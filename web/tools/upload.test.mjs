/* the publish path that netlify/functions/upload.mjs drives: the owner-review ticket, the order in
   which the duplicate fingerprint is claimed relative to the passport (ROW-128), and that scenario
   driven through the real endpoint.

   Split out of the former tools/run-tests.mjs. Shared setup (the in-memory blob double, reset(),
   GOOD, ...) is in ./_helpers.mjs, which also installs that double before any lib is exercised.
   Run just this file with: node --test tools/upload.test.mjs */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeStore,
  GOOD,
  parsed,
  reset,
  store,
  stores,
} from './_helpers.mjs';

/* THE UPLOAD HANDLER ITSELF, imported after the factory above so it shares this
   file's fake stores.

   THIS COMMENT USED TO SAY "Nothing in this suite drove the endpoint until
   ROW-128, and that is how ROW-128 survived", AND THAT DIAGNOSIS WAS WRONG.
   `tools/run-endpoint-tests.mjs` has imported and driven this handler with
   real Request objects since before ROW-128, it drives upload twenty-odd times
   including the duplicate guard and the ack replay, and `build.sh` runs it on
   every build. The defect was in front of a suite that was already looking.

   WHAT ACTUALLY LET IT SURVIVE: no double in either suite could FAIL A WRITE.
   The endpoint suite's FakeStore has no `failWrites` and still does not. So
   every ordering hazard on this path was invisible, not because nothing drove
   the endpoint, but because nothing could make storage fail underneath it
   while it ran. That is the more useful lesson and it generalises to the ack
   ticket, which is the second instance of the same bug found in this commit.

   The correct version is also a correction about placement. By this
   repository's own division of labour — README.md and run-endpoint-tests.mjs's
   own header — run-tests.mjs covers lib/ and the endpoint suite covers the
   handlers. The ROW-128 scenario test below belongs in the endpoint suite and
   sits here instead, which leaves two FakeStores that no longer match: this
   one knows `failWrites`, the other does not. Filed rather than moved in the
   same commit that is already carrying two behaviour changes. */
const upload = (await import('../netlify/functions/upload.mjs')).default;

/* ══ the owner-review ticket ══════════════════════════════ */

test('an acknowledgement cannot be invented by the client', async () => {
  reset();
  assert.equal(await store.readAck(undefined, 'unconfirmed', 'fp'), null);
  assert.equal(await store.readAck(undefined, 'a'.repeat(36), 'fp'), null);
  assert.equal(await store.readAck(undefined, '', 'fp'), null);
  assert.equal(await store.readAck(undefined, null, 'fp'), null);
});

/* `consumeAck` was ONE function that read the ticket and deleted it, and its
   caller ran it before createPassport. Same shape as the fingerprint defect
   ROW-128 is named for, on the same request: a publish that then failed spent
   the ticket on a success that had not happened. It is now readAck + burnAck,
   and the burn is after the passport exists. */
test('a ticket reads back for one body only, and is spent by the burn', async () => {
  reset();
  const ticket = await store.mintAck(undefined, 'fingerprint-a', ['k1', 'k2']);
  assert.match(ticket, /^[0-9a-f]{36}$/);

  assert.equal(await store.readAck(undefined, ticket, 'fingerprint-b'), null,
    'a ticket for one body must not publish another');

  /* The record is keyed on the ticket and the body together, so presenting the
     wrong body computes a key that is not there rather than reading one that
     is. The ticket survives that miss and is still good for its own body. */
  const ack = await store.readAck(undefined, ticket, 'fingerprint-a');
  assert.deepEqual(ack.charged, ['k1', 'k2']);

  /* READING DOES NOT SPEND IT, and that is the change. A read that spent the
     ticket is what made a failed publish cost the sharer a second refusal. */
  assert.deepEqual((await store.readAck(undefined, ticket, 'fingerprint-a')).charged, ['k1', 'k2'],
    'the read spent the ticket, so a failed publish would burn it');

  await store.burnAck(undefined, ack.key);
  assert.equal(await store.readAck(undefined, ticket, 'fingerprint-a'), null,
    'the burn did not spend the ticket, so it is not one-shot at all');
});

/* It runs after a passport is public and after a delete token has been minted
   that exists nowhere but the response, so it must not be able to fail one. */
test('burnAck cannot fail a publish that already happened', async () => {
  reset();
  const acks = new FakeStore('acks');
  acks.failWrites = true;
  stores.set('acks', acks);
  await store.burnAck(undefined, 'any-key');          // must not throw
  await store.burnAck(undefined, null);               // and must tolerate no ticket at all
});

test('an ack record holds nothing about the file it refused', async () => {
  reset();
  const fingerprint = store.sha256('a passport somebody thought better of');
  await store.mintAck(undefined, fingerprint, []);

  for (const value of stores.get('acks').data.values()) {
    assert.equal(value.includes(fingerprint), false,
      'the hash of a file nobody published is sitting in the store');
  }
  for (const key of stores.get('acks').data.keys()) {
    assert.equal(key.includes(fingerprint), false, 'the fingerprint is in the key');
  }
});

test('ack records left behind by somebody who walked away are swept', async () => {
  reset();
  await store.mintAck(undefined, 'fp', []);
  const acks = stores.get('acks');
  assert.equal(acks.data.size, 1);

  /* Age it past two ticket windows the way a closed tab would. */
  const [key, value] = [...acks.data.entries()][0];
  acks.data.delete(key);
  acks.data.set('1:' + key.slice(key.indexOf(':') + 1), value);

  const removed = await store.sweep(undefined);
  assert.equal(removed.acks, 1);
  assert.equal(acks.data.size, 0, 'a ticket nobody came back through is permanent');
});

/* ══ ROW-128: the fingerprint is claimed only once the passport exists ══════
   `seenRecently()` used to read the key AND write it, and upload.mjs called it
   before `createPassport()`. A storage failure at publish therefore claimed the
   fingerprint for a passport that does not exist: the sharer was told nothing
   was published, retried the same file inside the hour, and got 409 E_DUPLICATE
   whose message is "use the link you already have" when there is no link. Both
   attempts also paid the failure ceiling. */

test('seenRecently only reads; it does not claim the fingerprint', async () => {
  reset();
  const fp = store.sha256(GOOD);
  assert.equal(await store.seenRecently(undefined, fp), false);
  /* The store OBJECT exists after the read — the factory mints it on access —
     so the assertion is about its contents. Asserting the object was absent
     passed for the wrong reason before the fix and failed for the wrong reason
     after it. */
  assert.equal(stores.get('fingerprints').data.size, 0,
    'the check wrote a key, so a publish that fails still locks the file out');

  await store.claimFingerprint(undefined, fp, Math.floor(Date.now() / 3600e3));
  assert.equal(stores.get('fingerprints').data.size, 1);
  assert.equal(await store.seenRecently(undefined, fp), true, 'the claim did not register');
});

/* It runs after a passport is public and after a delete token has been minted
   that exists nowhere but the response. Anything that turned a successful
   publish into E_INTERNAL would leave that passport published, public,
   undeletable and unrenewable for thirty days. */
test('claimFingerprint cannot fail a publish that already happened', async () => {
  reset();
  const fp = new FakeStore('fingerprints');
  fp.failWrites = true;
  stores.set('fingerprints', fp);
  await store.claimFingerprint(undefined, store.sha256(GOOD), Math.floor(Date.now() / 3600e3));
  assert.equal(fp.data.size, 0);
});

/* ══ THE BUCKET SKEW, which a critic found and which predates ROW-128 ═══════
   `purge()` deletes fpKey(row.fingerprint, row.fingerprint_bucket). While
   claimFingerprint took its OWN Date.now(), an hour boundary falling between
   createPassport and the claim put the claim in bucket N+1 and the delete
   removed bucket N: deletePassport returned TRUE, and the identical file was
   refused 409 "use the link you already have" for the rest of the hour with no
   link to have. That is ROW-128's failure through the delete path. The fix is
   that the bucket is an argument, so the two keys are the same key by
   construction rather than by two clock reads landing in the same hour.

   The control matters here: pass a DIFFERENT bucket and the claim must
   survive the delete, which is what the defect did. */
test('a claim made across an hour boundary is still deleted with its passport', async () => {
  reset();
  const { id, token, fingerprint_bucket } = await store.createPassport(undefined, parsed(), GOOD);
  await store.claimFingerprint(undefined, store.sha256(GOOD), fingerprint_bucket);
  assert.equal(stores.get('fingerprints').data.size, 1);

  await store.deletePassport(undefined, id, token);
  assert.equal(stores.get('fingerprints').data.size, 0,
    'the claim outlived its passport, so the same file is locked out for an hour');

  /* And the control, which is the defect reproduced deliberately: a claim
     written into the NEXT bucket is the one purge cannot find. If this
     assertion ever fails, the delete has started matching on something other
     than the recorded bucket and the test above proves less than it looks. */
  reset();
  const b = await store.createPassport(undefined, parsed(), GOOD);
  await store.claimFingerprint(undefined, store.sha256(GOOD), b.fingerprint_bucket + 1);
  await store.deletePassport(undefined, b.id, b.token);
  assert.equal(stores.get('fingerprints').data.size, 1,
    'purge deleted a key it was not given, so this control proves nothing');
});

/* THE WHOLE DEFECT, DRIVEN THROUGH THE ENDPOINT. Neither file is wrong alone,
   so this is the only shape of test that can see it. The control below matters
   as much as the assertion: run this against the pre-ROW-128 code and the first
   attempt leaves a fingerprint and the retry is refused 409. */
test('a storage failure at publish does not lock the same file out', async () => {
  reset();
  const passports = new FakeStore('passports');
  passports.failWrites = true;
  stores.set('passports', passports);

  const post = () => new Request('https://app.phaeacia.ai/api/upload', {
    method: 'POST',
    headers: { 'content-type': 'text/markdown', 'x-nf-client-connection-ip': '203.0.113.9' },
    body: GOOD
  });

  const first = await post();
  const r1 = await upload(first);
  const j1 = await r1.json();
  assert.equal(r1.status, 500, 'the storage failure did not surface as E_INTERNAL');
  assert.equal(j1.code, 'E_INTERNAL');
  assert.equal(stores.get('fingerprints').data.size, 0,
    'the fingerprint was claimed for a passport that was never stored, so the ' +
    'same file is now refused for up to an hour with 409 "use the link you ' +
    'already have" and there is no link to have');

  passports.failWrites = false;                 // the outage passes
  const r2 = await upload(post());
  const j2 = await r2.json();
  assert.equal(r2.status, 200,
    `the retry was refused ${r2.status} ${j2.code || ''} instead of publishing`);
  assert.ok(j2.delete_token, 'the retry published without returning a delete token');
  assert.equal(stores.get('fingerprints').data.size, 1,
    'the successful publish did not claim the fingerprint, so the duplicate ' +
    'guard is now off for this file');

  /* And the guard still guards: a third identical upload inside the hour is a
     real duplicate and must be refused. Without this the test above is
     satisfied by deleting the duplicate guard entirely. */
  const r3 = await upload(post());
  assert.equal(r3.status, 409, 'the duplicate guard stopped guarding');
  assert.equal((await r3.json()).code, 'E_DUPLICATE');
});

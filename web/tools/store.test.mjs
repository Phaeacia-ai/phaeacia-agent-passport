/* lib/_store.mjs: passports, tokens, expiry and the sweeper, the limiter and its network keys,
   the views/copies counters, hold disposition storage (PH-507), deploy scoping (ROW-37) and the
   scope registry with sweepScopes() (ROW-155).

   Split out of the former tools/run-tests.mjs. Shared setup (the in-memory blob double, reset(),
   GOOD, ...) is in ./_helpers.mjs, which also installs that double before any lib is exercised.
   Run just this file with: node --test tools/store.test.mjs */

import { test } from 'node:test';
import { CATEGORIES } from '../lib/_categories.mjs';
import assert from 'node:assert/strict';
import {
  DAY_MS,
  FakeStore,
  GOOD,
  captureOps,
  expireNow,
  parsed,
  reset,
  store,
  stores,
} from './_helpers.mjs';

/* Interleaving hook (PH-518). `afterGet` is a one-shot async callback run AFTER a get has
   read its value and BEFORE the caller sees it, which is where a second request lands in
   a real deployment: the first caller holds a value that is already stale. Set with
   interleave(storeName, key, fn). Wrapping get keeps FakeStore itself untouched. */
const interleave = (storeName, key, fn) => {
  const s = stores.get(storeName);
  const real = s.get.bind(s);
  s.get = async (k, o) => {
    const v = await real(k, o);
    if (k === key && fn) { const f = fn; fn = null; s.get = real; await f(); }
    return v;
  };
};

const limiterKeys = (kind, windowMs, ip) => {
  const prefix = store.limitPrefix(ip, kind, windowMs);
  return [...(stores.get('ratelimit')?.data.keys() || [])].filter(k => k.startsWith(prefix));
};

/* ══ the sweeper ══════════════════════════════════════════ */

test('the sweeper deletes passports nobody came back for', async () => {
  reset();
  const live = await store.createPassport(undefined, parsed(), GOOD);
  const dead = await store.createPassport(undefined, parsed(), GOOD + '\n');
  expireNow(dead.id);

  const removed = await store.sweep(undefined);
  assert.equal(removed.passports, 1);
  assert.equal(stores.get('passports').data.has(dead.id), false,
    'an expired passport nobody opened is still on disk');
  assert.ok(stores.get('passports').data.has(live.id), 'the sweeper took a live passport');
});

test('an orphan expiry key with no row behind it is cleared and not counted', async () => {
  /* ROW-88. `passports.delete` on an already-absent key resolves rather than
     throwing, same as a real blob store's idempotent delete, so a naive sweep
     calls purge() on a row that is already gone, gets ok=true back, and counts
     a purge that purged nothing. This constructs exactly that shape: an expiry
     index key with no row behind it, as if the row had already vanished by
     some other route (or a previous sweep died between purge() and its own
     expiry delete). The stale key must go; the count must not move. */
  reset();
  const gone = await store.createPassport(undefined, parsed(), GOOD);
  expireNow(gone.id);
  const passports = stores.get('passports');
  passports.data.delete(gone.id);
  passports.meta.delete(gone.id);

  const removed = await store.sweep(undefined);
  assert.equal(removed.passports, 0, 'a purge that did not happen was counted as one that did');
  const expiry = stores.get('expiry');
  assert.equal([...expiry.data.keys()].some(k => k.endsWith(':' + gone.id)), false,
    'the orphan expiry-index key was left behind');
});

test('a real purge deletes the expiry key once, not twice', async () => {
  /* ROW-88's third item. purge() already deletes the exact key sweep() scanned
     whenever the row is non-null and expired, which is the only shape this
     branch of the loop reaches; sweep() used to delete it again unconditionally.
     Spied rather than reasoned about: count the calls the double actually saw. */
  reset();
  const dead = await store.createPassport(undefined, parsed(), GOOD);
  expireNow(dead.id);

  const expiry = stores.get('expiry');
  let deletes = 0;
  const real = expiry.delete.bind(expiry);
  expiry.delete = (k) => { deletes++; return real(k); };

  const removed = await store.sweep(undefined);
  assert.equal(removed.passports, 1);
  assert.equal(deletes, 1, `expiry.delete was called ${deletes} times for one purged passport`);
});

/* ── the budget, and the reserve inside it ─────────────────────────────────
   A clock that advances a fixed step every time it is read, so these are
   deterministic instead of racing an in-memory double that finishes a whole
   sweep inside a millisecond. This is a seam of the same kind as
   __useStoreFactory and exists for the same reason. */
const steppingClock = (stepMs) => { let t = 0; return () => (t += stepMs) - stepMs; };

/* TWELVE passports, and the number is the whole test.

   This was six, and at six it passed for the wrong reason. A critic instrumented
   it: with the reserve REMOVED (EXPIRY_SHARE 1.0) the run still returned
   `limits: 1`, so the headline assertion below would have passed either way. The
   test only went red on the `budgetSpent` precondition three lines earlier,
   because six passports finish before a 100 ms deadline whatever the share is.
   It was proving `expiryDeadline < budgetMs` arithmetic, never that the reserve
   protects the key stores.

   At twelve the control discriminates, measured:

     shipped (0.5), 12:  { passports: 4, limits: 1, budgetSpent: true }
     mutant  (1.0), 12:  { passports: 9, limits: 0, budgetSpent: true }

   Do not lower this number. The property under test only exists when the expiry
   loop can consume the whole budget, and it cannot at six. */
test('an exhausted expiry budget still leaves the key stores swept', async () => {
  reset();
  const ids = [];
  for (let i = 0; i < 12; i++) {
    const p = await store.createPassport(undefined, parsed(), GOOD + '\n'.repeat(i + 1));
    expireNow(p.id); ids.push(p.id);
  }

  /* A dead limiter bucket: the kind of key that piles up from ordinary traffic
     including REFUSED uploads, and what makes a sweep expensive with nothing
     expired at all. It is the reason the reserve exists. */
  const rl = stores.get('ratelimit') || new FakeStore('ratelimit');
  stores.set('ratelimit', rl);
  rl.data.set(`3600000:${String(1).padStart(12, '0')}:up-h:${store.ipKey('9.9.9.9')}:x`, '1');

  /* Budget 100, so the expiry half is 50. The clock advances 10 per read, so the
     purge loop runs out partway through six passports and the key stores below
     it still have room. */
  const removed = await store.sweep(undefined, { budgetMs: 100, clock: steppingClock(10) });

  assert.ok(removed.budgetSpent, 'the budget was never reported as spent');
  assert.ok(removed.passports < ids.length,
    `the expiry loop ran to completion (${removed.passports}/${ids.length}): the budget did nothing`);
  assert.equal(removed.limits, 1,
    'the expiry loop ate the whole budget and the limiter store went unswept, which is the ' +
    'exact failure the reserve exists to prevent');
});

/* The budget skips work; it must never leave work half-done. A passport whose
   purge started and did not finish is the unrecoverable state described on
   purge(), so the check has to sit before any work for a key rather than inside
   the loop body. */
test('a budget that runs out leaves no passport half-purged', async () => {
  reset();
  const ids = [];
  for (let i = 0; i < 6; i++) {
    const p = await store.createPassport(undefined, parsed(), GOOD + '\n'.repeat(i + 1));
    expireNow(p.id); ids.push(p.id);
  }

  const removed = await store.sweep(undefined, { budgetMs: 100, clock: steppingClock(10) });
  assert.ok(removed.budgetSpent && removed.passports < ids.length, 'the budget did not bite');

  const passports = stores.get('passports');
  const expiry = stores.get('expiry');
  for (const id of ids) {
    const row = passports.data.has(id);
    const key = [...expiry.data.keys()].some(k => k.endsWith(':' + id));
    /* Either both are gone or both are there. A row with no index key is
       unsweepable forever; an index key with no row is merely retried. */
    assert.ok(row === key || (!row && !key),
      `passport ${id} left half-purged: row ${row}, index key ${key}`);
    if (row) assert.ok(key, `a live row lost its index key: ${id} is now unsweepable`);
  }
});

/* Skipped work is retried, which is what makes ending early safe. The expiry
   index is the durable to-do list, so the next run finishes the job. */
test('what one budgeted sweep skips, the next one takes', async () => {
  reset();
  const ids = [];
  for (let i = 0; i < 6; i++) {
    const p = await store.createPassport(undefined, parsed(), GOOD + '\n'.repeat(i + 1));
    expireNow(p.id); ids.push(p.id);
  }

  const first = await store.sweep(undefined, { budgetMs: 100, clock: steppingClock(10) });
  assert.ok(first.passports < ids.length, 'the first sweep was not actually cut short');

  let total = first.passports;
  for (let i = 0; i < 10 && total < ids.length; i++) {
    total += (await store.sweep(undefined, { budgetMs: 100, clock: steppingClock(10) })).passports;
  }

  assert.equal(total, ids.length,
    'passports skipped for budget were never collected by a later sweep');
  for (const id of ids) {
    assert.equal(stores.get('passports').data.has(id), false, `${id} survived every sweep`);
  }
});

/* ── the mutants that survived, now pinned ───────────────────────────────────
   A critic mutation-tested the budget and found three changes that left the
   whole suite green. Each of these kills one of them. They are dull tests and
   that is the point: a constant defended by an argument in a comment and by
   nothing else is a constant that will be changed by someone who has not read
   the comment. */

test('the shipped budget leaves room under the platform ceiling', () => {
  /* Netlify documents 30 s for a scheduled function. The budget must leave room
     for the listing and the response on top of it. Nothing else pinned this:
     every other budget test passes budgetMs explicitly, so SWEEP_BUDGET_MS could
     be raised to any value at all and the suite stayed green. */
  const CEILING_MS = 30000;
  assert.ok(store.SWEEP_BUDGET_MS <= CEILING_MS * 0.7,
    `the sweep budget is ${store.SWEEP_BUDGET_MS}ms against a documented ${CEILING_MS}ms ceiling; ` +
    'a run that reaches the ceiling is killed before it can log why');
  assert.ok(store.EXPIRY_SHARE > 0 && store.EXPIRY_SHARE < 1,
    'the expiry share must leave some budget for the key stores, which is the whole reserve');
});

test('the key stores stop dropping when the budget runs out mid-drop', async () => {
  /* The gate used to be an ADMISSION check in front of drop(), which is not a
     bound: once admitted the loop ran to completion, 40 sequential batches at
     maxKeys 1000. This asserts the check BETWEEN batches. Removing it, or making
     the admission gates unconditional, turns this red. */
  reset();
  const rl = stores.get('ratelimit') || new FakeStore('ratelimit');
  stores.set('ratelimit', rl);
  rl.page = 200;
  const windowMs = 3600000;
  const deadBucket = String(1).padStart(12, '0');
  /* 600 keys is 24 batches of 25. At a 10 ms step against a 100 ms budget the
     loop gets about nine of them, so the assertion below has room to see the
     difference between "bounded" and "ran to completion". At 120 keys it is five
     batches, which finish inside the budget whether the check exists or not, and
     the test passes for the wrong reason. */
  for (let i = 0; i < 600; i++) {
    rl.data.set(`${windowMs}:${deadBucket}:up-h:${store.ipKey('9.9.9.' + i)}:${i}`, '1');
  }

  /* Budget 100 with a 10ms step: the expiry half is 50, nothing is expired so
     the loop costs nothing, and the drop below has room for a couple of batches
     and not for all five. */
  const removed = await store.sweep(undefined, { budgetMs: 100, clock: steppingClock(10) });

  assert.ok(removed.limits > 0, 'the drop never started, so this proves nothing');
  assert.ok(removed.limits < 600,
    `drop() deleted all ${removed.limits} keys after the budget ran out: it is admission-gated, not bounded`);
  assert.ok(removed.budgetSpent, 'a drop cut short did not report the budget as spent');
});

test('a sweep that cannot list says so, instead of reporting a clean store', async () => {
  /* All zeros is the tuning signal for "run this less often". A blind sweep
     produces the same zeros, so without this the advice is wrong in exactly the
     case that matters. */
  reset();
  const expiry = new FakeStore('expiry');
  expiry.list = () => { throw new Error('listing unavailable'); };
  stores.set('expiry', expiry);

  const removed = await store.sweep(undefined);
  assert.equal(removed.passports, 0, 'the fixture did not model a failed listing');
  assert.equal(removed.listFailed, true,
    'a sweep that could not list reported zeros indistinguishable from a clean store');
  assert.equal(removed.expiryBacklog, null, 'a backlog nobody could list was reported as a number');
  assert.equal(removed.expiryBacklogAgeMin, null);
});

/* The backlog is counted BEFORE the maxPassports cut, which is the whole point:
   counted after it, a run can never report more than it was allowed to clear,
   and "two weeks behind" reads the same as "one run's worth". `now` is moved
   three hours past the expiries and one entry expired two hours before the
   rest, so the oldest is 300 minutes overdue and the newest 180: an age taken
   from the wrong end of the list reads as 180 (review, 2026-10-22). */
test('the sweep reports its whole backlog and how overdue the oldest entry is', async () => {
  reset();
  await store.createPassport(undefined, parsed(), GOOD);           // live, not due
  for (let i = 0; i < 5; i++) {
    const p = await store.createPassport(undefined, parsed(), GOOD + '\n'.repeat(i + 1));
    expireNow(p.id, i === 3 ? 2 * 3600e3 : 1000);
  }
  const removed = await store.sweep(undefined, { now: Date.now() + 3 * 3600e3, maxPassports: 2 });
  assert.equal(removed.passports, 2, 'the fixture did not exercise the cut');
  assert.equal(removed.expiryBacklog, 5, 'the backlog was counted after the per-run cut');
  assert.ok(removed.expiryBacklogAgeMin >= 300 && removed.expiryBacklogAgeMin <= 301,
    `the oldest entry is about 300 minutes overdue, reported ${removed.expiryBacklogAgeMin}`);

  reset();
  await store.createPassport(undefined, parsed(), GOOD);
  const clean = await store.sweep(undefined);
  assert.equal(clean.expiryBacklog, 0, 'a listed store with nothing due is a real zero');
  assert.equal(clean.expiryBacklogAgeMin, null, 'nothing due has no oldest entry');
});

test('a failed index write does not publish an unsweepable passport', async () => {
  reset();
  const expiry = new FakeStore('expiry');
  expiry.set = async () => { throw new Error('transient index write failure'); };
  stores.set('expiry', expiry);

  /* It used to write the row first and swallow the index write, so the passport
     was BORN with no index entry: sweep() enumerates only through that index, so
     it could never be deleted, and the publisher was told it worked. */
  await assert.rejects(() => store.createPassport(undefined, parsed(), GOOD),
    'createPassport reported success while writing no index entry');

  const passports = stores.get('passports');
  assert.equal(passports ? passports.data.size : 0, 0,
    'a row was left behind with no index entry: unsweepable forever');
});

test('a failed index write on renew does not strip the passport of its only key', async () => {
  reset();
  const { id, token } = await store.createPassport(undefined, parsed(), GOOD);
  const expiry = stores.get('expiry');
  const before = [...expiry.data.keys()];
  assert.equal(before.length, 1);

  expiry.set = async () => { throw new Error('transient index write failure'); };

  /* Worse than the create case: the new key was swallowed and the OLD key was
     deleted anyway, so a cheerful new expiry date came back while the passport
     lost its only index entry. */
  await assert.rejects(() => store.renewPassport(undefined, id, token),
    'renewPassport reported success while writing no index entry');

  assert.deepEqual([...expiry.data.keys()], before,
    'the old index key was dropped: the passport is now unsweepable');
  assert.ok(stores.get('passports').data.has(id));
});

test('a failed row delete does not drop the index key or count as swept', async () => {
  reset();
  const { id } = await store.createPassport(undefined, parsed(), GOOD);
  expireNow(id);
  const expiry = stores.get('expiry');
  const key = [...expiry.data.keys()][0];

  /* No crash, no timeout, no backlog. ONE transient rejection on the row
     delete, which is what storage does under load. It used to be swallowed
     while the CONCURRENT expiry delete succeeded, leaving a live passport with
     no index entry. sweep() enumerates dead passports only through that index,
     so nothing could ever reach it again: retained past the thirty days
     privacy.html promises, undetectably, and counted as removed on the way. */
  const passports = stores.get('passports');
  passports.delete = async () => { throw new Error('transient storage failure'); };

  const removed = await store.sweep(undefined);

  assert.ok(passports.data.has(id), 'the failure did not model a failure');
  assert.ok(expiry.data.has(key),
    'index key dropped for a passport that is still there: unsweepable forever');
  assert.equal(removed.passports, 0, 'a purge that did not happen was counted as one that did');
});

test('deleting reports failure when the row did not actually go', async () => {
  reset();
  const { id, token } = await store.createPassport(undefined, parsed(), GOOD);
  const passports = stores.get('passports');
  passports.delete = async () => { throw new Error('transient storage failure'); };

  /* It used to return true unconditionally, so the delete page told a visitor
     their passport was gone while it was still being served. There is no honest
     wording to put over a function that reports a success it did not have. */
  assert.equal(await store.deletePassport(undefined, id, token), false,
    'a visitor was told their passport was deleted while it is still up');
  assert.ok(passports.data.has(id), 'the failure did not model a failure');
});

test('the sweeper clears dead limiter buckets and dead fingerprints', async () => {
  reset();
  const rl = new FakeStore('ratelimit');
  stores.set('ratelimit', rl);
  const pad = n => String(n).padStart(12, '0');
  rl.data.set(`3600000:${pad(1)}:old:${store.ipKey('1.1.1.1')}:x`, '1');   // bucket 1 of 1970
  rl.data.set(`3600000:${pad(Math.floor(Date.now() / 3600e3))}:new:${store.ipKey('1.1.1.1')}:y`, '1');

  const fp = new FakeStore('fingerprints');
  stores.set('fingerprints', fp);
  fp.data.set('1:deadbeef', '{}');
  fp.data.set(`${Math.floor(Date.now() / 3600e3)}:livebeef`, '{}');

  const removed = await store.sweep(undefined);
  assert.equal(removed.limits, 1);
  assert.equal(removed.fingerprints, 1);
  assert.equal(rl.data.size, 1);
  assert.equal(fp.data.size, 1);
});

test('deleting takes the duplicate fingerprint with it', async () => {
  reset();
  const { id, token, fingerprint_bucket } = await store.createPassport(undefined, parsed(), GOOD);
  /* `claimFingerprint`, not `seenRecently`. Since ROW-128 the check does not
     write: the claim is a separate call made only once the passport exists.
     This line used to read `seenRecently` and passed on its side effect.
     The bucket comes from the ROW, which is what makes this delete find the
     key at all; see the skew test below. */
  await store.claimFingerprint(undefined, store.sha256(GOOD), fingerprint_bucket);
  assert.equal(stores.get('fingerprints').data.size, 1);

  await store.deletePassport(undefined, id, token);
  assert.equal(stores.get('fingerprints').data.size, 0,
    'the fingerprint outlived the passport, so re-uploading the same file is refused');
});

/* ══ hold disposition storage (PH-507) ═══════════════════════════════════
   createHold / checkHold / attachHoldEmail / releaseHold / refuseHold /
   sweepHolds. Nothing here wires JEV_DISPOSITION="hold" to upload.mjs yet --
   that is a separate, not-yet-built step -- these tests are about the
   storage layer's own invariants: index-first, the owner's token check,
   "text and email deleted together, in one operation, whichever of the
   three paths does it", and that the fingerprint claimed at hold-creation
   time is neither re-claimed nor released by what release/refusal do. */

const holdArgs = (overrides = {}) => ({
  record: parsed(), text: GOOD, gallery: null, jev: { outcome: 'installable', score: 0.95 },
  ...overrides
});

/* helpers for the hold tests below */
const everywhere = needle => [...stores.values()].filter(s => [...s.data.values()].some(v => v.includes(needle))).map(s => s.name);
const OWNER = 'race-owner@example.com';
/* Runs fn with mail on and every send recorded (to, subject, text). ok:false makes Resend answer 500.
   console.error is captured too: nothing in the hold paths may print an address. */
async function captureMail(fn, { ok = true } = {}) {
  const savedFetch = globalThis.fetch, savedKey = process.env.RESEND_API_KEY, savedErr = console.error;
  const sent = [], logged = [];
  process.env.RESEND_API_KEY = 'test-key';
  console.error = (...a) => { logged.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); };
  globalThis.fetch = async (_u, init) => {
    const b = JSON.parse(init.body); sent.push({ to: b.to[0], subject: b.subject, text: b.text });
    return { ok, status: ok ? 200 : 500, json: async () => ({ id: 'x' }) };
  };
  try { return { out: await fn(), sent, logged }; } finally {
    globalThis.fetch = savedFetch; console.error = savedErr;
    if (savedKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = savedKey;
  }
}
const quietMail = async fn => {
  const savedFetch = globalThis.fetch, savedKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 'test-key';
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: 'x' }) });
  try { return await fn(); } finally { globalThis.fetch = savedFetch; if (savedKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = savedKey; }
};
test('createHold returns a fingerprint and bucket matching the text and the hour, for the caller to claim', async () => {
  reset();
  const before = Math.floor(Date.now() / 3600e3);
  const { fingerprint, fingerprint_bucket } = await store.createHold(undefined, holdArgs());
  assert.equal(fingerprint, store.sha256(GOOD));
  assert.equal(fingerprint_bucket, before, 'the hour bucket must be read once, at creation time');
  /* createHold does not claim it -- that is the caller's job, same contract
     as createPassport, per ROW-128: nothing claims a fingerprint for a row
     that might not exist yet. */
  assert.equal(stores.get('fingerprints')?.data.size ?? 0, 0);
});

test('a failed index write does not create an unsweepable hold', async () => {
  reset();
  const expiry = new FakeStore('hold-expiry');
  expiry.set = async () => { throw new Error('transient index write failure'); };
  stores.set('hold-expiry', expiry);

  await assert.rejects(() => store.createHold(undefined, holdArgs()),
    'createHold reported success while writing no index entry');

  const holds = stores.get('holds');
  assert.equal(holds ? holds.data.size : 0, 0,
    'a hold row was left behind with no index entry: unsweepable forever');
});

test('checkHold: pending for the right token, not_found for a wrong token, an unknown id, or a malformed id', async () => {
  reset();
  const { hold_id, hold_token } = await store.createHold(undefined, holdArgs());

  assert.deepEqual(await store.checkHold(undefined, hold_id, hold_token), { status: 'pending' });
  assert.deepEqual(await store.checkHold(undefined, hold_id, 'wrong-token'), { status: 'not_found' },
    'a wrong token must read exactly like a missing hold, not like "id right, token wrong"');
  assert.deepEqual(await store.checkHold(undefined, randomUUIDLike(), hold_token), { status: 'not_found' });
  assert.deepEqual(await store.checkHold(undefined, 'not-a-uuid', hold_token), { status: 'not_found' });
});

test('checkHold: an expired-but-not-yet-swept hold reads not_found', async () => {
  reset();
  const { hold_id, hold_token } = await store.createHold(undefined, holdArgs());
  const row = JSON.parse(stores.get('holds').data.get(hold_id));
  const future = Date.parse(row.expires_at) + 1000;

  assert.deepEqual(await store.checkHold(undefined, hold_id, hold_token, future), { status: 'not_found' },
    'the sweep has not run yet, but an expired hold must not read as pending');
});

test('attachHoldEmail: ok and overwrites rather than merging; not_found for a wrong token or unknown id', async () => {
  reset();
  const { hold_id, hold_token } = await store.createHold(undefined, holdArgs());

  assert.deepEqual(await store.attachHoldEmail(undefined, hold_id, hold_token, 'a@example.com'),
    { status: 'ok' });
  const addr = () => JSON.parse(stores.get('hold-email').data.get(hold_id)).email;
  assert.equal(addr(), 'a@example.com');
  assert.equal('email' in JSON.parse(stores.get('holds').data.get(hold_id)), false,
    'the address must not be written into the hold row: that write-back is what resurrected refused holds');

  assert.deepEqual(await store.attachHoldEmail(undefined, hold_id, hold_token, 'b@example.com'),
    { status: 'ok' });
  assert.equal(addr(), 'b@example.com', 'a second address must replace the first, not add a second');

  assert.deepEqual(await store.attachHoldEmail(undefined, hold_id, 'wrong-token', 'c@example.com'),
    { status: 'not_found' });
  assert.deepEqual(await store.attachHoldEmail(undefined, randomUUIDLike(), hold_token, 'c@example.com'),
    { status: 'not_found' });
  assert.equal(addr(), 'b@example.com', 'a rejected attach must not have touched the address');
});

test('releaseHold publishes the held record and text unchanged, then deletes the hold row and its index entry together', async () => {
  reset();
  const { hold_id: hid, hold_token: htok } = await store.createHold(undefined,
    holdArgs({ gallery: { category: CATEGORIES[0].slug } }));
  await store.attachHoldEmail(undefined, hid, htok, 'owner@example.com');
  const holdExpiry = stores.get('hold-expiry');
  assert.equal(holdExpiry.data.size, 1);

  const result = await store.releaseHold(undefined, hid);
  assert.equal(result.ok, true);
  assert.equal(result.email, 'owner@example.com');
  assert.ok(result.id, 'releaseHold must hand back the id of the passport it created');

  const published = JSON.parse(stores.get('passports').data.get(result.id));
  assert.equal(published.body, GOOD, 'the held text must reach the published row unchanged');
  assert.equal(stores.get('gallery').data.has(result.id), true,
    'the gallery choice recorded at hold time must carry through to release');

  assert.equal(stores.get('holds').data.has(hid), false, 'the hold row must be gone after release');
  assert.equal(holdExpiry.data.size, 0, 'the hold index entry must be gone after release, in the same operation');

  assert.deepEqual(await store.checkHold(undefined, hid, htok), { status: 'released', id: result.id },
    'a returning owner must be able to learn where their released passport went, without their token: the row is gone');
  /* The PASSPORT this points at is lifetime because it is in the gallery.
     The POINTER is not: HAL's correction, same day. A pointer that never
     expired for a gallery release would make "which of our public
     passports did our own check flag" a permanent, unbounded, undisclosed
     record -- document plus judgement, even with the identity gone. So the
     pointer expires on the ordinary 30-day clock regardless of where the
     passport itself ends up. */
  assert.equal(stores.get('hold-pointer-expiry')?.data.size ?? 0, 1,
    'a gallery release must still write a pointer expiry: only the passport is lifetime, never the pointer');
});

test('releaseHold writes a pointer that expires in 30 days, gallery release or not', async () => {
  for (const gallery of [null, { category: CATEGORIES[0].slug }]) {
    reset();
    const { hold_id, hold_token } = await store.createHold(undefined, holdArgs({ gallery }));
    const result = await store.releaseHold(undefined, hold_id);

    assert.deepEqual(await store.checkHold(undefined, hold_id, hold_token), { status: 'released', id: result.id });
    assert.equal(stores.get('hold-pointer-expiry').data.size, 1,
      `a release must write exactly one pointer-expiry entry (gallery=${Boolean(gallery)})`);
  }
});

test('releaseHold sends the owner their new link before deleting the address that would reach them, and reports mailed:true on success', async () => {
  reset();
  const savedKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 'test-key';
  const order = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    order.push('mailed');
    return { ok: true, json: async () => ({ id: 'x' }) };
  };
  try {
    const { hold_id, hold_token } = await store.createHold(undefined, holdArgs());
    await store.attachHoldEmail(undefined, hold_id, hold_token, 'owner@example.com');
    const holds = stores.get('holds');
    const realDelete = holds.delete.bind(holds);
    holds.delete = async (...args) => { order.push('row-deleted'); return realDelete(...args); };
    const addrs = stores.get('hold-email');
    const realAddrDelete = addrs.delete.bind(addrs);
    addrs.delete = async (...args) => { order.push('address-deleted'); return realAddrDelete(...args); };

    const result = await store.releaseHold(undefined, hold_id);
    assert.equal(result.ok, true);
    /* HAL's correction pinned the mail before the deletion of what could reach the owner: a version
       that hoists the ADDRESS delete ahead of the send would still publish correctly and still
       report ok:true, so only the ORDER catches it. PH-518 critic F1 moved the ROW delete ahead of
       the send, on purpose: the address is read after the row is gone, so an address saved just
       before the row went is still read and mailed. The address stays live until after the send. */
    assert.deepEqual(order, ['row-deleted', 'mailed', 'address-deleted'],
      'the mail must go out after the row is gone (so a late save is read) and before the address is deleted');
    assert.equal(result.mailed, true, 'a genuinely successful send must report mailed:true');
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = savedKey;
  }
});

test('releaseHold reports mailed:false and logs the reason when sendMail resolves ok:false, and still deletes the row -- two gate-code critics found this reported success on a failed send', async () => {
  /* sendMail() never throws (lib/_email.mjs): a fetch rejection and a
     non-2xx provider response both resolve to { ok:false, reason }. A
     try/catch around the call is therefore not enough to detect a failure
     -- critic-ph507-hold-r1 and -r2 independently found releaseHold
     ignored this return value entirely and told tools/review-holds.mjs the
     owner was mailed when they were not, right before deleting the only
     copy of their address. This test drives that exact shape: fetch
     RESOLVES with a non-ok status, never rejects. */
  reset();
  const savedKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 'test-key';
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 422, text: async () => 'invalid recipient' });
  const savedError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    const { hold_id, hold_token } = await store.createHold(undefined, holdArgs());
    await store.attachHoldEmail(undefined, hold_id, hold_token, 'owner@example.com');

    const result = await store.releaseHold(undefined, hold_id);
    assert.equal(result.ok, true, 'the publish itself must still succeed');
    assert.equal(result.mailed, false, 'a resolved ok:false must not be reported as mailed');
    assert.equal(stores.get('holds').data.has(hold_id), false,
      'the row is still deleted -- deletion does not wait on the send succeeding');
    assert.ok(errors.some(a => a.join(' ').includes('hold release mail failed')),
      'a failed send must be logged, since the address it concerns is about to be unrecoverable');
    assert.ok(!errors.some(a => a.join(' ').includes('owner@example.com')),
      'the failure log must never carry the address itself, matching every other outbound-mail failure this file logs');
  } finally {
    globalThis.fetch = savedFetch;
    console.error = savedError;
    if (savedKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = savedKey;
  }
});

test('releaseHold never lets a failed send undo the publish, and never sends when there is no address', async () => {
  reset();
  process.env.RESEND_API_KEY = undefined;
  delete process.env.RESEND_API_KEY;
  const savedFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('must not be reached: no api key means no send'); };
  try {
    const { hold_id } = await store.createHold(undefined, holdArgs()); // no email attached
    const result = await store.releaseHold(undefined, hold_id);
    assert.equal(result.ok, true, 'a release with no owner address must still succeed');
    assert.equal(called, false, 'nothing sends when no address was ever left');

    process.env.RESEND_API_KEY = 'test-key';
    globalThis.fetch = async () => { throw new Error('simulated provider outage'); };
    const { hold_id: hid2, hold_token: tok2 } = await store.createHold(undefined, holdArgs());
    await store.attachHoldEmail(undefined, hid2, tok2, 'owner@example.com');
    const result2 = await store.releaseHold(undefined, hid2);
    assert.equal(result2.ok, true, 'a send that throws must not cost the owner their already-completed publish');
    assert.equal(result2.mailed, false, 'an actual throw must also report mailed:false, not just a resolved ok:false');
  } finally {
    globalThis.fetch = savedFetch;
    delete process.env.RESEND_API_KEY;
  }
});

test('a failed hold-pointer index write leaves the hold row in place for a retry, rather than deleting it with no pointer to show for it', async () => {
  /* Both gate-code critics independently found this half of the index-first
     invariant unpinned: createHold's own index-first write is tested (the
     test above), but createHoldPointer's was not, and a mutation adding
     `.catch(() => {})` to its expiry write, or swapping its two writes,
     survived both suites at full green. releaseHold wraps neither
     createHoldPointer nor its own call to it in a try/catch, so a thrown
     write SHOULD already propagate and leave the hold row (and the
     published passport) both intact for a retry -- this test is what
     would have caught either mutation, by actually exercising the
     failure rather than trusting the absence of a swallow. */
  reset();
  const { hold_id } = await store.createHold(undefined, holdArgs());

  const pointerExpiry = new FakeStore('hold-pointer-expiry');
  pointerExpiry.set = async () => { throw new Error('transient index write failure'); };
  stores.set('hold-pointer-expiry', pointerExpiry);

  await assert.rejects(() => store.releaseHold(undefined, hold_id),
    'releaseHold reported success while writing a pointer with no index entry');

  assert.equal(stores.get('holds').data.has(hold_id), true,
    'the hold row must survive a failed pointer write, so a retry has something to find');
  assert.equal(stores.get('hold-pointers')?.data.size ?? 0, 0,
    'no pointer row may exist with no index entry backing it: unsweepable forever');
});

test('releaseHold hands back a delete token that genuinely authorises the published passport -- a gate-code critic found this discarded entirely', async () => {
  /* critic-ph507-hold-r2: createPassport mints a token exactly as it does
     for a normal publish, and releaseHold used to read only `.id` off the
     result, so a released hold became a passport nobody -- not the owner,
     not a reviewer -- could ever delete or renew through any product
     surface. Checked here against the real authorise()/statusOf() a manage
     request would use, not just that a `token` field is present: a
     present-but-wrong token would pass a shape check and still strand the
     owner exactly the same way. */
  const { authorise, statusOf } = store;
  for (const gallery of [null, { category: CATEGORIES[0].slug }]) {
    reset();
    const { hold_id } = await store.createHold(undefined, holdArgs({ gallery }));
    const result = await store.releaseHold(undefined, hold_id);
    assert.equal(result.ok, true);
    assert.match(result.token, /^[0-9a-f]{40}$/, 'a delete token is minted the same way createPassport mints one');
    assert.equal(result.manage_url, `https://app.phaeacia.ai/manage#${result.id}:${result.token}`);

    assert.notEqual(await authorise(undefined, result.id, result.token), null,
      `the returned token must actually authorise the published passport (gallery=${Boolean(gallery)})`);
    assert.equal(await authorise(undefined, result.id, 'f'.repeat(40)), null,
      'a wrong token must still be refused: this is not a check that accepts anything');

    const status = await statusOf(undefined, result.id, result.token);
    assert.ok(status, 'the token must be usable through the same function /api/manage calls');
  }
});

test('refuseHold leaves nothing for checkHold to find: refusal writes no pointer', async () => {
  reset();
  const { hold_id, hold_token } = await store.createHold(undefined, holdArgs());
  await store.refuseHold(undefined, hold_id);
  assert.deepEqual(await store.checkHold(undefined, hold_id, hold_token), { status: 'not_found' },
    'a refusal has nothing to point at, and must read exactly like an unknown hold, not a distinguishable third thing');
  assert.equal(stores.get('hold-pointers')?.data.size ?? 0, 0);
});

test('listPendingHolds: a lightweight summary per pending hold, no passport text, and released/refused holds are gone from it', async () => {
  reset();
  const a = await store.createHold(undefined, holdArgs({ gallery: { category: CATEGORIES[0].slug } }));
  await store.attachHoldEmail(undefined, a.hold_id, a.hold_token, 'a@example.com');
  const b = await store.createHold(undefined, holdArgs({ text: GOOD + '\nextra' }));

  const listed = await store.listPendingHolds(undefined);
  assert.equal(listed.listFailed, false);
  assert.equal(listed.holds.length, 2);

  const row = listed.holds.find(h => h.hold_id === a.hold_id);
  assert.equal(row.has_email, true);
  assert.equal(row.requested_listing, CATEGORIES[0].slug);
  assert.equal(row.jev.outcome, 'installable');
  assert.equal('text' in row, false, 'a listing must not carry the held passport text');
  assert.equal('record' in row, false);

  await store.refuseHold(undefined, b.hold_id);
  const afterRefusal = await store.listPendingHolds(undefined);
  assert.equal(afterRefusal.holds.length, 1, 'a refused hold must drop out of the pending list');
});

test('listPendingHolds reports a failed listing rather than a clean empty list', async () => {
  reset();
  const holds = new FakeStore('holds');
  holds.list = () => { throw new Error('simulated list outage'); };
  stores.set('holds', holds);

  const listed = await store.listPendingHolds(undefined);
  assert.equal(listed.listFailed, true);
  assert.deepEqual(listed.holds, []);
});

test('readHold returns the full row for a reviewer, with no token needed, and null for an unknown or malformed id', async () => {
  reset();
  const { hold_id } = await store.createHold(undefined, holdArgs());
  const row = await store.readHold(undefined, hold_id);
  assert.equal(row.text, GOOD);
  assert.ok(row.record);

  assert.equal(await store.readHold(undefined, randomUUIDLike()), null);
  assert.equal(await store.readHold(undefined, 'not-a-uuid'), null);
});

test('releaseHold on an unknown or already-gone hold id reports not_found and creates nothing', async () => {
  reset();
  const before = stores.get('passports')?.data.size ?? 0;
  const result = await store.releaseHold(undefined, randomUUIDLike());
  assert.deepEqual(result, { ok: false, reason: 'not_found' });
  assert.equal(stores.get('passports')?.data.size ?? 0, before);
});

test('refuseHold deletes the hold row and its index entry together, and publishes nothing', async () => {
  reset();
  const { hold_id, hold_token } = await store.createHold(undefined, holdArgs());
  await store.attachHoldEmail(undefined, hold_id, hold_token, 'owner@example.com');
  const holdExpiry = stores.get('hold-expiry');
  assert.equal(holdExpiry.data.size, 1);

  const { out: result } = await captureMail(() => store.refuseHold(undefined, hold_id, { reason: 'It contains a live password.' }));
  assert.equal(result.ok, true);
  assert.equal(result.email, 'owner@example.com');

  assert.equal(stores.get('holds').data.has(hold_id), false);
  assert.equal(holdExpiry.data.size, 0, 'refusal must delete the index entry in the same operation as the row');
  assert.deepEqual(everywhere('owner@example.com'), [], 'the address outlived the refusal');
  assert.equal(stores.get('passports')?.data.size ?? 0, 0, 'refusal must never publish anything');
});

test('release and refusal both leave an already-claimed fingerprint alone: neither re-claims nor releases it', async () => {
  /* A same-key re-claim would not move `.size`, so a version of release/
     refuse that re-claimed the same fingerprint could pass a size-only
     check while genuinely calling `.set()` a second time -- not a gap
     found by a critic, closed while the fingerprint code was already open
     for this round. Spies on the write itself, not only its aggregate
     effect. */
  for (const action of ['release', 'refuse']) {
    reset();
    const { hold_id, fingerprint, fingerprint_bucket } = await store.createHold(undefined, holdArgs());
    /* Models the caller -- upload.mjs's hold branch -- having claimed it
       at hold-creation time, exactly as it would for a normal publish. */
    await store.claimFingerprint(undefined, fingerprint, fingerprint_bucket);
    assert.equal(stores.get('fingerprints').data.size, 1);

    /* claimFingerprint writes with setJSON, not set -- spying on only one of
       the two would have missed exactly the mutation this test exists to
       catch, which is what a first draft of this fix actually did before
       being run against a real re-claim and found not to fail. Both are
       wrapped so neither write method can re-claim unnoticed. */
    const fp = stores.get('fingerprints');
    const realSet = fp.set.bind(fp);
    const realSetJSON = fp.setJSON.bind(fp);
    let writes = 0;
    fp.set = async (...args) => { writes++; return realSet(...args); };
    fp.setJSON = async (...args) => { writes++; return realSetJSON(...args); };

    if (action === 'release') await store.releaseHold(undefined, hold_id);
    else await store.refuseHold(undefined, hold_id);

    assert.equal(writes, 0,
      `${action}Hold must not write to the fingerprints store at all, not even a same-key re-claim`);
    assert.equal(stores.get('fingerprints').data.size, 1,
      `${action}Hold must not touch the fingerprint claim made at hold-creation time`);
  }
});

test('sweepHolds deletes the text and the email in the same operation once a hold has expired, and leaves a fresh hold alone', async () => {
  reset();
  const fresh = await store.createHold(undefined, holdArgs());
  const stale = await store.createHold(undefined, holdArgs());
  await store.attachHoldEmail(undefined, stale.hold_id, stale.hold_token, 'stale@example.com');

  /* Age the stale one exactly the way expireNow ages a passport: rewrite the
     row's own expires_at AND move its index key, because sweepHolds reads
     the index to decide what to look at and re-checks the row before
     trusting it. */
  const holds = stores.get('holds');
  const row = JSON.parse(holds.data.get(stale.hold_id));
  const wasMs = Date.parse(row.expires_at);
  row.expires_at = new Date(Date.now() - 1000).toISOString();
  const ms = Date.parse(row.expires_at);
  holds.data.set(stale.hold_id, JSON.stringify(row));
  const key = id => `${String(id[0]).padStart(16, '0')}:${id[1]}`;
  const holdExpiry = stores.get('hold-expiry');
  holdExpiry.data.delete(key([wasMs, stale.hold_id]));
  holdExpiry.data.set(key([ms, stale.hold_id]), '1');

  const removed = await store.sweepHolds(undefined);
  assert.equal(removed.holds, 1);

  assert.equal(stores.get('holds').data.has(stale.hold_id), false, 'the expired hold text must be gone');
  assert.equal(holdExpiry.data.has(key([ms, stale.hold_id])), false, 'the expired hold index entry must be gone');
  /* The address lives in its own store (hold-email), so "row gone" says nothing about it. */
  assert.deepEqual(everywhere('stale@example.com'), [], 'the expired hold\'s address outlived the sweep');

  assert.equal(stores.get('holds').data.has(fresh.hold_id), true, 'a fresh hold must survive a sweep');
  assert.ok(holdExpiry.data.size >= 1, 'the fresh hold must keep its own index entry');
});

/* PH-518 critic r1 (F3): attachHoldEmail read the hold, then wrote the whole row back with nothing
   conditioning the write on the row still existing. A save that overlapped a refusal, a release or the
   sweep brought the row back with the passport text and the address and no expiry-index key, so nothing
   ever deleted it. The three interleavings below drive that exact order (the attach has read a live row,
   THEN the other request finishes, THEN the attach writes) and then look at every store for the text
   and the address, not at one key, so the check does not depend on where the address is kept. */
async function raceAgainstAttach(other) {
  reset();
  const h = await store.createHold(undefined, holdArgs());
  interleave('holds', h.hold_id, () => other(h));
  const res = await store.attachHoldEmail(undefined, h.hold_id, h.hold_token, OWNER);
  return { h, res };
}
test('a save that overlaps a refusal does not bring the hold or the address back', async () => {
  const { h, res } = await raceAgainstAttach(hh => store.refuseHold(undefined, hh.hold_id));
  assert.deepEqual(everywhere(OWNER), [], 'the address survived the refusal it raced');
  assert.deepEqual(everywhere(GOOD.slice(0, 40)), [], 'the passport text survived the refusal it raced');
  assert.equal(stores.get('holds').data.has(h.hold_id), false);
  assert.deepEqual(res, { status: 'not_found' }, 'the owner was told "ok" for an address that was not kept');
});
test('a save that overlaps a release does not leave the address behind', async () => {
  const { res } = await quietMail(() => raceAgainstAttach(hh => store.releaseHold(undefined, hh.hold_id)));
  assert.deepEqual(everywhere(OWNER), [], 'the address survived the release it raced');
  assert.equal(stores.get('holds').data.has([...stores.get('holds').data.keys()][0] || 'none'), false);
  assert.ok(res.status === 'not_found' || res.status === 'ok');
});
/* The other half of the ordering argument. The three tests above land the attach BEFORE the ending
   starts. The ending is itself two deletes, and an attach can land between them, or just before the
   first. deleteHoldRecord deletes the row, then the address: an attach that lands anywhere in that
   sequence either sees no row and writes nothing, or writes an address the second delete then takes.
   Swap the two deletes and the second point orphans the address (row read as live, address written,
   row deleted, address left), which no single-step interleaving above can show. */
const beforeDelete = (storeName, key, fn) => {
  const st = stores.get(storeName), real = st.delete.bind(st);
  st.delete = async k => { if (k === key && fn) { const f = fn; fn = null; st.delete = real; await f(); } return real(k); };
};
for (const [ending, act] of [['refusal', h => store.refuseHold(undefined, h.hold_id, { reason: 'r' })],
                             ['expiry sweep', async h => { await AGED(h.hold_id); return store.sweepHolds(undefined); }]]) {
  for (const point of ['holds', 'hold-email']) {
    test(`a save that lands just before the ${ending}'s ${point} delete leaves neither the hold nor the address`, async () => {
      reset();
      const h = await store.createHold(undefined, holdArgs());
      await store.attachHoldEmail(undefined, h.hold_id, h.hold_token, OWNER);   // so the address store exists and is deleted at both points
      let res;
      beforeDelete(point, h.hold_id, async () => {
        res = await store.attachHoldEmail(undefined, h.hold_id, h.hold_token, OWNER + '.2');
      });
      await captureMail(() => act(h));
      assert.ok(res, 'test setup: the interleaved save never ran');
      assert.deepEqual(everywhere(OWNER), [], 'an address survived the ' + ending);
      assert.deepEqual(everywhere(GOOD.slice(0, 40)), [], 'the passport text survived the ' + ending);
    });
  }
}
/* PH-518 critic F1: "Saved" must mean the ending will read the address. An attach that lands just
   before the row is deleted (its re-read still sees the row, so it answers ok) used to be read
   NOTHING by an ending that had already looked for the address: Saved, then deleted, no mail. */
for (const [ending, act] of [['release', h => store.releaseHold(undefined, h.hold_id)],
                             ['refusal with a reason', h => store.refuseHold(undefined, h.hold_id, { reason: 'r' })],
                             ['refusal without a reason', h => store.refuseHold(undefined, h.hold_id)],
                             ['expiry sweep', async h => { await AGED(h.hold_id); return store.sweepHolds(undefined); }]]) {
  test(`a save that answers Saved just before the ${ending} deletes the row is mailed: Saved means read`, async () => {
    reset();
    const LATE = 'late-save@example.com';
    const h = await store.createHold(undefined, holdArgs());          // no address yet
    let res;
    beforeDelete('holds', h.hold_id, async () => { res = await store.attachHoldEmail(undefined, h.hold_id, h.hold_token, LATE); });
    const { sent } = await captureMail(() => act(h));
    assert.ok(res, 'test setup: the interleaved save never ran');
    if (ending === 'expiry sweep') {
      // the hold is already expired when the sweep runs, so the save is refused: never Saved, never mailed
      assert.deepEqual(res, { status: 'not_found' });
      assert.equal(sent.length, 0);
    } else if (res.status === 'ok') {
      assert.equal(sent.filter(m => m.to === LATE).length, 1, 'the owner was told Saved and never heard the outcome');
    } else {
      assert.equal(sent.length, 0);
    }
    assert.deepEqual(everywhere(LATE), [], 'the address outlived the ending');
  });
}
test('a save that overlaps the sweep of an expired hold does not bring it back', async () => {
  const { res } = await quietMail(() => raceAgainstAttach(async hh => {
    const holds = stores.get('holds'), hx = stores.get('hold-expiry');
    const row = JSON.parse(holds.data.get(hh.hold_id)); const was = Date.parse(row.expires_at);
    row.expires_at = new Date(Date.now() - 1000).toISOString();
    holds.data.set(hh.hold_id, JSON.stringify(row));
    hx.data.delete(`${String(was).padStart(16, '0')}:${hh.hold_id}`);
    hx.data.set(`${String(Date.parse(row.expires_at)).padStart(16, '0')}:${hh.hold_id}`, '1');
    await store.sweepHolds(undefined);
  }));
  assert.deepEqual(everywhere(OWNER), [], 'the address survived the sweep it raced');
  assert.deepEqual(everywhere(GOOD.slice(0, 40)), [], 'the passport text survived the sweep it raced');
  assert.deepEqual(res, { status: 'not_found' });
});

/* PH-518, HAL 2026-09-24: every path that ends a hold must leave the address in NO store,
   whether or not the mail went, and must not print it. One row per path x send outcome. */
const AGED = async id => {                       // make a hold expired the way the sweep sees it
  const holds = stores.get('holds'), hx = stores.get('hold-expiry');
  const row = JSON.parse(holds.data.get(id)); const was = Date.parse(row.expires_at);
  row.expires_at = new Date(Date.now() - 1000).toISOString();
  holds.data.set(id, JSON.stringify(row));
  hx.data.delete(`${String(was).padStart(16, '0')}:${id}`);
  hx.data.set(`${String(Date.parse(row.expires_at)).padStart(16, '0')}:${id}`, '1');
};
const ENDINGS = {
  release: id => store.releaseHold(undefined, id),
  refuse: id => store.refuseHold(undefined, id, { reason: 'It quotes a private document.' }),
  expire: async id => { await AGED(id); return store.sweepHolds(undefined); },
  'release of an expired hold': async id => { await AGED(id); return store.releaseHold(undefined, id); }
};
for (const [path, act] of Object.entries(ENDINGS)) {
  for (const ok of [true, false]) {
    test(`ending a hold by ${path}, mail ${ok ? 'sent' : 'failing'}: the address is in no store afterwards and in no log`, async () => {
      reset();
      const ADDR = 'gone-after-' + path.replace(/\W/g, '') + '@example.com';
      const h = await store.createHold(undefined, holdArgs());
      assert.deepEqual(await store.attachHoldEmail(undefined, h.hold_id, h.hold_token, ADDR), { status: 'ok' });
      assert.deepEqual(everywhere(ADDR), ['hold-email'], 'test setup: the address should be in exactly the hold-email store');
      const { sent, logged } = await captureMail(() => act(h.hold_id), { ok });
      assert.equal(sent.length, 1, 'exactly one message per hold: ' + JSON.stringify(sent));
      assert.equal(sent[0].to, ADDR);
      assert.deepEqual(everywhere(ADDR), [], 'the address outlived the hold');
      assert.equal(stores.get('holds').data.has(h.hold_id), false, 'the hold row outlived its end');
      assert.equal(stores.get('hold-expiry').data.size, 0, 'the hold-expiry key outlived its end');
      assert.equal(logged.some(l => l.includes(ADDR)), false, 'the address was printed to a log: ' + logged.join(' | '));
      if (!ok) assert.ok(logged.length >= 1, 'a failed send must be logged (without the address)');
    });
  }
}
test('a mail that fails by throwing an error that quotes the address does not print the address', async () => {
  reset();
  const h = await store.createHold(undefined, holdArgs());
  await store.attachHoldEmail(undefined, h.hold_id, h.hold_token, 'quoted@example.com');
  const savedFetch = globalThis.fetch, savedKey = process.env.RESEND_API_KEY, savedErr = console.error, logged = [];
  process.env.RESEND_API_KEY = 'test-key';
  console.error = (...a) => logged.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
  globalThis.fetch = async (_u, init) => { throw new Error('connect failed for ' + JSON.parse(init.body).to[0]); };
  try { await store.refuseHold(undefined, h.hold_id, { reason: 'x' }); } finally {
    globalThis.fetch = savedFetch; console.error = savedErr;
    if (savedKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = savedKey;
  }
  assert.ok(logged.length >= 1, 'the failure was not logged at all');
  assert.equal(logged.some(l => l.includes('quoted@example.com')), false, 'the address was logged: ' + logged.join(' | '));
  assert.deepEqual(everywhere('quoted@example.com'), []);
});
/* PH-518 critic F4: mutants the first round did not have. Each of these survived until it had a row. */
test('attachHoldEmail: when its re-read of the hold throws, the safe reading is "gone": the address comes out and the owner gets not_found', async () => {
  reset();
  const h = await store.createHold(undefined, holdArgs());
  const holds = stores.get('holds'), real = holds.get.bind(holds); let reads = 0;
  holds.get = async (k, o) => { if (k === h.hold_id && ++reads === 2) throw new Error('blob read failed'); return real(k, o); };
  assert.deepEqual(await store.attachHoldEmail(undefined, h.hold_id, h.hold_token, 'unsure@example.com'), { status: 'not_found' });
  assert.deepEqual(everywhere('unsure@example.com'), [], 'an address stayed although the hold could not be confirmed');
});
test('releaseHold: an unreadable address store does not stop the release, and a second release finds nothing to publish', async () => {
  reset();
  const h = await store.createHold(undefined, holdArgs());
  await store.attachHoldEmail(undefined, h.hold_id, h.hold_token, 'unreadable@example.com');
  const addrs = stores.get('hold-email'), real = addrs.get.bind(addrs);
  addrs.get = async () => { throw new Error('blob read failed'); };
  const { out, logged } = await captureMail(() => store.releaseHold(undefined, h.hold_id));
  addrs.get = real;
  assert.equal(out.ok, true, 'a failed address read stopped a release');
  assert.equal(out.mailed, false);
  assert.equal(stores.get('passports').data.size, 1);
  assert.equal(stores.get('holds').data.has(h.hold_id), false);
  assert.equal(logged.some(l => l.includes('unreadable@example.com')), false);
  assert.deepEqual((await store.releaseHold(undefined, h.hold_id)), { ok: false, reason: 'not_found' }, 'a second release found the hold again');
  assert.equal(stores.get('passports').data.size, 1, 'a second passport was published');
});
test('sweepHolds: an orphan address whose delete fails keeps its index key, so the address is retried when the key comes due', async () => {
  reset();
  const h = await store.createHold(undefined, holdArgs());
  await store.attachHoldEmail(undefined, h.hold_id, h.hold_token, 'orphan@example.com');
  stores.get('holds').data.delete(h.hold_id);                       // the row is gone, the address is not
  const hx = stores.get('hold-expiry'); const [k] = [...hx.data.keys()]; hx.data.delete(k);
  const due = `${String(Date.now() - 1000).padStart(16, '0')}:${h.hold_id}`; hx.data.set(due, '1');
  stores.get('hold-email').failWrites = true;
  await store.sweepHolds(undefined);
  stores.get('hold-email').failWrites = false;
  assert.equal(hx.data.has(due), true, 'the index key was deleted although the address could not be');
  await store.sweepHolds(undefined);
  assert.deepEqual(everywhere('orphan@example.com'), [], 'the retry did not remove the address');
  assert.equal(hx.data.size, 0);
});
test('a hold mail is sent with the hold timeout (3 s), not the default: the sweep\'s budget depends on it', async () => {
  reset();
  const h = await store.createHold(undefined, holdArgs());
  await store.attachHoldEmail(undefined, h.hold_id, h.hold_token, 'timeout@example.com');
  const real = AbortSignal.timeout, seen = [];
  AbortSignal.timeout = ms => { seen.push(ms); return real.call(AbortSignal, ms); };
  try { await captureMail(() => store.refuseHold(undefined, h.hold_id, { reason: 'r' })); } finally { AbortSignal.timeout = real; }
  assert.deepEqual(seen, [store.HOLD_MAIL_TIMEOUT_MS]);
  assert.equal(store.HOLD_MAIL_TIMEOUT_MS, 3000);
});
test('the refusal reason is cut to 600 characters and collapsed to one line before it is mailed', async () => {
  reset();
  const h = await store.createHold(undefined, holdArgs());
  await store.attachHoldEmail(undefined, h.hold_id, h.hold_token, 'cut@example.com');
  const { sent } = await captureMail(() => store.refuseHold(undefined, h.hold_id, { reason: 'a\n\nb   c ' + 'x'.repeat(700) }));
  const why = sent[0].text.split('\n').find(l => l.startsWith('Why: '));
  assert.ok(why.startsWith('Why: a b c x'), 'whitespace was not collapsed: ' + why.slice(0, 40));
  assert.equal(why.length - 'Why: '.length, 600, 'the reason was not cut to exactly 600 characters');
});
test('sweepHolds starts no hold once its budget is spent, and leaves the hold whole', async () => {
  reset();
  const h = await store.createHold(undefined, holdArgs());
  await store.attachHoldEmail(undefined, h.hold_id, h.hold_token, 'budget@example.com');
  await AGED(h.hold_id);
  let t = 0;
  const out = await store.sweepHolds(undefined, { budgetMs: 5000, clock: () => { const v = t; t += 6000; return v; } });
  assert.equal(out.budgetSpent, true, 'the sweep started a hold with its budget already spent');
  assert.equal(stores.get('holds').data.has(h.hold_id), true, 'the hold was ended although there was no budget');
  assert.deepEqual(everywhere('budget@example.com'), ['hold-email'], 'a hold left for the next run lost its address');
});

/* PH-518, Raffael and HAL 2026-09-24: TWO PASSES. Deletion first for every due hold, then the mails
   with what is left of the budget. A provider that hangs costs 3 s a mail; the version that mailed
   inside each ending ended ONE hold per run and left the rest of the backlog, text and address,
   on disk an hour more, which the deletion promise on privacy.html does not allow. The fake
   provider below "hangs" by advancing a virtual clock by the send timeout on every request. */
async function seedDue(n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const h = await store.createHold(undefined, holdArgs({ text: GOOD + '\n'.repeat(i + 1) + 'n' + i }));
    await store.attachHoldEmail(undefined, h.hold_id, h.hold_token, `due${i}@example.com`);
    await AGED(h.hold_id);
    ids.push(h.hold_id);
  }
  return ids;
}
async function sweepWithProvider(n, { hangMs }) {
  const ids = await seedDue(n);
  let t = 0, attempts = 0, goneAtFirstSend = null;
  const savedFetch = globalThis.fetch, savedKey = process.env.RESEND_API_KEY, savedErr = console.error;
  process.env.RESEND_API_KEY = 'test-key';
  console.error = () => {};
  globalThis.fetch = async () => {
    attempts++;
    if (goneAtFirstSend === null) {
      goneAtFirstSend = { rows: stores.get('holds').data.size, addresses: stores.get('hold-email').data.size };
    }
    t += hangMs;
    if (hangMs >= store.HOLD_MAIL_TIMEOUT_MS) throw new Error('aborted');
    return { ok: true, status: 200, json: async () => ({ id: 'x' }) };
  };
  try {
    const out = await store.sweepHolds(undefined, { budgetMs: 5000, clock: () => t });
    return { out, attempts, goneAtFirstSend, ids };
  } finally {
    globalThis.fetch = savedFetch; console.error = savedErr;
    if (savedKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = savedKey;
  }
}
test('a provider that hangs on every mail still ends every due hold in one run, and the unsent mails are counted', async () => {
  reset();
  const N = 8;
  const { out, attempts, ids } = await sweepWithProvider(N, { hangMs: store.HOLD_MAIL_TIMEOUT_MS });
  assert.equal(out.holds, N, `only ${out.holds} of ${N} holds ended in one run: the mail is holding the deletion back`);
  for (const id of ids) assert.equal(stores.get('holds').data.has(id), false, 'a due hold is still on disk after the run');
  assert.deepEqual(everywhere('@example.com'), [], 'a due hold left its address behind');
  assert.equal(stores.get('hold-expiry').data.size, 0, 'an index key survived a clean ending');
  assert.equal(attempts * store.HOLD_MAIL_TIMEOUT_MS < 5000, true,
    `${attempts} hung sends at 3 s each do not fit the 5 s budget: the sweep overran its share`);
  assert.equal(out.mailsDropped, N - attempts, `dropped ${out.mailsDropped}, sent ${attempts}, of ${N}`);
  assert.ok(out.mailsDropped > 0, 'nothing was dropped, so the hang never bit');
});
test('every deletion is finished before the first mail goes out', async () => {
  reset();
  const { goneAtFirstSend, out } = await sweepWithProvider(4, { hangMs: 0 });
  assert.equal(out.mailsDropped, 0, 'a healthy provider must lose no mail');
  assert.deepEqual(goneAtFirstSend, { rows: 0, addresses: 0 },
    'the first mail was sent while a due hold, or its address, was still stored');
});
test('a healthy provider gets one expiry mail per hold, to that hold\'s own address, and nothing is dropped', async () => {
  reset();
  const ids = await seedDue(3);
  const { out, sent } = await captureMail(() => store.sweepHolds(undefined));
  assert.equal(out.holds, 3);
  assert.equal(out.mailsDropped, 0);
  assert.deepEqual(sent.map(m => m.to).sort(), ['due0@example.com', 'due1@example.com', 'due2@example.com']);
  assert.equal(ids.length, 3);
  assert.deepEqual(everywhere('@example.com'), []);
});
test('pass 1 keeps the whole budget: a hold is started while any of it is left, whatever a mail would need', async () => {
  reset();
  const h = await store.createHold(undefined, holdArgs());
  await store.attachHoldEmail(undefined, h.hold_id, h.hold_token, 'pass1@example.com');
  await AGED(h.hold_id);
  let t = 0;
  const out = await quietMail(() => store.sweepHolds(undefined, { budgetMs: 5000, clock: () => { const v = t; t += 2600; return v; } }));
  assert.equal(out.holds, 1, 'pass 1 reserved budget for a mail it does not send, and left a due hold on disk');
  assert.deepEqual(everywhere('pass1@example.com'), []);
});
/* PH-518 final critic, F1: pass 1's ending keeps the index key when the ADDRESS delete failed, so
   the next run finds the hold again and removes the address. Only refuseHold pinned this before. */
test('a sweep whose address delete failed keeps the index key, and the next run removes the address', async () => {
  reset();
  const [id] = await seedDue(1);
  const hx = stores.get('hold-expiry');
  assert.equal(hx.data.size, 1, 'the fixture must start with one due key');
  stores.get('hold-email').failWrites = true;
  const first = await quietMail(() => store.sweepHolds(undefined));
  stores.get('hold-email').failWrites = false;
  assert.equal(first.holds, 1);
  assert.equal(stores.get('holds').data.has(id), false);
  assert.deepEqual(everywhere('due0@example.com'), ['hold-email'], 'the fixture must leave the address behind');
  assert.equal(hx.data.size, 1, 'the key was deleted although the address delete failed: nothing will ever sweep that address');
  await quietMail(() => store.sweepHolds(undefined));
  assert.deepEqual(everywhere('due0@example.com'), [], 'the retry did not remove the address');
  assert.equal(hx.data.size, 0);
});
/* F2: the budget is one budget across both passes. A clock that ticks 1500 ms a read spends 4.5 s in
   pass 1 of three holds, so pass 2 starts with 0.5 s left and may send nothing. A pass 2 with its own
   clock start would send. */
test('pass 2 shares pass 1\'s budget: mails start only with a full timeout left on the run\'s own clock', async () => {
  reset();
  await seedDue(3);
  let t = 0, sends = 0;
  const savedFetch = globalThis.fetch, savedKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 'test-key';
  globalThis.fetch = async () => { sends++; return { ok: true, status: 200, json: async () => ({ id: 'x' }) }; };
  let out;
  try {
    out = await store.sweepHolds(undefined, { budgetMs: 5000, clock: () => { const v = t; t += 1500; return v; } });
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = savedKey;
  }
  assert.equal(out.holds, 3, 'pass 1 must have ended all three inside the budget');
  assert.equal(sends, 0, 'a mail was started with less than one timeout of the run\'s budget left');
  assert.equal(out.mailsDropped, 3);
});
/* F3: a hold with no address owes nobody a mail, so it is not a dropped mail. */
test('mailsDropped counts only mails that had an address', async () => {
  reset();
  const ids = await seedDue(2);
  for (let i = 0; i < 3; i++) {                     // three more due holds, no address
    const h = await store.createHold(undefined, holdArgs({ text: GOOD + '\nnoaddr' + i + '\n'.repeat(i + 9) }));
    await AGED(h.hold_id);
  }
  const { out, attempts } = await (async () => {
    let t = 0, attempts = 0;
    const savedFetch = globalThis.fetch, savedKey = process.env.RESEND_API_KEY, savedErr = console.error;
    process.env.RESEND_API_KEY = 'test-key'; console.error = () => {};
    globalThis.fetch = async () => { attempts++; t += store.HOLD_MAIL_TIMEOUT_MS; throw new Error('aborted'); };
    try { return { out: await store.sweepHolds(undefined, { budgetMs: 5000, clock: () => t }), attempts }; }
    finally { globalThis.fetch = savedFetch; console.error = savedErr;
      if (savedKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = savedKey; }
  })();
  assert.equal(out.holds, 5);
  assert.equal(attempts, 1);
  assert.equal(out.mailsDropped, 1, `two addresses, one send attempted: ${out.mailsDropped} dropped, and holds without an address must not be counted`);
  assert.equal(ids.length, 2);
});
/* PH-518 final critic F1: a passport released from review carries its hold's id, so deleting or
   expiring the passport deletes the pointer /api/check-hold reads. Before this the pointer went on
   answering "released" with the id of a deleted passport for up to 30 days. */
async function releasedPassport() {
  const h = await store.createHold(undefined, holdArgs());
  const out = await quietMail(() => store.releaseHold(undefined, h.hold_id));
  assert.equal(out.ok, true);
  const token = out.token;
  return { hold_id: h.hold_id, hold_token: h.hold_token, id: out.id, token };
}
test('deleting a released passport deletes its hold pointer and the pointer\'s expiry key, and check-hold then says not_found', async () => {
  reset();
  const r = await releasedPassport();
  assert.deepEqual(await store.checkHold(undefined, r.hold_id, r.hold_token), { status: 'released', id: r.id });
  assert.equal(stores.get('hold-pointers').data.size, 1);
  assert.equal(stores.get('hold-pointer-expiry').data.size, 1);
  assert.equal(await store.deletePassport(undefined, r.id, r.token), true);
  assert.equal(stores.get('hold-pointers').data.size, 0, 'the pointer outlived the deleted passport');
  assert.equal(stores.get('hold-pointer-expiry').data.size, 0, 'the pointer\'s expiry key outlived it');
  assert.deepEqual(await store.checkHold(undefined, r.hold_id, r.hold_token), { status: 'not_found' });
  assert.deepEqual(everywhere(r.id), [], 'the deleted passport\'s id is still stored somewhere');
});
test('a released passport that EXPIRES takes its hold pointer with it', async () => {
  reset();
  const r = await releasedPassport();
  const px = stores.get('passports'), ex = stores.get('expiry');
  const row = JSON.parse(px.data.get(r.id));
  const was = Date.parse(row.expires_at);
  row.expires_at = new Date(Date.now() - 1000).toISOString();
  px.data.set(r.id, JSON.stringify(row));
  ex.data.delete(`${String(was).padStart(16, '0')}:${r.id}`);
  ex.data.set(`${String(Date.parse(row.expires_at)).padStart(16, '0')}:${r.id}`, '1');
  await store.sweep(undefined);
  assert.equal(px.data.has(r.id), false, 'the fixture did not expire the passport');
  assert.equal(stores.get('hold-pointers').data.size, 0, 'the pointer outlived the expired passport');
  assert.equal(stores.get('hold-pointer-expiry').data.size, 0);
});
test('a released GALLERY passport takes its hold pointer with it when its owner deletes it', async () => {
  reset();
  const h = await store.createHold(undefined, holdArgs({ gallery: { category: CATEGORIES[0].slug } }));
  const out = await quietMail(() => store.releaseHold(undefined, h.hold_id));
  assert.equal(out.ok, true);
  assert.ok(JSON.parse(stores.get('passports').data.get(out.id)).gallery, 'the fixture must release a listed passport');
  assert.equal(await store.deletePassport(undefined, out.id, out.token), true);
  assert.equal(stores.get('hold-pointers').data.size, 0, 'the pointer outlived the deleted gallery passport');
  assert.equal(stores.get('hold-pointer-expiry').data.size, 0);
});
test('the pointer is deleted only when the passport row is: a failed row delete leaves both', async () => {
  reset();
  const r = await releasedPassport();
  stores.get('passports').failWrites = true;
  const ok = await store.deletePassport(undefined, r.id, r.token);
  stores.get('passports').failWrites = false;
  assert.equal(ok, false, 'the fixture must fail the row delete');
  assert.deepEqual(await store.checkHold(undefined, r.hold_id, r.hold_token), { status: 'released', id: r.id },
    'the pointer went although the passport is still published');
});
test('a passport that did not come from a hold carries no hold field, and another hold\'s pointer is untouched', async () => {
  reset();
  const r = await releasedPassport();
  const direct = await store.createPassport(undefined, { title: 't', name: 'n' }, GOOD + '\ndirect');
  assert.equal('hold' in JSON.parse(stores.get('passports').data.get(direct.id)), false);
  assert.equal(await store.deletePassport(undefined, direct.id, direct.token), true);
  assert.equal(stores.get('hold-pointers').data.size, 1, 'deleting an unrelated passport removed a pointer');
  assert.equal((await store.checkHold(undefined, r.hold_id, r.hold_token)).status, 'released');
});
test('a mail that cannot start with a full timeout of budget left is dropped, not sent late', async () => {
  reset();
  const { out, attempts } = await sweepWithProvider(3, { hangMs: 2500 });
  assert.equal(out.holds, 3);
  /* 2500 ms a send in a 5000 ms budget with a 3000 ms reserve: the first goes at t=0 (0+3000<5000),
     the second at t=2500 (5500>=5000) is dropped, and so is the third. */
  assert.equal(attempts, 1);
  assert.equal(out.mailsDropped, 2);
});

test('a refusal with an address on file and no reason refuses to act, and changes nothing', async () => {
  reset();
  const h = await store.createHold(undefined, holdArgs());
  await store.attachHoldEmail(undefined, h.hold_id, h.hold_token, 'needs-reason@example.com');
  const { out, sent } = await captureMail(() => store.refuseHold(undefined, h.hold_id, { reason: '   ' }));
  assert.deepEqual(out, { ok: false, reason: 'reason_required' });
  assert.equal(sent.length, 0);
  assert.equal(stores.get('holds').data.has(h.hold_id), true, 'a refusal without a reason deleted the hold');
  assert.deepEqual(everywhere('needs-reason@example.com'), ['hold-email']);
  const none = await store.createHold(undefined, holdArgs({ text: GOOD + '\nno address' }));
  assert.equal((await store.refuseHold(undefined, none.hold_id)).ok, true, 'no address, no reason needed');
});
test('a delete that fails leaves the index key for the next sweep, and that sweep removes an address whose row is already gone', async () => {
  reset();
  const h = await store.createHold(undefined, holdArgs());
  await store.attachHoldEmail(undefined, h.hold_id, h.hold_token, 'stuck@example.com');
  stores.get('hold-email').failWrites = true;
  await captureMail(() => store.refuseHold(undefined, h.hold_id, { reason: 'x' }));
  stores.get('hold-email').failWrites = false;
  assert.equal(stores.get('holds').data.has(h.hold_id), false);
  assert.deepEqual(everywhere('stuck@example.com'), ['hold-email'], 'test setup: the address delete should have failed');
  assert.equal(stores.get('hold-expiry').data.size, 1, 'the index key was deleted although the address delete failed, so nothing would ever retry');
  const hx = stores.get('hold-expiry'); const [k] = [...hx.data.keys()]; hx.data.delete(k);
  hx.data.set(`${String(Date.now() - 1000).padStart(16, '0')}:${h.hold_id}`, '1');
  await store.sweepHolds(undefined);
  assert.deepEqual(everywhere('stuck@example.com'), [], 'the sweep did not remove an address whose hold row was already gone');
  assert.equal(hx.data.size, 0);
});
test('listPendingHolds and readHold report the address from its own store', async () => {
  reset();
  const h = await store.createHold(undefined, holdArgs());
  assert.equal((await store.listPendingHolds(undefined)).holds[0].has_email, false);
  assert.equal((await store.readHold(undefined, h.hold_id)).email, null);
  await store.attachHoldEmail(undefined, h.hold_id, h.hold_token, 'seen@example.com');
  assert.equal((await store.listPendingHolds(undefined)).holds[0].has_email, true);
  assert.equal((await store.readHold(undefined, h.hold_id)).email, 'seen@example.com');
});

test('sweepHolds drops only the index key when the row says it is not yet expired, and leaves the row alone', async () => {
  /* The branch at "row && !isExpired": replacing it with an unconditional delete
     of the row left both suites green (PH-507 gate-code critic). A stale index key
     must never take a live hold with it. */
  reset();
  const live = await store.createHold(undefined, holdArgs());
  const holdExpiry = stores.get('hold-expiry');
  const [origKey] = [...holdExpiry.data.keys()];
  holdExpiry.data.delete(origKey);
  const staleKey = `${String(Date.now() - 60000).padStart(16, '0')}:${live.hold_id}`;
  holdExpiry.data.set(staleKey, '1');

  const removed = await store.sweepHolds(undefined);
  assert.equal(removed.holds, 0, 'a live hold was counted as removed');
  assert.equal(stores.get('holds').data.has(live.hold_id), true, 'a live hold was deleted because its index key was stale');
  assert.equal(holdExpiry.data.has(staleKey), false, 'the stale index key must still be dropped');
});

test('an expired-but-unswept hold cannot be released, listed or read, and releasing it deletes it', async () => {
  /* Expiry was enforced only by the sweep: at day 7 the owner was told not_found
     while the reviewer still saw the hold pending and releaseHold published it and
     mailed the address (PH-507 gate-code critics). */
  reset();
  const stale = await store.createHold(undefined, holdArgs());
  await store.attachHoldEmail(undefined, stale.hold_id, stale.hold_token, 'stale@example.com');
  const holds = stores.get('holds');
  const row = JSON.parse(holds.data.get(stale.hold_id));
  row.expires_at = new Date(Date.now() - 1000).toISOString();
  holds.data.set(stale.hold_id, JSON.stringify(row));

  assert.equal((await store.listPendingHolds(undefined)).holds.length, 0, 'an expired hold was listed as pending');
  assert.equal(await store.readHold(undefined, stale.hold_id), null, 'an expired hold was readable');
  const { out: rel, sent } = await captureMail(() => store.releaseHold(undefined, stale.hold_id));
  assert.deepEqual(rel, { ok: false, reason: 'not_found' });
  assert.ok(!stores.get('passports') || stores.get('passports').data.size === 0, 'an expired hold was published');
  /* PH-518: an expired hold is now told once that nobody reviewed it. It is never the release mail. */
  assert.equal(sent.length, 1, 'an expired hold must send exactly one message: ' + JSON.stringify(sent));
  assert.match(sent[0].text, /Nobody reviewed it within 5 days/);
  assert.doesNotMatch(sent[0].text, /has now been published/, 'an expired hold mailed the owner as if it had been released');
  assert.deepEqual(everywhere('stale@example.com'), [], 'the address outlived an expired hold');
  assert.equal(holds.data.has(stale.hold_id), false, 'releasing an expired hold must delete text and address together');
});

test('sweepHolds drops an orphan index key whose row is already gone, without counting it as removed', async () => {
  reset();
  const { hold_id } = await store.createHold(undefined, holdArgs());
  const holds = stores.get('holds');
  const row = JSON.parse(holds.data.get(hold_id));
  holds.data.delete(hold_id); // the row is gone; the index key is not

  row.expires_at = new Date(Date.now() - 1000).toISOString();
  const ms = Date.parse(row.expires_at);
  const holdExpiry = stores.get('hold-expiry');
  for (const k of [...holdExpiry.data.keys()]) holdExpiry.data.delete(k);
  holdExpiry.data.set(`${String(ms).padStart(16, '0')}:${hold_id}`, '1');

  const removed = await store.sweepHolds(undefined);
  assert.equal(removed.holds, 0, 'a row that was never there was not removed by this sweep');
  assert.equal(holdExpiry.data.size, 0, 'the orphan index key must still be dropped on sight');
});

test('sweepHolds clears an expired release pointer, and checkHold reads not_found once it is gone', async () => {
  reset();
  const { hold_id, hold_token } = await store.createHold(undefined, holdArgs());
  const { id: publishedId } = await store.releaseHold(undefined, hold_id);
  assert.deepEqual(await store.checkHold(undefined, hold_id, hold_token), { status: 'released', id: publishedId });

  const pointerExpiry = stores.get('hold-pointer-expiry');
  assert.equal(pointerExpiry.data.size, 1);
  const key = [...pointerExpiry.data.keys()][0];
  const ms = Number(key.slice(0, key.indexOf(':')));

  // Not yet due: sweeping "now" (before the pointer's own expiry) must not touch it.
  const untouched = await store.sweepHolds(undefined, { now: ms - 1000 });
  assert.equal(untouched.pointers, 0);
  assert.equal(pointerExpiry.data.size, 1);

  const removed = await store.sweepHolds(undefined, { now: ms + 1000 });
  assert.equal(removed.pointers, 1);
  assert.equal(pointerExpiry.data.size, 0);
  assert.equal(stores.get('hold-pointers').data.has(hold_id), false);

  assert.deepEqual(await store.checkHold(undefined, hold_id, hold_token), { status: 'not_found' },
    'once the pointer is swept there is nothing left anywhere for a returning owner to find');
});

test('sweepHolds reports a failed listing rather than a clean zero', async () => {
  reset();
  const holdExpiry = new FakeStore('hold-expiry');
  holdExpiry.list = () => { throw new Error('simulated list outage'); };
  stores.set('hold-expiry', holdExpiry);

  const removed = await store.sweepHolds(undefined);
  assert.equal(removed.holds, 0);
  assert.equal(removed.listFailed, true, 'a sweep that could not list reported zeros indistinguishable from a clean store');
});

test('sweepHolds is budget-bounded the same way sweep() is', async () => {
  reset();
  const N = 20;
  const stale = [];
  for (let i = 0; i < N; i++) {
    const h = await store.createHold(undefined, holdArgs({ text: GOOD + '\n'.repeat(i + 1) }));
    stale.push(h);
  }
  const holds = stores.get('holds');
  const holdExpiry = stores.get('hold-expiry');
  for (const k of [...holdExpiry.data.keys()]) holdExpiry.data.delete(k);
  for (const h of stale) {
    const row = JSON.parse(holds.data.get(h.hold_id));
    row.expires_at = new Date(Date.now() - 1000).toISOString();
    holds.data.set(h.hold_id, JSON.stringify(row));
    holdExpiry.data.set(`${String(Date.parse(row.expires_at)).padStart(16, '0')}:${h.hold_id}`, '1');
  }

  /* sweepHolds checks the FULL budgetMs each iteration (unlike sweep(), which
     splits budgetMs across several sub-tasks via EXPIRY_SHARE): at 10ms a
     step, a 100ms budget allows roughly ten iterations before it trips, so
     N must clear that comfortably for this to test the budget rather than
     the fixture. */
  const removed = await store.sweepHolds(undefined, { budgetMs: 100, clock: steppingClock(10) });
  assert.ok(removed.holds < N, `a budget of 100ms at 10ms a step must not clear all ${N} in one pass`);
  assert.equal(removed.budgetSpent, true);
});

const randomUUIDLike = () => '00000000-0000-4000-8000-' + String(Math.floor(Math.random() * 1e12)).padStart(12, '0');

/* ══ storage, expiry, tokens ══════════════════════════════ */

test('a published passport reads back, and its token is returned once', async () => {
  reset();
  const { id, token, expires_at } = await store.createPassport(undefined, parsed(), GOOD);
  assert.match(token, /^[0-9a-f]{40}$/);
  assert.ok(Date.parse(expires_at) > Date.now());

  const row = await store.readPassport(undefined, id);
  assert.ok(row);
  assert.equal(row.body, GOOD);
  assert.equal(row.delete_token_hash, store.sha256(token));
  assert.equal(row.body.includes(token), false, 'the token must not be in the stored body');
});

test('the plaintext token is never stored anywhere', async () => {
  reset();
  const { token } = await store.createPassport(undefined, parsed(), GOOD);
  for (const s of stores.values()) {
    for (const value of s.data.values()) {
      assert.equal(String(value).includes(token), false,
        'the plaintext token turned up in store ' + s.name);
    }
  }
});

test('an expired passport reads as absent, and the sweeper is what deletes it', async () => {
  reset();
  const { id, token } = await store.createPassport(undefined, parsed(), GOOD);
  expireNow(id);

  /* Reading returns absent and does NOTHING ELSE. Purging on the read path was
     an oracle: an expired id cost a body read and four deletes where an id that
     never existed cost one lookup, with no credential needed to measure it. */
  assert.equal(await store.readPassport(undefined, id), null);
  assert.equal(await store.statusOf(undefined, id, token), null);
  assert.ok(stores.get('passports').data.has(id), 'the read path is doing the sweeper\'s work');

  await store.sweep(undefined);
  assert.equal(stores.get('passports').data.has(id), false, 'the sweeper left an expired passport');
});

test('an expired passport costs a reader exactly what a missing one costs', async () => {
  reset();
  const { id } = await store.createPassport(undefined, parsed(), GOOD);
  expireNow(id);

  /* Same number of store operations, which is the measurable form of "these
     two are the same answer". A wrong token is used for both, because that is
     the case somebody holding a harvested link can actually run. */
  const count = async (target) => {
    let n = 0;
    const real = stores.get('passports');
    const wrap = new Proxy(real, {
      get(t, prop) {
        const v = t[prop];
        if (typeof v === 'function') return (...a) => { n++; return v.apply(t, a); };
        return v;
      }
    });
    stores.set('passports', wrap);
    await store.authorise(undefined, target, 'f'.repeat(40));
    stores.set('passports', real);
    return n;
  };

  const expired = await count(id);
  const missing = await count('00000000-0000-4000-8000-000000000000');
  assert.equal(expired, missing,
    `an expired id costs ${expired} store operations against ${missing} for one that never existed`);
});

test('a deleted passport and one that never existed are the same answer', async () => {
  reset();
  const { id, token } = await store.createPassport(undefined, parsed(), GOOD);
  assert.equal(await store.deletePassport(undefined, id, token), true);
  assert.equal(await store.readPassport(undefined, id), null);
  assert.equal(await store.readPassport(undefined, '00000000-0000-4000-8000-000000000000'), null);
  assert.equal(await store.statusOf(undefined, id, token), null);
});

test('a wrong or malformed token deletes nothing', async () => {
  reset();
  const { id, token } = await store.createPassport(undefined, parsed(), GOOD);
  assert.equal(await store.deletePassport(undefined, id, 'f'.repeat(40)), false);
  assert.equal(await store.deletePassport(undefined, id, 'not-a-token'), false);
  assert.equal(await store.deletePassport(undefined, id, token.toUpperCase()), false);
  assert.equal(await store.deletePassport(undefined, id, ''), false);
  assert.ok(await store.readPassport(undefined, id), 'the passport must still be there');
  assert.equal(await store.deletePassport(undefined, id, token), true);
});

test('a view cannot resurrect a deleted passport', async () => {
  reset();
  const { id, token } = await store.createPassport(undefined, parsed(), GOOD);

  /* The page function reads, renders, then bumps. Delete in the middle of that
     and the bump must not write the row back. */
  const row = await store.readPassport(undefined, id);
  assert.ok(row);
  await store.deletePassport(undefined, id, token);
  await store.bumpViews(undefined, id);

  assert.equal(await store.readPassport(undefined, id), null, 'a late view brought the passport back');
  assert.equal(stores.get('passports').data.has(id), false);
  /* ROW-140. This is the assertion the original version of this test did not
     make: it checked the PASSPORT store and never looked at `views`, so the
     orphan `views/<id>` row this sequence used to create passed silently. */
  assert.equal(stores.get('views').data.has(id), false,
    'a late view left an orphan views/<id> row behind');
  assert.equal(await store.readViews(undefined, id), 0);
});

test('bumpViews on an id that never existed writes nothing', async () => {
  reset();
  await store.bumpViews(undefined, '00000000-0000-4000-8000-000000000000');
  /* The existence check now returns before `strong('views')` is ever called,
     so the store is not lazily created at all; a size-0 assertion on a store
     this function never touched would pass for the wrong reason. */
  assert.equal(stores.has('views'), false, 'bumpViews opened the views store for a dead id');
});

test('views count, and deletion takes the counter with it', async () => {
  reset();
  const { id, token } = await store.createPassport(undefined, parsed(), GOOD);
  await store.bumpViews(undefined, id);
  await store.bumpViews(undefined, id);
  assert.equal(await store.readViews(undefined, id), 2);

  const status = await store.statusOf(undefined, id, token);
  assert.equal(status.views, 2);
  assert.equal(status.renewed, 0);

  await store.deletePassport(undefined, id, token);
  assert.equal(await store.readViews(undefined, id), 0);
});

test('renewing moves the expiry and counts itself', async () => {
  reset();
  const { id, token, expires_at } = await store.createPassport(undefined, parsed(), GOOD);

  assert.equal(await store.renewPassport(undefined, id, 'f'.repeat(40)), null, 'a wrong token must not renew');

  const moved = await store.renewPassport(undefined, id, token);
  assert.ok(moved);
  assert.ok(Date.parse(moved) >= Date.parse(expires_at) - 2000);

  const status = await store.statusOf(undefined, id, token);
  assert.equal(status.renewed, 1);
  assert.equal(status.expires_at, moved);

  const row = await store.readPassport(undefined, id);
  assert.equal(row.body, GOOD, 'renewal must not lose the body');
});

test('an expired passport cannot be renewed back to life', async () => {
  reset();
  const { id, token } = await store.createPassport(undefined, parsed(), GOOD);
  expireNow(id);

  assert.equal(await store.renewPassport(undefined, id, token), null);
  assert.equal(await store.statusOf(undefined, id, token), null, 'an expired passport must not report status');
  await store.sweep(undefined);
  assert.equal(stores.get('passports').data.has(id), false);
});

/* ══ the limiter ══════════════════════════════════════════ */

test('the limiter allows exactly the limit and then refuses', async () => {
  reset();
  const results = [];
  for (let i = 0; i < 7; i++) results.push(await store.rateLimit(undefined, '1.2.3.4', 'test', 5, 3600e3));
  assert.equal(results.filter(Boolean).length, 5);
  assert.equal(results.slice(5).every(r => r === null), true);
});

/* A limiter that cannot record an attempt refuses it, and every caller answers
   that with a 429, so in a write outage the visitor is told they tried too
   often and the log used to say nothing. The refusal stays; the log line is
   new, and it carries the bucket and never the subject: an address here, a
   passport id for send-p. */
test('a limiter write failure is logged as a code with the bucket, and no subject', async () => {
  reset();
  const rl = new FakeStore('ratelimit');
  rl.failWrites = true;
  stores.set('ratelimit', rl);
  const id = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
  const { value, ops, raw } = await captureOps(async () => [
    await store.rateLimit(undefined, '203.0.113.77', 'up-h', 5, 3600e3),
    await store.rateLimit(undefined, id, 'send-p', 5, 86400e3)
  ]);
  assert.deepEqual(value, [null, null], 'a blind limiter must still refuse');
  assert.deepEqual(ops, [
    { code: 'RATELIMIT_STORE_WRITE_FAILED', bucket: 'up-h' },
    { code: 'RATELIMIT_STORE_WRITE_FAILED', bucket: 'send-p' }
  ]);
  for (const secret of ['203.0.113.77', store.ipKey('203.0.113.77'), id, store.ipKey(id)]) {
    assert.equal(raw.includes(secret), false, `the log carries a limiter subject: ${secret}`);
  }
});

/* readPassport answers a store error with the same null as a missing id, so
   the page is the not-found page; in an outage that is every passport, and
   nothing was logged. Same for the metadata read behind every owner action. */
test('a failed passport read is logged as a code with the step, and no id', async () => {
  reset();
  const plain = await store.createPassport(undefined, parsed(), GOOD);
  const listed = await store.createPassport(undefined, parsed(), GOOD + '\n', { gallery: { category: CATEGORIES[0].slug } });
  const passports = stores.get('passports');
  const realGet = passports.get.bind(passports);
  const realMeta = passports.getMetadata.bind(passports);

  passports.get = async () => { throw new Error('simulated blob outage'); };
  passports.getMetadata = async () => { throw new Error('simulated blob outage'); };
  const down = await captureOps(async () => [
    await store.readPassport(undefined, plain.id),
    await store.authorise(undefined, plain.id, plain.token)
  ]);
  passports.get = realGet;
  passports.getMetadata = realMeta;
  assert.deepEqual(down.value, [null, null], 'a store error must still read as absent');
  assert.deepEqual(down.ops, [
    { code: 'PASSPORT_READ_FAILED', stage: 'row' },
    { code: 'PASSPORT_READ_FAILED', stage: 'meta' }
  ]);

  const cats = stores.get('gallery-categories') || new FakeStore('gallery-categories');
  stores.set('gallery-categories', cats);
  cats.get = async () => { throw new Error('simulated blob outage'); };
  const category = await captureOps(() => store.readPassport(undefined, listed.id));
  assert.equal(category.value, null);
  assert.deepEqual(category.ops, [{ code: 'PASSPORT_READ_FAILED', stage: 'category' }]);

  for (const { raw } of [down, category]) {
    for (const secret of [plain.id, plain.token, listed.id]) {
      assert.equal(raw.includes(secret), false, 'the log carries a passport id or token');
    }
  }

  /* And a plain miss is not a failure: nothing is logged for an id that does
     not exist, or the line would fire on every guessed link. */
  const miss = await captureOps(() => store.readPassport(undefined, '00000000-0000-4000-8000-000000000000'));
  assert.equal(miss.value, null);
  assert.deepEqual(miss.ops, []);
});

test('a simultaneous burst does not walk through the limit', async () => {
  reset();
  /* This is the case the old read-modify-write counter got wrong: twenty
     requests that all read before any of them wrote. */
  const out = await Promise.all(
    Array.from({ length: 20 }, () => store.rateLimit(undefined, '5.6.7.8', 'burst', 5, 3600e3))
  );
  const allowed = out.filter(Boolean).length;
  assert.ok(allowed <= 5, 'the limiter let ' + allowed + ' through a limit of 5');
});

test('addresses are counted apart', async () => {
  reset();
  for (let i = 0; i < 5; i++) await store.rateLimit(undefined, '9.9.9.9', 'sep', 5, 3600e3);
  assert.equal(await store.rateLimit(undefined, '9.9.9.9', 'sep', 5, 3600e3), null);
  assert.ok(await store.rateLimit(undefined, '8.8.8.8', 'sep', 5, 3600e3), 'another address must be unaffected');
});

test('a refused attempt keeps its place in the window', async () => {
  reset();
  for (let i = 0; i < 5; i++) await store.rateLimit(undefined, '4.4.4.4', 'pen', 5, 3600e3);
  assert.equal(await store.rateLimit(undefined, '4.4.4.4', 'pen', 5, 3600e3), null);

  /* Six keys, not five: the sixth request wrote before it counted, and its key
     stays. That is the delete endpoint's documented "failures are counted"
     rule, and it has to hold here or the limiter would reward retrying. */
  assert.equal(limiterKeys('pen', 3600e3, '4.4.4.4').length, 6);
});

test('a refund gives exactly one attempt back', async () => {
  reset();
  const tickets = [];
  for (let i = 0; i < 3; i++) tickets.push(await store.rateLimit(undefined, '9.9.9.9', 'ref', 5, 3600e3));
  assert.equal(tickets.filter(Boolean).length, 3);

  await store.refundLimit(undefined, tickets[0]);

  /* Two of five spent, so three more, and then no more. */
  const after = [];
  for (let i = 0; i < 4; i++) after.push(await store.rateLimit(undefined, '9.9.9.9', 'ref', 5, 3600e3));
  assert.equal(after.filter(Boolean).length, 3, 'a refund freed the wrong number of attempts');
  assert.equal(after[3], null);
});

test('an old window is not counted against the current one', async () => {
  reset();
  const rl = new FakeStore('ratelimit');
  stores.set('ratelimit', rl);
  for (let i = 0; i < 5; i++) {
    rl.data.set(`3600000:${String(1).padStart(12, '0')}:sweep:${store.ipKey('7.7.7.7')}:${i}`, '1');
  }

  /* The bucket is part of the counting prefix now, so a dead bucket is not
     something to filter out on the hot path: it is simply not looked at. */
  assert.ok(await store.rateLimit(undefined, '7.7.7.7', 'sweep', 5, 3600e3));
  assert.equal(limiterKeys('sweep', 3600e3, '7.7.7.7').length, 1);

  await store.sweep(undefined);
  assert.equal(rl.data.size, 1, 'the dead bucket survived a sweep');
});

test('the limiter sweep reaches dead keys behind a wall of live ones', async () => {
  reset();
  const rl = new FakeStore('ratelimit');
  stores.set('ratelimit', rl);
  rl.page = 50;

  /* The failure this key order was changed to fix. Keyed by kind first, the
     store sorted `bad-h` before `up-h`, so a bounded sweep reading the early
     pages never reached a dead `up-h` key behind four thousand live `bad-h`
     ones and the store grew forever. */
  const now = Date.now();
  const liveBucket = String(Math.floor(now / 3600e3)).padStart(12, '0');
  for (let i = 0; i < 4001; i++) {
    rl.data.set(`3600000:${liveBucket}:bad-h:${store.ipKey('9.9.9.9')}:${i}`, '1');
  }
  for (let i = 0; i < 50; i++) {
    rl.data.set(`3600000:${String(1).padStart(12, '0')}:up-h:${store.ipKey('9.9.9.9')}:${i}`, '1');
  }

  const removed = await store.sweep(undefined);
  assert.ok(removed.limits > 0,
    'the sweeper could not reach a single dead key past the live ones');
  assert.equal(rl.data.size, 4001 + 50 - removed.limits);
});
const idInSlice = (prefix) => `${prefix}000000-0000-4000-8000-000000000000`;
const sliceAt = (now) => store.VIEWS_SLICES[Math.floor(now / DAY_MS) % store.VIEWS_SLICES.length];

test('sweep reclaims a views orphan whose id falls in the day\'s slice', async () => {
  reset();
  const now = 1000 * DAY_MS;
  const orphan = idInSlice(sliceAt(now));

  const views = new FakeStore('views');
  stores.set('views', views);
  views.data.set(orphan, JSON.stringify({ n: 1 }));
  /* No matching entry in `passports`: this id is a genuine orphan. */

  const removed = await store.sweep(undefined, { now });
  assert.equal(removed.views, 1);
  assert.equal(views.data.has(orphan), false, 'the orphan survived a sweep of its own slice');
});

test('sweep leaves a views orphan alone outside the day\'s slice, and reaches it on its day', async () => {
  reset();
  const now = 1000 * DAY_MS;
  const todaySlice = sliceAt(now);
  const otherSlice = store.VIEWS_SLICES[(store.VIEWS_SLICES.indexOf(todaySlice) + 1) % store.VIEWS_SLICES.length];
  const orphan = idInSlice(otherSlice);

  const views = new FakeStore('views');
  stores.set('views', views);
  views.data.set(orphan, JSON.stringify({ n: 1 }));

  await store.sweep(undefined, { now });
  assert.equal(views.data.has(orphan), true,
    'a bounded scan touched a slice it was not scheduled to read today');

  /* One day later, the rotation reaches the slice this id lives in. */
  const removed = await store.sweep(undefined, { now: now + DAY_MS });
  assert.equal(removed.views, 1);
  assert.equal(views.data.has(orphan), false, 'the orphan was not reclaimed on its own day');
});

test('the views reclaim never deletes a row whose passport still exists', async () => {
  /* GAP 1, found by a critic mutating the liveness check to "everything is an
     orphan" and watching this test pass anyway. The bug: `now + idx * DAY_MS`
     does not land on slice `idx`. `sweep()` reads
     VIEWS_SLICES[floor(now / DAY_MS) % 256]; adding `idx` whole days to a
     `now` that is not itself day-aligned to slice 0 offsets by `idx` from
     WHATEVER slice `now` was already on, not from slice 0. With
     `now = 1000 * DAY_MS` that base is slice 232, so `alignedNow` swept slice
     `(232 + idx) % 256`, never `idx`, for any UUID — the live passport's
     views key was never a candidate, so `removed.views === 0` was true
     because the block looked at nothing. `idx * DAY_MS` alone lands exactly
     on slice `idx`: floor(idx * DAY_MS / DAY_MS) % 256 === idx for every
     idx in [0, 256). Verified this is now load-bearing by re-running the
     "everything is an orphan" mutation against the fixed alignment: it fails,
     here, specifically. */
  reset();
  const { id } = await store.createPassport(undefined, parsed(), GOOD);
  await store.bumpViews(undefined, id);
  const idx = store.VIEWS_SLICES.indexOf(id.slice(0, 2).toLowerCase());
  const alignedNow = idx === -1 ? 1000 * DAY_MS : idx * DAY_MS;

  const removed = await store.sweep(undefined, { now: alignedNow });
  assert.equal(removed.views, 0, 'a live passport\'s view count was swept as an orphan');
  assert.equal(await store.readViews(undefined, id), 1);
});

test('a getMetadata that throws during the views reclaim is treated as unknown, not gone', async () => {
  /* GAP 2, found by the same critic pass: _store.mjs's comment on the views
     reclaim block claims a thrown getMetadata is treated as "unknown, not
     gone", matching this file's existing failed-read-vs-absent discipline
     everywhere else. Nothing exercised it — FakeStore.getMetadata has no
     failure mode at all, so the mutation that flips the rejection handler to
     "treat a throw as gone" passed all 110 tests with the shipped `.then(m =>
     m === null, () => false)` still in place, silently, and would also have
     passed with `() => true` there instead. This constructs exactly that: a
     views orphan in today's slice, and a passports store whose getMetadata
     throws. */
  reset();
  const now = 1000 * DAY_MS;
  const orphan = idInSlice(sliceAt(now));

  const views = new FakeStore('views');
  stores.set('views', views);
  views.data.set(orphan, JSON.stringify({ n: 1 }));

  const passports = new FakeStore('passports');
  stores.set('passports', passports);
  passports.getMetadata = async () => { throw new Error('simulated blob read failure'); };

  const removed = await store.sweep(undefined, { now });
  assert.equal(removed.views, 0,
    'a getMetadata failure was read as "gone" and deleted a views row nothing proved was orphaned');
  assert.equal(views.data.has(orphan), true);
});

test('the limiter stores a hash of the address, not the address', async () => {
  reset();
  await store.rateLimit(undefined, '203.0.113.9', 'priv', 5, 3600e3);
  const keys = [...stores.get('ratelimit').data.keys()];
  assert.equal(keys.length, 1);
  assert.equal(keys[0].includes('203.0.113.9'), false,
    'the caller address is written into a durable key: ' + keys[0]);
  assert.ok(keys[0].includes(store.ipKey('203.0.113.9')));
});

test('addresses with colons in them do not collide', async () => {
  reset();
  /* A raw IPv6 address contains colons, so `kind:2001:db8::1:` was a prefix of
     another address's keys and the stale sweep would have deleted them.

     The second address here used to be 2001:db8::1:2. That is in the same /64
     as the first, and an IPv6 caller is now counted per /64 on purpose, so it
     would be refused for the right reason. This one is in the next /64 and its
     text still starts with the first address's text, which is the collision
     this test exists for. */
  for (let i = 0; i < 5; i++) await store.rateLimit(undefined, '2001:db8::1', 'v6', 5, 3600e3);
  assert.ok(await store.rateLimit(undefined, '2001:db8::1:2:3:4:5', 'v6', 5, 3600e3),
    'a different network was counted against the first one');
  assert.equal(limiterKeys('v6', 3600e3, '2001:db8::1').length, 5);
});

test('a lagging list makes the limiter over-run, boundedly, then converge', async () => {
  reset();
  await store.rateLimit(undefined, '6.6.6.6', 'lag', 3, 3600e3);
  const rl = stores.get('ratelimit');

  /* Netlify Blobs listing is eventually consistent. Hide the two most recent
     writes and the limiter cannot see them, which is the real failure mode the
     Map-backed double used to hide entirely. */
  rl.hide = 2;
  const during = [];
  for (let i = 0; i < 4; i++) during.push(await store.rateLimit(undefined, '6.6.6.6', 'lag', 3, 3600e3));

  /* It over-runs. What matters is that it over-runs by at most the lag, not
     without limit: the writes are all there and nothing was lost. */
  const extra = during.filter(Boolean).length - 2;
  assert.ok(extra <= 2, 'over-ran by ' + extra + ', more than the listing lag');

  rl.hide = 0;
  assert.equal(await store.rateLimit(undefined, '6.6.6.6', 'lag', 3, 3600e3), null,
    'once the writes are visible the limiter must refuse');
});

test('the counted address comes from the edge, never from the caller', () => {
  /* X-Forwarded-For is a list a proxy chain appends to. The LAST element is
     what the nearest trusted hop wrote; the first is whatever the client
     typed. Reading it from the left, which this used to do, made every limiter
     free to evade and free to poison against a chosen victim on any deployment
     where the platform header was missing. No test sent this header at all,
     which is how the regression would have shipped. */
  const req = (headers) => ({ headers: new Headers(headers) });

  assert.equal(store.clientIp(req({ 'x-nf-client-connection-ip': '203.0.113.7' })), '203.0.113.7');
  assert.equal(
    store.clientIp(req({
      'x-nf-client-connection-ip': '203.0.113.7',
      'x-forwarded-for': '1.2.3.4, 203.0.113.7'
    })),
    '203.0.113.7',
    'a forwarded-for header overrode the edge'
  );
  assert.equal(
    store.clientIp(req({ 'x-forwarded-for': '9.9.9.9, 8.8.8.8, 203.0.113.7' })),
    '203.0.113.7',
    'the fallback took the value the client supplied'
  );
  assert.equal(store.clientIp(req({})), 'unknown');
});

/* ══ what a limiter counts: the network, not the address ═══
   An IPv6 customer is routed a block of 2^64 addresses, so a ceiling counted
   per IPv6 address could be reset at will. ipKey now counts an IPv6 caller by
   its /64 and an IPv4 caller by its address, as before. These pin both halves,
   every spelling an address can arrive in, and text that is not an address. */

test('an IPv4 caller is counted under the key it always had', () => {
  /* The IPv4 claim is "nothing moved", so this pins the old formula itself
     rather than a round trip through the new function: a key that changed shape
     at deploy would hand every IPv4 caller a fresh window. */
  for (const ip of ['203.0.113.7', '198.51.100.250', '9.9.9.9', '0.0.0.0', '255.255.255.255']) {
    assert.equal(store.ipKey(ip), store.sha256(ip).slice(0, 32), `${ip} is counted under a new key`);
  }
  for (const ip of ['203.0.113.7:8080', '[203.0.113.7]', '[203.0.113.7]:80', ' 203.0.113.7 ']) {
    assert.equal(store.ipKey(ip), store.ipKey('203.0.113.7'), `${ip} was counted as a second caller`);
  }
  assert.notEqual(store.ipKey('203.0.113.7'), store.ipKey('203.0.113.8'),
    'two IPv4 addresses were counted as one caller');
});

test('an IPv6 caller is counted per /64, however the address is spelled', () => {
  assert.equal(store.IPV6_BLOCK_BITS, 64);
  const key = store.ipKey('2001:db8:abcd:1234::1');
  const sameBlock = [
    '2001:db8:abcd:1234:ffff:ffff:ffff:ffff',       // the far end of the block
    '2001:0DB8:ABCD:1234:0000:0000:0000:0002',       // upper case, in full, leading zeros
    '2001:db8:abcd:1234:0:0:0:3',
    '[2001:db8:abcd:1234::4]',
    '[2001:db8:abcd:1234::5]:443',
    '2001:db8:abcd:1234::6%eth0',
    '[2001:db8:abcd:1234::7%25en0]:8443',
    '  2001:db8:abcd:1234::8  ',
    '2001:db8:abcd:1234:9:9:192.0.2.1'               // a dotted tail
  ];
  for (const ip of sameBlock) {
    assert.equal(store.ipKey(ip), key, `${ip} was counted outside its /64`);
  }
  for (const ip of ['2001:db8:abcd:1235::1', '2001:db8:abcd:1233:ffff:ffff:ffff:ffff', '2001:db9:abcd:1234::1']) {
    assert.notEqual(store.ipKey(ip), key, `${ip} was counted in a /64 it is not in`);
  }
});

test('an IPv4 address written as IPv4-mapped IPv6 is that IPv4 address', () => {
  const v4 = store.ipKey('203.0.113.7');
  for (const ip of ['::ffff:203.0.113.7', '::FFFF:203.0.113.7', '::ffff:cb00:7107',
                    '0:0:0:0:0:ffff:203.0.113.7', '[::ffff:203.0.113.7]:443']) {
    assert.equal(store.ipKey(ip), v4, `${ip} was not counted as 203.0.113.7`);
  }
  /* And two mapped addresses are two callers. Cut to a /64 they would all be
     one, ::/64, which is every dual-stack IPv4 caller in a single bucket. */
  assert.notEqual(store.ipKey('::ffff:203.0.113.8'), v4, 'two mapped IPv4 callers shared a bucket');
});

test('outside global unicast an IPv6 address is counted in full', () => {
  /* Loopback, link-local, unique-local, IPv4-compatible and NAT64: a /64 in any
     of these is not one customer's network, and cutting it would put unrelated
     callers in one bucket. */
  const pairs = [['::1', '::2'], ['fe80::1', 'fe80::2'], ['fc00::1', 'fc00::2'],
                 ['::203.0.113.7', '::203.0.113.8'], ['64:ff9b::203.0.113.7', '64:ff9b::203.0.113.8']];
  for (const [a, b] of pairs) {
    assert.notEqual(store.ipKey(a), store.ipKey(b), `${a} and ${b} were put in one bucket`);
  }
  assert.equal(store.ipKey('fe80::1%lo0'), store.ipKey('FE80::1'), 'a zone or case made a second bucket');
});

test('the /64 grouping covers exactly 2000::/3, from 2000:: to the last 3fff: address', () => {
  /* Both ends inside, and the addresses just outside each end. A range cut to
     2000::/4 fails the 3fff pair; one widened past /3 fails 1fff or 4000. */
  for (const net of ['2000:0:0:0', '3fff:ffff:ffff:ffff']) {
    assert.equal(store.ipKey(`${net}:0:0:0:1`), store.ipKey(`${net}:ffff:ffff:ffff:ffff`),
      `${net}::/64 is inside 2000::/3 and was not counted as one caller`);
  }
  for (const net of ['1fff:ffff:ffff:ffff', '4000:0:0:0']) {
    assert.notEqual(store.ipKey(`${net}:0:0:0:1`), store.ipKey(`${net}:0:0:0:2`),
      `${net}::/64 is outside 2000::/3 and was grouped by its /64`);
  }
});

test('text that is not an address is counted as itself, one bucket per text', () => {
  /* Each keeps exactly the key it had before this change, which is also what
     keeps them apart: a shared "invalid" key, which one caller could fill for
     every other unparseable caller, fails the first of these. */
  const junk = ['unknown', '', 'garbage', '1.2.3', '01.2.3.4', '256.1.1.1', '1.2.3.4.5',
                '2001:db8::1::2', '12345::1', '2001:db8:1:2:3:4:5:6:7', '[2001:db8::1',
                '1.2.3.4%eth0', 'x'.repeat(100)];
  for (const j of junk) {
    assert.equal(store.ipKey(j), store.sha256(j).slice(0, 32), `${JSON.stringify(j)} was rewritten`);
  }
});

test("the limiter's other subjects are never read as addresses", () => {
  /* A passport id (send-p), a mailbox hash (send-r) and the whole site
     (send-g) go through the same key function. None may be rewritten, or a
     ceiling would silently move under them. */
  const subjects = ['3bdc07b1-6b5f-4b2a-9c1e-0f5d2a6e7c11', store.mailboxKey('a@example.com'), 'site'];
  for (const s of subjects) {
    assert.equal(store.networkOf(s), s, `${s} was rewritten, so the ceiling keyed on it would move`);
    assert.equal(store.ipKey(s), store.sha256(s).slice(0, 32));
  }
});

test('the block width is one dial', () => {
  const a = '2001:db8:abcd:12ff::1', b = '2001:db8:abcd:1200::1', c = '2001:db8:abcd:1300::1';
  assert.equal(store.networkOf(a), store.networkOf(a, 64));
  assert.notEqual(store.networkOf(a, 64), store.networkOf(b, 64));
  assert.equal(store.networkOf(a, 56), store.networkOf(b, 56));
  assert.notEqual(store.networkOf(a, 56), store.networkOf(c, 56));
  assert.equal(store.networkOf(a, 48), store.networkOf(c, 48));
  assert.notEqual(store.networkOf(a, 128), store.networkOf('2001:db8:abcd:12ff::2', 128));
});

test('the limiter refuses one /64 after its budget, whichever address in it asks', async () => {
  reset();
  for (let i = 1; i <= 5; i++) {
    assert.ok(await store.rateLimit(undefined, `2001:db8:77::${i}`, 'net', 5, 3600e3), `attempt ${i} was refused`);
  }
  assert.equal(await store.rateLimit(undefined, '2001:db8:77:0:ffff:ffff:ffff:ffff', 'net', 5, 3600e3), null,
    'a sixth address in the same /64 was given a fresh budget');
  assert.ok(await store.rateLimit(undefined, '2001:db8:77:1::1', 'net', 5, 3600e3), 'the next /64 was refused');
  assert.ok(await store.rateLimit(undefined, '203.0.113.99', 'net', 5, 3600e3), 'an IPv4 caller was refused');
});

test('a recipient is counted by a hash of the address as typed, lower-cased and trimmed', () => {
  const k = store.mailboxKey('them@example.com');
  assert.match(k, /^[0-9a-f]{64}$/);
  for (const a of ['Them@Example.com', ' THEM@EXAMPLE.COM ', 'them@example.com']) {
    assert.equal(store.mailboxKey(a), k, `${a} was counted as a second mailbox`);
  }
  /* Not merged, and pinned so that merging them is a decision someone makes:
     whether a plus-tag or a dot reaches the same mailbox is each provider's
     rule. The site-wide ceiling bounds a mailbox with many spellings. */
  for (const a of ['them+x@example.com', 't.hem@example.com', 'them@example.org']) {
    assert.notEqual(store.mailboxKey(a), k, `${a} was merged into them@example.com`);
  }
});

test('a missing passport costs the same comparison as a present one', () => {
  /* authorise() runs a constant-time compare against a hash that cannot match
     when there is nothing there, so the not-found branch does the same sha256
     and the same timingSafeEqual as the found one. There is no way to observe
     that from outside, so this asserts the property the code depends on:
     hashMatches on a well-formed token is total, and returns false rather
     than short-circuiting on the zero hash. */
  assert.equal(store.hashMatches('0'.repeat(64), 'a'.repeat(40)), false);
  assert.equal(store.hashMatches(store.sha256('a'.repeat(40)), 'a'.repeat(40)), true);
  assert.equal(store.hashMatches('0'.repeat(64), 'not-a-token'), false);
});

test('the sweeper treats a failed read as unknown, not as absent', async () => {
  reset();
  const { id, token } = await store.createPassport(undefined, parsed(), GOOD);
  await store.renewPassport(undefined, id, token);

  /* The state an interrupted renewal leaves, plus one thing storage does under
     load: the re-read throws. `.catch(() => null)` turned that into "cannot
     confirm it is alive, therefore delete", and a live passport went with it,
     irreversibly, under a comment claiming this exact line was the difference
     between a sweeper and a data-loss bug. */
  const expiry = stores.get('expiry');
  expiry.data.set(`${String(Date.now() - 60_000).padStart(16, '0')}:${id}`, '1');

  const passports = stores.get('passports');
  const realGet = passports.get.bind(passports);
  let thrown = 0;
  passports.get = async (key, opts) => {
    if (key === id && thrown === 0) { thrown++; throw new Error('transient'); }
    return realGet(key, opts);
  };

  const removed = await store.sweep(undefined);
  passports.get = realGet;

  assert.equal(thrown, 1, 'the read never failed, so this proves nothing');
  assert.equal(removed.passports, 0, 'a failed read was treated as an absent passport');
  assert.ok(passports.data.has(id), 'the sweeper deleted a live passport on a storage hiccup');
});

test('readCorpusDay reads one day and not its neighbours', async () => {
  const s = await import('../lib/_store.mjs');
  const data = new Map([
    ['metrics', new Map([
      ['2026-08-18:aaa', JSON.stringify({ v: 1, day: '2026-08-18', refs: ['web.fetch'] })],
      ['2026-08-19:bbb', JSON.stringify({ v: 1, day: '2026-08-19', refs: ['files.read'] })]
    ])],
    ['attempts', new Map([
      ['2026-08-18:ccc', JSON.stringify({ v: 1, day: '2026-08-18', code: 'E_SCRUB_GATE' })],
      ['2026-08-17:ddd', JSON.stringify({ v: 1, day: '2026-08-17', code: 'E_CAPABILITY' })]
    ])]
  ]);
  s.__useStoreFactory(name => ({
    list: async ({ prefix }) => ({
      blobs: [...(data.get(name) || new Map()).keys()]
        .filter(k => !prefix || k.startsWith(prefix)).map(key => ({ key }))
    }),
    get: async (key) => JSON.parse(data.get(name).get(key))
  }));

  try {
    const got = await s.readCorpusDay(undefined, '2026-08-18');
    assert.equal(got.metrics.length, 1, 'read the wrong number of metrics rows');
    assert.equal(got.attempts.length, 1, 'read the wrong number of attempt rows');
    assert.equal(got.metrics[0].day, '2026-08-18');
    assert.equal(got.attempts[0].code, 'E_SCRUB_GATE');
    assert.equal(got.listed, true);
  } finally {
    /* PUT THE SUITE'S OWN DOUBLE BACK. __useStoreFactory is global, so a test
       that swaps it and returns leaves every test after it talking to this
       one's two hard-coded days. Nothing failed when this was written because
       these tests are last in the file, which is a property of where they sit
       rather than of the test, and the next person to append will not know. */
    s.__useStoreFactory(name => {
      if (!stores.has(name)) stores.set(name, new FakeStore(name));
      return stores.get(name);
    });
  }
});

test('getDay is a date and the two corpora agree on it', async () => {
  const { getDay } = await import('../lib/_store.mjs');
  assert.equal(getDay(Date.parse('2026-08-18T23:59:59Z')), '2026-08-18');
  assert.equal(getDay(Date.parse('2026-08-19T00:00:01Z')), '2026-08-19');
  assert.match(getDay(Date.now()), /^\d{4}-\d{2}-\d{2}$/);
});

/* ── ROW-37: deploy scoping ─────────────────────────────────
   Every test above this section calls the store functions with `undefined`
   as the deploy argument, which resolves to the bare production scope and
   preserves exactly the behaviour this suite already pinned. That is
   necessary coverage — a threading change that broke the default path would
   be the worst possible version of this fix — but it is not sufficient: it
   never exercises the ALLOWLIST in deployScope() or proves that two
   different scopes actually reach two different stores. These do. */

test('deployScope: the allowlist, not the exceptions', async () => {
  const { deployScope } = await import('../lib/_store.mjs');

  /* THE SAFE DEFAULT. Absent context, an absent deploy object entirely, and
     a context value this file does not recognise all resolve to the bare
     name, on purpose: wrongly scoping a production request is the
     catastrophic direction, wrongly leaving something bare is today's
     hazard, unchanged. See the comment on deployScope itself. */
  assert.equal(deployScope(undefined), '', 'no deploy object at all');
  assert.equal(deployScope(null), '', 'a null deploy object');
  assert.equal(deployScope({}), '', 'a deploy object with no context field');
  assert.equal(deployScope({ context: 'production' }), '', 'the documented production value');
  assert.equal(deployScope({ context: 'production', id: 'some-deploy-id' }), '',
    'production is checked BEFORE the id is read, so a rotating deploy id never reaches production');
  assert.equal(deployScope({ context: 'dev' }), '',
    'netlify dev sets x-nf-deploy-context to the literal string "dev" (see sweep.mjs); not on the allowlist, so bare');
  assert.equal(deployScope({ context: 'staging' }), '',
    'a context value nobody has documented is refused into the SAFE direction, not the scoped one');

  /* THE TWO VALUES THIS FILE WILL SCOPE AWAY FROM PRODUCTION, per
     @netlify/serverless-functions-api's dist/context.d.ts. */
  assert.equal(deployScope({ context: 'deploy-preview', id: 'abc123' }), 'dp-abc123-');
  assert.equal(deployScope({ context: 'branch-deploy', id: 'def456' }), 'dp-def456-');

  /* THE ID IS PREFERRED OVER THE BRANCH, and either is enough. A branch
     deploy without an id (should not happen, but nothing here trusts the
     platform to always send everything) still gets scoped rather than
     falling through to bare. */
  assert.equal(deployScope({ context: 'branch-deploy', branch: 'feature-x' }), 'dp-feature-x-',
    'falls back to the branch when there is no id');
  assert.equal(deployScope({ context: 'deploy-preview', id: 'abc', branch: 'feature-x' }), 'dp-abc-',
    'id wins when both are present');
  assert.equal(deployScope({ context: 'deploy-preview' }), 'dp-unknown-',
    'neither id nor branch: scoped away from production anyway, into a shared bucket rather than bare');
});

/* A critic reviewing this branch reproduced a real crash: a `branch-deploy`
   whose `branch` is this repository's own branch naming convention
   (`backend/row-37-deploy-scope`) produced the store name
   `dp-backend/row-37-deploy-scope-fingerprints`, and Netlify Blobs'
   `validateStoreName` (node_modules/@netlify/blobs/dist/main.js) THROWS
   SYNCHRONOUSLY on any `/` in a store name, out of `getStore` itself, before
   any network call — turning what should be at worst a scoping miss into a
   500 on every store call in the request. This tests the sanitiser against
   the REAL package's real validator, not a re-implementation of its rules
   that could drift from what the package actually enforces. */
test('deployScope never produces a name @netlify/blobs\' own validator refuses', async () => {
  const { deployScope } = await import('../lib/_store.mjs');
  const { getStore } = await import('@netlify/blobs');

  const cases = [
    { context: 'branch-deploy', branch: 'backend/row-37-deploy-scope' },   // the critic's exact repro
    { context: 'branch-deploy', branch: 'a/b/c/d/e' },
    { context: 'deploy-preview', id: 'x'.repeat(200) },                    // absurdly long
    { context: 'branch-deploy', branch: 'x'.repeat(60) },                  // long, no slash
    { context: 'deploy-preview', id: '%2Fslash-encoded' },
  ];

  for (const deploy of cases) {
    const scope = deployScope(deploy);
    // longest store name this file opens; see the budget comment on deployScope
    const name = scope + 'fingerprints';
    assert.doesNotThrow(
      () => getStore({ name, siteID: 'test-site', token: 'test-token' }),
      `deployScope(${JSON.stringify(deploy)}) produced "${name}", which the real validator refused`);
  }
});

test('deploy scoping actually isolates the passport store, not just the name', async () => {
  reset();
  const preview = { context: 'deploy-preview', id: 'pr-42' };

  /* Published from a preview, this must land in a DIFFERENT FakeStore than
     the one production reads, or the whole fix is cosmetic. */
  const { id, token } = await store.createPassport(preview, parsed(), GOOD);

  assert.equal(stores.has('passports'), false,
    'a preview publish must not touch the bare production store at all');
  assert.equal(stores.has('dp-pr-42-passports'), true,
    'and must land in its own, scoped store');

  /* THE SAME ID, READ UNDER PRODUCTION SCOPE, DOES NOT EXIST. This is the
     actual hazard ROW-37 exists to close: a stranger who happens onto a
     preview URL and a stranger who happens onto the production URL must not
     be able to reach the same row through two different deploys. */
  assert.equal(await store.readPassport(undefined, id), null,
    'production must not be able to read a passport a preview created');
  const previewRow = await store.readPassport(preview, id);
  assert.ok(previewRow, 'but the SAME deploy that created it can read it back');

  /* Deletion has to respect the same boundary, or a preview visitor could
     use their token to reach into production, or vice versa. */
  assert.equal(await store.deletePassport(undefined, id, token), false,
    'production cannot delete a passport it cannot see');
  assert.equal(await store.deletePassport(preview, id, token), true,
    'the preview that made it, can');
});

test('deploy scoping isolates every store the limiter and duplicate guard touch', async () => {
  reset();
  const preview = { context: 'deploy-preview', id: 'pr-9' };
  const branch = { context: 'branch-deploy', id: 'staging-9' };

  /* Same IP, same window, three different scopes: each must get its own
     five-request ceiling rather than sharing one. A shared ceiling would
     mean a stranger hammering a preview could exhaust the rate limit a real
     publisher on production depends on. */
  for (let i = 0; i < 5; i++) {
    assert.ok(await store.rateLimit(undefined, '1.2.3.4', 'up-h', 5, 3600e3),
      `production ticket ${i}`);
    assert.ok(await store.rateLimit(preview, '1.2.3.4', 'up-h', 5, 3600e3),
      `preview ticket ${i}`);
    assert.ok(await store.rateLimit(branch, '1.2.3.4', 'up-h', 5, 3600e3),
      `branch ticket ${i}`);
  }
  assert.equal(await store.rateLimit(undefined, '1.2.3.4', 'up-h', 5, 3600e3), null,
    'production is now at its own ceiling');
  assert.equal(await store.rateLimit(preview, '1.2.3.4', 'up-h', 5, 3600e3), null,
    'the preview is at its own ceiling, independently');
  assert.equal(await store.rateLimit(branch, '1.2.3.4', 'up-h', 5, 3600e3), null,
    'and so is the branch deploy');

  /* Same fingerprint, same body, two scopes: a duplicate CLAIMED in a
     preview must not make production refuse an identical, unrelated
     publish. seenRecently only reads; claimFingerprint is the write, split
     apart by ROW-128 so a storage failure at publish cannot claim a
     fingerprint for a passport that does not exist. */
  const fp = store.sha256('identical body for the duplicate guard test');
  const bucket = Math.floor(Date.now() / 3600e3);
  assert.equal(await store.seenRecently(undefined, fp), false, 'production has not seen it');
  assert.equal(await store.seenRecently(preview, fp), false, 'nor has the preview, independently');
  await store.claimFingerprint(preview, fp, bucket);
  assert.equal(await store.seenRecently(preview, fp), true, 'the preview now has, on its own record');
  assert.equal(await store.seenRecently(undefined, fp), false,
    'a claim made inside the preview must not be visible to production');
});

test('sweep() never reaches across the scope boundary', async () => {
  reset();
  const preview = { context: 'deploy-preview', id: 'pr-77' };

  /* A passport expired in a preview must be reclaimed by a sweep running in
     that preview's scope, and MUST NOT be touched by a sweep running
     unscoped (which is what production's scheduled sweep always is, since
     sweep.mjs's own guard refuses anything that is not production). If a
     bare sweep could see into `dp-pr-77-*`, an attacker who got a schedule
     to fire against a preview could use it to reach production-adjacent
     scopes it has no business touching, and conversely a stray bare sweep
     must never silently delete a preview's data out from under whoever is
     using it to test with. */
  const now = Date.now();
  const { id } = await store.createPassport(preview, parsed(), GOOD);
  // age it past its expiry directly through the scoped store, the same way
  // other sweep tests in this file do.
  const expiry = stores.get('dp-pr-77-expiry');
  const [key] = [...expiry.data.keys()];
  assert.ok(key, 'the preview publish wrote its own expiry index entry');

  const bareRemoved = await store.sweep(undefined, { now: now + 40 * 86400e3 });
  assert.equal(bareRemoved.passports, 0,
    'an unscoped sweep must not see, let alone remove, a preview-scoped passport');
  assert.equal(stores.get('dp-pr-77-passports').data.has(id), true,
    'the preview row is still there after the bare sweep ran');

  const previewRemoved = await store.sweep(preview, { now: now + 40 * 86400e3 });
  assert.equal(previewRemoved.passports, 1,
    'the SAME deploy that owns this scope reclaims it normally');
});

/* ── ROW-155: the scope registry and sweepScopes() ──────────
   ROW-37 closed the isolation hazard; this closes the retention one it left
   behind. `sweep()` never sees a `dp-<id>-*` family because it never runs
   with a scoped `deploy`, so nothing here reused those tests: this is a
   different mechanism, exercised on its own.

   FOUR CRITICS REFUTED FOUR VERSIONS OF THIS SECTION IN ONE DAY, each with
   a working counterexample against the previous fix. Every version keyed
   the registry by something with no time signal in it and then tried to
   bound how much of it a run could read: a count cap, then a per-day slice
   rotation, then an uncapped check phase, then a budget split. Each test
   written alongside a fix reproduced the defect that fix closed and was
   calibrated, by construction, not to reach the one it left open. The
   registry key now carries `lastSeen` (see `seenKey` in _store.mjs), which
   is the shape `limitPrefix` and `expiryKey` already use, so the oldest
   scope is always the first key read and no bounded read can miss it.

   The tests below therefore attack the one property that matters, from
   the direction every earlier test avoided: the dead scope is made to sort
   LAST by every signal except time (scope string of `zzz`, registered after
   everything else, behind a backlog larger than any budget), and the run
   still has to reach it. */
const ageScope = async (scope, lastSeen) => {
  const registry = stores.get('scopes');
  const truth = await registry.get(store.scopeKey(scope), { type: 'json' });
  assert.ok(truth, `${scope} was never registered`);
  await registry.delete(store.seenKey(truth.lastSeen, scope));
  const aged = { ...truth, lastSeen };
  await registry.setJSON(store.scopeKey(scope), aged);
  await registry.setJSON(store.seenKey(lastSeen, scope), aged);
};
const registryKeys = async () => (await stores.get('scopes').list()).blobs.map(b => b.key).sort();
/* `reset()` clears the fake stores but not _store.mjs's per-instance dedupe
   map, so a scope id reused across tests would silently never re-register. */
const resetScopes = () => { reset(); store.__forgetRegistrations(); };
const EIGHT_DAYS_AGO = () => Date.now() - 8 * DAY_MS;
const EMPTY_RESULT = {
  scopesTornDown: 0, scopesPending: 0, scopesRefreshed: 0, scopesUnreadable: 0,
  scopeKeysRemoved: 0, scopeListFailed: false, scopeBudgetSpent: false, scopesAbandoned: 0
};

test('a scoped store call registers the scope, in the bare registry, under both keys', async () => {
  resetScopes();
  const preview = { context: 'deploy-preview', id: 'pr-201' };

  await store.rateLimit(preview, '1.2.3.4', 'up-h', 5, 3600e3);
  /* The registration is fire-and-forget, three awaited store calls deep;
     let it land before looking. */
  await new Promise(r => setTimeout(r, 0));

  assert.equal(stores.has('scopes'), true, 'the registry store was never opened');
  const truth = await stores.get('scopes').get(store.scopeKey('dp-pr-201-'), { type: 'json' });
  assert.ok(truth, 'the scope has no truth record after a scoped store call');
  assert.equal(truth.context, 'deploy-preview');
  assert.equal(truth.id, 'pr-201');
  assert.ok(Number.isFinite(truth.lastSeen), 'lastSeen is not a number');
  const keys = await registryKeys();
  assert.deepEqual(keys, [store.scopeKey('dp-pr-201-'), store.seenKey(truth.lastSeen, 'dp-pr-201-')].sort(),
    'the registry holds something other than exactly one truth record and one index entry');
  assert.deepEqual(store.parseSeenKey(store.seenKey(truth.lastSeen, 'dp-pr-201-')),
    { lastSeen: truth.lastSeen, scope: 'dp-pr-201-' }, 'the index key does not round-trip');

  /* A PRODUCTION call must never write here: the registry exists to let a
     bare sweep find non-production scopes, so an entry keyed by the bare
     scope (the empty string) would be nonsensical and, worse, exactly what
     a bug that scoped nothing would still pass. */
  await store.rateLimit(undefined, '1.2.3.4', 'up-h', 5, 3600e3);
  await new Promise(r => setTimeout(r, 0));
  assert.equal((await registryKeys()).length, 2, 'a production store call wrote a registry entry');
});

test('the index sorts by time, not by scope name: an older scope lists first whatever it is called', async () => {
  resetScopes();
  const older = 'dp-zzz-';
  const newer = 'dp-aaa-';
  const t = Date.now();
  await store.rateLimit({ context: 'deploy-preview', id: 'zzz' }, '1.1.1.1', 'up-h', 5, 3600e3);
  await store.rateLimit({ context: 'deploy-preview', id: 'aaa' }, '1.1.1.2', 'up-h', 5, 3600e3);
  await new Promise(r => setTimeout(r, 0));
  await ageScope(older, t - 10 * DAY_MS);
  await ageScope(newer, t - 1 * DAY_MS);
  const seen = (await registryKeys()).filter(k => k.startsWith('seen:'));
  assert.deepEqual(seen.map(k => store.parseSeenKey(k).scope), [older, newer],
    'the index did not put the older scope first');
});

test('sweepScopes never runs for a non-bare deploy, and touches nothing', async () => {
  resetScopes();
  const preview = { context: 'deploy-preview', id: 'pr-9001' };
  await store.rateLimit(preview, '5.6.7.8', 'up-h', 5, 3600e3);
  await new Promise(r => setTimeout(r, 0));
  const before = await registryKeys();

  const result = await store.sweepScopes(preview);
  assert.deepEqual(result, EMPTY_RESULT, 'a scoped caller got anything other than an untouched, empty result');
  assert.deepEqual(await registryKeys(), before, 'a scoped caller changed the registry');
});

test('sweepScopes leaves a scope alone while it is still active, and never reads its truth record', async () => {
  resetScopes();
  const preview = { context: 'deploy-preview', id: 'pr-active' };
  const { id } = await store.createPassport(preview, parsed(), GOOD);
  await new Promise(r => setTimeout(r, 0));

  /* Wrap the registry's `get` to prove the walk stopped at the first fresh
     key rather than reading everything and deciding afterwards: the cost
     of a run must not scale with the number of ACTIVE scopes. */
  const registry = stores.get('scopes');
  let reads = 0;
  const realGet = registry.get.bind(registry);
  registry.get = async (...a) => { reads++; return realGet(...a); };

  const result = await store.sweepScopes(undefined);
  assert.deepEqual(result, EMPTY_RESULT, 'an active scope produced a non-empty result');
  assert.equal(reads, 0, 'the sweep read a truth record for a scope the index already showed was fresh');
  assert.equal(stores.get('dp-pr-active-passports').data.has(id), true,
    'an active preview\'s passport was deleted');
  assert.equal((await registryKeys()).length, 2, 'an active scope was pruned from the registry');
});

test('sweepScopes skips a scope whose truth record is unreadable, the safe direction, and says so', async () => {
  /* A critic flagged the unreadable-metadata branch as untested in the
     first version. Unreadable truth reads as ACTIVE, not abandoned: the
     asymmetry throughout this file is that wrongly leaving something
     alone costs a later cycle, wrongly touching it is not recoverable.
     It is COUNTED, though, because a persistently unreadable record is a
     leak and the count is the only thing that makes it visible. */
  resetScopes();
  const scope = 'dp-pr-corrupt-';
  const preview = { context: 'deploy-preview', id: 'pr-corrupt' };
  const { id } = await store.createPassport(preview, parsed(), GOOD);
  await new Promise(r => setTimeout(r, 0));
  await ageScope(scope, EIGHT_DAYS_AGO());
  await stores.get('scopes').setJSON(store.scopeKey(scope), { context: 'deploy-preview', id: 'pr-corrupt' }); // no lastSeen

  const noField = await store.sweepScopes(undefined);
  assert.equal(noField.scopesTornDown, 0, 'a scope with no lastSeen was torn down anyway');
  assert.equal(noField.scopesUnreadable, 1, 'the unreadable record was not counted');
  assert.equal(stores.get(`${scope}passports`).data.has(id), true,
    'a scope with unreadable metadata had its passport deleted');

  await stores.get('scopes').set(store.scopeKey(scope), '{not json');
  const notJson = await store.sweepScopes(undefined);
  assert.equal(notJson.scopesTornDown, 0, 'a scope whose truth record throws on read was torn down');
  assert.equal(notJson.scopesUnreadable, 1, 'a throwing read was not counted as unreadable');
  assert.equal((await registryKeys()).length, 2, 'a scope with unreadable metadata was pruned from the registry');
});

test('sweepScopes tears down an abandoned scope entirely, including metrics and attempts', async () => {
  resetScopes();
  const preview = { context: 'deploy-preview', id: 'pr-dead' };
  const scope = 'dp-pr-dead-';
  const { id } = await store.createPassport(preview, parsed(), GOOD);
  await store.rateLimit(preview, '1.1.1.1', 'up-h', 5, 3600e3);
  await store.recordMetrics(preview, { v: 1, day: '2026-08-18', refs: [] });
  await store.recordRejection(preview, { v: 1, day: '2026-08-18', code: 'E_SCRUB_GATE' });
  await new Promise(r => setTimeout(r, 0));
  await ageScope(scope, EIGHT_DAYS_AGO());

  const result = await store.sweepScopes(undefined);
  assert.equal(result.scopesTornDown, 1, 'the abandoned scope was not torn down');
  assert.equal(result.scopesPending, 0);
  /* EXACT, not a lower bound: createPassport writes 2 keys (expiry, passports),
     rateLimit 1, recordMetrics 1, recordRejection 1. drainStore used to report
     `pages * DROP_BATCH` (25) per store touched regardless of how many keys
     were actually in it, so this would have passed at 100 as readily as at 5;
     an exact count is what catches that class of overcount. */
  assert.equal(result.scopeKeysRemoved, 5, 'the reported key count does not match what was written');

  for (const name of ['passports', 'ratelimit', 'metrics', 'attempts']) {
    const s = stores.get(`${scope}${name}`);
    assert.equal(s && s.data.size, 0, `${scope}${name} was not fully drained`);
  }
  assert.deepEqual(await registryKeys(), [], 'the torn-down scope was left in the registry');
  assert.equal(id.length > 0, true); // the id itself was only needed to create the row above
});

test('sweepScopes never reaches a live, unrelated scope or the bare stores', async () => {
  resetScopes();
  const dead = { context: 'deploy-preview', id: 'pr-dead-2' };
  const alive = { context: 'deploy-preview', id: 'pr-alive-2' };

  const deadRow = await store.createPassport(dead, parsed(), GOOD);
  const aliveRow = await store.createPassport(alive, parsed(), GOOD);
  await store.createPassport(undefined, parsed(), GOOD); // a bare, production passport
  await new Promise(r => setTimeout(r, 0));
  await ageScope('dp-pr-dead-2-', EIGHT_DAYS_AGO());

  await store.sweepScopes(undefined);

  assert.equal(stores.get('dp-pr-dead-2-passports').data.has(deadRow.id), false,
    'the abandoned scope was not torn down');
  assert.equal(stores.get('dp-pr-alive-2-passports').data.has(aliveRow.id), true,
    'a live, unrelated scope was touched by a run that swept a different one');
  assert.equal((await registryKeys()).length, 2, 'the live scope\'s registry entries were removed too');
  assert.equal(stores.get('passports').data.size, 1,
    'the bare production store was touched by a scope teardown');
});

test('sweepScopes leaves a scope registered when it cannot fully drain it in one run, and finishes later', async () => {
  resetScopes();
  const preview = { context: 'deploy-preview', id: 'pr-big' };
  const scope = 'dp-pr-big-';
  /* One real write to get the store created under the factory this suite
     installed and to register the scope, then enough more keys written
     directly to force drainStore past SWEEP_PAGES (4) at the double's page
     size (3), so a single run cannot confirm the store empty. */
  await store.rateLimit(preview, '9.9.9.9', 'up-h', 1, 3600e3);
  await new Promise(r => setTimeout(r, 0));
  const rl = stores.get(`${scope}ratelimit`);
  for (let i = 0; i < 20; i++) rl.data.set(`3600000:${String(i).padStart(12, '0')}:up-h:x:${i}`, '1');
  await ageScope(scope, EIGHT_DAYS_AGO());

  const first = await store.sweepScopes(undefined);
  assert.equal(first.scopesTornDown, 0, 'a partially-drained scope was counted as torn down');
  assert.equal(first.scopesPending, 1);
  assert.equal((await registryKeys()).length, 2,
    'a scope that could not be fully drained was pruned from the registry anyway');
  assert.ok(rl.data.size < 21, 'the first run made no progress at all');

  let torn = false;
  for (let i = 0; i < 10 && !torn; i++) {
    const r = await store.sweepScopes(undefined);
    if (r.scopesTornDown === 1) torn = true;
  }
  assert.ok(torn, 'repeated runs never finished draining an abandoned scope');
  assert.deepEqual(await registryKeys(), [], 'a finished scope left registry entries behind');
});

test('a store whose deletes fail is not confirmed empty, so the scope stays registered', async () => {
  /* Found while rewriting this section: the earlier drainStore counted a
     failed delete as removed and reported the store empty, which pruned
     the registry entry and left the data behind with nothing pointing at
     it. The double's `failWrites` makes delete throw while list and get
     keep working, which is exactly that shape. */
  resetScopes();
  const preview = { context: 'deploy-preview', id: 'pr-stuck' };
  const scope = 'dp-pr-stuck-';
  const { id } = await store.createPassport(preview, parsed(), GOOD);
  await new Promise(r => setTimeout(r, 0));
  await ageScope(scope, EIGHT_DAYS_AGO());
  stores.get(`${scope}passports`).failWrites = true;

  const result = await store.sweepScopes(undefined);
  assert.equal(result.scopesTornDown, 0, 'a scope with an undeletable key was reported torn down');
  assert.equal(result.scopesPending, 1);
  assert.equal(stores.get(`${scope}passports`).data.has(id), true, 'precondition: the key should still be there');
  assert.equal((await registryKeys()).length, 2, 'the registry forgot a scope that still holds data');

  stores.get(`${scope}passports`).failWrites = false;
  const later = await store.sweepScopes(undefined);
  assert.equal(later.scopesTornDown, 1, 'the scope was not finished once deletes worked again');
  assert.deepEqual(await registryKeys(), []);
});

test('a ghost index entry under a fresh truth record is moved forward, not torn down', async () => {
  /* The crash shape `writeRegistration` is ordered for: the truth was
     rewritten, the new index entry never landed (or a concurrent
     registration left the old one behind). The old index entry ages past
     the threshold while the scope is in daily use. */
  resetScopes();
  const preview = { context: 'deploy-preview', id: 'pr-ghost' };
  const scope = 'dp-pr-ghost-';
  const { id } = await store.createPassport(preview, parsed(), GOOD);
  await new Promise(r => setTimeout(r, 0));
  const registry = stores.get('scopes');
  const truth = await registry.get(store.scopeKey(scope), { type: 'json' });
  const ghostSeen = truth.lastSeen - 9 * DAY_MS;
  await registry.setJSON(store.seenKey(ghostSeen, scope), { ...truth, lastSeen: ghostSeen });
  await registry.delete(store.seenKey(truth.lastSeen, scope)); // the fresh index entry never landed

  const result = await store.sweepScopes(undefined);
  assert.equal(result.scopesTornDown, 0, 'a scope in daily use was torn down on the strength of a ghost');
  assert.equal(result.scopesRefreshed, 1, 'the ghost was not reported as refreshed');
  assert.equal(stores.get(`${scope}passports`).data.has(id), true, 'the ghost cost the scope its passport');
  assert.deepEqual(await registryKeys(), [store.scopeKey(scope), store.seenKey(truth.lastSeen, scope)].sort(),
    'the index was not moved forward to the truth\'s lastSeen');

  /* And once the scope really is abandoned, the moved entry is the one
     that finds it, with both index keys and the truth gone afterwards. */
  await ageScope(scope, EIGHT_DAYS_AGO());
  const later = await store.sweepScopes(undefined);
  assert.equal(later.scopesTornDown, 1);
  assert.deepEqual(await registryKeys(), []);
});

test('a scope torn down before, whose truth record is gone, is drained by its index entry alone', async () => {
  resetScopes();
  const scope = 'dp-pr-leftover-';
  await store.rateLimit({ context: 'deploy-preview', id: 'pr-leftover' }, '3.3.3.3', 'up-h', 5, 3600e3);
  await new Promise(r => setTimeout(r, 0));
  await ageScope(scope, EIGHT_DAYS_AGO());
  await stores.get('scopes').delete(store.scopeKey(scope));

  const result = await store.sweepScopes(undefined);
  assert.equal(result.scopesTornDown, 1, 'an index entry without a truth record was not acted on');
  assert.equal(stores.get(`${scope}ratelimit`).data.size, 0);
  assert.deepEqual(await registryKeys(), []);
});

/* THE PROPERTY EVERY EARLIER VERSION FAILED. A thousand active scopes,
   every one of them named to sort BEFORE the dead scope by string, plus
   the dead scope named `zzz` so that nothing about its name helps it,
   under a budget that cannot list a thousand keys at the double's page
   size of three. The run has to find it anyway, in one pass, and must
   not have read a single active scope's truth record to do so. */
test('an abandoned scope behind a thousand active ones is found in the first run, and the run never looks at the active ones', async () => {
  resetScopes();
  const { id } = await store.createPassport({ context: 'deploy-preview', id: 'zzz' }, parsed(), GOOD);
  await new Promise(r => setTimeout(r, 0));
  await ageScope('dp-zzz-', EIGHT_DAYS_AGO());
  const registry = stores.get('scopes');

  const fresh = Date.now();
  for (let i = 0; i < 1000; i++) {
    const scope = `dp-a-${String(i).padStart(4, '0')}-`;
    const meta = { context: 'deploy-preview', id: `a-${i}`, lastSeen: fresh - i };
    await registry.setJSON(store.scopeKey(scope), meta);
    await registry.setJSON(store.seenKey(meta.lastSeen, scope), meta);
  }
  let reads = 0;
  const realGet = registry.get.bind(registry);
  registry.get = async (...a) => { reads++; return realGet(...a); };
  /* Pages too, not only reads: a walk that skipped fresh keys instead of
     stopping at the first one would still read no truth records and would
     still list every page of the index. That mutation survived the read
     count alone. */
  let pages = 0;
  const realList = registry.list.bind(registry);
  registry.list = (opts) => {
    const it = realList(opts);
    if (!opts || !opts.paginate) return it;
    return (async function* () { for await (const page of it) { pages++; yield page; } })();
  };

  /* 600 ticks of 10ms: enough to drain one small scope (nine stores, two
     keys), nowhere near enough to list a thousand keys at page size 3 if
     the walk had to pass them first. */
  const result = await store.sweepScopes(undefined, { budgetMs: 600, clock: steppingClock(10) });
  assert.equal(result.scopesTornDown, 1, 'the abandoned scope was starved behind a thousand active ones');
  /* Two reads, both of the dead scope's own truth record: once before the
     drain and once before the prune (the race test below is why). Zero for
     the thousand active ones is the claim. */
  assert.equal(reads, 2, 'the run read truth records for active scopes it had no need to examine');
  assert.equal(pages, 1, `the walk listed ${pages} pages of the index instead of stopping at the first fresh key`);
  assert.equal(stores.get('dp-zzz-passports').data.has(id), false, 'the abandoned scope survived');
  assert.equal((await registryKeys()).length, 2000, 'an active scope lost a registry entry');
});

/* And the other half of the property: a backlog of DEAD scopes larger than
   one run can drain still empties completely, because every run starts at
   the oldest and removes what it finishes, so the front of the index is
   always something not yet done. This is what the count cap, the slice
   rotation and the budget split each broke in turn: a bounded run whose
   bound was measured from the top of a set that did not shrink. */
test('a backlog of abandoned scopes larger than one run is fully cleared by repeated runs, with no scope left behind', async () => {
  resetScopes();
  const N = 40;
  await store.rateLimit({ context: 'deploy-preview', id: 'seed' }, '4.4.4.4', 'up-h', 5, 3600e3);
  await new Promise(r => setTimeout(r, 0));
  await ageScope('dp-seed-', EIGHT_DAYS_AGO());
  const registry = stores.get('scopes');
  for (let i = 0; i < N; i++) {
    const scope = `dp-dead-${String(i).padStart(3, '0')}-`;
    const meta = { context: 'deploy-preview', id: `dead-${i}`, lastSeen: EIGHT_DAYS_AGO() - i * 1000 };
    await registry.setJSON(store.scopeKey(scope), meta);
    await registry.setJSON(store.seenKey(meta.lastSeen, scope), meta);
    const s = new FakeStore(`${scope}passports`);
    s.data.set('k1', 'x'); s.data.set('k2', 'x');
    stores.set(`${scope}passports`, s);
  }

  const runs = [];
  for (let i = 0; i < 200 && (await registryKeys()).length > 0; i++) {
    /* Every budget check costs one 10ms tick, and a scope with nine stores
       to list costs at least eighteen checks, so 600 fits a few scopes per
       run and forty-one cannot fit in one. */
    runs.push(await store.sweepScopes(undefined, { budgetMs: 600, clock: steppingClock(10) }));
  }
  const torn = runs.reduce((n, r) => n + r.scopesTornDown, 0);
  assert.ok(runs.length > 1, `precondition: ${N + 1} dead scopes should not fit in one 600ms-tick run`);
  assert.equal(torn, N + 1, `only ${torn} of ${N + 1} abandoned scopes were ever torn down across ${runs.length} runs`);
  assert.deepEqual(await registryKeys(), [], 'the registry was not empty after every scope was torn down');
  assert.ok(runs.some(r => r.scopeBudgetSpent), 'precondition: no run ever hit the budget, so this proved nothing about bounded runs');
  /* The registry being empty is the weaker half. A critic's mutation that
     confirmed a budget-truncated scope empty passed the two assertions
     above: every entry was pruned, and the data was still there. */
  for (let i = 0; i < N; i++) {
    const s = stores.get(`dp-dead-${String(i).padStart(3, '0')}-passports`);
    assert.equal(s.data.size, 0, `dp-dead-${i} was pruned from the registry with ${s.data.size} keys still in it`);
  }
});

/* THE FIFTH CRITIC'S COUNTEREXAMPLE. An oldest-first index has a head, and
   a head can be held: a scope whose deletes keep failing never changes its
   lastSeen, is examined first every run, spends the budget, and every
   abandoned scope behind it is never reached. Same family as the original
   defect, narrower trigger. The fix re-keys a pending scope to the back of
   the abandoned queue after each attempt, so the run after the one it
   spent is one it does not. Calibrated so the stuck scope alone exhausts a
   run: at the double's page size of 3 and SWEEP_PAGES 4, draining its
   ratelimit store costs four failing batches, one budget check each, and
   the budget is seven checks. */
test('a scope that can never be emptied does not starve the abandoned scopes behind it', async () => {
  resetScopes();
  const registry = (await store.rateLimit({ context: 'deploy-preview', id: 'stuck' }, '8.8.8.8', 'up-h', 1, 3600e3), stores.get('scopes'));
  await new Promise(r => setTimeout(r, 0));
  const rl = stores.get('dp-stuck-ratelimit');
  for (let i = 0; i < 30; i++) rl.data.set(`3600000:${String(i).padStart(12, '0')}:up-h:x:${i}`, '1');
  rl.failWrites = true;
  await ageScope('dp-stuck-', EIGHT_DAYS_AGO() - 60e3); // the oldest, so it heads the queue

  const behind = ['dp-b0-', 'dp-b1-', 'dp-b2-'];
  behind.forEach((scope, i) => {
    const meta = { context: 'deploy-preview', id: scope, lastSeen: EIGHT_DAYS_AGO() + i * 1000 };
    registry.data.set(store.scopeKey(scope), JSON.stringify(meta));
    registry.data.set(store.seenKey(meta.lastSeen, scope), JSON.stringify(meta));
    const s = new FakeStore(`${scope}passports`);
    s.data.set('k1', 'x'); s.data.set('k2', 'x');
    stores.set(`${scope}passports`, s);
  });

  const runs = [];
  for (let i = 0; i < 12; i++) runs.push(await store.sweepScopes(undefined, { budgetMs: 70, clock: steppingClock(10) }));
  assert.ok(runs[0].scopeBudgetSpent && runs[0].scopesTornDown === 0,
    'precondition: the stuck scope should exhaust the first run on its own, or this test proves nothing');
  const torn = runs.reduce((n, r) => n + r.scopesTornDown, 0);
  assert.equal(torn, 3, `only ${torn} of 3 abandoned scopes behind a stuck one were torn down in 12 runs`);
  for (const scope of behind) assert.equal(stores.get(`${scope}passports`).data.size, 0, `${scope} was never drained`);
  assert.equal(rl.data.size, 31, 'precondition: the stuck store should still hold every key');
  /* The stuck scope is still registered, still abandoned by its truth
     record, and still at the back of the queue rather than forgotten. */
  const keys = await registryKeys();
  assert.deepEqual(keys.filter(k => k.startsWith('scope:')), [store.scopeKey('dp-stuck-')]);
  assert.equal(keys.filter(k => k.startsWith('seen:')).length, 1);
  assert.ok(store.parseSeenKey(keys.find(k => k.startsWith('seen:'))).lastSeen < Date.now() - store.SCOPE_ABANDON_MS,
    'the re-keyed stuck scope was pushed out of the abandoned range, which would hide it instead of queueing it');
});

test('a failed registration write is retried on the next store call, not suppressed for an hour', async () => {
  resetScopes();
  const preview = { context: 'deploy-preview', id: 'pr-outage' };
  /* First call: the registry is down. The rate limiter's own store works,
     so the request succeeds and the registration is the only casualty. */
  stores.set('scopes', new FakeStore('scopes'));
  stores.get('scopes').failWrites = true;
  await store.rateLimit(preview, '9.1.1.1', 'up-h', 5, 3600e3);
  await new Promise(r => setTimeout(r, 0));
  assert.equal((await registryKeys()).length, 0, 'precondition: the outage should have lost the registration');

  stores.get('scopes').failWrites = false;
  await store.rateLimit(preview, '9.1.1.1', 'up-h', 5, 3600e3);
  await new Promise(r => setTimeout(r, 0));
  assert.equal((await registryKeys()).length, 2, 'the registration was not retried once the store recovered');
});

/* A registry double that fails only index writes, to model a crash between
   the two registration writes without a crash. Which write goes first is
   the whole safety argument for the two-key design, and a critic showed the
   suite could not tell the orders apart. */
class IndexWriteFails extends FakeStore {
  async setJSON(key, value, opts) {
    if (key.startsWith('seen:')) throw new Error('simulated crash after the truth write');
    return super.setJSON(key, value, opts);
  }
}

test('the truth record is written before the index entry, so a lost index write cannot get a live scope torn down', async () => {
  resetScopes();
  const preview = { context: 'deploy-preview', id: 'pr-order' };
  const scope = 'dp-pr-order-';
  const { id } = await store.createPassport(preview, parsed(), GOOD);
  await new Promise(r => setTimeout(r, 0));
  await ageScope(scope, EIGHT_DAYS_AGO()); // idle for eight days, by every record

  /* The preview is used again. The registry accepts the truth write and
     loses the index write. In the shipped order the truth is fresh and the
     old index entry is a ghost; in the reversed order nothing lands and the
     scope is still abandoned by every record. */
  const broken = new IndexWriteFails('scopes');
  broken.data = stores.get('scopes').data;
  stores.set('scopes', broken);
  store.__forgetRegistrations();
  await store.rateLimit(preview, '5.5.5.5', 'up-h', 5, 3600e3);
  await new Promise(r => setTimeout(r, 0));
  const truth = await broken.get(store.scopeKey(scope), { type: 'json' });
  assert.ok(Date.now() - truth.lastSeen < 60e3, 'precondition: the truth write should have landed');
  assert.equal((await registryKeys()).filter(k => k.startsWith('seen:')).length, 1,
    'precondition: only the stale index entry should exist');

  /* The crash is over by the time the sweep runs; the registry is healthy. */
  const healthy = new FakeStore('scopes'); healthy.data = broken.data; stores.set('scopes', healthy);
  const result = await store.sweepScopes(undefined);
  assert.equal(result.scopesTornDown, 0, 'a preview used a moment ago was torn down because one index write was lost');
  assert.equal(result.scopesRefreshed, 1);
  assert.equal(stores.get(`${scope}passports`).data.has(id), true);
});

test('re-registering a scope retires its previous index entry', async () => {
  resetScopes();
  const preview = { context: 'deploy-preview', id: 'pr-again' };
  const scope = 'dp-pr-again-';
  await store.rateLimit(preview, '4.4.4.4', 'up-h', 5, 3600e3);
  await new Promise(r => setTimeout(r, 5));
  store.__forgetRegistrations();           // a cold instance, or an hour later
  await store.rateLimit(preview, '4.4.4.4', 'up-h', 5, 3600e3);
  await new Promise(r => setTimeout(r, 0));
  const keys = await registryKeys();
  const truth = await stores.get('scopes').get(store.scopeKey(scope), { type: 'json' });
  assert.deepEqual(keys, [store.scopeKey(scope), store.seenKey(truth.lastSeen, scope)].sort(),
    `a second registration left ${keys.length} registry keys; every stale index entry is a ghost the sweep has to repair later`);
});

test('a scope with two stale index entries is torn down once and leaves neither behind', async () => {
  resetScopes();
  const scope = 'dp-pr-twice-';
  const registry = (stores.set('scopes', new FakeStore('scopes')), stores.get('scopes'));
  const older = EIGHT_DAYS_AGO() - 3600e3;
  const newer = EIGHT_DAYS_AGO();
  const meta = { context: 'deploy-preview', id: 'pr-twice', lastSeen: newer };
  await registry.setJSON(store.scopeKey(scope), meta);
  await registry.setJSON(store.seenKey(older, scope), { ...meta, lastSeen: older });
  await registry.setJSON(store.seenKey(newer, scope), meta);
  const s = new FakeStore(`${scope}passports`); s.data.set('k', 'x'); stores.set(`${scope}passports`, s);

  const result = await store.sweepScopes(undefined);
  assert.equal(result.scopesTornDown, 1);
  assert.deepEqual(await registryKeys(), [], 'a second index entry for a torn-down scope was left in the registry');
});

/* THE FIFTH CRITIC'S RACE. A request registers the scope while the sweep
   is between reading the truth and pruning it. Modelled by a passports
   store whose first list() call re-registers the scope, the way a request
   arriving mid-drain would. The truth record must survive; what the request
   wrote into stores already drained does not, and the test says so rather
   than asserting otherwise. */
class RegistersOnList extends FakeStore {
  constructor(name, onList) { super(name); this.onList = onList; this.fired = false; }
  list(opts) {
    if (!this.fired) { this.fired = true; this.onList(); }
    return super.list(opts);
  }
}

test('a scope registered while the sweep is draining it keeps its truth record and is not forgotten', async () => {
  resetScopes();
  const preview = { context: 'deploy-preview', id: 'pr-revived' };
  const scope = 'dp-pr-revived-';
  await store.createPassport(preview, parsed(), GOOD);
  await new Promise(r => setTimeout(r, 0));
  await ageScope(scope, EIGHT_DAYS_AGO());

  const racing = new RegistersOnList(`${scope}passports`, () => {
    store.__forgetRegistrations();
    store.rateLimit(preview, '1.2.3.5', 'up-h', 5, 3600e3); // a request lands mid-drain; not awaited, like a real one
  });
  racing.data = stores.get(`${scope}passports`).data;
  stores.set(`${scope}passports`, racing);

  const result = await store.sweepScopes(undefined);
  assert.equal(result.scopesTornDown, 0, 'the sweep forgot a scope that was registered while it was draining it');
  const truth = await stores.get('scopes').get(store.scopeKey(scope), { type: 'json' });
  assert.ok(truth && Date.now() - truth.lastSeen < 60e3, 'the fresh truth record was pruned');
  const seen = (await registryKeys()).filter(k => k.startsWith('seen:'));
  assert.equal(seen.length, 1, `expected one fresh index entry, found ${seen.length}`);
  assert.ok(store.parseSeenKey(seen[0]).lastSeen === truth.lastSeen, 'the surviving index entry is not the fresh one');
  /* The residue, on the record: the passport written before the race was
     drained. Nothing here claims otherwise. */
  assert.equal(stores.get(`${scope}passports`).data.size, 0);
});

/* The critic's second pass found the re-keying left one path unmoved: an
   entry whose truth record cannot be read returned before the pending
   block, so eight of them (one read each, sixteen reads per budget) held
   the head as surely as a stuck drain. Three here, under a budget of four
   checks, ahead of one real abandoned scope. */
test('unreadable-truth entries do not hold the head either', async () => {
  resetScopes();
  const registry = (stores.set('scopes', new FakeStore('scopes')), stores.get('scopes'));
  for (let i = 0; i < 3; i++) {
    const scope = `dp-unreadable-${i}-`;
    const lastSeen = EIGHT_DAYS_AGO() - (10 - i) * 60e3;
    registry.data.set(store.scopeKey(scope), '{not json');
    registry.data.set(store.seenKey(lastSeen, scope), JSON.stringify({ lastSeen }));
  }
  /* Named to sort AFTER the unreadable ones when the timestamps tie, so
     nothing about its name helps it. */
  const real = 'dp-zreal-';
  const meta = { context: 'deploy-preview', id: 'zreal', lastSeen: EIGHT_DAYS_AGO() };
  registry.data.set(store.scopeKey(real), JSON.stringify(meta));
  registry.data.set(store.seenKey(meta.lastSeen, real), JSON.stringify(meta));
  const s = new FakeStore(`${real}passports`); s.data.set('k', 'x'); stores.set(`${real}passports`, s);

  /* Hourly runs, so each run's `cutoff` differs and a scope sent to the
     back in one run sorts before anything sent back in the next. The
     suite's other tests run inside one wall-clock millisecond, which is a
     tie the real schedule never produces. Budget: five checks, one short
     of what one scope needs after three unreadable entries. */
  let torn = 0;
  const base = Date.now();
  for (let i = 0; i < 6 && !torn; i++) {
    const r = await store.sweepScopes(undefined, { now: base + i * 3600e3, budgetMs: 50, clock: steppingClock(10) });
    torn += r.scopesTornDown;
  }
  assert.equal(torn, 1, 'a real abandoned scope was starved behind three unreadable entries');
  assert.equal(s.data.size, 0);
  assert.equal((await registryKeys()).filter(k => k.startsWith('seen:dp-') || k.includes('unreadable')).length, 6,
    'the unreadable entries should still be registered, both keys each');
});

/* And the cost the first re-keying imposed, also the critic's: a large
   scope that is draining fine was sent to the back on every run, behind
   every scope that crossed the threshold meanwhile, sixteen-fold slower
   under one arrival per hour. A scope that removed something this run
   keeps the head. Sixty keys at four pages of three per run is five runs
   of work; one small scope arrives per run; the large one must finish in
   six runs, not alternate with the arrivals. */
test('a large scope that is making progress keeps the head; only a scope that removed nothing is sent to the back', async () => {
  resetScopes();
  const registry = (stores.set('scopes', new FakeStore('scopes')), stores.get('scopes'));
  const big = 'dp-big-';
  const meta = { context: 'deploy-preview', id: 'big', lastSeen: EIGHT_DAYS_AGO() - 3600e3 };
  registry.data.set(store.scopeKey(big), JSON.stringify(meta));
  registry.data.set(store.seenKey(meta.lastSeen, big), JSON.stringify(meta));
  const bigStore = new FakeStore(`${big}passports`);
  for (let i = 0; i < 60; i++) bigStore.data.set(`k${String(i).padStart(3, '0')}`, 'x');
  stores.set(`${big}passports`, bigStore);

  let finishedAt = -1;
  for (let run = 0; run < 12 && finishedAt < 0; run++) {
    /* One newly-abandoned small scope per run, sorting after the big one. */
    const scope = `dp-arrival-${run}-`;
    const m = { context: 'deploy-preview', id: scope, lastSeen: EIGHT_DAYS_AGO() + run };
    registry.data.set(store.scopeKey(scope), JSON.stringify(m));
    registry.data.set(store.seenKey(m.lastSeen, scope), JSON.stringify(m));
    const s = new FakeStore(`${scope}passports`); s.data.set('k', 'x'); stores.set(`${scope}passports`, s);

    /* Budget: enough for one scope's worth of work, not two. */
    await store.sweepScopes(undefined, { budgetMs: 110, clock: steppingClock(10) });
    if (bigStore.data.size === 0) finishedAt = run;
  }
  assert.ok(finishedAt >= 0 && finishedAt <= 6,
    `the large scope finished at run ${finishedAt}; re-keying it while it was making progress put it behind every arrival`);
});

/* DRY RUN. Raffael's condition on the yes: delete nothing, show the list.
   Proven the strong way, by wrapping every write on every store the run
   could touch and counting zero, not by checking that the data is still
   there afterwards. */
test('a dry run writes nothing anywhere and lists each abandoned scope with what it holds', async () => {
  resetScopes();
  const dead = { context: 'deploy-preview', id: 'pr-dry' };
  const scope = 'dp-pr-dry-';
  await store.createPassport(dead, parsed(), GOOD);
  await store.rateLimit(dead, '1.1.1.1', 'up-h', 5, 3600e3);
  await new Promise(r => setTimeout(r, 0));
  await ageScope(scope, EIGHT_DAYS_AGO() - 12 * 3600e3);
  /* A stuck one and an unreadable one too, so the paths that write in a
     live run (send-to-back) are exercised and must not write here. */
  const registry = stores.get('scopes');
  registry.data.set(store.scopeKey('dp-unread-'), '{not json');
  registry.data.set(store.seenKey(EIGHT_DAYS_AGO() - DAY_MS, 'dp-unread-'), '{}');
  const ghostScope = 'dp-ghost-';
  const gmeta = { context: 'deploy-preview', id: 'ghost', lastSeen: Date.now() };
  registry.data.set(store.scopeKey(ghostScope), JSON.stringify(gmeta));
  registry.data.set(store.seenKey(EIGHT_DAYS_AGO() - 2 * DAY_MS, ghostScope), JSON.stringify(gmeta));

  /* Wrapped AT THE FACTORY, not over the stores that exist now: a critic's
     mutant wrote and deleted a scratch key in a store the run opened for
     the first time, net zero, and a wrap over existing stores could not see
     it. Every store the run opens, including ones it creates, is counted. */
  let writes = 0;
  const wrap = (s) => {
    if (s.__wrapped) return s;
    for (const m of ['set', 'setJSON', 'delete']) {
      const real = s[m].bind(s);
      s[m] = async (...a) => { writes++; return real(...a); };
    }
    s.__wrapped = true;
    return s;
  };
  for (const s of stores.values()) wrap(s);
  store.__useStoreFactory(name => {
    if (!stores.has(name)) stores.set(name, new FakeStore(name));
    return wrap(stores.get(name));
  });
  const before = new Map([...stores].map(([n, s]) => [n, [...s.data.keys()].sort().join('|')]));

  let result;
  try {
    result = await store.sweepScopes(undefined, { dryRun: true });
  } finally {
    store.__useStoreFactory(name => {
      if (!stores.has(name)) stores.set(name, new FakeStore(name));
      return stores.get(name);
    });
  }
  assert.equal(writes, 0, `a dry run performed ${writes} write(s)`);
  for (const [n, s] of stores) {
    /* Stores the peek opened for the first time did not exist before; they
       must be empty, which is the same claim. */
    assert.equal([...s.data.keys()].sort().join('|'), before.has(n) ? before.get(n) : '', `${n} changed under a dry run`);
  }
  assert.equal(result.dryRun, true);
  assert.equal(result.scopesTornDown + result.scopesPending + result.scopesRefreshed, 0);
  assert.equal(result.scopesUnreadable, 1);
  assert.equal(result.scopingErrors, 0);
  assert.equal(result.wouldTearDown.length, 1, 'the list should hold the one genuinely abandoned scope, not the ghost or the unreadable one');
  const e = result.wouldTearDown[0];
  assert.equal(e.scope, scope);
  assert.equal(e.context, 'deploy-preview');
  assert.equal(e.id, 'pr-dry');
  assert.equal(e.idleDays, 8);
  assert.deepEqual(e.keys, { passports: 1, expiry: 1, ratelimit: 1 });
  assert.equal(e.total, 3);
  assert.equal(e.atLeast, undefined);
  assert.equal(e.scopingError, undefined);
});

test('a dry run flags a scope that a live run should never have registered', async () => {
  resetScopes();
  const registry = (stores.set('scopes', new FakeStore('scopes')), stores.get('scopes'));
  /* The bare scope itself, the empty string, cannot even be parsed out of
     an index key (`parseSeenKey` needs one character of scope), so a live
     run could never drain production through it. Planted to prove that. */
  const bare = { context: 'production', id: null, lastSeen: EIGHT_DAYS_AGO() - DAY_MS };
  registry.data.set(store.scopeKey(''), JSON.stringify(bare));
  registry.data.set(store.seenKey(bare.lastSeen, ''), JSON.stringify(bare));
  /* And a scope that is not bare but is not a preview either. */
  const bad = { context: 'production', id: 'x', lastSeen: EIGHT_DAYS_AGO() };
  registry.data.set(store.scopeKey('x-prod-'), JSON.stringify(bad));
  registry.data.set(store.seenKey(bad.lastSeen, 'x-prod-'), JSON.stringify(bad));
  stores.set('passports', new FakeStore('passports'));
  stores.get('passports').data.set('a-real-production-passport', 'x');
  stores.set('x-prod-passports', new FakeStore('x-prod-passports'));
  stores.get('x-prod-passports').data.set('p', 'x');

  const result = await store.sweepScopes(undefined, { dryRun: true });
  assert.equal(result.wouldTearDown.length, 1, 'the bare-scope entry should be unparseable and skipped, the other listed');
  assert.equal(result.scopingErrors, 1, 'a production-looking entry was not flagged');
  assert.equal(result.wouldTearDown[0].scopingError, true);
  assert.equal(result.wouldTearDown[0].scope, 'x-prod-');
  assert.equal(result.wouldTearDown[0].context, 'production');
  assert.equal(result.wouldTearDown[0].keys.passports, 1, 'the flagged entry should show what a live run would have destroyed');
  assert.equal(stores.get('passports').data.size, 1, 'the dry run touched production');

  /* The live run, on the same registry: the bare entry is still skipped
     and production is still untouched. The x-prod- scope IS drained,
     because a live run trusts the registry; that is exactly why the dry
     run has to show it first. */
  const live = await store.sweepScopes(undefined);
  assert.equal(stores.get('passports').data.size, 1, 'a live run drained production through a bare index entry');
  assert.equal(live.scopesTornDown, 1);
});

/* Three corrections from the dry-run critic, one test each. */
test('the dry-run idle age is the value the live decision uses, not the newer of two records', async () => {
  resetScopes();
  const registry = (stores.set('scopes', new FakeStore('scopes')), stores.get('scopes'));
  const scope = 'dp-stale-';
  const truth = { context: 'deploy-preview', id: 'stale', lastSeen: Date.now() - 30 * DAY_MS };
  registry.data.set(store.scopeKey(scope), JSON.stringify(truth));
  registry.data.set(store.seenKey(Date.now() - 8 * DAY_MS, scope), '{}'); // an index key newer than the truth
  const result = await store.sweepScopes(undefined, { dryRun: true });
  assert.equal(result.wouldTearDown[0].idleDays, 30, 'the list understated the staleness the decision is made on');
});

test('a truth record without a context field is listed with context null and record no-context, and a missing one with record missing', async () => {
  resetScopes();
  const registry = (stores.set('scopes', new FakeStore('scopes')), stores.get('scopes'));
  const old = Date.now() - 9 * DAY_MS;
  registry.data.set(store.scopeKey('dp-noctx-'), JSON.stringify({ id: 'nc', lastSeen: old }));
  registry.data.set(store.seenKey(old, 'dp-noctx-'), '{}');
  registry.data.set(store.seenKey(old + 1, 'dp-orphan-'), '{}');
  const result = await store.sweepScopes(undefined, { dryRun: true });
  const byScope = Object.fromEntries(result.wouldTearDown.map(e => [e.scope, e]));
  assert.equal(result.scopingErrors, 0, 'a record with no context is not evidence of a scoping error');
  assert.equal(byScope['dp-noctx-'].context, null);
  assert.equal(byScope['dp-noctx-'].record, 'no-context');
  assert.equal(JSON.parse(JSON.stringify(byScope['dp-noctx-'])).context, null, 'the printed line must carry the null, not drop the field');
  assert.equal(byScope['dp-orphan-'].record, 'missing');
});

test('a scope with a store that cannot be listed shows no total, names the store, and says a live run would leave it pending', async () => {
  resetScopes();
  const registry = (stores.set('scopes', new FakeStore('scopes')), stores.get('scopes'));
  const old = Date.now() - 9 * DAY_MS;
  const meta = { context: 'deploy-preview', id: 'u', lastSeen: old };
  registry.data.set(store.scopeKey('dp-unl-'), JSON.stringify(meta));
  registry.data.set(store.seenKey(old, 'dp-unl-'), JSON.stringify(meta));
  const p = new FakeStore('dp-unl-passports'); p.data.set('k', 'x'); stores.set('dp-unl-passports', p);
  const r = new FakeStore('dp-unl-ratelimit'); r.list = () => { throw new Error('outage'); }; stores.set('dp-unl-ratelimit', r);
  const result = await store.sweepScopes(undefined, { dryRun: true });
  const e = result.wouldTearDown[0];
  assert.equal(e.total, undefined, 'a total was printed over stores that could not be listed');
  assert.deepEqual(e.unlisted, ['ratelimit']);
  assert.equal(e.wouldPend, true);
  assert.equal(e.keys.passports, 1);
});

/* The dry run removes nothing, so it must move on its own: resume after
   the last entry listed, count the whole backlog every run, and start
   over once the fresh entries are reached. Thirty abandoned scopes, a
   budget that lists a few per run. */
test('a dry run pages through a backlog larger than one run via its cursor, and reports the whole backlog every time', async () => {
  resetScopes();
  const registry = (stores.set('scopes', new FakeStore('scopes')), stores.get('scopes'));
  const N = 30;
  for (let i = 0; i < N; i++) {
    const scope = `dp-b-${String(i).padStart(2, '0')}-`;
    const meta = { context: 'deploy-preview', id: scope, lastSeen: EIGHT_DAYS_AGO() - i * 1000 };
    registry.data.set(store.scopeKey(scope), JSON.stringify(meta));
    registry.data.set(store.seenKey(meta.lastSeen, scope), JSON.stringify(meta));
  }
  // and one active scope after them, so the walk has a fresh entry to stop at
  const live = { context: 'deploy-preview', id: 'live', lastSeen: Date.now() };
  registry.data.set(store.scopeKey('dp-live-'), JSON.stringify(live));
  registry.data.set(store.seenKey(live.lastSeen, 'dp-live-'), JSON.stringify(live));

  const seen = new Set();
  let cursor = '';
  let runs = 0;
  let wrapped = false;
  while (runs < 40 && !wrapped) {
    const r = await store.sweepScopes(undefined, { dryRun: true, dryRunAfter: cursor, budgetMs: 60, clock: steppingClock(10) });
    runs++;
    assert.equal(r.scopesAbandoned, N, `run ${runs} reported ${r.scopesAbandoned} abandoned, not the whole backlog`);
    for (const e of r.wouldTearDown) seen.add(e.scope);
    if (runs === 1) assert.ok(r.scopeBudgetSpent && r.wouldTearDown.length < N, 'precondition: one run should not list the whole backlog');
    cursor = r.dryRunCursor;
    if (cursor === '') wrapped = true;
  }
  assert.ok(wrapped, 'the cursor never reset after a full pass');
  assert.ok(runs > 1);
  assert.equal(seen.size, N, `only ${seen.size} of ${N} scopes were ever listed across ${runs} runs`);
  assert.equal(seen.has('dp-live-'), false, 'an active scope was listed');
});

/* The change-only emission. What has to move the fingerprint: a scope
   appearing, a scope's key count changing, a scoping flag appearing, a
   scoping error flagged in the unreached tail. What must not: order. */
test('the dry-run fingerprint moves on a count change and a flag, not on order', async () => {
  const base = { wouldTearDown: [
    { scope: 'dp-a-', total: 1 }, { scope: 'dp-b-', total: 3 }
  ], unreachedScopingErrors: [] };
  const f = store.dryRunFingerprint;
  assert.equal(f(base), f({ ...base, wouldTearDown: [...base.wouldTearDown].reverse() }), 'order moved the fingerprint');
  assert.notEqual(f(base), f({ ...base, wouldTearDown: [{ scope: 'dp-a-', total: 6500 }, { scope: 'dp-b-', total: 3 }] }),
    'a scope growing from 1 to 6500 keys did not move the fingerprint');
  assert.notEqual(f(base), f({ ...base, wouldTearDown: [{ scope: 'dp-a-', total: 1, scopingError: true }, { scope: 'dp-b-', total: 3 }] }),
    'a scoping flag did not move the fingerprint');
  assert.notEqual(f(base), f({ ...base, unreachedScopingErrors: ['x-prod-'] }),
    'a scoping error in the unreached tail did not move the fingerprint');
  assert.notEqual(f(base), f({ ...base, wouldTearDown: [{ scope: 'dp-a-', total: 1 }, { scope: 'dp-b-', unlisted: ['ratelimit'] }] }),
    'a store becoming unlistable did not move the fingerprint');
  assert.notEqual(f({ ...base, unreachedScopingErrors: ['x-prod-'], scopingErrors: 20 }),
    f({ ...base, unreachedScopingErrors: ['x-prod-'], scopingErrors: 21 }),
    'a scoping error past the names cap did not move the fingerprint');
});

/* The names list is the one field that fills exactly when something is
   wrong; a critic seeded 5000 non-dp entries and got a 64 KB log line.
   Names are capped, the count is exact. */
test('the unreached scoping-error names are capped and the count is not', async () => {
  resetScopes();
  const registry = (stores.set('scopes', new FakeStore('scopes')), stores.get('scopes'));
  const n = store.UNREACHED_NAMES_CAP + 15;
  for (let i = 0; i < n; i++) {
    const meta = { context: 'production', id: `p${i}`, lastSeen: EIGHT_DAYS_AGO() - 60_000 * (n - i) };
    const scope = `x-prod-${String(i).padStart(3, '0')}-`;
    registry.data.set(store.scopeKey(scope), JSON.stringify(meta));
    registry.data.set(store.seenKey(meta.lastSeen, scope), JSON.stringify(meta));
  }
  const r = await store.sweepScopes(undefined, { dryRun: true, budgetMs: 40, clock: steppingClock(10) });
  /* One entry may be cut mid-examine by the budget: it is pending, not
     listed and not counted this run, and the cursor lists it next run.
     The entry that trips the budget on the walk is counted from its key. */
  assert.equal(r.scopingErrors + r.scopesPending, n, 'the count was capped with the names');
  assert.ok(r.scopingErrors > store.UNREACHED_NAMES_CAP, 'precondition: the count should exceed the cap');
  assert.equal(r.unreachedScopingErrors.length, store.UNREACHED_NAMES_CAP, 'the names were not capped');
  assert.ok(/^x-prod-00[0-3]-$/.test(r.unreachedScopingErrors[0]), `the cap did not keep the oldest names: ${r.unreachedScopingErrors[0]}`);
});

test('dryRunSetChanged reports a change once, then quiet, and the report says when it is partial', async () => {
  resetScopes();
  const scopes = { wouldTearDown: [{ scope: 'dp-a-', total: 1 }], unreachedScopingErrors: [],
    scopeBudgetSpent: true, scopesAbandoned: 300, scopingErrors: 0 };
  const first = await store.dryRunSetChanged(undefined, scopes);
  const second = await store.dryRunSetChanged(undefined, scopes);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(stores.has('sweep-dryrun'), true, 'the fingerprint lives in its own bare store');
  assert.equal(stores.has('dp-sweep-dryrun'), false);
  const report = store.dryRunReport(scopes, first, 'seen:0000000000000001:dp-z-');
  assert.equal(report.partial, true, 'a budget-limited list was not marked partial');
  assert.equal(report.backlog, 300);
  assert.equal(report.resumedAfter, 'seen:0000000000000001:dp-z-');
  assert.equal(report.count, 1);
  /* And a preview deploy must not be able to reach the bare fingerprint. */
  await store.dryRunSetChanged({ context: 'deploy-preview', id: 'x' }, scopes);
  assert.equal(stores.has('dp-x-sweep-dryrun'), true, 'the store is not threaded through the scope rule');
});

test('a non-dp scope in the part of the backlog the budget does not reach is still flagged from its key', async () => {
  resetScopes();
  const registry = (stores.set('scopes', new FakeStore('scopes')), stores.get('scopes'));
  for (let i = 0; i < 12; i++) {
    const scope = `dp-c-${String(i).padStart(2, '0')}-`;
    const meta = { context: 'deploy-preview', id: scope, lastSeen: EIGHT_DAYS_AGO() - (100 - i) * 1000 };
    registry.data.set(store.scopeKey(scope), JSON.stringify(meta));
    registry.data.set(store.seenKey(meta.lastSeen, scope), JSON.stringify(meta));
  }
  const bad = { context: 'production', id: 'p', lastSeen: EIGHT_DAYS_AGO() - 1000 }; // sorts after the twelve
  registry.data.set(store.scopeKey('x-prod-'), JSON.stringify(bad));
  registry.data.set(store.seenKey(bad.lastSeen, 'x-prod-'), JSON.stringify(bad));
  const r = await store.sweepScopes(undefined, { dryRun: true, budgetMs: 40, clock: steppingClock(10) });
  assert.ok(r.scopeBudgetSpent && r.wouldTearDown.length < 12, 'precondition: the run should not reach the tail');
  assert.equal(r.scopesAbandoned, 13);
  assert.deepEqual(r.unreachedScopingErrors, ['x-prod-'], 'the tail scoping error was not flagged');
  assert.equal(r.scopingErrors, 1);
});

test('a spent budget before the first entry touches nothing and says so', async () => {
  resetScopes();
  await store.rateLimit({ context: 'deploy-preview', id: 'pr-nobudget' }, '6.6.6.6', 'up-h', 5, 3600e3);
  await new Promise(r => setTimeout(r, 0));
  await ageScope('dp-pr-nobudget-', EIGHT_DAYS_AGO());
  const result = await store.sweepScopes(undefined, { budgetMs: 0 });
  assert.equal(result.scopeBudgetSpent, true);
  assert.equal(result.scopesTornDown + result.scopesPending, 0);
  assert.equal((await registryKeys()).length, 2);
});

test('a registry that cannot be listed is reported, not treated as empty', async () => {
  resetScopes();
  await store.rateLimit({ context: 'deploy-preview', id: 'pr-nolist' }, '7.7.7.7', 'up-h', 5, 3600e3);
  await new Promise(r => setTimeout(r, 0));
  stores.get('scopes').list = () => { throw new Error('simulated outage'); };
  const result = await store.sweepScopes(undefined);
  assert.equal(result.scopeListFailed, true);
  assert.equal(result.scopesTornDown, 0);
});

/* /create's two capture-path prompt counters. No passport id, so none of
   the existence-check machinery above applies; what has to hold here is
   that the two prefixes are independent, that PROMPT_COPY_PATHS is the one
   place "f" and "w" are named, and — the property a round-1 critic showed
   the original {n} get-then-increment shape did not have — that CONCURRENT
   presses of the same path are not lost. */
test('create: bumpPromptCopy moves f and w independently', async () => {
  reset();
  await store.bumpPromptCopy(undefined, 'f');
  await store.bumpPromptCopy(undefined, 'f');
  await store.bumpPromptCopy(undefined, 'w');
  assert.deepEqual(await store.readPromptCopies(undefined), { f: 2, w: 1 });
  const pc = stores.get('prompt-clicks');
  assert.equal([...pc.data.keys()].filter(k => k.startsWith('f:')).length, 2);
  assert.equal([...pc.data.keys()].filter(k => k.startsWith('w:')).length, 1);
});

test('create: readPromptCopies on an empty store reads zero for both, and PROMPT_COPY_PATHS names exactly f and w', async () => {
  reset();
  assert.deepEqual(await store.readPromptCopies(undefined), { f: 0, w: 0 });
  assert.deepEqual([...store.PROMPT_COPY_PATHS].sort(), ['f', 'w']);
});

test('create: concurrent presses of the same path are not lost (round-1 critic counterexample, fixed)', async () => {
  reset();
  for (const n of [2, 5, 20, 50]) {
    reset();
    await Promise.all(Array.from({ length: n }, () => store.bumpPromptCopy(undefined, 'f')));
    assert.equal((await store.readPromptCopies(undefined)).f, n,
      `${n} concurrent f presses should all count; a get-then-increment counter lost all but one of them`);
  }
});

test('create: a failure listing just one prefix fails the whole read closed, not a wrong comparison', async () => {
  reset();
  await store.bumpPromptCopy(undefined, 'f');
  await store.bumpPromptCopy(undefined, 'f');
  for (let i = 0; i < 3; i++) await store.bumpPromptCopy(undefined, 'w');
  assert.deepEqual(await store.readPromptCopies(undefined), { f: 2, w: 3 }, 'sanity: the healthy read is right');

  /* A round-2 critic built this counterexample against an earlier version:
     only the "w:" listing fails, and readPromptCopies returned {f:2,w:0} —
     a real count beside a fabricated zero, which reads as "f is winning"
     when the truth (3 w's, 2 f's) says the opposite. The fix wraps both
     prefix reads in one try, so either failing must fail both. */
  const failing = new FakeStore('prompt-clicks');
  failing.data = stores.get('prompt-clicks').data;
  failing.list = ({ prefix } = {}) => {
    if (prefix === 'w:') return (async function* () { throw new Error('simulated list failure'); })();
    return FakeStore.prototype.list.call(failing, { prefix, paginate: true });
  };
  stores.set('prompt-clicks', failing);
  assert.deepEqual(await store.readPromptCopies(undefined), { f: 0, w: 0 },
    'a failure reading one path must not leave the other path\'s real count standing alone');
});

test('create: readPromptCopies does not throw when the store cannot even be opened', async () => {
  reset();
  const originalFactory = name => { throw new Error('simulated getStore() throw'); };
  store.__useStoreFactory(originalFactory);
  try {
    await assert.doesNotReject(store.readPromptCopies(undefined));
    assert.deepEqual(await store.readPromptCopies(undefined), { f: 0, w: 0 });
  } finally {
    store.__useStoreFactory(name => {
      if (!stores.has(name)) stores.set(name, new FakeStore(name));
      return stores.get(name);
    });
  }
});

test('deploy scoping isolates prompt-clicks the same way it isolates copies', async () => {
  reset();
  const preview = { context: 'deploy-preview', id: 'pr-cc1' };
  await store.bumpPromptCopy(preview, 'f');
  assert.equal(stores.has('prompt-clicks'), false,
    'a preview press must not touch the bare production store at all');
  assert.equal(stores.has('dp-pr-cc1-prompt-clicks'), true,
    'and must land in its own, scoped store');
  assert.deepEqual(await store.readPromptCopies(undefined), { f: 0, w: 0 },
    'production must not see a count a preview wrote');
  assert.deepEqual(await store.readPromptCopies(preview), { f: 1, w: 0 },
    'but the same deploy that wrote it reads it back');
});

test('gallery: sweep reclaims an orphan copies row the way it reclaims a views orphan', async () => {
  reset();
  const now = 1000 * DAY_MS;
  const orphan = idInSlice(sliceAt(now));
  const copies = new FakeStore('copies');
  stores.set('copies', copies);
  copies.data.set(orphan, JSON.stringify({ n: 3 }));
  const removed = await store.sweep(undefined, { now });
  assert.equal(removed.copies, 1);
  assert.equal(copies.data.has(orphan), false, 'the orphan copies row survived a sweep of its own slice');
});

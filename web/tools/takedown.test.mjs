/* the operator takedown: unlist or delete by id without the token (lib/_store-takedown.mjs),
   and the command that runs it (tools/_takedown-cli.mjs, behind tools/takedown.mjs).

   Shared setup (the in-memory blob double, reset(), GOOD, ...) is in ./_helpers.mjs, which also
   installs that double before any lib is exercised. Run just this file with:
   node --test tools/takedown.test.mjs */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { CATEGORIES } from '../lib/_categories.mjs';
import {
  CAT,
  FakeStore,
  GOOD,
  NOBODY,
  VOTER_A,
  VOTER_B,
  assertUnlistedShape,
  expireNow,
  parsed,
  reset,
  rowOf,
  store,
  stores
} from './_helpers.mjs';
import { main } from './_takedown-cli.mjs';

const OTHER = CATEGORIES.map(c => c.slug).find(s => s !== CAT);

/* Every write the double takes, counted on the prototype so a store first
   opened during the call is counted too. */
async function writesDuring(fn) {
  const proto = FakeStore.prototype;
  const orig = { set: proto.set, setJSON: proto.setJSON, delete: proto.delete };
  let n = 0;
  for (const m of Object.keys(orig)) proto[m] = async function (...a) { n++; return orig[m].apply(this, a); };
  try { await fn(); } finally { Object.assign(proto, orig); }
  return n;
}

/* Every store that holds this id in a key or a value, read off the double
   itself rather than off the code under test. */
const mentions = id => [...stores.values()]
  .filter(s => [...s.data.entries()].some(([k, v]) => k.includes(id) || String(v).includes(id)))
  .map(s => s.name).sort();

/* Opening a store creates an empty double, which is not a write; compare what
   the stores hold. */
const snapshot = () => JSON.stringify([...stores.entries()].filter(([, s]) => s.data.size)
  .sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, s]) => [n, [...s.data.entries()], [...s.meta.entries()]]));

/* A listed passport with one of everything a passport can have: it came out
   of review (so a hold pointer names it), it has two votes, a category edit,
   a view, a copy and its duplicate-guard fingerprint. */
async function fullyLoaded() {
  reset();
  const { hold_id } = await store.createHold(undefined, {
    record: parsed(), text: GOOD, gallery: { category: CAT }, jev: { outcome: 'installable', score: 0.95 }
  });
  const released = await store.releaseHold(undefined, hold_id);
  assert.equal(released.ok, true, 'the hold must release');
  const { id, token } = released;
  await store.castVote(undefined, id, VOTER_A, 'up');
  await store.castVote(undefined, id, VOTER_B, 'down');
  assert.ok(await store.listPassport(undefined, id, token, OTHER), 'the category edit must land');
  await store.bumpViews(undefined, id);
  await store.bumpCopies(undefined, id);
  const row = rowOf(id);
  await store.claimFingerprint(undefined, row.fingerprint, row.fingerprint_bucket);
  return { id, token, hold_id };
}

const EVERYTHING = {
  passports: 1, gallery: 1, 'gallery-categories': 1, votes: 2, 'votes-count': 1,
  views: 1, copies: 1, fingerprints: 1, 'hold-pointers': 1
};

test('takedown: a dry run reads, reports what the passport has, and writes nothing', async () => {
  const { id } = await fullyLoaded();
  const before = snapshot();
  let del, un;
  assert.equal(await writesDuring(async () => { del = await store.operatorDelete(undefined, id); }), 0,
    'a delete without apply must not write');
  assert.equal(await writesDuring(async () => { un = await store.operatorUnlist(undefined, id); }), 0,
    'an unlist without apply must not write');
  assert.equal(snapshot(), before, 'a dry run must leave every store byte-identical');
  for (const r of [del, un]) {
    assert.equal(r.ok, true);
    assert.equal(r.applied, false);
    assert.deepEqual(r.before, { present: EVERYTHING, unknown: [] });
    assert.equal(r.row.listed, true);
    assert.equal(r.row.held, true);
    assert.equal(r.row.title, rowOf(id).title);
    assert.ok(!('body' in r.row) && !JSON.stringify(r.row).includes(rowOf(id).delete_token_hash),
      'the summary must carry neither the body nor the token hash');
  }
});

test('takedown: the footprint names every store the double says holds the passport', async () => {
  const { id } = await fullyLoaded();
  const { before } = await store.operatorDelete(undefined, id);
  const reported = Object.keys(before.present);
  for (const name of mentions(id)) assert.ok(reported.includes(name), `the footprint missed ${name}`);
});

test('takedown: delete leaves nothing under the id in any store, gallery and indexes included', async () => {
  const { id } = await fullyLoaded();
  const r = await store.operatorDelete(undefined, id, { apply: true });
  assert.equal(r.ok, true);
  assert.equal(r.applied, true);
  assert.deepEqual(r.after, { present: {}, unknown: [] }, 'what the tool prints as left must be nothing');
  assert.deepEqual(mentions(id), [], 'no store may hold a key or a value naming a deleted passport');
  assert.equal(await store.readPassport(undefined, id), null);
  const { cards } = await store.listGallery(undefined);
  assert.equal(cards.length, 0, 'the gallery must not list a deleted passport');
});

test('takedown: delete removes an expired passport the sweep has not reached yet', async () => {
  reset();
  const { id } = await store.createPassport(undefined, parsed(), GOOD);
  expireNow(id);
  const r = await store.operatorDelete(undefined, id, { apply: true });
  assert.equal(r.row.expired, true);
  assert.equal(r.ok, true);
  assert.deepEqual(mentions(id), [], 'the row and its expiry index key must both go');
});

test('takedown: unlist is the owner\'s unlist, with no listing left behind', async () => {
  const { id } = await fullyLoaded();
  const r = await store.operatorUnlist(undefined, id, { apply: true });
  assert.equal(r.ok, true);
  assert.equal(r.applied, true);
  assertUnlistedShape(id);
  assert.equal(r.expires_at, rowOf(id).expires_at);
  for (const name of ['gallery', 'votes', 'votes-count', 'gallery-categories']) {
    assert.ok(!(name in r.after.present), `an unlist must leave nothing in ${name}`);
    assert.ok(!mentions(id).includes(name), `the double still holds ${name} for an unlisted passport`);
  }
  assert.equal(r.after.present.expiry, 1, 'the row is back on the clock, so the sweep can reach it');
  assert.equal(r.after.present.views, 1, 'counters belong to the passport, not the listing');
});

test('takedown: unlist leaves an unlisted passport exactly as it was, even with apply', async () => {
  reset();
  const { id } = await store.createPassport(undefined, parsed(), GOOD);
  const before = snapshot();
  let r;
  assert.equal(await writesDuring(async () => { r = await store.operatorUnlist(undefined, id, { apply: true }); }), 0);
  assert.equal(r.unchanged, true);
  assert.equal(snapshot(), before);
});

test('takedown: no endpoint imports the operator functions', async () => {
  /* A request that reached operatorDelete would be a delete without a token,
     and one that reached restoreStores a write of a whole copy. */
  const dirs = ['../netlify/functions/', '../netlify/edge-functions/'].map(d => new URL(d, import.meta.url));
  const operatorOnly = /\b(operatorDelete|operatorUnlist|exportStores|restoreStores)\b/;
  for (const dir of dirs) {
    for (const f of await readdir(dir)) {
      const src = await readFile(new URL(f, dir), 'utf8');
      assert.ok(!operatorOnly.test(src), `${f} names an operator-only store function`);
    }
  }
});

test('takedown: a bad id, a missing passport and a failed read change nothing and say which', async () => {
  reset();
  assert.equal((await store.operatorDelete(undefined, 'not-a-uuid', { apply: true })).reason, 'not_a_uuid');
  assert.equal((await store.operatorDelete(undefined, NOBODY, { apply: true })).reason, 'not_found');

  const { id } = await store.createPassport(undefined, parsed(), GOOD);
  const passports = stores.get('passports');
  const get = passports.get;
  passports.get = async () => { throw new Error('simulated blob outage'); };
  let r;
  try {
    assert.equal(await writesDuring(async () => { r = await store.operatorDelete(undefined, id, { apply: true }); }), 0,
      'a row that could not be read must not be purged as if it were absent');
  } finally { passports.get = get; }
  assert.equal(r.reason, 'read_failed');
  assert.ok(rowOf(id), 'the passport must still be there');
});

test('takedown: a store the footprint cannot read is reported unknown, never as empty', async () => {
  /* After the delete is when it matters: "left: none" is what an erasure
     reply is written from. */
  const { id } = await fullyLoaded();
  const gallery = stores.get('gallery');
  const votes = stores.get('votes');
  let r;
  try {
    gallery.getMetadata = async () => { throw new Error('simulated blob outage'); };
    votes.list = async () => { throw new Error('simulated blob outage'); };
    r = await store.operatorDelete(undefined, id, { apply: true });
  } finally {
    delete gallery.getMetadata;
    delete votes.list;
  }
  assert.equal(r.applied, true);
  assert.deepEqual([...r.after.unknown].sort(), ['gallery', 'votes']);
  assert.deepEqual([...r.before.unknown].sort(), ['gallery', 'votes']);
  assert.ok(!('gallery' in r.before.present) && !('votes' in r.before.present));
});

/* ── the command, tools/_takedown-cli.mjs ───────────────────
   Driven as takedown.mjs drives it, with a connect that leaves the double in
   place and counts that it ran, and a console that records. */
const ENV = { NETLIFY_SITE_ID: 'site-a', NETLIFY_AUTH_TOKEN: 'test-only' };
async function cli(argv, env = ENV) {
  const out = [];
  const err = [];
  let connected = 0;
  let code;
  const writes = await writesDuring(async () => {
    code = await main(argv, env, () => { connected++; }, { log: l => out.push(l), error: l => err.push(l) });
  });
  return { code, writes, connected, out: out.join('\n'), err: err.join('\n') };
}

test('takedown.mjs: a dry run without --apply, the owner\'s unlist and delete with it', async () => {
  const { id } = await fullyLoaded();
  const before = snapshot();
  for (const cmd of ['unlist', 'delete']) {
    const dry = await cli([cmd, id]);
    assert.equal(dry.code, 0, dry.err);
    assert.equal(dry.writes, 0, `${cmd} without --apply must not write`);
    assert.match(dry.out, /DRY RUN/);
    assert.ok(dry.out.includes(`title    ${rowOf(id).title}`), 'the operator sees which passport it is');
    assert.ok(!dry.out.includes(rowOf(id).delete_token_hash), 'the token hash is never printed');
  }
  assert.equal(snapshot(), before);

  const un = await cli(['unlist', id, '--apply']);
  assert.equal(un.code, 0, un.err);
  assert.match(un.out, /Unlisted\. The link now expires/);
  assertUnlistedShape(id);

  const del = await cli(['delete', id, '--apply']);
  assert.equal(del.code, 0, del.err);
  assert.match(del.out, /Deleted\.\n {2}left {5}none/);
  assert.deepEqual(mentions(id), []);

  const again = await cli(['delete', id, '--apply']);
  assert.equal(again.code, 1);
  assert.match(again.err, /No passport at that id/);
  assert.equal(again.writes, 0);
});

test('takedown.mjs: without credentials, a command or an id, nothing is opened', async () => {
  for (const [argv, env] of [[['delete', NOBODY], {}], [['delete', NOBODY], { NETLIFY_SITE_ID: 'site-a' }],
    [['erase', NOBODY], ENV], [['delete'], ENV]]) {
    const r = await cli(argv, env);
    assert.equal(r.code, 2, argv.join(' '));
    assert.equal(r.connected, 0);
  }
  const bad = await cli(['delete', 'not-a-uuid', '--apply']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /not a passport id/);
});

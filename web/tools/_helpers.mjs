/* Shared setup for the web layer's test suite (tools/*.test.mjs). The suite runs with
   `node --test "tools/*.test.mjs"` and from build.sh, with no network and no Netlify runtime.
   It used to be one file, tools/run-tests.mjs. This holds the in-memory blob double, the
   network guard, and whatever else more than one of the files below needs; setup that only
   one file needs sits in that file. A file that needs something from here imports it. Nothing
   in here registers a test; the network guard registers one afterEach hook.

   What it covers is chosen by what would be expensive to get wrong: the rules
   that decide whether a stranger's file is stored, the promise that an expired
   or deleted passport is indistinguishable from one that never existed, the
   constant-time token comparison, the limiter's behaviour under a simultaneous
   burst, and every string that leaves the building in an email.

   The storage module talks to Netlify Blobs, which is not available here, so
   the store is exercised against an in-memory double that implements the four
   methods _store.mjs uses. That double is the weak point of this file and it is
   worth naming: it proves the logic in _store.mjs, not that Netlify Blobs
   behaves as the logic assumes. The assumption being relied on is that a write
   to a distinct key never loses another key's write, which is true of any
   key-value store worth the name. */

import { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/* ── no network ─────────────────────────────────────────────
   NOTHING IN THIS SUITE MAY REACH A REAL SERVICE, and until 2026-10-22 nothing
   made sure of it. With TYPESAFE_API_KEY and RESEND_API_KEY set, as they are in
   Netlify's build, every deploy's run sent four requests to api.typesafe.ai
   (upload.test.mjs's ROW-128 test, through upload.mjs into the Jev check) and
   one mail to api.resend.com (store.test.mjs's releaseHold test). CI has no
   keys, so it never took those paths: the gate and the deploy ran different code.

   Two halves. The variables that switch a third-party path on are taken out of
   the environment, and so are the Jev thresholds and dispositions and the mail
   headers, which lib/ reads at call time and an operator can set on the site
   (with JEV_SECRET_HOLD=0.7 on the site, secretFlagged would fail the deploy
   and pass CI).
   A test that wants one of them sets it itself, and stubs fetch if it reaches
   the network, as captureMail and quietMail in store.test.mjs and the
   password-check tests in jev.test.mjs already do. And fetch is replaced, so a
   request nothing stubbed is refused before it leaves AND fails a test.
   Refusing is not enough alone: the code under test fails open on a network
   error, which is how those five requests went unnoticed. The afterEach below
   fails the test that made the request, or the first one after it if the
   request came from work a test left running; one made after the last test
   fails the file through its exit code. network-guard.test.mjs proves the
   scrub and both failures, since with the keys gone no other test can. */
for (const name of ['TYPESAFE_API_KEY', 'RESEND_API_KEY', 'MAIL_API_BASE', 'HOLD_ALERT_TO', 'DIGEST_TO', 'SUBSCRIBE_SEGMENT_ID',
  'JEV_CUTOFF', 'JEV_DISPOSITION', 'JEV_SECRET_HOLD', 'JEV_SECRET_DISPOSITION', 'MAIL_FROM', 'MAIL_REPLY_TO',
  'ARCHIVE_MODE']) {
  delete process.env[name];
}
const unstubbed = [];
globalThis.fetch = async (url, init) => {
  const req = url instanceof Request ? url : null;
  const what = `${(init && init.method) || (req ? req.method : 'GET')} ${req ? req.url : String(url)}`;
  unstubbed.push(what);
  throw new TypeError('unstubbed request refused by tools/_helpers.mjs: ' + what);
};
afterEach(() => {
  if (unstubbed.length) {
    assert.fail('made a request no test stubbed (this test, or work an earlier one left running): ' +
      unstubbed.splice(0).join('; '));
  }
});
process.on('exit', () => {
  if (!unstubbed.length) return;
  console.error('unstubbed request(s) after the last test, refused by tools/_helpers.mjs: ' + unstubbed.join('; '));
  process.exitCode = 1;
});

/* ── the blob double ────────────────────────────────────────
   Installed before _store.mjs is imported, because _store.mjs calls getStore at
   call time rather than at import time, so a module-level mock is enough. */
export const stores = new Map();

export class FakeStore {
  constructor(name) { this.name = name; this.data = new Map(); this.meta = new Map(); }
  async get(key, opts) {
    if (!this.data.has(key)) return null;
    const raw = this.data.get(key);
    return opts && opts.type === 'json' ? JSON.parse(raw) : raw;
  }
  /* `failWrites` models a blob store that is up enough to answer reads and
     fails on write, which is the shape of the outage ROW-128 is about. Reads
     keep working on purpose: an outage that failed reads too would refuse the
     duplicate check as well, and the bug being pinned lives in what happens
     when the check succeeds and the write does not. */
  failWrites = false;
  async set(key, value, opts) {
    if (this.failWrites) throw new Error('simulated blob outage');
    this.data.set(key, String(value));
    if (opts && opts.metadata) this.meta.set(key, opts.metadata);
  }
  async setJSON(key, value, opts) {
    if (this.failWrites) throw new Error('simulated blob outage');
    this.data.set(key, JSON.stringify(value));
    if (opts && opts.metadata) this.meta.set(key, opts.metadata);
  }
  /* A DELETE IS A WRITE, and this double did not model that until the ack was
     split. Both one-shot claims on the publish path — the fingerprint and the
     ack ticket — are now made after createPassport and must swallow their own
     failure, and a `delete` that always succeeded could not test the second. */
  async delete(key) {
    if (this.failWrites) throw new Error('simulated blob outage');
    this.data.delete(key); this.meta.delete(key);
  }
  /* `hide` is what makes this double worth having. Netlify Blobs gives strong
     consistency on get; LISTING is eventually consistent whatever the store is
     configured with, and the limiter's correctness argument rests on listing.
     A double whose list is a Map is perfectly consistent, so the real failure
     was unreachable in this suite and the limiter's comment claimed a guarantee
     it did not have. Setting `hide` makes list pretend the last N writes have
     not landed yet. */
  hide = 0;
  /* `page` models the other thing about the real store: list() is paginated,
     and the sweeper reads ONE page rather than collecting every page of every
     store inside an upload request. A double that hands back everything in one
     go would let an unbounded sweep pass. */
  page = 3;
  list({ prefix, paginate } = {}) {
    /* Sorted, because that is what a real blob store does and the sweeper's
       reachability depends on it. An insertion-ordered double would let a
       key layout that starves the sweeper pass. */
    let keys = [...this.data.keys()].sort();
    if (this.hide > 0) keys = keys.slice(0, Math.max(0, keys.length - this.hide));
    keys = keys.filter(k => !prefix || k.startsWith(prefix));
    const blobs = keys.map(key => ({ key }));

    if (!paginate) return Promise.resolve({ blobs, directories: [] });

    const size = this.page;
    return (async function* () {
      for (let i = 0; i < blobs.length; i += size) {
        yield { blobs: blobs.slice(i, i + size), directories: [] };
      }
    })();
  }
  async getMetadata(key) {
    if (!this.data.has(key)) return null;
    return { etag: 'x', metadata: this.meta.get(key) || {} };
  }
  /* The real store's one-round-trip body and metadata, text by default, which
     is what the backup export and the restore read (_store-backup.mjs). */
  async getWithMetadata(key) {
    if (!this.data.has(key)) return null;
    return { data: this.data.get(key), etag: 'x', metadata: this.meta.get(key) || {} };
  }
}

export const store = await import('../lib/_store.mjs');
store.__useStoreFactory(name => {
  if (!stores.has(name)) stores.set(name, new FakeStore(name));
  return stores.get(name);
});

export const { transport, validate, err, MESSAGES, RULES_VERSION, SECRETS } = await import('../lib/_validate.mjs');
export const { derive } = await import('../lib/_derive.mjs');
export const render = await import('../lib/_render.mjs');

export const reset = () => stores.clear();

export const GOOD = await readFile(new URL('../../examples/daily-brief-passport.md', import.meta.url), 'utf8');

/* Age a passport out. Production writes expires_at into the row and into the
   blob's metadata in one call, so a test that touches only one of them is
   testing a state that cannot happen. `agoMs` is how long ago it expired; the
   sweep's backlog-age test needs entries that expired at different times. */
export const expireNow = (id, agoMs = 1000) => {
  const passports = stores.get('passports');
  const row = JSON.parse(passports.data.get(id));
  const wasMs = Date.parse(row.expires_at);

  row.expires_at = new Date(Date.now() - agoMs).toISOString();
  const ms = Date.parse(row.expires_at);
  passports.data.set(id, JSON.stringify(row));
  passports.meta.set(id, { h: row.delete_token_hash, x: ms });

  /* The expiry index is the third place the date lives, and the sweeper reads
     only that one. Production writes all three in createPassport and rewrites
     all three in renewPassport, so a helper that moved two of them would be
     testing a state that cannot occur. */
  const key = ms => `${String(ms).padStart(16, '0')}:${id}`;
  const expiry = stores.get('expiry');
  if (expiry) {
    expiry.data.delete(key(wasMs));
    expiry.data.set(key(ms), '1');
  }
};

/* ── the ops log (lib/_ops.mjs) ─────────────────────────────
   Runs `fn` with console.error captured. `ops` is each `ops:` line parsed;
   `raw` is everything console.error saw, joined, so a test can assert that no
   identifier reached the log by any route, not only through the ops line. */
export async function captureOps(fn) {
  const lines = [];
  const saved = console.error;
  console.error = (...a) => { lines.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
  let value;
  try { value = await fn(); } finally { console.error = saved; }
  const ops = lines.filter(l => l.startsWith('ops: ')).map(l => JSON.parse(l.slice('ops: '.length)));
  return { value, ops, raw: lines.join('\n') };
}

export const parsed = () => {
  const v = validate(GOOD);
  assert.equal(v.errors.length, 0, 'the repository example must validate');
  const d = derive(v.front, v.lines);
  assert.equal(d.error, undefined, 'the repository example must derive');
  return d.record;
};

/* ── the views reclaim, ROW-140 ─────────────────────────────
   `views` keys are bare passport UUIDs, not time-bucketed like the stores
   above, so sweep() reaches them by rotating scan()'s `prefix` across a fixed
   256-slice cycle, one slice per calendar day (derived from `now`). Matches
   `_store.mjs`'s own DAY_MS; not exported, so pinned here as a literal rather
   than imported, same as every other millisecond constant this suite already
   hardcodes (see ACK_TTL_MS-shaped buckets above). A UUID-shaped id whose
   first two hex characters are chosen to land in a given day's slice. */
export const DAY_MS = 86400e3;

/* ══ the gallery ══════════════════════════════════════════
   GALLERY-SPEC.md §2: the entry IS the passport row, flagged, and these are the
   six invariants written as tests before the code. Each transition test asserts
   the whole invariant-1 shape through the two helpers below rather than the
   one field it is about, so a transition that gets its own field right and a
   neighbour's wrong still fails. */
export const CAT = 'research-and-monitoring';
export const NOBODY = '00000000-0000-4000-8000-000000000000';
export const VOTER_A = 'a'.repeat(32);
export const VOTER_B = 'b'.repeat(32);
export const listedPublish = (category = CAT) =>
  store.createPassport(undefined, parsed(), GOOD, { gallery: { category } });
export const expiryKeysFor = id => [...(stores.get('expiry')?.data.keys() || [])].filter(k => k.endsWith(':' + id));
export const rowOf = id => JSON.parse(stores.get('passports').data.get(id));
export const metaOf = id => stores.get('passports').meta.get(id);
export const cardOf = id => {
  const g = stores.get('gallery');
  const raw = g && g.data.get(id);
  return raw ? JSON.parse(raw) : null;
};
export const tallyKeyFor = id => rowOf(id).gallery?.generation ? `${id}:${rowOf(id).gallery.generation}` : id;
export const tallyKeysFor = id => [...(stores.get('votes-count')?.data.keys() || [])].filter(k => k === id || k.startsWith(id + ':'));
export const voteKeysFor = id => [...(stores.get('votes')?.data.keys() || [])].filter(k => k.startsWith(id + ':'));

export function assertUnlistedShape(id) {
  const row = rowOf(id);
  assert.ok(!row.gallery, 'an unlisted row must have gallery null or undefined');
  assert.ok(Number.isFinite(Date.parse(row.expires_at)), 'an unlisted row must carry an expiry');
  assert.deepEqual(metaOf(id), { h: row.delete_token_hash, x: Date.parse(row.expires_at) },
    'unlisted metadata must be exactly { h, x }, with no g');
  assert.equal(expiryKeysFor(id).length, 1, 'an unlisted row must have exactly one expiry index entry');
  assert.equal(cardOf(id), null, 'an unlisted row must have no gallery card');
}
export const finder = await import('../lib/_secretfinder.mjs');

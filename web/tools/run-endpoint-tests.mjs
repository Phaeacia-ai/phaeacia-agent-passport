/* The endpoints, driven as endpoints.

   tools/run-tests.mjs covers lib/. It imports no handler and executes none, and
   an adversarial review pointed out what that costs: every one of the ten
   findings it raised lived in a handler or in the seam between a handler and a
   library. Worse, one test in that file was NAMED for the owner-review gate and
   asserted nothing about it — it called the limiter with a `kind` no endpoint
   uses, and would have passed unchanged if the gate had reverted to the header
   anyone could send.

   So this file calls the handlers' default exports with real Request objects
   and reads real Responses (five when it was written; the gallery added
   four). The store is the same in-memory double, installed
   before the handlers are imported so they resolve to the same module instance.
   Nothing here reaches the network: fetch is stubbed for the mail provider. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JEV_URL, secretStats } from '../lib/_jev.mjs';
import { storeCallSites } from './store-call-sites.mjs';

const stores = new Map();

class FakeStore {
  constructor(name) { this.name = name; this.data = new Map(); this.meta = new Map(); }
  async get(key, opts) {
    if (!this.data.has(key)) return null;
    const raw = this.data.get(key);
    return opts && opts.type === 'json' ? JSON.parse(raw) : raw;
  }
  async set(key, value, opts) {
    this.data.set(key, String(value));
    if (opts && opts.metadata) this.meta.set(key, opts.metadata);
  }
  async setJSON(key, value, opts) {
    this.data.set(key, JSON.stringify(value));
    if (opts && opts.metadata) this.meta.set(key, opts.metadata);
  }
  async delete(key) { this.data.delete(key); this.meta.delete(key); }
  async getMetadata(key) {
    if (!this.data.has(key)) return null;
    return { etag: 'x', metadata: this.meta.get(key) || {} };
  }
  list({ prefix, paginate } = {}) {
    const blobs = [...this.data.keys()].sort()
      .filter(k => !prefix || k.startsWith(prefix)).map(key => ({ key }));
    if (!paginate) return Promise.resolve({ blobs, directories: [] });
    return (async function* () {
      for (let i = 0; i < blobs.length; i += 25) {
        yield { blobs: blobs.slice(i, i + 25), directories: [] };
      }
    })();
  }
}

const store = await import('../lib/_store.mjs');
store.__useStoreFactory(name => {
  if (!stores.has(name)) stores.set(name, new FakeStore(name));
  return stores.get(name);
});

/* Mail is switched on for these, and pointed at a recorder. */
process.env.RESEND_API_KEY = 'test-key';
process.env.MAIL_FROM = 'Agent Passport <passport@example.test>';
process.env.MAIL_API_BASE = 'https://mail.invalid/emails';

const outbox = [];
/* The subscribe endpoint posts to a contacts path rather than /emails, and the
   path is the thing worth asserting, so calls are recorded with their URL. */
const calls = [];
let nextStatus = null;                    // one-shot override, for the 409 case

/* PH-507: the Jev gate's own call, stubbed separately by URL. `null` means
   "no score set for this test" -- shadowCheck() will still run (if a key is
   set) but readBoundedJson() will throw on this branch's plain object (no
   streaming body), landing in transport_error, same fail-open outcome the
   real function keeps for any transport failure. Set to
   `{ installable, unconsented, model }` to make the gate see a real scored
   answer; a real `Response` is constructed (not the plain object the mail
   stub below returns) because `_jev.mjs`'s reader needs a genuine streaming
   body, matching what undici's real fetch would hand it. */
let jevScore = null;
/* JEV_URL is imported from lib/_jev.mjs, not retyped here -- see that
   file's own comment on the constant for why: a hand-copied second string
   is exactly the kind of thing that drifts silently everywhere except
   Netlify's real build, which is the one environment TYPESAFE_API_KEY is
   ever set in. */

/* PH-507 round 3: a gate-code critic (critic-ph507-jev-gate-r2-round3)
   rebuilt the ordering tests below and found they pass whether or not the
   real network call is where the test claims it is. The reason: both
   tests asserted on `stores.get('jev')`, a row `recordJev` writes -- a
   separate statement from `shadowCheck(text)`, which is the thing that
   actually posts the passport text to TypeSafe. A mutation that hoists
   `shadowCheck` alone ahead of every gate, leaving `recordJev` in place,
   sends every passport's full text (a leaked credential included, proven
   live in the critic's report) to a third party before any gate runs, and
   both suites stayed green throughout. `jevCalls` counts the request
   itself, at the point the stub receives it, independent of whatever the
   caller later does with the result -- so a test asserting on this number
   cannot be fooled by separating the call from the store write. */
let jevCalls = 0;
/* The password check (lib/_jev.mjs secretCheck) is a second kind of request to the same URL, told
   apart by its questions being named c1, c2, ... `jevCalls` counts BOTH kinds, so every "no Jev
   request before a gate" assertion below covers the password check too. `secretScore` is null (the
   stub answers 500, which the check must fail open on) or a function of one excerpt's text that
   returns its score. `secretDelayMs` and `consentDelayMs` make the two calls slow, to prove they
   run side by side. */
let finderRunsAtConsent = null;
let secretCalls = 0, secretScore = null, secretDelayMs = 0, consentDelayMs = 0, secretModel = null;
const secretRequests = [];

globalThis.fetch = async (url, init) => {
  if (String(url) === JEV_URL) {
    jevCalls++;
    const req = JSON.parse(init.body);
    if (Object.keys(req.questions || {})[0] === 'c1') {
      secretCalls++;
      secretRequests.push(req);
      if (secretDelayMs) await new Promise(r => setTimeout(r, secretDelayMs));
      if (!secretScore) return { ok: false, status: 500, text: async () => '' };
      const excerpts = req.state.split('\n\n').map(b => b.replace(/^\[\d+\] /, ''));
      const answers = {};
      excerpts.forEach((e, i) => { answers['c' + (i + 1)] = { noul: secretScore(e) }; });
      return new Response(JSON.stringify({ model: secretModel || 'jev-1.13.0', answers }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    finderRunsAtConsent = secretStats.finderRuns;
    if (consentDelayMs) await new Promise(r => setTimeout(r, consentDelayMs));
    if (!jevScore) return { ok: false, status: 500, text: async () => '' };
    return new Response(JSON.stringify({
      model: jevScore.model || 'jev-1.13.0',
      answers: {
        installable: { noul: jevScore.installable },
        unconsented: { noul: jevScore.unconsented }
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const body = JSON.parse(init.body);
  outbox.push(body);
  calls.push({ url: String(url), body });
  const status = nextStatus === null ? 200 : nextStatus;
  nextStatus = null;
  return { ok: status >= 200 && status < 300, status, text: async () => '' };
};

process.env.SUBSCRIBE_SEGMENT_ID = 'seg_test';

/* Archive mode off for the suite, whatever the build environment says: the
   archive-mode tests at the end set it themselves. */
delete process.env.ARCHIVE_MODE;

/* The vote endpoint signs its cookie with VOTE_SECRET, a production-scoped
   Netlify variable that neither this suite nor `netlify dev` receives. Set
   here so the endpoint runs; one test below unsets it to prove the endpoint
   fails closed without it. */
process.env.VOTE_SECRET = 'test-only-vote-secret-not-the-production-one';

const upload = (await import('../netlify/functions/upload.mjs')).default;
const passport = (await import('../netlify/functions/passport.mjs')).default;
const manage = (await import('../netlify/functions/manage.mjs')).default;
const remove = (await import('../netlify/functions/delete-passport.mjs')).default;
const sweepModule = await import('../netlify/functions/sweep.mjs');
const sweepFn = sweepModule.default;
const SCOPE_SWEEP_DRY_RUN = sweepModule.SCOPE_SWEEP_DRY_RUN;
const send = (await import('../netlify/functions/send.mjs')).default;
const subscribe = (await import('../netlify/functions/subscribe.mjs')).default;
const digest = (await import('../netlify/functions/digest.mjs')).default;
const vote = (await import('../netlify/functions/vote.mjs')).default;
const copied = (await import('../netlify/functions/copied.mjs')).default;
const copiedPrompt = (await import('../netlify/functions/copied-prompt.mjs')).default;
const recountFn = (await import('../netlify/functions/recount.mjs')).default;
const checkHoldFn = (await import('../netlify/functions/check-hold.mjs')).default;
const holdEmailFn = (await import('../netlify/functions/hold-email.mjs')).default;
const { HEADERS } = await import('../netlify/functions/passport.mjs');

const GOOD = await readFile(new URL('../../examples/daily-brief-passport.md', import.meta.url), 'utf8');
const UNCONFIRMED = GOOD.replace(/^owner_confirmed: true$/m, 'owner_confirmed: false');

/* ROW-228 fixtures. GOOD is capture_path: file and already carries both
   places a declared-only marker can live: the `email.send status:
   declared_only` entry in section 3's capabilities: block, and the "Send it
   on to somebody else ... no, declared only" row in section 2. That is
   exactly the shape the write-consent gate looks for; GOOD itself is the
   negative control, since the gate is browser-only. */
const BROWSER = GOOD.replace(/^capture_path: file$/m, 'capture_path: browser');
const BROWSER_UNCONFIRMED = UNCONFIRMED.replace(/^capture_path: file$/m, 'capture_path: browser');

/* Same passport, both write markers removed: the capabilities: entry and its
   consent row. What is left declares nothing write-class, so declaresWrite is
   false and the envelope floor (E_DERIVE_ENVELOPE) asks for nothing, same as
   it does for GOOD's other five rows. Used to prove the gate does not fire on
   a browser passport that is actually clean. */
const BROWSER_CLEAN = BROWSER
  .replace(/\n\| Send it on to somebody else \|[^\n]*\|\n/, '\n')
  .replace(/\n  - capability_ref: email\.send\n    status: declared_only/, '');

/* Only the capabilities: entry removed, the consent row left standing — the
   shape the memo's second critic built: "an owner who deletes only the
   section 3 entry produces a passport that passes both validators and still
   tells the recipient her agent wrote". declaresWrite is now false, so
   derive()'s own envelope floor (E_DERIVE_ENVELOPE) asks for nothing and this
   reaches upload.mjs's gate at all; the gate must still fire, from the
   section 2 read alone, or the partial edit publishes clean. */
const BROWSER_ENTRY_DELETED = BROWSER
  .replace(/\n  - capability_ref: email\.send\n    status: declared_only/, '');

/* Both real write markers removed, and an ordinary read row marked "no" for
   an unrelated reason. validate()/derive() accept this: nothing in the
   schema restricts the Installable column's free text to declared-only
   capabilities, so this is a legal passport that declares no write anywhere.
   A critic showed the gate's second condition (any needs[].installable ===
   false row) fires on it anyway. Not a fix for that — the message wording
   is fixed to stay true either way, and the predicate question is recorded
   as open in record/proposals/row-228-refusal-code-and-payload-shape.md.
   This fixture pins the gate still firing (the ruled behaviour, unless HAL
   says otherwise) with a message that no longer asserts a write claim it
   has not found. */
const BROWSER_UNRELATED_NO_ROW = BROWSER
  .replace(/\n\| Send it on to somebody else \|[^\n]*\|\n/, '\n')
  .replace(/\n  - capability_ref: email\.send\n    status: declared_only/, '')
  .replace(
    '| Read your calendar | adds today\'s schedule to the brief | Optional | the brief has no calendar section | yes |',
    '| Read your calendar | adds today\'s schedule to the brief | Optional | the brief has no calendar section | no, you grant it in your own client |'
  );

/* The same declared-only entry twice in the capabilities: block — a legal
   passport, validate() accepts a repeated capability_ref. A critic found
   that writeMarkers() built its ref-to-entry lookup as a last-wins Map, so
   the owner was shown one pair of lines when two existed: she deleted
   exactly what she was shown, the other pair survived, and the retry
   refused her again for a line she was never told about. */
const BROWSER_DUPLICATE_ENTRY = BROWSER
  .replace(
    '  - capability_ref: email.send\n    status: declared_only',
    '  - capability_ref: email.send\n    status: declared_only\n  - capability_ref: email.send\n    status: declared_only'
  );

/* The capabilities: block entry removed, the id moved onto an inputs: entry
   instead, the section 2 row left standing. Corrected 2026-09-08, spec §8c:
   this gate's block read must NOT be d.declaredOnlyRefs' wide section-3 scan,
   which also covers inputs: — that scope belongs to the envelope floor's
   E_DERIVE_ENVELOPE_INPUT (§6.3), not this gate. declaresWrite is still true
   (the wide scan sees the id on the input), so derive()'s own floor asks for
   nothing here because the row still satisfies its arithmetic check; this
   fixture reaches the gate with the row as its only true marker.
   capability_markers must come back empty: an input entry carries no status
   and is not the passport's own statement about the capability, so this gate
   has nothing to hand the owner to delete from section 3. */
const BROWSER_ON_INPUT_WITH_ROW = BROWSER
  .replace(/\n  - capability_ref: email\.send\n    status: declared_only/, '')
  .replace(
    'inputs:\n  - what: a fixed list of general and regional news sources',
    'inputs:\n  - what: a list of things to mail\n    capability_ref: email.send\n    access: open\n  - what: a fixed list of general and regional news sources'
  );

/* The real email.send entry, PLUS a tacit_notes field on the SAME entry
   mentioning a different id mid-line. Regression for a critic-found defect
   (2026-09-08): capabilityBlockEntries()'s ref/status pairing is unanchored
   on purpose (parity with tools/validate.py check 16a) and last-match-wins
   within an entry, so this entry's own ref gets misattributed to msg.send.
   Before the fix, capability_markers sourced its id from that same walk and
   showed the owner a fabricated "msg.send" marker with real-looking lines;
   following the instruction to delete them breaks the honest email.send
   entry it actually belongs to. The fix reads ids from capabilityBlockRefs()
   (anchored, cannot be set by mid-line prose) and only uses the entry walk
   for best-effort line text, degrading to an empty lines array rather than
   naming the wrong id. */
const BROWSER_PROSE_MENTIONS_OTHER_ID = BROWSER
  .replace(
    '  - capability_ref: email.send\n    status: declared_only',
    '  - capability_ref: email.send\n    status: declared_only\n    tacit_notes: "the old config had capability_ref: msg.send but we never used it"'
  );

const ORIGIN = 'https://app.phaeacia.test';

/* Distinct source addresses per test, so one test's limiter state is not the
   next test's mystery failure. */
let nth = 0;
const freshIp = () => `198.51.100.${(nth = (nth + 1) % 250) + 1}`;

function reset() {
  stores.clear();
  outbox.length = 0;
  calls.length = 0;
  nextStatus = null;
  jevScore = null;
  jevCalls = 0;
  secretCalls = 0; secretScore = null; secretDelayMs = 0; consentDelayMs = 0; secretModel = null; secretRequests.length = 0;
  delete process.env.JEV_SECRET_DISPOSITION; delete process.env.JEV_SECRET_HOLD;
  /* PH-507: deliberate insulation, not incidental cleanup. Every test starts
     from a shell with neither variable set, whatever the ambient
     environment actually has -- so this suite models a CLEAN environment,
     never production's, where TYPESAFE_API_KEY is always set. That gap is
     safe today only because the fetch stub above is URL-aware on its own
     (built for Jev-scored fixtures, not for this reason) and because every
     Jev-specific test below re-sets the variable itself when it needs it
     present. If a future code path ever branches on the key's mere
     EXISTENCE rather than on using it to call out, this suite will not see
     it, because that branch would fire in real deploys and never fire here.
     See record/findings/a-test-that-cannot-fail-anywhere-it-runs-and-fails-
     only-where-it-ships-2026-09-17.md, the failure this insulation and the
     URL-aware stub jointly prevented on this branch without either being
     built for that purpose. */
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.JEV_DISPOSITION;
  /* A deploy with ARCHIVE_MODE=1 runs this suite in its build, so the flag is
     taken out here and set only by the archive-mode tests at the end. */
  delete process.env.ARCHIVE_MODE;
}

const post = (path, body, headers = {}, ip = freshIp()) =>
  new Request(ORIGIN + path, {
    method: 'POST',
    headers: { 'x-nf-client-connection-ip': ip, ...headers },
    body
  });

const uploadReq = (text, headers = {}, ip) =>
  post('/api/upload', text, { 'content-type': 'text/markdown', ...headers }, ip);

const jsonReq = (path, obj, ip) =>
  post(path, JSON.stringify(obj), { 'content-type': 'application/json' }, ip);

/* What Netlify's scheduler sends: a POST whose JSON body carries next_run. The
   sweep handler keys its guard on that, so a test that fabricates it is standing
   in for the platform. Written here rather than inline so the one place that
   encodes the scheduler's shape is the one place to change if it moves. */
const scheduledReq = () =>
  post('/api/sweep', JSON.stringify({ next_run: new Date(Date.now() + 3600e3).toISOString() }),
       { 'content-type': 'application/json' });

const body = async (res) => JSON.parse(await res.text());

/* A body nobody has uploaded before, so the duplicate guard is never the thing
   under test unless it is the thing under test. */
let unique = 0;
const distinct = (base = GOOD) =>
  base.replace(/^title: (.*)$/m, (_, t) => `title: ${t} ${++unique}`);

async function publish(text = distinct(), ip = freshIp()) {
  const res = await upload(uploadReq(text, {}, ip));
  const j = await body(res);
  assert.equal(j.ok, true, 'publish failed: ' + JSON.stringify(j));
  return j;
}

/* ══ upload ═══════════════════════════════════════════════ */

test('a good passport publishes and comes back with everything the screen needs', async () => {
  reset();
  const j = await publish();
  assert.match(j.id, /^[0-9a-f-]{36}$/);
  assert.match(j.delete_token, /^[0-9a-f]{40}$/);
  assert.ok(j.url.endsWith('/p/' + j.id));
  assert.ok(j.manage_url.includes('#' + j.id + ':' + j.delete_token));
  assert.ok(Date.parse(j.expires_at) > Date.now());
  assert.equal(j.ttl_days, 30);
});

/* The success screen draws a card from this, and every element on that card is
   supposed to be backed by real passport data. If these fields stop arriving the
   card does not break loudly: it draws with holes in it, or a second parser gets
   written on the client and drifts from _derive.mjs. Both are quiet failures, so
   the shape is asserted here rather than trusted. */
test('the publish response carries the derived passport the card is drawn from', async () => {
  reset();
  const j = await publish();
  const p = j.passport;
  assert.ok(p, 'no derived passport in the publish response');
  assert.equal(p.name, 'daily-brief');
  assert.equal(p.envelope, 'read-notify');
  assert.equal(p.capture_path, 'file');
  assert.equal(p.owner_confirmed, true);
  assert.ok(Array.isArray(p.capabilities) && p.capabilities.length >= 1);
  for (const c of p.capabilities) {
    assert.equal(typeof c.label, 'string');
    assert.equal(typeof c.granted, 'boolean');
    assert.equal(typeof c.required, 'boolean');
  }
  /* The counts are what the card stamps, so they have to agree with the rows
     they are counted from rather than being a second opinion about them. */
  assert.equal(p.installable, p.capabilities.filter(c => c.granted).length);
  assert.equal(p.declared_only, p.capabilities.filter(c => !c.granted).length);
  assert.equal(p.installable + p.declared_only, p.capabilities.length);
  /* And the ambiguous name stays gone. "declared" means the total in the
     passport page's own permit note and the not-installable bucket in the
     phrase "declared only" directly beside it, so a field by that name is
     read backwards by half its readers. */
  assert.equal('declared' in p, false, 'the ambiguous `declared` key is back');
});

/* ── metrics ─────────────────────────────────────────────
   The privacy page tells a publisher that this row holds "no text you wrote.
   Not the title, not the description, not the agent's name, not one sentence of
   the file", and that it carries "no identifier of any kind". Those are two
   sentences a reader has to take on trust unless something checks them, so this
   checks them: it serialises the row and looks for the passport's own words and
   ids inside it. A field added later that quietly carries prose fails here
   rather than on the privacy page. */
test('publishing writes one metrics row, and it holds no text and no identifier', async () => {
  reset();
  const j = await publish();
  const metrics = stores.get('metrics');
  assert.ok(metrics, 'no metrics store was written at all');
  const keys = [...metrics.data.keys()];
  assert.equal(keys.length, 1, 'expected exactly one row per publish');

  /* day:uuid, so the store lists oldest-first and no key joins a row to a page */
  assert.match(keys[0], /^\d{4}-\d{2}-\d{2}:[0-9a-f-]{36}$/);
  assert.ok(!keys[0].includes(j.id), 'the key must not carry the passport id');

  const row = JSON.parse(metrics.data.get(keys[0]));

  /* The real invariant, and it is stronger than hunting for words: EVERY string
     anywhere in this record must come from a closed set. Vocabulary ids, the
     enums spec/passport-0.1.md fixes, the spec version, and the day. Anything
     else is free text by definition, whoever put it there and whatever they
     called the field. Word-matching against the summary cannot do this job:
     "calendar" is both a word the owner wrote and half of `calendar.read`. */
  const VOCAB = new Set([
    'web.fetch', 'email.read', 'calendar.read', 'files.read', 'schedule.run',
    'chat.notify', 'memory.prefs', 'email.send', 'msg.send', 'social.post', 'ext.write'
  ]);
  const ENUMS = new Set([
    'read-notify', 'file', 'browser',
    'scheduled', 'on_demand', 'event', 'unknown',
    'structural', 'exact', 'input_relative',
    '0.1'
  ]);
  const strings = [];
  (function walk(v) {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  })(row);
  for (const str of strings) {
    /* `money.*` AND NOT `money.<anything>`, and the difference is the whole
       point of this assertion. spec/vocabulary.md:43 makes money a PREFIX
       rather than an id, so the validator accepts any ref under it without
       further checking. This test used to allow `str.startsWith('money.')`,
       which meant the one assertion written to prove the record holds no free
       text had a hole exactly the shape of the spec's wildcard: a passport
       carrying `capability_ref: money.<seventy characters a stranger chose>`
       validated, published, and stored the sentence verbatim. Demonstrated end
       to end before it was fixed. _metrics.mjs now collapses every money ref to
       the literal `money.*`, so that is the only spelling that may appear. */
    const allowed = VOCAB.has(str) || ENUMS.has(str) ||
                    str === 'money.*' || /^\d{4}-\d{2}-\d{2}$/.test(str);
    assert.ok(allowed, `metrics row carries a string from outside the closed set: ${JSON.stringify(str)}`);
  }

  /* And nothing that identifies the passport, belt and braces. */
  const blob = JSON.stringify(row);
  for (const secret of [j.id, j.delete_token, j.title, 'daily-brief']) {
    assert.ok(!blob.includes(secret), `metrics row leaked ${JSON.stringify(secret)}`);
  }
  /* A date, never a time: a timestamp beside a passport is a join key. */
  assert.match(row.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(/\d{2}:\d{2}/.test(blob), false, 'the row carries a clock time');
});

test('a metrics failure never costs the publisher their passport', async () => {
  reset();
  /* The one path where losing the row is the correct outcome: the delete token
     exists in exactly one response, so a broken statistic may not take it down. */
  const metrics = new FakeStore('metrics');
  metrics.setJSON = async () => { throw new Error('metrics store is down'); };
  stores.set('metrics', metrics);
  const res = await upload(uploadReq(distinct(), {}, freshIp()));
  const j = await body(res);
  assert.equal(j.ok, true, 'a metrics write failure took the publish down with it');
  assert.match(j.delete_token, /^[0-9a-f]{40}$/);
});

/* ── attempts that did not publish ───────────────────────
   The other half of the corpus, in its own store. These tests exist because the
   suite that shipped ROW-37's dead guard was 73/73 green: passing tests around a
   feature prove nothing about the feature unless one of them fails when it is
   removed. Each of these fails if the counter is deleted, and the leak test
   below fails if the wrong half of the error object is stored.

   The privacy argument is the same one made for `metrics` above, and it is
   sharper here, because the input to a refusal is a file this site REFUSED and
   the error message quotes pieces of it back. */
const CODED = (code) => code;

test('a refused upload writes one row, and it carries the code and nothing else', async () => {
  reset();
  const res = await upload(uploadReq(distinct().replace('capability_ref: web.fetch', 'capability_ref: zz.bogusmarker'), {}, freshIp()));
  assert.equal(res.status, 422);

  const attempts = stores.get('attempts');
  assert.ok(attempts, 'a refused upload wrote no attempt row at all');
  const keys = [...attempts.data.keys()];
  assert.equal(keys.length, 1, 'expected exactly one row per refused attempt');

  /* day:uuid, same as metrics: lists oldest-first, and no key joins a row to a
     request, an address or a file. */
  assert.match(keys[0], /^\d{4}-\d{2}-\d{2}:[0-9a-f-]{36}$/);

  const row = JSON.parse(attempts.data.get(keys[0]));
  assert.equal(row.code, 'E_CAPABILITY');
  assert.match(row.day, /^\d{4}-\d{2}-\d{2}$/);

  /* THE LEAK TEST, and it is the reason this fixture uses a bogus capability id
     rather than any other error. `err()` fills `{refs}` into E_CAPABILITY's
     message with the id lifted verbatim out of the uploaded file, so a row built
     from `message` instead of `code` carries a string a stranger typed. Storing
     the whole error object is the natural mistake — the two fields arrive
     together — and this is what catches it. */
  const blob = JSON.stringify(row);
  assert.equal(blob.includes('zz.bogusmarker'), false, 'the attempt row leaked text from the uploaded file');
  assert.equal(blob.includes('capability'), false, 'the attempt row carries the error message, not the code');

  /* Same closed-set rule as the metrics row: every string must come from a fixed
     set. Here that is one error code and one date. */
  const strings = [];
  (function walk(v) {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  })(row);
  for (const str of strings) {
    const allowed = /^E_[A-Z_]+$/.test(str) || /^\d{4}-\d{2}-\d{2}$/.test(str);
    assert.ok(allowed, `attempt row carries a string from outside the closed set: ${JSON.stringify(str)}`);
  }

  /* A date, never a time. A refusal and the retry a minute later are the same
     person, and a clock would say so. */
  assert.equal(/\d{2}:\d{2}/.test(blob), false, 'the attempt row carries a clock time');
});

/* ══ PH-507: the Jev gate ═══════════════════════════════════

   Filed against a critic's own residual, both rounds: "no test in either
   suite touches _jev.mjs" (critic-ph507-jev-r1, r1, round 3), so neither
   regression that branch produced would be caught again. These are the
   first tests to exercise it, added when the branch moved from
   log-only to something that can actually refuse. */

test('the Jev gate refuses when disposition is refuse and the score is flagged, and nothing is stored', async () => {
  reset();
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.JEV_DISPOSITION = 'refuse';
  jevScore = { installable: 0.97, unconsented: 0.2 };

  const res = await upload(uploadReq(distinct()));
  assert.equal(res.status, 422);
  const j = await body(res);
  assert.equal(j.code, 'E_JEV_REFUSED');
  /* This message has been wrong four times now, three in the code and a
     fourth in the test guarding it:
     1. "final: will not be accepted on a retry" -- both gate-code critics
        reproduced that exact claim false (identical bytes, second call
        published).
     2. "Nothing was stored" -- HAL caught that this contradicts
        privacy.html's own accurate disclosure that a refusal leaves a
        rejection row and a rate-limit entry.
     3. Subjectless "no text you wrote was kept" -- HAL caught that this
        reads as "your text is gone", which is false on this path: Jev
        already read the full text over the network before this line runs.
     4. The regex that replaced fix 3's check (`/\bwe\b.*\bkept\b/i`) pinned
        the SUBJECT and not the SCOPE -- a round-2 critic built a surviving
        mutation appending "...anywhere, including at TypeSafe" to the
        message, which still matches the regex and is still false (the
        site cannot speak for TypeSafe's retention, the exact category of
        error fix 3 exists to prevent). An exact-string assertion cannot
        admit an extension a substring/regex check would miss, so this now
        pins the full string rather than a pattern within it -- update this
        assertion deliberately, in the same commit, if the wording ever
        changes again. */
  assert.equal(j.message,
    'This upload was not accepted: no passport was published, and we kept no text you wrote.');

  const passports = stores.get('passports');
  assert.ok(!passports || passports.data.size === 0, 'a Jev-refused upload created a passport');

  /* The rejection row must exist -- a gate-code critic found E_JEV_REFUSED
     silently dropped by rejectionRecord()'s MESSAGES-membership gate, which
     zeroed this refusal out of the one corpus that counts what got refused
     and why (_digest.mjs's `refused`). */
  const attempts = stores.get('attempts');
  assert.ok(attempts, 'a Jev refusal wrote no attempt row at all');
  const attemptRows = [...attempts.data.values()].map(v => JSON.parse(v));
  assert.equal(attemptRows.length, 1);
  assert.equal(attemptRows[0].code, 'E_JEV_REFUSED');

  /* No refund into the failure ceiling -- a gate-code critic found the
     un-fixed code let one IP trigger up to 35 Jev/TypeSafe calls an hour
     (5 publish-ceiling refunds + 30 failure-ceiling charges) instead of the
     5-per-hour shadow mode had, since a Jev refusal (unlike every other
     refusal on this path) happens after the expensive external call, not
     before it. `bad-h` must stay untouched by this refusal. */
  const ratelimit = stores.get('ratelimit');
  const badHKeys = ratelimit ? [...ratelimit.data.keys()].filter(k => k.includes(':bad-h:')) : [];
  assert.equal(badHKeys.length, 0, 'a Jev refusal charged the failure ceiling, refunding the publish ceiling');

  /* Logged anyway -- the gate must not stop the corpus from collecting on the
     very calls it acts on. */
  const jevStore = stores.get('jev');
  assert.ok(jevStore, 'no jev log record was written for a refused upload');
  const rows = [...jevStore.data.values()].map(v => JSON.parse(v));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'scored');
  assert.equal(rows[0].installable, 0.97);
  assert.equal(rows[0].unconsented, 0.2);
});

test('the Jev gate does not refuse an unflagged score, same disposition', async () => {
  reset();
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.JEV_DISPOSITION = 'refuse';
  jevScore = { installable: 0.2, unconsented: 0.3 };

  const j = await publish();
  assert.equal(j.ok, true, 'a low score was refused as if it were flagged');

  const jevStore = stores.get('jev');
  const rows = [...jevStore.data.values()].map(v => JSON.parse(v));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'scored');
});

test('the unconsented question alone can flag it: max(), never installable alone', async () => {
  /* Regression guard for exactly the mistake jevFlagged() exists to not make:
     reading only `installable` and missing the question that actually fired.
     record/findings/the-frozen-jev-battery-scores-zero-of-165-real-captures-above-0.9-2026-09-17.md
     found unconsented the higher score on 43% of the 165-capture corpus, so a
     gate that ignored it would be silently blind on nearly half its input. */
  reset();
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.JEV_DISPOSITION = 'refuse';
  jevScore = { installable: 0.1, unconsented: 0.95 };

  const res = await upload(uploadReq(distinct()));
  assert.equal(res.status, 422);
  const j = await body(res);
  assert.equal(j.code, 'E_JEV_REFUSED');
});

test('JEV_DISPOSITION off publishes normally even on a score that would flag, matching shadow mode', async () => {
  reset();
  process.env.TYPESAFE_API_KEY = 'test-key';
  /* JEV_DISPOSITION left unset: jevDisposition() must default to 'off'. */
  jevScore = { installable: 0.99, unconsented: 0.99 };

  const j = await publish();
  assert.equal(j.ok, true, "'off' must never refuse, whatever the score");

  /* And it must still log -- 'off' silencing the corpus would break the very
     shadow-mode contract this branch is supposed to preserve for anyone who
     has not yet turned the gate on. */
  const jevStore = stores.get('jev');
  const rows = [...jevStore.data.values()].map(v => JSON.parse(v));
  assert.equal(rows.length, 1, "'off' must still write a jev log record");
  assert.equal(rows[0].outcome, 'scored');
});

test('an unimplemented disposition fails closed to off, end to end, on a flagged score, loudly', async () => {
  reset();
  process.env.TYPESAFE_API_KEY = 'test-key';
  /* 'notify', not 'hold': this test used 'hold' until PH-507 built it. 'hold'
     is now real, implemented code with its own dedicated tests below, and
     using it here would still pass -- with no HOLD_ALERT_TO set, hold fails
     closed to off for the COUPLING reason, not because it is unimplemented
     -- while this test's own name and comment kept claiming otherwise. Same
     species of stale claim HAL and I each found once already today in
     _store.mjs and _email.mjs's comments: caught here before it shipped. */
  process.env.JEV_DISPOSITION = 'notify';
  jevScore = { installable: 0.99, unconsented: 0.99 };

  const savedWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const j = await publish();
    assert.equal(j.ok, true, 'an unimplemented disposition refused a publish instead of failing closed to off');
    assert.ok(
      warnings.some(w => w.includes('JEV_DISPOSITION') && w.includes('notify')),
      'selecting an unimplemented disposition produced no warning: it looked exactly like a working choice'
    );
  } finally {
    console.warn = savedWarn;
  }
});

test('JEV_DISPOSITION=hold with no reachable HOLD_ALERT_TO fails closed to off end to end: hold is real code, not unimplemented, and still refuses to run without somewhere to tell', async () => {
  reset();
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.JEV_DISPOSITION = 'hold';
  delete process.env.HOLD_ALERT_TO;                 // the coupling this whole test exists to pin
  jevScore = { installable: 0.99, unconsented: 0.99 };

  const savedWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const j = await publish();
    assert.equal(j.ok, true, 'hold with no alert destination must publish normally, same as off');
    assert.ok(!stores.get('holds') || stores.get('holds').data.size === 0,
      'no hold row may exist when the coupling correctly failed closed');
    assert.equal(calls.length, 0, 'nothing was mailed: there is no reachable HOLD_ALERT_TO to mail');
    assert.ok(warnings.some(w => w.includes('JEV_DISPOSITION') && w.includes('hold')),
      'the coupling failing must warn, or a misconfigured hold looks like a working choice');
  } finally {
    console.warn = savedWarn;
    delete process.env.HOLD_ALERT_TO;
  }
});

test('JEV_DISPOSITION=hold with a reachable HOLD_ALERT_TO holds a flagged upload: no passport, a hold record, and a reviewer alert with no passport text', async () => {
  reset();
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.JEV_DISPOSITION = 'hold';
  process.env.HOLD_ALERT_TO = 'reviewer@example.com';    // RESEND_API_KEY is 'test-key' for this whole suite
  jevScore = { installable: 0.97, unconsented: 0.2 };
  try {
    const text = distinct();
    const res = await upload(uploadReq(text));
    assert.equal(res.status, 202);
    const j = await body(res);
    assert.equal(j.ok, false, 'a hold is not a publish: ok:true draws the success screen');
    assert.equal(j.code, 'E_HELD');
    assert.equal(j.status, 'hold');
    assert.match(j.hold_id, /^[0-9a-f-]{36}$/);
    assert.match(j.hold_token, /^[0-9a-f]{40}$/, 'the hold token must be minted the same way a delete token is');
    assert.ok(Date.parse(j.expires_at) > Date.now());
    assert.equal(j.hold_ttl_days, 5);
    assert.equal(j.url, undefined, 'nothing was published: there is no page to link to');
    assert.equal(j.delete_token, undefined, 'nothing was published: there is no passport to delete');

    const passports = stores.get('passports');
    assert.ok(!passports || passports.data.size === 0, 'a held upload must not publish a passport');

    const holds = stores.get('holds');
    assert.equal(holds.data.size, 1);
    const row = JSON.parse([...holds.data.values()][0]);
    assert.equal(row.text, text, 'the held row must carry the exact text that was uploaded');
    assert.equal('email' in row, false, 'the hold row never carries an address');
    assert.ok(!stores.get('hold-email') || stores.get('hold-email').data.size === 0, 'no address was left on this upload');

    /* The reviewer alert, driven through the real global fetch stub (not a
       mock of sendMail): recorded in `calls`, same as every other outbound
       mail this suite drives through upload/send/subscribe. */
    assert.equal(calls.length, 1, 'exactly one mail must go out: the reviewer alert');
    assert.equal(calls[0].body.to[0], 'reviewer@example.com');
    const alertText = calls[0].body.text + ' ' + calls[0].body.html;
    assert.ok(alertText.includes(j.hold_id), 'the alert must name the hold id a reviewer needs to find it');
    /* The first line of a passport is the frontmatter fence, so asserting on it
       only ever proved the alert lacks three hyphens (PH-507 gate-code critic:
       mailing the title, summary and whole body passed the suite). Assert on
       EVERY substantive line instead, and on the title and summary values. */
    const substantive = text.split('\n').map(l => l.trim()).filter(l => l.length >= 12 && l !== '---');
    assert.ok(substantive.length >= 5, 'the fixture must have enough body lines for this assertion to mean something');
    for (const line of substantive) {
      assert.ok(!alertText.includes(line),
        'the alert must never carry passport text, and it carried this line: ' + line.slice(0, 60));
    }
  } finally {
    delete process.env.HOLD_ALERT_TO;
  }
});

test('a held upload claims its fingerprint: an identical re-upload inside the hour is refused as a duplicate', async () => {
  reset();
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.JEV_DISPOSITION = 'hold';
  process.env.HOLD_ALERT_TO = 'reviewer@example.com';
  jevScore = { installable: 0.97, unconsented: 0.2 };
  try {
    const text = distinct();
    const ip = freshIp();
    const first = await body(await upload(uploadReq(text, {}, ip)));
    assert.equal(first.status, 'hold');

    const second = await body(await upload(uploadReq(text, {}, ip)));
    assert.equal(second.ok, false);
    assert.equal(second.code, 'E_DUPLICATE',
      'a hold must claim its fingerprint the same way a publish does, or the same file can be held twice');
  } finally {
    delete process.env.HOLD_ALERT_TO;
  }
});

/* PH-518 final critic: the reviewer alert used sendMail's 10 s default, so a provider that never
   answers held every flagged upload for 10 s, at the platform ceiling. It takes the hold mails' 3 s. */
test('the reviewer alert is sent with the 3 s hold timeout, not sendMail\'s 10 s default', async () => {
  reset();
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.JEV_DISPOSITION = 'hold';
  process.env.HOLD_ALERT_TO = 'reviewer@example.com';
  jevScore = { installable: 0.97, unconsented: 0.2 };
  const real = AbortSignal.timeout, seen = [];
  AbortSignal.timeout = ms => { seen.push(ms); return real.call(AbortSignal, ms); };
  try {
    const j = await body(await upload(uploadReq(distinct())));
    assert.equal(j.status, 'hold');
    assert.equal(calls.length, 1, 'the alert must have gone out for this test to say anything');
    assert.ok(seen.includes(3000), 'no 3000 ms timeout was armed: ' + JSON.stringify(seen));
    assert.ok(!seen.includes(10000), 'the alert armed sendMail\'s 10 s default: ' + JSON.stringify(seen));
  } finally {
    AbortSignal.timeout = real;
    delete process.env.HOLD_ALERT_TO;
  }
});
test('a held upload never fails because the reviewer alert could not be sent', async () => {
  reset();
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.JEV_DISPOSITION = 'hold';
  process.env.HOLD_ALERT_TO = 'reviewer@example.com';
  jevScore = { installable: 0.97, unconsented: 0.2 };
  nextStatus = 500;   // the one-shot override: the next outbound call gets a provider failure
  try {
    const j = await body(await upload(uploadReq(distinct())));
    assert.equal(j.status, 'hold', 'a failed alert send must never cost the upload its hold');
    assert.equal(stores.get('holds').data.size, 1, 'the hold itself must still exist');
  } finally {
    delete process.env.HOLD_ALERT_TO;
  }
});

/* ══ the password check (design S), through the real upload handler ════════════════
   RULING (Raffael, 2026-09-24): a score of 0.5 or more HOLDS, nothing is refused on this check. Off by
   default (JEV_SECRET_DISPOSITION), read fresh each call, logged always. The candidate line below is a
   real candidate for the finder (a cookie header) that the code gate accepts, so the number the stub
   scores and the number the response reports are the same line, end to end. */
const SECRET_MARK = 'Cookie: theme=dark';
const withSecretLine = (text = distinct()) => text.replace(/\s+$/, '') + '\n\n' + SECRET_MARK + '\n';
const lineNumberOf = (text, mark) => text.split('\n').findIndex(l => l.includes(mark)) + 1;
const scoreMark = (hi, lo = 0.05) => e => (e.includes(SECRET_MARK) ? hi : lo);
async function secretUpload({ hi, disposition = 'hold', alert = true, threshold, text, lo }) {
  reset();
  process.env.TYPESAFE_API_KEY = 'test-key';
  if (alert) process.env.HOLD_ALERT_TO = 'reviewer@example.com';
  if (disposition !== null) process.env.JEV_SECRET_DISPOSITION = disposition;   // null = leave it unset
  if (threshold !== undefined) process.env.JEV_SECRET_HOLD = threshold;
  jevScore = { installable: 0.01, unconsented: 0.01 };
  secretScore = scoreMark(hi, lo);
  const t = text || withSecretLine();
  try {
    const res = await upload(uploadReq(t));
    return { res, j: await body(res), t };
  } finally { delete process.env.HOLD_ALERT_TO; }
}
test('the code gate accepts the password-check test line, so the tests below drive the check and not a refusal', async () => {
  reset();
  const j = await body(await upload(uploadReq(withSecretLine())));
  assert.equal(j.ok, true, 'the gate refused the planted line: ' + JSON.stringify(j));
});
test('password check, hold: a score of exactly 0.5 holds, and the response names the line and only the line', async () => {
  const { res, j, t } = await secretUpload({ hi: 0.5 });
  assert.equal(res.status, 202);
  assert.equal(j.code, 'E_HELD');
  assert.equal(j.held_for, 'possible_secret');
  assert.equal(j.flagged_line, lineNumberOf(t, SECRET_MARK), 'the line number must be the 1-based number of the scored line');
  assert.equal(JSON.stringify(j).includes(SECRET_MARK), false, 'the response quoted the line');
  assert.ok(!stores.get('passports') || stores.get('passports').data.size === 0, 'a held upload must not publish');
  const held = JSON.parse([...stores.get('holds').data.values()][0]);
  assert.deepEqual(Object.keys(held.jev.secret).sort(), ['line', 'n', 'score'], 'the hold row carries numbers only');
  assert.equal(held.jev.secret.line, j.flagged_line);
});
test('password check, hold: 0.49 publishes', async () => {
  const { res, j } = await secretUpload({ hi: 0.49 });
  assert.equal(res.status, 200);
  assert.equal(j.ok, true);
  assert.ok(!stores.get('holds') || stores.get('holds').data.size === 0);
});
test('password check, disposition off (the default): a score of 0.99 publishes, and is logged with numbers only', async () => {
  const { j, t } = await secretUpload({ hi: 0.99, disposition: null });
  assert.equal(j.ok, true, 'nothing may act until Raffael switches it on');
  const rows = [...stores.get('jev').data.values()].map(v => JSON.parse(v));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].secret.outcome, 'scored');
  assert.equal(rows[0].secret.score, 0.99);
  assert.equal(rows[0].secret.line, lineNumberOf(t, SECRET_MARK));
  assert.ok(Number.isInteger(rows[0].secret.n) && rows[0].secret.n >= 1 && rows[0].secret.n <= 30);
  assert.equal(JSON.stringify(rows[0]).includes('theme'), false, 'the log row carried text from the passport');
  assert.deepEqual(Object.keys(rows[0].secret).sort(), ['line', 'modelMismatch', 'n', 'outcome', 'score']);
});
test('password check: there is no refuse. JEV_SECRET_DISPOSITION=refuse fails closed to off with a warning, and 0.99 publishes', async () => {
  const savedWarn = console.warn, warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const { j } = await secretUpload({ hi: 0.99, disposition: 'refuse' });
    assert.equal(j.ok, true, 'a refuse value must never turn into a refusal or a hold');
    assert.ok(warnings.some(w => w.includes('JEV_SECRET_DISPOSITION') && w.includes('never refuses')), warnings.join(' | '));
  } finally { console.warn = savedWarn; }
});
test('password check, hold with no reachable HOLD_ALERT_TO: publishes normally and warns (a hold nobody is told about is not a hold)', async () => {
  const savedWarn = console.warn, warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const { j } = await secretUpload({ hi: 0.99, alert: false });
    assert.equal(j.ok, true);
    assert.ok(warnings.some(w => w.includes('JEV_SECRET_DISPOSITION') && w.includes('HOLD_ALERT_TO')), warnings.join(' | '));
  } finally { console.warn = savedWarn; }
});
test('password check: JEV_SECRET_HOLD moves the threshold, and a value outside (0, 1] falls back to 0.5 with a warning', async () => {
  assert.equal((await secretUpload({ hi: 0.6, threshold: '0.7' })).j.ok, true, '0.6 is under a 0.7 threshold');
  assert.equal((await secretUpload({ hi: 0.7, threshold: '0.7' })).j.code, 'E_HELD', '0.7 meets a 0.7 threshold');
  const savedWarn = console.warn, warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    for (const bad of ['0', '-1', '2', 'abc', ' ']) {
      warnings.length = 0;
      const { j } = await secretUpload({ hi: 0.5, threshold: bad });
      assert.equal(j.code, 'E_HELD', 'threshold ' + JSON.stringify(bad) + ' should fall back to 0.5, and 0.5 holds');
      if (bad.trim() !== '') assert.ok(warnings.some(w => w.includes('JEV_SECRET_HOLD')), 'no warning for ' + bad);
    }
  } finally { console.warn = savedWarn; }
});
test('password check fails open: an HTTP error, a wrong model and a missing key never hold, and a missing key sends nothing', async () => {
  // HTTP 500 from the stub (secretScore null)
  reset();
  process.env.TYPESAFE_API_KEY = 'test-key'; process.env.JEV_SECRET_DISPOSITION = 'hold'; process.env.HOLD_ALERT_TO = 'reviewer@example.com';
  jevScore = { installable: 0.01, unconsented: 0.01 };
  try {
    assert.equal((await body(await upload(uploadReq(withSecretLine())))).ok, true, 'an HTTP error held an upload');
    const row = [...stores.get('jev').data.values()].map(v => JSON.parse(v))[0];
    assert.equal(row.secret.outcome, 'http_error');
    // a score from a model that is not the one the threshold was measured on
    reset(); process.env.TYPESAFE_API_KEY = 'test-key'; process.env.JEV_SECRET_DISPOSITION = 'hold'; process.env.HOLD_ALERT_TO = 'reviewer@example.com';
    jevScore = { installable: 0.01, unconsented: 0.01 }; secretScore = scoreMark(0.99); secretModel = 'jev-9.9.9';
    assert.equal((await body(await upload(uploadReq(withSecretLine())))).ok, true, 'a mismatched model held an upload');
    // no key: the kill switch, nothing sent at all
    reset(); process.env.JEV_SECRET_DISPOSITION = 'hold'; process.env.HOLD_ALERT_TO = 'reviewer@example.com';
    delete process.env.TYPESAFE_API_KEY; secretScore = scoreMark(0.99);
    assert.equal((await body(await upload(uploadReq(withSecretLine())))).ok, true);
    assert.equal(jevCalls, 0, 'with the key unset nothing may reach Jev');
  } finally { delete process.env.HOLD_ALERT_TO; }
});
test('password check: the request carries excerpts, never the whole passport, at most 30 of them, with the frozen question', async () => {
  const { t } = await secretUpload({ hi: 0.1 });
  assert.equal(secretRequests.length, 1);
  const req = secretRequests[0];
  const n = Object.keys(req.questions).length;
  assert.ok(n >= 1 && n <= 30, 'candidate count out of range: ' + n);
  assert.deepEqual(Object.keys(req.questions), Array.from({ length: n }, (_, i) => 'c' + (i + 1)));
  assert.ok(req.state.length < t.length, 'the check sent the whole passport instead of excerpts');
  assert.ok(req.state.includes(SECRET_MARK));
  assert.match(req.questions.c1.instructions, /^Look only at excerpt \[1\]\. Does this text contain the actual value of a secret/);
});
test('password check runs beside the consent check, not after it: two 250 ms calls finish in under 450 ms', async () => {
  reset();
  process.env.TYPESAFE_API_KEY = 'test-key';
  jevScore = { installable: 0.01, unconsented: 0.01 }; secretScore = scoreMark(0.1);
  secretDelayMs = 250; consentDelayMs = 250;
  const t0 = Date.now();
  const j = await body(await upload(uploadReq(withSecretLine())));
  const ms = Date.now() - t0;
  assert.equal(j.ok, true);
  assert.equal(jevCalls, 2, 'test setup: both checks should have run');
  assert.ok(ms < 450, 'the two checks ran one after the other: ' + ms + ' ms');
});

test('password check: it holds only on its own disposition, and reports a line only when it is what held', async () => {
  // consent disposition = hold, password check OFF, high password-check score: held by the consent check alone
  reset();
  process.env.TYPESAFE_API_KEY = 'test-key'; process.env.JEV_DISPOSITION = 'hold'; process.env.HOLD_ALERT_TO = 'reviewer@example.com';
  jevScore = { installable: 0.97, unconsented: 0.2 }; secretScore = scoreMark(0.99);
  try {
    let j = await body(await upload(uploadReq(withSecretLine())));
    assert.equal(j.code, 'E_HELD');
    assert.equal(j.held_for, 'consent_table');
    assert.equal(j.flagged_line, null, 'a line was reported on a hold the password check did not make');
    // consent LOW, password check OFF, high password-check score: publishes (the consent disposition must not switch the password check on)
    reset();
    process.env.TYPESAFE_API_KEY = 'test-key'; process.env.JEV_DISPOSITION = 'hold'; process.env.HOLD_ALERT_TO = 'reviewer@example.com';
    jevScore = { installable: 0.01, unconsented: 0.01 }; secretScore = scoreMark(0.99);
    j = await body(await upload(uploadReq(withSecretLine())));
    assert.equal(j.ok, true, 'JEV_DISPOSITION=hold switched the password check on');
  } finally { delete process.env.JEV_DISPOSITION; delete process.env.HOLD_ALERT_TO; }
});
test('password check: the finder runs before the consent request starts, so it can never eat that request\'s 2 s', async () => {
  reset();
  process.env.TYPESAFE_API_KEY = 'test-key';
  jevScore = { installable: 0.01, unconsented: 0.01 }; secretScore = scoreMark(0.1);
  const before = secretStats.finderRuns;
  finderRunsAtConsent = null;
  await body(await upload(uploadReq(withSecretLine())));
  assert.equal(finderRunsAtConsent, before + 1, 'the consent request started before the candidate finder had run');
});
test('a 253 KB line of "auth" in section 3 does not let a passport past the consent gate, and costs the upload well under a second of finder time', async () => {
  reset();
  process.env.TYPESAFE_API_KEY = 'test-key'; process.env.JEV_DISPOSITION = 'refuse';
  jevScore = { installable: 0.99, unconsented: 0.99 };
  try {
    const t = distinct().replace(/(## 3\.[^\n]*\n)/, '$1' + 'auth'.repeat(63000) + '\n');
    assert.ok(t.length > 250000, 'test setup: the line was not inserted');
    const t0 = Date.now();
    const res = await upload(uploadReq(t));
    const ms = Date.now() - t0;
    assert.equal(res.status, 422, 'a passport the consent check refuses was published: ' + res.status);
    assert.equal((await body(res)).code, 'E_JEV_REFUSED');
    assert.ok(ms < 3000, 'the upload took ' + ms + ' ms');
  } finally { delete process.env.JEV_DISPOSITION; }
});

/* ══ /api/check-hold and /api/hold-email ══════════════════════════════════
   Driven as real HTTP requests through a hold actually created by upload(),
   not by calling lib/_store.mjs directly -- tools/run-tests.mjs already
   covers checkHold/attachHoldEmail's own logic; this file's job is the
   handler wiring: method, rate limit, payload shape, and the response an
   actual caller gets back. */

async function makeHold(ip = freshIp()) {
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.JEV_DISPOSITION = 'hold';
  process.env.HOLD_ALERT_TO = 'reviewer@example.com';
  jevScore = { installable: 0.97, unconsented: 0.2 };
  const j = await body(await upload(uploadReq(distinct(), {}, ip)));
  assert.equal(j.status, 'hold', 'test setup failed to create a hold: ' + JSON.stringify(j));
  delete process.env.HOLD_ALERT_TO;
  delete process.env.JEV_DISPOSITION;
  delete process.env.TYPESAFE_API_KEY;
  return j;
}

test('check-hold: only POST, and a malformed payload fails without touching the store', async () => {
  reset();
  const get = await checkHoldFn(new Request(ORIGIN + '/api/check-hold', { method: 'GET' }));
  assert.equal(get.status, 405);

  const bad = await checkHoldFn(jsonReq('/api/check-hold', { hold_id: 'x' })); // no hold_token
  assert.equal(bad.status, 400);
  const j = await body(bad);
  assert.equal(j.ok, false);
});

test('check-hold: pending for a fresh hold, not_found for a wrong token or an unknown id, released after releaseHold', async () => {
  reset();
  const hold = await makeHold();

  const pending = await body(await checkHoldFn(jsonReq('/api/check-hold',
    { hold_id: hold.hold_id, hold_token: hold.hold_token })));
  assert.deepEqual(pending, { ok: true, status: 'pending' });

  const wrongToken = await body(await checkHoldFn(jsonReq('/api/check-hold',
    { hold_id: hold.hold_id, hold_token: 'f'.repeat(40) })));
  assert.deepEqual(wrongToken, { ok: true, status: 'not_found' });

  const unknown = await body(await checkHoldFn(jsonReq('/api/check-hold',
    { hold_id: '00000000-0000-4000-8000-000000000000', hold_token: hold.hold_token })));
  assert.deepEqual(unknown, { ok: true, status: 'not_found' });

  const store = await import('../lib/_store.mjs');
  const released = await store.releaseHold(undefined, hold.hold_id);
  assert.equal(released.ok, true);

  const afterRelease = await body(await checkHoldFn(jsonReq('/api/check-hold',
    { hold_id: hold.hold_id, hold_token: hold.hold_token })));
  assert.deepEqual(afterRelease, { ok: true, status: 'released', id: released.id },
    'a returning owner must learn where their released passport went, without needing their token');
});

test('a hold whose reviewer alert fails to send is still stored, and the failure is logged with the hold id and never the address', async () => {
  /* sendMail never throws; it resolves { ok:false, reason }. The call site ignored
     the return, so the catch around it was unreachable and a hold nobody was told
     about left no trace (PH-507 gate-code critic). */
  reset();
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.JEV_DISPOSITION = 'hold';
  process.env.HOLD_ALERT_TO = 'alerts-only@example.com';
  jevScore = { installable: 0.97, unconsented: 0.2 };
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
  let j;
  try {
    nextStatus = 500;
    j = await body(await upload(uploadReq(distinct())));
  } finally {
    console.error = realError;
    delete process.env.HOLD_ALERT_TO;
    delete process.env.JEV_DISPOSITION;
    delete process.env.TYPESAFE_API_KEY;
  }
  assert.equal(j.status, 'hold', 'a failed alert must not cost the owner their hold');
  assert.equal(stores.get('holds').data.size, 1);
  const line = errors.find(e => e.includes('hold alert mail failed'));
  assert.ok(line, 'a failed alert left no trace: ' + JSON.stringify(errors));
  assert.ok(line.includes(j.hold_id), 'the log line must name the hold');
  assert.ok(!line.includes('alerts-only@example.com'), 'the log line must never carry an address');
});

test('under JEV_DISPOSITION=hold an UNFLAGGED score publishes, and no hold is created', async () => {
  /* The refuse disposition has this test; hold had only the flagged case, so
     dropping jevFlagged() from the hold branch made every clean upload hold and
     both suites stayed green (PH-507 gate-code critic). */
  reset();
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.JEV_DISPOSITION = 'hold';
  process.env.HOLD_ALERT_TO = 'reviewer@example.com';
  jevScore = { installable: 0.2, unconsented: 0.3 };
  try {
    const j = await publish();
    assert.equal(j.ok, true);
    assert.notEqual(j.status, 'hold', 'a low score was held as if it were flagged');
    assert.ok(j.url, 'an unflagged upload under hold must publish');
    const holds = stores.get('holds');
    assert.ok(!holds || holds.data.size === 0, 'no hold row may exist for an unflagged upload');
  } finally {
    delete process.env.HOLD_ALERT_TO;
    delete process.env.JEV_DISPOSITION;
    delete process.env.TYPESAFE_API_KEY;
  }
});

test('hold-email is rate-limited per network, and the limit stops writes to the store', async () => {
  reset();
  const ip = freshIp();
  const hold = await makeHold(ip);
  for (let i = 0; i < 20; i++) {
    const res = await holdEmailFn(jsonReq('/api/hold-email',
      { hold_id: hold.hold_id, hold_token: hold.hold_token, email: `n${i}@example.com` }, ip));
    assert.equal(res.status, 200, `attempt ${i + 1} should not be limited yet`);
  }
  const limited = await holdEmailFn(jsonReq('/api/hold-email',
    { hold_id: hold.hold_id, hold_token: hold.hold_token, email: 'over-the-limit@example.com' }, ip));
  assert.equal(limited.status, 429);
  const kept = JSON.parse(stores.get('hold-email').data.get(hold.hold_id));
  assert.equal(kept.email, 'n19@example.com', 'a limited request must not reach the store');
});

test("the hold response is not a publish to today's share.js, and the branch it falls to renders the server's own message", async () => {
  /* assets/share.js treated ok:true as a publish, so a hold drew "Published" with
     "undefined" as the link and the delete token. This runs the CURRENT client's own
     predicate (sliced out of the file, so a change to it is seen here) against the
     real hold response. */
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../assets/share.js', import.meta.url), 'utf8');
  const m = src.match(/if \((res\.json && res\.json\.ok)\) return succeed\(res\.json\);/);
  assert.ok(m, 'share.js no longer has the publish predicate this test slices; re-read it before trusting the hold response shape');
  const isPublish = new Function('res', 'return !!(' + m[1] + ');');

  const hold = await makeHold();
  assert.equal(isPublish({ status: 202, json: hold }), false, 'the client would draw the success screen for a hold');
  /* The client's next branches: a code that is neither of the two gate codes nor
     E_INTERNAL falls through to `list = [res.json]` and prints err.message. */
  assert.ok(!['E_OWNER_UNCONFIRMED', 'E_WRITE_UNCONFIRMED', 'E_INTERNAL'].includes(hold.code));
  assert.equal(typeof hold.message, 'string');
  assert.ok(hold.message.length > 20 && !/undefined/.test(hold.message));
  assert.ok(hold.message.includes('not published'), 'the message must say the passport was not published');
  assert.ok(hold.message.includes('5 days'), 'the message must carry the real hold lifetime, not the 30-day publish lifetime');
});

test('check-hold is rate-limited per network, counted against attempts', async () => {
  reset();
  const ip = freshIp();
  const hold = await makeHold(ip);
  for (let i = 0; i < 20; i++) {
    const res = await checkHoldFn(jsonReq('/api/check-hold',
      { hold_id: hold.hold_id, hold_token: hold.hold_token }, ip));
    assert.equal(res.status, 200, `attempt ${i + 1} should not be limited yet`);
  }
  const limited = await checkHoldFn(jsonReq('/api/check-hold',
    { hold_id: hold.hold_id, hold_token: hold.hold_token }, ip));
  assert.equal(limited.status, 429);
});

test('hold-email: only POST, requires a real address, and overwrites rather than merges', async () => {
  reset();
  const get = await holdEmailFn(new Request(ORIGIN + '/api/hold-email', { method: 'GET' }));
  assert.equal(get.status, 405);

  const hold = await makeHold();

  const badAddr = await holdEmailFn(jsonReq('/api/hold-email',
    { hold_id: hold.hold_id, hold_token: hold.hold_token, email: 'not-an-address' }));
  assert.equal(badAddr.status, 422);

  const first = await body(await holdEmailFn(jsonReq('/api/hold-email',
    { hold_id: hold.hold_id, hold_token: hold.hold_token, email: 'a@example.com' })));
  assert.deepEqual(first, { ok: true, status: 'ok' });

  const second = await body(await holdEmailFn(jsonReq('/api/hold-email',
    { hold_id: hold.hold_id, hold_token: hold.hold_token, email: 'b@example.com' })));
  assert.deepEqual(second, { ok: true, status: 'ok' });

  const kept = JSON.parse(stores.get('hold-email').data.get(hold.hold_id));
  assert.equal(kept.email, 'b@example.com', 'a second address must replace the first, not add a second');
});

test('hold-email: a wrong token or an unknown id both fail the same way, indistinguishably', async () => {
  reset();
  const hold = await makeHold();

  const wrongToken = await holdEmailFn(jsonReq('/api/hold-email',
    { hold_id: hold.hold_id, hold_token: 'f'.repeat(40), email: 'a@example.com' }));
  assert.equal(wrongToken.status, 400);
  const wrongTokenBody = await body(wrongToken);

  const unknown = await holdEmailFn(jsonReq('/api/hold-email',
    { hold_id: '00000000-0000-4000-8000-000000000000', hold_token: hold.hold_token, email: 'a@example.com' }));
  assert.equal(unknown.status, 400);
  const unknownBody = await body(unknown);

  assert.deepEqual(wrongTokenBody, unknownBody, 'a wrong token and an unknown id must be one indistinguishable answer');
});

test('with no TYPESAFE_API_KEY the gate skips cleanly, whatever the disposition, and logs the skip', async () => {
  reset();
  /* No TYPESAFE_API_KEY set: the kill switch / missing-key skip condition. */
  process.env.JEV_DISPOSITION = 'refuse';
  jevScore = { installable: 0.99, unconsented: 0.99 };  // must never be read: no key, no call

  const j = await publish();
  assert.equal(j.ok, true, 'a missing key must skip, never error and never refuse');

  const jevStore = stores.get('jev');
  const rows = [...jevStore.data.values()].map(v => JSON.parse(v));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'skipped_no_key');
});

test('a scored response naming the wrong model never refuses, even above cutoff', async () => {
  /* A gate-code critic reproduced this live: `_jev.mjs` computes and logs
     `modelMismatch` specifically because a moved model invalidates the
     0.9 cutoff's calibration, and the un-fixed jevFlagged() ignored that
     fact and refused anyway. */
  reset();
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.JEV_DISPOSITION = 'refuse';
  jevScore = { installable: 0.99, unconsented: 0.99, model: 'jev-9.9.9' };

  const j = await publish();
  assert.equal(j.ok, true, 'a mismatched model must fail open, not refuse on an uncalibrated score');

  const jevStore = stores.get('jev');
  const rows = [...jevStore.data.values()].map(v => JSON.parse(v));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].modelMismatch, true, 'the mismatch itself must still be logged');
});

test('the Jev call never fires for a passport the secret scan already refused', async () => {
  /* Regression guard for a gate-code critic's mutation: moving the whole
     Jev block from its position after the duplicate check to immediately
     before validate() survived both suites silently, and would send a
     leaked credential's own passport text to TypeSafe ahead of the secret
     scan that is supposed to catch it. This pins the ordering itself, not
     just today's placement, so a future reorder fails a test instead of
     shipping quietly.

     Asserts on `jevCalls` (the stub receiving the request) as well as the
     `jev` store row: round 3 found the store-row assertion alone passes
     even when `shadowCheck` is hoisted ahead of this gate and only
     `recordJev` is left behind, because nothing had ever separated "the
     call happened" from "the call's result got logged". */
  reset();
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.JEV_DISPOSITION = 'refuse';
  jevScore = { installable: 0.01, unconsented: 0.01 };  // would not flag even if called

  const leaky = distinct().replace('## 6. Losses',
    'The key is AKIAIOSFODNN7EXAMPLE and it works.\n\n## 6. Losses');
  const res = await upload(uploadReq(leaky));
  const j = await body(res);
  assert.equal(res.status, 422);
  assert.ok((j.errors || [j]).some(e => e.code === 'E_SECRET_FOUND'));

  assert.equal(jevCalls, 0,
    'the Jev network call fired on text the secret scan should have stopped first');
  const jevStore = stores.get('jev');
  assert.ok(!jevStore || jevStore.data.size === 0,
    'the Jev call ran on text the secret scan should have stopped first');
});

test('the Jev call never fires ahead of the category, owner-review, write-consent, or duplicate gates either', async () => {
  /* Two more gate-code critics, round 2, each found the previous test too
     narrow: one moved the whole block ahead of derive/owner-review/duplicate
     and all three survived; the other moved just the network call (not the
     refusal) to right after the fingerprint is computed -- ahead of every
     gate below it -- and that survived too. The most severe of these,
     named explicitly: an unreviewed browser passport (owner_confirmed:
     false) is one this site's own framing says the person it describes has
     not read, and a reorder that ships its full text to TypeSafe before
     that gate fires would do so with nothing in either suite noticing.
     One test per gate, asserting on `jevCalls` -- the network request
     itself -- not on the jev store row. Round 3 (critic-ph507-jev-gate-
     r2-round3) found a mutation that hoists `shadowCheck` alone ahead of
     every one of these gates, leaving `recordJev` at its current
     position, passes a store-row assertion: the row simply never gets
     written because the refusal returns before `recordJev` runs, which
     looks identical, to that assertion, to "Jev never ran". The critic
     proved the request itself still reaches TypeSafe -- with a leaked
     credential in the body, on the secret-scan case -- so the count of
     stub invocations is the only thing that cannot be fooled this way. */
  const casesRefusedBeforeJev = [
    ['category', () => upload(uploadReq(distinct(), { 'x-passport-list': '1', 'x-passport-category': 'not-a-real-category' }))],
    ['owner-review', () => upload(uploadReq(BROWSER_UNCONFIRMED.replace(/^title: (.*)$/m, (_, t) => `title: ${t} owner${++unique}`)))],
    ['write-consent', () => upload(uploadReq(BROWSER.replace(/^title: (.*)$/m, (_, t) => `title: ${t} write${++unique}`)))],
  ];

  for (const [label, run] of casesRefusedBeforeJev) {
    reset();
    process.env.TYPESAFE_API_KEY = 'test-key';
    process.env.JEV_DISPOSITION = 'refuse';
    jevScore = { installable: 0.99, unconsented: 0.99 };  // would flag if it ran -- must not run
    const res = await run();
    assert.ok(res.status === 409 || res.status === 422, `${label}: expected a refusal, got ${res.status}`);
    assert.equal(jevCalls, 0,
      `${label}: the Jev network call fired on text this gate should have refused first`);
    const jevStore = stores.get('jev');
    assert.ok(!jevStore || jevStore.data.size === 0,
      `${label}: the Jev call ran on text this gate should have refused first`);
  }

  // Duplicate: the first upload must publish (nothing to refuse yet), so it legitimately calls
  // Jev once; the SECOND, identical-body upload must be caught by seenRecently before Jev runs again.
  reset();
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.JEV_DISPOSITION = 'refuse';
  jevScore = { installable: 0.01, unconsented: 0.01 };  // low enough that the first upload publishes
  const text = distinct();
  const first = await publish(text);
  assert.equal(first.ok, true);
  /* Two requests now: the whole-document consent question and the password check's candidate
     excerpts (the example passport has candidate lines). Each is once. */
  assert.equal(jevCalls, 2, 'the first, legitimate upload should have called Jev once for each of its two checks');
  assert.equal(secretCalls, 1, 'the password check should have run exactly once');
  const jevAfterFirst = [...stores.get('jev').data.values()].length;
  assert.equal(jevAfterFirst, 1, 'the first, legitimate upload should have logged Jev exactly once');

  const second = await upload(uploadReq(text));
  assert.equal((await body(second)).code, 'E_DUPLICATE');
  assert.equal(jevCalls, 2, 'a duplicate body must be caught before Jev is called again, not after');
  const jevAfterSecond = [...stores.get('jev').data.values()].length;
  assert.equal(jevAfterSecond, 1, 'a duplicate body must be caught before Jev runs again, not after');
});

test('a Jev refusal spends the publish ceiling and grants no extra budget, unlike an un-fixed refund', async () => {
  /* A gate-code critic measured the un-fixed code (chargeAsFailure() called
     on this path like every other refusal) letting one IP trigger 35
     Jev/TypeSafe calls an hour: 5 publish-ceiling refunds plus 30
     failure-ceiling charges, because a Jev refusal happens AFTER the
     expensive external call, unlike every other refusal on this path. The
     fixed code must cap it at up-h's 5, the same ceiling shadow mode had
     (Jev only ever ran on a successful publish there). */
  reset();
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.JEV_DISPOSITION = 'refuse';
  jevScore = { installable: 0.99, unconsented: 0.99 };
  const ip = freshIp();

  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const res = await upload(uploadReq(distinct(), {}, ip));
    statuses.push(res.status);
  }
  assert.deepEqual(statuses, [422, 422, 422, 422, 422, 429],
    'five Jev refusals should exhaust the 5/hour publish ceiling, the sixth call must be rate-limited, not refused again');
});

test('a passport with several problems is one person bouncing once, not four rows', async () => {
  reset();
  const broken = distinct()
    .replace('capability_ref: web.fetch', 'capability_ref: zz.bogusmarker')
    .replace(/^comparison_mode:.*$/m, 'comparison_mode: nonsense');
  const res = await upload(uploadReq(broken, {}, freshIp()));
  const j = await body(res);
  assert.equal(j.ok, false);
  assert.ok(j.errors.length >= 2, 'fixture stopped producing multiple errors: ' + JSON.stringify(j.errors));

  const attempts = stores.get('attempts');
  assert.equal([...attempts.data.keys()].length, 1, 'one attempt produced more than one row');
  const row = JSON.parse(attempts.data.get([...attempts.data.keys()][0]));
  assert.equal(row.code, j.code, 'the row does not carry the code the client was shown');
});

/* THE REFUSALS THAT DO NOT COME FROM THE VALIDATOR, and this test exists
   because it was missing and the omission was invisible.

   The first draft of this block tested four refusals and every one of them was a
   validation failure, so all four went through `refuseMany`. Deleting the
   counter from `refuse` — the other half, carrying transport errors, derive
   errors, the duplicate guard and the 500 — left the suite 52/52 green. That is
   the ROW-37 failure reproduced inside the change that was written to avoid it:
   a guard with tests around it and no test through it.

   Found by mutation rather than by reading, which is the point. Any refusal that
   reaches `refuse` rather than `refuseMany` will do; these two are the cheapest
   to provoke. */
test('a transport refusal is counted, not only a validation one', async () => {
  reset();
  const res = await upload(post('/api/upload', GOOD, { 'content-type': 'application/json' }));
  const j = await body(res);
  assert.equal(res.status, 415);
  assert.equal(j.code, 'E_CONTENT_TYPE');
  const rows = [...(stores.get('attempts')?.data.values() ?? [])].map(JSON.parse);
  assert.equal(rows.length, 1, 'a transport refusal wrote no row: `refuse` is not counting');
  assert.equal(rows[0].code, 'E_CONTENT_TYPE');
});

test('the duplicate guard is counted', async () => {
  reset();
  const text = distinct();
  await publish(text);
  const res = await upload(uploadReq(text, {}, freshIp()));
  assert.equal(res.status, 409);
  const rows = [...(stores.get('attempts')?.data.values() ?? [])].map(JSON.parse);
  assert.equal(rows.length, 1, 'a duplicate refusal wrote no row: `refuse` is not counting');
  assert.equal(rows[0].code, 'E_DUPLICATE');
});

/* The remaining two paths through `refuse`. Both reach it, so neither can have
   its own dead call site, but both were unexercised: a bug in what they hand to
   `refuse` — a missing `code`, an error object of a different shape — would not
   have shown up anywhere. Cheap to close, so closed. */
/* Reaching stage 4 at all takes care: an over-long title looks like the obvious
   derive failure and never gets there, because the validator refuses it at stage
   2 as E_BAD_VALUE and the attempt goes through `refuseMany` instead. Emptying
   section 1 passes every structural check — the heading is still present and in
   order — and fails only when derive tries to read three sentences out of it. */
test('a derive refusal is counted', async () => {
  reset();
  const src = distinct();
  const a = src.indexOf('## 1. What this agent is');
  const b = src.indexOf('## 2.');
  assert.ok(a >= 0 && b > a, 'fixture headings moved');
  const gutted = src.slice(0, a + '## 1. What this agent is'.length) + '\n\n' + src.slice(b);
  const res = await upload(uploadReq(gutted, {}, freshIp()));
  const j = await body(res);
  assert.equal(j.code, 'E_DERIVE_SUMMARY', 'fixture stopped producing a derive error: ' + j.code);
  const rows = [...(stores.get('attempts')?.data.values() ?? [])].map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, 'E_DERIVE_SUMMARY');
});

/* The 500. This is the one refusal that means the fault is ours rather than the
   uploader's, which makes it the most valuable code in the corpus to see: a
   cluster of E_INTERNAL is an outage nobody reported. It is also the one where
   the counter is least likely to work, because the store it writes to may be the
   store that just failed — hence a double named `passports` only. */
test('a storage failure is counted as a refusal, and does not take the response with it', async () => {
  reset();
  const passports = new FakeStore('passports');
  /* setJSON, not set. createPassport writes the expiry index with `set` and the
     row itself with `setJSON` (_store.mjs:368-370), so breaking `set` breaks the
     index and the publish still succeeds. The first version of this test did
     exactly that and asserted a 500 against a 200. */
  passports.setJSON = async () => { throw new Error('passports store is down'); };
  stores.set('passports', passports);
  const res = await upload(uploadReq(distinct(), {}, freshIp()));
  const j = await body(res);
  assert.equal(res.status, 500);
  assert.equal(j.code, 'E_INTERNAL');
  const rows = [...(stores.get('attempts')?.data.values() ?? [])].map(JSON.parse);
  assert.equal(rows.length, 1, 'the 500 path recorded nothing');
  assert.equal(rows[0].code, 'E_INTERNAL');
});

test('the owner-review gate is counted, because it is the only refusal of a well-formed passport', async () => {
  reset();
  const res = await upload(uploadReq(distinct(UNCONFIRMED), {}, freshIp()));
  assert.equal(res.status, 409);
  const attempts = stores.get('attempts');
  const rows = [...attempts.data.values()].map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, CODED('E_OWNER_UNCONFIRMED'));
});

/* THE SUCCESS PATH STAYS CLEAN, and this is a performance assertion rather than
   a privacy one. A production store operation costs a median of 310 ms, and the
   publish path is the one where the delete token exists in exactly one response.
   Total attempts on a day is the metrics count plus the attempts count; the
   arithmetic belongs to the reader, not to the hot path. A future change that
   "completes" the corpus by recording successes here fails this test. */
test('a successful publish writes no attempt row', async () => {
  reset();
  await publish();
  const attempts = stores.get('attempts');
  assert.equal(attempts ? attempts.data.size : 0, 0, 'the publish path grew a second store write');
});

test('a rate-limited request is not recorded, because recording past a ceiling is unbounded', async () => {
  reset();
  const ip = freshIp();
  for (let i = 0; i < 5; i++) await publish(distinct(), ip);
  const before = stores.get('attempts') ? stores.get('attempts').data.size : 0;
  const res = await upload(uploadReq(distinct(), {}, ip));
  assert.equal(res.status, 429, 'fixture did not reach the hourly ceiling');
  const after = stores.get('attempts') ? stores.get('attempts').data.size : 0;
  assert.equal(after, before, 'a refusal past the rate limit wrote a row, which is an unbounded write');
});

test('a wrong method is not an upload attempt', async () => {
  reset();
  const res = await upload(new Request(ORIGIN + '/api/upload', { method: 'GET' }));
  assert.equal(res.status, 405);
  assert.equal(stores.get('attempts') ? stores.get('attempts').data.size : 0, 0);
});

/* Fail closed. If a caller ever passes the wrong half of an error object, the
   row is dropped rather than stored: a lost count is worth less than a leak. */
test('a code this site does not define is refused by the record itself', async () => {
  const { rejectionRecord } = await import('../lib/_metrics.mjs');
  assert.equal(rejectionRecord({ day: '2026-08-17', code: 'E_INVENTED' }), null);
  assert.equal(rejectionRecord({ day: '2026-08-17', code: 'The passport asks for a capability' }), null);
  assert.equal(rejectionRecord({ day: '2026-08-17', code: 'toString' }), null, 'a prototype key was accepted as an error code');
  assert.deepEqual(rejectionRecord({ day: '2026-08-17', code: 'E_CAPABILITY' }),
                   { v: 1, day: '2026-08-17', code: 'E_CAPABILITY' });

  /* BOTH fields, not just the interesting one. The first version of this record
     validated `code` and let `day` through untouched, because `day` comes from
     the server clock and no caller could put anything else there. That is a fact
     about today's callers, not a property of the record, and the record is what
     privacy.html's promise is made about. A critic broke it in one line. */
  assert.equal(rejectionRecord({ day: '<script>alert(1)</script>', code: 'E_CAPABILITY' }), null,
               'the record accepted free text in the day field');
  assert.equal(rejectionRecord({ day: { leak: 'user text' }, code: 'E_CAPABILITY' }), null,
               'the record accepted an object in the day field');
  assert.equal(rejectionRecord({ code: 'E_CAPABILITY' }), null, 'the record accepted a missing day');
  assert.equal(rejectionRecord({ day: '2026-08-17T14:32:01Z', code: 'E_CAPABILITY' }), null,
               'the record accepted a clock time as a day');
});

test('an attempts-store failure never changes what the caller is told', async () => {
  reset();
  const attempts = new FakeStore('attempts');
  attempts.setJSON = async () => { throw new Error('attempts store is down'); };
  stores.set('attempts', attempts);
  const res = await upload(uploadReq(distinct().replace('capability_ref: web.fetch', 'capability_ref: zz.bogusmarker'), {}, freshIp()));
  const j = await body(res);
  assert.equal(res.status, 422, 'a broken counter turned a clear refusal into something else');
  assert.equal(j.code, 'E_CAPABILITY');
});

test('the owner-review gate refuses once and cannot be talked past', async () => {
  reset();
  const ip = freshIp();
  const text = distinct(UNCONFIRMED);

  const first = await upload(uploadReq(text, {}, ip));
  const refused = await body(first);
  assert.equal(first.status, 409);
  assert.equal(refused.code, 'E_OWNER_UNCONFIRMED');
  assert.match(refused.ack, /^[0-9a-f]{36}$/);

  /* The word the first version of this took. */
  const guessed = await upload(uploadReq(text, { 'x-passport-owner-ack': 'unconfirmed' }, ip));
  assert.equal(guessed.status, 409, 'a guessed acknowledgement published a passport');

  /* Another passport's ticket. */
  const other = await body(await upload(uploadReq(distinct(UNCONFIRMED), {}, ip)));
  const crossed = await upload(uploadReq(text, { 'x-passport-owner-ack': other.ack }, ip));
  assert.equal(crossed.status, 409, "another body's ticket published this one");

  const ok = await upload(uploadReq(text, { 'x-passport-owner-ack': refused.ack }, ip));
  assert.equal((await body(ok)).ok, true, 'the real ticket did not publish');
});

test('a ticket is spent once', async () => {
  reset();
  const ip = freshIp();
  const text = distinct(UNCONFIRMED);
  const { ack } = await body(await upload(uploadReq(text, {}, ip)));
  assert.equal((await body(await upload(uploadReq(text, { 'x-passport-owner-ack': ack }, ip)))).ok, true);
  const replay = await upload(uploadReq(text, { 'x-passport-owner-ack': ack }, ip));
  assert.equal(replay.status, 409, 'a spent ticket published a second passport');
});

test('a refusal is never free, whichever kind of refusal it is', async () => {
  reset();
  /* The hole, twice over: the gate refunded both attempts on a path the client
     chose, then refunded them on consume, which still bought two full
     validations per recorded attempt. Every refusal now moves its attempt to
     the failure ceiling, so nothing runs the validator for nothing. */
  const ip = freshIp();
  const limiter = () => stores.get('ratelimit') || { data: new Map() };
  /* Keys are `${windowMs}:${paddedBucket}:${kind}:${iphash}:${uuid}` — window
     and bucket first, so the sweeper's bounded scan meets the oldest keys. */
  const count = kind => [...limiter().data.keys()].filter(k => k.split(':')[2] === kind).length;

  for (let i = 0; i < 6; i++) await upload(uploadReq(distinct(UNCONFIRMED), {}, ip));
  assert.equal(count('bad-h'), 6, 'gate refusals were not charged');
  assert.equal(count('up-h'), 0, 'a refusal kept a publish slot');

  /* A malformed file is charged the same way. */
  await upload(uploadReq('not a passport at all, but long enough. '.repeat(20), {}, ip));
  assert.equal(count('bad-h'), 7);
});

/* ── ROW-228: the write-consent gate ─────────────────────
   record/proposals/where-the-owners-yes-no-on-a-declared-only-write-row-lives.md
   and record/proposals/row-228-refusal-code-and-payload-shape.md. */

test('a browser passport carrying no write marker publishes, same as file capture', async () => {
  reset();
  const j = await publish(distinct(BROWSER_CLEAN));
  assert.equal(j.passport.capture_path, 'browser');
});

test('a file-capture passport with both write markers is not gated: the gate is browser-only', async () => {
  reset();
  const j = await publish();   // GOOD, capture_path: file, carries both markers
  assert.equal(j.passport.capture_path, 'file');
});

test('a browser passport carrying both write markers is refused, listing both, not paired', async () => {
  reset();
  const res = await upload(uploadReq(distinct(BROWSER), {}, freshIp()));
  const j = await body(res);
  assert.equal(res.status, 409);
  assert.equal(j.code, 'E_WRITE_UNCONFIRMED');
  assert.match(j.ack, /^[0-9a-f]{36}$/);
  assert.equal(j.refusals.length, 1);
  assert.equal(j.refusals[0].code, 'E_WRITE_UNCONFIRMED');

  assert.equal(j.capability_markers.length, 1);
  assert.equal(j.capability_markers[0].id, 'email.send');
  assert.deepEqual(j.capability_markers[0].lines,
    ['  - capability_ref: email.send', '    status: declared_only']);

  assert.equal(j.consent_rows.length, 1);
  assert.match(j.consent_rows[0].line, /Send it on to somebody else/);
  assert.match(j.consent_rows[0].line, /no, declared only/);
});

test('an unrelated "no" row still trips the gate today, and its message does not assert a write claim it has not found', async () => {
  reset();
  const res = await upload(uploadReq(distinct(BROWSER_UNRELATED_NO_ROW), {}, freshIp()));
  const j = await body(res);
  assert.equal(res.status, 409, 'if this now publishes, the predicate was narrowed: update this test to match, do not delete it');
  assert.equal(j.code, 'E_WRITE_UNCONFIRMED');
  assert.equal(j.capability_markers.length, 0, 'the fixture declares no write id anywhere');
  assert.equal(j.consent_rows.length, 1);
  assert.doesNotMatch(j.message, /still declares a capability that writes to the world/i,
    'the message must not assert a write claim when capability_markers is empty');
});

test('a duplicated declared-only entry reports lines from both occurrences, not just the last', async () => {
  reset();
  const res = await upload(uploadReq(distinct(BROWSER_DUPLICATE_ENTRY), {}, freshIp()));
  const j = await body(res);
  assert.equal(res.status, 409);
  assert.equal(j.capability_markers.length, 1, 'declaredOnlyRefs is a Set, so one id, not two markers');
  assert.deepEqual(j.capability_markers[0].lines, [
    '  - capability_ref: email.send', '    status: declared_only',
    '  - capability_ref: email.send', '    status: declared_only'
  ], 'both occurrences of the duplicated entry must be listed, or the owner deletes one and is refused again for the other');
});

test('an id mentioned mid-line in a real entry\'s own prose field is not the reported id', async () => {
  reset();
  const res = await upload(uploadReq(distinct(BROWSER_PROSE_MENTIONS_OTHER_ID), {}, freshIp()));
  const j = await body(res);
  assert.equal(res.status, 409);
  assert.equal(j.code, 'E_WRITE_UNCONFIRMED');
  assert.equal(j.capability_markers.length, 1, 'exactly one real declared-only entry exists');
  assert.equal(j.capability_markers[0].id, 'email.send',
    'the id must be the entry\'s own capability_ref, not a word from its tacit_notes field');
  assert.notEqual(j.capability_markers[0].id, 'msg.send');
  /* An empty lines array is the honest degrade: capabilityBlockEntries()'
     unanchored, entry-pairing walk (kept unanchored for Python parity, see
     its own comment) attributes this entry's lines to the wrong key
     internally, so the correct id has no line lookup — better than showing
     lines that, if deleted, break the entry they actually belong to. */
  assert.deepEqual(j.capability_markers[0].lines, []);
});

test('the partial edit: section 3 entry deleted, section 2 row kept, still refused', async () => {
  reset();
  /* declaresWrite is false here, so derive()'s own envelope floor asks for
     nothing and this reaches the gate at all — see BROWSER_ENTRY_DELETED's
     own comment. If the gate only read section 3, this would publish with a
     row telling the recipient the agent writes. */
  const res = await upload(uploadReq(distinct(BROWSER_ENTRY_DELETED), {}, freshIp()));
  const j = await body(res);
  assert.equal(res.status, 409);
  assert.equal(j.code, 'E_WRITE_UNCONFIRMED');
  assert.equal(j.capability_markers.length, 0, 'no section 3 marker should remain');
  assert.equal(j.consent_rows.length, 1, 'the section 2 row alone must still trip the gate');
});

test('a declared-only id on an inputs: entry alone is not a capability_markers marker; the row still trips the gate', async () => {
  reset();
  const res = await upload(uploadReq(distinct(BROWSER_ON_INPUT_WITH_ROW), {}, freshIp()));
  const j = await body(res);
  assert.equal(res.status, 409);
  assert.equal(j.code, 'E_WRITE_UNCONFIRMED', 'the row alone is enough to fire the gate');
  assert.equal(j.capability_markers.length, 0,
    'an id found only on an inputs: entry is not this gate\'s marker (spec §8c); it is the envelope floor\'s, via E_DERIVE_ENVELOPE_INPUT');
  assert.equal(j.consent_rows.length, 1, 'the section 2 row is still the one true marker here');
});

test('"yes": the write-consent ticket republishes the bytes unchanged', async () => {
  reset();
  const ip = freshIp();
  const text = distinct(BROWSER);
  const refused = await body(await upload(uploadReq(text, {}, ip)));
  assert.equal(refused.code, 'E_WRITE_UNCONFIRMED');

  const ok = await body(await upload(uploadReq(text, { 'x-passport-write-ack': refused.ack }, ip)));
  assert.equal(ok.ok, true, 'the write-consent ticket did not publish');
  /* Stored as pasted: the declared-only row is still there, not stripped. */
  assert.equal(ok.passport.declared_only, 1);
});

test('a write-consent ticket is spent once', async () => {
  reset();
  const ip = freshIp();
  const text = distinct(BROWSER);
  const { ack } = await body(await upload(uploadReq(text, {}, ip)));
  assert.equal((await body(await upload(uploadReq(text, { 'x-passport-write-ack': ack }, ip)))).ok, true);
  const replay = await body(await upload(uploadReq(text, { 'x-passport-write-ack': ack }, ip)));
  /* code, not just status: E_DUPLICATE is also a 409 on this endpoint (the
     same bytes republished), so status alone cannot tell "the ticket was
     burned" from "the duplicate guard caught the body" — a critic pointed
     out the first version of this assertion could pass for the wrong
     reason. The gate runs ahead of the duplicate check, so a spent ticket
     against unchanged bytes is refused as E_WRITE_UNCONFIRMED again. */
  assert.equal(replay.code, 'E_WRITE_UNCONFIRMED', 'a spent write-consent ticket published a second passport');
});

test('one gate\'s ticket does not satisfy the other', async () => {
  reset();
  const ip = freshIp();
  /* Both problems on one body, so both tickets exist from the same refusal. */
  const text = distinct(BROWSER_UNCONFIRMED);
  const refused = await body(await upload(uploadReq(text, {}, ip)));
  assert.equal(refused.refusals.length, 2, 'expected both gates to fire together');
  const ownerAck = refused.refusals.find(r => r.code === 'E_OWNER_UNCONFIRMED').ack;
  const writeAck = refused.refusals.find(r => r.code === 'E_WRITE_UNCONFIRMED').ack;

  /* The owner-review ticket presented as the write-consent header, and vice
     versa. Neither should be accepted for the other gate. */
  const crossed = await body(await upload(uploadReq(text, {
    'x-passport-owner-ack': writeAck,
    'x-passport-write-ack': ownerAck
  }, ip)));
  assert.equal(crossed.ok, false, 'a crossed ticket published');
  assert.equal(crossed.refusals.length, 2, 'a crossed ticket satisfied a gate it was not minted for');

  /* The real pairing publishes. */
  const ok = await body(await upload(uploadReq(text, {
    'x-passport-owner-ack': ownerAck,
    'x-passport-write-ack': writeAck
  }, ip)));
  assert.equal(ok.ok, true, 'the correctly paired tickets did not publish');
});

test('both gates on one browser passport: one 409, one screen, two problems', async () => {
  reset();
  const res = await upload(uploadReq(distinct(BROWSER_UNCONFIRMED), {}, freshIp()));
  const j = await body(res);
  assert.equal(res.status, 409);
  assert.equal(j.refusals.length, 2);
  assert.deepEqual(j.refusals.map(r => r.code).sort(),
    ['E_OWNER_UNCONFIRMED', 'E_WRITE_UNCONFIRMED']);
  /* One priced attempt (chargeAsFailure runs once per POST, whichever gates
     fire) but TWO rejection-corpus rows, one per entry in refusals[].
     Corrected 2026-09-08, spec §8c: a single row keyed to problems[0].code
     made the write gate invisible in the corpus on every passport that trips
     both gates, because owner-review is checked first and always wins that
     slot. Pricing and counting are different questions; only pricing is
     once-per-POST. */
  const attempts = stores.get('attempts');
  const rows = [...attempts.data.values()].map(JSON.parse);
  assert.equal(rows.length, 2,
    'a combined refusal should record one rejection row per refusals[] entry');
  assert.deepEqual(rows.map(r => r.code).sort(),
    ['E_OWNER_UNCONFIRMED', 'E_WRITE_UNCONFIRMED'],
    'both refused codes should reach the corpus, not just problems[0]');
  const limiter = stores.get('ratelimit');
  const badH = [...limiter.data.keys()].filter(k => k.split(':')[2] === 'bad-h');
  assert.equal(badH.length, 1, 'a combined refusal should charge one failure, not two');
});

test('the two ceilings together cap full validator runs at thirty-five', async () => {
  reset();
  const ip = freshIp();
  const junk = 'not a passport at all, but long enough. '.repeat(20);
  let refusedAt = null;
  for (let i = 0; i < 45 && refusedAt === null; i++) {
    const res = await upload(uploadReq(junk, {}, ip));
    if (res.status === 429) refusedAt = i;
  }
  /* Thirty move to the failure ceiling; then the move stops working and five
     stay on the publish ceiling; then nothing. There is no pre-check gate, so a
     publisher on a shared address is never locked out by somebody else's
     malformed file — they always have their own five. */
  assert.equal(refusedAt, 35, 'the ceilings did not cap at 35: ' + refusedAt);
});

test('a bad file does not cost somebody else on the same network their publish', async () => {
  reset();
  const ip = freshIp();
  const junk = 'not a passport at all, but long enough. '.repeat(20);
  for (let i = 0; i < 30; i++) await upload(uploadReq(junk, {}, ip));

  const res = await upload(uploadReq(distinct(), {}, ip));
  assert.equal((await body(res)).ok, true,
    'thirty bad uploads locked the whole network out of publishing');
});

test('publishing five times an hour is where the publish ceiling is', async () => {
  reset();
  const ip = freshIp();
  const codes = [];
  for (let i = 0; i < 7; i++) {
    codes.push((await upload(uploadReq(distinct(), {}, ip))).status);
  }
  assert.equal(codes.filter(c => c === 200).length, 5, codes.join(','));
  assert.equal(codes[6], 429);
});

test('the same body twice in an hour is a duplicate', async () => {
  reset();
  const text = distinct();
  await publish(text);
  const again = await upload(uploadReq(text));
  assert.equal((await body(again)).code, 'E_DUPLICATE');
});

test('a passport carrying a credential is refused and nothing is stored', async () => {
  reset();
  const leaky = distinct().replace('## 6. Losses',
    'The key is AKIAIOSFODNN7EXAMPLE and it works.\n\n## 6. Losses');
  const res = await upload(uploadReq(leaky));
  const j = await body(res);
  assert.equal(res.status, 422);
  assert.ok((j.errors || [j]).some(e => e.code === 'E_SECRET_FOUND'));
  assert.equal((stores.get('passports') || { data: new Map() }).data.size, 0);
});

test('a URL-carried token under 20 characters cannot publish in either ROW-77 shape', async () => {
  reset();
  /* Both shapes published from main at 8ab975e, through this very endpoint,
     while the tools suite stayed green: the astral path because \S{0,512}
     counted code points in Python and UTF-16 units in V8, so only the endpoint
     side fell over the bound, and the long path because 512 characters before
     the parameter is short for a signed URL. Values stay under 20 characters so
     CREDENTIAL_ASSIGN cannot be the rule doing the catching; if these two pass
     for that reason the gate is still broken. */
  const shapes = {
    'an astral path': 'https://a.example/' + '\u{1F600}'.repeat(300) + '/cb?token=abc123',
    'a long path':    'https://a.example/' + 'a'.repeat(600) + '/cb?token=abc123',
  };
  for (const [name, url] of Object.entries(shapes)) {
    const leaky = distinct().replace('## 6. Losses',
      `See ${url} for it.\n\n## 6. Losses`);
    const res = await upload(uploadReq(leaky, {}, freshIp()));
    const j = await body(res);
    assert.equal(res.status, 422, `${name} published through the upload gate`);
    assert.ok((j.errors || [j]).some(e => e.code === 'E_SECRET_FOUND'),
      `${name} was refused, but not as a secret`);
  }
  /* The negative that keeps the rule honest at this door: the same long path
     with no credential parameter is ordinary content and publishes. */
  const benign = distinct().replace('## 6. Losses',
    'See https://a.example/' + 'a'.repeat(600) + '/docs?page=2 for it.\n\n## 6. Losses');
  const ok = await body(await upload(uploadReq(benign, {}, freshIp())));
  assert.equal(ok.ok, true, 'a long URL without a credential parameter was refused');
});

test('a signed-URL signature cannot publish through the upload gate', async () => {
  reset();
  /* The URL vocabulary held token|key|secret|auth|apikey|api_key|access_token
     and nothing else, so the most credential-shaped URL in circulation
     published through this door: a presigned URL's whole security IS the
     signature parameter, and it is not called any of those seven things.

     The AWS shape carries ASIA and not AKIA on purpose. An AKIA key id has its
     own rule; a probe carrying one would be refused by that rule and would
     report this one working while it was not. A control must fail the way the
     real thing fails.

     The X-Ms shape names a vendor nobody enumerated. The rule is a bounded
     ASCII prefix class rather than a list of clouds, and this is the probe that
     says the difference matters. */
  const shapes = {
    'an AWS presigned URL':
      'https://b.s3.amazonaws.com/o.pdf?X-Amz-Credential=ASIAX%2F20260901&X-Amz-Signature=4f2a9c1de8b7360a5c1f9e0d2b8a7645',
    'an Azure SAS URL':
      'https://acct.blob.core.windows.net/c/b.txt?sv=2022-11-02&sp=r&sig=Kx8Qz%2Bm3Lp7Yv1Wq4Nd6Rf9Tg2Hj5Sc8Bn0Am3Zw%3D',
    'a bare signature parameter':
      'https://api.example.com/v1/pay?ts=1756713600&signature=9d4f8c2b1e7a60539f8c2b1e7a60539f',
    'a vendor prefix nobody enumerated':
      'https://a.example/o?X-Ms-Signature=4f2a9c1de8b7360a5c1f9e0d2b8a7645',
  };
  for (const [name, url] of Object.entries(shapes)) {
    const leaky = distinct().replace('## 6. Losses',
      `See ${url} for it.\n\n## 6. Losses`);
    const res = await upload(uploadReq(leaky, {}, freshIp()));
    const j = await body(res);
    assert.equal(res.status, 422, `${name} published through the upload gate`);
    assert.ok((j.errors || [j]).some(e => e.code === 'E_SECRET_FOUND'),
      `${name} was refused, but not as a secret`);
  }
  /* The negatives. "sig" and "signature" are ordinary English words and the
     delimiter anchor is the whole defence; a document that merely discusses
     them must still publish. */
  for (const benignText of [
    'The sig field is described in the signature section below.',
    'The query was ?sig=abc123 in the log, after a space.',
  ]) {
    const benign = distinct().replace('## 6. Losses',
      `${benignText}\n\n## 6. Losses`);
    const ok = await body(await upload(uploadReq(benign, {}, freshIp())));
    assert.equal(ok.ok, true, `refused ordinary prose: ${benignText}`);
  }
});

test('a webhook URL cannot publish through the upload gate', async () => {
  reset();
  /* The path IS the credential here, so no rule that looks for a parameter or
     an assignment can see it. This is the credential a passport is most likely
     to carry honestly: an owner describing how their agent posts to a channel
     writes the URL down without thinking of it as a key. */
  const shapes = {
    'a Slack trigger':
      'https://hooks.slack.com/triggers/T012AB3CD/8912345678901/8f3c1a9b2d4e6f70a1b2c3d4e5f60718',
    'a Discord webhook':
      'https://discord.com/api/webhooks/1234567890123456789/aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7bC9dE1fG3hI5jK7lM9nO1pQ',
  };
  for (const [name, url] of Object.entries(shapes)) {
    const leaky = distinct().replace('## 6. Losses',
      `It posts to ${url} each morning.\n\n## 6. Losses`);
    const res = await upload(uploadReq(leaky, {}, freshIp()));
    const j = await body(res);
    assert.equal(res.status, 422, `${name} published through the upload gate`);
    assert.ok((j.errors || [j]).some(e => e.code === 'E_SECRET_FOUND'),
      `${name} was refused, but not as a secret`);
  }
  /* The negatives share the vendors' domains and must still publish, or the
     rule costs every honest document that explains where its output goes. */
  for (const benignText of [
    'See https://api.slack.com/messaging/webhooks for the guide.',
    'Join the thread at https://acme.slack.com/archives/C012AB3CD',
  ]) {
    const benign = distinct().replace('## 6. Losses',
      `${benignText}\n\n## 6. Losses`);
    const ok = await body(await upload(uploadReq(benign, {}, freshIp())));
    assert.equal(ok.ok, true, `refused ordinary prose: ${benignText}`);
  }
});

test('a refusal that cannot be charged keeps its attempt', async () => {
  reset();
  const ip = freshIp();
  const junk = 'not a passport at all, but long enough. '.repeat(20);

  /* chargeAsFailure refunds up-h ONLY if the bad-h charge landed. Without that
     guard, a refusal that cannot be recorded anywhere is a free full validator
     run, which is the rule shouted in capitals in refundLimit's comment and
     the one this endpoint has now broken twice. */
  const rl = stores.get('ratelimit') || { set: async () => {} };
  await upload(uploadReq(junk, {}, ip));          // make the store exist
  const live = stores.get('ratelimit');
  const realSet = live.set.bind(live);
  live.set = async (key, value, opts) => {
    if (key.split(':')[2] === 'bad-h') throw new Error('storage refused');
    return realSet(key, value, opts);
  };

  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await upload(uploadReq(junk, {}, ip))).status);
  live.set = realSet;

  assert.ok(codes.includes(429),
    'with the failure ceiling unwritable, refusals became free: ' + codes.join(','));
});

/* ══ /p/:id ═══════════════════════════════════════════════ */

const page = (id) => passport(new Request(`${ORIGIN}/p/${id}`), { params: { id } });

test('a published passport renders, and its view count is real', async () => {
  reset();
  const { id } = await publish();

  const first = await page(id);
  assert.equal(first.status, 200);
  assert.ok((await first.text()).includes('first presentation'));

  await page(id);
  const third = await page(id);
  assert.ok((await third.text()).includes('presented 2 times before this'),
    'the page is not reading the view counter back');
});

test('the social card names the canonical site, whatever Host asked for the page', async () => {
  /* This is the regression test for the thing that was wrong, and the reason it
     has to be driven through the HANDLER rather than through renderPassport:
     the defect was never in the renderer. renderPassport did exactly what it
     was told. The handler told it `new URL(req.url).origin`, which is the Host
     header, so a request with a foreign Host produced a page whose og:url,
     og:image and twitter:image named that host and an unfurling bot fetched our
     social card from somewhere that is not us. A test that calls the renderer
     with a hostile origin would only prove the renderer interpolates its
     argument, which was never in doubt.

     Every other test in this file arrives from ORIGIN, `https://app.phaeacia.test`,
     which is not the canonical host either. So before this change the assertions
     below would have failed on the ordinary path too, not merely a hostile one.
     That is the deploy-preview case: a preview is not an attacker, it just has
     a different hostname, and it rendered cards pointing at itself. */
  reset();
  const { id } = await publish();

  for (const [what, req] of [
    ['a hostile Host',   new Request(`https://evil.example/p/${id}`)],
    ['the test origin',  new Request(`${ORIGIN}/p/${id}`)],
  ]) {
    const html = await (await passport(req, { params: { id } })).text();

    assert.ok(!html.includes('evil.example'),
      `${what}: the requesting host reached the page`);

    for (const tag of [
      'meta property="og:url"',
      'meta property="og:image"',
      'meta name="twitter:image"',
    ]) {
      const at = html.indexOf('<' + tag);
      assert.ok(at >= 0, `${what}: ${tag} is not on the page at all`);
      const content = html.slice(at).match(/content="([^"]*)"/);
      assert.ok(content, `${what}: ${tag} has no readable content attribute`);
      assert.ok(content[1].startsWith('https://app.phaeacia.ai/'),
        `${what}: ${tag} is ${content[1]}, which is not the canonical site`);
    }
  }
});

test('the specimen route takes its card from the canonical site too', async () => {
  /* /p/example renders from a bundled fixture and is a separate call in the
     handler, so it is a separate way to reintroduce the same bug. */
  reset();
  const html = await (await passport(
    new Request('https://evil.example/p/example'), { params: { id: 'example' } })).text();

  assert.ok(!html.includes('evil.example'), 'the requesting host reached the specimen page');
  assert.ok(html.includes('content="https://app.phaeacia.ai/p/example"'),
    'the specimen page og:url is not the canonical one');
});

test('deleted, expired and never-existed are one answer, to the byte', async () => {
  reset();
  const gone = await publish();
  await remove(jsonReq('/api/delete', { id: gone.id, token: gone.delete_token }));

  const dead = await publish();
  const passports = stores.get('passports');
  const row = JSON.parse(passports.data.get(dead.id));
  row.expires_at = new Date(Date.now() - 1000).toISOString();
  passports.data.set(dead.id, JSON.stringify(row));
  passports.meta.set(dead.id, { h: row.delete_token_hash, x: Date.parse(row.expires_at) });

  const answers = [];
  for (const id of [gone.id, dead.id, '00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
    const res = await page(id);
    answers.push({
      status: res.status,
      headers: [...res.headers].sort().map(h => h.join(':')).join('|'),
      body: await res.text()
    });
  }
  for (const a of answers.slice(1)) {
    assert.equal(a.status, answers[0].status);
    assert.equal(a.headers, answers[0].headers);
    assert.equal(a.body, answers[0].body, 'one kind of absence looks different from another');
  }
  assert.equal(answers[0].status, 404);
});

test('the specimen renders without touching the network', async () => {
  reset();
  const res = await page('example');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Specimen'));
  assert.ok(html.includes('Never, it is the specimen'));
});

/* ══ manage and delete ════════════════════════════════════ */

test('the status behind a token, and nothing without it', async () => {
  reset();
  const { id, delete_token } = await publish();
  await page(id);

  const ok = await body(await manage(jsonReq('/api/manage', { id, token: delete_token, action: 'status' })));
  assert.equal(ok.ok, true);
  assert.equal(ok.status.views, 1);
  assert.equal(ok.status.renewed, 0);

  for (const token of ['f'.repeat(40), 'nope', '', delete_token.toUpperCase()]) {
    const res = await manage(jsonReq('/api/manage', { id, token, action: 'status' }));
    assert.equal(res.status, 404);
    assert.equal((await body(res)).code, 'E_MANAGE_FAILED');
  }
});

test('renewing moves the date and is counted', async () => {
  reset();
  const { id, delete_token, expires_at } = await publish();
  const j = await body(await manage(jsonReq('/api/manage', { id, token: delete_token, action: 'renew' })));
  assert.equal(j.ok, true);
  assert.equal(j.status.renewed, 1);
  assert.ok(Date.parse(j.renewed_to) >= Date.parse(expires_at) - 2000);

  const res = await page(id);
  assert.equal(res.status, 200, 'the passport stopped rendering after a renewal');
});

/* This used to be titled "the sweep that runs on the next upload" and ran a
   second publish() to trigger it. The sweep is a scheduled function now, so it
   is driven through that handler instead.

   The property under test never had anything to do with uploading: it is that a
   renewed passport survives a sweep and its stale index key is cleared. Driving
   it through the real handler rather than calling sweep() directly also covers
   the guard, because a handler that refuses the caller sweeps nothing and would
   pass a weaker version of this test for entirely the wrong reason. */
test('a renewed passport survives a scheduled sweep, and its stale key is cleared', async () => {
  reset();
  const { id, delete_token } = await publish();

  /* The state an interrupted renewal leaves: the new index key written, the old
     one still there and pointing at a live passport. A sweeper that trusted the
     index over the record deleted it, irreversibly, and told nobody. */
  const expiry = stores.get('expiry');
  const stale = `${String(Date.now() - 60_000).padStart(16, '0')}:${id}`;
  expiry.data.set(stale, '1');
  await manage(jsonReq('/api/manage', { id, token: delete_token, action: 'renew' }));
  expiry.data.set(stale, '1');

  const res = await sweepFn(scheduledReq());
  assert.equal((await body(res)).ok, true, 'the scheduled sweep refused its own scheduler');

  assert.equal((await page(id)).status, 200, 'the sweeper deleted a live passport');
  assert.equal(expiry.data.has(stale), false, 'the stale index key was not cleared');
});

test('the scheduled sweep actually clears an expired hold, not just a static count in the response', async () => {
  /* A gate-code critic (critic-ph507-hold-r2) found `sweepHolds` called in
     exactly one place, sweep.mjs, and nothing that would notice if that
     call were replaced with a static zero object: a mutation doing exactly
     that passed 249/249 unit and 142/144 endpoint tests. The unit suite
     tests sweepHolds() itself directly, never through sweep.mjs, so it
     cannot see this. This drives it through the real scheduled handler and
     checks the STORE, not only the number sweep.mjs prints. */
  reset();
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.JEV_DISPOSITION = 'hold';
  process.env.HOLD_ALERT_TO = 'reviewer@example.com';
  jevScore = { installable: 0.97, unconsented: 0.2 };
  let hold;
  try {
    hold = await body(await upload(uploadReq(distinct())));
    assert.equal(hold.status, 'hold', 'test setup failed to create a hold: ' + JSON.stringify(hold));
  } finally {
    delete process.env.HOLD_ALERT_TO;
    delete process.env.JEV_DISPOSITION;
    delete process.env.TYPESAFE_API_KEY;
  }

  const holds = stores.get('holds');
  const holdExpiry = stores.get('hold-expiry');
  const row = JSON.parse(holds.data.get(hold.hold_id));
  const wasKey = [...holdExpiry.data.keys()][0];
  row.expires_at = new Date(Date.now() - 1000).toISOString();
  holds.data.set(hold.hold_id, JSON.stringify(row));
  holdExpiry.data.delete(wasKey);
  holdExpiry.data.set(`${String(Date.parse(row.expires_at)).padStart(16, '0')}:${hold.hold_id}`, '1');

  const res = await sweepFn(scheduledReq());
  const j = await body(res);
  assert.equal(j.ok, true);
  assert.equal(j.holds, 1, 'the sweep response must reflect the hold sweepHolds() actually cleared');
  /* The rename to holdPointers/holdsListFailed/holdsBudgetSpent exists so the holds
     pass cannot overwrite the passports pass's listFailed/budgetSpent. Replacing
     the renamed object with the raw counters left both suites green (PH-507
     gate-code critics): pin every key. */
  for (const k of ['holdPointers', 'holdsListFailed', 'holdsBudgetSpent', 'holdMailsDropped', 'listFailed', 'budgetSpent']) {
    assert.ok(k in j, 'the sweep response lost ' + k + ': ' + JSON.stringify(j));
  }
  assert.equal(j.holdsListFailed, false);
  assert.equal(j.listFailed, false, 'the passports pass reports its own listing state, not the holds pass');
  assert.equal(holds.data.has(hold.hold_id), false,
    'the hold row must actually be gone from the store, not just counted');
  assert.equal(holdExpiry.data.size, 0, 'the hold-expiry index entry must be gone too');
});

/* Everything console.log and console.error printed while `fn` ran, as lines,
   for the code-only log lines added from the 2026-10-22 audit. Both channels,
   so an assertion that no id was logged covers every route to the log. */
async function captureLogs(fn) {
  const lines = [];
  const realLog = console.log, realError = console.error;
  const keep = (...a) => { lines.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
  console.log = keep; console.error = keep;
  let value;
  try { value = await fn(); } finally { console.log = realLog; console.error = realError; }
  return { value, lines, ops: lines.filter(l => l.startsWith('ops: ')).map(l => JSON.parse(l.slice(5))) };
}

/* The backlog figure reaches the one line this scheduled function logs, and
   no swept id does. budgetSpent alone could not tell an hour behind from two
   weeks behind (sweep() in lib/_store-expiry.mjs). */
test('the sweep log line carries the expiry backlog and its age, and no passport id', async () => {
  reset();
  const a = await publish();
  const b = await publish();
  const twoHoursAgo = Date.now() - 2 * 3600e3;
  for (const { id } of [a, b]) {
    const passports = stores.get('passports');
    const row = JSON.parse(passports.data.get(id));
    const expiry = stores.get('expiry');
    expiry.data.delete([...expiry.data.keys()].find(k => k.endsWith(':' + id)));
    row.expires_at = new Date(twoHoursAgo).toISOString();
    passports.data.set(id, JSON.stringify(row));
    passports.meta.set(id, { h: row.delete_token_hash, x: twoHoursAgo });
    expiry.data.set(`${String(twoHoursAgo).padStart(16, '0')}:${id}`, '1');
  }

  const { value: res, lines } = await captureLogs(() => sweepFn(scheduledReq()));
  assert.equal((await body(res)).ok, true);
  const counts = lines.filter(l => l.startsWith('sweep: ')).map(l => JSON.parse(l.slice('sweep: '.length)));
  assert.equal(counts.length, 1, 'expected exactly one counts line');
  assert.equal(counts[0].passports, 2);
  assert.equal(counts[0].expiryBacklog, 2, 'the counts line has no backlog figure');
  assert.ok(counts[0].expiryBacklogAgeMin >= 120 && counts[0].expiryBacklogAgeMin <= 121,
    'the backlog age is not on the counts line: ' + counts[0].expiryBacklogAgeMin);
  for (const { id, delete_token } of [a, b]) {
    assert.equal(lines.some(l => l.includes(id) || l.includes(delete_token)), false, 'a swept id reached the log');
  }
});

/* ── the guard on the scheduled sweep ──────────────────────────────────────
   The hazard this endpoint carries is larger than the others': it deletes, in
   bulk, from site-wide stores, and a non-production deploy shares those stores
   with production. Netlify will not TRIGGER it off production, but it still
   SERVES it there, so anything that can reach the URL can run a delete pass.

   These assert the refusal, not the platform behaviour, which is not ours to
   test. */
test('the scheduled sweep refuses a caller that is not the scheduler', async () => {
  reset();
  const { id } = await publish();
  const expiry = stores.get('expiry');
  const stale = `${String(Date.now() - 60_000).padStart(16, '0')}:${id}`;
  expiry.data.set(stale, '1');

  for (const [what, req] of [
    ['a bare GET', new Request('https://x/api/sweep')],
    ['an empty POST', new Request('https://x/api/sweep', { method: 'POST' })],
    ['a POST with a body but no next_run',
     jsonReq('/api/sweep', { please: 'sweep' })],
  ]) {
    const res = await sweepFn(req);
    assert.equal(res.status, 403, `${what} was allowed to run a delete pass`);
    assert.equal((await body(res)).code, 'E_NOT_SCHEDULED', `${what} refused with the wrong code`);
  }

  /* And it did not sweep on the way to refusing, which is the assertion that
     matters: a guard that returns 403 after doing the work is not a guard. */
  assert.equal(expiry.data.has(stale), true, 'a refused call still ran the sweep');
});

test('the scheduled sweep refuses a non-production deploy, even when the caller is the scheduler', async () => {
  /* The case guard two cannot reach. Netlify will not TRIGGER the schedule off
     production, but it serves the endpoint there, and the dashboard's `Run now`
     button is documented as working on previews and "especially useful" there.
     That is a real scheduler-shaped POST arriving at a preview, so it carries
     `next_run` and passes the shape check. Only the deploy context separates it
     from the real thing. */
  reset();
  const { id } = await publish();
  const expiry = stores.get('expiry');
  const stale = `${String(Date.now() - 60_000).padStart(16, '0')}:${id}`;
  expiry.data.set(stale, '1');

  for (const ctx of ['deploy-preview', 'branch-deploy']) {
    const res = await sweepFn(scheduledReq(), { deploy: { context: ctx } });
    assert.equal(res.status, 403, `a ${ctx} was allowed to run a delete pass`);
    assert.equal((await body(res)).code, 'E_NOT_PRODUCTION',
      `a ${ctx} refused with the wrong code`);
  }

  assert.equal(expiry.data.has(stale), true, 'a refused deploy still ran the sweep');
});

test('an unrecognised deploy context is refused, not admitted', async () => {
  /* The guard matches the one value that must be allowed rather than listing
     the bad ones, so a context nobody anticipated is refused. This asserts that
     direction, because the natural way to write this guard is a list of known
     previews, and that version admits anything new by default.

     'dev' and 'dev-server' are real: the CLI's SUPPORTED_CONTEXTS at
     dist/utils/env/index.js:7 carries six values, not the three an earlier
     version of the comment in sweep.mjs claimed. */
  reset();
  const { id } = await publish();
  const expiry = stores.get('expiry');
  const stale = `${String(Date.now() - 60_000).padStart(16, '0')}:${id}`;
  expiry.data.set(stale, '1');

  for (const ctx of ['dev', 'dev-server', 'something-netlify-adds-in-2027']) {
    const res = await sweepFn(scheduledReq(), { deploy: { context: ctx } });
    assert.equal(res.status, 403, `context '${ctx}' was allowed to run a delete pass`);
  }

  assert.equal(expiry.data.has(stale), true, 'a refused context still ran the sweep');
});

test('the sweep still runs on production, and on an absent deploy context', async () => {
  /* The direction that must not regress. Absent means production: it is what a
     local run and this suite see, and reading absence as "preview" would turn a
     maintenance job into one that silently stops running. Both are asserted
     because a guard written the other way round would pass the test above. */
  reset();
  const { id } = await publish();
  const expiry = stores.get('expiry');

  for (const [what, ctx] of [
    ['an explicit production context', { deploy: { context: 'production' } }],
    ['no context object at all', undefined],
    ['a context with no deploy field', {}],
    /* THE EMPTY STRING IS THE REAL CASE, and it was nearly untested. The other
       three above are shapes this suite invents. The runtime maps an ABSENT
       `x-nf-deploy-context` header to `''`, not to undefined, so `''` is what a
       real invocation without the header actually carries. The guard reads
       truthily rather than comparing to undefined, which handles it, but that
       was luck until this line existed: a guard written as
       `context.deploy.context !== undefined && ... !== 'production'` passes the
       other three cases and refuses every real sweep. */
    ['an empty-string context, which is how the runtime spells absent',
     { deploy: { context: '' } }],
  ]) {
    const stale = `${String(Date.now() - 60_000).padStart(16, '0')}:${id}-${what}`;
    expiry.data.set(stale, '1');

    const res = await sweepFn(scheduledReq(), ctx);
    assert.equal(res.status, 200, `${what} was refused`);
    assert.equal((await body(res)).ok, true, `${what} did not sweep`);
    assert.equal(expiry.data.has(stale), false, `${what} left the stale key behind`);
  }
});

/* ── ROW-155: scope teardown, driven through the real scheduled handler ─────
   tools/run-tests.mjs proves sweepScopes() itself works. This proves
   sweep.mjs actually calls it and folds its counts into the one response a
   real scheduled run produces, the same wiring gap the ROW-37 tests above
   this section exist to cover for `deploy` threading.

   sweep.mjs calls `sweepScopes(deploy)` with no `now` override, so these
   age the scope through the registry itself (the truth record and the
   index entry, see `seenKey` in _store.mjs) rather than through a seam the
   handler does not have. */
const ageScope = async (scope, lastSeen) => {
  const registry = stores.get('scopes');
  const truth = await registry.get(store.scopeKey(scope), { type: 'json' });
  assert.ok(truth, `${scope} was never registered`);
  await registry.delete(store.seenKey(truth.lastSeen, scope));
  const aged = { ...truth, lastSeen };
  await registry.setJSON(store.scopeKey(scope), aged);
  await registry.setJSON(store.seenKey(lastSeen, scope), aged);
};

/* SHIPPED MODE IS DRY-RUN (sweep.mjs, SCOPE_SWEEP_DRY_RUN = true), Raffael's
   condition on approving preview deletion. So what the real scheduled
   handler must do with an abandoned preview today is: delete nothing, and
   report it on the list with enough to recognise a scoping error. The three
   tests below key off the exported constant: the two dry-run tests run
   while it is true, the teardown test runs once it is false, so the flip to
   live is the one-line change in sweep.mjs and nothing here. A skipped
   test is printed as skipped, not as passed. */
/* THE PIN. The three keyed tests follow the constant, so nothing below
   would notice the constant changing. This one does. Raffael's condition
   is that nothing deletes preview data until he has read the list and said
   yes to the flip, and that promise must not rest on one boolean that a
   merge, a rebase or an edit made for another reason can move with the
   suite green. The flip commit changes this line and the constant together,
   which puts the mode change in the diff twice where a reviewer cannot
   miss it. */
test('the shipped scope pass is in dry-run mode until Raffael says otherwise', () => {
  assert.equal(SCOPE_SWEEP_DRY_RUN, true,
    'SCOPE_SWEEP_DRY_RUN is not true: the scheduled sweep would delete preview data. If that is the flip Raffael approved, change this assertion in the same commit.');
});

const whileDryRun = { skip: SCOPE_SWEEP_DRY_RUN ? false : 'SCOPE_SWEEP_DRY_RUN is false' };
const onceLive = { skip: SCOPE_SWEEP_DRY_RUN ? 'SCOPE_SWEEP_DRY_RUN is true' : false };

test('the scheduled sweep tears down an abandoned preview scope, in the same run (live mode)', onceLive, async () => {
  reset();
  const preview = { context: 'deploy-preview', id: 'pr-880' };
  const scope = 'dp-pr-880-';
  const uploadCtx = { deploy: preview };
  const res = await upload(uploadReq(distinct(), {}, freshIp()), uploadCtx);
  const { id } = await body(res);
  assert.equal(stores.get(`${scope}passports`).data.has(id), true,
    'the preview publish this test depends on did not land where expected');
  await new Promise(r => setTimeout(r, 0)); // the registration is fire-and-forget
  await ageScope(scope, Date.now() - 8 * 86400e3);

  const sweepRes = await sweepFn(scheduledReq());
  const j = await body(sweepRes);
  assert.equal(sweepRes.status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.dryRun, undefined, 'a live scope pass reported itself as a dry run');
  assert.equal(j.wouldTearDown, undefined, 'a live scope pass carried a dry-run list');
  assert.equal(j.scopesTornDown, 1, 'the scheduled sweep response did not report the scope teardown');
  assert.equal(stores.get(`${scope}passports`).data.has(id), false,
    'the abandoned preview\'s passport survived a production sweep');
  assert.equal((await stores.get('scopes').list()).blobs.length, 0,
    'the torn-down scope was left in the registry after a real scheduled run');
  assert.equal(stores.has('sweep-dryrun'), false, 'a live run touched the dry-run cursor store');
});

test('the scheduled sweep lists an abandoned preview scope in the dry-run and deletes nothing', whileDryRun, async () => {
  reset();
  const preview = { context: 'deploy-preview', id: 'pr-880' };
  const scope = 'dp-pr-880-';
  const uploadCtx = { deploy: preview };
  const res = await upload(uploadReq(distinct(), {}, freshIp()), uploadCtx);
  const { id } = await body(res);
  assert.equal(stores.get(`${scope}passports`).data.has(id), true,
    'the preview publish this test depends on did not land where expected');
  await new Promise(r => setTimeout(r, 0)); // the registration is fire-and-forget
  await ageScope(scope, Date.now() - 8 * 86400e3);
  const registryBefore = (await stores.get('scopes').list()).blobs.map(b => b.key).sort();

  const sweepRes = await sweepFn(scheduledReq());
  const j = await body(sweepRes);
  assert.equal(sweepRes.status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.dryRun, true, 'the shipped scope pass is not in dry-run mode');
  assert.equal(j.scopesTornDown, 0);
  assert.equal(j.scopingErrors, 0);
  assert.equal(j.wouldTearDown.length, 1, 'the dry-run did not list the abandoned scope');
  const entry = j.wouldTearDown[0];
  assert.equal(entry.scope, scope);
  assert.equal(entry.context, 'deploy-preview');
  assert.equal(entry.id, 'pr-880');
  assert.equal(entry.idleDays, 8);
  assert.ok(entry.keys.passports >= 1 && entry.total >= 2, `the entry does not show what the scope holds: ${JSON.stringify(entry)}`);
  assert.equal(stores.get(`${scope}passports`).data.has(id), true,
    'the dry-run deleted a preview passport');
  assert.deepEqual((await stores.get('scopes').list()).blobs.map(b => b.key).sort(), registryBefore,
    'the dry-run wrote to the registry');
});

/* ── ROW-226: SCOPED_STORE_NAMES must not silently drift from the stores
   `strong()` actually opens ────────────────────────────────
   Two failures were reproduced together on 2026-09-08: the array named nine
   stores while `strong()` opened fifteen, and a scope torn down by
   sweepScopes() left the other six behind — data with no registry entry
   pointing at it any more, permanently, under the scope's own prefix, not
   because anything reads it there but because nothing ever deletes it
   either. Two tests, because neither alone would have caught this: the
   first proves teardown is complete against data six real features write;
   the second proves the array stays honest against the actual call sites
   the next feature adds, so a seventh store added carelessly fails a test
   instead of leaking quietly for as long as this one did. */

test('the scheduled sweep tears down every store a real preview writes, not just the nine it used to know about', onceLive, async () => {
  reset();
  const preview = { context: 'deploy-preview', id: 'pr-9001' };
  const scope = 'dp-pr-9001-';
  const uploadCtx = { deploy: preview };

  /* passports, views, expiry, fingerprints, ratelimit, metrics, attempts,
     acks: covered by the sibling test above through a real upload. What is
     new here is the six the fix adds: gallery, gallery-categories, votes,
     votes-count, copies, sweep-dryrun. Seeded directly, the way the
     critic's original reproduction did, rather than through five more
     endpoint calls: what this test proves is that sweepScopes() clears
     every name SCOPED_STORE_NAMES lists, not that five other handlers write
     under a scope prefix, which is exercised elsewhere for each of them. */
  for (const name of ['gallery', 'gallery-categories', 'votes', 'votes-count', 'copies', 'sweep-dryrun']) {
    stores.set(scope + name, new FakeStore(scope + name));
    await stores.get(scope + name).setJSON('leftover', { seeded: true });
  }
  /* And one store the sibling test already covers, so this test also fails
     on its own if the fix regresses, rather than only in combination. */
  const res = await upload(uploadReq(distinct(), {}, freshIp()), uploadCtx);
  const { id } = await body(res);
  assert.equal(stores.get(`${scope}passports`).data.has(id), true,
    'the preview publish this test depends on did not land where expected');
  await new Promise(r => setTimeout(r, 0));   // the registration is fire-and-forget
  await ageScope(scope, Date.now() - 8 * 86400e3);

  await sweepFn(scheduledReq());

  const leftBehind = [...stores.entries()]
    .filter(([name, s]) => name.startsWith(scope) && s.data.size > 0)
    .map(([name]) => name);
  assert.deepEqual(leftBehind, [],
    'the scheduled sweep tore down the scope and left data behind: ' + leftBehind.join(', '));
});

test('SCOPED_STORE_NAMES names every store strong() actually opens', async () => {
  /* ROW-226, read across every lib/_store*.mjs. This test read only
     lib/_store.mjs, which was true to its comment on 2026-09-08 ("only
     lib/_store.mjs calls strong() at all") and false from the split on
     2026-10-01: the file became a barrel with no call sites, the scan found
     0 stores, and the test passed with nothing to compare. The scan now
     lives in tools/store-call-sites.mjs, shared with check-store-split.mjs
     so the two cannot drift apart again; the shapes it reads, the critic's
     counterexamples that shaped them, and the one it still cannot see are in
     that file's header. check-store-split.mjs check 5 refuses a literal
     import specifier naming a _store-*.mjs module in the .mjs files in
     netlify/functions/, tools/ and the rest of lib/ (a computed specifier,
     '_' + 'store-core.mjs', gets past it), so those that import plainly reach
     the family only through the barrel,
     which exports neither strong() nor factory (check 1). It does not stop a
     file importing getStore from @netlify/blobs itself, and three non-test
     files do, outside what this test reads: netlify/edge-functions/count.ts
     (the site-wide pulse stores; check 5 does not scan edge-functions/),
     tools/metrics.mjs and tools/review-holds.mjs. See the comment on
     SCOPED_STORE_NAMES for what these two tests do and do not prove. */
  const { files, found, unresolved } = storeCallSites(new URL('../lib/', import.meta.url));
  assert.ok(found.size > 0,
    `the scan read ${files.length} file(s) and found no store at all, so it is reading the wrong files: ` + files.join(', '));

  assert.deepEqual(unresolved, [],
    'a call site names its store in a shape this test cannot resolve: ' + unresolved.join('; '));

  const missing = [...found.keys()].filter(name => !store.SCOPED_STORE_NAMES.includes(name));
  assert.deepEqual(missing, [],
    'a store the _store-*.mjs family opens is missing from SCOPED_STORE_NAMES, so a scope teardown would leave it behind: ' +
    missing.map(n => `${n} (${[...found.get(n)].join(', ')})`).join(', '));
});

/* One line an hour for a week is not a list. The per-entry block prints
   only when the set of scopes changes; the counts line always carries the
   set's fingerprint. Proven through the real handler by capturing
   console.log. */
test('the dry-run block prints when the set of scopes changes and stays quiet when it does not', whileDryRun, async () => {
  reset();
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => { lines.push(a.map(String).join(' ')); };
  try {
    const blocks = () => lines.filter(l => l.startsWith('sweep scopes dry-run')).length;
    const counts = () => lines.filter(l => l.startsWith('sweep:')).map(l => JSON.parse(l.slice('sweep:'.length)));

    await sweepFn(scheduledReq());                       // nothing abandoned yet: first run, set is empty
    assert.equal(blocks(), 1, 'the first run should print the block even for an empty set');
    await sweepFn(scheduledReq());
    assert.equal(blocks(), 1, 'an unchanged empty set printed the block again');

    const preview = { context: 'deploy-preview', id: 'pr-882' };
    await upload(uploadReq(distinct(), {}, freshIp()), { deploy: preview });
    await new Promise(r => setTimeout(r, 0));
    await ageScope('dp-pr-882-', Date.now() - 9 * 86400e3);
    await sweepFn(scheduledReq());
    assert.equal(blocks(), 2, 'a new abandoned scope did not print the block');
    await sweepFn(scheduledReq());
    await sweepFn(scheduledReq());
    assert.equal(blocks(), 2, 'an unchanged set printed the block again');

    const c = counts();
    assert.equal(c.length, 5);
    assert.deepEqual(c.map(x => x.dryRunSetChanged), [true, false, true, false, false]);
    assert.equal(c[0].dryRunSet, c[1].dryRunSet);
    assert.notEqual(c[1].dryRunSet, c[2].dryRunSet, 'the fingerprint did not move when the set did');
    assert.equal(c[2].dryRunSet, c[4].dryRunSet);
    const block = JSON.parse(lines.filter(l => l.startsWith('sweep scopes dry-run'))[1].split(': ').slice(1).join(': '));
    assert.equal(block.count, 1);
    assert.equal(block.partial, false, 'a complete list was marked partial');
    assert.equal(block.scopes[0].scope, 'dp-pr-882-');
    assert.equal(block.set, c[2].dryRunSet);
  } finally {
    console.log = realLog;
  }
});

/* And the asymmetry that matters most: a preview still being used must
   survive a production sweep untouched, driven through the same real
   handler rather than asserted only at the sweepScopes() unit level. */
test('the scheduled sweep leaves an active preview scope alone', async () => {
  reset();
  const preview = { context: 'deploy-preview', id: 'pr-881' };
  const scope = 'dp-pr-881-';
  const uploadCtx = { deploy: preview };
  const res = await upload(uploadReq(distinct(), {}, freshIp()), uploadCtx);
  const { id } = await body(res);
  await new Promise(r => setTimeout(r, 0));

  const sweepRes = await sweepFn(scheduledReq());
  const j = await body(sweepRes);
  assert.equal(j.scopesTornDown, 0, 'a scope with no chance to go stale was torn down anyway');
  assert.equal(stores.get(`${scope}passports`).data.has(id), true,
    'an active preview\'s passport was deleted by a production sweep');
  assert.equal((await stores.get('scopes').list()).blobs.length, 2,
    'an active preview\'s registry entries were removed by a production sweep');
});

test('delete needs the token, and takes everything with it', async () => {
  reset();
  const { id, delete_token } = await publish();
  await page(id);

  assert.equal((await remove(jsonReq('/api/delete', { id, token: 'f'.repeat(40) }))).status, 404);
  assert.equal((await page(id)).status, 200, 'a wrong token deleted the passport');

  const ok = await remove(jsonReq('/api/delete', { id, token: delete_token }));
  assert.equal((await body(ok)).ok, true);
  assert.equal((await page(id)).status, 404);
  assert.equal(stores.get('views').data.has(id), false);
  assert.equal(stores.get('fingerprints').data.size, 0, 'the duplicate guard outlived the passport');
});

/* ══ store failures that look like user errors ════════════════
   Audit, 2026-10-22. The answers stay what they were, a 404 for a passport
   the store could not read and a 429 for a limiter that could not count; what
   is new is a code-only line saying it was the store. Neither line may carry
   the id from the URL or the caller's address. */
test('a passport the store cannot read is still the not-found page, and the log says it was the store', async () => {
  reset();
  const { id } = await publish();
  const passports = stores.get('passports');
  passports.get = async () => { throw new Error('simulated blob outage'); };
  const { value: res, ops, lines } = await captureLogs(() => page(id));
  delete passports.get;
  assert.equal(res.status, 404);
  assert.deepEqual(ops, [{ code: 'PASSPORT_READ_FAILED', stage: 'row' }]);
  assert.equal(lines.some(l => l.includes(id)), false, 'the passport id reached the log');
});

test('a limiter that cannot write still answers 429, and the log names the bucket and not the address', async () => {
  reset();
  const { id, delete_token } = await publish();
  const rl = stores.get('ratelimit');
  rl.set = async () => { throw new Error('simulated blob outage'); };
  const ip = '198.51.100.251';
  const { value: res, ops, lines } = await captureLogs(() =>
    send(jsonReq('/api/send', { id, token: delete_token, to: 'them@example.com' }, ip)));
  delete rl.set;
  assert.equal(res.status, 429);
  assert.equal((await body(res)).code, 'E_SEND_LIMIT');
  assert.deepEqual(ops, [{ code: 'RATELIMIT_STORE_WRITE_FAILED', bucket: 'send-h' }]);
  for (const secret of [ip, store.ipKey(ip), id, delete_token, 'them@example.com']) {
    assert.equal(lines.some(l => l.includes(secret)), false, `the log carries ${secret}`);
  }
});

/* ══ send ═════════════════════════════════════════════════ */

test('sending needs the delete token', async () => {
  reset();
  const { id } = await publish();
  const res = await send(jsonReq('/api/send', { id, token: 'f'.repeat(40), to: 'them@example.com' }));
  assert.equal(res.status, 404);
  assert.equal(outbox.length, 0);
});

test('the subject line carries nothing the sender wrote, in either message', async () => {
  reset();
  const phish = distinct().replace(/^title: .*$/m,
    'title: URGENT ACTION REQUIRED: your Microsoft 365 mailbox will be suspended');
  const { id, delete_token } = await publish(phish);

  const res = await send(jsonReq('/api/send', {
    id, token: delete_token,
    to: 'victim@example.com',
    from_name: 'Microsoft 365 Security Team',
    copy_to: 'victim2@example.com'
  }));
  assert.equal((await body(res)).ok, true);
  assert.equal(outbox.length, 2);

  for (const message of outbox) {
    assert.equal(/URGENT|Microsoft/i.test(message.subject), false,
      'sender text in a subject line: ' + message.subject);
  }
});

/* ══ links that leave the building name the canonical site ═══════════════
   ROW-63. These assert the invariant rather than trusting the comment that
   argues for it, which is the lesson ROW-50 cost: there, a critic deleted the
   thing the comment defended and the whole suite stayed green, because every
   caller happened to pass a string identical to the constant. Here the stakes
   are higher, because the value ships inside an email carrying a delete token.

   Every request in this file already arrives from ORIGIN, `https://app.phaeacia.test`,
   which is NOT the canonical host. So reverting either handler to
   `new URL(req.url).origin` fails these on the ordinary path, not only on a
   hostile one. That is deliberate: the realistic case is not an attacker, it is
   a deploy-preview hostname, which differs from canonical in exactly the way
   ORIGIN does. */

const CANON = 'https://app.phaeacia.ai';

const hostile = (path, obj) =>
  new Request('https://deploy-preview-42--agent-passport.netlify.app' + path, {
    method: 'POST',
    headers: { 'x-nf-client-connection-ip': freshIp(), 'content-type': 'application/json' },
    body: JSON.stringify(obj)
  });

test('every link in either message points at the canonical site', async () => {
  /* The general form of the two tests below, and the one that catches the case
     they cannot: a link that is not the passport link. A logo src, a footer
     href, an unsubscribe URL, anything added later — each would be the same
     defect wearing different clothes, and asserting only `url` would not see
     it. So this asserts over EVERY href and src in both messages rather than
     over the values this fix happened to touch.

     Checked by rendering rather than by reading the template: _email.mjs builds
     its links from four different places. */
  reset();
  const { id, delete_token } = await publish();
  await send(hostile('/api/send', {
    id, token: delete_token, to: 'them@example.com', copy_to: 'me@example.com'
  }));
  assert.equal(outbox.length, 2);

  for (const m of outbox) {
    /* HTML: every href and src. */
    const inHtml = [...String(m.html).matchAll(/(?:href|src)="([^"]+)"/g)].map(x => x[1]);
    assert.ok(inHtml.length > 0, 'a message carried no links at all, which is not this template');

    /* PLAIN TEXT: every URL-shaped token, and this half was missing.
       A critic put a second link into the text body pointing at
       deploy-preview-42--x.example.com — a wrong host deliberately containing
       no "netlify.app" — and the whole suite stayed green, because the text
       alternative was only ever checked for that one vendor substring.

       Plain text is not the lesser half. It is what a recipient on a text
       client reads, and the sender's copy carries the delete token in it. A
       substring check against one hostname convention is not a guard; it is a
       guard against the example I happened to think of. */
    const inText = String(m.text).match(/https?:\/\/[^\s<>()"']+/g) || [];
    assert.ok(inText.length > 0, 'a message text carried no links, which is not this template');

    /* There used to be one deliberate exception here, a third-party feedback
       form in the sender's copy. It is gone from the open-source tree, so there
       is no exception left: anything off the canonical site fails. */
    for (const link of [...inHtml, ...inText]) {
      if (link.startsWith('mailto:') || link.startsWith('#')) continue;
      assert.ok(link.startsWith(CANON + '/'),
        `a message links to ${link}, which is not the canonical site`);
    }
    assert.equal(/undefined/.test(String(m.html) + String(m.text)), false,
      'a message carried the string "undefined", so an interpolation is missing');
  }
});

test('the emailed link names the canonical site, not the host that asked', async () => {
  reset();
  const { id, delete_token } = await publish();

  await send(hostile('/api/send', { id, token: delete_token, to: 'them@example.com' }));
  assert.equal(outbox.length, 1);
  const m = outbox[0];

  for (const [what, text] of [['html', m.html], ['text', m.text]]) {
    assert.ok(text.includes(`${CANON}/p/${id}`),
      `the ${what} body does not carry the canonical link`);
    assert.equal(/netlify\.app/.test(text), false,
      `the ${what} body carries the requesting hostname`);
  }
});

test('the delete token is mailed to the canonical site or not at all', async () => {
  /* The sender's copy carries the manage URL with the token in the fragment.
     Mailed to a preview hostname, that is a token pointing at a host which
     stops existing when the deploy is cleaned up: a passport whose owner
     cannot revoke it. */
  reset();
  const { id, delete_token } = await publish();

  await send(hostile('/api/send', {
    id, token: delete_token, to: 'them@example.com', copy_to: 'me@example.com'
  }));
  assert.equal(outbox.length, 2);

  const copy = outbox.find(m => (m.text || '').includes('/manage#'));
  assert.ok(copy, 'no sender copy carried a manage link');
  assert.ok(copy.text.includes(`${CANON}/manage#${id}:${delete_token}`),
    'the manage link is not canonical');
  assert.equal(/netlify\.app/.test(copy.text + copy.html), false,
    'the sender copy carries the requesting hostname');
});

test('the publish response hands back canonical links', async () => {
  /* Lower stakes than the email, since this returns to the browser that set the
     Host, and the same fix: the publisher pastes `url` to someone else and
     stores `manage_url`, so both outlive the tab they were made in. */
  reset();
  const j = await body(await upload(new Request(
    'https://deploy-preview-42--agent-passport.netlify.app/api/upload', {
      method: 'POST',
      headers: { 'x-nf-client-connection-ip': freshIp(), 'content-type': 'text/markdown' },
      body: distinct()
    })));

  assert.equal(j.ok, true, 'publish failed: ' + JSON.stringify(j));
  assert.equal(j.url, `${CANON}/p/${j.id}`, 'the published link is not canonical');
  assert.ok(j.manage_url.startsWith(`${CANON}/manage#`), 'the manage link is not canonical');
  assert.equal(/netlify\.app/.test(j.url + j.manage_url), false,
    'the response carries the requesting hostname');
});

test('a title that is a link does not travel at all', async () => {
  reset();
  const lure = distinct().replace(/^title: .*$/m,
    'title: Mailbox full. Restore now at https://evil.example/o365');
  const { id, delete_token } = await publish(lure);

  await send(jsonReq('/api/send', { id, token: delete_token, to: 'them@example.com' }));
  assert.equal(outbox.length, 1);
  const m = outbox[0];
  for (const text of [m.subject, m.html, m.text]) {
    assert.equal(/evil\.example/.test(text), false, 'a link in the title reached the message');
  }
  assert.ok(m.text.includes('An agent, named on the page'));
});

test('a typo in the copy field costs the passport nothing', async () => {
  reset();
  const { id, delete_token } = await publish();

  for (let i = 0; i < 6; i++) {
    const res = await send(jsonReq('/api/send', {
      id, token: delete_token, to: 'them@example.com', copy_to: 'not-an-address'
    }));
    assert.equal(res.status, 422);
  }
  assert.equal(outbox.length, 0, 'a refused request put mail on the wire');

  const good = await send(jsonReq('/api/send', { id, token: delete_token, to: 'them@example.com' }));
  assert.equal((await body(good)).ok, true, 'six typos burned the daily send budget');
  assert.equal(outbox.length, 1);
});

test('a passport can be emailed five times a day and no more', async () => {
  reset();
  const { id, delete_token } = await publish();
  const codes = [];
  for (let i = 0; i < 6; i++) {
    const res = await send(jsonReq('/api/send', { id, token: delete_token, to: `a${i}@example.com` }));
    codes.push(res.status === 200 ? 200 : (await body(res)).code);
  }
  assert.deepEqual(codes.slice(0, 5), [200, 200, 200, 200, 200]);
  assert.equal(codes[5], 'E_SEND_PASSPORT_LIMIT',
    'the wrong ceiling reported itself: ' + codes[5]);
  assert.equal(outbox.length, 5);
});

test('sending is off, and says so, without a key', async () => {
  reset();
  const key = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    const probe = await body(await send(new Request(ORIGIN + '/api/send')));
    assert.equal(probe.enabled, false);

    const res = await send(jsonReq('/api/send', { id: 'x', token: 'y', to: 'a@b.co' }));
    assert.equal(res.status, 503);
    assert.equal((await body(res)).code, 'E_SEND_DISABLED');
    assert.equal(outbox.length, 0);
  } finally {
    process.env.RESEND_API_KEY = key;
  }
});

test('the recipient address is nowhere in any store afterwards', async () => {
  reset();
  const { id, delete_token } = await publish();
  await send(jsonReq('/api/send', {
    id, token: delete_token, to: 'private@example.com', copy_to: 'mine@example.com'
  }));
  assert.equal(outbox.length, 2);

  for (const s of stores.values()) {
    for (const [key, value] of s.data) {
      for (const address of ['private@example.com', 'mine@example.com']) {
        assert.equal(String(key).includes(address), false, `${address} is a key in ${s.name}`);
        assert.equal(String(value).includes(address), false, `${address} is stored in ${s.name}`);
      }
    }
  }
});

/* ══ the ceilings that protect people other than the sender ══
   Per recipient, across every sender and network, and for the whole site per
   UTC day, because the mail account is shared and capped. Each message is
   charged before the provider call and given back only when the provider
   answers with a 4xx, a refusal. */

const { SEND_PER_RECIPIENT_PER_DAY, SEND_SITE_PER_DAY } =
  await import('../netlify/functions/send.mjs');

/* The send-r and send-g keys in the limiter's store. A key is
   `${windowMs}:${bucket}:${kind}:${ipKey}:${uuid}`. */
const ceilingKeys = (kind, subject) =>
  [...(stores.get('ratelimit')?.data.keys() || [])].filter(k => {
    const [, , kd, who] = k.split(':');
    return kd === kind && (subject === undefined || who === store.ipKey(subject));
  });

const sendTo = async (to, extra = {}, p = null) => {
  const { id, delete_token } = p || await publish();
  return send(jsonReq('/api/send', { id, token: delete_token, to, ...extra }));
};

test('the recipient and site-wide ceilings are the numbers Raffael set on 2026-09-30', () => {
  assert.equal(SEND_PER_RECIPIENT_PER_DAY, 5, 'the per-recipient ceiling moved without a decision');
  assert.equal(SEND_SITE_PER_DAY, 50, 'the site-wide ceiling moved without a decision');
});

/* The tests below count in these two, so a ruling that moves them moves only
   the pin above. */
const PER_MAILBOX = SEND_PER_RECIPIENT_PER_DAY;

test('one mailbox is sent five messages a day from here, whoever sends them', async () => {
  reset();
  /* A passport and a network per message, and every spelling of one address. */
  const spellings = ['someone@example.com', 'Someone@Example.com', ' SOMEONE@example.COM ',
                     'SOMEONE@EXAMPLE.COM', '  someone@Example.com'];
  assert.equal(spellings.length, PER_MAILBOX);
  for (const to of spellings) {
    const res = await sendTo(to);
    assert.equal(res.status, 200, `${to} was refused: ` + JSON.stringify(await body(res)));
  }
  const res = await sendTo('someone@example.com');
  assert.equal(res.status, 429, 'a message past the ceiling to one mailbox was accepted');
  const j = await body(res);
  assert.equal(j.code, 'E_SEND_DAILY_LIMIT', 'the wrong ceiling reported itself: ' + j.code);
  assert.equal(/recipient|per address|fifty|50|five|\b5\b/i.test(j.message), false,
    'the refusal says which ceiling fired: ' + j.message);
  assert.equal(outbox.length, PER_MAILBOX, 'a message past the ceiling went on the wire');

  assert.equal((await sendTo('someone.else@example.com')).status, 200,
    'the ceiling on one mailbox stopped mail to another');
});

test('a mailbox at its ceiling costs the sending passport nothing', async () => {
  reset();
  for (let i = 0; i < PER_MAILBOX; i++) await sendTo('full@example.com');
  const p = await publish();
  /* Five refusals: enough to spend the passport's whole day if they were
     charged to it. */
  for (let i = 0; i < 5; i++) {
    assert.equal((await sendTo('full@example.com', {}, p)).status, 429, 'a full mailbox took another message');
  }
  for (let i = 0; i < 5; i++) {
    const res = await sendTo(`r${i}@example.com`, {}, p);
    assert.equal(res.status, 200, 'a refusal at a full mailbox spent the passport budget: ' +
      JSON.stringify(await body(res)));
  }
  assert.equal((await body(await sendTo('r9@example.com', {}, p))).code, 'E_SEND_PASSPORT_LIMIT',
    'the passport ceiling stopped counting');
});

test('refusals at a full mailbox never touch the site-wide count', async () => {
  reset();
  for (let i = 0; i < PER_MAILBOX; i++) await sendTo('hammered@example.com');
  const rl = stores.get('ratelimit');
  const real = rl.set.bind(rl);
  const written = [];
  rl.set = async (key, value, opts) => { written.push(key); return real(key, value, opts); };
  try {
    for (let i = 0; i < 5; i++) {
      assert.equal((await sendTo('hammered@example.com')).status, 429, 'a full mailbox took another message');
    }
  } finally {
    rl.set = real;
  }
  assert.equal(written.filter(k => k.split(':')[2] === 'send-g').length, 0,
    'a message refused for its recipient was charged to the site-wide ceiling first');
  assert.equal(ceilingKeys('send-g').length, PER_MAILBOX, 'the site-wide count is not the messages sent');
});

test('a sender copy pays the recipient ceiling too, and a full one fails only the copy', async () => {
  reset();
  for (let i = 0; i < PER_MAILBOX; i++) {
    const j = await body(await sendTo(`friend${i}@example.com`, { copy_to: 'me@example.com' }));
    assert.equal(j.copy, 'sent', `copy ${i + 1} of ${PER_MAILBOX} did not go out`);
  }
  outbox.length = 0;
  const res = await sendTo('friend9@example.com', { copy_to: 'me@example.com' });
  const j = await body(res);
  assert.equal(res.status, 200, 'a full copy address refused the whole request');
  assert.equal(j.copy, 'failed', 'a copy past the ceiling to one mailbox went out');
  assert.equal(outbox.length, 1, 'the recipient message and the copy did not come to one message');
  assert.deepEqual(outbox[0].to, ['friend9@example.com'], 'the message that went out was not the recipient\'s');

  /* The copies counted: the copy field is not a way round the ceiling. */
  assert.equal((await sendTo('me@example.com')).status, 429,
    'copies were not counted against the mailbox they went to');
});

test('the whole site sends fifty messages a UTC day and not one more', async () => {
  reset();
  let n = 0;
  while (n < SEND_SITE_PER_DAY) {
    const p = await publish();
    for (let i = 0; i < 5 && n < SEND_SITE_PER_DAY; i++, n++) {
      const res = await sendTo(`r${n}@example.com`, {}, p);
      assert.equal(res.status, 200, `message ${n + 1} was refused: ` + JSON.stringify(await body(res)));
    }
  }
  const res = await sendTo('one-more@example.com');
  assert.equal(res.status, 429, `message ${SEND_SITE_PER_DAY + 1} was accepted`);
  assert.equal((await body(res)).code, 'E_SEND_DAILY_LIMIT', 'the wrong ceiling reported itself');
  assert.equal(outbox.length, SEND_SITE_PER_DAY, 'the wire did not carry exactly the site ceiling');
  /* The refused message's recipient charge was given back, so a full site
     ceiling does not also spend strangers' inboxes. */
  assert.equal(ceilingKeys('send-r', store.mailboxKey('one-more@example.com')).length, 0,
    'the recipient of a refused message was charged');
});

test('a sender copy is a second message to the site-wide ceiling', async () => {
  reset();
  let n = 0;
  while (n < SEND_SITE_PER_DAY - 1) {
    const p = await publish();
    for (let i = 0; i < 5 && n < SEND_SITE_PER_DAY - 1; i++, n++) await sendTo(`r${n}@example.com`, {}, p);
  }
  outbox.length = 0;
  const res = await sendTo('last@example.com', { copy_to: 'copy@example.com' });
  const j = await body(res);
  assert.equal(res.status, 200, 'a full site ceiling refused the recipient message it had room for');
  assert.equal(j.copy, 'failed', 'a message past the site ceiling went out as a copy');
  assert.equal(outbox.length, 1, 'more than the site ceiling went on the wire');
  assert.equal(ceilingKeys('send-r', store.mailboxKey('copy@example.com')).length, 0,
    'the copy address was charged for a copy that was not sent');
});

test('a message the provider refuses is given back to both ceilings', async () => {
  reset();
  const p = await publish();
  nextStatus = 422;
  const res = await sendTo('bounced@example.com', {}, p);
  assert.equal(res.status, 502, 'a provider refusal was not reported as a failed send');
  assert.equal(ceilingKeys('send-r', store.mailboxKey('bounced@example.com')).length, 0,
    'a refused message still counts against its recipient');
  assert.equal(ceilingKeys('send-g').length, 0, 'a refused message still counts against the site');
  for (let i = 0; i < PER_MAILBOX; i++) {
    assert.equal((await sendTo('bounced@example.com')).status, 200, 'the refused message was counted after all');
  }
});

/* The status is the only thing that decides: every 4xx is a refusal and is
   given back, every 5xx is kept. The stub puts the message on the wire before
   it answers, so a kept 5xx is exactly the case where one did go out. */
test('only a 4xx gives a message back; a 5xx keeps its charge, because the provider may have taken it', async () => {
  for (const status of [400, 403, 422, 429, 499, 500, 502, 503, 504, 599]) {
    reset();
    const p = await publish();
    nextStatus = status;
    const res = await sendTo('edge@example.com', {}, p);
    assert.equal(res.status, 502, `a provider ${status} was not reported as a failed send`);
    const kept = status >= 500 ? 1 : 0;
    assert.equal(ceilingKeys('send-r', store.mailboxKey('edge@example.com')).length, kept,
      `a provider ${status} ${kept ? 'was given back to' : 'still counts against'} its recipient`);
    assert.equal(ceilingKeys('send-g').length, kept,
      `a provider ${status} ${kept ? 'was given back to' : 'still counts against'} the site`);
  }
});

test('a message answered with a 503 still counts against its mailbox for the rest of the day', async () => {
  reset();
  nextStatus = 503;
  assert.equal((await sendTo('accepted@example.com')).status, 502);
  assert.equal(outbox.length, 1, 'the stub did not put the 503 message on the wire');
  for (let i = 1; i < PER_MAILBOX; i++) {
    assert.equal((await sendTo('accepted@example.com')).status, 200, 'the mailbox was refused before its ceiling');
  }
  const res = await sendTo('accepted@example.com');
  assert.equal(res.status, 429, 'a message answered with a 503 was given back, so the mailbox got one too many');
  assert.equal(outbox.length, PER_MAILBOX);
});

test('a sender copy the provider refuses is given back; one answered with a 5xx is not', async () => {
  for (const [status, kept] of [[422, 0], [503, 1]]) {
    reset();
    const p = await publish();
    /* The recipient message goes, and the copy, the second mail call, gets the status. */
    const real = globalThis.fetch;
    let n = 0;
    globalThis.fetch = async (url, init) => {
      if (++n === 2) nextStatus = status;
      return real(url, init);
    };
    let j;
    try {
      j = await body(await sendTo('friend@example.com', { copy_to: 'me@example.com' }, p));
    } finally {
      globalThis.fetch = real;
    }
    assert.equal(n, 2, 'the request did not make two mail calls');
    assert.equal(j.copy, 'failed', `a copy answered with ${status} was reported as sent`);
    assert.equal(ceilingKeys('send-r', store.mailboxKey('friend@example.com')).length, 1,
      'the recipient message that went out lost its charge');
    assert.equal(ceilingKeys('send-r', store.mailboxKey('me@example.com')).length, kept,
      `a copy answered with ${status} ${kept ? 'was given back to' : 'still counts against'} the copy address`);
    assert.equal(ceilingKeys('send-g').length, 1 + kept,
      `a copy answered with ${status} ${kept ? 'was given back to' : 'still counts against'} the site`);
  }
});

test('a message lost to a network failure keeps its charge, because it may have gone out', async () => {
  reset();
  const p = await publish();
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('socket hang up'); };
  let res;
  try {
    res = await sendTo('lost@example.com', {}, p);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(res.status, 502, 'a network failure was not reported as a failed send');
  assert.equal(ceilingKeys('send-r', store.mailboxKey('lost@example.com')).length, 1,
    'a message that may have gone out was given back to its recipient');
  assert.equal(ceilingKeys('send-g').length, 1, 'a message that may have gone out was given back to the site');
  for (let i = 1; i < PER_MAILBOX; i++) {
    assert.equal((await sendTo('lost@example.com')).status, 200, 'the mailbox was refused before its ceiling');
  }
  assert.equal((await sendTo('lost@example.com')).status, 429,
    'the lost message was not counted, so a mailbox got one too many');
});

test('the recipient ceiling stores a hash of the address and never the address', async () => {
  reset();
  await sendTo('Private.Person@Example.com', { copy_to: 'Mine@Example.com' });
  assert.equal(outbox.length, 2, 'the message and its copy did not both go out');
  for (const s of stores.values()) {
    for (const [key, value] of s.data) {
      for (const a of ['private.person', 'mine@example']) {
        assert.equal(String(key).toLowerCase().includes(a), false, `${a} is in a key in ${s.name}`);
        assert.equal(String(value).toLowerCase().includes(a), false, `${a} is stored in ${s.name}`);
      }
    }
  }
  const expected = new Set(['private.person@example.com', 'mine@example.com']
    .map(a => store.ipKey(store.mailboxKey(a))));
  const seen = ceilingKeys('send-r').map(k => k.split(':')[3]);
  assert.equal(seen.length, 2, 'expected one per-recipient key for each of the two messages');
  for (const who of seen) assert.ok(expected.has(who), 'a send-r key is not a hashed recipient: ' + who);
});

/* ══ every per-network ceiling counts an IPv6 /64 as one caller ══
   The limiter keys an IPv6 caller by its /64 in one place, lib/_store.mjs's
   ipKey. These drive each handler that counts per network, from a new address
   in one /64 on every request, to prove the handler reaches that place. Bodies
   are empty on purpose: every one of these ceilings is charged before the body
   is read. */

let block = 0;
const freshBlock = () => `2001:db8:${(++block).toString(16)}:0`;

const PER_NETWORK = [
  ['send', () => send, '/api/send', 10],
  ['subscribe', () => subscribe, '/api/subscribe', 5],
  ['manage', () => manage, '/api/manage', 20],
  ['delete', () => remove, '/api/delete', 20],
  ['vote', () => vote, '/api/vote', 30],
  ['copied', () => copied, '/api/copied', 60],
  ['copied-prompt', () => copiedPrompt, '/api/copied-prompt', 60],
  ['check-hold', () => checkHoldFn, '/api/check-hold', 20],
  ['hold-email', () => holdEmailFn, '/api/hold-email', 20]
];

for (const [name, handler, path, limit] of PER_NETWORK) {
  test(`${name}: one IPv6 /64 gets ${limit} an hour, not ${limit} per address`, async () => {
    reset();
    const net = freshBlock();
    const call = ip => handler()(post(path, '{}', { 'content-type': 'application/json' }, ip));
    for (let i = 1; i <= limit; i++) {
      assert.notEqual((await call(`${net}:${i.toString(16)}::1`)).status, 429, `request ${i} was refused`);
    }
    assert.equal((await call(`${net}:ffff:ffff:ffff:ffff`)).status, 429,
      `a new address in the same /64 got a fresh ${name} budget`);
    assert.notEqual((await call(`${freshBlock()}::1`)).status, 429, 'the next /64 was refused');
  });
}

test('upload: one IPv6 /64 gets five publishes an hour, not five per address', async () => {
  reset();
  const net = freshBlock();
  for (let i = 1; i <= 5; i++) await publish(distinct(), `${net}:${i}::1`);
  const res = await upload(uploadReq(distinct(), {}, `${net}:ffff::1`));
  assert.equal(res.status, 429, 'a new address in the same /64 got a fresh upload budget');
  assert.equal((await body(res)).code, 'E_RATE_LIMIT');
});

test('upload: refusals fill one failure ceiling per /64, then the upload ceiling', async () => {
  /* 30 refusals move to bad-h, the next 5 stay on up-h, and the 36th request
     is refused before any work. Counted per address, 36 addresses would never
     reach it. */
  reset();
  const net = freshBlock();
  for (let i = 1; i <= 35; i++) {
    const res = await upload(uploadReq('too short', {}, `${net}:${i.toString(16)}::1`));
    assert.notEqual(res.status, 429, `refusal ${i} hit a ceiling early`);
  }
  const res = await upload(uploadReq('too short', {}, `${net}:ffff::1`));
  assert.equal(res.status, 429, 'refusals from new addresses in one /64 were never capped');
  assert.equal((await body(res)).code, 'E_RATE_LIMIT');
});

/* ══ subscribe ════════════════════════════════════════════
   The optional list box on the success screen. It is the first thing on this
   site that keeps a personal detail, so the tests are about the promises rather
   than about the happy path. */

test('subscribing needs the delete token, so it cannot be posted at from outside', async () => {
  reset();
  const { id } = await publish();
  const res = await subscribe(jsonReq('/api/subscribe',
    { id, token: 'f'.repeat(40), email: 'a@example.com', consent: true }));
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0, 'an address was sent to the provider without a valid token');
});

test('an unticked box is refused, because consent is the whole legal basis', async () => {
  reset();
  const { id, delete_token } = await publish();
  for (const consent of [undefined, false, 'true', 1]) {
    const res = await subscribe(jsonReq('/api/subscribe',
      { id, token: delete_token, email: 'a@example.com', consent }));
    assert.equal(res.status, 400, `consent ${JSON.stringify(consent)} was accepted`);
  }
  assert.equal(calls.length, 0, 'an address travelled without consent');
});

test('a good subscription reaches the segment, and nothing is stored here', async () => {
  reset();
  const { id, delete_token } = await publish();
  const before = [...stores.keys()];
  const res = await subscribe(jsonReq('/api/subscribe',
    { id, token: delete_token, email: 'someone@example.com', consent: true }));
  assert.equal(res.status, 200);
  assert.equal((await body(res)).ok, true);

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/segments\/seg_test\/contacts$/);
  assert.deepEqual(calls[0].body, { email: 'someone@example.com', unsubscribed: false });

  /* The address is at the provider and nowhere here. Every store is searched,
     because "we do not store it" is the sentence on the privacy page and a
     store nobody thought about is how that sentence stops being true. */
  for (const [name, store] of stores) {
    for (const [key, value] of store.data) {
      assert.ok(!key.includes('someone@example.com'), `address in a ${name} key`);
      assert.ok(!String(value).includes('someone@example.com'), `address in a ${name} value`);
    }
  }
  assert.deepEqual([...stores.keys()].filter(k => !before.includes(k) && k !== 'ratelimit'), [],
    'subscribing created a new store');
});

test('an address already on the list is a success, not an error', async () => {
  reset();
  const { id, delete_token } = await publish();
  nextStatus = 409;
  const res = await subscribe(jsonReq('/api/subscribe',
    { id, token: delete_token, email: 'again@example.com', consent: true }));
  assert.equal(res.status, 200, 'a second subscription reported failure to the person');
});

test('a malformed address never reaches the provider', async () => {
  reset();
  const { id, delete_token } = await publish();
  for (const email of ['not-an-address', '', 'a@b', 'two@addresses.com, other@x.com', null]) {
    const res = await subscribe(jsonReq('/api/subscribe', { id, token: delete_token, email, consent: true }));
    assert.equal(res.status, 422, `${JSON.stringify(email)} was accepted`);
  }
  assert.equal(calls.length, 0);
});

test('the box does not draw where it cannot work', async () => {
  reset();
  const segment = process.env.SUBSCRIBE_SEGMENT_ID;
  delete process.env.SUBSCRIBE_SEGMENT_ID;
  assert.equal((await body(await subscribe(new Request('https://x.test/api/subscribe')))).enabled, false);
  const { id, delete_token } = await publish();
  const res = await subscribe(jsonReq('/api/subscribe',
    { id, token: delete_token, email: 'a@example.com', consent: true }));
  assert.equal(res.status, 503, 'it accepted an address with no list configured');
  process.env.SUBSCRIBE_SEGMENT_ID = segment;
  assert.equal((await body(await subscribe(new Request('https://x.test/api/subscribe')))).enabled, true);
});

test('a provider failure says the passport is fine', async () => {
  reset();
  const { id, delete_token } = await publish();
  nextStatus = 500;
  const res = await subscribe(jsonReq('/api/subscribe',
    { id, token: delete_token, email: 'a@example.com', consent: true }));
  const j = await body(res);
  assert.equal(j.ok, false);
  assert.match(j.message, /published/,
    'a failed subscription must not read as a failed publish');
});

/* subscribe.mjs called the provider with no timeout, so a provider that never
   answered held the request until the platform killed it. The timeout is
   shortened here through AbortSignal.timeout itself, the way the reviewer-alert
   test above checks its 3 s, and the stub hangs until its signal aborts. With
   no signal the call would hang for good, which the race below turns into a
   failure instead of a cancelled run. */
test('a provider that never answers a subscription is given up on, and the person is told only this failed', async () => {
  reset();
  const { id, delete_token } = await publish();
  const { SUBSCRIBE_TIMEOUT_MS } = await import('../netlify/functions/subscribe.mjs');
  const realTimeout = AbortSignal.timeout, realFetch = globalThis.fetch, seen = [];
  let signals = 0;
  AbortSignal.timeout = ms => { seen.push(ms); return realTimeout.call(AbortSignal, 20); };
  globalThis.fetch = (_url, init) => new Promise((_, reject) => {
    if (!init || !init.signal) return;
    signals++;
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  let timer;
  try {
    const res = await Promise.race([
      subscribe(jsonReq('/api/subscribe', { id, token: delete_token, email: 'a@example.com', consent: true })),
      new Promise(r => { timer = setTimeout(() => r('hung'), 2000); })
    ]);
    assert.notEqual(res, 'hung', 'the subscription never gave up on a provider that never answered');
    assert.equal(res.status, 502);
    assert.equal((await body(res)).code, 'E_SUBSCRIBE_FAILED');
    assert.ok(seen.includes(SUBSCRIBE_TIMEOUT_MS), 'no subscribe timeout was armed: ' + JSON.stringify(seen));
    assert.equal(signals, 1, 'the provider call carried no abort signal');
  } finally {
    clearTimeout(timer);
    AbortSignal.timeout = realTimeout;
    globalThis.fetch = realFetch;
  }
});

/* ── the digest ───────────────────────────────────────────
   THE POINT OF THESE IS THAT IT DOES NOT SEND. Raffael agreed to the idea of a
   daily mail and has not seen one, so this function ships deployed, unscheduled
   and disabled. Each guard gets a test, because "it did not send" is the same
   observation whether the guard worked or the function is simply broken.

   The last one is the opposite check and it is the one that matters most: with
   every guard satisfied it MUST send, and the body must carry a number that
   could only have come from the rows in the store. A digest that mails a
   well-formatted zero looks identical to one that works. */

const scheduledDigest = () =>
  post('/api/digest', JSON.stringify({ next_run: new Date(Date.now() + 3600e3).toISOString() }),
       { 'content-type': 'application/json' });

const prodCtx = { deploy: { context: 'production' } };

test('the digest refuses on a deploy preview', async () => {
  reset();
  process.env.DIGEST_TO = 'raffael@example.test';
  const res = await digest(scheduledDigest(), { deploy: { context: 'deploy-preview' } });
  const j = await body(res);
  assert.equal(res.status, 403);
  assert.equal(j.code, 'E_NOT_PRODUCTION');
  assert.equal(outbox.length, 0, 'a deploy preview sent mail built from production data');
  delete process.env.DIGEST_TO;
});

test('the digest refuses a direct call that is not the scheduler', async () => {
  reset();
  process.env.DIGEST_TO = 'raffael@example.test';
  const res = await digest(post('/api/digest', '', {}), prodCtx);
  const j = await body(res);
  assert.equal(res.status, 403);
  assert.equal(j.code, 'E_NOT_SCHEDULED');
  assert.equal(outbox.length, 0);
  delete process.env.DIGEST_TO;
});

/* No recipient is the OFF SWITCH, not an error to be worked around. This is the
   state the function ships in and it is why it can be deployed today. */
test('the digest sends nothing when no recipient is set', async () => {
  reset();
  delete process.env.DIGEST_TO;
  const res = await digest(scheduledDigest(), prodCtx);
  const j = await body(res);
  assert.equal(res.status, 200);
  assert.equal(j.sent, false);
  assert.equal(j.reason, 'E_DIGEST_DISABLED');
  assert.equal(outbox.length, 0, 'the digest sent mail with no recipient configured');
});

test('the digest sends nothing to an address that is not one', async () => {
  reset();
  process.env.DIGEST_TO = 'not an address';
  const res = await digest(scheduledDigest(), prodCtx);
  assert.equal((await body(res)).sent, false);
  assert.equal(outbox.length, 0);
  delete process.env.DIGEST_TO;
});

/* THE ONE THAT DISTINGUISHES WORKING FROM SILENTLY EMPTY. */
test('with every guard satisfied the digest sends, and carries the day it read', async () => {
  reset();
  process.env.DIGEST_TO = 'raffael@example.test';

  /* Yesterday, because that is the day the handler reports on. */
  const day = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  const other = new Date(Date.now() - 5 * 86400e3).toISOString().slice(0, 10);

  const metrics = new FakeStore('metrics');
  const attempts = new FakeStore('attempts');
  for (let i = 0; i < 4; i++) {
    metrics.data.set(`${day}:m${i}`, JSON.stringify({
      v: 1, day, refs: ['web.fetch'], trigger: 'scheduled', capture_path: 'file',
      owner_confirmed: true, scrub_reviewed: true, inputs: 1, slots: 0, checks: 1,
      goldens: 1, consent: { rows: 2, required: 1 }
    }));
  }
  attempts.data.set(`${day}:a0`, JSON.stringify({ v: 1, day, code: 'E_SCRUB_GATE' }));
  attempts.data.set(`${day}:a1`, JSON.stringify({ v: 1, day, code: 'E_SCRUB_GATE' }));
  /* A different day, which must not appear. */
  metrics.data.set(`${other}:m9`, JSON.stringify({ v: 1, day: other, refs: ['files.read'], consent: {} }));
  stores.set('metrics', metrics);
  stores.set('attempts', attempts);

  const res = await digest(scheduledDigest(), prodCtx);
  const j = await body(res);
  assert.equal(j.sent, true, 'every guard was satisfied and nothing was sent');
  assert.equal(outbox.length, 1, 'expected exactly one mail');

  const mail = outbox[0];
  const blob = JSON.stringify(mail);
  assert.match(blob, /4 published, 2 refused/, 'the mail did not carry the numbers from the store');
  assert.match(blob, /E_SCRUB_GATE/);
  /* The neighbouring day's capability must not have been read. */
  assert.equal(blob.includes('files.read'), false, 'the digest read a day it was not reporting on');
  delete process.env.DIGEST_TO;
});

/* THE money.* HOLE, DRIVEN THROUGH THE REAL ENDPOINT.

   tools/run-tests.mjs asserts metricsRecord collapses the ref. That is the unit
   version and it was not enough: removing the collapse left this suite 61/61
   green, because the closed-set assertion above only ever sees the standard
   fixture and the standard fixture has no money capability. Tightening that
   assertion removed a permission nothing exercised, which is not the same as
   adding a test.

   spec/vocabulary.md:43 makes `money.` a PREFIX rather than an id, deliberately,
   so the validator accepts anything under it. That made it the one field in
   the record not drawn from a closed set, and it published verbatim. */
test('a money capability carrying a sentence publishes without storing the sentence', async () => {
  reset();
  const payload = 'money.urgentyouraccountislockedvisitphaeaciasecuritydotcomtounlockitnow';
  const text = distinct().replace('capability_ref: web.fetch', 'capability_ref: ' + payload);

  const j = await body(await upload(uploadReq(text, {}, freshIp())));
  assert.equal(j.ok, true, 'fixture stopped publishing, so it stopped testing the hole: ' + JSON.stringify(j.code));

  const metrics = stores.get('metrics');
  const row = JSON.parse([...metrics.data.values()][0]);
  const blob = JSON.stringify(row);

  assert.equal(blob.includes('unlockitnow'), false, 'the metrics row stored a stranger\'s sentence');
  assert.equal(blob.includes(payload), false, 'the metrics row stored the raw money ref');
  assert.ok(row.refs.includes('money.*'), 'the money capability vanished instead of collapsing');
  assert.ok(row.refs_outside_envelope.includes('money.*'), 'collapsing broke the envelope check');

  /* No string in this record has any business being long. The longest real
     vocabulary id is `calendar.read` at 13. */
  const strings = [];
  (function walk(v) {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  })(row);
  for (const str of strings) {
    assert.ok(str.length <= 32, `metrics row carries a ${str.length}-character string: ${JSON.stringify(str.slice(0, 40))}`);
  }
});

/* ONCE A DAY, WHOEVER ASKS. Without this the moment DIGEST_TO is set the
   function is a button: a critic wrote the curl, and every press is a Resend
   send against the quota plus a full corpus read against the blob store. The
   scheduler-shape check is not authentication and sweep.mjs says so about the
   same check, so the bound has to come from somewhere that is not the caller. */
test('the digest sends once a day however many times it is called', async () => {
  reset();
  process.env.DIGEST_TO = 'raffael@example.test';
  const first = await body(await digest(scheduledDigest(), prodCtx));
  assert.equal(first.sent, true);

  for (let i = 0; i < 5; i++) {
    const again = await body(await digest(scheduledDigest(), prodCtx));
    assert.equal(again.sent, false, 'the digest sent twice for one day');
    assert.equal(again.reason, 'E_DIGEST_ALREADY_SENT');
  }
  assert.equal(outbox.length, 1, `six calls produced ${outbox.length} mails`);
  delete process.env.DIGEST_TO;
});

/* The catch had no test at all: nothing in either suite drove readCorpusDay,
   digestReport or sendMail to throw, so E_DIGEST_FAILED was never once
   observed and `throw e` as the first statement of the catch left the suite
   green. */
test('a failure inside the digest is swallowed and named, not raised', async () => {
  reset();
  process.env.DIGEST_TO = 'raffael@example.test';
  const metrics = new FakeStore('metrics');
  metrics.list = async () => { throw new Error('metrics store is down'); };
  stores.set('metrics', metrics);

  /* The listing failure is caught inside readCorpusDay and surfaces as
     listed:false rather than as a throw, so break the send instead. */
  const saved = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('mail provider unreachable'); };
  try {
    const res = await digest(scheduledDigest(), prodCtx);
    const j = await body(res);
    assert.equal(res.status, 200, 'a digest failure became a non-2xx nobody reads');
    assert.equal(j.sent, false, 'a failed send was reported as sent');
    /* E_DIGEST_SEND_FAILED, not E_DIGEST_FAILED, and the difference is the bug
       this test found. sendMail does not throw: it returns { ok, reason }. The
       handler ignored the return value inside a try/catch, so a failed send was
       reported as sent:true and logged as "digest sent", and the catch could
       not have caught it because there was nothing to catch. */
    assert.equal(j.reason, 'E_DIGEST_SEND_FAILED');
  } finally {
    globalThis.fetch = saved;
    delete process.env.DIGEST_TO;
  }
});

/* An unlistable store must reach the MAIL as a warning, not just the log. This
   is the end-to-end half of the outage finding: the unit test proves the report
   builder says the right thing, this proves the handler actually hands it the
   flag rather than dropping it on the floor, which is what it used to do. */
test('an unreachable store produces a mail that says so', async () => {
  reset();
  process.env.DIGEST_TO = 'raffael@example.test';
  const attempts = new FakeStore('attempts');
  attempts.list = async () => { throw new Error('attempts store is down'); };
  stores.set('attempts', attempts);

  const j = await body(await digest(scheduledDigest(), prodCtx));
  assert.equal(j.sent, true, 'an outage produced no mail at all, which is also silent');
  const blob = JSON.stringify(outbox[0]);
  assert.match(blob, /INCOMPLETE/, 'the subject did not carry the warning');
  assert.equal(/Not an error/.test(blob), false,
               'an unreachable store was reported to the reader as a quiet day');
  delete process.env.DIGEST_TO;
});

/* Guard one fails OPEN when the runtime hands no deploy context, which is
   inherited from sweep.mjs rather than invented here. Pinned so that the
   behaviour is a decision on the record rather than a surprise: a local run and
   the test suite both see no context, and treating that as non-production would
   make the function untestable. Production is the safe default for a READ; it
   is worth re-reading if this ever writes. */
test('no deploy context at all is treated as production, deliberately', async () => {
  reset();
  process.env.DIGEST_TO = 'raffael@example.test';
  const j = await body(await digest(scheduledDigest(), {}));
  assert.equal(j.sent, true, 'absent context was treated as non-production, which makes this untestable');
  delete process.env.DIGEST_TO;
});

/* ── ROW-37: deploy scoping, driven through the real handlers ───────────────
   tools/run-tests.mjs proves the mechanism in _store.mjs works: two different
   `deploy` objects reach two different stores. What it CANNOT prove is that
   each handler actually reads `context.deploy` and hands it down rather than,
   say, passing `context.deploy.context` (a string) where an object was
   wanted, or forgetting the plumbing on one particular endpoint. That is a
   wiring bug and the unit-level tests are structurally blind to it, because
   they call _store.mjs directly with a deploy object built by the test, not
   by a handler. This file drives the actual handlers with a `context.deploy`
   shaped exactly like the one `@netlify/serverless-functions-api` hands them,
   the same shape the sweep-guard and digest-guard tests above already use. */

const previewCtx = { deploy: { context: 'deploy-preview', id: 'pr-501' } };

test('a preview publish lands in a scoped store, not the bare one', async () => {
  reset();
  const res = await upload(uploadReq(distinct(), {}, freshIp()), previewCtx);
  const j = await body(res);
  assert.equal(res.status, 200, JSON.stringify(j));
  assert.equal(stores.has('passports'), false,
    'the handler must not have touched the bare production store at all');
  assert.equal(stores.get('dp-pr-501-passports').data.has(j.id), true,
    'and must have written into its own scoped store');
});

test('a preview publish is invisible to the production page, and visible to its own', async () => {
  reset();
  const res = await upload(uploadReq(distinct(), {}, freshIp()), previewCtx);
  const { id } = await body(res);

  const productionRes = await passport(new Request(ORIGIN + `/p/${id}`),
    { params: { id } });   // no `deploy`: production, the same as every other passport.mjs test above
  assert.equal(productionRes.status, 404,
    'production must not be able to render a passport a preview created');

  const previewRes = await passport(new Request(ORIGIN + `/p/${id}`),
    { params: { id }, ...previewCtx });
  assert.equal(previewRes.status, 200,
    'the same deploy that created it renders it normally');
});

test('a preview publish can only be deleted from its own deploy, not from production', async () => {
  reset();
  const { id, delete_token } = await body(
    await upload(uploadReq(distinct(), {}, freshIp()), previewCtx));

  const fromProduction = await remove(
    jsonReq('/api/delete', { id, token: delete_token }));   // no context: production
  assert.equal(fromProduction.status, 404,
    'production has no row at this id to delete, by construction');
  assert.equal(stores.get('dp-pr-501-passports').data.has(id), true,
    'and the preview row is still there — this was not a delete that silently hit the wrong store');

  const fromPreview = await remove(
    jsonReq('/api/delete', { id, token: delete_token }), previewCtx);
  assert.equal(fromPreview.status, 200);
  assert.equal(stores.get('dp-pr-501-passports').data.has(id), false,
    'the deploy that owns the row can delete it');
});

test('rate limiter counters do not cross the scope boundary through the real endpoint', async () => {
  reset();
  const ip = freshIp();
  /* Five is the up-h ceiling. Spend it all from the preview; production must
     still have its own five, untouched, because a stranger hammering a
     preview deploy must not be able to lock a real publisher out of
     production from the same address. */
  for (let i = 0; i < 5; i++) {
    const res = await upload(uploadReq(distinct(), {}, ip), previewCtx);
    assert.equal(res.status, 200, `preview publish ${i} should have succeeded`);
  }
  const sixthPreview = await upload(uploadReq(distinct(), {}, ip), previewCtx);
  assert.equal(sixthPreview.status, 429, 'the preview is now at its own ceiling');

  const productionRes = await upload(uploadReq(distinct(), {}, ip));   // no context
  assert.equal(productionRes.status, 200,
    'production, same address, is unaffected by the preview exhausting its own limiter');
});

/* THE THREE HANDLERS ABOVE DO NOT COVER MANAGE, SEND OR SUBSCRIBE, and a
   critic reviewing this branch found exactly that gap by mutation: forcing
   `const deploy = undefined;` in `manage.mjs`, `send.mjs` and
   `subscribe.mjs` — destroying their deploy threading completely — passed
   every test in this file and in run-tests.mjs. `manage.mjs` is the one
   that matters most: with its threading gone, `renewPassport`/`statusOf`
   run against the BARE PRODUCTION STORE from inside a preview request,
   which is the exact hazard ROW-37 exists to close, and nothing failed.
   These three close that. Each follows the same shape as the upload/
   passport/delete-passport tests above: authorise (or its equivalent) must
   fail under the wrong scope and succeed under the right one. */

test('manage cannot reach a preview passport from production, and can from its own deploy', async () => {
  reset();
  const { id, delete_token } = await body(
    await upload(uploadReq(distinct(), {}, freshIp()), previewCtx));

  const fromProduction = await manage(
    jsonReq('/api/manage', { id, token: delete_token, action: 'status' }));   // no context
  assert.equal(fromProduction.status, 404,
    'production has no row at this id to authorise against, by construction');

  const fromPreview = await manage(
    jsonReq('/api/manage', { id, token: delete_token, action: 'status' }), previewCtx);
  assert.equal(fromPreview.status, 200,
    'the deploy that owns the row can read its status');
  const j = await body(fromPreview);
  assert.equal(j.status.id, id);
});

test('send cannot authorise a preview passport from production, and can from its own deploy', async () => {
  reset();
  const { id, delete_token } = await body(
    await upload(uploadReq(distinct(), {}, freshIp()), previewCtx));

  const fromProduction = await send(
    jsonReq('/api/send', { id, token: delete_token, to: 'them@example.com' }));   // no context
  assert.equal(fromProduction.status, 404,
    'production cannot authorise a token for a row it cannot see');

  const fromPreview = await send(
    jsonReq('/api/send', { id, token: delete_token, to: 'them@example.com' }), previewCtx);
  assert.notEqual(fromPreview.status, 404,
    'the deploy that owns the row gets past authorise (the mail step itself is not what this test is about)');
});

test('subscribe cannot authorise a preview passport from production, and can from its own deploy', async () => {
  reset();
  const { id, delete_token } = await body(
    await upload(uploadReq(distinct(), {}, freshIp()), previewCtx));

  const fromProduction = await subscribe(
    jsonReq('/api/subscribe', { id, token: delete_token, email: 'reader@example.com', consent: true }));
  assert.equal(fromProduction.status, 404,
    'production cannot authorise a token for a row it cannot see');

  const fromPreview = await subscribe(
    jsonReq('/api/subscribe', { id, token: delete_token, email: 'reader@example.com', consent: true }),
    previewCtx);
  assert.equal(fromPreview.status, 200,
    'the deploy that owns the row authorises normally and reaches the provider');
});

/* ══ the gallery ══════════════════════════════════════════
   GALLERY-SPEC.md §11's checks, as endpoint tests: publish listed, unlisted,
   unreviewed-and-listed; list, unlist, renew and delete from manage; the vote
   in both request shapes, with and without the cookie, on an unlisted id;
   the copy counter; and /gallery empty, with a card, and with a card whose
   row went underneath it. The gallery page itself is imported inside its
   tests: lib/_gallery-render.mjs is the frontend lane's file, so on the
   backend branch alone those tests fail at the import and the rest of this
   suite still runs. */
const CATEGORY = 'research-and-monitoring';
const listedReq = (text, category = CATEGORY, extra = {}, ip) =>
  uploadReq(text, { 'x-passport-list': '1', ...(category === null ? {} : { 'x-passport-category': category }), ...extra }, ip);
const cookieOf = (res) => {
  const raw = res.headers.get('set-cookie') || '';
  return raw ? raw.split(';')[0] : null;
};
const voteJson = (obj, cookie, ip = freshIp()) =>
  vote(post('/api/vote', JSON.stringify(obj),
    { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ip));
const voteForm = (fields, cookie, ip = freshIp()) =>
  vote(post('/api/vote', new URLSearchParams(fields).toString(),
    { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, ip));
const manageReq = (obj) => manage(jsonReq('/api/manage', obj));
const expiryKeys = (id) => [...(stores.get('expiry')?.data.keys() || [])].filter(k => k.endsWith(':' + id));
const tallyKeyFor = id => {
  const generation = JSON.parse(stores.get('passports').data.get(id)).gallery?.generation;
  return generation ? `${id}:${generation}` : id;
};
const rowShape = (id) => {
  const p = stores.get('passports');
  return { row: JSON.parse(p.data.get(id)), meta: p.meta.get(id), expiry: expiryKeys(id),
           card: stores.get('gallery') ? stores.get('gallery').data.has(id) : false };
};
const WITHOUT_ROBOTS = (() => { const { 'x-robots-tag': _r, ...rest } = HEADERS; return rest; })();
const headerMap = (res) => Object.fromEntries([...res.headers.entries()]);

test('gallery: a listed publish comes back listed, with no expiry, and its page is indexable', async () => {
  reset();
  const j = await body(await upload(listedReq(distinct())));
  assert.equal(j.ok, true, JSON.stringify(j));
  assert.equal(j.listed, true);
  assert.equal(j.expires_at, null);
  assert.equal(j.gallery_url, 'https://app.phaeacia.ai/gallery');

  const { row, meta, expiry, card } = rowShape(j.id);
  assert.deepEqual(row.gallery.category, CATEGORY);
  assert.equal(row.expires_at, null);
  assert.deepEqual(meta, { h: row.delete_token_hash, x: 0, g: 1, gg: row.gallery.generation });
  assert.deepEqual(expiry, []);
  assert.equal(card, true);

  const res = await page(j.id);
  assert.equal(res.status, 200);
  const h = headerMap(res);
  assert.equal(h['x-robots-tag'], undefined, 'a listed passport page must not say noindex');
  assert.deepEqual(h, WITHOUT_ROBOTS, 'a listed page must carry exactly the unlisted headers minus x-robots-tag');
  assert.equal((await res.text()).match(/content-security-policy/g), null, 'the CSP is a header, never a meta tag');
});

test('gallery: an unlisted publish is unchanged: listed false, the same headers, the same 404', async () => {
  reset();
  const j = await publish();
  assert.equal(j.listed, false);
  assert.ok(j.expires_at);
  const { row, meta, expiry, card } = rowShape(j.id);
  assert.ok(!row.gallery);
  assert.deepEqual(meta, { h: row.delete_token_hash, x: Date.parse(row.expires_at) });
  assert.equal(expiry.length, 1);
  assert.equal(card, false);

  assert.deepEqual(headerMap(await page(j.id)), HEADERS, 'an unlisted page moved a header');
  const gone = await page('00000000-0000-4000-8000-000000000000');
  assert.equal(gone.status, 404);
  assert.deepEqual(headerMap(gone), HEADERS, 'the 404 moved a header');
});

test('gallery: the list header without a real category is refused, charged as a failure, counted, and publishes nothing', async () => {
  reset();
  const ip = freshIp();
  for (const category of [null, '', 'Research and monitoring', 'not-a-category']) {
    const res = await upload(listedReq(distinct(), category, {}, ip));
    assert.equal(res.status, 422);
    assert.equal((await body(res)).code, 'E_CATEGORY');
  }
  assert.equal(stores.has('passports'), false, 'a refused listing published a passport');
  assert.equal(stores.has('gallery'), false, 'a refused listing wrote a card');
  const rows = [...stores.get('attempts').data.values()].map(v => JSON.parse(v));
  assert.equal(rows.length, 4);
  assert.ok(rows.every(r => r.code === 'E_CATEGORY'));
  /* Moved to the failure ceiling: no up-h key left, four bad-h keys. */
  const keys = [...stores.get('ratelimit').data.keys()];
  assert.equal(keys.filter(k => k.includes(':up-h:')).length, 0, 'a refusal kept its publish attempt');
  assert.equal(keys.filter(k => k.includes(':bad-h:')).length, 4);
});

test('gallery: unreviewed and listed, the retry must keep the headers', async () => {
  reset();
  const ip = freshIp();
  const text = distinct(UNCONFIRMED);
  const refused = await body(await upload(listedReq(text, CATEGORY, {}, ip)));
  assert.equal(refused.code, 'E_OWNER_UNCONFIRMED');
  assert.ok(refused.ack);

  const ok = await body(await upload(listedReq(text, CATEGORY, { 'x-passport-owner-ack': refused.ack }, ip)));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.listed, true, 'the retry dropped the listing');
  assert.equal(rowShape(ok.id).card, true);
  assert.equal(rowShape(ok.id).row.owner_confirmed, false);

  /* And the failure this pins: a retry that drops the headers publishes
     UNLISTED, with nothing telling anyone. The client must resend them. */
  const text2 = distinct(UNCONFIRMED);
  const refused2 = await body(await upload(listedReq(text2, CATEGORY, {}, ip)));
  const plain = await body(await upload(uploadReq(text2, { 'x-passport-owner-ack': refused2.ack }, ip)));
  assert.equal(plain.ok, true);
  assert.equal(plain.listed, false);
});

test('gallery: list, renew, unlist and delete from manage', async () => {
  reset();
  const { id, delete_token: token } = await publish();

  const bad = await manageReq({ id, token, action: 'list', category: 'nope' });
  assert.equal(bad.status, 404);
  assert.equal((await body(bad)).code, 'E_MANAGE_FAILED');
  assert.equal(rowShape(id).card, false);

  const listed = await body(await manageReq({ id, token, action: 'list', category: CATEGORY }));
  assert.equal(listed.ok, true);
  assert.equal(listed.status.listed, true);
  assert.equal(listed.status.category, CATEGORY);
  assert.equal(listed.status.expires_at, null);
  assert.deepEqual(listed.status.votes, { up: 0, down: 0 });
  assert.equal(listed.status.copies, 0);
  const after = rowShape(id);
  assert.deepEqual(after.meta, { h: after.row.delete_token_hash, x: 0, g: 1, gg: after.row.gallery.generation });
  assert.deepEqual(after.expiry, []);
  assert.equal(after.card, true);

  /* Renew on a listed row: ok, nothing renewed, nothing changed. */
  const before = JSON.stringify(rowShape(id));
  const renewed = await body(await manageReq({ id, token, action: 'renew' }));
  assert.equal(renewed.ok, true);
  assert.equal(renewed.renewed_to, null);
  assert.equal(renewed.status.listed, true);
  assert.equal(JSON.stringify(rowShape(id)), before, 'renewing a listed passport changed it');

  const wrong = await manageReq({ id, token: 'f'.repeat(40), action: 'unlist' });
  assert.equal(wrong.status, 404);
  assert.equal(rowShape(id).card, true);

  const un = await body(await manageReq({ id, token, action: 'unlist' }));
  assert.equal(un.ok, true);
  assert.ok(Date.parse(un.expires_at) > Date.now() + 29 * 86400e3);
  assert.equal(un.status.listed, false);
  assert.equal(un.status.expires_at, un.expires_at);
  const back = rowShape(id);
  assert.deepEqual(back.meta, { h: back.row.delete_token_hash, x: Date.parse(un.expires_at) });
  assert.equal(back.expiry.length, 1);
  assert.equal(back.card, false);
  assert.deepEqual(headerMap(await page(id)), HEADERS, 'an unlisted page must say noindex again');

  /* Delete a listed one: the card and the votes go with it. */
  await manageReq({ id, token, action: 'list', category: CATEGORY });
  await voteJson({ id, dir: 'up' });
  assert.equal(stores.get('votes').data.size, 1);
  assert.equal((await body(await remove(jsonReq('/api/delete', { id, token })))).ok, true);
  assert.equal(stores.get('gallery').data.has(id), false);
  assert.equal(stores.get('votes').data.size, 0);
  assert.equal([...stores.get('votes-count').data.keys()].some(k => k === id || k.startsWith(id + ':')), false);
  assert.equal((await page(id)).status, 404);
});

test('gallery: voting up, changing to down, clearing, and voting again with the cookie gone', async () => {
  reset();
  const { id } = await body(await upload(listedReq(distinct())));

  const first = await voteJson({ id, dir: 'up' });
  assert.equal(first.status, 200);
  assert.deepEqual(await body(first), { ok: true, up: 1, down: 0, yours: 'up' });
  const cookie = cookieOf(first);
  assert.match(cookie, /^pv=[0-9a-f]{32}\.[0-9a-f]{32}$/);
  const attrs = first.headers.get('set-cookie');
  for (const a of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=31536000']) {
    assert.ok(attrs.includes(a), 'the cookie is missing ' + a);
  }

  const second = await voteJson({ id, dir: 'down' }, cookie);
  assert.deepEqual(await body(second), { ok: true, up: 0, down: 1, yours: 'down' });
  assert.equal(second.headers.get('set-cookie'), null, 'a valid cookie must not be reissued');

  const third = await voteJson({ id, dir: 'none' }, cookie);
  assert.deepEqual(await body(third), { ok: true, up: 0, down: 0, yours: null });

  /* The cookie deleted: a fresh id, a fresh cookie, a second vote. */
  const again = await voteJson({ id, dir: 'up' }, cookie);
  assert.deepEqual(await body(again), { ok: true, up: 1, down: 0, yours: 'up' });
  const fresh = await voteJson({ id, dir: 'up' });
  assert.deepEqual(await body(fresh), { ok: true, up: 2, down: 0, yours: 'up' });
  assert.notEqual(cookieOf(fresh), cookie);

  /* A forged signature is a missing cookie. */
  const forged = await voteJson({ id, dir: 'up' }, cookie.replace(/\.[0-9a-f]{32}$/, '.' + 'f'.repeat(32)));
  assert.deepEqual(await body(forged), { ok: true, up: 3, down: 0, yours: 'up' });
  assert.ok(cookieOf(forged), 'a forged cookie must be replaced');
  assert.equal(stores.get('votes').data.size, 3);
});

test('gallery: the form path votes without script and redirects to the validated page', async () => {
  reset();
  const { id } = await body(await upload(listedReq(distinct())));
  const res = await voteForm({ id, dir: 'up' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `/p/${id}`);
  assert.match(cookieOf(res) || '', /^pv=/);
  assert.equal(JSON.parse(stores.get('votes-count').data.get(tallyKeyFor(id))).up, 1);

  const back = await voteForm({ id, dir: 'down', back: 'gallery' }, cookieOf(res));
  assert.equal(back.status, 303);
  assert.equal(back.headers.get('location'), '/gallery');
  assert.equal(JSON.parse(stores.get('votes-count').data.get(tallyKeyFor(id))).down, 1);

  /* A field value is never a redirect target. */
  const bad = await voteForm({ id: 'https://evil.example/', dir: 'up' });
  assert.equal(bad.status, 303);
  assert.equal(bad.headers.get('location'), '/gallery');
});

test('gallery: a vote on an unlisted, missing or malformed id, or with a bad direction, is one answer', async () => {
  reset();
  const { id } = await publish();
  for (const req of [
    { id, dir: 'up' },
    { id: '00000000-0000-4000-8000-000000000000', dir: 'up' },
    { id: 'not-a-uuid', dir: 'up' },
    { dir: 'up' },
    null
  ]) {
    const res = await voteJson(req);
    assert.equal(res.status, 404);
    assert.equal((await body(res)).code, 'E_VOTE_FAILED');
  }
  const listed = await body(await upload(listedReq(distinct())));
  const sideways = await voteJson({ id: listed.id, dir: 'sideways' });
  assert.equal(sideways.status, 404);
  assert.equal((await body(sideways)).code, 'E_VOTE_FAILED');
  assert.equal(stores.has('votes'), false, 'a refused vote opened the votes store');
});

test('gallery: without VOTE_SECRET the vote endpoint fails closed', async () => {
  reset();
  const { id } = await body(await upload(listedReq(distinct())));
  const keep = process.env.VOTE_SECRET;
  delete process.env.VOTE_SECRET;
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  let res;
  try {
    res = await voteJson({ id, dir: 'up' });
  } finally {
    console.error = realError;
    process.env.VOTE_SECRET = keep;
  }
  assert.equal(res.status, 404);
  assert.equal((await body(res)).code, 'E_VOTE_FAILED');
  assert.equal(res.headers.get('set-cookie'), null, 'no cookie can be signed without the secret');
  assert.equal(stores.has('votes'), false, 'a vote was recorded with no secret');
  const limiterKeys = [...(stores.get('ratelimit')?.data.keys() || [])].filter(k => k.includes(':vote-h:'));
  assert.deepEqual(limiterKeys, [], 'a refusal for a missing secret wrote a limiter key');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /VOTE_SECRET/);
});

test('gallery: thirty votes an hour per network, then E_VOTE_LIMIT', async () => {
  reset();
  const { id } = await body(await upload(listedReq(distinct())));
  const ip = freshIp();
  for (let i = 0; i < 30; i++) {
    assert.equal((await voteJson({ id, dir: 'up' }, null, ip)).status, 200, 'vote ' + (i + 1) + ' was refused');
  }
  const over = await voteJson({ id, dir: 'up' }, null, ip);
  assert.equal(over.status, 429);
  assert.equal((await body(over)).code, 'E_VOTE_LIMIT');
});

test('gallery: the copy control counts, for a listed and an unlisted passport, and says nothing back', async () => {
  reset();
  const listed = await body(await upload(listedReq(distinct())));
  const plain = await publish();
  for (const id of [listed.id, plain.id]) {
    const res = await copied(jsonReq('/api/copied', { id }));
    assert.equal(res.status, 204);
    assert.equal(await res.text(), '');
    assert.equal(res.headers.get('set-cookie'), null);
  }
  assert.equal(JSON.parse(stores.get('copies').data.get(listed.id)).n, 1);
  assert.equal(JSON.parse(stores.get('copies').data.get(plain.id)).n, 1);
  const status = await body(await manageReq({ id: plain.id, token: plain.delete_token, action: 'status' }));
  assert.equal(status.status.copies, 1);

  /* Nothing to count is still 204: not an oracle. */
  for (const payload of [{ id: '00000000-0000-4000-8000-000000000000' }, { id: 'nope' }, {}, 'not json']) {
    const res = await copied(post('/api/copied', typeof payload === 'string' ? payload : JSON.stringify(payload),
      { 'content-type': 'application/json' }));
    assert.equal(res.status, 204);
  }
  assert.equal(stores.get('copies').data.size, 2, 'something that is not a live passport was counted');
  assert.equal((await copied(new Request(`${ORIGIN}/api/copied`))).status, 405);
});

test('gallery: sixty copy presses an hour per network, then a bodyless 429', async () => {
  reset();
  const { id } = await publish();
  const ip = freshIp();
  for (let i = 0; i < 60; i++) {
    assert.equal((await copied(jsonReq('/api/copied', { id }, ip))).status, 204);
  }
  const over = await copied(jsonReq('/api/copied', { id }, ip));
  assert.equal(over.status, 429);
  assert.equal(await over.text(), '');
  assert.equal(JSON.parse(stores.get('copies').data.get(id)).n, 60);
});

/* /create's copy-control counter: which capture path (F, folder on your
   computer; W, browser chat) a visitor copied. No passport id — see
   netlify/functions/copied-prompt.mjs and lib/_store.mjs's PROMPT_COPY_PATHS
   for why. Built reading copied.mjs first and the shape below mirrors its
   tests on purpose: 204 always, a malformed body counts nothing, its own
   hourly ceiling, and here specifically that f and w move independently
   AND that concurrent presses of the same path are not lost — a round-1
   critic showed a get-then-increment counter drops almost every write once
   presses of one path overlap, because there are only two keys in the
   whole store for every press in the world to contend on; the fix is one
   key per press, counted by listing, so `countPromptClicks` below counts
   the same way lib/_store.mjs's readPromptCopies does. */
const countPromptClicks = (path) => {
  const st = stores.get('prompt-clicks');
  if (!st) return 0;
  return [...st.data.keys()].filter(k => k.startsWith(`${path}:`)).length;
};

test('create: a copy-control press counts against its own path and says nothing back', async () => {
  reset();
  const resF = await copiedPrompt(jsonReq('/api/copied-prompt', { path: 'f' }));
  assert.equal(resF.status, 204);
  assert.equal(await resF.text(), '');
  assert.equal(resF.headers.get('set-cookie'), null);
  const resW = await copiedPrompt(jsonReq('/api/copied-prompt', { path: 'w' }));
  assert.equal(resW.status, 204);
  assert.equal(countPromptClicks('f'), 1);
  assert.equal(countPromptClicks('w'), 1);
  /* A second f press moves only f. The two counters are independent. */
  await copiedPrompt(jsonReq('/api/copied-prompt', { path: 'f' }));
  assert.equal(countPromptClicks('f'), 2);
  assert.equal(countPromptClicks('w'), 1);
});

test('create: anything that is not exactly "f" or "w" counts nothing and is still 204', async () => {
  reset();
  for (const payload of [{ path: 'x' }, { path: 'F' }, { path: '' }, { path: 'f ' },
    { path: ['f'] }, { path: 1 }, { id: 'f' }, {}, 'not json']) {
    const res = await copiedPrompt(post('/api/copied-prompt',
      typeof payload === 'string' ? payload : JSON.stringify(payload),
      { 'content-type': 'application/json' }));
    assert.equal(res.status, 204, `payload ${JSON.stringify(payload)} was not answered 204`);
  }
  assert.equal(stores.has('prompt-clicks'), false,
    'something that is not exactly "f" or "w" was counted');
  assert.equal((await copiedPrompt(new Request(`${ORIGIN}/api/copied-prompt`))).status, 405);
});

test('create: sixty copy-control presses an hour per network, then a bodyless 429, shared across f and w', async () => {
  reset();
  const ip = freshIp();
  for (let i = 0; i < 60; i++) {
    const path = i % 2 === 0 ? 'f' : 'w';
    assert.equal((await copiedPrompt(jsonReq('/api/copied-prompt', { path }, ip))).status, 204);
  }
  const over = await copiedPrompt(jsonReq('/api/copied-prompt', { path: 'f' }, ip));
  assert.equal(over.status, 429);
  assert.equal(await over.text(), '');
  assert.equal(countPromptClicks('f'), 30);
  assert.equal(countPromptClicks('w'), 30);
  /* A fresh network is not rate limited by the first one's ceiling. */
  const fresh = await copiedPrompt(jsonReq('/api/copied-prompt', { path: 'w' }, freshIp()));
  assert.equal(fresh.status, 204);
});

test('create: concurrent presses of the same path through the real handler are not lost', async () => {
  reset();
  const ip = freshIp();
  await Promise.all(Array.from({ length: 20 }, () =>
    copiedPrompt(jsonReq('/api/copied-prompt', { path: 'f' }, ip))));
  assert.equal(countPromptClicks('f'), 20,
    'a get-then-increment counter would have collapsed these 20 concurrent presses to 1');
});

test('create: a preview deploy counts into its own scope, not production\'s', async () => {
  reset();
  const preview = { context: 'deploy-preview', id: 'pr-cc-ep1' };
  await copiedPrompt(jsonReq('/api/copied-prompt', { path: 'f' }), { deploy: preview });
  assert.equal(stores.has('prompt-clicks'), false,
    'a preview press touched the bare production store');
  assert.equal(stores.has('dp-pr-cc-ep1-prompt-clicks'), true,
    'a preview press did not land in its own scoped store');
});

/* The gallery page. Imported here rather than at the top: see the section
   comment. */
const runRecount = () => recountFn(
  post('/api/recount', JSON.stringify({ next_run: new Date().toISOString() }), { 'content-type': 'application/json' }),
  { deploy: { context: 'production' } });
const galleryPage = async (query = '', extra = {}) => {
  const gallery = (await import('../netlify/functions/gallery.mjs')).default;
  return gallery(new Request(`${ORIGIN}/gallery${query}`, { headers: extra }));
};

test('gallery: with nothing listed the page still renders, indexable and cacheable, and links to /upload', async () => {
  reset();
  const res = await galleryPage();
  assert.equal(res.status, 200);
  const h = headerMap(res);
  assert.equal(h['x-robots-tag'], undefined);
  assert.equal(h['cache-control'], 'public, max-age=60');
  assert.equal(h['content-security-policy'], HEADERS['content-security-policy']);
  assert.equal(h['set-cookie'], undefined, 'a cacheable page must never set a cookie');
  const { 'cache-control': _c, ...rest } = h;
  const { 'cache-control': _d, ...expected } = WITHOUT_ROBOTS;
  assert.deepEqual(rest, expected);
  const html = await res.text();
  assert.match(html, /Nobody has listed a passport yet/);
  assert.match(html, /href="\/upload"/);
});

test('gallery: a listed passport is a card linking to its page, and the counts on it are real', async () => {
  reset();
  const { id, title } = await body(await upload(listedReq(distinct())));
  await voteJson({ id, dir: 'up' });
  await voteJson({ id, dir: 'up' });
  await voteJson({ id, dir: 'down' });
  const html = await (await galleryPage()).text();
  assert.match(html, new RegExp(`href="/p/${id}"`));
  assert.ok(html.includes(title.replace(/&/g, '&amp;')), 'the card does not carry the title');
  assert.ok(!/Nobody has listed a passport yet/.test(html));
  assert.match(html, /2/);
  assert.match(html, /name="dir" value="up"/);
  assert.match(html, /name="dir" value="down"/);
  assert.match(html, new RegExp(`name="id" value="${id}"`));
});

test('gallery: GET never reads the vote cookie, so the page is the same with and without one', async () => {
  reset();
  const { id } = await body(await upload(listedReq(distinct())));
  const first = await voteJson({ id, dir: 'up' });
  const cookie = cookieOf(first);
  const bare = await (await galleryPage()).text();
  const withCookie = await (await galleryPage('', { cookie })).text();
  assert.equal(withCookie, bare);
  assert.ok(!bare.includes('aria-pressed="true"'), 'a server render marked a vote as somebody\'s');
});

test('gallery: a card whose row was deleted or unlisted underneath it is not shown and is repaired', async () => {
  reset();
  const kept = await body(await upload(listedReq(distinct())));
  const deleted = await body(await upload(listedReq(distinct())));
  const unlisted = await body(await upload(listedReq(distinct())));
  /* Deleted underneath: the row goes, the card stays (the state a delete
     interrupted before its cosmetic jobs leaves). */
  stores.get('passports').data.delete(deleted.id);
  stores.get('passports').meta.delete(deleted.id);
  /* Unlisted underneath: the row and its metadata lose the flag, the card
     stays (unlist step 3 failed). */
  const row = JSON.parse(stores.get('passports').data.get(unlisted.id));
  const expires_at = new Date(Date.now() + 30 * 86400e3).toISOString();
  stores.get('passports').data.set(unlisted.id, JSON.stringify({ ...row, gallery: null, expires_at }));
  stores.get('passports').meta.set(unlisted.id, { h: row.delete_token_hash, x: Date.parse(expires_at) });
  assert.equal(stores.get('gallery').data.size, 3);

  const html = await (await galleryPage()).text();
  assert.ok(html.includes(`/p/${kept.id}`));
  assert.ok(!html.includes(deleted.id), 'a card whose row was deleted was served');
  assert.ok(!html.includes(unlisted.id), 'a card whose row was unlisted was served');
  assert.equal(stores.get('gallery').data.size, 1, 'the stale cards were not repaired');
});

test('gallery: filter, sort and page come only from the fixed sets, and anything else falls back', async () => {
  reset();
  const a = await body(await upload(listedReq(distinct(), 'research-and-monitoring')));
  const b = await body(await upload(listedReq(distinct(), 'other')));
  await voteJson({ id: b.id, dir: 'up' });
  await copied(jsonReq('/api/copied', { id: a.id }));

  const onlyOther = await (await galleryPage('?category=other')).text();
  assert.ok(onlyOther.includes(b.id) && !onlyOther.includes(a.id));

  const junk = await (await galleryPage('?category=zz-nope-%3Cb%3E&sort=drop%20table&page=-3')).text();
  assert.ok(junk.includes(a.id) && junk.includes(b.id), 'a malformed query must fall back to everything');
  assert.ok(!junk.includes('zz-nope') && !junk.includes('drop table'), 'a query value reached the page');

  const top = await (await galleryPage('?sort=top')).text();
  assert.ok(top.indexOf(b.id) < top.indexOf(a.id), 'top must put the voted card first');

  /* `copied` sorts on the `copies` field the nightly recount writes into the
     card (GALLERY-SPEC.md §6): a render never reads the counter store, so the
     press above is invisible to the sort until the recount has run. Before
     it, the tiebreak (newest first) puts b first; after it, a leads. */
  const beforeRecount = await (await galleryPage('?sort=copied')).text();
  assert.ok(beforeRecount.indexOf(b.id) < beforeRecount.indexOf(a.id), 'a press must not reorder the gallery before the recount');
  await runRecount();
  const mostCopied = await (await galleryPage('?sort=copied')).text();
  assert.ok(mostCopied.indexOf(a.id) < mostCopied.indexOf(b.id), 'copied must put the copied card first once the recount has run');
});

test('gallery: the recount runs only for the scheduler on production, and rebuilds what a race left', async () => {
  reset();
  const { id } = await body(await upload(listedReq(distinct())));
  await voteJson({ id, dir: 'up' });
  stores.get('votes-count').data.set(tallyKeyFor(id), JSON.stringify({ up: 0, down: 0 }));
  stores.get('votes').data.set('00000000-0000-4000-8000-000000000000:' + 'a'.repeat(32), '1');

  const direct = await recountFn(post('/api/recount', '{}', { 'content-type': 'application/json' }));
  assert.equal(direct.status, 403);
  assert.equal((await body(direct)).code, 'E_NOT_SCHEDULED');

  const preview = await recountFn(
    post('/api/recount', JSON.stringify({ next_run: new Date().toISOString() }), { 'content-type': 'application/json' }),
    { deploy: { context: 'deploy-preview', id: 'abc' } });
  assert.equal(preview.status, 403);
  assert.equal((await body(preview)).code, 'E_NOT_PRODUCTION');
  assert.equal(JSON.parse(stores.get('votes-count').data.get(tallyKeyFor(id))).up, 0, 'a refused recount did work');

  const ran = await body(await recountFn(
    post('/api/recount', JSON.stringify({ next_run: new Date().toISOString() }), { 'content-type': 'application/json' }),
    { deploy: { context: 'production' } }));
  assert.equal(ran.ok, true);
  assert.equal(ran.listed, 1);
  assert.equal(ran.orphanVotes, 1);
  assert.equal(JSON.parse(stores.get('votes-count').data.get(tallyKeyFor(id))).up, 1);
  assert.equal(JSON.parse(stores.get('gallery').data.get(id)).up, 1);
});

/* `listed` against `refreshed` is the recount's lag figure, and it has to be
   on the log line, which is the only reader the counts have. */
test('gallery: the recount log line shows listed against refreshed, and no id', async () => {
  reset();
  const { id } = await body(await upload(listedReq(distinct())));
  await voteJson({ id, dir: 'up' });
  const { lines } = await captureLogs(runRecount);
  const counts = lines.filter(l => l.startsWith('recount: ')).map(l => JSON.parse(l.slice('recount: '.length)));
  assert.equal(counts.length, 1);
  assert.equal(counts[0].listed, 1);
  assert.equal(counts[0].refreshed, 1, 'the recount line does not say how many listed ids it refreshed');
  assert.equal(lines.some(l => l.includes(id)), false, 'a listed id reached the log');
});

test('gallery: manage category edits preserve listing votes and remain visible after recount', async () => {
  reset();
  const { id, delete_token: token } = await body(await upload(listedReq(distinct())));
  const initial = rowShape(id);
  await voteJson({ id, dir: 'up' });
  const changed = await body(await manageReq({ id, token, action: 'list', category: 'other' }));
  assert.equal(changed.ok, true);
  assert.equal(changed.status.category, 'other');
  assert.deepEqual(changed.status.votes, { up: 1, down: 0 });
  const publicPage = await page(id);
  assert.equal(publicPage.status, 200);
  const publicHtml = await publicPage.text();
  assert.match(publicHtml, /In the gallery under Something else, listed /, 'public passport category disagrees with manage and gallery');
  assert.doesNotMatch(publicHtml, /In the gallery under Research and monitoring/);
  assert.deepEqual(rowShape(id).row, initial.row, 'category update or public rendering rewrote the lifecycle row');
  await stores.get('gallery').delete(id);
  await runRecount();
  const card = JSON.parse(stores.get('gallery').data.get(id));
  assert.equal(card.category, 'other');
  assert.equal(card.up, 1);
  assert.ok((await (await galleryPage('?category=other')).text()).includes(id));
});

test('gallery: search examines all listed cards before pagination and combines with category', async () => {
  reset();
  const ids = [];
  for (let i = 0; i < 26; i++) {
    const item = await body(await upload(listedReq(distinct(), i === 0 ? 'other' : 'research-and-monitoring')));
    ids.push(item.id);
  }
  const target = stores.get('gallery');
  const first = JSON.parse(target.data.get(ids[0]));
  target.data.set(ids[0], JSON.stringify({ ...first, title: 'Boundary Compass', listed_at: '2020-01-01T00:00:00Z' }));
  const result = await (await galleryPage('?q=boundary')).text();
  assert.ok(result.includes(ids[0]));
  assert.ok(!result.includes(ids[1]));
  assert.match(result, /1 passport found/);
  const noMatch = await (await galleryPage('?q=boundary&category=research-and-monitoring')).text();
  assert.ok(!noMatch.includes(ids[0]));
  assert.match(noMatch, /No passports match yet/);
});


test('gallery: search encoding stays safe at the Unicode boundary and preserves pager state', async () => {
  const { renderGallery } = await import('../lib/_gallery-render.mjs');
  const html = renderGallery({cards: [], search: 'a'.repeat(119)+'😀', category: 'other', sort: 'top', page: 1, pages: 2, total: 25});
  assert.match(html, /rel="next"/);
  assert.match(html, /%EF%BF%BD/);
  assert.match(html, /category=other&amp;sort=top&amp;page=2/);
  const hostile = renderGallery({cards: [], search: '\" autofocus onfocus=alert(1) <script>', pages: 2});
  assert.ok(!hostile.includes('value="" autofocus'));
  assert.ok(!hostile.includes('<script>alert'));
  assert.match(hostile, /&quot; autofocus/);
});

test('gallery: a card carries its category only when the slug is on the list, and the cover names it', async () => {
  const { renderGallery } = await import('../lib/_gallery-render.mjs');
  const { CATEGORIES } = await import('../lib/_categories.mjs');
  const card = (n, category) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, title: 'Title ' + n, summary: 's', category,
    envelope: 'e', installable: 1, declared_only: 0, up: 0, down: 0, views: 0, copies: 0, listed_at: '2026-09-21', owner_confirmed: true });
  const listed = CATEGORIES.map((c, i) => card(i + 1, c.slug));
  const odd = [card(20, 'retired-slug'), card(21, ''), card(22, undefined), card(23, 'research-and-monitoring" onmouseover="x'), card(24, 'Research and monitoring')];
  const html = renderGallery({ cards: [...listed, ...odd], total: 13, pages: 1 });
  assert.match(html, /<div class="passport-grid">[\s\S]*<\/div>\s*<div class="gallery-help">/, 'cards must sit in one grid wrapper');
  const articles = html.split('<article ').slice(1);
  assert.equal(articles.length, 13);
  articles.slice(0, 8).forEach((a, i) => {
    const c = CATEGORIES[i];
    assert.ok(a.startsWith(`class="passport-entry" data-cat="${c.slug}"`), `${c.slug}: wrong data-cat`);
    assert.ok(a.includes(`<span class="cover-kind">${c.label}</span>`), `${c.slug}: the cover does not print the category name`);
    assert.ok(a.includes(`<p class="entry-category">${c.label}</p>`), `${c.slug}: the text line is gone, so colour would be the only signal for a screen reader`);
  });
  articles.slice(8).forEach((a, i) => {
    assert.ok(a.startsWith('class="passport-entry" data-cat="none"'), `odd category ${i} reached the attribute`);
    assert.ok(!a.includes('cover-kind') && !a.includes('entry-category'), `odd category ${i} printed a label`);
  });
  assert.ok(!html.includes('onmouseover'), 'a hostile category value reached the page');
});

// Consumed by phaeacia.ai netlify/functions/gallery.mjs; the contract is
// ~/Phaeacia/record/decisions/row-224-gallery-json-contract.md (ROW-224).
// Renaming HTML classes must never change these fields or their types.
const galleryJSON = async (query = '', method = 'GET', headers = {}) =>
  (await import('../netlify/functions/gallery-json.mjs')).default(new Request(`${ORIGIN}/gallery.json${query}`, { method, headers }));

test('gallery.json: pins the phaeacia.ai consumer contract without bodies or private metadata', async () => {
  reset();
  const listed = await body(await upload(listedReq(distinct(), 'research-and-monitoring')));
  const unlisted = await publish();
  const res = await galleryJSON('', 'GET', { cookie: 'vote=private', host: 'attacker.invalid' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('set-cookie'), null);
  const json = await res.json();
  assert.deepEqual(Object.keys(json).sort(), ['cards', 'next', 'version']);
  assert.equal(json.version, 1);
  assert.equal(json.next, null);
  assert.equal(json.cards.length, 1);
  const card = json.cards[0];
  assert.deepEqual(Object.keys(card).sort(), ['category','category_label','declared','envelope','id','installable','listed_at','owner_confirmed','summary','title','url','warning']);
  assert.equal(card.url, 'https://app.phaeacia.ai/p/' + listed.id);
  assert.equal(card.category, 'research-and-monitoring');
  assert.equal(card.category_label, 'Research and monitoring');
  assert.equal(card.id, listed.id);
  assert.match(card.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(card.envelope, 'read-notify');
  assert.equal(card.owner_confirmed, true);
  assert.match(card.listed_at, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Array.from(card.title).length >= 1 && Array.from(card.title).length <= 200);
  assert.ok(Array.from(card.summary).length >= 20 && Array.from(card.summary).length <= 2000);
  assert.equal(card.title, listed.title);
  assert.equal(typeof card.summary, 'string');
  assert.equal(card.installable, 5);
  assert.equal(card.declared, 1);
  assert.equal(card.warning, null);
  assert.ok(!JSON.stringify(json).includes(unlisted.id));
  assert.deepEqual(await (await galleryJSON()).json(), json, 'visitor cookies must not change a cached response');
  const stored = JSON.parse(stores.get('gallery').data.get(listed.id));
  stores.get('gallery').data.set(listed.id, JSON.stringify({...stored, owner_confirmed:false, title:'A & <B>', delete_token:'must-not-leak', body:'must-not-leak'}));
  const changed = (await (await galleryJSON()).json()).cards[0];
  assert.equal(changed.summary, stored.summary, 'summary must not be truncated');
  assert.equal(changed.title, 'A & <B>', 'JSON carries text, not HTML entities');
  assert.equal(changed.owner_confirmed, false);
  assert.equal(changed.warning, 'Did not confirm this description');
  assert.ok(!JSON.stringify(changed).includes('must-not-leak'));
  stores.get('gallery').data.set(listed.id, JSON.stringify({...stored, category:'retired-category', listed_at:null}));
  const retired = (await (await galleryJSON()).json()).cards[0];
  assert.equal(retired.category, 'retired-category');
  assert.equal(retired.category_label, '');
  assert.equal(retired.listed_at, null);
});

test('gallery.json: phaeacia.ai pagination terminates, is ordered and excludes stale listings', async () => {
  reset();
  const ids = [];
  for (let i = 0; i < 26; i++) ids.push((await body(await upload(listedReq(distinct())))).id);
  const first = await (await galleryJSON()).json();
  assert.equal(first.cards.length, 24);
  assert.equal(first.next, '/gallery.json?page=2');
  const second = await (await galleryJSON('?page=2')).json();
  assert.equal(second.cards.length, 2);
  assert.equal(second.next, null);
  assert.equal(new Set([...first.cards,...second.cards].map(c=>c.url)).size, 26);
  assert.deepEqual(await (await galleryJSON('?page=3')).json(), {version:1,cards:[],next:null});
  for (const page of ['-1','0','NaN','1.5','']) {
    const bad = await galleryJSON('?page='+page);
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), {error:'E_BAD_PAGE'});
  }
  for (const page of ['9007199254740992', '9'.repeat(400)]) {
    const past = await galleryJSON('?page='+page);
    assert.equal(past.status, 200);
    assert.deepEqual(await past.json(), {version:1,cards:[],next:null});
  }
  const head = await galleryJSON('', 'HEAD');
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal((await galleryJSON('', 'POST')).status, 405);
  stores.get('passports').data.delete(ids[0]); stores.get('passports').meta.delete(ids[0]);
  assert.ok(!(await (await galleryJSON()).text()).includes(ids[0]));
});

test('gallery.json: phaeacia.ai distinguishes an empty gallery from a store outage', async () => {
  reset();
  assert.deepEqual(await (await galleryJSON()).json(), {version:1,cards:[],next:null});
  const galleryStore = stores.get('gallery');
  galleryStore.list = async () => { throw new Error('private infrastructure detail'); };
  const res = await galleryJSON();
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), {error:'E_GALLERY_UNAVAILABLE'});
});


test('gallery.json: phaeacia.ai receives 503 for partial card or metadata read failure', async () => {
  for (const which of ['card', 'metadata']) {
    reset();
    const listed = await body(await upload(listedReq(distinct())));
    const target = stores.get(which === 'card' ? 'gallery' : 'passports');
    const method = which === 'card' ? 'get' : 'getMetadata';
    const original = target[method];
    target[method] = async function(key, ...args) {
      if (key === listed.id) throw new Error('temporary read failure');
      return original.call(this, key, ...args);
    };
    const response = await galleryJSON();
    assert.equal(response.status, 503, which);
    assert.deepEqual(await response.json(), {error: 'E_GALLERY_UNAVAILABLE'});
    assert.ok(stores.get('gallery').data.has(listed.id), 'unknown card must not be deleted');
  }
});

/* ══ M1: a POST that a page on another site sent ═════════════════════════════
   lib/_origin.mjs has the rule. The header shapes below are the ones Chrome
   154 sent on 2026-09-30 against a local server that served its pages with
   Referrer-Policy: no-referrer, as this app does
   (record/findings/a-same-origin-form-post-here-sends-origin-null.md); ORIGIN
   stands in for the site's own origin. Every refusal is checked for its status
   AND for having written nothing at all, because a guard placed after the
   limiter would still refuse, and would still charge the visitor for it. */

const { crossSite, mediaType } = await import('../lib/_origin.mjs');
const FOREIGN = 'https://elsewhere.example';
const PREVIEW = 'https://deploy-preview-9--app-phaeacia.netlify.app';
const SHAPES = {
  /* this site's own pages: every fetch call, and the vote form with script off */
  ownFetch:     { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
  ownForm:      { origin: 'null', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' },
  /* a browser too old for Sec-Fetch-Site, fetching from this site */
  oldOwnFetch:  { origin: ORIGIN },
  /* scripts/publish.py and anything else that is not a browser */
  script:       {},
  /* another site: fetch in no-cors mode, a plain form, a form on a page that
     set no-referrer on itself (a sandboxed frame sends the same), a subdomain,
     and the value a browser sends only for what its own interface started */
  foreignFetch: { origin: FOREIGN, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' },
  foreignForm:  { origin: FOREIGN, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
  foreignNull:  { origin: 'null', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
  sameSite:     { origin: 'https://www.phaeacia.test', 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' },
  none:         { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' },
  /* another site, in a browser too old for Sec-Fetch-Site */
  oldForeign:   { origin: FOREIGN },
  oldNull:      { origin: 'null' }
};
const ACCEPTED = ['ownFetch', 'ownForm', 'oldOwnFetch', 'script'];
const REFUSED = ['foreignFetch', 'foreignForm', 'foreignNull', 'sameSite', 'none', 'oldForeign', 'oldNull'];

test('M1: crossSite() lets this site and scripts through and refuses every other shape, each by its own rule', () => {
  const at = (headers, url = ORIGIN + '/api/vote') => crossSite(new Request(url, { method: 'POST', headers }));
  const expected = {
    ownFetch: null, ownForm: null, oldOwnFetch: null, script: null,
    foreignFetch: 'sec-fetch-site', foreignForm: 'sec-fetch-site', foreignNull: 'sec-fetch-site',
    sameSite: 'sec-fetch-site', none: 'sec-fetch-site',
    oldForeign: 'origin', oldNull: 'origin-null'
  };
  assert.deepEqual(Object.keys(expected).sort(), Object.keys(SHAPES).sort());
  assert.deepEqual([...ACCEPTED, ...REFUSED].sort(), Object.keys(SHAPES).sort());
  for (const [name, headers] of Object.entries(SHAPES)) {
    assert.equal(at(headers), expected[name], name);
    assert.equal(expected[name] === null, ACCEPTED.includes(name), name + ' is on the wrong list');
  }

  /* The request's own origin, not a fixed one: a preview's page posting to that
     preview passes, and neither host passes for the other. */
  assert.equal(at({ origin: PREVIEW, 'sec-fetch-site': 'same-origin' }, PREVIEW + '/api/vote'), null);
  assert.equal(at({ origin: PREVIEW }, PREVIEW + '/api/vote'), null);
  assert.equal(at({ origin: ORIGIN }, PREVIEW + '/api/vote'), 'origin');
  assert.equal(at({ origin: PREVIEW }, ORIGIN + '/api/vote'), 'origin');

  /* Exactly the origin as a browser serialises it: no path, no trailing slash,
     the same scheme and port, lower case, one value. */
  for (const near of [ORIGIN + '/', ORIGIN.replace('https:', 'http:'), ORIGIN + ':8443',
    ORIGIN.toUpperCase(), `${ORIGIN}, ${FOREIGN}`, 'app.phaeacia.test', '']) {
    assert.equal(at({ origin: near }), 'origin', JSON.stringify(near));
  }
  /* A request that says same-origin while naming another origin did not come
     from a browser, and a Sec-Fetch-Site value is compared exactly. */
  assert.equal(at({ origin: FOREIGN, 'sec-fetch-site': 'same-origin' }), 'origin');
  assert.equal(at({ 'sec-fetch-site': 'Same-Origin' }), 'sec-fetch-site');
  assert.equal(at({ 'sec-fetch-site': '' }), 'sec-fetch-site');

  const typed = (ct) => mediaType(new Request(ORIGIN, { method: 'POST', headers: ct === null ? {} : { 'content-type': ct } }));
  assert.equal(typed('Application/JSON; charset=utf-8'), 'application/json');
  assert.equal(typed(' application/json '), 'application/json');
  assert.equal(typed('text/plain'), 'text/plain');
  assert.equal(typed(null), '');
});

/* Every store's keys, values and metadata, so "nothing was written" is a
   comparison rather than a list of places somebody thought to look. */
const everything = () => JSON.stringify([...stores.entries()].map(([name, s]) =>
  [name, [...s.data.entries()], [...s.meta.entries()]]));

/* One case per guarded function, keyed by its file name so the census test
   below can hold this list and the .mjs files to each other. `make` builds
   the request with extra headers; `setup` publishes whatever the request
   needs; `done` asserts that an accepted request really did its work. */
const JSONH = { 'content-type': 'application/json' };
const GUARDED = {
  'vote.mjs': [
    { shape: 'fetch', expect: 200,
      setup: async () => ({ id: (await body(await upload(listedReq(distinct())))).id }),
      make: (s, h) => vote(post('/api/vote', JSON.stringify({ id: s.id, dir: 'up' }), { ...JSONH, ...h })),
      done: (s) => assert.equal(JSON.parse(stores.get('votes-count').data.get(tallyKeyFor(s.id))).up, 1) },
    { shape: 'form', expect: 303,
      setup: async () => ({ id: (await body(await upload(listedReq(distinct())))).id }),
      make: (s, h) => vote(post('/api/vote', new URLSearchParams({ id: s.id, dir: 'up' }).toString(),
        { 'content-type': 'application/x-www-form-urlencoded', ...h })),
      done: (s) => assert.equal(JSON.parse(stores.get('votes-count').data.get(tallyKeyFor(s.id))).up, 1) }
  ],
  'copied.mjs': [
    { shape: 'fetch', expect: 204, bodyless: true,
      setup: async () => ({ id: (await publish()).id }),
      make: (s, h) => copied(post('/api/copied', JSON.stringify({ id: s.id }), { ...JSONH, ...h })),
      done: (s) => assert.equal(JSON.parse(stores.get('copies').data.get(s.id)).n, 1) }
  ],
  'copied-prompt.mjs': [
    { shape: 'fetch', expect: 204, bodyless: true,
      setup: async () => ({}),
      make: (s, h) => copiedPrompt(post('/api/copied-prompt', JSON.stringify({ path: 'f' }), { ...JSONH, ...h })),
      done: () => assert.equal(countPromptClicks('f'), 1) }
  ],
  'upload.mjs': [
    { shape: 'fetch', expect: 200,
      setup: async () => ({ text: distinct() }),
      make: (s, h) => upload(uploadReq(s.text, h)),
      done: (s, j) => assert.ok(stores.get('passports').data.has(j.id)) }
  ],
  'manage.mjs': [
    { shape: 'fetch', expect: 200,
      setup: async () => publish(),
      make: (s, h) => manage(post('/api/manage', JSON.stringify({ id: s.id, token: s.delete_token, action: 'status' }), { ...JSONH, ...h })),
      done: (s, j) => assert.equal(j.status.listed, false) }
  ],
  'delete-passport.mjs': [
    { shape: 'fetch', expect: 200,
      setup: async () => publish(),
      make: (s, h) => remove(post('/api/delete', JSON.stringify({ id: s.id, token: s.delete_token }), { ...JSONH, ...h })),
      done: (s) => assert.equal(stores.get('passports').data.has(s.id), false) }
  ],
  'subscribe.mjs': [
    { shape: 'fetch', expect: 200,
      setup: async () => publish(),
      make: (s, h) => subscribe(post('/api/subscribe',
        JSON.stringify({ id: s.id, token: s.delete_token, email: 'reader@example.com', consent: true }), { ...JSONH, ...h })),
      done: () => assert.equal(calls.length, 1) }
  ],
  'send.mjs': [
    { shape: 'fetch', expect: 200,
      setup: async () => publish(),
      make: (s, h) => send(post('/api/send',
        JSON.stringify({ id: s.id, token: s.delete_token, to: 'friend@example.com' }), { ...JSONH, ...h })),
      done: (s, j) => {
        assert.equal(j.ok, true);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].body.to, ['friend@example.com']);
      } }
  ],
  'hold-email.mjs': [
    { shape: 'fetch', expect: 200,
      setup: async () => makeHold(),
      make: (s, h) => holdEmailFn(post('/api/hold-email',
        JSON.stringify({ hold_id: s.hold_id, hold_token: s.hold_token, email: 'owner@example.com' }), { ...JSONH, ...h })),
      done: (s, j) => assert.equal(j.ok, true) }
  ]
};

test('M1: every guarded endpoint refuses each shape another site can send, 403, and writes nothing', async () => {
  let n = 0;
  for (const [file, cases] of Object.entries(GUARDED)) {
    for (const c of cases) {
      for (const name of REFUSED) {
        reset();
        const s = await c.setup();
        const before = everything();
        const sentBefore = calls.length, jevBefore = jevCalls;
        const res = await c.make(s, SHAPES[name]);
        const where = `${file} ${c.shape}, ${name}`;
        assert.equal(res.status, 403, where);
        if (c.bodyless) {
          assert.equal(await res.text(), '', where + ' carried a body');
        } else {
          const j = await body(res);
          assert.equal(j.ok, false, where);
          assert.equal(j.code, 'E_CROSS_SITE', where);
        }
        assert.equal(res.headers.get('set-cookie'), null, where + ' set a cookie');
        assert.equal(res.headers.get('location'), null, where + ' redirected');
        assert.equal(everything(), before, where + ' wrote to a store');
        assert.equal(calls.length, sentBefore, where + ' called the mail provider');
        assert.equal(jevCalls, jevBefore, where + ' called the Jev gate');
        n++;
      }
    }
  }
  assert.equal(n, REFUSED.length * Object.values(GUARDED).flat().length);
});

test('M1: every guarded endpoint still does its work for this site\'s own pages and for a script', async () => {
  for (const [file, cases] of Object.entries(GUARDED)) {
    for (const c of cases) {
      for (const name of ACCEPTED) {
        reset();
        const s = await c.setup();
        const res = await c.make(s, SHAPES[name]);
        const where = `${file} ${c.shape}, ${name}`;
        assert.equal(res.status, c.expect, where + ': ' + (c.bodyless || c.expect === 303 ? '' : await res.clone().text()));
        const j = c.bodyless || c.expect === 303 ? null : await body(res);
        c.done(s, j);
      }
    }
  }
});

test('M1: the vote control\'s own form, script off, votes and redirects exactly as before', async () => {
  reset();
  const { id } = await body(await upload(listedReq(distinct())));
  const res = await vote(post('/api/vote', new URLSearchParams({ id, dir: 'up', back: 'gallery' }).toString(),
    { 'content-type': 'application/x-www-form-urlencoded', ...SHAPES.ownForm }));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/gallery');
  assert.match(cookieOf(res) || '', /^pv=/);
  assert.equal(JSON.parse(stores.get('votes-count').data.get(tallyKeyFor(id))).up, 1);
});

test('M1: the two copy counters take application/json and nothing else, from any caller', async () => {
  const counters = [
    ['copied', async () => ({ id: (await publish()).id }), (s) => JSON.stringify({ id: s.id }),
      (s, h) => copied(post('/api/copied', JSON.stringify({ id: s.id }), h)),
      (s) => (stores.get('copies')?.data.has(s.id) ? JSON.parse(stores.get('copies').data.get(s.id)).n : 0)],
    ['copied-prompt', async () => ({}), null,
      (s, h) => copiedPrompt(post('/api/copied-prompt', JSON.stringify({ path: 'f' }), h)),
      () => countPromptClicks('f')]
  ];
  for (const [label, setup, , send, count] of counters) {
    for (const ct of ['text/plain', 'text/plain; charset=utf-8', 'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x', 'application/jsonx', null]) {
      reset();
      const s = await setup();
      const before = everything();
      const res = await send(s, ct === null ? {} : { 'content-type': ct });
      assert.equal(res.status, 415, `${label} ${ct}`);
      assert.equal(await res.text(), '');
      assert.equal(everything(), before, `${label} ${ct} wrote to a store`);
      assert.equal(count(s), 0);
    }
    reset();
    const s = await setup();
    const res = await send(s, { 'content-type': 'Application/JSON; charset=utf-8' });
    assert.equal(res.status, 204, label);
    assert.equal(count(s), 1, label);
  }
});

test('M1: a deploy preview\'s own pages still count and vote there, and a production page cannot post to it', async () => {
  reset();
  const at = (path, obj, headers) => new Request(PREVIEW + path, {
    method: 'POST', body: JSON.stringify(obj),
    headers: { 'x-nf-client-connection-ip': freshIp(), ...JSONH, ...headers }
  });
  const own = { origin: PREVIEW, 'sec-fetch-site': 'same-origin' };
  const published = await upload(new Request(PREVIEW + '/api/upload', {
    method: 'POST', body: distinct(),
    headers: { 'x-nf-client-connection-ip': freshIp(), 'content-type': 'text/markdown', ...own,
      'x-passport-list': '1', 'x-passport-category': CATEGORY }
  }), previewCtx);
  assert.equal(published.status, 200, 'the preview\'s own upload page was refused on the preview');
  const { id } = await body(published);
  assert.ok(stores.get('dp-pr-501-passports').data.has(id), 'the preview publish did not land in its scope');

  assert.equal((await copied(at('/api/copied', { id }, own), previewCtx)).status, 204);
  assert.equal(JSON.parse(stores.get('dp-pr-501-copies').data.get(id)).n, 1);
  const voted = await vote(at('/api/vote', { id, dir: 'up' }, own), previewCtx);
  assert.equal(voted.status, 200);
  assert.equal((await body(voted)).up, 1);

  const before = everything();
  const fromProduction = { origin: ORIGIN, 'sec-fetch-site': 'cross-site' };
  assert.equal((await copied(at('/api/copied', { id }, fromProduction), previewCtx)).status, 403);
  assert.equal((await vote(at('/api/vote', { id, dir: 'down' }, { origin: ORIGIN }), previewCtx)).status, 403);
  assert.equal(everything(), before);
});

test('M1: scripts/publish.py, and the skill\'s copy of it, still publish, sending neither Origin nor Sec-Fetch-Site', async () => {
  reset();
  const http = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { fileURLToPath } = await import('node:url');
  const { join } = await import('node:path');

  /* The real upload handler behind a loopback socket, standing in for the
     platform: the request URL is built from the Host header, as Netlify's is,
     and the client address header is the one its edge adds. */
  const seen = [];
  const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive']);
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen.push({ ...req.headers });
    const headers = { 'x-nf-client-connection-ip': freshIp() };
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
    const answer = await upload(new Request(`http://${req.headers.host}${req.url}`,
      { method: req.method, headers, body: Buffer.concat(chunks) }));
    res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') || 'text/plain' });
    res.end(Buffer.from(await answer.arrayBuffer()));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/upload`;
  const dir = await mkdtemp(join(tmpdir(), 'm1-publish-'));
  try {
    for (const script of ['scripts/publish.py', 'skills/agent-passport/scripts/publish.py']) {
      const file = join(dir, `run${seen.length}-passport.md`);
      await writeFile(file, distinct());
      /* The endpoint twice over, argument and environment, so no mistake in
         this test can make it publish to the real site. */
      const run = await new Promise((resolve) => {
        const p = spawn('python3', [fileURLToPath(new URL('../../' + script, import.meta.url)), file, '--endpoint', endpoint],
          { env: { ...process.env, PHAEACIA_UPLOAD_ENDPOINT: endpoint } });
        let out = '', errOut = '';
        p.stdout.on('data', d => { out += d; });
        p.stderr.on('data', d => { errOut += d; });
        p.on('close', code => resolve({ code, out, errOut }));
      });
      assert.equal(run.code, 0, `${script} did not publish: ${run.errOut}`);
      assert.match(run.out.trim().split('\n').pop(), /\/p\/[0-9a-f-]{36}$/, `${script} did not end with the link`);
      const sent = seen[seen.length - 1];
      assert.ok(sent, `${script} never reached the server`);
      assert.equal(sent.origin, undefined, `${script} sent an Origin`);
      assert.equal(sent['sec-fetch-site'], undefined, `${script} sent Sec-Fetch-Site`);
      assert.match(sent['content-type'], /^text\/markdown/);
    }
    assert.equal(seen.length, 2);
    assert.equal(stores.get('passports').data.size, 2);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('M1: every function is either guarded and tested above, or named here with the reason it is not', async () => {
  const { readdir, readFile: read } = await import('node:fs/promises');
  const dir = new URL('../netlify/functions/', import.meta.url);
  const files = (await readdir(dir)).filter(f => f.endsWith('.mjs')).sort();
  const NOT_GUARDED = {
    'check-hold.mjs': 'reads a hold and changes nothing but its own limiter entry',
    'passport.mjs': 'serves the passport page',
    'gallery.mjs': 'serves the gallery page',
    'gallery-json.mjs': 'serves the gallery to phaeacia.ai, GET and HEAD only',
    'og.mjs': 'serves social card images',
    'sweep.mjs': 'scheduled; the platform calls it, no page does',
    'recount.mjs': 'scheduled; the platform calls it, no page does',
    'digest.mjs': 'no route and no page calls it; it checks for the scheduler\'s shape itself'
  };
  const guarded = Object.keys(GUARDED);
  assert.deepEqual([...guarded, ...Object.keys(NOT_GUARDED)].sort(), files,
    'a function is on neither list, or on one that names a file that is gone: decide which list it belongs on');
  for (const f of files) {
    const src = await read(new URL(f, dir), 'utf8');
    const imports = /from '\.\.\/\.\.\/lib\/_origin\.mjs'/.test(src);
    assert.equal(imports, guarded.includes(f),
      imports ? `${f} imports the guard but is not tested above: add its case to GUARDED`
              : `${f} is on GUARDED but does not import lib/_origin.mjs`);
  }
});

/* ══ archive mode ══════════════════════════════════════════
   ARCHIVE_MODE=1 turns the app into a read-only showcase (lib/_archive.mjs,
   README.md "Archive mode"). Reads and withdrawal keep working; every write
   that creates data or sends mail stops. The status, the code and the
   repository address are literals here, not imports: the capture skill's
   publish.py keys on 410, so a change to the constant has to fail this file
   rather than move the contract with it. */
const ARCHIVE_REPO_URL = 'https://github.com/Phaeacia-ai/phaeacia-agent-passport';
const inArchive = async (fn) => {
  process.env.ARCHIVE_MODE = '1';
  try { return await fn(); } finally { delete process.env.ARCHIVE_MODE; }
};
/* Every key and value in every store, so "nothing was written" covers the
   limiter, the counters and the corpora as well as the passport rows. */
const everyStore = () => JSON.stringify([...stores].sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([name, s]) => [name, [...s.data].sort()]));

test('archive mode: off by default, and 0 or false keep it off, so an upload publishes as before', async () => {
  reset();
  assert.equal(process.env.ARCHIVE_MODE, undefined, 'the suite must start with archive mode unset');
  await publish();
  for (const off of ['0', 'false', '']) {
    process.env.ARCHIVE_MODE = off;
    try { await publish(); } finally { delete process.env.ARCHIVE_MODE; }
  }
  assert.equal(stores.get('passports').data.size, 4);
});

test('archive mode: an upload is refused with 410 and code archived, and nothing is stored', async () => {
  reset();
  const before = everyStore();
  for (const req of [uploadReq(distinct()), listedReq(distinct())]) {
    const res = await inArchive(() => upload(req));
    assert.equal(res.status, 410, 'publish.py relies on exactly 410');
    assert.match(res.headers.get('content-type') || '', /^application\/json/);
    const j = await body(res);
    assert.equal(j.ok, false);
    assert.equal(j.code, 'archived');
    assert.ok(j.message.includes(ARCHIVE_REPO_URL), 'the message must name the repository: ' + j.message);
    assert.ok(/unchanged on your machine/.test(j.message), 'the message must say the file is unchanged: ' + j.message);
  }
  assert.equal(everyStore(), before, 'a refused upload wrote to a store, the limiter included');
  assert.equal(jevCalls, 0, 'a refused upload reached the third-party check');
});

test('archive mode: a vote is refused in both shapes, sets no cookie and writes nothing', async () => {
  reset();
  const { id } = await body(await upload(listedReq(distinct())));
  const before = everyStore();
  const j = await inArchive(() => voteJson({ id, dir: 'up' }));
  assert.equal(j.status, 410);
  assert.equal((await body(j)).code, 'archived');
  assert.equal(j.headers.get('set-cookie'), null, 'an archived vote set the vote cookie');
  const form = await inArchive(() => voteForm({ id, dir: 'up' }));
  assert.equal(form.status, 303, 'the no-script form goes back to the page it came from');
  assert.equal(form.headers.get('location'), `/p/${id}`);
  assert.equal(form.headers.get('set-cookie'), null);
  assert.equal(everyStore(), before, 'an archived vote wrote to a store');
});

test('archive mode: the owner can still delete a passport with its token', async () => {
  reset();
  const { id, delete_token: token } = await body(await upload(listedReq(distinct())));
  const res = await inArchive(() => remove(jsonReq('/api/delete', { id, token })));
  assert.equal(res.status, 200);
  assert.equal((await body(res)).ok, true);
  assert.equal(stores.get('passports').data.has(id), false);
  assert.equal(stores.get('gallery').data.has(id), false, 'the gallery card outlived the delete');
  assert.equal((await inArchive(() => page(id))).status, 404);
});

test('archive mode: status and unlist still work, listing and renewing are refused', async () => {
  reset();
  const listed = await body(await upload(listedReq(distinct())));
  const plain = await publish();
  const before = JSON.stringify([rowShape(plain.id), rowShape(listed.id)]);

  const status = await inArchive(() => manageReq({ id: plain.id, token: plain.delete_token, action: 'status' }));
  assert.equal(status.status, 200);
  for (const action of ['renew', 'list']) {
    const res = await inArchive(() => manageReq({ id: plain.id, token: plain.delete_token, action, category: CATEGORY }));
    assert.equal(res.status, 410, action + ' was not refused');
    assert.equal((await body(res)).code, 'archived');
  }
  assert.equal(JSON.stringify([rowShape(plain.id), rowShape(listed.id)]), before, 'a refused action changed a row');

  const un = await inArchive(() => manageReq({ id: listed.id, token: listed.delete_token, action: 'unlist' }));
  assert.equal(un.status, 200);
  assert.equal((await body(un)).status.listed, false);
  assert.equal(stores.get('gallery').data.has(listed.id), false, 'unlisting must still take the card down');
});

test('archive mode: gallery.json answers byte for byte as it does with the flag off', async () => {
  reset();
  await body(await upload(listedReq(distinct())));
  await body(await upload(listedReq(distinct(), 'writing-and-editing')));
  for (const query of ['', '?page=1', '?page=2', '?page=x']) {
    const off = await galleryJSON(query);
    const on = await inArchive(() => galleryJSON(query));
    assert.equal(on.status, off.status, query);
    assert.deepEqual(headerMap(on), headerMap(off), query);
    assert.equal(await on.text(), await off.text(), 'the phaeacia.ai contract changed in archive mode: ' + query);
  }
});

test('archive mode: the gallery page is served with the notice and without vote controls', async () => {
  reset();
  const listed = await body(await upload(listedReq(distinct())));
  const off = await (await galleryPage()).text();
  assert.ok(off.includes('action="/api/vote"'), 'control: the open gallery has vote controls');
  assert.equal(off.includes('archive-notice'), false, 'control: the open gallery has no notice');

  const res = await inArchive(() => galleryPage());
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('class="archive-notice"'), 'no archive notice on /gallery');
  assert.ok(html.includes(`href="${ARCHIVE_REPO_URL}"`), 'the notice does not link the repository');
  assert.ok(html.includes(`/p/${listed.id}`), 'the archived gallery lost its cards');
  assert.equal(html.includes('action="/api/vote"'), false, 'the archived gallery still offers a vote');
});

test('archive mode: a passport page is served with the notice, no vote control, and counts no view', async () => {
  reset();
  const { id } = await body(await upload(listedReq(distinct())));
  await page(id);
  const before = everyStore();
  const res = await inArchive(() => page(id));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('class="archive-notice"'));
  assert.ok(/<html[^>]*\bdata-archived\b/.test(html), 'the page is not marked archived for the stylesheet');
  assert.equal(html.includes('action="/api/vote"'), false, 'an archived passport page still offers a vote');
  assert.equal(everyStore(), before, 'an archived page view wrote to a store');

  for (const other of ['example', '00000000-0000-4000-8000-000000000000']) {
    const r = await inArchive(() => page(other));
    assert.ok((await r.text()).includes('class="archive-notice"'), other + ' has no archive notice');
  }
});

test('archive mode: sending, subscribing and leaving an address are refused, and no mail goes out', async () => {
  reset();
  const { id, delete_token: token } = await publish();
  const hold = await makeHold();
  outbox.length = 0; calls.length = 0;
  const before = everyStore();

  const sendGet = await inArchive(() => send(new Request(ORIGIN + '/api/send')));
  assert.deepEqual(await body(sendGet), { ok: true, enabled: false }, 'the send box would still draw');
  const subGet = await inArchive(() => subscribe(new Request(ORIGIN + '/api/subscribe')));
  assert.deepEqual(await body(subGet), { ok: true, enabled: false }, 'the subscribe box would still draw');

  for (const [fn, path, payload] of [
    [send, '/api/send', { id, token, to: 'friend@example.com' }],
    [subscribe, '/api/subscribe', { id, token, email: 'me@example.com', consent: true }],
    [holdEmailFn, '/api/hold-email', { hold_id: hold.hold_id, hold_token: hold.hold_token, email: 'me@example.com' }]
  ]) {
    const res = await inArchive(() => fn(jsonReq(path, payload)));
    assert.equal(res.status, 410, path + ' was not refused');
    assert.equal((await body(res)).code, 'archived', path);
  }
  assert.equal(outbox.length + calls.length, 0, 'archive mode reached the mail provider');
  assert.equal(everyStore(), before, 'a refused send, subscribe or address wrote to a store');
});

test('archive mode: the copy counters count nothing', async () => {
  reset();
  const { id } = await publish();
  const before = everyStore();
  const a = await inArchive(() => copied(jsonReq('/api/copied', { id })));
  const b = await inArchive(() => copiedPrompt(jsonReq('/api/copied-prompt', { path: 'f' })));
  assert.equal(a.status, 410);
  assert.equal(b.status, 410);
  assert.equal(everyStore(), before, 'an archived copy press was counted');
});

test('archive mode: the digest sends nothing and claims no day', async () => {
  reset();
  process.env.DIGEST_TO = 'digest@example.test';
  try {
    const before = everyStore();
    const res = await inArchive(() => digest(scheduledDigest(), prodCtx));
    assert.equal(res.status, 200);
    const j = await body(res);
    assert.equal(j.sent, false);
    assert.equal(j.reason, 'archived');
    assert.equal(outbox.length, 0, 'the archived digest sent mail');
    assert.equal(everyStore(), before, 'the archived digest claimed a day');
  } finally {
    delete process.env.DIGEST_TO;
  }
});

test('archive mode: the sweep still deletes an expired passport and an expired hold, and mails nobody', async () => {
  reset();
  const dead = await publish();
  const passports = stores.get('passports');
  const row = JSON.parse(passports.data.get(dead.id));
  row.expires_at = new Date(Date.now() - 1000).toISOString();
  passports.data.set(dead.id, JSON.stringify(row));
  passports.meta.set(dead.id, { h: row.delete_token_hash, x: Date.parse(row.expires_at) });
  const expiry = stores.get('expiry');
  for (const k of [...expiry.data.keys()]) if (k.endsWith(':' + dead.id)) expiry.data.delete(k);
  expiry.data.set(`${String(Date.parse(row.expires_at)).padStart(16, '0')}:${dead.id}`, '1');

  const hold = await makeHold();
  await holdEmailFn(jsonReq('/api/hold-email', { hold_id: hold.hold_id, hold_token: hold.hold_token, email: 'held@example.com' }));
  const holds = stores.get('holds');
  const holdExpiry = stores.get('hold-expiry');
  const hrow = JSON.parse(holds.data.get(hold.hold_id));
  hrow.expires_at = new Date(Date.now() - 1000).toISOString();
  holds.data.set(hold.hold_id, JSON.stringify(hrow));
  for (const k of [...holdExpiry.data.keys()]) if (k.endsWith(':' + hold.hold_id)) holdExpiry.data.delete(k);
  holdExpiry.data.set(`${String(Date.parse(hrow.expires_at)).padStart(16, '0')}:${hold.hold_id}`, '1');
  outbox.length = 0; calls.length = 0;

  const j = await body(await inArchive(() => sweepFn(scheduledReq())));
  assert.equal(j.ok, true, JSON.stringify(j));
  assert.equal(passports.data.has(dead.id), false, 'the archived sweep kept an expired passport');
  assert.equal(holds.data.has(hold.hold_id), false, 'the archived sweep kept an expired hold');
  assert.equal(stores.get('hold-email').data.has(hold.hold_id), false, 'the held address outlived its hold');
  assert.equal(j.holdMailsWithheld, 1, 'the withheld expiry mail is not counted: ' + JSON.stringify(j));
  assert.equal(outbox.length + calls.length, 0, 'the archived sweep mailed a held uploader');
});

test('archive mode: every function has a decision, and the ones that change read the flag', async () => {
  const { readdir, readFile: read } = await import('node:fs/promises');
  const dir = new URL('../netlify/functions/', import.meta.url);
  const files = (await readdir(dir)).filter(f => f.endsWith('.mjs')).sort();
  /* The same list README.md prints under "Archive mode". */
  const DECISION = {
    'upload.mjs': 'refused: 410 archived',
    'vote.mjs': 'refused: 410 archived, the form path redirects back',
    'manage.mjs': 'list and renew refused; status and unlist kept',
    'send.mjs': 'refused; GET says enabled: false',
    'subscribe.mjs': 'refused; GET says enabled: false',
    'hold-email.mjs': 'refused',
    'copied.mjs': 'counts nothing, 410',
    'copied-prompt.mjs': 'counts nothing, 410',
    'passport.mjs': 'served with the notice, no vote control, no view counted',
    'gallery.mjs': 'served with the notice, no vote controls',
    'digest.mjs': 'sends nothing',
    'sweep.mjs': 'still deletes; withholds the hold expiry mail',
    'delete-passport.mjs': null,
    'check-hold.mjs': null,
    'gallery-json.mjs': null,
    'og.mjs': null,
    'recount.mjs': null
  };
  assert.deepEqual(Object.keys(DECISION).sort(), files,
    'a function has no archive-mode decision, or the list names one that is gone');
  for (const f of files) {
    const src = await read(new URL(f, dir), 'utf8');
    assert.equal(/\barchiveMode\(/.test(src), DECISION[f] !== null,
      DECISION[f] === null ? `${f} is listed as unchanged but reads the flag` : `${f} is listed as changed but never reads the flag`);
  }
  const edge = await read(new URL('../netlify/edge-functions/count.ts', import.meta.url), 'utf8');
  assert.ok(edge.includes('ARCHIVE_MODE'), 'the edge page counter does not read the flag');
});

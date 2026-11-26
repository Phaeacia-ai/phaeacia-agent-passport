/* _store-core.mjs

   The bottom of the family: every other _store-*.mjs imports from here, and
   this file imports from none of them.

   Holds the store-factory test seam (`factory`, `__useStoreFactory`), deploy
   scoping (`deployScope`), the WRITE half of the scope registry
   (`registerScope`, which `strong()` calls on every scoped open; the teardown
   half is _store-scopes.mjs), `strong()` itself, the sha256 and UUID
   primitives, the two time constants, and `drop` / `scan`, the bounded bulk
   delete and list that every sweeper in the family shares. Those two live here
   rather than in _store-expiry.mjs because _store-listing.mjs needs `drop` and
   _store-expiry.mjs needs _store-listing.mjs; the other way round is an import
   cycle.

   `factory` is a `let` and is exported as a live binding on purpose: a test
   double installed through `__useStoreFactory` is seen by every module that
   imports `factory`, because an importer reads the binding at call time.

   Stores opened here: scopes.

   Exports that _store.mjs does not re-export are internal to the _store-*.mjs family. */

import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';

/* One indirection, and it is a test seam rather than an abstraction. Netlify
   Blobs needs a Netlify runtime, so the suite in tools/run-tests.mjs swaps in an
   in-memory double here and exercises the real logic in the _store-*.mjs modules against it.
   Node's own module mocking is behind an experimental flag, and a test suite
   that only runs with a flag is a test suite that stops being run.

   Production never calls the setter. If it ever does, that is a bug rather than
   a feature to build on.

   DO NOT MEMOISE THIS INTO A MODULE-LEVEL STORE MAP. The factory is DEFINED at
   module scope and INVOKED per call, which means `getStore` runs inside the
   handler's execution context, where Netlify has injected the blob credentials.
   A module-level `getStore(...)`, or a cache built around one, runs before that
   injection and throws MissingBlobsEnvironmentError. It is the most common
   reported failure with Netlify Blobs.

   This matters more since the sweep moved to a schedule. A request handler that
   cannot open a store fails a request somebody is watching. The scheduled sweep
   has nobody watching, so the same fault is a maintenance job that quietly stops
   running. The saving from caching a store handle is one object allocation; the
   cost is a class of failure that only appears in production. */
export let factory = name => getStore({ name, consistency: 'strong' });
export function __useStoreFactory(f) { factory = f; }

/* ── deploy scoping, ROW-37 ─────────────────────────────────
   Every function in the _store-*.mjs modules that used to call `strong(name)`
   now calls `strong(deploy, name)`, where `deploy` is `context.deploy` from the Netlify
   handler's second argument, THREADED IN FROM THE HANDLER, NEVER READ FROM
   `process.env`. `process.env.CONTEXT` is a build-time variable and is never
   set at function runtime — see
   record/findings/the-deploy-scope-guard-reads-an-environment-that-is-never-set.md,
   which is the branch this replaces and the reason it was never merged.
   `context.deploy` IS delivered at runtime, on every invocation, as the
   handler's second argument (`@netlify/serverless-functions-api` builds it
   from the `x-nf-deploy-*` request headers), and `passport.mjs` and
   `sweep.mjs` were already reading `context.deploy.context` before this file
   used it for anything.

   ALLOWLIST, NOT A DENYLIST, and this is the one design decision in this
   section that matters more than the rest of it put together. Only a
   `deploy.context` this file can name for certain is NOT production earns a
   separate, scoped store. Everything else — no `deploy` object at all (a
   local run, a test, or a request Netlify genuinely did not attach one to),
   a `context` field this file does not recognise, or `context.deploy.context
   === 'production'` — resolves to the SAME bare, unscoped name production
   has always used.

   That asymmetry is deliberate and was worked out before this file existed:
   wrongly SCOPING a production request is catastrophic (every existing
   passport lives under the bare name and becomes unreachable at once);
   wrongly leaving a preview BARE is exactly today's hazard, unchanged rather
   than worsened. See record/decisions/strike-s1-do-not-merge-scope-stores-by-deploy.md
   for the fuller accounting, including the two traps this design avoids by
   construction: `NETLIFY_BLOBS_CONTEXT`'s `deployID` rotates on every
   PRODUCTION deploy too, so scoping by it unconditionally would move
   production passports to a fresh namespace on every ship; that never
   happens here because a `deploy.context` of `'production'` is checked
   FIRST and short-circuits straight to the bare name, before the id is ever
   read. `NETLIFY_BRANCH` does not distinguish production from a preview at
   all and is not consulted.

   NOT MEMOISED, same rule as `factory` above and for the same reason:
   `deploy` arrives with the request and must travel with it. Nothing here
   caches a resolved scope across invocations.

   A LATENT GAP, named rather than fixed because nothing today triggers it:
   `web/netlify.toml` has no `[context.<name>]` block, so `deploy.context` is
   always one of `production`, `deploy-preview` or `branch-deploy`. If a
   custom build context is ever added there, a deploy under it would report
   that custom name, fail this allowlist, and fall through to the BARE scope
   — a wrongly-bare non-production deploy, the same direction as today's
   pre-fix hazard rather than the catastrophic one, but still a real gap.
   Check this comment before adding a `[context.*]` block to that file. */
export const SCOPED_DEPLOY_CONTEXTS = new Set(['deploy-preview', 'branch-deploy']);

/* Netlify Blobs' own `validateStoreName` (dist/main.js) refuses a `/` (or
   `%2F`) anywhere in the name and anything over 64 UTF-8 bytes, and THROWS
   SYNCHRONOUSLY out of `getStore` for either. `strong()` below calls
   `factory()`, which calls `getStore()`, in the same tick as every store
   call in the _store-*.mjs modules, so an unsanitised id here does not degrade
   anything —
   it takes down the whole request with a 500, for every store the request
   touches, not just the ones it names explicitly.

   `deploy.id` (a 24-character hex deploy id) never hits either limit. This
   crew's own branch naming convention does: a critic reviewing this file
   built a real branch called `backend/row-37-deploy-scope` and reproduced
   the throw against the actual `getStore()`, not the test double, from the
   documented `deploy.branch` fallback below. So the fallback path is
   sanitised even though `context.deploy`'s current documented shape
   (`{context, id, published, skewProtectionToken}`) does not appear to carry
   a `branch` field at all — if that ever changes, or if `deploy.id` itself
   is ever something other than the plain hex string it is today, this still
   cannot crash a request on a name Netlify Blobs would refuse. */
/* Truncates to at most `maxBytes` of UTF-8, the same unit Netlify Blobs'
   own validator measures in (`TextEncoder().encode(name).length`), not
   `.slice()`'s UTF-16 code units — a git branch name is not guaranteed
   ASCII, and a code-unit count understates the byte count for anything
   outside it. Cuts on a code point boundary via the array spread, so it
   never splits a surrogate pair into two dangling halves. */
const truncateUtf8 = (s, maxBytes) => {
  const enc = new TextEncoder();
  let out = '';
  for (const ch of s) {
    if (enc.encode(out + ch).length > maxBytes) break;
    out += ch;
  }
  return out;
};

export const deployScope = (deploy) => {
  const ctx = deploy && deploy.context;
  if (!SCOPED_DEPLOY_CONTEXTS.has(ctx)) return '';
  const raw = String((deploy && (deploy.id || deploy.branch)) || 'unknown');
  /* Longest store name this file opens is `fingerprints`, 12 bytes. Budget:
     64 total - 3 (`dp-`) - 1 (trailing `-`) - 12 (`fingerprints`) = 48. 40
     leaves margin without having to track every store name that gets added
     here in the future. */
  const safe = truncateUtf8(raw.replace(/[/%]/g, '-'), 40) || 'unknown';
  return `dp-${safe}-`;
};

/* ── scope registry, ROW-155 ────────────────────────────────
   ROW-37 gave every non-production deploy its own store family and nowhere
   that discovers what those families ARE. `sweep()` only ever runs with the
   bare production scope (sweep.mjs's own guard refuses anything else before
   it is called), and Netlify Blobs has no "list every store" primitive, only
   "list keys within a store you already have the name of." So a
   `dp-<id>-*` family a preview created was invisible to any cleanup path and
   accumulated forever. This is the registry that makes it visible.

   ALWAYS OPENED BARE, never through `strong()`. This store is itself the
   thing production's sweep must be able to find without already knowing a
   scope's name, so it cannot be scoped by one. */
export const SCOPES_STORE = 'scopes';

/* NOT THE SAME MISTAKE AS THE "DO NOT MEMOISE" RULE ABOVE. That rule is
   about caching a STORE HANDLE at module level, which breaks because
   `getStore()` must run inside the handler's execution context to see the
   injected credentials. `lastRegisteredAt` caches nothing but a scope
   string and a timestamp; `factory(SCOPES_STORE)` below is still called
   fresh, inside the handler's execution context, on every registration
   write, exactly like every other store open in this file. */
/* Not `HOUR_MS` below: that const is declared further down this file, after
   this block runs at module-evaluation time, and referencing it here would
   throw. Same value, stated independently rather than reordering the file
   to share it. */
const REGISTER_DEDUPE_MS = 3600e3;
const lastRegisteredAt = new Map();
/* Test seam, same standing as `__useStoreFactory`: the dedupe map outlives
   a test suite's `reset()` of its fake stores, so a scope registered in one
   test is silently not re-registered in the next for an hour. */
export function __forgetRegistrations() { lastRegisteredAt.clear(); }

/* THE TIME SIGNAL IS IN THE KEY. FOUR CRITICS IN ONE DAY EARNED THIS LINE.

   The first version keyed the registry by scope alone. A bounded read of a
   lexically-sorted store with no time signal reads the same entries every
   run, so a handful of active scopes that sorted first starved an abandoned
   one behind them forever: the exact defect `limitPrefix` (in _store-ratelimit.mjs)
   documents fixing once already for the rate limiter. Three successive repairs kept
   the shape and shrank the hole: a hash-derived slice rotated by calendar
   day (divides the hole by seven, does not close it), an uncapped check
   over the whole slice (closes it until the slice is large enough that
   checking alone eats the budget and draining never runs), and a 50/50
   budget split between checking and draining (reopens the first hole,
   because the check phase re-lists from the top of the same lexical prefix
   every run with no cursor, and a dead scope that sorts late in a large
   backlog is never reached). Each fix was tested against the counterexample
   that found the previous defect and each was refuted by a fresh one.

   What every version shared was a key that had to be READ before the sweep
   knew whether the entry mattered. This version puts `lastSeen` in the key,
   zero-padded so it sorts numerically, the same layout `expiryKey` uses for
   the expiry index and `limitPrefix` uses for the limiter: the OLDEST scope
   is always the FIRST key listed, the sweep stops at the first key newer
   than the threshold, and the cost of a run is proportional to the number
   of abandoned scopes, never to the number of active ones. There is no
   slice, no rotation, no reservation, and no second phase: nothing sorts
   ahead of the oldest abandoned scope except an older abandoned scope, and
   that one is torn down first. Progress is guaranteed as long as one run
   can list one page and delete one key.

   TWO KEYS PER SCOPE, and the order they are written in is load-bearing.
   `scope:<scope>` is the truth: the scope's latest `lastSeen`, rewritten in
   place. `seen:<lastSeen>:<scope>` is the sorted index the sweep walks. A
   registration writes the truth FIRST, then the index entry, then deletes
   the previous index entry. A crash after the first write leaves an old
   index entry under a fresh truth; the sweep reads the truth before it
   drains anything, sees the scope was seen since, and moves the index entry
   forward instead of tearing the scope down. The wrong-direction failure
   (deleting a preview that is still in use) needs the truth itself to be
   stale, and the truth is the one write that happens before anything else.
   A crash before it is the same outcome as the registration never running,
   which the hourly dedupe and every cold start already retry. */
export const SEEN_PREFIX = 'seen:';
const SCOPE_PREFIX = 'scope:';
export const seenKey = (ms, scope) => `${SEEN_PREFIX}${String(ms).padStart(16, '0')}:${scope}`;
export const scopeKey = (scope) => `${SCOPE_PREFIX}${scope}`;
const SEEN_KEY = /^seen:(\d{16}):(.+)$/s;
export const parseSeenKey = (key) => {
  const m = SEEN_KEY.exec(key);
  return m ? { lastSeen: Number(m[1]), scope: m[2] } : null;
};

/* `previousSeen` is what this warm instance last wrote, if it knows; a cold
   instance reads the truth to find the index entry it has to retire. A
   concurrent registration from another instance can leave a second index
   entry behind either way. That entry is a ghost, and the sweep repairs
   ghosts (see `sweepScopes`); it does not need this function to be
   race-free, only to write the truth before the index. */
async function writeRegistration(scope, meta, previousSeen) {
  const registry = factory(SCOPES_STORE);
  let old = previousSeen;
  if (!old) {
    const prior = await registry.get(scopeKey(scope), { type: 'json' }).catch(() => null);
    old = prior && Number.isFinite(prior.lastSeen) ? prior.lastSeen : 0;
  }
  await registry.setJSON(scopeKey(scope), meta);
  await registry.setJSON(seenKey(meta.lastSeen, scope), meta);
  if (old && old !== meta.lastSeen) await registry.delete(seenKey(old, scope));
}

/* Fire-and-forget, deliberately. A scope is bookkeeping for a maintenance
   job nobody is waiting on; a request must never be slowed down, let alone
   fail, because the registry write was slow or the store was briefly down.
   Deduped per warm instance so an active preview does not write this key on
   every single store call it makes; a preview upload alone calls `strong`
   five or six times. The dedupe window bounds how STALE `lastSeen` can get
   while an instance stays warm and keeps serving the same scope without
   this line running again; an hour is short against the multi-day
   abandonment threshold `sweepScopes` (in _store-scopes.mjs) uses, so it cannot make an
   actively-used preview look idle. */
function registerScope(deploy, scope) {
  const now = Date.now();
  const last = lastRegisteredAt.get(scope) || 0;
  if (now - last <= REGISTER_DEDUPE_MS) return;
  lastRegisteredAt.set(scope, now);
  const meta = {
    context: deploy.context,
    id: (deploy.id || deploy.branch) || null,
    lastSeen: now
  };
  writeRegistration(scope, meta, last).catch(() => {
    /* A missed registration costs one cycle of teardown, not correctness,
       PROVIDED the next store call retries it. The dedupe entry was set
       before the write so that concurrent calls on a warm instance do not
       all write; on failure it has to come out again, or an outage lasting
       one request suppresses the retry for an hour on this instance. A
       critic built that: the truth stayed stale through the outage and the
       hour, and nothing on the instance would have refreshed it. */
    if (lastRegisteredAt.get(scope) === now) lastRegisteredAt.delete(scope);
  });
}

export const strong = (deploy, name) => {
  const scope = deployScope(deploy);
  if (scope) registerScope(deploy, scope);
  return factory(scope + name);
};

export const sha256 = s => createHash('sha256').update(s, 'utf8').digest('hex');

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const DAY_MS = 86400e3;
export const HOUR_MS = 3600e3;

/* A few pages of keys, not the whole store.

   `list()` with no options collects every page of the iterator before it
   returns, so the cost of a sweep was the number of passports that exist rather
   than the amount of dead work there is. Measured: an upload went from 80ms to
   360ms against ten thousand LIVE passports with nothing to delete.

   This DEPENDS ON LEXICOGRAPHIC LISTING and there is no point pretending
   otherwise. Every swept store is keyed so that its oldest entries sort first:
   the expiry index by zero-padded expiry, the limiter by window then padded
   bucket, fingerprints and acks by bucket. Given that order, the early pages
   are exactly the pages with dead keys in them and a bounded sweep converges.
   Given an arbitrary order, no bounded sweep of a large store can promise to
   reach anything, four pages or forty, and the honest answer would be a
   scheduled job instead.

   Four pages rather than one because the margin is nearly free and one page is
   a thin bet on an ordering nobody documented for us. The doubles in
   tools/ sort their keys for the same reason: an insertion-ordered double would
   let a key layout that starves the sweeper pass. */
export const SWEEP_PAGES = 4;

/* Deletes, in parallel batches. The three cleanup loops used to `await` inside
   a `for`, so a dirty store turned one upload into six hundred strictly
   sequential round trips: at 10-30ms each that is six to eighteen seconds, on a
   path in front of a ten-second function timeout. An attacker fills those
   stores for nothing, because every refused upload writes a key.

   Batched, the same six hundred deletes are thirty round trips.

   The sentence that followed said the budgets in _store-expiry.mjs are lower because "the
   request it is riding on belongs to somebody who wanted to publish a passport".
   That stopped being true when the sweep moved to netlify/functions/sweep.mjs
   and nobody is waiting on it. Batching still matters for the same arithmetic,
   against a 30-second scheduled ceiling rather than a publisher's patience. */
export const DROP_BATCH = 25;

/* `stillHave` is checked BETWEEN batches, not only before the first one.

   This was an admission check in front of the whole loop, and that is not a
   bound: once admitted, `drop()` ran to completion. At maxKeys = 1000 and
   DROP_BATCH = 25 that is 40 STRICTLY SEQUENTIAL round trips, about 12 s at the
   measured 310 ms, which a run could legally enter at 19.9 s of a 20 s budget
   and blow the 30 s ceiling. A critic simulated it: the old 20/100 bounds
   survived a 3x latency excursion, the raised 200/1000 bounds failed at 1.6x,
   at 500 ms, which is the exact figure the budget comment cites as the reason a
   count is the wrong control. The comment argued for a deadline and then raised
   the count in a way that defeated it.

   Abandoning a drop part-way is safe in a way abandoning a purge is not: these
   three stores hold cosmetic keys with no cross-store invariant, so a key left
   behind is retried next run and nothing points at anything. */
export async function drop(deploy, name, keys, stillHave = () => true) {
  const store = strong(deploy, name);
  let done = 0;
  for (let i = 0; i < keys.length; i += DROP_BATCH) {
    if (!stillHave()) break;
    const batch = keys.slice(i, i + DROP_BATCH);
    await Promise.all(batch.map(k => store.delete(k).catch(() => {})));
    done += batch.length;
  }
  return done;
}

export async function scan(deploy, name, { pages = SWEEP_PAGES, prefix } = {}) {
  const out = [];
  try {
    const it = strong(deploy, name).list({ paginate: true, ...(prefix ? { prefix } : {}) });
    let seen = 0;
    for await (const page of it) {
      out.push(...(page.blobs || []));
      if (++seen >= pages) break;
    }
  } catch {
    /* A listing that FAILED and a store that is EMPTY are different answers, and
       collapsing them is how "all zeros" stops being readable. The tuning story
       for this sweep is that a run of zeros means it is running more often than
       it needs to; a blind sweep produces exactly the same zeros. So the failure
       is signalled rather than swallowed, and the caller decides. */
    out.failed = true;
  }
  return out;
}

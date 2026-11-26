/* _store-scopes.mjs

   Scope teardown (ROW-155): `sweepScopes` deletes every store a deploy-preview
   scope opened once the scope has been idle past SCOPE_ABANDON_MS, and the
   dry-run report that goes with it. The registry's write half is in
   _store-core.mjs, because `strong()` calls it.

   SCOPED_STORE_NAMES below must list every store opened by ANY _store-*.mjs
   module, not only this one.

   Stores opened here: scopes, sweep-dryrun.

   Exports that _store.mjs does not re-export are internal to the _store-*.mjs family. */

import {
  DAY_MS,
  deployScope,
  DROP_BATCH,
  factory,
  parseSeenKey,
  SCOPED_DEPLOY_CONTEXTS,
  scopeKey,
  SCOPES_STORE,
  SEEN_PREFIX,
  seenKey,
  sha256,
  strong,
  SWEEP_PAGES
} from './_store-core.mjs';

/* ── scope teardown, ROW-155 ────────────────────────────────
   Reads the registry `registerScope` (in _store-core.mjs) writes and, for every scope this
   file has not heard from in a while, deletes everything it holds and
   forgets the scope. This is a different shape of work from `sweep()`
   (_store-expiry.mjs), deliberately.

   `sweep()` protects an INVARIANT: an expiry-index entry and the row it
   names must not go out of step, because the index is the only path back to
   a live row. There is no equivalent invariant here. Nothing outside a
   `dp-<id>-*` family ever references a key inside it — no production code
   path reads a scoped store by name, only `strong()` computes one, from the
   request that owns it — so there is nothing to protect and no reason to
   keep partial preview data around once a scope is judged abandoned. Delete
   everything in every store the scope might have opened, then forget the
   scope existed.

   SCOPED_STORE_NAMES IS MEANT TO LIST EVERY STORE `strong()` EVER OPENS,
   including `metrics`, `attempts` and `digest`, which the bare production
   sweep deliberately never touches (see the comments on `recordMetrics` and
   `recordRejection`: production keeps that corpus forever, on purpose, as
   the record of what the product's first users actually did). That
   reasoning does not apply to a preview: nobody analyses a deploy preview's
   metrics as product data, so a full teardown correctly includes stores the
   bare sweep correctly leaves alone. Same list, opposite policy, because the
   two policies are answering different questions.

   ROW-226: THAT SENTENCE WAS FALSE FOR SIX STORES, and the false claim in it
   is exactly why nobody noticed. `gallery`, `gallery-categories`, `votes`,
   `votes-count` and `copies` opened when the gallery shipped; `sweep-dryrun`
   (below, `DRYRUN_STORE`) opened when the dry-run report did. None was added
   here. A scope torn down by `sweepScopes` deleted the nine names on this
   list and forgot the scope; the six others sat under the same `dp-<id>-`
   prefix with nothing pointing at them any more — not corruption, since
   nothing reads a scoped store by name except `strong()` computing one fresh
   per request, but a quiet, permanent leak of preview data past the
   mechanism that exists to remove it. Reproduced: a fake preview scope seeded
   the way a real upload + listing + vote + copy writes, aged past
   `SCOPE_ABANDON_MS`, swept — registry entry gone, six stores still holding
   their key. `web/tools/run-endpoint-tests.mjs` carries that reproduction as
   a regression, and a second test greps every `strong(deploy, ...)` call
   site in this tree (literal and via a named constant like `DRYRUN_STORE`)
   and fails if any resolved name is missing from this array — so the next
   store this list does not learn about fails a test instead of leaking
   quietly for as long as this one did. Neither test can make the array
   trustworthy on its own; a name added to this list by hand and never opened
   by `strong()` would pass both. What they buy is not "this list is right",
   only "this list has not silently drifted from the source since the last
   time these tests ran green." */
/* Exported so tools/run-endpoint-tests.mjs can check it against the actual
   call sites rather than trusting it by name; see the comment above. */
export const SCOPED_STORE_NAMES = [
  'passports', 'views', 'expiry', 'fingerprints', 'ratelimit',
  'metrics', 'attempts', 'digest', 'acks',
  'gallery', 'gallery-categories', 'votes', 'votes-count', 'copies', 'sweep-dryrun',
  'prompt-clicks', 'jev', 'holds', 'hold-email', 'hold-expiry', 'hold-pointers', 'hold-pointer-expiry'
];

/* SEVEN DAYS, A STAND-IN AND NAMED AS ONE. This crew has never measured how
   long a Netlify deploy preview or branch deploy actually stays useful to
   whoever pushed it, the same gap `move-the-sweep-to-a-schedule.md` flagged
   for the scheduled interval itself. What this number has to be larger than
   is a real review cycle, not a guess at Netlify's own retention: deleting a
   preview's data while someone is still iterating on the PR it belongs to
   is the wrong-direction mistake, the same asymmetry `deployScope`'s
   allowlist is built on. Seven days is chosen to be obviously longer than a
   normal review cycle rather than plausibly tight. Revisit once there is a
   real figure for either question.

   The latency from crossing this threshold to actually being torn down is
   one scheduled run, plus however many runs a large scope needs to drain,
   plus however many older abandoned scopes are queued ahead of it. An
   earlier design examined each scope only on one day in seven and carried
   a 13-day worst case and a boundary cliff; both are gone with the slicing
   that caused them (see the comment on `seenKey` in _store-core.mjs). */
export const SCOPE_ABANDON_MS = 7 * DAY_MS;
export const SCOPE_SWEEP_BUDGET_MS = 5000;

/* Drains at most SWEEP_PAGES pages of `store`, the same page bound `scan()`
   (_store-core.mjs) uses and for the same reason: an abandoned scope is not assumed
   small just because it is a preview. A hostile or merely chatty preview
   can fill `dp-<id>-ratelimit` the same way a stranger fills the bare one,
   see the comment on DROP_BATCH. Returns `emptied: false` the moment the
   budget runs out, when there was more than SWEEP_PAGES worth of keys to
   see, OR when any single delete failed: a key whose delete threw is still
   in the store, and a store with a key in it is not empty, whatever the
   listing said. The first version of this function counted failed deletes
   as removed and reported the store empty, which would have pruned the
   registry entry and left the data behind with nothing pointing at it. A
   scope that takes several runs to fully clear is not a bug, it is the same
   self-healing shape `sweep()` already relies on for the expiry index. */
async function drainStore(store, budgetOk) {
  let pages = 0;
  let removed = 0;
  let failed = false;
  const it = store.list({ paginate: true });
  for await (const page of it) {
    const keys = (page.blobs || []).map(b => b.key);
    for (let i = 0; i < keys.length; i += DROP_BATCH) {
      if (!budgetOk()) return { emptied: false, removed };
      const batch = keys.slice(i, i + DROP_BATCH);
      const outcomes = await Promise.all(batch.map(k => store.delete(k).then(() => true, () => false)));
      for (const ok of outcomes) { if (ok) removed++; else failed = true; }
    }
    if (++pages >= SWEEP_PAGES) return { emptied: false, removed };
  }
  return { emptied: !failed, removed };
}

/* Only ever runs against the bare scope, same discipline as `sweep()` and
   for the same reason: sweep.mjs's own guard has already refused anything
   that is not production before either function is called, and this second
   check is defence in depth against the day something calls this directly.
   A non-bare `deploy` returning immediately, having touched nothing, is the
   safe failure: a scope sweeping ONLY ITSELF would still be wrong, because
   the whole point is that nothing except this bare-scope pass may ever
   enumerate or delete across scope boundaries.

   ONE WALK, OLDEST FIRST, STOP AT THE FIRST FRESH KEY. The index sorts by
   `lastSeen` (see `seenKey`), so every abandoned scope precedes every
   active one and the walk ends the moment it meets a key newer than the
   threshold, without reading anything about the active scopes at all.
   Each abandoned entry is handled as it is met, inside the same page,
   rather than collected first: a run that can afford one page and one
   delete makes progress on the oldest scope, and no amount of backlog
   behind it changes that. Nothing here is a reservation or a share; the
   budget is one cooperative deadline checked between store calls, the same
   shape as `sweep()`'s, and like that one it can overshoot by the cost of
   the single call in flight when it expires.

   The result counts are diagnostics for the log line in sweep.mjs, not a
   contract. `scopesUnreadable` is the one to watch: an entry whose truth
   record cannot be read or has no usable `lastSeen` is skipped, in the safe
   direction, and stays at the front of the index costing one read per run
   until something rewrites it. A persistently unreadable one is a leak,
   visible as a count that never returns to zero. */
/* DRY RUN, RAFFAEL'S CONDITION ON THE YES. "Yes, but dry-run first and show
   me the list." With `dryRun: true` this function WRITES NOTHING: no store
   is drained, no registry entry is pruned, refreshed or re-keyed. It walks
   the index exactly as the live run would, reads each abandoned scope's
   truth record and counts the keys in each of its nine stores, and returns
   that as `wouldTearDown`, one entry per scope, which sweep.mjs logs.

   What an entry has to carry to be worth reading: enough to recognise a
   scoping error on sight. So each carries the scope prefix itself, the
   deploy context and id the registration recorded, the idle age in days,
   and the key count per store (a count is not a list, but a count per
   store per scope is what a person can check against what they remember
   publishing). `scopingError` is set on any entry whose scope does not
   start with `dp-` or whose recorded context is not one of the two
   non-production contexts; a live run would never have produced such an
   entry, and the dry run exists to show it if one did. Counts stop at
   SWEEP_PAGES pages per store, the same bound the live drain has, and say
   so with `atLeast: true` rather than under-reporting silently.

   Because a dry run removes nothing, every run re-lists from the head of
   the queue and the list is the same until something changes; that is
   the point of it. */
export async function sweepScopes(deploy, {
  now = Date.now(), budgetMs = SCOPE_SWEEP_BUDGET_MS, clock = Date.now, dryRun = false, dryRunAfter = ''
} = {}) {
  const result = {
    scopesTornDown: 0, scopesPending: 0, scopesRefreshed: 0, scopesUnreadable: 0,
    scopeKeysRemoved: 0, scopeListFailed: false, scopeBudgetSpent: false,
    /* How many index entries are past the threshold in total, counted
       cheaply (index pages only, no truth reads) even after the budget is
       spent, so a partial run can say how much it did not reach. `null` if
       the count itself hit its page bound. */
    scopesAbandoned: 0
  };
  if (dryRun) {
    result.dryRun = true; result.wouldTearDown = []; result.scopingErrors = 0;
    result.unreachedScopingErrors = [];
    /* The index key the dry run stopped at, for the next run to resume
       after; '' when it reached the first fresh entry, so the next run
       starts over. A dry run removes nothing, so without this every run
       would list the same head forever. */
    result.dryRunCursor = '';
  }
  if (deployScope(deploy)) return result;

  const startedAt = clock();
  const budgetOk = () => clock() - startedAt < budgetMs;
  const cutoff = now - SCOPE_ABANDON_MS;
  const registry = factory(SCOPES_STORE);

  /* See the comment at the pending branch of `examine` for why. */
  const sendToBack = async (indexKey, scope, value) => {
    if (dryRun) return;
    const back = seenKey(cutoff - 1, scope);
    if (back === indexKey) return;
    try {
      await registry.setJSON(back, value);
      await registry.delete(indexKey);
    } catch { /* left where it was; the next run tries again */ }
  };

  const examine = async (indexKey, { scope, lastSeen }) => {
    /* The truth first, always. The index entry says when the scope was
       seen as of the write that produced it; the truth says when it was
       seen as of the latest write that landed, and a registration writes
       the truth before it writes the index. */
    let truth;
    try {
      truth = await registry.get(scopeKey(scope), { type: 'json' });
    } catch {
      /* Skipped in the safe direction, and SENT TO THE BACK, because the
         critic showed eight entries that return here hold the head as
         surely as a stuck drain does: one read each, sixteen reads per
         budget, nothing behind them ever reached. */
      result.scopesUnreadable++;
      if (dryRun) result.dryRunCursor = indexKey;
      await sendToBack(indexKey, scope, { lastSeen });
      return;
    }
    if (truth && !Number.isFinite(truth.lastSeen)) {
      result.scopesUnreadable++;
      if (dryRun) result.dryRunCursor = indexKey;
      await sendToBack(indexKey, scope, truth);
      return;
    }

    if (truth && truth.lastSeen >= cutoff) {
      if (dryRun) { result.dryRunCursor = indexKey; return; }
      /* A ghost: the scope has been seen since this index entry was
         written and the newer entry either exists already (in which case
         the write below is a no-op) or was lost to a crash between the two
         registration writes. Move the index forward, then retire the
         ghost; if the forward write fails, leave the ghost so the next run
         tries again rather than losing the scope from the index. */
      try {
        await registry.setJSON(seenKey(truth.lastSeen, scope), truth);
        await registry.delete(indexKey);
        result.scopesRefreshed++;
      } catch { /* retried next run */ }
      return;
    }

    /* Abandoned by every record there is. A missing truth means the scope
       was torn down before and this entry is a leftover, or a registration
       never got past its first write; either way the index entry's own
       `lastSeen` is the only evidence and it is past the threshold. */
    /* ONE PARALLEL ROUND TRIP TO SEE WHICH STORES HOLD ANYTHING, then a
       sequential drain of only those. Most abandoned scopes are nearly
       empty (a preview that published once, or a spoofed registration that
       published nothing), and at this repo's measured 310 ms per round trip
       nine sequential lists cost 2.8 s per scope against a 5 s budget: the
       critic timed a thousand junk scopes at 42 days to clear. The peek
       makes an empty scope cost two round trips instead of ten. Delete
       concurrency is unchanged: draining still runs one store at a time in
       DROP_BATCH-sized batches, for the reason on `DROP_BATCH`. A peek that
       fails counts as "holds something" and falls through to the drain,
       which reports its own failure. */
    if (!budgetOk()) { result.scopesPending++; result.scopeBudgetSpent = true; return; }
    const handles = SCOPED_STORE_NAMES.map(name => factory(scope + name));

    if (dryRun) {
      const counts = await Promise.all(handles.map(async h => {
        let n = 0, pages = 0;
        try {
          for await (const page of h.list({ paginate: true })) {
            n += (page.blobs || []).length;
            if (++pages >= SWEEP_PAGES) return { n, atLeast: true };
          }
          return { n, atLeast: false };
        } catch { return { n, atLeast: true, listFailed: true }; }
      }));
      const keys = {};
      const unlisted = [];
      let total = 0, atLeast = false;
      SCOPED_STORE_NAMES.forEach((name, i) => {
        if (counts[i].listFailed) { unlisted.push(name); return; }
        if (counts[i].n > 0) keys[name] = counts[i].n;
        total += counts[i].n;
        atLeast = atLeast || counts[i].atLeast;
      });
      /* THE SAME VALUE THE DECISION USES. The live run decides on the truth
         record's lastSeen when there is one and on the index key's when there
         is not; a critic planted a 30-day truth behind an 8-day index key and
         the list said 8. */
      const decidedOn = truth ? truth.lastSeen : lastSeen;
      /* `context: null` for a missing truth record (a leftover of an earlier
         teardown) and for a truth without the field, with `record` saying
         which, so a reader never sees a flag without the evidence for it.
         A context that IS recorded and is not one of the two non-production
         ones is the error this exists to show. */
      const context = truth && truth.context !== undefined ? truth.context : null;
      const record = !truth ? 'missing' : (truth.context === undefined ? 'no-context' : undefined);
      const scopingError = !scope.startsWith('dp-') || (typeof context === 'string' && !SCOPED_DEPLOY_CONTEXTS.has(context));
      if (scopingError) result.scopingErrors++;
      result.wouldTearDown.push({
        scope, context, id: truth ? truth.id : null,
        ...(record ? { record } : {}),
        idleDays: Math.floor((now - decidedOn) / DAY_MS),
        keys,
        /* `total` only when every store was listed; a store that could not
           be listed may hold anything, and a live run would leave this
           scope pending rather than tear it down. */
        ...(unlisted.length ? { unlisted, wouldPend: true } : { total }),
        ...(atLeast ? { atLeast: true } : {}),
        ...(scopingError ? { scopingError: true } : {})
      });
      /* The cursor moves only past an entry that was actually listed (or
         handled above); a budget cut before the listing leaves it where it
         was, so the next run starts with that entry. */
      result.dryRunCursor = indexKey;
      return;
    }
    const peeks = await Promise.all(handles.map(async h => {
      try {
        for await (const page of h.list({ paginate: true })) return (page.blobs || []).length === 0;
        return true;
      } catch { return false; }
    }));

    let confirmedEmpty = true;
    let removedThisScope = 0;
    for (let i = 0; i < handles.length; i++) {
      if (peeks[i]) continue;
      if (!budgetOk()) { confirmedEmpty = false; result.scopeBudgetSpent = true; break; }
      let outcome;
      try {
        outcome = await drainStore(handles[i], budgetOk);
      } catch {
        confirmedEmpty = false;
        continue;
      }
      result.scopeKeysRemoved += outcome.removed;
      removedThisScope += outcome.removed;
      if (!outcome.emptied) confirmedEmpty = false;
    }

    /* Prune the registry only once every store the scope might have opened
       has come back empty in the SAME run. This is what stops the registry
       growing without bound: a scope that never finishes teardown in one
       run simply stays listed, at the front of the index, and is the first
       thing the next run continues with. The index entry goes last so that
       a failure part-way leaves the scope findable. */
    if (confirmedEmpty) {
      /* READ THE TRUTH AGAIN BEFORE FORGETTING THE SCOPE. The fifth critic
         built the interleaving: a request registers the scope after the
         read at the top of this function and before the prune below, and
         the prune deletes a truth record that says the scope was seen
         moments ago. Re-reading narrows that window from the whole drain to
         the gap between this read and the delete; it does not close it,
         and it does nothing for the data the request wrote into stores
         this run had already drained, which is gone. That residue is the
         same shape as a passport renewed in the instant `sweep()` purges
         it, and it needs a conditional delete the blob client does not
         offer to close. Stated here rather than claimed away: a preview
         revived after exactly seven idle days, in the seconds the hourly
         sweep spends on it, can lose what it wrote in those seconds. */
      let again = null;
      try { again = await registry.get(scopeKey(scope), { type: 'json' }); } catch { again = truth; }
      if (again && Number.isFinite(again.lastSeen) && again.lastSeen >= cutoff) {
        try {
          await registry.setJSON(seenKey(again.lastSeen, scope), again);
          await registry.delete(indexKey);
          result.scopesRefreshed++;
        } catch { /* retried next run */ }
        return;
      }
      try {
        if (truth && truth.lastSeen !== lastSeen) await registry.delete(seenKey(truth.lastSeen, scope));
        await registry.delete(scopeKey(scope));
        await registry.delete(indexKey);
      } catch { confirmedEmpty = false; }
    }
    if (confirmedEmpty) { result.scopesTornDown++; return; }
    result.scopesPending++;
    /* A scope that made progress keeps the head: it is large, not stuck,
       and it will finish. Re-keying it too would put it behind every scope
       that crosses the threshold while it drains, and the critic measured a
       4000-key scope slowing sixteen-fold from one arrival per hour. Only a
       scope this run could not remove a single key from goes to the back. */
    if (removedThisScope > 0) return;

    /* A SCOPE THAT CANNOT FINISH MUST NOT HOLD THE HEAD OF THE INDEX. The
       fifth critic built this one: a scope whose deletes keep failing (or
       that is simply too large for one run) sits at the front, is examined
       first every run, spends the whole budget, and every abandoned scope
       behind it is never reached. Same family as the original defect, one
       rung down: not "an active scope ahead of a dead one" but "a dead
       scope that cannot finish ahead of every other dead one". The four
       rotating designs before this one could not have had this bug and
       could not have been tested for it: they had no head. Replacing an
       unbounded scan with a queue inherits every failure a queue has.

       So a pending scope is moved to the BACK of the abandoned queue: its
       index entry is rewritten to sort just below the threshold, after every
       scope that was already abandoned when this run started and before any
       that crosses the threshold later. The next run therefore serves the
       rest of the backlog before it returns to this one, and a run in which
       this scope spent the budget is followed by one in which it does not.
       The truth record is untouched, so the scope is still abandoned by every
       record that matters, and a later run drains it from wherever it sits.
       Done even when the budget is spent, at the cost of two calls past the
       deadline, because this write is the thing that prevents the starvation
       and skipping it under pressure would skip it exactly when it matters.

       WHAT THIS DOES NOT DO: a scope that can NEVER be emptied still costs
       every other run its budget, forever. That is a halving of throughput,
       not a starvation, and it is visible as a `scopesPending` that never
       returns to zero. Backing off further would need a retry count
       somewhere; not built, because nothing establishes that a permanently
       undeletable blob key exists on the platform. */
    await sendToBack(indexKey, scope, truth || { lastSeen });
  };

  /* Once per run. A pending scope is re-keyed just below the threshold
     while the walk is still paginating, and a real listing whose later
     pages are fetched after that write can hand the same scope back on a
     later page; the double snapshots at list() time and cannot show this.
     Examining it twice would spend the budget twice on the one scope the
     re-keying exists to stop from doing exactly that. */
  const examined = new Set();
  /* Once the budget is spent the walk keeps listing but stops examining:
     index pages are one round trip per thousand entries and the count of
     what was not reached is the difference between a list and a sample.
     Bounded at COUNT_PAGES so a pathological registry cannot hold the
     function past its ceiling; past that the count is reported as null. */
  const COUNT_PAGES = 50;
  let counting = false;
  let pages = 0;
  let reachedFresh = false;
  try {
    const it = registry.list({ prefix: SEEN_PREFIX, paginate: true });
    for await (const page of it) {
      if (++pages > COUNT_PAGES) { result.scopesAbandoned = null; break; }
      for (const { key } of page.blobs || []) {
        const parsed = parseSeenKey(key);
        if (!parsed) continue;
        if (parsed.lastSeen >= cutoff) { reachedFresh = true; break; }
        result.scopesAbandoned++;
        /* A scope that is not `dp-` is visible from the key alone, so it is
           flagged even in the part of the backlog this run does not reach.
           A critic planted one at position 200 of 300 and the head-only
           fingerprint never moved. */
        /* Names are capped, the count is not. This is the one field that
           fills exactly when something is wrong, and a critic seeded 5000
           non-dp entries into a 64 KB log line. Twenty names identify the
           shape; `scopingErrors` carries the size and the fingerprint
           carries both, so the twenty-first still moves the block. */
        const flagUnreached = () => {
          if (!dryRun || parsed.scope.startsWith('dp-')) return;
          result.scopingErrors++;
          if (result.unreachedScopingErrors.length < UNREACHED_NAMES_CAP) result.unreachedScopingErrors.push(parsed.scope);
        };
        if (counting || (dryRun && key <= dryRunAfter)) { flagUnreached(); continue; }
        /* The entry that trips the budget is not examined either, so it is
           flagged from its key like the ones behind it; the cursor stays on
           the last examined entry and lists it next run. */
        if (!budgetOk()) { result.scopeBudgetSpent = true; counting = true; flagUnreached(); continue; }
        if (examined.has(parsed.scope)) continue;
        examined.add(parsed.scope);
        await examine(key, parsed);
      }
      if (reachedFresh) break;
    }
  } catch {
    result.scopeListFailed = true;
  }
  /* A dry run that reached the first fresh entry without spending the
     budget has listed everything after its cursor; the next run starts
     over. One that spent the budget resumes after the last entry listed. */
  if (dryRun && !result.scopeBudgetSpent) result.dryRunCursor = '';
  return result;
}

/* ONE LINE AN HOUR FOR A WEEK IS NOT A LIST. Raffael asked to see the list;
   168 near-identical log lines he has to diff by eye is a worse instrument
   than one snapshot. So sweep.mjs prints the per-entry block only when the
   SET of scopes the dry run would tear down differs from the previous run,
   and the hourly counts line carries the set's fingerprint so a reader can
   see when it moved. The previous fingerprint has to live somewhere between
   two cold starts, and `sweepScopes` in dry-run mode must write nothing to
   any store it could later drain, so it lives in its own bare store,
   `sweep-dryrun`, under one key, which nothing else reads or sweeps. The
   fingerprint is over scope names plus each entry's scopingError flag,
   sorted: counts changing under the same scopes is not a new event, a
   scoping error appearing on a scope already listed is. An unreadable or missing previous
   fingerprint counts as changed, so the first run and any run after an
   outage print the block rather than staying quiet. */
const DRYRUN_STORE = 'sweep-dryrun';
/* The fingerprint covers, per listed scope, its name, its total key count
   and its scoping flag, plus every scoping error flagged from the unreached
   part of the backlog. A critic grew a listed scope from one key to 6500
   under a names-only fingerprint and the block never printed again; the
   count is the one field that says how much a live run would destroy. */
export const UNREACHED_NAMES_CAP = 20;
export const dryRunFingerprint = (scopes) => {
  const items = scopes.wouldTearDown.map(e =>
    `${e.scope}|${e.total === undefined ? '?' : e.total}|${e.scopingError ? '!' : ''}`);
  items.push(...scopes.unreachedScopingErrors.map(s => `unreached:${s}!`));
  /* The names are capped (see the walk), so the count is what moves the
     fingerprint once the cap is full. */
  items.push(`scopingErrors:${scopes.scopingErrors || 0}`);
  return sha256(JSON.stringify(items.sort())).slice(0, 12);
};
/* Threaded through `strong(deploy, ...)` like every other store call, so it
   is scoped by construction and not only by the handler's guard; the
   handler only ever calls this with the bare deploy. */
export async function dryRunSetChanged(deploy, scopes) {
  const fingerprint = dryRunFingerprint(scopes);
  let previous = null;
  try { previous = await strong(deploy, DRYRUN_STORE).get('last'); } catch { previous = null; }
  if (previous === fingerprint) return { changed: false, fingerprint };
  await strong(deploy, DRYRUN_STORE).set('last', fingerprint).catch(() => {});
  return { changed: true, fingerprint };
}
/* The dry run's resume point, same store. A run that could not read it
   starts from the head, which is the safe direction: a repeated head is a
   nuisance, a skipped tail is a scope he never saw. */
export async function dryRunCursor(deploy) {
  try { return (await strong(deploy, DRYRUN_STORE).get('cursor')) || ''; } catch { return ''; }
}
export async function saveDryRunCursor(deploy, cursor) {
  await strong(deploy, DRYRUN_STORE).set('cursor', cursor || '').catch(() => {});
}
/* The block sweep.mjs prints. Built here so it can be unit-tested against a
   budget-limited result; the handler cannot be driven at a chosen budget. */
export function dryRunReport(scopes, set, resumedAfter) {
  return {
    set: set.fingerprint,
    partial: scopes.scopeBudgetSpent,
    backlog: scopes.scopesAbandoned,
    resumedAfter: resumedAfter || null,
    scopingErrors: scopes.scopingErrors,
    unreachedScopingErrors: scopes.unreachedScopingErrors,
    count: scopes.wouldTearDown.length,
    scopes: scopes.wouldTearDown
  };
}

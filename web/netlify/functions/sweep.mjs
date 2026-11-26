/* The sweep, on a schedule instead of on somebody's publish.

   It used to run inside upload.mjs, in front of the write, so the only thing
   that ever cleaned this system was a stranger publishing a passport. That is
   self-scaling for free, which is the one real thing being given up here, and it
   costs every publisher a maintenance pass in front of their own request.

   WHY THIS IS SAFE TO RUN ON A TIMER, WHICH IT WAS NOT BEFORE.
   Our functions open SITE-WIDE blob stores, so a non-production deploy reads and
   writes the same passports as production. A timer on such a deploy would delete
   live passports. That is why this was not built until 2026-08-15, when Raffael
   confirmed deploy previews are off.

   The confirmation is not what makes it safe, and should not be relied on as if
   it were. Two things do:

   1. THE PLATFORM. Netlify documents that "scheduled functions only run on their
      schedule for published deploys — Deploy Previews and branch deploys won't
      trigger them automatically." Checked against the current docs on
      2026-08-15, not assumed. That is a stronger guarantee than the dashboard
      setting, because it holds for branch deploys too, and branch deploys are a
      SEPARATE setting from deploy previews that nobody has confirmed. There is a
      non-main branch on the marketing remote pushed after that site was
      connected, so the question is live rather than theoretical.

   2. THE GUARD BELOW — and read the next paragraph before trusting it, because
      an earlier version of this comment claimed it closes the preview hole and
      it does not.

   THE HOLE IS `Run now`, AND NOTHING HERE CAN CLOSE IT. A critic went back to
   the docs and found the sentence that finishes the one quoted above:

     "Deploy Previews and branch deploys won't trigger them automatically. You
      can still invoke them manually via the Run now button."

   and, on that button:

     "This is especially useful to test scheduled functions with Deploy Previews
      or branch deploys."

   So the documented, supported, one-click way to run this function on a preview
   is `Run now`, against site-wide production blobs. That is what "automatically"
   was doing in the first sentence. Whether `Run now` sends a next_run body is
   undocumented, and both answers are bad: if it does, the guard waves it through
   and a bulk delete runs from a preview; if it does not, the guard blocks the
   only sanctioned way to test this function and reports E_NOT_SCHEDULED with no
   obvious cause.

   Meanwhile the case the guard WAS written for is already closed by the
   platform: "You can't invoke scheduled functions directly with a URL."

   So the guard is defence in depth against a path the platform says does not
   exist, and the real residual risk is a person clicking a button in a UI. Say
   that to anyone who deploys this rather than letting them read the guard and
   feel covered.

   A correction to an earlier draft of this file, kept because it was wrong in an
   instructive direction. It said reachability "cannot be measured without
   deploying it". That was more uncertain than the evidence warranted: the docs
   answer it outright in the sentence above. What I had measured was that
   /api/upload returns 405 and /.netlify/functions/upload returns 404, which is a
   fact about a function that declares `path` and does not generalise to one that
   does not. Overclaiming and underclaiming are the same error with the sign
   flipped, and I did both in one file on the same afternoon.

   KEEP THE GUARD ANYWAY. It costs one JSON parse per run, it is the only thing
   standing between an accidental POST and a bulk delete if the platform's
   routing behaviour ever changes, and its test asserts that a refused call
   sweeps nothing rather than merely returning 403 after doing the work. Do not
   remove it on the grounds that the endpoint is unreachable; that property
   belongs to the platform and not to this repo.

   WHAT THE GUARD CANNOT BE, and this paragraph was WRONG from 2026-08-15 to
   2026-08-16. It is kept because the way it was wrong is worth more than the
   correction.

   It said: "The obvious guard is to check the deploy context and refuse outside
   production. It is not available: Netlify exposes CONTEXT during the BUILD, and
   at function runtime only URL, SITE_NAME and SITE_ID. Verified against the
   runtime environment-variables page rather than assumed from the build one,
   which lists CONTEXT and is the page you land on first."

   Every factual clause in that is true. The conclusion does not follow. What was
   verified is a fact about `process.env`; what was written is a claim about the
   capability. The deploy context is available, on the request, as the
   `x-nf-deploy-context` header, handed to the handler as
   `context.deploy.context`. It was arriving on every invocation of this very
   function and being discarded by a signature that took only `req`.

   The sentence did damage past this file: it was cited as independent
   corroboration for the ROW-37 finding, which made a false claim load-bearing
   for a true conclusion. Its confident register is what made it citable, and
   "verified against the runtime page rather than the build one" is exactly the
   phrasing that stops a reader checking. A narrower search than the sentence it
   supports leaves no trace in its own output.

   Both guards now exist and neither replaces the other; see the handler.
   Recorded in record/findings/the-deploy-scope-guard-reads-an-environment-that-is-never-set.md. */

import {
  sweep, sweepScopes, sweepHolds, dryRunSetChanged, dryRunCursor, saveDryRunCursor, dryRunReport
} from '../../lib/_store.mjs';
import { archiveMode } from '../../lib/_archive.mjs';

/* ROW-155, RAFFAEL'S CONDITION: "yes, but dry-run first and show me the
   list." While this is true the scope pass deletes nothing and logs, once
   an hour, the list of preview scopes it would have torn down, one entry
   per scope with the deploy context, the idle age and the key count per
   store. He reads that list for a week and decides; flipping this to false
   is the decision, made as a one-line change with its own yes rather than
   as an environment variable nobody can see in the diff. See `sweepScopes`
   in _store.mjs for what the list carries and why. Exported so the endpoint
   tests key off it: while it is true they assert the dry-run contract, and
   the moment it flips they assert the teardown, so the flip stays one line. */
export const SCOPE_SWEEP_DRY_RUN = true;

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

export default async (req, context) => {
  /* GUARD ONE: refuse outside production.

     The comment above this handler used to say this guard "is not available",
     and gave a reason that was true and narrower than the conclusion: Netlify
     exposes CONTEXT during the build, and at function runtime `process.env`
     carries only URL, SITE_NAME and SITE_ID. All correct, and all about
     `process.env`, which is not the only channel.

     The deploy context arrives on the REQUEST, as `x-nf-deploy-context`, and
     the runtime hands it to the handler as `context.deploy.context`
     (@netlify/serverless-functions-api, dist/headers.d.ts and dist/context.d.ts).
     It was being delivered on every invocation of this function and discarded
     by a signature that took only `req`. passport.mjs:34 already took the second
     argument for `context.params`, one directory away.

     THE TEST IS `!== 'production'`, NOT A LIST OF BAD VALUES, and NO ENUMERATION
     OF THE VALUE SET APPEARS HERE ON PURPOSE. `dist/context.d.ts` types
     `deploy.context` as `string`, not a union, so the type declarations support
     the accessor above and can never support a list of values. A first draft of
     this comment asserted the value is "'production', 'deploy-preview' or
     'branch-deploy'" anyway. A second draft cited `SUPPORTED_CONTEXTS` at
     `dist/utils/env/index.js:7` as the correction, which is better evidence and
     still not the right evidence: that is the CLI's ENVIRONMENT-VARIABLE SCOPING
     list, and it contains `'all'`, which is a sentinel no header can carry.

     Matching on the one value that must be allowed means an unknown value is
     refused rather than admitted, which is the safe direction for a bulk delete,
     and it is why none of the above costs anything operationally. Two drafts of
     one comment reached for an enumeration the code deliberately does not need.

     `netlify dev` REFUSES, AND THAT IS A STATEMENT RATHER THAN A HEDGE.
     `netlify-cli dist/lib/edge-functions/proxy.js:84` sets
     `req.headers['x-nf-deploy-context'] = 'dev'` unconditionally. It runs after
     the `if (!registry) return` at :79 and BEFORE the
     `if (functionNames.length === 0) return` at :96, so a site with no edge
     functions — which this one is, `web/netlify/` holds only `functions/` — still
     gets the header set, and `dist/utils/proxy.js:632` forwards the mutated
     request to the functions server. So the sweep endpoint returns 403 under
     `netlify dev`, always. That is correct: the sweep is exercised by the test
     suite, not by pointing a local dev server at production stores.

     ABSENT MEANS PRODUCTION, deliberately, and the asymmetry is the same one the
     store scoping is written to: a wrongly refused sweep is a maintenance job
     that silently stops running, and a wrongly permitted one is a bulk delete of
     live passports. Absent is what THIS TEST SUITE sees. It is NOT what a local
     run sees, per the paragraph above; an earlier version of this comment said
     "any local run" and was false about the one local runner anybody uses. Do
     not "fix" this into refusing on absence.

     `deploy.published` WAS CONSIDERED AND DECLINED, and the reason is worth the
     line. `getDeployObject` also returns `published`, from
     `x-nf-deploy-published`. A superseded or rolled-back deploy still serves at
     its permalink, still reports `context: 'production'`, and shares production's
     blobs because `_store.mjs` uses site-scoped `getStore`. So it passes this
     guard. Checking `published` would close that, and it is not added here
     because whether `Run now` can target such a deploy could not be established
     without deploying, and a guard added on an unestablished threat is how the
     struck paragraph above came to exist. Named so the next reader knows it was
     seen rather than missed. */
  const deploy = context && context.deploy;
  const deployContext = deploy && deploy.context;
  if (deployContext && deployContext !== 'production') {
    console.log('sweep refused:', JSON.stringify({ context: deployContext }));
    return json(403, {
      ok: false,
      code: 'E_NOT_PRODUCTION',
      message: 'This endpoint only runs on the production deploy.'
    });
  }

  /* GUARD TWO, which stays exactly as it was. It is not made redundant by the
     one above: that one keys on the deploy, this one keys on the caller, and
     the case they overlap on is only the preview. A hand-made POST to the
     PRODUCTION url passes guard one and is stopped here.

     Netlify invokes a scheduled function with a POST carrying a JSON body whose
     `next_run` is the next firing time. A browser, a curl, or anything reaching
     the preview URL by hand has neither.

     This is a shape check and not authentication, and it is written down as such
     so nobody later mistakes it for one. It cannot stop a caller who knows the
     shape and sends it deliberately. What it stops is the realistic case: a
     preview URL that is reachable, indexable and guessable, hit by a person, a
     crawler or an uptime checker, quietly deleting production passports. The
     platform stops the scheduled case; this stops the accidental one. Between
     them the deliberate-attacker case is what remains, and that caller could
     equally hit /api/delete, which is the endpoint actually designed to refuse
     them. */
  let nextRun = null;
  try {
    const body = await req.json();
    nextRun = body && body.next_run;
  } catch { /* no body, or not JSON: not the scheduler */ }

  if (!nextRun) {
    return json(403, {
      ok: false,
      code: 'E_NOT_SCHEDULED',
      message: 'This endpoint runs on a schedule and does not accept direct calls.'
    });
  }

  /* Failures are logged and swallowed rather than returned as a non-2xx. A
     scheduled function that reports failure gets retried by nobody and alerts
     nobody here, so the status code has no reader; the log is the only channel
     that does. Swallowing also keeps a single bad store from turning every run
     into a failed run, and the expiry index is a durable to-do list, so the next
     firing resumes from exactly where this one stopped. */
  try {
    /* ROW-37: guard one above has already refused anything that is not
       production, so `deploy` resolves to the bare production scope here
       too. Threaded through for the same reason as digest.mjs: one uniform
       rule, no store call anywhere in the system exempted from it. */
    const removed = await sweep(deploy);

    /* ROW-155: a second, separate pass, run after the first rather than
       inside its budget. `sweep()` above protects an invariant (index vs.
       row) that has to stay inside its own 20s share of the 30s scheduled
       ceiling; scope teardown has no such invariant and gets its own 5s
       share instead, so neither pass can starve the other. See the comment
       on sweepScopes() in _store.mjs for what it does and why the same
       function that never touches `metrics` or `attempts` here deletes both
       for an abandoned preview. */
    /* The dry run removes nothing, so without a resume point every run would
       list the same head of the queue. It resumes after the last entry the
       previous run listed and starts over once it has reached the first
       fresh entry; `scopesAbandoned` on the counts line is the whole backlog
       either way, so a partial block can be read against the total. */
    const after = SCOPE_SWEEP_DRY_RUN ? await dryRunCursor(deploy) : '';
    const scopes = await sweepScopes(deploy, { dryRun: SCOPE_SWEEP_DRY_RUN, dryRunAfter: after });
    if (SCOPE_SWEEP_DRY_RUN) await saveDryRunCursor(deploy, scopes.dryRunCursor);

    /* PH-507's third pass, run after the two above for the same starvation
       reason ROW-155 gave sweepScopes its own share: HOLD_SWEEP_BUDGET_MS is
       a separate, smaller budget (_store.mjs), so this cannot eat into
       sweep()'s 20s or sweepScopes()'s 5s.

       RENAMED, NOT SPREAD BARE. sweepHolds() returns { holds, pointers,
       listFailed, budgetSpent } -- the same field names sweep() already
       returns for a different meaning (a passport, not a hold, and its own
       budget, not this pass's). `...removed, ...holdsRemoved` in the log
       and response below would let the later spread silently overwrite the
       earlier `listFailed`/`budgetSpent`, hiding whichever pass actually
       ran into trouble behind whichever ran last. sweepScopes() already
       avoids this by naming every field with a `scopes` prefix; holds gets
       the same treatment here instead of trusting a future reader to
       notice the collision. */
    /* Archive mode (lib/_archive.mjs) still deletes every expired hold and its
       address, which is the privacy promise, and withholds the courtesy mail
       about it, which is the one thing this function sends. */
    const holdsRemoved = await sweepHolds(deploy, { mail: !archiveMode() });
    const holds = {
      holds: holdsRemoved.holds,
      holdPointers: holdsRemoved.pointers,
      holdsListFailed: holdsRemoved.listFailed,
      holdsBudgetSpent: holdsRemoved.budgetSpent,
      holdMailsDropped: holdsRemoved.mailsDropped,
      holdMailsWithheld: holdsRemoved.mailsWithheld
    };

    /* Counts only. No passport id, no key, no address: this line lands in a log
       that is readable with less ceremony than the stores are, and a swept id is
       still a passport uuid, which is the one secret in this system. The dry-run
       list is the one exception and it is deliberately not a list of keys: it
       names scopes (a deploy id or a branch name, neither a secret) and counts
       what each holds. It goes on its own line so the counts line stays the
       shape every earlier log reader expects.

       `expiryBacklog` and `expiryBacklogAgeMin` ride in on `...removed`, see
       sweep(). They are what "a run that regularly reports budgetSpent" at the
       bottom of this file is read against: a backlog that grows run on run, or
       an age past a few hours, means the hourly pass has stopped keeping up. */
    const { wouldTearDown, dryRunCursor: cursor, unreachedScopingErrors, ...scopeCounts } = scopes;
    let set = null;
    if (wouldTearDown) set = await dryRunSetChanged(deploy, scopes);
    console.log('sweep:', JSON.stringify({
      ...removed, ...scopeCounts, ...holds,
      ...(set ? { dryRunSet: set.fingerprint, dryRunSetChanged: set.changed } : {}),
      next_run: nextRun
    }));
    /* The per-entry block only when the set moved (see dryRunSetChanged).
       That goes quiet only when the whole backlog fits in one run, about
       eight scopes at the measured latency. Above that each run lists a
       different window and the block prints every hour for as long as the
       backlog is larger than one window (the wrap does not end it: the next
       pass groups the entries differently), so the whole list exists nowhere
       but spread across those lines; `resumedAfter` and `backlog` on each
       block are how a reader stitches them. A critic counted 38 blocks per
       pass for a 300-scope backlog and 90 blocks in 90 runs. */
    if (wouldTearDown && set.changed) {
      /* `partial: true` means the budget ran out before the walk reached the
         first fresh entry, so this is the head of the queue, not the whole
         of it, and the next run lists the same head. A critic showed a
         300-scope backlog printing eight entries with nothing on this line
         saying so. */
      console.log('sweep scopes dry-run, would tear down:', JSON.stringify(dryRunReport(scopes, set, after)));
    }

    return json(200, { ok: true, ...removed, ...scopes, ...holds });
  } catch (e) {
    console.error('sweep failed:', e && e.message);
    return json(200, { ok: false, code: 'E_SWEEP_FAILED' });
  }
};

/* HOURLY, and what that number is standing in for.

   The honest position: the right interval depends on how dirty the stores
   actually are, which is the orphan audit, which is parked pending ROW-31. This
   is not that number. It is a deliberate stand-in chosen to be obviously
   conservative rather than plausibly right.

   Why hourly is defensible without the measurement. A passport lives thirty
   days, so nothing here is time-critical: an expiry served an hour late is
   indistinguishable to everyone including the person who published it. Hourly
   bounds the backlog any single run has to clear to one hour of expiries and one
   hour of limiter keys, which is far inside the 200-passport and 1000-key bounds
   and inside the 20-second budget. And 24 invocations a day is a rounding error
   against the function allowance.

   What would change it. A run that regularly reports `budgetSpent: true` means
   an hour's backlog no longer fits in one pass, and the fix is a shorter
   interval rather than a bigger budget, because the 30-second ceiling is not
   ours to raise. A run that regularly reports all zeros means this is running
   more often than it needs to. Both are readable off the log line above without
   any store access, which is deliberate: the tuning signal should not itself
   require the credential that ROW-31 is about. */
export const config = { schedule: '@hourly' };

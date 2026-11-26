/* The gallery recount, once an hour (once a day until 2026-09-13; Raffael read a card that lagged the passport page by a day as a bug, and an hour is the cost of one more scheduled run).

   GALLERY-SPEC.md §7. Rebuilds every listed passport's tally from the votes
   store, copies views and copies into every card so a render never reads a
   counter store, rebuilds a card for a listed row that lost one, and deletes
   the votes, tallies and cards a race or a failed unlist left behind. The
   work is in lib/_store.mjs recount(); this file is the schedule and the
   guards.

   THE GUARDS ARE sweep.mjs's, AND THAT FILE'S COMMENT IS THE ARGUMENT for
   both of them, including the part about `Run now`, which can invoke this on
   a preview against site-wide stores and which nothing here can close. Read
   that comment rather than a copy of it; the two functions would otherwise
   drift the way two copies of anything drift. In one sentence each: guard one
   refuses any deploy context that is not `production`, matching the one
   allowed value rather than a list of bad ones, so an unknown value is refused
   and `netlify dev` (which sets `dev`) always gets 403; guard two refuses a
   caller that does not send the scheduler's `next_run` body, which is a shape
   check and not authentication.

   What a refused or failed run costs: an hour of tallies at most one lost
   update off, and a day of orphans nobody can see. Nothing here is time
   critical, and the log line is the only reader of the counts. */

import { recount } from '../../lib/_store.mjs';

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

export default async (req, context) => {
  const deploy = context && context.deploy;
  const deployContext = deploy && deploy.context;
  if (deployContext && deployContext !== 'production') {
    console.log('recount refused:', JSON.stringify({ context: deployContext }));
    return json(403, {
      ok: false,
      code: 'E_NOT_PRODUCTION',
      message: 'This endpoint only runs on the production deploy.'
    });
  }

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

  try {
    const out = await recount(deploy);
    /* Counts only. No passport id, no voter id, no key. `listed` against
       `refreshed` is the lag figure: see recount() for what each counts. */
    console.log('recount:', JSON.stringify({ ...out, next_run: nextRun }));
    return json(200, { ok: true, ...out });
  } catch (e) {
    console.error('recount failed:', e && e.message);
    return json(200, { ok: false, code: 'E_RECOUNT_FAILED' });
  }
};

/* Daily: a tally at most one lost update off for a day is invisible to
   everyone, and the orphan sweep has nobody waiting on it. */
export const config = { schedule: '@hourly' };

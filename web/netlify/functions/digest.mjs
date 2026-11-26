/* The daily digest, and it is DELIBERATELY NOT SCHEDULED AND CANNOT SEND.

   Read this before adding `schedule` to the config at the bottom.

   Raffael agreed to the idea of a daily mail. He has not seen one. The human
   gate on this crew is that nothing deploys, sends or publishes without his yes,
   and "yes to a daily digest" is not "yes to a function that starts mailing me
   tonight". So this file ships in three states and only the first is live:

     1. deployed, unscheduled, disabled          <- today
     2. deployed, unscheduled, enabled by env    <- after he has read a sample
     3. deployed, scheduled                      <- after he has had one by hand

   Getting to 2 is setting DIGEST_TO in the Netlify environment and then
   creating a new deploy, because Netlify applies environment variables per
   deploy (see the kill-switch note in lib/_jev.mjs). Getting to 3 is
   adding `schedule` below. Both are deliberate acts by a person, which is the
   point: there is no state of this file where forgetting something causes mail
   to be sent.

   THREE GUARDS, in the order they run, and the first two are copied from
   sweep.mjs rather than invented, because that endpoint had to solve exactly
   this problem and the reasoning there is worth reading.

   Guard one, production only, via `context.deploy.context`. Without it, every
   deploy preview that anyone pokes mails Raffael a report built from production
   data. Netlify does not fire scheduled functions on previews, but this endpoint
   is reachable by URL whether or not it is scheduled, so the platform's
   behaviour is not the guard.

   Guard two, the scheduler's shape. A shape check and not authentication, and
   sweep.mjs says so at length. It stops the accidental case: a crawler or an
   uptime checker hitting a reachable function URL. It does not stop somebody who
   knows the shape.

   Guard three, and this one is not in sweep.mjs: NO RECIPIENT, NO MAIL. There is
   no default address and no fallback. An unset DIGEST_TO is not an error to be
   worked around, it is the off switch. */

import { getDay, readCorpusDay, claimDigestDay } from '../../lib/_store.mjs';
import { digestReport } from '../../lib/_digest.mjs';
import { mailConfig, mailEnabled, sendMail, validAddress } from '../../lib/_email.mjs';
import { archiveMode } from '../../lib/_archive.mjs';

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

export default async (req, context) => {
  const deployContext = context && context.deploy && context.deploy.context;
  if (deployContext && deployContext !== 'production') {
    console.log('digest refused:', JSON.stringify({ context: deployContext }));
    return json(403, {
      ok: false,
      code: 'E_NOT_PRODUCTION',
      message: 'This endpoint only runs on the production deploy.'
    });
  }

  /* ROW-37: guard one above already refuses any deploy this is not, so
     `deploy` resolves to the bare production scope by the time anything
     below reads it. Threaded through anyway rather than special-cased, so
     _store.mjs's scoping is one uniform rule with no store call in the
     system that is exempt from it — belt and suspenders against the guard
     ever being bypassed rather than reliance on it alone. */
  const deploy = context && context.deploy;

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

  /* Archive mode sends no digest and claims no day (lib/_archive.mjs).
     Logged for the reason given below for a disabled digest. */
  if (archiveMode()) {
    console.log('digest disabled:', JSON.stringify({ archived: true }));
    return json(200, { ok: true, sent: false, reason: 'archived' });
  }

  const to = (process.env.DIGEST_TO || '').trim();
  if (!to || !validAddress(to) || !mailEnabled()) {
    /* Logged rather than returned as an error, for sweep.mjs's reason: a
       scheduled function's status code has no reader. The log line is the only
       channel, and "disabled" must be visible in it or the first question after
       a silent week is unanswerable. */
    console.log('digest disabled:', JSON.stringify({
      recipient: to ? (validAddress(to) ? 'set' : 'invalid') : 'unset',
      mail: mailEnabled() ? 'configured' : 'unconfigured'
    }));
    return json(200, { ok: true, sent: false, reason: 'E_DIGEST_DISABLED' });
  }

  /* YESTERDAY, not today. A digest that fires at 07:00 and reports "today" would
     describe seven hours and call it a day, and the number would be quietly
     wrong every morning rather than loudly wrong once. `next_run` is not used
     for this: it is the NEXT firing, so deriving the reporting day from it is
     off by one schedule interval, which is the kind of error that survives
     review because the code reads plausibly. */
  const day = getDay(Date.now() - 86400e3);

  /* Claimed BEFORE the work, not after. A claim after a successful send leaves
     the window between reading and sending open to a second caller, which is
     the window that matters when the read takes seconds. */
  if (!await claimDigestDay(deploy, day)) {
    console.log('digest already claimed:', JSON.stringify({ day }));
    return json(200, { ok: true, sent: false, reason: 'E_DIGEST_ALREADY_SENT' });
  }

  try {
    const { metrics, attempts, listed, unreadable } = await readCorpusDay(deploy, day);

    /* `listed` IS PASSED THROUGH, and dropping it was the worst defect in the
       first version of this file.

       readCorpusDay goes to deliberate trouble to tell a failed listing from an
       empty store, and _store.mjs says at length why collapsing those two "is
       how all zeros stops being readable". This handler destructured
       `{ metrics, attempts }` and let the distinction fall on the floor.

       The consequence: during a blob-store outage the mail said "Nothing was
       uploaded on this day. Not an error: no rows exist for it in either store."
       It asserted the negative it could not know, in the sentence written
       specifically to stop the reader worrying. This is the only surface
       through which the beta is watched, and it was reassuring in precisely the
       case it should have been loudest. */
    const { subject, text } = digestReport({ day, metrics, attempts, listed, unreadable });

    /* SENDMAIL DOES NOT THROW. It returns `{ ok, reason }` — see _email.mjs,
       which catches its own network error and turns a non-2xx into a reason
       string. The first version of this handler ignored the return value and
       sat inside a try/catch, so a failed send was reported as `sent: true` and
       logged as "digest sent". The catch could not have caught it: there was
       nothing to catch.

       Found by writing the test for the catch rather than by reading the code.
       The test asserted E_DIGEST_FAILED on a broken provider and got sent:true,
       which is the bug rather than the test being wrong. */
    const posted = await sendMail({ to, subject, text, html: null, config: mailConfig() });
    if (!posted || !posted.ok) {
      /* The claim is NOT released. A missing digest is visible to its reader as
         a missing mail; a double digest is visible as nothing, and releasing
         would also hand back the once-a-day bound that is the only thing
         keeping this endpoint from being a repeatable send button. Losing one
         day to a provider outage is the cheaper failure, and the log line names
         it. */
      console.error('digest send failed:', JSON.stringify({ day, reason: posted && posted.reason }));
      return json(200, { ok: true, sent: false, reason: 'E_DIGEST_SEND_FAILED' });
    }

    console.log('digest sent:', JSON.stringify({
      day, published: metrics.length, refused: attempts.length, listed, unreadable
    }));
    return json(200, { ok: true, sent: true, day });
  } catch (e) {
    /* Swallowed, like the sweep's. A digest that fails is a missing mail, not a
       broken site, and nothing retries it. */
    console.error('digest failed:', JSON.stringify({ day, reason: e && e.message }));
    return json(200, { ok: true, sent: false, reason: 'E_DIGEST_FAILED' });
  }
};

/* NO `schedule` KEY, AND NO `path` KEY EITHER. Both absences are deliberate and
   the second one was a defect in the first version of this file.

   I gave this `path: '/api/digest'`, copying the shape of the endpoints around
   it without asking what a path is for. A path publishes a function at a
   friendly public URL. `sweep.mjs`, the other scheduled function here, has no
   path for exactly that reason: a scheduled function does not need one, because
   the scheduler invokes it directly.

   What the path bought was nothing, and what it cost was a public send button.
   A critic wrote the curl: with `DIGEST_TO` set, anyone could POST
   `{"next_run":1}` and cause a mail plus a full corpus read, as often as they
   liked, each one against the mail quota and the blob store.

   Removing the path does not make it unreachable — `/.netlify/functions/digest`
   still resolves, and `sweep.mjs` says plainly that its shape check is not
   authentication. It removes the advertised door. The once-a-day claim in the
   handler is what actually bounds the damage. */
export const config = {};

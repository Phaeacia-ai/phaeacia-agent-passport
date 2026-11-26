/* POST /api/delete — { id, token }

   Deletion is immediate and irreversible. There is no soft delete, no tombstone
   and no undo, because a tombstone would answer "did a passport ever exist at
   this uuid", which the not-found rule exists to refuse.

   A wrong token, a malformed token and a uuid that does not exist all return the
   same E_DELETE_FAILED. */

import { err } from '../../lib/_validate.mjs';
import { crossSite } from '../../lib/_origin.mjs';
import { clientIp, rateLimit, deletePassport } from '../../lib/_store.mjs';

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

export default async (req, context) => {
  if (req.method !== 'POST') return json(405, { ok: false, ...err('E_METHOD') });

  /* Refused when a page on another site sent it, before anything is counted
     or read (lib/_origin.mjs). */
  if (crossSite(req)) return json(403, { ok: false, ...err('E_CROSS_SITE') });

  /* ROW-37: which store this request touches. See _store.mjs's "deploy
     scoping" section. */
  const deploy = context && context.deploy;

  /* The limiter counts every attempt, including failed ones, and that is
     deliberate rather than an oversight left in place.

     Failures cannot be dropped from the count: they are the only thing capping
     this endpoint, and an attacker sends nothing but failures. Counting only
     successes would leave it uncapped for flooding.

     Failures also cannot be brute-forced into a success. The token is 20 bytes
     of cryptographic randomness, 160 bits, compared in constant time. Working
     through half of 2^160 at the old ceiling of 10 an hour takes on the order
     of 10^42 years; lifting the ceiling to a million an hour takes it down to
     10^37. Both are the same answer. The limiter is therefore a flood speed
     bump and never the thing standing between an attacker and a passport, so
     its ceiling can be set for the owner's comfort rather than for the
     attacker's inconvenience.

     So: 20 an hour rather than 10, with a message that says what happened and
     how long it lasts, and the same number printed on /delete beside the token
     field. Ten wrong pastes no longer lock an owner out of deleting their own
     passport under a page that promises deletion is immediate.

     DOCUMENTED DEVIATION from upload-validation.md §3, which says 10. This is
     the fourth deviation and the README lists it with the other three.

     The window is a tumbling one, not a rolling one, and this comment used to
     say rolling. It is bucketed on floor(now/windowMs), so somebody who spends
     20 attempts at 10:59 gets 20 more at 11:00. For a flood speed bump in front
     of 160 bits of token, 40 across a boundary is the same answer as 20; it is
     written down because a limit described as rolling and implemented as
     tumbling is the kind of thing that gets designed around later. */
  const ip = clientIp(req);
  if (!(await rateLimit(deploy, ip, 'del-h', 20, 3600e3))) {
    return json(429, { ok: false, ...err('E_DELETE_LIMIT') });
  }

  let payload;
  try { payload = await req.json(); } catch { payload = null; }
  if (!payload || typeof payload.id !== 'string' || typeof payload.token !== 'string') {
    return json(404, { ok: false, ...err('E_DELETE_FAILED') });
  }

  const ok = await deletePassport(deploy, payload.id, payload.token);
  if (!ok) return json(404, { ok: false, ...err('E_DELETE_FAILED') });
  return json(200, { ok: true });
};

export const config = { path: '/api/delete' };

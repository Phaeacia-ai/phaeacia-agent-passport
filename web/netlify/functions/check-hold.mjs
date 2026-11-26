/* POST /api/check-hold — { hold_id, hold_token } -> { ok, status, id? }

   PH-507's hold disposition. The owner's own receipt for a held upload, the
   same shape /api/manage's 'status' action is for a published one: the hold
   id and token from the upload response are the only credential this site
   hands back, so they are also the only thing that can answer "what happened
   to my upload".

   THREE STATUSES, and checkHold() in lib/_store.mjs is where the reasoning
   for exactly these three lives (grep it there rather than re-argued here):
     pending    still held, nobody has decided yet
     released   a reviewer released it; `id` names the published passport
     not_found  wrong token, unknown id, malformed id, an expired-and-swept
                hold, or a refused hold -- one answer for all of them, on the
                same "not for sale one guess at a time" rule /api/manage and
                /p/:id already keep for a passport id.

   No fourth status for a refusal specifically: refuseHold() has nothing to
   point at, and a status that distinguished "refused" from "never existed"
   would let a guess learn which uuids were ever real holds. */

import { err } from '../../lib/_validate.mjs';
import { clientIp, rateLimit, checkHold } from '../../lib/_store.mjs';

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

const failed = () => json(400, {
  ok: false,
  code: 'E_HOLD_CHECK_FAILED',
  message: 'That link is incomplete. Check that you pasted the whole thing.'
});

export default async (req, context) => {
  if (req.method !== 'POST') return json(405, { ok: false, ...err('E_METHOD') });

  /* ROW-37: which store this request touches. See _store.mjs's "deploy
     scoping" section. */
  const deploy = context && context.deploy;

  /* Same order of magnitude as /api/manage's 20/hour: a hold token is minted
     the same way a delete token is (mintDeleteToken, reused deliberately —
     see createHold), 160 bits of randomness, so the same guessing-resistance
     argument and the same ceiling apply. Counted per network, not per hold,
     so a wrong guess never costs the hold it was aimed at. */
  const ip = clientIp(req);
  if (!(await rateLimit(deploy, ip, 'hold-check-h', 20, 3600e3))) {
    return json(429, { ok: false, code: 'E_HOLD_CHECK_LIMIT',
      message: 'Too many attempts from this network. The limit is 20 in an hour, counted per network. Your hold is unaffected.' });
  }

  let payload;
  try { payload = await req.json(); } catch { payload = null; }
  if (!payload || typeof payload.hold_id !== 'string' || typeof payload.hold_token !== 'string') {
    return failed();
  }

  const result = await checkHold(deploy, payload.hold_id, payload.hold_token);
  return json(200, { ok: true, ...result });
};

export const config = { path: '/api/check-hold' };

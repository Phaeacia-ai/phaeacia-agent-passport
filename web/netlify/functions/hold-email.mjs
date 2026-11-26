/* POST /api/hold-email — { hold_id, hold_token, email } -> { ok, status }

   PH-507's hold disposition, Raffael's instruction relayed by HAL: "please
   also set it up so they can leave their e-mail". Attaches an address to an
   already-held upload so the owner can be told the outcome once a reviewer
   decides. Optional: an upload holds with `email: null` and can be checked
   with /api/check-hold with no address ever left.

   Requires the hold token, same reasoning as /api/subscribe requiring the
   delete token: without it this is a form anyone can post arbitrary
   addresses into, keyed off a hold id they would have to guess (see
   check-hold.mjs's own comment on that guessing-resistance argument).

   OVERWRITES, NOT MERGES — see attachHoldEmail in lib/_store.mjs. A second
   call with a different address corrects the first; there is one owner, one
   hold, one address.

   Same not_found collapsing as check-hold.mjs: a wrong token and an unknown
   id both fail the same way, so a guess cannot tell them apart. */

import { err } from '../../lib/_validate.mjs';
import { crossSite } from '../../lib/_origin.mjs';
import { clientIp, rateLimit, attachHoldEmail } from '../../lib/_store.mjs';
import { validAddress } from '../../lib/_email.mjs';
import { archiveMode, archivedResponse } from '../../lib/_archive.mjs';

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

const failed = () => json(400, {
  ok: false,
  code: 'E_HOLD_EMAIL_FAILED',
  message: 'That link is incomplete, or the hold is gone. Check that you pasted the whole link.'
});

export default async (req, context) => {
  if (req.method !== 'POST') return json(405, { ok: false, ...err('E_METHOD') });

  /* Archive mode stores no new address and sends no outcome mail
     (lib/_archive.mjs). The hold itself still expires and is deleted. */
  if (archiveMode()) return archivedResponse();

  /* Refused when a page on another site sent it, before anything is counted
     or read (lib/_origin.mjs). */
  if (crossSite(req)) return json(403, { ok: false, ...err('E_CROSS_SITE') });

  /* ROW-37: which store this request touches. See _store.mjs's "deploy
     scoping" section. */
  const deploy = context && context.deploy;

  /* Same ceiling as check-hold.mjs, same reasoning: a hold token carries the
     same 160 bits of randomness a delete token does. */
  const ip = clientIp(req);
  if (!(await rateLimit(deploy, ip, 'hold-email-h', 20, 3600e3))) {
    return json(429, { ok: false, code: 'E_HOLD_EMAIL_LIMIT',
      message: 'Too many attempts from this network. The limit is 20 in an hour, counted per network. Your hold is unaffected.' });
  }

  let payload;
  try { payload = await req.json(); } catch { payload = null; }
  if (!payload || typeof payload.hold_id !== 'string' || typeof payload.hold_token !== 'string') {
    return failed();
  }

  const email = validAddress(payload.email);
  if (!email) {
    return json(422, { ok: false, code: 'E_BAD_ADDRESS',
      message: 'That does not look like an email address. Check it and try again.' });
  }

  const result = await attachHoldEmail(deploy, payload.hold_id, payload.hold_token, email);
  if (result.status !== 'ok') return failed();
  return json(200, { ok: true, status: 'ok' });
};

export const config = { path: '/api/hold-email' };

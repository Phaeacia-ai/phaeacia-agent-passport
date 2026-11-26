/* POST /api/subscribe — { id, token, email }
   GET  /api/subscribe — { ok, enabled }, so the page hides a box that cannot work.

   The optional "tell me what comes next" box on the success screen. It exists
   instead of a gate in front of the upload: the decision, taken 2026-08-10, is
   that a wall in front of a product nobody has heard of buys a bounce rather
   than scarcity, and that what a gate would have bought — knowing who showed up
   and being able to reach them — belongs AFTER somebody has watched their own
   agent render as a passport.

   What this endpoint is, precisely, because it is the first thing on this site
   that stores a personal detail:

   - It is a mailing list, and it says so. Unlike /api/send, which holds an
     address for the length of one request, this one hands it to Resend to keep.
     privacy.html says that in those words. If this comment and that page ever
     disagree, the page is the promise and this is the bug.
   - It needs the delete token. Not as security theatre: without it this is a
     form anyone can post arbitrary addresses into, and the first thing that
     happens to an open subscribe endpoint is somebody else's address being
     signed up from it. The token proves the caller just published.
   - It is consent, recorded once, and never assumed. The client sends
     `consent: true` only from an unticked checkbox the person ticked. That is
     the lawful basis, and it is withdrawable by the unsubscribe link Resend
     puts in every broadcast.
   - It cannot fail a publish. It runs after one, from a separate request, so
     the worst it can do is show an error under a passport that is already live.
   - It stores nothing on this site. No blob, no counter, no local copy. The
     address exists here for the length of this request and then only at Resend.

   Off by default. Without RESEND_API_KEY and SUBSCRIBE_SEGMENT_ID the GET says
   enabled: false and the box never draws, which is a normal deployment rather
   than a broken one, exactly as /api/send behaves without a key. */

import { err } from '../../lib/_validate.mjs';
import { crossSite } from '../../lib/_origin.mjs';
import { clientIp, rateLimit, authorise } from '../../lib/_store.mjs';
import { validAddress } from '../../lib/_email.mjs';
import { archiveMode, archivedResponse } from '../../lib/_archive.mjs';

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

const RESEND = 'https://api.resend.com';
export const SUBSCRIBE_TIMEOUT_MS = 8000;

export const subscribeConfig = (env = process.env) => ({
  key: env.RESEND_API_KEY || '',
  segment: env.SUBSCRIBE_SEGMENT_ID || '',
  api: env.MAIL_API_BASE ? env.MAIL_API_BASE.replace(/\/emails$/, '') : RESEND
});
export const subscribeEnabled = (env = process.env) => {
  const c = subscribeConfig(env);
  return Boolean(c.key && c.segment);
};

export default async (req, context) => {
  /* Archive mode adds nobody to the list: disabled on GET, 410 on POST,
     before the limiter (lib/_archive.mjs). */
  if (req.method === 'GET') return json(200, { ok: true, enabled: !archiveMode() && subscribeEnabled() });
  if (req.method !== 'POST') return json(405, { ok: false, ...err('E_METHOD') });
  if (archiveMode()) return archivedResponse();

  /* Refused when a page on another site sent it, before anything is counted
     or read (lib/_origin.mjs). */
  if (crossSite(req)) return json(403, { ok: false, ...err('E_CROSS_SITE') });

  const cfg = subscribeConfig();
  if (!subscribeEnabled()) return json(503, { ok: false, ...err('E_SEND_DISABLED') });

  /* ROW-37: which store this request touches. See _store.mjs's "deploy
     scoping" section. */
  const deploy = context && context.deploy;

  const ip = clientIp(req);
  if (!(await rateLimit(deploy, ip, 'sub-h', 5, 3600e3))) {
    return json(429, { ok: false, ...err('E_SEND_LIMIT') });
  }

  let payload;
  try { payload = await req.json(); } catch { payload = null; }
  if (!payload || typeof payload.id !== 'string' || typeof payload.token !== 'string') {
    return json(404, { ok: false, ...err('E_MANAGE_FAILED') });
  }

  /* Same answer for a wrong token, a deleted passport and a uuid that never
     existed, and authorise() reads metadata rather than the body so all three
     cost the same. */
  if (!(await authorise(deploy, payload.id, payload.token))) {
    return json(404, { ok: false, ...err('E_MANAGE_FAILED') });
  }

  /* The checkbox ships unticked and the client sends this only when it is
     ticked. A request without it is a bug in the page or a hand-rolled POST,
     and either way there is no consent to act on. */
  if (payload.consent !== true) {
    return json(400, { ok: false, code: 'E_NO_CONSENT',
      message: 'Tick the box to agree before this can be sent.' });
  }

  const email = validAddress(payload.email);
  if (!email) {
    return json(422, { ok: false, code: 'E_BAD_ADDRESS',
      message: 'That does not look like an email address. Check it and try again.' });
  }

  /* Resend renamed audiences to segments and the API kept both paths for a
     while. lib/_email.mjs does not do this because it only ever posts /emails;
     the website's access endpoint carries the same fallback for the same
     reason.

     ONE DEADLINE FOR BOTH CALLS, added 2026-10-22: there was none, so a
     provider that never answered held this request until the platform killed
     it, and the person got a platform error instead of E_SUBSCRIBE_FAILED.
     AbortSignal.timeout as in sendMail, but shared rather than per call,
     because the fallback makes this up to two sequential requests and the
     bound that matters is the pair. SUBSCRIBE_TIMEOUT_MS sits under the
     lowest synchronous limit this repo still budgets against (ten seconds,
     lib/_store-core.mjs's drop() note), with room for the limiter and
     authorise() round trips in front of it. An abort lands in the catch
     below as a TimeoutError, which is what it logs. */
  const signal = AbortSignal.timeout(SUBSCRIBE_TIMEOUT_MS);
  const post = async (path) => fetch(cfg.api + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email, unsubscribed: false }),
    signal
  });

  try {
    let res = await post(`/segments/${cfg.segment}/contacts`);
    if (res.status === 404) res = await post(`/audiences/${cfg.segment}/contacts`);

    /* Already on the list is a success from where the person is standing. */
    if (res.ok || res.status === 409) return json(200, { ok: true });

    /* Nothing from the provider's response is logged. Resend echoes the address
       back in some 4xx bodies and this site promises it keeps no copy of its own, so a
       status code is the whole of what goes to the log. */
    console.error('subscribe failed', { status: res.status });
    return json(502, { ok: false, code: 'E_SUBSCRIBE_FAILED',
      message: 'That did not go through. Your passport is published and the link works; only this failed.' });
  } catch (e) {
    console.error('subscribe threw', { name: e && e.name });
    return json(502, { ok: false, code: 'E_SUBSCRIBE_FAILED',
      message: 'That did not go through. Your passport is published and the link works; only this failed.' });
  }
};

export const config = { path: '/api/subscribe' };

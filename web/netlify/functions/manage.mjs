/* POST /api/manage — { id, token, action: 'status' | 'renew' | 'list' | 'unlist' }

   The delete token is the only credential this site has, so it is also the only
   thing that can answer "is my passport still up, and has anyone opened it",
   and, since the gallery, the only thing that can list or unlist it. There are
   no accounts, and adding one to show a view count would be a bad trade.

   Every failure is the same failure. A wrong token, a malformed token, an id
   that expired, an id that was deleted, an id that never existed and a
   category that is not one all return E_MANAGE_FAILED with the same status
   and the same body, for the same reason /p/:id returns one 404 for all of
   them: the answer to "does a passport exist at this uuid" is not for sale
   one guess at a time. An unlist of a passport that is not listed is NOT a
   failure: it answers ok with the row's expiry, because a repeated press on
   a page that has not refreshed is the common case, and the store treats it
   the same way (unlistPassport is idempotent).

   Deleting lives at /api/delete and is not duplicated here. */

import { err } from '../../lib/_validate.mjs';
import { crossSite } from '../../lib/_origin.mjs';
import { isCategory } from '../../lib/_categories.mjs';
import { archiveMode, archivedResponse } from '../../lib/_archive.mjs';
import {
  clientIp, rateLimit, statusOf, renewPassport, listPassport, unlistPassport, RENEW_DAYS
} from '../../lib/_store.mjs';

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

const failed = () => json(404, { ok: false, ...err('E_MANAGE_FAILED') });

const ACTIONS = new Set(['status', 'renew', 'list', 'unlist']);

/* Refused in archive mode (lib/_archive.mjs): listing makes a passport
   permanent and public, and renewing keeps an unlisted one alive. Status and
   unlist stay, because withdrawing is the owner's right whatever the site's
   state. */
const ARCHIVE_REFUSED = new Set(['renew', 'list']);

export default async (req, context) => {
  if (req.method !== 'POST') return json(405, { ok: false, ...err('E_METHOD') });

  /* Refused when a page on another site sent it, before anything is counted
     or read (lib/_origin.mjs). */
  if (crossSite(req)) return json(403, { ok: false, ...err('E_CROSS_SITE') });

  /* ROW-37: which store this request touches. See _store.mjs's "deploy
     scoping" section. */
  const deploy = context && context.deploy;

  /* Counted per network, failures included, on the same reasoning as the delete
     endpoint: failures are the only thing this needs capping against, and 160
     bits of token is what stands between a guess and a passport. Listing and
     unlisting ride on the same ceiling (GALLERY-SPEC.md §8). */
  /* The body is read before the limiter so that an action archive mode
     refuses is answered without writing a limiter key. Everything else is
     counted exactly as before: the limiter still runs ahead of every check on
     the payload, malformed ones included. */
  let payload;
  try { payload = await req.json(); } catch { payload = null; }
  if (archiveMode() && payload && ARCHIVE_REFUSED.has(payload.action)) return archivedResponse();

  const ip = clientIp(req);
  if (!(await rateLimit(deploy, ip, 'man-h', 20, 3600e3))) {
    return json(429, { ok: false, ...err('E_MANAGE_LIMIT') });
  }

  if (!payload || typeof payload.id !== 'string' || typeof payload.token !== 'string') {
    return failed();
  }

  const action = ACTIONS.has(payload.action) ? payload.action : 'status';
  const { id, token } = payload;

  if (action === 'list') {
    /* The category is checked before the token so a bad one costs no store
       read, and it is one answer either way: E_MANAGE_FAILED, like every
       other refusal here. The UI never sends a bad one; a client that does
       is not the UI. */
    if (!isCategory(payload.category)) return failed();
    if (!(await listPassport(deploy, id, token, payload.category))) return failed();
    const status = await statusOf(deploy, id, token);
    if (!status) return failed();
    return json(200, { ok: true, status, renew_days: RENEW_DAYS });
  }

  if (action === 'unlist') {
    const un = await unlistPassport(deploy, id, token);
    if (!un) return failed();
    const status = await statusOf(deploy, id, token);
    if (!status) return failed();
    return json(200, { ok: true, status, expires_at: un.expires_at, renew_days: RENEW_DAYS });
  }

  if (action === 'renew') {
    /* RENEW ON A LISTED ROW (GALLERY-SPEC.md §4). A listed passport has no
       expiry to move, so renewPassport returns null for it, and this handler
       used to turn every null into E_MANAGE_FAILED. Read the status first:
       when it is listed, answer ok with `renewed_to: null` and the status,
       having called nothing that writes. The page hides the renew row for a
       listed passport; this is for the client that presses it anyway. */
    const status = await statusOf(deploy, id, token);
    if (!status) return failed();
    if (status.listed) return json(200, { ok: true, renewed_to: null, renew_days: RENEW_DAYS, status });
    const expires_at = await renewPassport(deploy, id, token);
    if (!expires_at) return failed();
    const after = await statusOf(deploy, id, token);
    return json(200, { ok: true, renewed_to: expires_at, renew_days: RENEW_DAYS, status: after });
  }

  const status = await statusOf(deploy, id, token);
  if (!status) return failed();
  return json(200, { ok: true, status, renew_days: RENEW_DAYS });
};

export const config = { path: '/api/manage' };

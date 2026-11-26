/* POST /api/copied — { id }: one press of the copy control on a passport page.

   GALLERY-SPEC.md §7b. Raffael asked for "most installed", and there is no
   such number and no honest way to get one: an install is a block of text
   pasted into somebody else's agent, and nothing reaches us when that happens.
   NOTHING IN THE INSTALLER TEXT EVER PHONES HOME; that would be a tracking
   pixel inside a product whose promise is that nothing leaves the owner's
   machine, and it is refused here in writing so nobody proposes it later.

   What can be counted is a press of the copy control, sent by assets/passport.js
   after a successful copy. Same origin, no cookie, no body beyond the id,
   and the answer to that page is 204 whatever happened: a well-formed id
   that names no live passport counts nothing and is answered the same, so
   this endpoint is not an oracle for whether a uuid exists (the page it is
   sent from already answered that). A copy made with JavaScript off, by selecting the text, is
   not counted, and the privacy page says "copies made with the copy control".

   Any live passport counts, listed or not, so a passport listed later brings
   its count with it. The word on every surface is "copied", never
   "installed". Rate limit cp-h, 60 an hour per network: a held-down key is a
   speed bump and not a leaderboard. The 429 carries no body, because nothing
   reads one; the client fires and forgets. */

import { err } from '../../lib/_validate.mjs';
import { clientIp, rateLimit, bumpCopies, UUID } from '../../lib/_store.mjs';
import { crossSite, mediaType } from '../../lib/_origin.mjs';
import { archiveMode } from '../../lib/_archive.mjs';

const empty = (status) => new Response(null, { status, headers: { 'cache-control': 'no-store' } });

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, ...err('E_METHOD') }), {
      status: 405,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    });
  }

  /* A press on another site's page is not a press of this site's copy
     control. Refused before the limiter, bodyless like every other answer
     here; lib/_origin.mjs has the rule. application/json is required as well,
     and it is what the one caller, assets/passport.js, sends. A browser will
     not send that type to another site without first asking it, and nothing
     here answers yes, so even a browser too old to send the headers that rule
     reads cannot count a copy from another site's page. Both answers are
     decided by headers before the id is read, so neither makes this an
     oracle for whether a uuid exists. */
  if (crossSite(req)) return empty(403);
  if (mediaType(req) !== 'application/json') return empty(415);

  /* Archive mode counts nothing and writes no limiter key. 410 with no body,
     decided before the id is read, so it is no oracle either; the client
     fires and forgets (lib/_archive.mjs). */
  if (archiveMode()) return empty(410);

  /* ROW-37: which store this request touches. See _store.mjs's "deploy
     scoping" section. */
  const deploy = context && context.deploy;

  const ip = clientIp(req);
  if (!(await rateLimit(deploy, ip, 'cp-h', 60, 3600e3))) return empty(429);

  let id = null;
  try {
    const j = await req.json();
    id = j && j.id;
  } catch { /* nothing to count */ }

  if (typeof id === 'string' && UUID.test(id)) await bumpCopies(deploy, id);
  return empty(204);
};

export const config = { path: '/api/copied' };

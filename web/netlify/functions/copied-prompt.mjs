/* POST /api/copied-prompt — { path: "f" | "w" }: one press of the copy
   control on /create, for whichever capture-path prompt was copied. F is
   the folder-on-your-computer prompt, W is the browser-chat prompt. Filed
   on the Crew Board (Project Agent Passport, Lane web-backend): Raffael
   wants to know which capture path gets copied more. Only F's button is
   live on /create today; W's button is on the unmerged branch
   frontend/row-262-create-browser-chat, so this ships counting F now and
   starts counting W the day that branch merges — the contract already
   accepts "w" and nothing here changes when it does.

   Same shape as netlify/functions/copied.mjs and built by reading it
   first: same origin, no cookie read, no body echoed back, fire and
   forget from the client, 204 to that page whatever happened so this is
   never an oracle. UNLIKE copied.mjs this counts against no passport id — there is
   nothing to look up, so there is nothing this endpoint could confirm or
   deny the existence of by its answer. Anything that is not exactly the
   string "f" or "w" counts nothing and still answers 204; see
   lib/_store.mjs's PROMPT_COPY_PATHS, the one place that set is defined.

   Rate limit pcp-h, 60 an hour per network, its own bucket rather than
   copied.mjs's cp-h: a held-down key is a speed bump, not a leaderboard,
   for the same reason copied.mjs gives in full. One shared bucket across
   both paths, not split per path, matching copied.mjs's own shape (it
   does not split by passport id either) — a script alternating f/w to
   dodge a per-path limit gets nothing from it.

   PRIVACY: counting a press here is not yet described on privacy.html.
   web-frontend owns that text and drafts it; this endpoint ships no
   sooner than that wording lands, per HAL. What this stores, for that
   text to describe accurately: one row per press in a store named
   prompt-clicks, keyed "f:<random>" or "w:<random>" — a fresh random
   suffix, not a timestamp or anything derived from the request, so no key
   joins a press to a person or a session; the count Raffael sees is the
   number of keys under each prefix. No IP, no id in the row itself — the
   rate limiter's own key does hash the caller's IP, exactly as copied.mjs's
   does, and expires with its bucket. Why one key per press rather than a
   single incrementing counter: lib/_store.mjs's comment on bumpPromptCopy
   has the reproduced counterexample — a get-then-increment counter loses
   almost every write once presses of the SAME path arrive concurrently,
   because unlike views/copies there are only two keys in the whole store
   for every press in the world to contend on. */

import { err } from '../../lib/_validate.mjs';
import { clientIp, rateLimit, bumpPromptCopy, PROMPT_COPY_PATHS } from '../../lib/_store.mjs';
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

  /* The same two refusals as copied.mjs and for its reasons, read there. The
     one caller, assets/site.js, sends application/json. */
  if (crossSite(req)) return empty(403);
  if (mediaType(req) !== 'application/json') return empty(415);

  /* Archive mode counts nothing, as in copied.mjs (lib/_archive.mjs). */
  if (archiveMode()) return empty(410);

  const deploy = context && context.deploy;

  const ip = clientIp(req);
  if (!(await rateLimit(deploy, ip, 'pcp-h', 60, 3600e3))) return empty(429);

  let path = null;
  try {
    const j = await req.json();
    path = j && j.path;
  } catch { /* nothing to count */ }

  if (typeof path === 'string' && PROMPT_COPY_PATHS.has(path)) await bumpPromptCopy(deploy, path);
  return empty(204);
};

export const config = { path: '/api/copied-prompt' };

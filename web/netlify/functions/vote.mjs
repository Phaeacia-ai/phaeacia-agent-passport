/* POST /api/vote — an up or down vote on a listed passport, one per browser.

   GALLERY-SPEC.md §7. Accepts two request shapes and answers each in kind:
     application/json                  { id, dir }         -> { ok, up, down, yours }
     application/x-www-form-urlencoded id, dir, back       -> 303 to /p/<id>, or to
                                                              /gallery when back=gallery
   A request a page on another site sent gets 403 E_CROSS_SITE in either shape,
   before anything else is read (lib/_origin.mjs).
   `dir` is one of up | down | none. The form path is kept on purpose: the
   passport page works without script, and a vote control that silently did
   nothing would be the first element on this site that fails closed. Its two
   known costs are accepted: the redirect to /p/<id> bumps the view counter,
   and /gallery shows counts up to sixty seconds stale. A redirect target is
   built only from a uuid that passed UUID.test, never from a field value.

   IDENTITY IS A COOKIE, THE FIRST THIS APP SETS, which is why the privacy page
   and every footer changed in the same branch as this file:

     pv=<voter>.<sig>   voter = 32 hex of randomness, sig = HMAC-SHA256(voter,
                        VOTE_SECRET) truncated to 32 hex
                        HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=1 year

   It holds a random id and a signature and nothing about the person. A
   request with no cookie or a bad signature gets a fresh cookie and votes
   under the new id, so clearing the cookie lets a person vote again; the
   privacy page says so rather than pretending otherwise. The IP limiter caps
   the damage at 30 an hour per network, and its trace expires with its
   window like every other limiter key. HttpOnly means the page cannot know
   "yours" on a GET; it learns it from this response, which is fine.

   VOTE_SECRET is a Netlify environment variable, production context only,
   set in the Netlify UI and never in the repo. WITHOUT IT THIS FAILS CLOSED:
   every request is E_VOTE_FAILED and one console.error names the cause.
   `netlify dev` does not receive production-scoped variables, so the
   endpoint tests set VOTE_SECRET=test-only-... themselves and say so.

   ONE BODY FOR EVERY FAILURE. A passport that is not listed, an id that does
   not exist, a malformed direction and a store that would not take the write
   are all E_VOTE_FAILED 404, on the rule manage.mjs states: whether a uuid is
   listed is not for sale one guess at a time. */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { err } from '../../lib/_validate.mjs';
import { clientIp, rateLimit, castVote, UUID } from '../../lib/_store.mjs';
import { crossSite } from '../../lib/_origin.mjs';
import { archiveMode, archivedResponse } from '../../lib/_archive.mjs';

const COOKIE = 'pv';
const COOKIE_MAX_AGE = 365 * 24 * 3600;

const json = (status, obj, extra = {}) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra }
});

const redirect = (to, extra = {}) => new Response(null, {
  status: 303,
  headers: { location: to, 'cache-control': 'no-store', ...extra }
});

const sign = (voter, secret) =>
  createHmac('sha256', secret).update(voter, 'utf8').digest('hex').slice(0, 32);

/* The voter id from the cookie, or null for a missing or unsigned one. The
   signature is compared in constant time; a forged cookie is indistinguishable
   from a missing one and gets the same fresh id. */
export function voterFrom(cookieHeader, secret) {
  for (const part of String(cookieHeader || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== COOKIE) continue;
    const m = part.slice(eq + 1).trim().match(/^([0-9a-f]{32})\.([0-9a-f]{32})$/);
    if (!m) return null;
    const a = Buffer.from(sign(m[1], secret), 'hex');
    const b = Buffer.from(m[2], 'hex');
    return a.length === b.length && timingSafeEqual(a, b) ? m[1] : null;
  }
  return null;
}

export const cookieFor = (voter, secret) =>
  `${COOKIE}=${voter}.${sign(voter, secret)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`;

/* The two request shapes. Anything else is treated as the JSON shape with
   nothing in it, which is refused below like any other vote that cannot be
   recorded. */
async function readInput(req) {
  const ct = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (ct === 'application/x-www-form-urlencoded') {
    try {
      const p = new URLSearchParams(await req.text());
      return { form: true, id: p.get('id'), dir: p.get('dir'), back: p.get('back') };
    } catch {
      return { form: true, id: null, dir: null, back: null };
    }
  }
  try {
    const j = await req.json();
    return { form: false, id: j && j.id, dir: j && j.dir, back: null };
  } catch {
    return { form: false, id: null, dir: null, back: null };
  }
}

export default async (req, context) => {
  if (req.method !== 'POST') return json(405, { ok: false, ...err('E_METHOD') });

  /* A vote a page on another site sent is refused before the body, the secret
     or the limiter is touched, and in one shape for the form and the fetch
     alike: 403, not the form path's 303, because a redirect would take the
     visitor to a passport page and count a view for whoever forged the vote.
     lib/_origin.mjs has the rule, including why this page's own form arrives
     with `Origin: null` and is still let through. */
  if (crossSite(req)) return json(403, { ok: false, ...err('E_CROSS_SITE') });

  /* ROW-37: which store this request touches. See _store.mjs's "deploy
     scoping" section. */
  const deploy = context && context.deploy;

  const input = await readInput(req);
  const id = typeof input.id === 'string' && UUID.test(input.id) ? input.id : null;
  /* THE VALIDATED UUID, NEVER A FIELD VALUE. A form vote on an id that is not
     one has nowhere to go back to except the gallery. */
  const target = id && input.back !== 'gallery' ? `/p/${id}` : '/gallery';
  const failed = (status, code, extra) =>
    input.form ? redirect(target, extra) : json(status, { ok: false, ...err(code) }, extra);

  /* Archive mode: no vote, no cookie, no limiter key. The form path goes back
     to the page it came from, like every other refusal on that path; the page
     itself no longer draws the control (lib/_archive.mjs). */
  if (archiveMode()) return input.form ? redirect(target) : archivedResponse();

  /* The secret is checked BEFORE the limiter, so that a deploy without it
     writes nothing at all: not a vote, not a cookie, and not a limiter key
     either. The limiter writes its attempt key before it counts, so the other
     order let an unset variable burn thirty refusals an hour into the
     ratelimit store for an endpoint that was going to do nothing. */
  const secret = process.env.VOTE_SECRET || '';
  if (!secret) {
    console.error('vote refused: VOTE_SECRET is not set, so no voter cookie can be signed or checked');
    return failed(404, 'E_VOTE_FAILED');
  }

  const ip = clientIp(req);
  if (!(await rateLimit(deploy, ip, 'vote-h', 30, 3600e3))) return failed(429, 'E_VOTE_LIMIT');

  let voter = voterFrom(req.headers.get('cookie'), secret);
  const extra = {};
  if (!voter) {
    voter = randomBytes(16).toString('hex');
    extra['set-cookie'] = cookieFor(voter, secret);
  }

  const res = id ? await castVote(deploy, id, voter, input.dir) : null;
  if (!res) return failed(404, 'E_VOTE_FAILED', extra);
  return input.form ? redirect(target, extra) : json(200, { ok: true, ...res }, extra);
};

export const config = { path: '/api/vote' };

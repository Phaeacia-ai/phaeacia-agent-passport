/* GET /p/:id — the page a recipient sees.

   E_NOT_FOUND is returned for a uuid that never existed AND for one that was
   deleted or expired: same status, same body, same headers. A visitor must not
   be able to tell them apart, so do not "improve" this to say which it was. */

import { readPassport, bumpViews, readViews, readVotes } from '../../lib/_store.mjs';
import { renderPassport, renderNotFound } from '../../lib/_render.mjs';
import { listingOf } from '../../lib/_row.mjs';
import { MESSAGES } from '../../lib/_validate.mjs';
import { archiveMode, archivePage } from '../../lib/_archive.mjs';

/* The specimen is a fixture written by build.sh, through the real validator and
   the real derivation, and it is imported rather than fetched. It used to be
   fetched over HTTP from an origin derived from the request URL, which means
   from the Host header: a request-shaped outbound call, guarding a file that is
   sitting in the bundle. The platform edge validates Host, so it was not
   exploitable, but a server-side fetch whose destination comes from the caller
   is a shape worth not having. */
import EXAMPLE from '../../assets/example.json' with { type: 'json' };

/* THE POLICY BELOW IS SET HERE BECAUSE netlify.toml CANNOT REACH THIS RESPONSE.
   Its `[[headers]]` block applies to static files only; a function response
   carries exactly the headers the function sets and nothing else. So the
   "second layer" that netlify.toml's own comment describes was absent on the
   one route that renders Markdown a stranger uploaded, which is the route with
   the best claim to it. Checked against the live deploy before this change:
   `/p/example` came back with referrer-policy and x-content-type-options and no
   CSP at all, and the x-content-type-options was the platform injecting it
   rather than the toml reaching us. It is set explicitly below so that it stops
   depending on platform behaviour nobody here controls.

   THE POLICY IS netlify.toml's, COPIED VERBATIM, and the copy is deliberate.
   The toml is not importable from a function and a function response is not
   reachable from the toml, so one of the two has to be a copy. What keeps them
   honest is not this comment: `build.sh` parses both and fails the build when a
   header set in both places carries two different values.

   WHY THIS POLICY CANNOT BREAK A STRANGER'S PASSPORT, stated as a property of
   the renderer rather than as a count of what today's page happens to load.
   This paragraph used to say that `src` and `href` appear exclusively as
   hardcoded literals in `lib/_render.mjs`. That stopped being true the day
   the gallery landed: a card links to `/p/<uuid>`, and the vote control
   carries a hidden `<input value="<uuid>">`, on this page and on
   `lib/_gallery-render.mjs`. The property that actually holds, and that both
   renderers state at their top: AN ATTRIBUTE IS BUILT ONLY FROM A VALUE THAT
   PASSED `UUID.test` OR IS A MEMBER OF A FIXED SLUG LIST; NO STRING AN
   UPLOADER WROTE EVER REACHES AN ATTRIBUTE. The uuid is minted by this site
   and matched by regex before it is interpolated; the category slug is one
   of the entries in `lib/_categories.mjs`; the sort word is one of three
   literals; a page number is an integer the function formatted itself. The
   attributes built from anything else are still `class`, `content` and
   `style`, all server-controlled: a stamp class from a ternary, a bucket key
   from a module-level constant, and --tilt from a fixed six-element array
   indexed by row. So no uploaded content can reach a URL the browser fetches,
   and not because escaping holds: the code structurally never builds a
   resource URL from a stranger's string. A markdown link is emitted as its
   label plus the href as TEXT inside a span, never as an anchor. There is no
   <img> element anywhere in either renderer.

   AND WHY IT IS WORTH HAVING ANYWAY, given all that. The value of this policy is
   not that it blocks something the page loads today, because it blocks nothing.
   It is that if the window.__BODY script-escaping ever failed and a stranger did
   achieve injection, 'unsafe-inline' would let their script run but
   connect-src 'self', img-src 'self' and default-src 'self' would still refuse
   to carry anything to another origin. Exfiltration is what this buys. Judge any
   future widening of it against that sentence rather than against convenience.

   Each directive was then settled by rendering this page and reading what came
   out, not by reading the template:

     script-src 'unsafe-inline'  two inline scripts run here, the theme snippet
                                 that has to beat first paint and the
                                 window.__BODY handoff. A nonce cannot reach
                                 them and would not help anyway: injection is
                                 stopped by escaping on the way out.
     style-src  'unsafe-inline'  seven style="" attributes, including the
                                 per-row --tilt on the entry stamps.
     default-src 'self'          no third-party script, font, image, frame or
                                 fetch loads. The only off-origin URL either
                                 page emits is an <a href> to phaeacia.ai, and a
                                 navigation is not a fetch, so no directive here
                                 governs it.
     frame-ancestors 'none'      with X-Frame-Options repeating it for anything
                                 too old to read the directive.

   WHAT IS SETTLED HERE IS THE POLICY'S CONTENT, NOT ITS DELIVERY, and the
   difference is the whole of what is left to check. Everything above was
   established against the renderer and against fixtures, which is the right way
   to settle what the policy must permit: those are properties of the code and a
   deploy would not make them truer. What no fixture can settle is that these
   headers arrive on the wire in the form set here, that no platform layer
   strips, merges or duplicates the CSP, and that nothing between this function
   and the browser adds one of its own. That risk is not theoretical: the live
   response was already carrying an x-content-type-options that came from the
   platform rather than from any config in this repository, which is exactly the
   class of thing that only appears on the wire.

   So, on the first request to /p/example after this ships: read the response
   headers and confirm there is exactly ONE content-security-policy and that it
   matches the string below. Tracked rather than trusted to memory.

   renderNotFound SHARES THIS OBJECT AND HAS TO KEEP SHARING IT. A uuid that
   never existed and one that was deleted are the same 404 with the same body;
   if the two paths ever carried different headers, the headers would be the
   tell that the body is careful not to be. */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
].join('; ');

export const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'content-security-policy': CSP,
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff'
};

/* A LISTED passport is indexable (GALLERY-SPEC.md §0, Raffael's decision):
   the same object minus `x-robots-tag`, and nothing else moves. HEADERS
   itself is unchanged and stays what the 404 path and every unlisted row
   send, so a deleted, expired and never-existed uuid remain the same answer
   to the byte, and build.sh's parity check, which reads only `m.HEADERS`,
   still reads the same export. gallery.mjs derives its own headers from
   HEADERS the same way rather than importing this, so that the one
   difference it adds, a public cache-control, stays in that file. */
const { 'x-robots-tag': _noindex, ...INDEXABLE } = HEADERS;
export const LISTED_HEADERS = Object.freeze(INDEXABLE);

/* Archive mode (lib/_archive.mjs) marks every page this function serves,
   the not-found page included, so the three kinds of absence stay one answer. */
const marked = html => (archiveMode() ? archivePage(html) : html);

function notFound() {
  /* Markup only. The status, the headers and the message stay exactly where
     they were: a uuid that never existed and one that was deleted must stay
     indistinguishable. */
  return new Response(marked(renderNotFound(MESSAGES.E_NOT_FOUND)), { status: 404, headers: HEADERS });
}

export default async (req, context) => {
  const id = context.params && context.params.id;
  if (!id) return notFound();

  /* ROW-37: which store this request touches. See _store.mjs's "deploy
     scoping" section — `context.deploy` is the request's actual deploy
     context, threaded through rather than read from `process.env`, which
     never carries it at function runtime. */
  const deploy = context && context.deploy;

  /* NO ORIGIN IS PASSED, deliberately, and this is the same lesson as the
     specimen note above rather than a new one. `renderPassport` builds og:url,
     og:image and twitter:image from the origin it is handed. Handing it
     `new URL(req.url).origin` meant handing it the Host header, so a request
     with a foreign Host rendered a page whose card URLs named that host, and a
     deploy preview rendered cards pointing at the preview. It now defaults to
     CANONICAL, which is what a social card should say whatever host served the
     page. The comment above this file's imports already caught this shape once,
     for a server-side fetch, and left it standing here. */

  if (id === 'example') {
    return new Response(marked(renderPassport('example', EXAMPLE)), { status: 200, headers: HEADERS });
  }

  /* readPassport treats an expired row as absent; it is reported the same as a
     deleted one and one that never existed, all three the same 404 with the
     same body. It does NOT delete on the way out any more, and this comment
     said it did until ROW-88 — the actual removal is the sweeper's job, done
     separately and later, argued in lib/_store.mjs beside readPassport. */
  const row = await readPassport(deploy, id);
  if (!row) return notFound();

  /* The view count lives in its own store, so it has to be read back in rather
     than being a field on the row. It was not, for a while, and every passport
     page printed "first presentation" forever while /manage reported the real
     number. On a document whose rule is that every playful element is generated
     from the stored passport, that line was a constant pretending to be data. */
  const views = await readViews(deploy, id);
  /* The tally lives in its own store like the view count, and is attached
     here for a listed row only: an unlisted row has none (GALLERY-SPEC.md §2
     invariant 1) and the renderer prints no vote control for it, so reading
     the store for it would be a round trip that reads zero. */
  /* listingOf, not raw `row.gallery` truthiness (lib/_row.mjs) — the same
     predicate renderPassport uses internally to decide the body, so this
     gate and the headers line below cannot disagree with what the page
     actually prints. Truthiness alone treats {}, [], and a category with no
     date as listed. */
  const listing = listingOf(row);
  const votes = listing ? await readVotes(deploy, id) : undefined;
  const archived = archiveMode();
  const html = renderPassport(id, votes ? { ...row, views, votes } : { ...row, views }, undefined, { archived });

  /* One integer, in its own store. bumpViews() re-checks the row exists
     immediately before writing (ROW-140/ROW-88): the `readPassport` call above
     happens before the render, this call happens after it, and a delete
     landing in that gap is exactly what the check narrows. It narrows the
     race, it does not close it — see the comment on bumpViews itself for the
     honest limit and what it does not cover. (Not this file's line number: a
     line reference here would go stale the next time either function moves,
     which is the failure this whole comment exists to stop repeating.) */
  /* Archive mode counts no view: the page reads, and writes nothing. */
  if (!archived) await bumpViews(deploy, id);
  return new Response(archived ? archivePage(html) : html, { status: 200, headers: listing ? LISTED_HEADERS : HEADERS });
};

export const config = { path: '/p/:id' };

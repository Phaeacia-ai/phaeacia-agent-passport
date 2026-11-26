/* GET /og/:id.png — the per-passport social card, ROW-169 shape B.

   Draws a 1200x630 PNG from the stored row at request time and stores
   nothing: no blob, no cache beyond the response header below. Every input
   is already public on /p/<id> (the memo and the finding it produced are
   both explicit about this: the card is a picture of what the page already
   says, never more). Unknown, expired, deleted, or otherwise unrenderable
   ids all answer with the same generic card,
   web/assets/og/og-card.png, which since ROW-169's A′ carries a SPECIMEN
   strip rather than a real one -- see og-card.html's header. NOTHING ABOUT
   THE REQUESTED ROW LEAKS INTO THAT RESPONSE: same bytes, same headers,
   whatever the reason was. The reason is logged server-side only. Be exact
   about what that is and is not: /p/<id> logs nothing at all (a critic
   checked, zero console calls in passport.mjs or gallery.mjs), apart from
   one code-only PASSPORT_READ_FAILED line on a store error (lib/_ops.mjs,
   from readPassport, which this function calls too), so this
   function logs MORE than the page does, on purpose, because "why did this
   share get the generic card" is a question somebody will ask and the page
   never had to answer it. What reaches a log is the reason and the id; the
   id is already in the platform's request line for every route. No row
   CONTENT can reach a log: the only place a row value could enter a message
   is ogCard's TypeError on a bad strip, and mrzLines() pads every field to
   its width, so a critic's eighteen hostile rows (5,000-character names,
   emoji, bogus dates, ten thousand needs) all produced two 44-character
   lines and no throw.

   Four ways a request ends up on the generic card, and none of them is
   distinguishable from outside:
     - the id is not a UUID and not 'example' (readPassport refuses it, or
       there is no id at all)
     - readPassport finds no row: never existed, deleted, or expired --
       genuinely one 404 to a stranger, same as /p/<id>
     - canDraw(row) is false: the title or summary carries a codepoint
       neither the three site faces nor the Noto Sans fallback face has a
       glyph for. og-template.mjs's cardCanDraw covers the site faces alone
       and would route ě ř ł ğ ı to the generic card; _og-render.mjs's
       canDraw widens that by the fallback's cmap (Latin Extended-A/B and
       Additional, so Czech, Polish, Turkish, Vietnamese titles draw). What
       still falls here is a script outside those Latin ranges: Greek,
       Cyrillic, CJK. A PRODUCT LIMITATION, narrower than it was, not a bug.
     - ogCard() or renderCardPng() throws: a malformed strip, a font file
       missing, satori or resvg refusing the tree. This is the only branch
       that is actually unexpected, and it is the one most worth the log
       line naming what broke.

   WHY read the row at all if a badly-formed one falls back anyway. Because
   the fallback is the safety net, not the plan: canDraw and the strip
   shape check exist so a row this site itself considers well-formed still
   gets a real card, and the four branches above are ordered from "expected
   traffic" to "something to go look at". */

import { readPassport } from '../../lib/_store.mjs';
import { ogInputs } from '../../lib/_render.mjs';
import { ogCard } from '../../lib/og-template.mjs';
import { renderCardPng, canDraw, assetPath } from '../../lib/_og-render.mjs';
import { readFileSync } from 'node:fs';

/* The same fixture passport.mjs renders at /p/example. Imported rather than
   read through readPassport: there is no stored row named 'example', the
   same reason passport.mjs special-cases it before ever calling
   readPassport. See that file's own comment on why this is an import and
   not a runtime fetch: a request-shaped outbound call guarding a file
   already sitting in the bundle is a shape worth not having. */
import EXAMPLE from '../../assets/example.json' with { type: 'json' };

/* Read once per warm instance, like the fonts and the wasm module in
   _og-render.mjs: this is a file the repository ships, not a per-request
   value, and included_files (netlify.toml, [functions."og"]) is what makes
   it exist once deployed. assetPath() finds the root it landed under; see
   _og-render.mjs's header for why that is searched rather than assumed. If
   it cannot be found at all there is nothing to serve, and the throw from
   assetPath names every directory tried, which is the right failure: a
   missing generic card is a broken deploy, not a request to paper over. */
let genericPng = null;
function loadGeneric() {
  if (!genericPng) genericPng = readFileSync(assetPath('assets/og/og-card.png'));
  return genericPng;
}

/* no-store, the same as /p/<id>, and NOT the gallery's public max-age=60
   that the memo and the finding both suggested. A critic (2026-09-06) put
   the case: this picture carries the title, the owner's name in the strip
   and the first line of the summary, and /p/<id> is deliberately no-store
   so that a deleted passport is gone from every cache the moment it is gone
   from the store. A cacheable card would be a second surface, up to sixty
   seconds wide, that privacy.html's deletion section does not name (it
   names exactly one: an already-open gallery page), on a site whose own
   gallery.mjs records that whether the CDN honours cache-control on a
   function response is not established. What the cache would have bought is
   small: a platform's unfurler fetches the card about once per share and
   keeps its own copy after that. So the card is rendered on every request,
   about 45 ms warm, and there is no window to disclose. A crawler storm on
   this path is the same rate-limit question /p/<id> answers by setting
   nothing, which the memo notes and this does not re-litigate.

   nosniff and referrer-policy are carried like passport.mjs's HEADERS and
   gallery.mjs's; a PNG endpoint has no reason to drop them. */
const PNG_HEADERS = Object.freeze({
  'content-type': 'image/png',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
});

function genericResponse() {
  return new Response(loadGeneric(), { status: 200, headers: PNG_HEADERS });
}

export default async (req, context) => {
  const raw = context.params && context.params.id;
  /* The route pattern is /og/:id, so :id swallows the whole final path
     segment INCLUDING the .png suffix (there is no literal after :id for
     the matcher to split on) -- stripped here rather than trusted to a
     pattern, so this works the same whatever path-matching library Netlify
     Functions v2 is using underneath, checked or not. */
  const id = raw ? String(raw).replace(/\.png$/i, '') : '';
  if (!id) { console.log('og: no id'); return genericResponse(); }

  const deploy = context && context.deploy;

  let row;
  if (id === 'example') {
    row = EXAMPLE;
  } else {
    row = await readPassport(deploy, id);
  }
  if (!row) { console.log('og: no row for', id); return genericResponse(); }

  if (!canDraw(row)) {
    /* Frontend's finding asked for U+00AD, the soft hyphen, to be named in
       this line, because it is invisible in a title and the site faces lack
       it. Since the Noto fallback landed it is in the fallback cmap, canDraw
       accepts it, and harfbuzz shapes it to nothing, so no row reaches this
       branch for that reason any more (second critic, 2026-09-06). What does
       reach it: a script outside the Latin ranges, and the zero-width
       characters U+200B/C/D, U+2060 and U+FEFF, which no face maps and which
       would also draw as nothing; refusing those is over-strict and harmless. */
    console.log('og: canDraw false for', id, '(title or summary has a codepoint outside the Latin ranges the faces cover)');
    return genericResponse();
  }

  try {
    const { counts, strip } = ogInputs(row);
    const tree = ogCard({ row, counts, strip });
    const png = await renderCardPng(tree);
    return new Response(png, { status: 200, headers: PNG_HEADERS });
  } catch (e) {
    console.error('og: render failed for', id, e && e.message ? e.message : e);
    return genericResponse();
  }
};

export const config = { path: '/og/:id' };

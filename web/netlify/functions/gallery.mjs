/* GET /gallery — every passport whose owner chose to list it, as cards.

   GALLERY-SPEC.md §6. Served by this function from the gallery store, no
   static generation (Raffael's decision, §0). What it is not: no accounts, no
   comments, no moderation queue, no copy of any body anywhere
   new, no email, no third-party script. The app's CSP is byte-identical to
   passport.mjs's, and it is imported from there rather than copied so that
   build.sh's parity check, which reads only that module's HEADERS, keeps
   covering this page too.

   THE RENDERER PROPERTY, stated here and in lib/_gallery-render.mjs: an
   attribute is built only from a value that passed UUID.test or is a member
   of a fixed slug list; no string an uploader wrote ever reaches an attribute.
   This function is where the fixed lists are enforced: the category has to be
   in lib/_categories.mjs, the sort has to be one of three literals, the page
   has to be an integer this function formatted itself. Anything malformed
   falls back to the default rather than refusing; a listing page has no
   secret to protect.

   GET NEVER READS THE VOTE COOKIE. The response is cacheable for a minute
   (`cache-control: public, max-age=60`) and a page that carried one voter's
   state would hand it to everyone behind the cache. Whether the CDN honours
   cache-control on a function response is not established (spec §13); the
   header is set regardless, and the answer is one live request away. What a
   stale minute costs is visible on the page: vote counts up to sixty seconds
   old, and a card that was unlisted or deleted underneath it stays for at
   most that long. The views and copies on a card are older than that
   whatever the cache does: the hourly recount writes them into the card,
   and a render never reads either counter store (spec §6).

   READS: the unpaginated list() on the gallery store, then one card get and
   one metadata read per card, never a body (lib/_store.mjs listGallery). A
   card whose row is absent or unlisted is skipped and its key deleted on the
   way past; that is the repair for the states a failed write leaves. */

import { HEADERS } from './passport.mjs';
import { listGallery } from '../../lib/_store.mjs';
import { isCategory } from '../../lib/_categories.mjs';
import { searchText, matchesSearch } from '../../lib/_gallery-query.mjs';
import { renderGallery } from '../../lib/_gallery-render.mjs';
import { archiveMode, archivePage } from '../../lib/_archive.mjs';

/* passport.mjs's headers minus the one that says "do not index": a listed
   passport is indexable (§0) and so is the page that lists them. Plus a
   public cache-control in place of no-store, which is the only header this
   page sets that the passport page does not. */
const { 'x-robots-tag': _noindex, ...INDEXABLE } = HEADERS;
export const GALLERY_HEADERS = Object.freeze({ ...INDEXABLE, 'cache-control': 'public, max-age=60' });

export const PER_PAGE = 24;
const SORTS = new Set(['new', 'top', 'copied']);

const when = s => Date.parse(s) || 0;
const byNewest = (a, b) => when(b.listed_at) - when(a.listed_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const SORT = {
  new: byNewest,
  top: (a, b) => ((b.up || 0) - (b.down || 0)) - ((a.up || 0) - (a.down || 0)) || byNewest(a, b),
  copied: (a, b) => (b.copies || 0) - (a.copies || 0) || byNewest(a, b)
};

/* Query parsing, in one place, returning only values from the fixed sets. */
export function parseQuery(url) {
  const q = url.searchParams;
  const category = isCategory(q.get('category')) ? q.get('category') : null;
  const sort = SORTS.has(q.get('sort')) ? q.get('sort') : 'new';
  const n = Number(q.get('page'));
  const page = Number.isInteger(n) && n >= 1 ? n : 1;
  return { category, sort, page, search: searchText(q.get('q')) };
}

export default async (req, context) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' } });
  }

  /* ROW-37: which store this request reads. See _store.mjs's "deploy
     scoping" section. */
  const deploy = context && context.deploy;

  const { category, sort, search } = parseQuery(new URL(req.url));
  let { page } = parseQuery(new URL(req.url));

  const { cards } = await listGallery(deploy);
  const filtered = cards.filter(c => (!category || c.category === category) && (!search || matchesSearch(c, search)));
  filtered.sort(SORT[sort]);

  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  if (page > pages) page = pages;
  const slice = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  /* Archive mode (lib/_archive.mjs): the same cards, no vote controls, and the
     notice. Nothing else about the page or its caching changes. */
  const archived = archiveMode();
  const html = renderGallery({ cards: slice, category, sort, page, pages, total, search, archived });
  return new Response(archived ? archivePage(html) : html, { status: 200, headers: GALLERY_HEADERS });
};

export const config = { path: '/gallery' };

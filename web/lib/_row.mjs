/* Pure predicates about what a stored row's FIELDS mean, not about reading or
   writing one. Nothing here opens a store, nothing here is async, and nothing
   here may import anything that does either, ever, including `_store.mjs`
   itself. That constraint is not stylistic:

   `website/tools/build-samples.mjs` renders the sample passport phaeacia.ai
   serves by dynamically importing this repo's own `_render.mjs`, from a
   sibling repo whose `package.json` has no `@netlify/blobs` dependency at
   all. `_render.mjs` IS TO IMPORT FROM THIS FILE (frontend's edit, pending as
   of 2026-09-05 — `_render.mjs` still carries its own copy of `listingOf`
   below, byte-identical to this one for now, until that edit lands). If this
   file, or anything it imports, ever reached into `_store.mjs` (which imports
   `@netlify/blobs` at its top), that import would ride along into the
   website repo's build and
   `node tools/build-samples.mjs` would die on a missing module the moment
   anyone touched a passport's rendered page. Verified by HAL 2026-09-05
   before this file existed: `_categories.mjs`, the one thing this file itself
   imports, has zero imports of its own, which is what keeps this file
   importable with no Netlify runtime present. The next import added here
   inherits that promise silently; it has to be kept by hand, because nothing
   enforces it. If you need something from `_store.mjs`, this is the wrong
   file for what you are writing.

   `_store.mjs` imports both predicates below and re-exports `isExpired`, so
   nothing outside this move had to change. */

import { CATEGORIES } from './_categories.mjs';

/* True once a row's `expires_at` has passed. A row with no `expires_at`
   (a listed passport, or one written before metadata existed) is never
   expired by this test; `expires_at: null` means "does not expire," not
   "already has." Moved from `_store.mjs`, 2026-09-05, alongside `listingOf`:
   checked first that nothing outside `_store.mjs` imports it, on every
   branch with a copy of this file at the time (`main`, `frontend/gallery-live`,
   `codex/gallery-fixes`, `backend/gallery-store`) — none did, so the move
   costs zero call-site churn anywhere. */
export const isExpired = (row, now = Date.now()) => {
  if (!row || !row.expires_at) return false;
  const at = Date.parse(row.expires_at);
  return Number.isFinite(at) && now >= at;
};

/* THE ONE PREDICATE THE RENDERED PAGE AND ITS HEADERS SHARE, exported so that
   the body and the response headers cannot disagree with EACH OTHER.
   passport.mjs picks LISTED_HEADERS (indexable) or HEADERS (x-robots-tag
   noindex) on the same question, and the body prints a robots meta for the
   same reason; a page whose header says index while its body says noindex is
   the split the meta tag exists to prevent, read the other way round.
   Truthiness alone let {}, [], 'other' and a category with no date render
   listed. A listing is a plain object whose category is a real slug and
   whose listed_at begins with an ISO day, which is what createPassport and
   listPassport write; anything else is unlisted here, the safer wrong
   answer. Found by a critic.

   NOT the one predicate repo-wide: `_store.mjs` still answers "is this row
   listed" by raw `row.gallery` truthiness in several places of its own
   (`statusOf`'s `listed: Boolean(row.gallery)`, which /manage shows the
   owner; `deletePassport`; `renewPassport` and its guard) — a second critic
   pass on 2026-09-05 found this. For a malformed row today (none exist; see
   the write-path note below) that would mean /p/<id> says noindex while
   /manage still reports it listed with a vote tally: the same disagreement
   this predicate closes, one layer further out. Not closed by this change;
   named here so the next person doesn't assume it is.

   Moved from `_render.mjs` 2026-09-05 so `passport.mjs` can import the same
   function `renderPassport` already calls internally, rather than keep its
   own separate truth test on the same question next to it: an independent
   second predicate, even a hardened one guarded by a test asserting the two
   agree, is enforcement of agreement rather than a structural guarantee of
   it — a shared function cannot disagree with itself, a test can be wrong
   about whether two things do. Body unchanged from the version this
   superseded at `_render.mjs` (frontend, commit 126574a and unchanged through
   71d4e3a): read before writing this copy, to confirm there was no
   divergence to reconcile. There was none. */
export function listingOf(row) {
  const g = row && row.gallery;
  if (!g || typeof g !== 'object' || Array.isArray(g)) return null;
  if (!CATEGORIES.some(c => c.slug === g.category)) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(g.listed_at || ''))) return null;
  return g;
}

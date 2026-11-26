/* _store-listing.mjs

   A passport's gallery LISTING, as the primitives more than one module needs:
   the key shapes (`listingKey`, `sameListing`, `cardMatches`, `voteScope`,
   `scopeId`), `listedMeta` (listed or not, from blob metadata alone),
   `readGalleryCategory`, `cardOf` (the shape of a card) and `dropListing`.

   These are here and not in _store-gallery.mjs because three modules the
   gallery itself imports need them: _store-passport.mjs (readPassport reads the
   category override), _store-votes.mjs, and _store-expiry.mjs (purge calls
   `dropListing`). Left in the gallery module each of those would be an import
   cycle. The gallery's own operations (list, unlist, the listing page) are in
   _store-gallery.mjs, which carries the long explanation of how a listing works.

   Stores opened here: passports, gallery-categories, gallery, votes-count, votes.

   Exports that _store.mjs does not re-export are internal to the _store-*.mjs family. */

import { isCategory } from './_categories.mjs';
import { drop, strong, UUID } from './_store-core.mjs';

/* The gallery card for a listed row: the fields the listing page needs and
   nothing a body read would add. Never the body, never the token hash. The
   counters default to zero and are copied in by the caller that has them:
   listPassport reads views and copies, a fresh publish has none, the vote and
   the recount copy the tally. */
export function cardOf(id, row, counters = {}) {
  const needs = row.needs || [];
  return {
    id,
    title: row.title,
    summary: row.summary,
    category: row.gallery.category,
    listed_at: row.gallery.listed_at,
    generation: row.gallery.generation || null,
    created: row.created,
    name: row.name,
    installable: needs.filter(n => n.installable).length,
    declared_only: needs.filter(n => !n.installable).length,
    envelope: row.envelope,
    owner_confirmed: row.owner_confirmed === true,
    up: 0,
    down: 0,
    views: 0,
    copies: 0,
    ...counters
  };
}

/* Whether a passport is listed, from blob metadata alone, no body. Three
   answers, and callers must keep them apart the way this file does everywhere:
     { listed, hash, generation }                   the row exists
     { listed: false, hash: null, absent: true }    there is no row
     null                                           the read FAILED
   A vote treats null as "refuse"; the listing page treats null as "keep the
   card this render and delete nothing". A read that failed and a row that is
   absent are different answers, and the sweeper's own comment says what it
   cost the last time they were collapsed. */
export async function listedMeta(deploy, id) {
  if (!UUID.test(id)) return { listed: false, hash: null, absent: true };
  try {
    const got = await strong(deploy, 'passports').getMetadata(id);
    if (!got) return { listed: false, hash: null, absent: true };
    const m = got.metadata || {};
    return { listed: m.g === 1 || m.g === '1', hash: m.h || null, generation: m.gg || null };
  } catch {
    return null;
  }
}

/* The random generation changes only when an unlisted passport is listed.
   Legacy rows have no generation and keep their old keys until unlisted.
   Cleanup is best effort, but keys from different listings never overlap. */
export const listingKey = (id, generation) => generation ? `${id}:${generation}` : id;
export const sameListing = (meta, generation) => meta && meta.listed && meta.generation === generation;
export const cardMatches = (card, generation) => card && (card.generation || null) === generation;
export const voteScope = key => key.slice(0, key.lastIndexOf(':'));
export const scopeId = key => key.split(':')[0];

/* Category changes never rewrite the passport's lifecycle row. Otherwise
   a delayed category edit could restore a generation that was unlisted and
   make its old votes current again. A missing override uses the row's initial
   category; a failed read is unknown and must not be passed off as that value. */
export async function readGalleryCategory(deploy, id, generation, fallback) {
  const saved = await strong(deploy, 'gallery-categories').get(listingKey(id, generation), { type: 'json' });
  if (saved === null) return fallback;
  if (!saved || !isCategory(saved.category)) throw new Error('Invalid stored gallery category');
  return saved.category;
}

/* The two drop() calls that run on a REQUEST path, dropListing below and the
   repair in listGallery (_store-gallery.mjs), get this budget rather than the sweep's. A delete or
   an unlist of a passport with a few thousand votes would otherwise spend
   longer in sequential batches than a synchronous function is allowed to
   live (DROP_BATCH keys per round trip at the measured 310 ms). What the
   budget leaves behind is what the recount reclaims: orphan vote keys for a
   dropListing that stopped early, stale cards for a listGallery that did. */
const REQUEST_DROP_BUDGET_MS = 3000;
export const requestBudget = () => {
  const startedAt = Date.now();
  return () => Date.now() - startedAt < REQUEST_DROP_BUDGET_MS;
};

/* Reclaim only the captured listing's tally, category override and votes. Prefix enumeration
   can omit keys, fail, or outlive the listing. None of those cases can carry
   votes into a new generation. Legacy vote prefixes overlap new generations,
   so filter exact voteScope too. The shared card is cosmetic; a delayed card
   write is checked against current metadata on every gallery render. */
export async function dropListing(deploy, id, generation) {
  const scope = listingKey(id, generation);
  const stillHave = requestBudget();
  await Promise.all([
    strong(deploy, 'gallery').delete(id).catch(() => {}),
    strong(deploy, 'votes-count').delete(scope).catch(() => {}),
    strong(deploy, 'gallery-categories').delete(scope).catch(() => {}),
    (async () => {
      try {
        const { blobs } = await strong(deploy, 'votes').list({ prefix: scope + ':' });
        await drop(deploy, 'votes', blobs.map(b => b.key).filter(k => voteScope(k) === scope), stillHave);
      } catch { /* the recount sweeps what a failed listing leaves */ }
    })()
  ]);
}

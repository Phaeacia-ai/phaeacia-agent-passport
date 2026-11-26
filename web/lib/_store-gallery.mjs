/* _store-gallery.mjs

   Listing and unlisting a passport from /manage, and the listing page's read
   (`listPassport`, `unlistPassport`, `listGallery`). The primitives these
   share with the rest of the family are in _store-listing.mjs. The long
   explanation of how a listing works, below, was the banner above the gallery
   section of the original file.

   Stores opened here: passports, gallery-categories, gallery, expiry.

   Exports that _store.mjs does not re-export are internal to the _store-*.mjs family. */

/* ── the gallery ────────────────────────────────────────────
   GALLERY-SPEC.md §2. The gallery entry IS the passport row, flagged, and not
   a copy of it: two objects drift, and the reason a copy was ever proposed
   (the live row expires) went away when Raffael removed the expiry for listed
   passports. A listed row carries `gallery: { category, listed_at, generation }`,
   `expires_at: null`, blob metadata `{ h, x: 0, g: 1, gg: generation }`, NO expiry index
   entry, and one card in the `gallery` store. An unlisted row has every one
   of those the other way round. Listing and unlisting, below, are the only
   transitions, and tools/run-tests.mjs asserts the whole shape after each.

   WHY `x: 0` READS AS NEVER-EXPIRING, traced rather than assumed: readMeta
   does `Number(x) || 0`; authorise computes `expired` from `meta.expiresMs &&
   ...`, and 0 is falsy; isExpired returns false for a null expires_at, so
   readPassport serves the row; purge skips the expiry key for a row with no
   expires_at; sweep never reaches the row because no expiry key names it.
   The one reader that DID break was renewPassport, which would have written a
   fresh expiry key onto a listed row and handed it to the sweeper thirty days
   later; it now returns null for a listed row.

   A CARD IS WRITTEN ONLY WHILE THE ROW IS LISTED (invariant 6). The two card
   writes that can race an unlist, the vote's tally copy and the recount,
   re-read the row's metadata as the LAST read before the write and require
   the SAME listing generation. A late old card retains its old generation
   and listGallery skips it; recount rebuilds the current card. Blobs has no
   compare-and-swap, so one round trip always separates the re-read from the
   write. A late card for an unlisted row is dropped by listGallery; a card
   from an old generation is hidden until recount replaces it. The
   window is one round trip and not two or three, which is where it sat
   until the critic built the interleaving (2026-09-04). Without the guard,
   unlist-then-vote resurrects the card, which is the exact race the view
   counter's note in _store-counters.mjs documents, one store over. The two writes that cannot apply that guard, a
   fresh listed publish (no row yet) and listPassport (the row is unlisted
   until one write later), are ordered card first, row second, so the state a
   failure leaves is the one the listing page repairs. */

import { randomUUID } from 'node:crypto';
import { isCategory } from './_categories.mjs';
import { drop, DROP_BATCH, strong, UUID } from './_store-core.mjs';
import { readCopies, readViews } from './_store-counters.mjs';
import { expiryFrom, expiryKey, TTL_DAYS } from './_store-expiry.mjs';
import {
  cardMatches,
  cardOf,
  dropListing,
  listedMeta,
  listingKey,
  requestBudget,
  sameListing
} from './_store-listing.mjs';
import { authorise } from './_store-passport.mjs';
import { readVotes } from './_store-votes.mjs';

/* List a published passport from /manage (GALLERY-SPEC.md §4). Authorised
   with the delete token like renew. Returns { listed_at } or null for a
   wrong token, a missing row or a category that is not one.

   In this order, and the order is the design:
     1. the card
     2. the row, flagged, with `expires_at: null` and metadata { h, x: 0, g: 1, gg: generation };
        a whole-row rewrite from a read, the shape renewPassport already uses,
        safe for the same reason: the caller holds the token
     3. the old expiry key, swallowed: a stale key pointing at a live listed
        row is the recoverable direction, and the sweeper's re-read already
        drops a stale key whose row is not expired.
   Re-listing a passport that is already listed keeps its date and its votes
   and its generation. A category edit writes its generation-specific override
   and then the card; it NEVER rewrites the row. */
export async function listPassport(deploy, id, token, category) {
  if (!isCategory(category)) return null;
  if (!(await authorise(deploy, id, token))) return null;
  const store = strong(deploy, 'passports');
  const row = await store.get(id, { type: 'json' }).catch(() => null);
  if (!row) return null;

  const listed_at = row.gallery && row.gallery.listed_at ? row.gallery.listed_at : new Date().toISOString();
  const generation = row.gallery ? (row.gallery.generation || null) : randomUUID();
  const next = { ...row, expires_at: null, gallery: { category, listed_at, generation } };
  const counters = { views: await readViews(deploy, id), copies: await readCopies(deploy, id) };
  const wasMs = Date.parse(row.expires_at);

  if (row.gallery) {
    const votes = await readVotes(deploy, id);
    await strong(deploy, 'gallery-categories').setJSON(listingKey(id, generation), { category });
    const again = await listedMeta(deploy, id);
    if (!sameListing(again, generation)) return null;
    await strong(deploy, 'gallery').setJSON(id, cardOf(id, next, { ...counters, ...votes }));
    return { listed_at };
  }

  await strong(deploy, 'gallery').setJSON(id, cardOf(id, next, counters));
  await store.setJSON(id, next, { metadata: { h: row.delete_token_hash, x: 0, g: 1, ...(generation ? { gg: generation } : {}) } });
  if (Number.isFinite(wasMs)) {
    await strong(deploy, 'expiry').delete(expiryKey(wasMs, id)).catch(() => {});
  }
  return { listed_at };
}

/* Unlist from /manage, the reverse order of listPassport and the same rule
   as createPassport: the recoverable write first.
     1. the new expiry key for now + TTL_DAYS; if this throws nothing changed
     2. the row, unflagged, back on the thirty-day clock, metadata { h, x } and
        NO g
     3. the card, tally, category override and votes, cosmetic, each swallowed.
   If step 3 fails the card points at a live row that is no longer listed;
   the listing page skips and deletes a card whose row metadata has no g.
   Votes go with the listing and not with the passport (HAL, §4): a passport
   listed twice starts from zero, which is honest about what the votes were
   for. Unlisting a passport that is not listed changes nothing and returns
   its current expiry, so a repeated press is not an error. */
export async function unlistPassport(deploy, id, token) {
  if (!(await authorise(deploy, id, token))) return null;
  const row = await strong(deploy, 'passports').get(id, { type: 'json' }).catch(() => null);
  if (!row) return null;
  return unlistRow(deploy, id, row);
}

/* The unlist itself, once a caller is entitled to it: unlistPassport after
   the token, operatorUnlist (_store-takedown.mjs) after an operator chose to.
   Split out 2026-10-22 so the takedown path runs these exact writes in this
   exact order rather than a copy of them. `row` is the raw row the caller just
   read. Throws if step 1 or 2 does; step 3 swallows, as above. */
export async function unlistRow(deploy, id, row) {
  if (!row.gallery) return { expires_at: row.expires_at };
  const store = strong(deploy, 'passports');

  const expires_at = expiryFrom(Date.now(), TTL_DAYS);
  const expiresMs = Date.parse(expires_at);
  await strong(deploy, 'expiry').set(expiryKey(expiresMs, id), '1');
  const { gallery: _listing, ...rest } = row;
  await store.setJSON(id, { ...rest, gallery: null, expires_at },
    { metadata: { h: row.delete_token_hash, x: expiresMs } });
  await dropListing(deploy, id, row.gallery.generation || null);
  return { expires_at };
}

/* Every live card, for the gallery page. THE UNPAGINATED list(): it collects
   every page of the iterator (the note on SWEEP_PAGES in _store-core.mjs says what that
   costs), and that is the point. scan() is a bounded read of four pages that
   drops the rest; copied here it would silently truncate the gallery. Then one
   card get and one metadata read per card, in parallel batches, and never a
   body: `passports.get` is not called in this function, and the suite counts
   to make sure.

   A card whose row is ABSENT, or present and NOT listed (no g), is skipped and
   its key deleted: that is the repair for the two states a failed write can
   leave, a card written before a row that then failed to write, and a card a
   failed unlist step 3 left behind. A card whose row or whose own value could
   not be read is skipped this render and NOT deleted, because unknown is not
   gone. A key that is not a uuid is deleted: nothing here ever wrote one.

   What this costs past a few hundred cards is not established (spec §13);
   the comment on SWEEP_PAGES in _store-core.mjs is the reasoning to revisit then. */
export async function listGallery(deploy, { strict = false } = {}) {
  const g = strong(deploy, 'gallery');
  let blobs;
  try {
    ({ blobs } = await g.list());
  } catch {
    return { cards: [], listed: false, repaired: 0 };
  }
  const cards = [];
  const doomed = [];
  for (let i = 0; i < blobs.length; i += DROP_BATCH) {
    const batch = blobs.slice(i, i + DROP_BATCH);
    const results = await Promise.all(batch.map(async ({ key }) => {
      if (!UUID.test(key)) return { drop: key };
      const [card, meta] = await Promise.all([
        g.get(key, { type: 'json' }).then(c => (c === null ? { gone: true } : c), () => undefined),
        listedMeta(deploy, key)
      ]);
      if (card === undefined || meta === null) return { keep: true, unavailable: true };
      if (card.gone) return { keep: true };
      if (meta.absent || !meta.listed) return { drop: key };
      // A delayed write from an earlier listing must never display its counts.
      if (!cardMatches(card, meta.generation)) return { keep: true };
      return { card: { ...card, id: key } };
    }));
    // The JSON consumer must distinguish a partial read from an empty listing.
    // HTML keeps its existing best-effort behavior; neither mode deletes unknown rows.
    if (strict && results.some(r => r.unavailable)) return { cards: [], listed: false, repaired: 0 };
    for (const r of results) {
      if (r.card) cards.push(r.card);
      else if (r.drop) doomed.push(r.drop);
    }
  }
  const repaired = doomed.length ? await drop(deploy, 'gallery', doomed, requestBudget()) : 0;
  return { cards, listed: true, repaired };
}

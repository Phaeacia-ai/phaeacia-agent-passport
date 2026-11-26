/* _store-takedown.mjs

   The operator's removal path: unlist or delete a passport by id WITHOUT its
   delete token (`operatorUnlist`, `operatorDelete`), for an abuse report, an
   erasure request from somebody who is not the owner (privacy.html promises
   erasure), or an owner who lost the token. Until 2026-10-22 the only such path
   was "a store operation Raffael runs by hand" (GALLERY-SPEC.md §12), and a
   hand-run key delete is how a passport loses its row and keeps its card, its
   votes or its expiry entry.

   NOTHING NEW IS DECIDED HERE. Each operation is the owner's own minus
   `authorise`: delete is purge() (_store-expiry.mjs), exactly what
   deletePassport runs once the token checks out, and unlist is unlistRow
   (_store-gallery.mjs), exactly what unlistPassport runs. The write order, the
   swallowed cosmetic deletes and the listing cleanup are the owner path's, so a
   fix to one is a fix to both.

   DRY RUN UNLESS `apply` IS TRUE, here and not only in the tool, so a caller
   that forgets the flag gets a report and not a delete. Everything before that
   check is a read.
   `footprint` below reports what the passport has in each store: before the
   write it is what would go, after it what is left, and the second reading is
   what lets an erasure reply say "deleted" truthfully or name what the sweep
   and the recount will still reclaim.

   Called by tools/takedown.mjs only, through tools/_takedown-cli.mjs. No
   endpoint may import these: a request that reached one would be a delete
   without a token.

   Stores opened here: passports, expiry, gallery, votes-count, gallery-categories, votes, views, copies, fingerprints, hold-pointers.

   Exports that _store.mjs does not re-export are internal to the _store-*.mjs family. */

import { isExpired } from './_row.mjs';
import { strong, UUID } from './_store-core.mjs';
import { purge } from './_store-expiry.mjs';
import { unlistRow } from './_store-gallery.mjs';
import { fpKey } from './_store-ratelimit.mjs';

/* Which stores hold something under this passport's id, and how many keys.
   `row` is the row read BEFORE any write: once it is gone the expiry key, the
   fingerprint and the hold pointer can only be named from it.

   Wider than purge() on purpose. The three listing stores are read by the id's
   whole prefix, every listing generation, not only the current one that
   dropListing deletes, and the expiry index is listed whole for any key ending
   in this id, not only the one the row's date names. An erasure reply has to
   know about an old generation's orphaned votes or a renew's stale index key
   too, even though the recount and the sweep reclaim them on their own.

   A store that could not be read is reported as unknown, never as empty. */
async function footprint(deploy, id, row) {
  const present = {};
  const unknown = [];
  const has = async (name, key) => {
    try {
      if (await strong(deploy, name).getMetadata(key)) present[name] = (present[name] || 0) + 1;
    } catch { unknown.push(name); }
  };
  const listed = async (name, prefix, match) => {
    try {
      const { blobs } = await strong(deploy, name).list(prefix ? { prefix } : {});
      const n = blobs.filter(b => match(b.key)).length;
      if (n) present[name] = n;
    } catch { unknown.push(name); }
  };
  const ownKey = k => k === id || k.startsWith(id + ':');
  const jobs = [
    has('passports', id), has('gallery', id), has('views', id), has('copies', id),
    listed('votes', id, ownKey), listed('votes-count', id, ownKey), listed('gallery-categories', id, ownKey),
    listed('expiry', '', k => k.endsWith(':' + id))
  ];
  if (row && row.fingerprint && row.fingerprint_bucket !== undefined) {
    jobs.push(has('fingerprints', fpKey(row.fingerprint, row.fingerprint_bucket)));
  }
  if (row && row.hold && typeof row.hold.id === 'string') jobs.push(has('hold-pointers', row.hold.id));
  await Promise.all(jobs);
  return { present, unknown };
}

/* What the operator needs to confirm it is the right passport, and nothing
   more: never the body, never the token hash. */
const summarise = row => ({
  title: row.title,
  name: row.name,
  created_at: row.created_at,
  expires_at: row.expires_at,
  expired: isExpired(row),
  listed: Boolean(row.gallery),
  category: row.gallery ? row.gallery.category : null,
  listed_at: row.gallery ? row.gallery.listed_at : null,
  held: Boolean(row.hold)
});

/* The read both operations start from. A read that FAILED is not a passport
   that is absent, for the reason given on sweep(): the first is "try again",
   the second is "nothing to do". */
async function readForTakedown(deploy, id) {
  if (!UUID.test(String(id || ''))) return { ok: false, reason: 'not_a_uuid' };
  let row;
  try {
    row = await strong(deploy, 'passports').get(id, { type: 'json' });
  } catch {
    return { ok: false, reason: 'read_failed' };
  }
  const before = await footprint(deploy, id, row);
  /* No row means there is nothing this module may delete. What is left under
     the id is reported, not removed: a card or votes without a row are the
     orphans listGallery and the recount already reclaim, and deleting them here
     would be the raw key delete this module exists to replace. */
  if (!row) return { ok: false, reason: 'not_found', before };
  return { ok: true, row, before };
}

/* Unlist, as the owner's Unlist button would: off the gallery, its votes,
   tally and category override gone, and the link back on a fresh thirty-day
   clock (privacy.html §04). For a passport that must not stay up at all, use
   operatorDelete. An unlisted passport is left as it is. */
export async function operatorUnlist(deploy, id, { apply = false } = {}) {
  const got = await readForTakedown(deploy, id);
  if (!got.ok) return got;
  const { row, before } = got;
  const out = { ok: true, applied: false, row: summarise(row), before };
  if (!row.gallery) return { ...out, unchanged: true };
  if (!apply) return out;
  let expires_at;
  try {
    ({ expires_at } = await unlistRow(deploy, id, row));
  } catch {
    return { ...out, ok: false, reason: 'write_failed', after: await footprint(deploy, id, row) };
  }
  return { ...out, applied: true, expires_at, after: await footprint(deploy, id, row) };
}

/* Delete, as a successful owner delete would: purge() with the row just read,
   so the row, both counters, the index key, the fingerprint, the listing and
   the hold pointer go in purge's order. `ok` is purge's: true only when the
   row itself went. */
export async function operatorDelete(deploy, id, { apply = false } = {}) {
  const got = await readForTakedown(deploy, id);
  if (!got.ok) return got;
  const { row, before } = got;
  const out = { ok: true, applied: false, row: summarise(row), before };
  if (!apply) return out;
  const { ok } = await purge(deploy, id, row);
  return { ...out, ok, applied: true, ...(ok ? {} : { reason: 'write_failed' }), after: await footprint(deploy, id, row) };
}

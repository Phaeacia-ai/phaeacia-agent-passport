/* _store-passport.mjs

   The passport row and its owner: `createPassport`, `readMeta`,
   `readPassport`, the delete-token primitives (`mintDeleteToken`,
   `hashMatches`, `tokenMatches`, `authorise`) and the three token-gated owner
   actions, `deletePassport`, `statusOf` and `renewPassport`.

   Stores opened here: gallery, passports, expiry.

   Exports that _store.mjs does not re-export are internal to the _store-*.mjs family. */

/* Moved verbatim from the original _store.mjs header.

   DOCUMENTED DEVIATION from site/spec/schema.sql and upload-validation.md §9.1.
   That spec puts the delete token inside public.create_passport so it is minted
   in exactly one place, in the database. There is no database here: a passport
   is 7 KB of Markdown with no relations, no accounts and no queries beyond "get
   by id", so Postgres would be paid infrastructure for a key-value problem.
   The token is therefore minted here, and here only. Every property the spec
   actually depends on is preserved:
     - 20 bytes of cryptographic randomness, 160 bits, 40 lowercase hex
     - only the sha256 hash is stored, never the plaintext
     - the plaintext is returned once, in the upload response, and never logged
   If this ever moves to Postgres, move the minting with it and delete this note.
*/

/* ── passports ──────────────────────────────────────────────
   The token hash and the expiry live in the blob's METADATA as well as in the
   row. Netlify Blobs serves metadata without the body, so checking a token
   costs a small fixed read instead of fetching and parsing ten kilobytes of
   Markdown. That is not an optimisation: it is what makes "a wrong token, a
   deleted passport and a uuid that never existed are the same answer" true of
   the clock as well as of the status code. With the body in the path, a wrong
   token against a live passport took about 12ms longer than a miss, which is
   enough to confirm that a link somebody glimpsed is still live without opening
   it and showing up in the owner's view count. */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isCategory } from './_categories.mjs';
import { opsLog } from './_ops.mjs';
import { isExpired } from './_row.mjs';
import { HOUR_MS, sha256, strong, UUID } from './_store-core.mjs';
import { readCopies, readViews } from './_store-counters.mjs';
import { expiryFrom, expiryKey, purge, RENEW_DAYS, TTL_DAYS } from './_store-expiry.mjs';
import { cardOf, readGalleryCategory } from './_store-listing.mjs';
import { readVotes } from './_store-votes.mjs';

const ZERO_HASH = '0'.repeat(64);

export function mintDeleteToken() {
  const token = randomBytes(20).toString('hex');
  return { token, hash: sha256(token) };
}

/* `hold` is set only by releaseHold: `{ id, x }`, the hold's id and the time its pointer expires. It is
   written onto the passport row so that deleting or expiring the passport can delete the pointer
   (hold-pointers/<hold id>, which /api/check-hold reads) with it. Before this a passport its owner
   deleted stayed reported as "released", with its id, for up to 30 days (PH-518 final critic F1). */
export async function createPassport(deploy, record, body, { gallery = null, hold = null } = {}) {
  const id = randomUUID();
  const { token, hash } = mintDeleteToken();
  const now = Date.now();
  /* Read ONCE and returned below, so the caller's claim and purge()'s delete
     name the same key. See claimFingerprint. */
  const fingerprint_bucket = Math.floor(now / HOUR_MS);
  const fingerprint = sha256(body);
  const created_at = new Date(now).toISOString();

  if (gallery) {
    /* LISTED FROM THE START (GALLERY-SPEC.md §3). The row is born flagged,
       with `expires_at: null`, metadata `{ h, x: 0, g: 1, gg: generation }` and NO expiry
       index entry, and its card is written before it.

       CARD FIRST, ROW SECOND, the same rule as index-first below and for the
       same reason. A card without a row is repaired by the listing page,
       which skips and deletes a card whose row is absent. A listed row
       without a card is a passport the owner was told is in the gallery and
       is not, and nothing on a request path would ever notice; the recount
       rebuilds one when it finds votes for such a row, but a row nobody votes
       on stays invisible. Write the recoverable thing first.

       The category is checked here as well as in upload.mjs: a slug reaches
       an attribute on the gallery page, and the renderer's rule is that only
       a value that passed the membership test ever does. A caller that gets
       here with a bad one has a bug, so this throws rather than publishing
       unlisted and telling nobody. Checked before any store is opened. */
    if (!isCategory(gallery.category)) {
      throw new TypeError('createPassport: gallery.category is not one of the categories');
    }
    const row = {
      ...record,
      body,
      delete_token_hash: hash,
      created_at,
      expires_at: null,
      renewed: 0,
      fingerprint_bucket,
      fingerprint,
      ...(hold ? { hold: { id: hold.id, x: hold.x } } : {}),
      gallery: { category: gallery.category, listed_at: created_at, generation: randomUUID() }
    };
    await strong(deploy, 'gallery').setJSON(id, cardOf(id, row));
    await strong(deploy, 'passports').setJSON(id, row, { metadata: { h: hash, x: 0, g: 1, gg: row.gallery.generation } });
    return { id, token, expires_at: null, fingerprint_bucket, listed: true };
  }

  const expires_at = expiryFrom(now, TTL_DAYS);
  const expiresMs = Date.parse(expires_at);

  /* INDEX FIRST, ROW SECOND, and the order is the invariant rather than a style.

     This used to write the row and then `.set` the index key with
     `.catch(() => {})`. A transient failure on that write was swallowed and the
     function still returned success: **the passport was born with no index
     entry**, and sweep() enumerates dead passports only through that index, so
     it could never be deleted. Retained past the thirty days privacy.html
     promises, permanently, while the publisher was told it worked. Measured: row
     present, index entries 0, survives sweeps thirty years in the future.

     Reversed, the two failure modes are no longer symmetric:
       index ok, row fails  -> an index key pointing at nothing. HARMLESS; the
                               sweeper reaches it, finds no row, and drops it.
       index fails          -> nothing has been written at all, and this throws
                               rather than reporting a publish that will never
                               be deletable.

     That is the same rule purge() enforces from the other side: an index entry
     without a row is recoverable, a row without an index entry is not. Write
     the recoverable thing first and let the unrecoverable one be impossible. */
  await strong(deploy, 'expiry').set(expiryKey(expiresMs, id), '1');

  await strong(deploy, 'passports').setJSON(id, {
    ...record,
    body,
    delete_token_hash: hash,
    created_at,
    expires_at,
    renewed: 0,
    fingerprint_bucket,
    fingerprint,
    ...(hold ? { hold: { id: hold.id, x: hold.x } } : {})
  }, { metadata: { h: hash, x: expiresMs } });

  return { id, token, expires_at, fingerprint_bucket, listed: false };
}

/* The small read: token hash and expiry, without the body.

   The fallback matters. A row written before metadata existed has none, and
   silently treating it as absent would delete nothing and serve nothing while
   looking like a missing passport. So it falls back to the row. That path costs
   the body read this function exists to avoid, and therefore has the timing
   difference this function exists to remove; it applies only to rows written by
   an older deploy and disappears the first time each is renewed. */
async function readMeta(deploy, id) {
  if (!UUID.test(id)) return null;
  try {
    const got = await strong(deploy, 'passports').getMetadata(id);
    if (got && got.metadata && got.metadata.h) {
      return { hash: got.metadata.h, expiresMs: Number(got.metadata.x) || 0 };
    }
    if (got) {
      const row = await strong(deploy, 'passports').get(id, { type: 'json' });
      if (!row) return null;
      return { hash: row.delete_token_hash, expiresMs: Date.parse(row.expires_at) || 0 };
    }
    return null;
  } catch {
    /* Answered as a wrong token by every owner action, so log it; see
       readPassport below. */
    opsLog('PASSPORT_READ_FAILED', { stage: 'meta' });
    return null;
  }
}

/* An expired passport is reported as absent. It is NOT deleted on the way out
   any more, and this comment said it was until ROW-88: the function body below
   is `if (isExpired(row)) return null`, no delete, and the reasoning for why is
   nine lines further down in this same function. A visitor must not be able to
   tell an expired link from a deleted one from one that never existed, so this
   returns exactly what a missing id returns; the sweeper does the actual
   removal, separately and later. */
export async function readPassport(deploy, id) {
  if (!UUID.test(id) && id !== 'example') return null;
  let row;
  try {
    row = await strong(deploy, 'passports').get(id, { type: 'json' });
  } catch {
    /* A store error is still answered as absent: the visitor sees the page a
       missing id gets. But in an outage that is every passport at once, and
       the log used to say nothing, so this says so (audit, 2026-10-22). The
       code and the step, never the id. */
    opsLog('PASSPORT_READ_FAILED', { stage: 'row' });
    return null;
  }
  if (!row) return null;
  /* Same reasoning as authorise(): expired reads as absent and the sweeper does
     the deleting. Purging here made the first request after an expiry cost five
     store operations against one for a uuid that never existed, on a page that
     needs no credential at all. */
  if (isExpired(row)) return null;
  if (row.gallery) {
    try {
      const category = await readGalleryCategory(deploy, id, row.gallery.generation || null, row.gallery.category);
      // A read-only presentation overlay. Lifecycle writers read the raw row
      // directly; never persist this projected category back to passports.
      return { ...row, gallery: { ...row.gallery, category } };
    } catch {
      opsLog('PASSPORT_READ_FAILED', { stage: 'category' });
      return null;
    }
  }
  return row;
}

/* Constant-time comparison of a presented token against a stored hash.
   A wrong token, a malformed token and a missing hash are the same answer, and
   every caller renders all three identically. */
export function hashMatches(hash, token) {
  if (!/^[0-9a-f]{40}$/.test(token || '')) return false;
  if (!/^[0-9a-f]{64}$/.test(hash || '')) return false;
  const a = Buffer.from(sha256(token), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export const tokenMatches = (row, token) => hashMatches(row && row.delete_token_hash, token);

/* Check a token without reading a body. Returns the metadata on success and
   null for every failure, including an expired passport, which it purges. */
export async function authorise(deploy, id, token) {
  const meta = await readMeta(deploy, id);

  /* ONE EXIT, DELIBERATELY, and this shape is the control rather than a style.

     A missing passport, an expired one and a wrong token all reach the same
     comparison against a hash that cannot match, so all three cost the same
     sha256 and the same constant-time compare. Written as a single return
     because the previous version did it with a throwaway `hashMatches(zeroes,
     token)` statement above an early return, and a statement whose result is
     discarded reads as dead code to everyone who meets it, including a linter.
     A mutation test confirmed nothing in either suite noticed when it was
     deleted. Nothing outside this function can observe a constant-time
     compare, so the structure has to hold it up.

     Expiry returns absent and does NOTHING ELSE. It used to purge on the way
     out, which reads as tidy and was an oracle: an expired id cost a body read
     and four deletes where an id that never existed cost one lookup, and the
     token was irrelevant to either, so anybody holding a harvested link could
     confirm afterwards that the uuid had been real. Reclaiming that storage is
     the sweeper's job and the sweeper has no stranger waiting on it. */
  const expired = Boolean(meta && meta.expiresMs && Date.now() >= meta.expiresMs);
  const hash = (meta && !expired) ? meta.hash : ZERO_HASH;
  return hashMatches(hash, token) ? meta : null;
}

/* Returns true only when exactly one passport was deleted. A wrong token, a
   malformed token and a uuid that does not exist all return false, and the
   endpoint renders all three as the same E_DELETE_FAILED. */
export async function deletePassport(deploy, id, token) {
  if (!(await authorise(deploy, id, token))) return false;
  const row = await strong(deploy, 'passports').get(id, { type: 'json' }).catch(() => null);

  /* Was `await purge(...); return true;`, which told a visitor their passport
     was deleted whether or not the row went. There is no honest sentence to
     print over a function that reports a success it did not have, so the signal
     is fixed here rather than the wording downstream. A transient failure now
     renders E_DELETE_FAILED and the visitor retries, which is the outcome they
     would want. Deleting an id that is already gone still succeeds, so a repeat
     delete is unaffected. */
  const { ok } = await purge(deploy, id, row);
  return ok;
}

/* The status behind the delete token: what is published, how many people
   opened it, and when it goes away. Returns null for every failure, so a wrong
   token cannot be told apart from an id that is not there. */
export async function statusOf(deploy, id, token) {
  if (!(await authorise(deploy, id, token))) return null;
  const row = await strong(deploy, 'passports').get(id, { type: 'json' }).catch(() => null);
  if (!row) return null;
  const category = row.gallery
    ? await readGalleryCategory(deploy, id, row.gallery.generation || null, row.gallery.category).catch(() => null)
    : null;
  if (row.gallery && category === null) return null;
  return {
    id,
    title: row.title,
    name: row.name,
    created_at: row.created_at,
    expires_at: row.expires_at,
    renewed: row.renewed || 0,
    owner_confirmed: row.owner_confirmed === true,
    views: await readViews(deploy, id),
    copies: await readCopies(deploy, id),
    /* The listing, for /manage: whether, in which category, since when, and
       how the votes stand. The tally is read only for a listed row, because
       an unlisted one has none (invariant 1) and opening the store for it
       would be a round trip that reads zero. */
    listed: Boolean(row.gallery),
    category,
    listed_at: row.gallery ? row.gallery.listed_at : null,
    votes: row.gallery ? await readVotes(deploy, id) : { up: 0, down: 0 }
  };
}

/* Renewal moves the expiry to RENEW_DAYS from now. It rewrites the row, which
   is safe in a way bumpViews was not: the caller proved it holds the delete
   token, and the row it writes is the row it just read plus two fields. */
export async function renewPassport(deploy, id, token) {
  if (!(await authorise(deploy, id, token))) return null;
  const store = strong(deploy, 'passports');
  const row = await store.get(id, { type: 'json' }).catch(() => null);
  if (!row) return null;

  /* A LISTED ROW IS NOT RENEWED (GALLERY-SPEC.md §2 invariant 2, §4). It has
     no expiry to move, and this function was the one reader that broke on a
     listed row: with no check it would have written a fresh expiry key onto
     it, the sweeper would have purged the row thirty days later, and the card
     would have pointed at nothing. The manage endpoint reads statusOf first
     and never calls this for a listed row; this is the guard for every other
     caller, and the test that pins it asserts the row, its metadata and the
     index are byte-identical afterwards. */
  if (row.gallery) return null;

  const expires_at = expiryFrom(Date.now(), RENEW_DAYS);
  const expiresMs = Date.parse(expires_at);
  const wasMs = Date.parse(row.expires_at);

  /* Same reversal, same reason, and this one was worse. The new index key was
     written with `.catch(() => {})` and the OLD key was then deleted regardless,
     so a swallowed failure took the passport's only index entry with it while
     renewPassport returned a cheerful new expiry date. Measured: index entries
     1 -> 0, row live with a valid thirty-day expiry, unreachable by ten sweeps.

     Now: new key first, and if it fails nothing else happens and the caller is
     told. The row keeps its old expiry, the old index key still points at it,
     and the owner can simply renew again. */
  await strong(deploy, 'expiry').set(expiryKey(expiresMs, id), '1');

  await store.setJSON(id, {
    ...row,
    expires_at,
    renewed: (row.renewed || 0) + 1
  }, { metadata: { h: row.delete_token_hash, x: expiresMs } });

  /* Only after both writes landed. A failure here leaves a stale past-dated key
     beside the current one, which is the recoverable direction: the sweeper's
     re-read finds the row not expired and drops the stale key. */
  if (Number.isFinite(wasMs) && wasMs !== expiresMs) {
    await strong(deploy, 'expiry').delete(expiryKey(wasMs, id)).catch(() => {});
  }
  return expires_at;
}

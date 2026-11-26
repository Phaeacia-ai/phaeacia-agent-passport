/* _store-votes.mjs

   Votes on a listed passport, per listing generation: `readVotes` (the tally),
   `castVote`, and `recount`, the daily rebuild of tallies and gallery cards.

   Stores opened here: votes-count, votes, gallery, passports, gallery-categories.

   Exports that _store.mjs does not re-export are internal to the _store-*.mjs family. */

import { drop, DROP_BATCH, strong, UUID } from './_store-core.mjs';
import { readCopies, readViews } from './_store-counters.mjs';
import { SWEEP_BUDGET_MS } from './_store-expiry.mjs';
import {
  cardMatches,
  cardOf,
  listedMeta,
  listingKey,
  readGalleryCategory,
  sameListing,
  scopeId,
  voteScope
} from './_store-listing.mjs';

export async function readVotes(deploy, id) {
  try {
    const meta = await listedMeta(deploy, id);
    if (!meta || !meta.listed) return { up: 0, down: 0 };
    const cur = await strong(deploy, 'votes-count').get(listingKey(id, meta.generation), { type: 'json' });
    const again = await listedMeta(deploy, id);
    if (!sameListing(again, meta.generation)) return { up: 0, down: 0 };
    return { up: (cur && Number(cur.up)) || 0, down: (cur && Number(cur.down)) || 0 };
  } catch {
    return { up: 0, down: 0 };
  }
}

const VOTER = /^[0-9a-f]{32}$/;
const VOTE_VALUE = Object.freeze({ up: 1, down: -1, none: 0 });

/* One vote per (passport, listing generation, voter), as one key whose value is the direction.
   Returns { up, down, yours } or null for every reason a vote cannot be
   recorded: a malformed id or voter, a direction that is not up, down or none,
   a passport that is not listed, or a store that would not take the write.
   The endpoint renders every null as the same E_VOTE_FAILED. */
export async function castVote(deploy, id, voter, dir) {
  if (!UUID.test(String(id || '')) || !VOTER.test(String(voter || ''))) return null;
  if (!Object.hasOwn(VOTE_VALUE, dir)) return null;
  const value = VOTE_VALUE[dir];

  /* Only a listed passport takes a vote, and a read that failed refuses too.
     Checked before any vote store is opened, so a refused vote costs one
     metadata read and leaves no trace. */
  const meta = await listedMeta(deploy, id);
  if (!meta || !meta.listed) return null;

  const scope = listingKey(id, meta.generation);
  const key = `${scope}:${voter}`;
  const votes = strong(deploy, 'votes');
  let prev = 0;
  try {
    const cur = await votes.get(key);
    prev = cur === '1' ? 1 : cur === '-1' ? -1 : 0;
    if (value === 0) await votes.delete(key);
    else await votes.set(key, String(value));
  } catch {
    return null;
  }

  /* The tally: take away what this voter had, add what they have now. A
     read-modify-write, so two votes inside one another's round trip can lose
     one; clamped at zero so a lost update can never print a negative number,
     and repaired by the daily recount, which rebuilds it from `votes`. */
  const counts = strong(deploy, 'votes-count');
  let tally;
  try {
    const cur = (await counts.get(scope, { type: 'json' })) || {};
    tally = {
      up:   Math.max(0, (Number(cur.up) || 0)   - (prev === 1 ? 1 : 0)  + (value === 1 ? 1 : 0)),
      down: Math.max(0, (Number(cur.down) || 0) - (prev === -1 ? 1 : 0) + (value === -1 ? 1 : 0)),
      at: new Date().toISOString()
    };
    await counts.setJSON(scope, tally);
  } catch {
    return null;
  }

  /* Copy into the card, ONLY IF STILL LISTED (invariant 6). The listing is
     re-read as THE LAST READ BEFORE THE WRITE, after the card read, so that
     the window an unlist or a delete can land in is one round trip and not
     two. It was two, with the re-read before the card read, and the critic
     built the interleaving that slips through: an unlist landing between the
     card read and the card write wrote the card back, against the branch's
     own test, which had put the unlist one round trip too early. A window of
     one round trip remains, because Blobs has no compare-and-swap: a card
     that lands in it is skipped by listGallery if its generation no longer
     matches, and the recount repairs it.

     A vote whose re-read finds the row UNLISTED, GONE OR RELISTED undoes itself: the
     unlist or purge that overtook it deletes the votes and the tally, and
     this vote's key and tally rewrite may have landed after that delete.
     Both deletes name only the generation this vote started in.
     Deleting its own key and the tally here turns "one orphan votes key and
     one orphan tally" into nothing in every ordering but one, the delete
     landing between this re-read and these two deletes, which the recount
     reclaims. A re-read that FAILED is unknown, not gone: the vote stands,
     the card is skipped, and the recount copies the tally in daily. */
  const g = strong(deploy, 'gallery');
  let card = null;
  try { card = await g.get(id, { type: 'json' }); } catch { card = null; }
  const again = await listedMeta(deploy, id);
  if (again && !sameListing(again, meta.generation)) {
    await Promise.all([votes.delete(key).catch(() => {}), counts.delete(scope).catch(() => {})]);
    return null;
  }
  if (sameListing(again, meta.generation) && cardMatches(card, meta.generation)) {
    try { await g.setJSON(id, { ...card, up: tally.up, down: tally.down }); }
    catch { /* the recount repairs a card that missed a copy */ }
  }

  return { up: tally.up, down: tally.down, yours: value === 1 ? 'up' : value === -1 ? 'down' : null };
}

/* The daily recount (GALLERY-SPEC.md §7), run by netlify/functions/recount.mjs.
   It is the only scheduled thing that touches listed rows, and it does five
   things: reads which ids are listed off the cards and checks each against
   row metadata; walks the whole `votes` store with the unpaginated list(),
   one get per key for its value (a listing returns keys only); rewrites
   `votes-count` and the card for every listed id, copying views and copies
   in so a render never reads a counter store; rebuilds a card for a listed
   row that has none but has votes, which is the state createPassport's
   card-first order cannot repair from a request path; resolves durable category
   overrides when rebuilding cards; and deletes votes, tallies and category
   overrides whose generation is no longer current, plus cards whose row is
   gone or unlisted,
   which are the orphans a race or a failed unlist leaves.

   UNKNOWN IS NEITHER LISTED NOR ORPHAN. An id whose metadata read failed is
   excluded from counting: its votes are not read and its tally/card are not
   rewritten. Cleanup requires a successful fresh metadata read before any
   key is classified as orphaned. A recount that treated a failed read
   as "not listed" would delete every vote a listed passport has on one bad
   round trip, which is the sweeper's data-loss bug one store over.

   BUDGETED like sweep(), against the same 30-second ceiling for a scheduled
   function. At the measured 310 ms per operation and batches of DROP_BATCH,
   one get per vote key is about 80 keys a second, so a few thousand votes is
   where one run stops fitting; a run that stops early rewrites only the ids
   it finished reading, reports budgetSpent, and the next run starts over.
   Tallies it did not reach keep their vote-time values, at worst one lost
   update off.

   `refreshed` counts the listed ids whose tally this run actually rewrote,
   so the log line shows `listed` against it (audit, 2026-10-22). `cards`
   could not: a listed id with no card is refreshed without one, so is one
   whose card write then fails, and a run that stops in step 2 returns before
   any id is refreshed. `listed` minus `refreshed` is the listed ids this run
   did not refresh: cut by the budget, votes it could not read, a read or
   tally write that failed, or a listing that changed under it. */
export async function recount(deploy, { budgetMs = SWEEP_BUDGET_MS, clock = Date.now } = {}) {
  const startedAt = clock();
  const spent = () => clock() - startedAt;
  const out = { listed: 0, refreshed: 0, votes: 0, orphanVotes: 0, orphanTallies: 0, orphanCategories: 0, cards: 0,
                budgetSpent: false, listFailed: false };

  /* 1. the listed ids, off the cards, each checked against row metadata */
  const g = strong(deploy, 'gallery');
  let cardKeys;
  try {
    cardKeys = (await g.list()).blobs.map(b => b.key).filter(k => UUID.test(k));
  } catch {
    out.listFailed = true;
    return out;
  }
  const listed = new Map();
  const unknown = new Set();
  const staleCards = [];
  for (let i = 0; i < cardKeys.length; i += DROP_BATCH) {
    const batch = cardKeys.slice(i, i + DROP_BATCH);
    const metas = await Promise.all(batch.map(k => listedMeta(deploy, k)));
    batch.forEach((k, j) => {
      const m = metas[j];
      if (m === null) unknown.add(k);
      else if (m.listed) listed.set(k, m.generation);
      else staleCards.push(k);
    });
  }

  /* 2. every vote, grouped by id. An id with votes but no card is probed
     once: listed means the card is missing and gets rebuilt below, anything
     else means the votes are orphans. Votes count only when their namespace
     matches the generation captured from that metadata. */
  let voteKeys;
  try {
    voteKeys = (await strong(deploy, 'votes').list()).blobs.map(b => b.key);
  } catch {
    out.listFailed = true;
    return out;
  }
  const idOf = key => key.slice(0, key.indexOf(':'));
  const probe = [...new Set(voteKeys.map(idOf).filter(id => !listed.has(id) && !unknown.has(id) && UUID.test(id)))];
  for (let i = 0; i < probe.length; i += DROP_BATCH) {
    const batch = probe.slice(i, i + DROP_BATCH);
    const metas = await Promise.all(batch.map(k => listedMeta(deploy, k)));
    batch.forEach((k, j) => {
      const m = metas[j];
      if (m === null) unknown.add(k);
      else if (m.listed) { listed.set(k, m.generation); }
    });
  }
  out.listed = listed.size;

  const tally = new Map();
  for (const id of listed.keys()) tally.set(id, { up: 0, down: 0 });
  const orphanVotes = [];
  const toRead = [];
  for (const key of voteKeys) {
    const id = idOf(key);
    if (unknown.has(id)) continue;
    if (!listed.has(id) || voteScope(key) !== listingKey(id, listed.get(id))) { orphanVotes.push(key); continue; }
    toRead.push(key);
  }
  const votes = strong(deploy, 'votes');
  const damaged = new Set();
  for (let i = 0; i < toRead.length; i += DROP_BATCH) {
    if (spent() >= budgetMs) { out.budgetSpent = true; return out; }
    const batch = toRead.slice(i, i + DROP_BATCH);
    const values = await Promise.all(batch.map(k => votes.get(k).catch(() => undefined)));
    batch.forEach((k, j) => {
      const id = idOf(k);
      const v = values[j];
      if (v === undefined) { damaged.add(id); return; }
      const t = tally.get(id);
      if (v === '1') t.up++;
      else if (v === '-1') t.down++;
    });
  }

  /* 3. Read the card/counters, then confirm the SAME generation immediately
     before writing. There is no cross-key transaction: a relist can land in
     the remaining write round trip. The tally's namespace and the card's
     generation prevent that late write from being read as the new listing. */
  const counts = strong(deploy, 'votes-count');
  const lostListing = new Set();
  for (const [id, generation] of listed) {
    if (spent() >= budgetMs) { out.budgetSpent = true; break; }
    if (damaged.has(id)) continue;
    const t = tally.get(id);
    try {
      let card = await g.get(id, { type: 'json' });
      if (!cardMatches(card, generation)) {
        const row = await strong(deploy, 'passports').get(id, { type: 'json' });
        card = row && row.gallery && (row.gallery.generation || null) === generation ? cardOf(id, row) : null;
      }
      const [views, copies, category] = card
        ? await Promise.all([readViews(deploy, id), readCopies(deploy, id), readGalleryCategory(deploy, id, generation, card.category)])
        : [0, 0, null];
      const again = await listedMeta(deploy, id);
      if (again === null) continue;
      if (!sameListing(again, generation)) { lostListing.add(id); continue; }
      await counts.setJSON(listingKey(id, generation), { up: t.up, down: t.down, at: new Date().toISOString() });
      out.refreshed++;
      out.votes += t.up + t.down;
      if (!card) continue;
      await g.setJSON(id, { ...card, category, up: t.up, down: t.down, views, copies });
      out.cards++;
    } catch { /* next run */ }
  }

  /* 4. Cleanup rechecks each observed key against CURRENT metadata. A new
     listing may have appeared since step 1. Never classify its tally from
     that old snapshot, or delete a prefix that could contain its votes.
     Category overrides follow the same generation lifetime. */
  let categoryKeys = [];
  try { categoryKeys = (await strong(deploy, 'gallery-categories').list()).blobs.map(b => b.key); }
  catch { out.listFailed = true; }
  let tallyKeys = [];
  try { tallyKeys = (await counts.list()).blobs.map(b => b.key); }
  catch { out.listFailed = true; }
  for (const id of lostListing) {
    for (const key of toRead) if (idOf(key) === id) orphanVotes.push(key);
  }
  const reclaim = async (name, keys, scopeOf) => {
    const doomed = [];
    for (let i = 0; i < keys.length; i += DROP_BATCH) {
      if (spent() >= budgetMs) { out.budgetSpent = true; break; }
      const batch = keys.slice(i, i + DROP_BATCH);
      const metas = await Promise.all(batch.map(key => listedMeta(deploy, scopeId(scopeOf(key)))));
      batch.forEach((key, j) => {
        const scope = scopeOf(key);
        const meta = metas[j];
        if (meta && (!meta.listed || scope !== listingKey(scopeId(scope), meta.generation))) doomed.push(key);
      });
    }
    const n = await drop(deploy, name, doomed, () => spent() < budgetMs);
    if (n < doomed.length) out.budgetSpent = true;
    return n;
  };
  out.orphanVotes = await reclaim('votes', orphanVotes, voteScope);
  out.orphanTallies = await reclaim('votes-count', tallyKeys, key => key);
  out.orphanCategories = await reclaim('gallery-categories', categoryKeys, key => key);
  // Card keys are shared between generations. Recheck rather than delete a
  // card solely because this recount observed an earlier unlisted state.
  for (const id of new Set([...staleCards, ...lostListing])) {
    if (spent() >= budgetMs) { out.budgetSpent = true; break; }
    const meta = await listedMeta(deploy, id);
    if (meta && !meta.listed) await g.delete(id).catch(() => {});
  }
  return out;
}

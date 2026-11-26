/* _store-backup.mjs

   A copy of the bare (production) stores that hold durable state, and the way
   back. `exportStores` reads them, `serialiseBackup` and `parseBackup` turn the
   copy into files and back with a sha256 per file, and `restoreStores` writes a
   copy into the live stores. tools/backup-stores.mjs is the IO half, through
   tools/_backup-cli.mjs.

   WHY IT EXISTS. Netlify Blobs keeps no versions and has no point-in-time
   restore, and a write is last-write-wins. Meanwhile the hourly sweep, the
   recount and the hold sweep delete as their job, and sweepScopes, which
   deletes whole stores, has never run live (SCOPE_SWEEP_DRY_RUN in sweep.mjs).
   Listed passports, their votes and their categories are permanent public
   state, and before this file nothing could put one back. (Audit of
   analysis_and_improvement_plan.md, 2026-10-22: "no backup or restore".)

   BARE SCOPE ONLY, BY CONSTRUCTION. Nothing here takes a `deploy`. Every store
   is opened with `factory(name)`, the bare name production uses, so a preview
   cannot be backed up or restored into by mistake, and an export makes no
   write at all, not even the scope-registry write strong() makes for a scoped
   deploy.

   HOW LONG A COPY MAY BE KEPT IS NOT DECIDED HERE. A copy of `passports` holds
   the text people published, which privacy.html says is removed "immediately
   and permanently" when they delete it. Every copy taken before that delete
   still holds it. The retention rule for copies is the owner's decision, and
   the tool says so every time it writes one.

   Stores opened here: the BACKUP_STORES below, and expiry.

   Exports that _store.mjs does not re-export are internal to the _store-*.mjs family. */

import { isExpired } from './_row.mjs';
import { DROP_BATCH, factory, sha256, UUID } from './_store-core.mjs';
import { expiryKey } from './_store-expiry.mjs';
import { cardMatches, cardOf, listingKey, voteScope } from './_store-listing.mjs';

/* WHICH STORES. Every name in SCOPED_STORE_NAMES is in exactly one of the two
   lists below, and tools/backup.test.mjs fails when a store is added there with
   no decision here. A store is copied when losing it loses something nothing
   else rebuilds, and when keeping a copy does not break what privacy.html says
   about how long it lives.

   PASSPORTS FIRST, then the stores that hang off a passport. A listing writes
   its card before its row, so a row the passports read found listed already
   had its card, and the gallery read after it finds the card unless an unlist
   or a delete took it in between. Blobs has no transactions and a copy is not
   one instant, so restoreStores checks every dependent against its row rather
   than trusting the copy to agree with itself. */
export const BACKUP_STORES = Object.freeze([
  'passports',          // row, body and metadata { h, x, g, gg }; h keeps each owner's delete link working
  'gallery',            // the cards; a listed row without one is a passport nobody can find
  'gallery-categories', // category changes per listing generation
  'votes',              // one key per vote, kept for as long as the listing is
  'votes-count',        // the tallies; the recount rebuilds them from votes, but only on its own schedule
  'views', 'copies',    // the counters a card and /manage show; nothing else has them
  'metrics', 'attempts', 'jev', 'prompt-clicks' // never swept, no identifier, the only record of what the first users did
]);

/* Also not copied, and not in SCOPED_STORE_NAMES either: `scopes`, the bare
   registry of preview scopes, which a live preview rewrites on its next store
   call; and `pulse` / `pulse-preview` (netlify/edge-functions/count.ts), raw
   page counts the morning report deletes after 45 days (privacy.html), which a
   copy would outlive. */
export const NOT_BACKED_UP = Object.freeze({
  expiry: 'derived: the restore writes the index key of every unlisted row it restores from that row\'s own expires_at, index first, so a restored row can never be the unsweepable state purge() warns about',
  fingerprints: 'the duplicate guard, two hours long and self-clearing',
  ratelimit: 'limiter windows of a day or less, keyed by hashes of network and email addresses, of no use once the window has passed',
  acks: 'owner-review tickets, fifteen minutes long',
  digest: 'the once-a-day digest claim; an old claim put back could only suppress a digest',
  'sweep-dryrun': 'the teardown dry-run report\'s last state, which the next run rewrites',
  holds: 'at most five days of text nobody has reviewed yet; a copy would outlive the deletion privacy.html promises, and a hold put back could mail its owner twice',
  'hold-email': 'an address privacy.html says is used for one message and then deleted',
  'hold-expiry': 'the index of the holds above',
  'hold-pointers': 'thirty days of "this hold became that passport", read only by /api/check-hold; losing one degrades that answer, and keeping one past its expiry breaks the retention it was given',
  'hold-pointer-expiry': 'the index of the pointers above'
});

export const BACKUP_FORMAT = 'agent-passport-blobs-backup';
export const BACKUP_VERSION = 1;
export const BACKUP_NOTICE = 'This backup holds personal data: published passport text, which can name '
  + 'people, delete-token hashes and pseudonymous voter ids. A passport deleted after it was taken stays '
  + 'in it, although privacy.html says deletion removes the text immediately and permanently. Keep it only '
  + 'under the retention privacy.html states, never in the repository, and destroy it when that ends.';

/* The unpaginated list(): an export wants every key, and the cost note on
   SWEEP_PAGES (_store-core.mjs) is about request paths, not this. Listing is
   eventually consistent, so a key written in the last moments before an export
   can be missing from it; a copy is of what the listing showed.

   A key that lists and then reads null was deleted in between, and is left out
   (`vanished`). A read that THREW is `unreadable` and makes the copy
   incomplete: unknown is not gone, and a backup that quietly lacked a row would
   be found out on the day it is needed. */
async function readStore(name) {
  const store = factory(name);
  let blobs;
  try {
    ({ blobs } = await store.list());
  } catch {
    return { listed: false, entries: [], vanished: 0, unreadable: 0 };
  }
  const keys = blobs.map(b => b.key).sort();
  const entries = [];
  let vanished = 0;
  let unreadable = 0;
  for (let i = 0; i < keys.length; i += DROP_BATCH) {
    const batch = keys.slice(i, i + DROP_BATCH);
    const got = await Promise.all(batch.map(k => store.getWithMetadata(k).catch(() => undefined)));
    got.forEach((r, j) => {
      if (r === undefined) unreadable++;
      else if (r === null) vanished++;
      else entries.push({ key: batch[j], value: r.data, metadata: r.metadata || {} });
    });
  }
  return { listed: true, entries, vanished, unreadable };
}

/* Reads only. One store at a time, in BACKUP_STORES order, for the reason given
   above the list. */
export async function exportStores({ names = BACKUP_STORES } = {}) {
  const stores = {};
  for (const name of names) stores[name] = await readStore(name);
  const complete = Object.values(stores).every(s => s.listed && s.unreadable === 0);
  return { stores, complete };
}

/* One file per store, an array with one entry per line so the file can be
   grepped, and a manifest with each file's count and sha256. The value is the
   stored text exactly as read, never re-encoded, so a restore writes back the
   bytes the store held. */
export function serialiseBackup(snapshot, { created_at = new Date().toISOString(), site_id = null } = {}) {
  const files = {};
  const stores = {};
  for (const [name, s] of Object.entries(snapshot.stores)) {
    const file = `${name}.json`;
    const lines = s.entries.map(e => JSON.stringify({ key: e.key, value: e.value, metadata: e.metadata }));
    const content = '[\n' + lines.join(',\n') + (lines.length ? '\n' : '') + ']\n';
    files[file] = content;
    stores[name] = {
      file, count: lines.length, bytes: Buffer.byteLength(content), sha256: sha256(content),
      listed: s.listed, vanished: s.vanished || 0, unreadable: s.unreadable || 0
    };
  }
  const manifest = {
    format: BACKUP_FORMAT, version: BACKUP_VERSION, created_at, site_id,
    complete: snapshot.complete === true, notice: BACKUP_NOTICE, stores, not_backed_up: NOT_BACKED_UP
  };
  return { manifest, files };
}

/* The reverse, and it refuses rather than guesses: a manifest it did not write,
   a store it does not restore, a file name other than the one it would have
   written (the name comes from the manifest, so this is also what keeps a read
   inside the backup directory), a sha256 or a count that does not match, or an
   entry that is not { key, value, metadata }. `read(file)` returns the file's
   text. */
export async function parseBackup(manifest, read) {
  if (!manifest || manifest.format !== BACKUP_FORMAT || manifest.version !== BACKUP_VERSION) {
    throw new Error(`not a ${BACKUP_FORMAT} version ${BACKUP_VERSION} manifest`);
  }
  const stores = {};
  for (const [name, m] of Object.entries(manifest.stores || {})) {
    if (!BACKUP_STORES.includes(name)) throw new Error(`the manifest names a store this tool does not restore: ${name}`);
    if (!m || m.file !== `${name}.json`) throw new Error(`${name}: unexpected file name in the manifest`);
    const content = await read(m.file);
    if (sha256(content) !== m.sha256) throw new Error(`${m.file}: sha256 does not match the manifest`);
    const entries = JSON.parse(content);
    if (!Array.isArray(entries) || entries.length !== m.count) throw new Error(`${m.file}: entry count does not match the manifest`);
    for (const e of entries) {
      if (!e || typeof e.key !== 'string' || typeof e.value !== 'string'
          || !e.metadata || typeof e.metadata !== 'object' || Array.isArray(e.metadata)) {
        throw new Error(`${m.file}: an entry is not { key, value, metadata }`);
      }
    }
    stores[name] = { entries };
  }
  return { stores, complete: manifest.complete === true, created_at: manifest.created_at, site_id: manifest.site_id };
}

const PER_PASSPORT = ['gallery', 'gallery-categories', 'votes-count', 'votes', 'views', 'copies'];
const CORPORA = ['metrics', 'attempts', 'jev', 'prompt-clicks'];

const parse = text => { try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : null; } catch { return null; } };
const flat = m => JSON.stringify(Object.entries(m || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const sameEntry = (live, e) => live.data === e.value && flat(live.metadata) === flat(e.metadata);
const setOpts = m => (m && Object.keys(m).length ? { metadata: m } : {});
const generationOf = row => (row.gallery.generation || null);

/* Whether a dependent of passport `id` belongs with the row the restore leaves
   there (`row`): the counters with any row, the listing's keys only with a
   listed row and only for its current generation. Anything else in the copy is
   an orphan the recount or the sweep would reclaim, and putting it back would
   only hand them the work again. */
function belongs(name, entry, id, row) {
  if (!row) return false;
  if (name === 'views' || name === 'copies') return entry.key === id;
  if (!row.gallery) return false;
  const scope = listingKey(id, generationOf(row));
  if (name === 'gallery') return entry.key === id && cardMatches(parse(entry.value), generationOf(row));
  if (name === 'votes') return voteScope(entry.key) === scope;
  return entry.key === scope;   // gallery-categories, votes-count
}

async function inBatches(items, fn) {
  for (let i = 0; i < items.length; i += DROP_BATCH) await Promise.all(items.slice(i, i + DROP_BATCH).map(fn));
}

/* Put a copy back. DRY RUN UNLESS `apply` IS TRUE: without it this function
   reads and counts and never writes.

   NEVER OVER A NEWER VALUE UNLESS `force`. Blobs keeps no modification time,
   but a backup is a snapshot, so a live value that differs from the copy was
   written after the copy was taken (or the copy is from another site). Either
   way the live value wins and is counted `keep`. With `force` the copy wins and
   it is counted `overwrite`. A key absent from the live store is `create`, and
   equal is `same`. Each key is read immediately before it is written, which
   leaves one round trip for a vote or a bump to land in between; Blobs 8.x has
   no compare-and-swap (see _store-gallery.mjs), so that window is the floor.

   ABSENT IS NOT THE SAME AS LOST, and nothing here can tell them apart. A
   passport its owner deleted, an operator took down or that was erased on
   request after the copy was taken is absent too, and creating it brings it
   back. `resurrected` counts those rows so the tool can say so before anything
   is applied. The same holds one level down: a vote withdrawn since is absent
   (castVote deletes the key), and creating it beside a row that is still live
   puts it back for the next recount to count, so `resurrectedVotes` counts
   those. What is never brought back: an unlisted row whose thirty days
   have passed (`expired`), which privacy.html says is deleted, and with it
   anything that hangs off it.

   `force` NEVER WRITES WHAT IS NOT IN THE COPY. A listed row whose card the
   copy lacks (an unlist between the two reads, or a gallery already lost when
   the copy was taken) gets a card made from the row, with every counter at
   zero. That card is written only where there is no live card; over a live
   one it is `keep` even with `force`, because it would zero the counters the
   gallery shows until the recount, which rebuilds a card that does not match
   its row anyway.

   THE INVARIANTS ARE THE WRITE PATH'S, per passport. A listed row's card is
   written before the row and an unlisted row's expiry index key before the
   row, as createPassport does and for its reason: if the row write fails, what
   is left is an orphan the listing page or the sweep reclaims, and if the first
   write fails the row is not written at all. Then the listing's category,
   tally and votes and the counters, each only if it belongs with the row
   (`belongs` above). A row that is `same` gets its card or index key checked
   too, which is what repairs a lost `gallery` or `expiry` store. The corpora
   come last; nothing hangs off them. */
export async function restoreStores(snapshot, { apply = false, force = false, now = Date.now() } = {}) {
  const report = { applied: apply, force, stores: {}, resurrected: 0, resurrectedVotes: 0, expired: 0, ok: true };
  const count = (name, action) => {
    const t = report.stores[name] ||= { create: 0, same: 0, keep: 0, overwrite: 0, skip: 0, unknown: 0, failed: 0 };
    t[action]++;
    if (action === 'unknown' || action === 'failed') report.ok = false;
    return action;
  };

  /* Read, decide, and write only if applying. Returns the action. */
  const restoreKey = async (name, entry, overwrite = force) => {
    const store = factory(name);
    let live;
    try { live = await store.getWithMetadata(entry.key); } catch { return 'unknown'; }
    const action = live === null ? 'create' : sameEntry(live, entry) ? 'same' : overwrite ? 'overwrite' : 'keep';
    if (apply && (action === 'create' || action === 'overwrite')) {
      try { await store.set(entry.key, entry.value, setOpts(entry.metadata)); } catch { return 'failed'; }
    }
    return action;
  };

  const entriesOf = name => (snapshot.stores[name] && snapshot.stores[name].entries) || [];
  const byId = new Map();
  const slot = id => { if (!byId.has(id)) byId.set(id, {}); return byId.get(id); };
  for (const name of ['passports', ...PER_PASSPORT]) {
    for (const e of entriesOf(name)) {
      const id = e.key.split(':')[0];
      if (!UUID.test(id)) { count(name, 'skip'); continue; }
      (slot(id)[name] ||= []).push(e);
    }
  }

  const restorePassport = async ([id, own]) => {
    let cardDone = false;
    const skipAll = action => {
      for (const name of PER_PASSPORT) {
        if (name === 'gallery' && cardDone) continue;
        for (const _ of own[name] || []) count(name, action);
      }
    };
    let live;
    try { live = await factory('passports').getWithMetadata(id); } catch {
      if (own.passports) count('passports', 'unknown');
      return skipAll('unknown');
    }
    const liveRow = live ? parse(live.data) : null;
    const copy = own.passports && own.passports[0];
    let row = liveRow;
    let action = null;
    if (copy) {
      const copied = parse(copy.value);
      if (!copied) action = 'skip';
      else if (isExpired(copied, now)) { action = 'skip'; report.expired++; }
      else action = !live ? 'create' : sameEntry(live, copy) ? 'same' : force ? 'overwrite' : 'keep';
      if (action === 'create' || action === 'overwrite' || action === 'same') row = copied;
    }

    /* A live row that has expired is the sweep's, within the hour; nothing is
       restored beside it. */
    if (row && isExpired(row, now)) row = null;

    /* The card, or the index key, first; the gallery pass below then skips the
       card, which has been dealt with here. */
    if (row && (action === 'create' || action === 'overwrite' || action === 'same')) {
      let first = null;
      if (row.gallery) {
        const fromCopy = (own.gallery || []).find(e => belongs('gallery', e, id, row));
        first = count('gallery', fromCopy ? await restoreKey('gallery', fromCopy)
          : await restoreKey('gallery', { key: id, value: JSON.stringify(cardOf(id, row)), metadata: {} }, false));
        cardDone = true;
        if (!fromCopy) for (const _ of own.gallery || []) count('gallery', 'skip');
      } else if (Number.isFinite(Date.parse(row.expires_at))) {
        first = count('expiry', await restoreKey('expiry',
          { key: expiryKey(Date.parse(row.expires_at), id), value: '1', metadata: {} }));
      }
      if (action !== 'same' && (first === 'unknown' || first === 'failed')) {
        /* The index did not land, so the row must not either. */
        count('passports', 'failed');
        return skipAll('skip');
      }
      if (action !== 'same' && apply) {
        try { await factory('passports').set(id, copy.value, setOpts(copy.metadata)); } catch {
          count('passports', 'failed');
          return skipAll('skip');
        }
      }
    }
    if (action) count('passports', action);
    if (action === 'create') report.resurrected++;

    for (const name of PER_PASSPORT) {
      if (name === 'gallery' && cardDone) continue;
      await inBatches(own[name] || [], async e => {
        if (!belongs(name, e, id, row)) return count(name, 'skip');
        const done = count(name, await restoreKey(name, e));
        if (name === 'votes' && done === 'create' && live) report.resurrectedVotes++;
      });
    }
  };

  await inBatches([...byId.entries()].sort(([a], [b]) => (a < b ? -1 : 1)), restorePassport);
  for (const name of CORPORA) await inBatches(entriesOf(name), async e => count(name, await restoreKey(name, e)));
  return report;
}

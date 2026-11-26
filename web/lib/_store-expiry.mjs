/* _store-expiry.mjs

   How long a passport lives and how it is made to stop: the TTL constants and
   `expiryFrom`, the expiry-index key (`expiryKey`), `purge` (everything a
   passport left behind, in one place) and `sweep`, the scheduled pass that
   finds dead entries by key name and purges them.

   Sits above _store-listing.mjs and _store-ratelimit.mjs (purge drops a
   listing and releases a fingerprint) and below _store-passport.mjs, which
   calls `purge` for an owner's delete.

   Stores opened here: passports, views, copies, expiry, fingerprints, hold-pointers, hold-pointer-expiry.

   Exports that _store.mjs does not re-export are internal to the _store-*.mjs family. */

import { isExpired } from './_row.mjs';
import { DAY_MS, drop, DROP_BATCH, HOUR_MS, scan, strong } from './_store-core.mjs';
import { dropListing } from './_store-listing.mjs';
import { ACK_TTL_MS, fpKey } from './_store-ratelimit.mjs';

/* How long a link lives. Expiry is the privacy story and the storage story in
   one: a passport nobody renewed stops being readable and is then deleted, and
   neither needs anybody to remember it exists. Renewing is one click from the
   delete token, and it moves the date rather than extending it, so a passport
   renewed on its last day and one renewed on its first both get the same thirty
   days. */
export const TTL_DAYS = 30;
export const RENEW_DAYS = 30;

export const expiryFrom = (now, days) => new Date(now + days * DAY_MS).toISOString();

export const expiryKey = (ms, id) => `${String(ms).padStart(16, '0')}:${id}`;

/* Everything a passport left behind, gone in one place. Getting this list wrong
   is how a "delete" turns into a "hide": the fingerprint used to survive here,
   which both contradicted the privacy page's list of what is stored and refused
   the owner's re-upload of a file they had just deleted. */
/* THE INVARIANT, and it is the whole of this function's safety:

     An expiry-index entry pointing at a live row is RECOVERABLE. The next sweep
     re-reads that row, finds it still expired, and tries again.
     An ABSENT entry pointing at a live row is not recoverable by anything.

   `sweep()` enumerates dead passports ONLY by scanning the expiry index, so a
   row with no index key cannot be reached again by any code path that exists. It
   is then retained past the thirty days privacy.html promises, permanently, and
   nothing can detect it.

   The row delete used to be `.catch(() => {})` like the cosmetic deletes beside
   it, which broke that invariant with no crash required: one transient rejection
   on `passports.delete` while the CONCURRENT `expiry.delete` succeeded left
   exactly the unrecoverable state. Storage throws under load; readMeta's
   neighbour comment says so, and the identical collapse was already found and
   fixed for the expiry READ two hundred lines up: "a read that FAILED and a
   passport that is ABSENT are different answers."

   So the row delete's outcome is captured rather than discarded, the index key
   is put back if it failed, and the result is returned so callers can stop
   claiming a deletion they did not get. The repair costs a round trip only on
   the failure path. */
export async function purge(deploy, id, row) {
  const rowGone = strong(deploy, 'passports').delete(id).then(() => true, () => false);
  const jobs = [
    rowGone,
    strong(deploy, 'views').delete(id).catch(() => {}),
    /* Same shape as views: one integer in its own store, deleted beside it,
       and reclaimed by the same rotating sweep if a late bump lands after
       this delete. */
    strong(deploy, 'copies').delete(id).catch(() => {})
  ];
  let expiryDeleted = null;
  if (row && row.expires_at) {
    const ms = Date.parse(row.expires_at);
    if (Number.isFinite(ms)) {
      expiryDeleted = expiryKey(ms, id);
      jobs.push(strong(deploy, 'expiry').delete(expiryDeleted).catch(() => {}));
    }
  }
  if (row && row.fingerprint && row.fingerprint_bucket !== undefined) {
    jobs.push(strong(deploy, 'fingerprints')
      .delete(fpKey(row.fingerprint, row.fingerprint_bucket)).catch(() => {}));
  }
  await Promise.all(jobs);

  const ok = await rowGone;
  if (!ok && expiryDeleted) {
    /* THE REPAIR MUST NOT SWALLOW, and this is the one place where swallowing is
       most tempting and least defensible.

       It used to be `.catch(() => {})` like everything around it. But this line
       runs ONLY because `passports.delete` just rejected, and storage rejecting
       under load is exactly when a second write to a sibling store also rejects.
       **The two failures are correlated: the repair is least likely to work at
       precisely the moment it is needed.** So a swallow here reproduces the
       unrecoverable state that this whole function exists to prevent, by way of
       the fix for it. Found by a critic, who measured it: row alive, zero index
       entries, unreachable by ten further sweeps.

       Nothing in this process can put it right once both writes have failed. The
       only thing left is to make it loud. The function log is the only channel
       that reaches a person. This used to add that `sweep()`'s return value is
       discarded by `upload.mjs`, so a counter would reach nobody; upload.mjs no
       longer calls sweep at all, and netlify/functions/sweep.mjs does log the
       counts. The conclusion is unchanged, because a count of orphans created is
       not one of the counts it returns.

       NO IDENTIFIER IS LOGGED. A passport uuid is the only secret in this
       system, and a count is enough to detect the condition. */
    const restored = await strong(deploy, 'expiry').set(expiryDeleted, '1').then(() => true, () => false);
    if (!restored) {
      console.error('expiry index restore FAILED after a failed row delete; '
        + 'a live passport now has no index entry and no sweep can reach it');
    }
  }
  /* THE LISTING GOES ONLY ONCE THE ROW HAS GONE, and only for a row that was
     listed (GALLERY-SPEC.md §2 invariant 3). Gated on `row.gallery` because
     the votes cleanup is a prefix LISTING, and every sweep of an ordinary
     expired row would otherwise pay it; by invariant 1 an unlisted row has no
     card and no tally, and the one state that breaks that, a card left behind
     by a failed unlist, is repaired by the listing page when it finds the row
     absent. After `rowGone` rather than beside it: a card deleted while the
     row delete fails leaves a listed row with no card, which is the state
     nothing notices, whereas a card whose row has gone is the state the
     listing page repairs on its next render. Cosmetic in the sense above:
     every job swallows, and the row-versus-index invariant is untouched. */
  if (ok && row && row.gallery) await dropListing(deploy, id, row.gallery.generation || null);

  /* A passport that came out of review carries the id of its hold (createPassport's `hold`), and the
     pointer under that id says "released" and names this passport to /api/check-hold. It goes with
     the passport, deleted by the owner or expired, and only once the row is gone. A failed delete
     here is bounded, not silent: the pointer's own expiry key is left in place and the sweep removes
     both at their 30 days. */
  if (ok && row && row.hold && typeof row.hold.id === 'string') {
    const gone = await strong(deploy, 'hold-pointers').delete(row.hold.id).then(() => true, () => false);
    if (gone && Number.isFinite(row.hold.x)) {
      await strong(deploy, 'hold-pointer-expiry').delete(expiryKey(row.hold.x, row.hold.id)).catch(() => {});
    }
  }

  /* `expiryDeleted` rides along so sweep() can tell whether this call already
     removed the exact key it scanned, instead of deleting it a second time.
     ROW-88's third item: the scanned key and this one are byte-identical
     whenever row is non-null and expired, which is the only shape sweep()
     calls this with, so that second delete was a guaranteed-redundant round
     trip on every real purge. deletePassport and operatorDelete
     (_store-takedown.mjs), the other two callers, have no scanned key to
     compare against and only ever read `.ok`. */
  return { ok, expiryDeleted };
}

/* ── the sweeper ────────────────────────────────────────────
   Expiry enforced only on read means an expired passport that nobody opens
   again is never actually deleted, and the common case for an expired passport
   is precisely that nobody opened it. "It stops being served" and "it is
   deleted" are not the same sentence, and the privacy page makes the second
   claim. This is what makes that claim true.

   It runs from the upload endpoint rather than from a schedule, because a
   scheduled function is another thing to configure and go wrong, and because
   somebody publishing a passport is the one moment this site reliably has a
   process running with time to spare. Work is bounded so a busy store cannot
   turn one upload into a long request.

   The expiry index is what makes it cheap: one empty key per passport, named
   for the millisecond it dies, so finding the dead ones is a key listing and a
   string compare with no bodies fetched at all. */

/* `views` keys are bare passport UUIDs, not time-bucketed like every other
   store this file sweeps, so the trick in the note on SWEEP_PAGES (_store-core.mjs) — the oldest keys
   sort first —
   has nothing to bite on: a bounded scan with no prefix would read the same
   arbitrary slice of the store on every run, forever, and never be the slice
   an orphan happens to sort into. Found by a critic attacking exactly the
   claim that this could not be bounded and made convergent at once; it built
   the counterexample by rotating scan()'s existing `prefix` argument.

   256 two-hex-character slices covering the whole UUID keyspace, one slice
   scanned per calendar day (derived from `now`, not `clock` — this is a
   rotation schedule, not the sweep's own elapsed time, and `now` is the seam
   tests already move). Every run still reads at most SWEEP_PAGES pages of ONE
   slice; every key in the store is read by some run within a 256-day cycle.
   Depth is fixed rather than sized to the store, so it is conservative for a
   small store and, if the store ever holds enough live passports that one
   slice alone exceeds a few pages, slower to fully rotate rather than
   unbounded per run — a tuning question, not a correctness one, and nothing
   here has ever measured the real store's size to size it by. */
export const VIEWS_SLICES = (() => {
  const HEX = '0123456789abcdef';
  const out = [];
  for (const a of HEX) for (const b of HEX) out.push(a + b);
  return out;
})();

/* BUDGET, and why it is a deadline rather than a smaller count.

   `maxPassports` and `maxKeys` are proxies for time and they are bad ones. The
   measured cost of one store operation against production is 310 ms with an IQR
   of 282 to 323, and neither this module nor its caller controls it. A count
   tuned for 310 ms is wrong at 500. A deadline is the quantity actually being
   protected.

   WHAT IT PROTECTS CHANGED, AND THE NUMBER WITH IT. This bound was written to
   protect a publisher's request, because sweep() ran on the publish path. It no
   longer does: netlify/functions/sweep.mjs owns it and nobody is waiting. What
   remains is a platform ceiling, and Netlify documents **30 seconds for a
   scheduled function**, which is a different figure from the synchronous limit
   and must not be conflated with it. Verified against the current docs on
   2026-08-15 rather than assumed from the synchronous number, which this crew
   has four conflicting values for and never settled.

   So the budget is 20 seconds against a 30 second ceiling, leaving 10 for the
   scan and the response. It is not tuned, because tuning it needs the store
   dirtiness figure that only the orphan audit can produce and that audit is
   parked. It is a deliberate stand-in for that measurement, chosen to be
   obviously conservative rather than plausibly right: a run that ends early
   loses nothing, because the expiry index is a durable to-do list and the next
   run resumes from it. Raise it once a real backlog figure exists.

   THE SPLIT IS THE POINT, AND IT SURVIVES THE MOVE TO A SCHEDULE. The expiry
   loop gets only `EXPIRY_SHARE` of the budget, not all of it. The three key
   stores below it fill from ordinary traffic rather than from expiry, including
   from REFUSED uploads, so they are what makes a sweep expensive with zero
   passports expired. Under a single overall deadline the expiry loop would
   consume it all and those three would never run, which is exactly the failure
   the 2026-08-12 handoff recorded for the timeout case: "it self-heals is true
   of passports and false of everything else in the sweep." Removing the reserve
   because "there is no publisher waiting now" is the specific mistake this
   comment exists to prevent; the ceiling is what the reserve was ever about.

   WHAT THE RAISED COUNTS ACTUALLY BUY, WHICH IS LESS THAN IT LOOKS. The bounds
   below went from 20 passports and 100 keys to 200 and 1000, because leaving a
   publisher-sized cap on a scheduled job would fix latency and cap the system's
   deletion throughput forever. But the budget binds long before the count does.
   Arithmetic, at the measured 310 ms per store operation:

     the expiry loop is SEQUENTIAL, and each passport costs three round trips
     (the get, the purge's parallel deletes, the index delete)  ~0.93 s
     expiry share of the budget                                  10 s
     passports actually reachable in one run                    ~10
     at @hourly                                                 ~240 / day

   So `maxPassports: 200` is a backstop, not a capacity. Nothing is wrong with
   that, and it is written down because a reader who sees 200 and assumes a run
   clears 200 will pick the wrong interval. If a backlog ever exceeds 240 a day
   the system still converges, just slowly, and the fix is a shorter interval
   rather than a larger count, because the count is not what is stopping it.

   Also note `SWEEP_PAGES = 4` upstream: a run only ever sees the keys in four
   pages of the expiry listing, whatever the page size turns out to be.

   THE DOUBLES PAGE DIFFERENTLY AND THE NUMBER HERE WAS WRONG. An earlier version
   of this paragraph said the in-memory double pages at 25, so the suite could
   never present more than 100 keys. That is the ENDPOINT double, in
   tools/run-endpoint-tests.mjs. The one that actually exercises `sweep()`, in
   tools/run-tests.mjs, has `page = 3`, so four pages is TWELVE keys, and the
   figure was out by a factor of eight in a paragraph written to correct an
   overclaim. Seeding forty expired passports still yields four swept.

   The consequence is unchanged and now rests on the right number: no test in
   this suite can assert anything about the raised bounds without first raising
   the double's page size, which several of them do deliberately. A test that
   claimed 200 passports were swept in one run would be asserting a property of
   the double. */
export const SWEEP_BUDGET_MS = 20000;
export const EXPIRY_SHARE = 0.5;

export async function sweep(deploy, {
  now = Date.now(), maxPassports = 200, maxKeys = 1000,
  budgetMs = SWEEP_BUDGET_MS, clock = Date.now
} = {}) {
  /* `clock` is a test seam. An in-memory double runs a whole sweep inside a
     millisecond, so a budget test against the real clock would be a race rather
     than a test.

     Deliberately NOT the injectable `now`. `now` is the expiry comparison and
     tests move it years; elapsed time is a different quantity, and conflating
     them would let a test that ages a passport also exhaust the budget. */
  const startedAt = clock();
  const spent = () => clock() - startedAt;
  const expiryDeadline = budgetMs * EXPIRY_SHARE;
  /* `listFailed` exists so that an all-zero run is readable. A clean store and a
     sweep that could not list anything both return zeros, and the tuning advice
     on the scheduled function says a run of zeros means it can run less often.
     Without this flag that advice is wrong in exactly the case that matters. */
  /* THE BACKLOG, and why `budgetSpent` alone could not show it (audit,
     2026-10-22). One boolean cannot tell "an hour behind" from "two weeks
     behind", and the slice below used to cut the due list to maxPassports
     before anything counted it. `expiryBacklog` is every past-due index key
     this run's scan saw, before that cut; `expiryBacklogAgeMin` is how long
     ago the oldest of them expired. Both are null when the listing failed
     (unknown is not zero, the same rule as `listFailed`) and the age is null
     when nothing is due. The count is a floor when it equals what the scan
     read, since the scan stops at SWEEP_PAGES pages; the age is exact either
     way, because the index sorts oldest-first. */
  const removed = { passports: 0, limits: 0, fingerprints: 0, acks: 0, views: 0, copies: 0,
                    budgetSpent: false, listFailed: false,
                    expiryBacklog: null, expiryBacklogAgeMin: null };

  try {
    const blobs = await scan(deploy, 'expiry');
    if (blobs.failed) removed.listFailed = true;
    const due = blobs
      .map(b => b.key)
      .filter(k => {
        const cut = k.indexOf(':');
        return cut > 0 && Number(k.slice(0, cut)) <= now;
      });
    if (!blobs.failed) {
      removed.expiryBacklog = due.length;
      let oldest = Infinity;
      for (const k of due) oldest = Math.min(oldest, Number(k.slice(0, k.indexOf(':'))));
      if (due.length) removed.expiryBacklogAgeMin = Math.floor((now - oldest) / 60000);
    }
    const dead = due.slice(0, maxPassports);

    for (const key of dead) {
      /* Checked BEFORE any work for this key, never inside a purge. A purge
         either runs whole or not at all, so an exhausted budget can never leave
         a passport half-removed. What is skipped is simply retried next sweep;
         the expiry index is the durable to-do list and it is still intact. */
      if (spent() >= expiryDeadline) { removed.budgetSpent = true; break; }

      const id = key.slice(key.indexOf(':') + 1);

      /* A read that FAILED and a passport that is ABSENT are different answers,
         and collapsing them here is how the guard below stops working. It used
         to be `.catch(() => null)`, so one transient error on one get turned
         into "not expired is unknowable, therefore delete", and a live
         passport went irreversibly with it. Storage throws under load; that is
         what storage does. */
      let row = null;
      try {
        row = await strong(deploy, 'passports').get(id, { type: 'json' });
      } catch {
        continue;      // unknown is not dead. Next sweep asks again.
      }

      /* The index says this one is dead. The RECORD decides, and this check is
         the difference between a sweeper and a data-loss bug.

         renewPassport writes the new index key before deleting the old one,
         which is the correct order — the failure it makes possible is a
         leftover key, and the failure the other order makes possible is a live
         passport with no index entry that is never swept. But a leftover key is
         a past-dated key pointing at a passport that was renewed, and a sweeper
         that trusted it would delete a live passport, irreversibly, without
         telling its owner. So: re-read, and if it is not actually expired,
         drop the stale key and leave the passport alone. */
      if (row && !isExpired(row, now)) {
        await strong(deploy, 'expiry').delete(key).catch(() => {});
        continue;
      }

      /* ROW-88. The comment this replaced said the count below must be gated on
         the row ACTUALLY going, and then did not gate it: `row === null` reached
         `purge(id, null)` same as an expired row, and `passports.delete` on an
         already-absent key RESOLVES rather than throwing — Netlify Blobs' delete
         is idempotent, same as the double's `Map.delete` on a missing key. So
         `ok` came back true, `removed.passports` counted a purge that purged
         nothing, and the count is the only thing this scheduled function logs.
         An orphan expiry-index key (the row already gone by some other route, or
         a previous sweep dying between purge() and this delete) is real and
         worth clearing, it is just not a purged passport. */
      if (!row) {
        await purge(deploy, id, null);  // defensive: clears a stray views/<id> for this id too
        await strong(deploy, 'expiry').delete(key).catch(() => {});
        continue;
      }

      /* Gated on the row ACTUALLY going. Dropping the index key for a passport
         that is still there is the unrecoverable state described on purge(). */
      const { ok, expiryDeleted } = await purge(deploy, id, row);
      if (ok) {
        removed.passports++;
        /* purge() already deleted `expiryDeleted` when it could compute one, and
           for the common case reaching this line that is byte-identical to the
           `key` this loop is scanning, so re-deleting it was a guaranteed-
           redundant round trip on every ordinary purge (ROW-88's third item).
           Two real cases still fall through to deleting `key` here, not the one
           this comment named at first:

           1. An unparseable `expires_at`, where purge() cannot compute a key at
              all.
           2. renewPassport wrote a NEW index key and its delete of the OLD one
              failed (`.catch(() => {})`, deliberately — see renewPassport). If
              the row then lives long enough to expire again under its renewed
              date, sweep() eventually scans that OLD, stale key, re-reads a row
              whose `expires_at` is now the NEW date, and purge() computes
              `expiryDeleted` from THAT date — a different string from `key`.
              Rare: the ordinary path is that sweep() reaches the stale key
              first, while the row is still not-yet-re-expired, and clears it
              in the branch above without ever calling purge(). Found by a
              critic reviewing this branch after the comment here claimed
              unparseable dates were the only case; the mismatch is handled
              correctly either way, since equality is checked rather than
              assumed, but the comment was wrong about why.

           NOT PURELY A COST CHANGE, which is what this section used to claim.
           purge()'s own delete of `expiryDeleted` also swallows its failure
           (`.catch(() => {})`, inside purge()). The old unconditional delete
           here was an accidental RETRY of that swallowed failure, on the
           common path where the two keys match. Skipping it now means a
           transient failure inside purge()'s delete is no longer retried in
           the same sweep. Benign rather than a regression: the leftover key
           is exactly what the `!row` branch above reclaims on the NEXT sweep,
           uncounted, same as any other orphan expiry key — just one cycle
           later than the old code's accidental immediate retry. */
        if (expiryDeleted !== key) await strong(deploy, 'expiry').delete(key).catch(() => {});
      }
    }
  } catch { /* a sweep that cannot list is a sweep that does nothing */ }

  /* Limiter keys for addresses that never came back. Every key carries its own
     window length and its bucket, so a dead bucket is arithmetic rather than a
     lookup table, and the keys sort oldest-first so the pages read are the ones
     with dead keys in them. */
  {
    const doomed = [];
    const found = spent() < budgetMs ? await scan(deploy, 'ratelimit') : [];
    if (found.failed) removed.listFailed = true;
    for (const { key } of found) {
      if (doomed.length >= maxKeys) break;
      const [windowMs, bucket] = key.split(':');
      const end = (Number(bucket) + 1) * Number(windowMs);
      if (Number.isFinite(end) && end < now) doomed.push(key);
    }
    if (spent() < budgetMs) {
      removed.limits = await drop(deploy, 'ratelimit', doomed, () => spent() < budgetMs);
      if (removed.limits < doomed.length) removed.budgetSpent = true;
    } else if (doomed.length) removed.budgetSpent = true;
  }

  {
    const live = Math.floor(now / HOUR_MS);
    const doomed = [];
    const found = spent() < budgetMs ? await scan(deploy, 'fingerprints') : [];
    if (found.failed) removed.listFailed = true;
    for (const { key } of found) {
      if (doomed.length >= maxKeys) break;
      const bucket = Number(key.slice(0, key.indexOf(':')));
      if (Number.isFinite(bucket) && bucket < live - 1) doomed.push(key);
    }
    if (spent() < budgetMs) {
      removed.fingerprints = await drop(deploy, 'fingerprints', doomed, () => spent() < budgetMs);
      if (removed.fingerprints < doomed.length) removed.budgetSpent = true;
    } else if (doomed.length) removed.budgetSpent = true;
  }

  /* Tickets from owner-review stops that nobody came back through. The TTL was
     enforced on read and nothing ever read them again, so they were permanent. */
  {
    const live = Math.floor(now / ACK_TTL_MS);
    const doomed = [];
    const found = spent() < budgetMs ? await scan(deploy, 'acks') : [];
    if (found.failed) removed.listFailed = true;
    for (const { key } of found) {
      if (doomed.length >= maxKeys) break;
      const bucket = Number(key.slice(0, key.indexOf(':')));
      if (Number.isFinite(bucket) && bucket < live - 1) doomed.push(key);
    }
    if (spent() < budgetMs) {
      removed.acks = await drop(deploy, 'acks', doomed, () => spent() < budgetMs);
      if (removed.acks < doomed.length) removed.budgetSpent = true;
    } else if (doomed.length) removed.budgetSpent = true;
  }

  /* Orphaned views/<id> rows: a bumpViews() write that landed after purge()
     had already deleted the passport (ROW-140). See VIEWS_SLICES above for
     why this cannot be a bare bounded scan the way the three blocks above are.

     A candidate key is orphaned when its passport no longer exists. Checked
     with getMetadata, the same existence check bumpViews itself now runs, not
     a body read. This is the one cost the blocks above do not pay: they can
     tell a dead key from its own bucket number; this one has to ask the
     sibling store, one round trip per candidate, batched like drop()'s
     deletes. A getMetadata that THROWS is treated as "unknown", not "gone" —
     the same distinction this file draws everywhere else between a failed
     read and an absent row — so a transient error costs a missed reclaim
     this cycle rather than a live row's views key. */
  /* `copies` is keyed and reclaimed exactly like `views` (GALLERY-SPEC.md
     §7b: "whatever backend does for views there, do for copies in the same
     place"), so the same slice of both stores is read on the same day. */
  for (const name of ['views', 'copies']) {
    const slice = VIEWS_SLICES[Math.floor(now / DAY_MS) % VIEWS_SLICES.length];
    const found = spent() < budgetMs ? await scan(deploy, name, { prefix: slice }) : [];
    if (found.failed) removed.listFailed = true;
    const candidates = found.map(b => b.key).slice(0, maxKeys);
    const doomed = [];
    for (let i = 0; i < candidates.length; i += DROP_BATCH) {
      if (spent() >= budgetMs) { removed.budgetSpent = true; break; }
      const batch = candidates.slice(i, i + DROP_BATCH);
      const gone = await Promise.all(batch.map(k =>
        strong(deploy, 'passports').getMetadata(k).then(m => m === null, () => false)));
      batch.forEach((k, j) => { if (gone[j]) doomed.push(k); });
    }
    if (spent() < budgetMs) {
      removed[name] = await drop(deploy, name, doomed, () => spent() < budgetMs);
    } else if (doomed.length) removed.budgetSpent = true;
  }

  return removed;
}

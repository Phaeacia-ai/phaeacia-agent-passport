/* _store-metrics.mjs

   The corpus: one row per publish (`recordMetrics`), per refused upload
   (`recordRejection`) and per Jev check (`recordJev`), none of them swept and
   none of them joined to a passport. `readCorpusDay` reads one day back, and
   `claimDigestDay` is the once-a-day claim the digest mail makes.

   Stores opened here: metrics, attempts, jev, digest.

   Exports that _store.mjs does not re-export are internal to the _store-*.mjs family. */

import { randomUUID } from 'node:crypto';
import { strong } from './_store-core.mjs';

/* ── metrics ────────────────────────────────────────────────
   One row per publish, describing the shape of what was published and nothing
   about who published it. The record is built in _metrics.mjs, which is where
   the rule about what may go in it is written down.

   Three properties of this function are deliberate.

   It is keyed by `day:uuid`, so the store lists oldest-first and a day can be
   read without touching any other day. The uuid is fresh randomness, not the
   passport's id: there is deliberately no key that joins a row to a page, which
   is why deleting a passport cannot delete its row. There is nothing to look up.

   It is NOT swept and NOT deleted with the passport. That is the one thing on
   this site that outlives the thing it describes, the privacy page says so in
   those words, and it is the reason the record carries a date rather than a
   time: a timestamp beside a passport written in the same second is a join key.

   It never throws. A metric is worth less than a publish, and this runs on the
   path where the delete token exists in exactly one response. A caller that
   let this failure surface would turn a missing statistic into a passport the
   owner cannot take down. */
export async function recordMetrics(deploy, record) {
  try {
    const day = String(record && record.day || '').slice(0, 10) || 'undated';
    await strong(deploy, 'metrics').setJSON(`${day}:${randomUUID()}`, record);
    return true;
  } catch {
    return false;
  }
}

/* One row per REFUSED upload. Its own store, and that is not tidiness.

   `metrics` means "one row per publish" to every reader it has: the endpoint
   suite asserts exactly one row per publish, tools/metrics.mjs divides by
   `rows.length` to get percentages, and privacy.html describes it as the record
   of a passport that was published. Putting a refusal in there would falsify all
   three at once and every consumer would have to learn to filter. A separate
   store leaves each corpus meaning one thing.

   Same key shape, `day:uuid`. It sorts oldest-first BY DAY and not within one:
   the suffix is random, so the order rows were written in on a given day is not
   recoverable from the store. That is the right trade here rather than a
   limitation, because an intra-day sequence is the beginning of a session, but
   the claim is "oldest day first" and not "oldest row first". A day still reads
   without touching another day, and the uuid is fresh randomness rather than
   anything derived from the request, so no key joins a row to a person, an
   address or a file.

   NOT SWEPT, like `metrics` and unlike everything else here. A row is a date and
   an error code; there is no identifier in it to expire and nothing to look up.

   THAT IS NOT THE WHOLE STORY AND THE COMPARISON TO `metrics` FLATTERS IT.
   Three ways this corpus is worse than the publish corpus it is modelled on, all
   raised by a critic and all standing:

   - **Volume.** Publishes are capped at 20 per address per day. Refusals run to
     35 full validator runs per address per hour. The corpus that is never swept
     is the one that grows fastest.
   - **A join exists while a limiter bucket is live.** `bad-h` keys carry a
     hashed address and an hour bucket and no code; rows here carry a day and a
     code and no address. Separately neither identifies anybody. Together, on a
     quiet day, they attribute a code to an address. privacy.html:136-138 already
     concedes a version of this for `metrics` and it bites harder here, because
     this site has no external users yet and nearly every row is one of a handful
     of known people.
   - **The exclusion is silent.** `netlify/functions/sweep.mjs` has no entry for
     this store, so nothing at the place sweeping is defined records that this
     store is deliberately outside it.

   None of that changes the decision — an expiring corpus cannot answer "what
   were people bouncing off in the first month" — but it is the reason this store
   is named in the privacy amendment rather than folded into the existing
   paragraph about the record of what was published.

   It never throws, for the same reason recordMetrics does not: this runs on the
   path that returns a refusal to somebody who is trying to fix their file, and a
   storage hiccup must not turn a clear 422 into a 500. */
export async function recordRejection(deploy, record) {
  if (!record) return false;
  try {
    const day = String(record.day || '').slice(0, 10) || 'undated';
    await strong(deploy, 'attempts').setJSON(`${day}:${randomUUID()}`, record);
    return true;
  } catch {
    return false;
  }
}

/* PH-507: one row per Jev shadow-mode call, on a passport the code gate and the
   secret scan already accepted. Same key shape and same never-throw discipline as
   `recordMetrics`/`recordRejection`, for the same reason: this runs after the
   response-shaping work on a successful upload, and a storage hiccup here must
   not turn a 200 into a 500 for something that has no effect on the outcome by
   design.

   Not touched by the bare `sweep()` (_store-expiry.mjs), same as `metrics`/`attempts`/`digest`:
   there is no per-address key to expire, only a day and a score. It IS covered by
   `SCOPED_STORE_NAMES` (_store-scopes.mjs) so a preview scope's full teardown removes it, and
   by `web/tools/run-endpoint-tests.mjs`'s grep of every `strong(deploy, ...)` call
   site, so a rename here fails a test rather than leaking quietly (ROW-226). */
export async function recordJev(deploy, record) {
  if (!record) return false;
  try {
    const day = String(record.day || '').slice(0, 10) || 'undated';
    await strong(deploy, 'jev').setJSON(`${day}:${randomUUID()}`, record);
    return true;
  } catch {
    return false;
  }
}

/* The day both corpora are keyed by, from a millisecond clock. One definition,
   used by the writer and by the reader, because a digest that computes its own
   day slightly differently reports an empty day and looks like a quiet one. */
export const getDay = ms => new Date(ms).toISOString().slice(0, 10);

/* Read one day out of both corpora.

   This is why both stores are keyed `day:uuid`. The prefix is the whole query:
   one listing per store, bounded by the day, touching no other day and reading
   no key that belongs to one. A corpus keyed by uuid alone would have to list
   everything and filter, which gets slower every day it runs and would make the
   digest the most expensive thing on the site by month three.

   A row that fails to parse is dropped rather than thrown, and the count of
   dropped rows is returned rather than swallowed. A digest that silently omits
   corrupt rows reports a smaller day and says nothing; one that refuses outright
   reports nothing at all. Neither is right, so the caller is told. */
export async function readCorpusDay(deploy, day) {
  const prefix = `${day}:`;
  const fetchAll = async (name) => {
    const rows = [];
    let unreadable = 0;
    let blobs = [];
    try {
      ({ blobs } = await strong(deploy, name).list({ prefix }));
    } catch {
      return { rows, unreadable, listed: false };
    }
    for (let i = 0; i < blobs.length; i += 25) {
      const batch = await Promise.all(
        blobs.slice(i, i + 25).map(b =>
          strong(deploy, name).get(b.key, { type: 'json' }).catch(() => null))
      );
      for (const r of batch) { if (r) rows.push(r); else unreadable++; }
    }
    return { rows, unreadable, listed: true };
  };

  const [m, a] = await Promise.all([fetchAll('metrics'), fetchAll('attempts')]);
  return {
    metrics: m.rows,
    attempts: a.rows,
    unreadable: m.unreadable + a.unreadable,
    listed: m.listed && a.listed
  };
}

/* At most one digest per day, whoever asks.

   The digest is reachable at `/.netlify/functions/digest` whether or not it is
   scheduled, and its scheduler-shape check is not authentication — `sweep.mjs`
   says so about the same check. Without this, the moment a recipient is
   configured the endpoint is a button that sends a mail and reads the whole
   day's corpus, as often as a stranger cares to press it.

   This does not authenticate anything. It bounds the blast radius to one mail
   and one corpus read per day, which is exactly what the feature is supposed to
   do anyway, and it makes a scheduler retry idempotent rather than a second
   mail.

   NOT ATOMIC, and it does not need to be. Netlify Blobs has no
   compare-and-swap, so two calls landing inside one listing's lag could both
   claim. The bound then is two mails rather than one, against an unbounded
   number, and the honest description is a speed bump — the same words the rate
   limiter uses about itself.

   Failure claims rather than releases. If the store cannot be reached, this
   returns false and no mail goes out. A digest that silently sends twice on a
   storage hiccup is worse than one that silently skips a day, because the skip
   is visible as a missing mail and the double is visible as nothing at all. */
export async function claimDigestDay(deploy, day) {
  const key = `sent:${String(day).slice(0, 10)}`;
  try {
    const store = strong(deploy, 'digest');
    if (await store.get(key)) return false;
    await store.set(key, '1');
    return true;
  } catch {
    return false;
  }
}

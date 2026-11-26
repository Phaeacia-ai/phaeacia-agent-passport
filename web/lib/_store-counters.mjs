/* _store-counters.mjs

   Per-passport view and copy counters, and the /create page's prompt-copy
   counter. Each counter is its own store and never a field on the passport
   row; the reason is the paragraph below, moved here from the original header
   because this is the module it explains.

   Stores opened here: views, passports, copies, prompt-clicks.

   Exports that _store.mjs does not re-export are internal to the _store-*.mjs family. */

/* Moved verbatim from the original _store.mjs header.

   The view counter is NOT a field on the passport row, and that separation is
   load bearing rather than tidy. It used to be one, incremented by reading the
   row and writing it back. A page load that started before a delete and finished
   after it wrote the whole row back, body and all, and the passport came back
   from the dead on a site that promises deletion is immediate and total. A
   counter in its own store cannot resurrect anything: the worst a late view can
   do is leave an integer behind for a passport that no longer exists. */

import { randomUUID } from 'node:crypto';
import { strong } from './_store-core.mjs';

export async function readViews(deploy, id) {
  try {
    const cur = await strong(deploy, 'views').get(id, { type: 'json' });
    return (cur && cur.n) || 0;
  } catch {
    return 0;
  }
}

/* Writes to the views store only. It can never write a passport body, which is
   the whole point of it being a separate store. A lost increment under a burst
   is acceptable; this is the one number the sharer sees and it is not billing.

   CHECKED AGAINST THE ROW IMMEDIATELY BEFORE THE WRITE, which it was not until
   ROW-140/ROW-88. A page load races a delete over the WHOLE render, not just
   the read at the top: passport.mjs reads the row once, renders the page, and
   only then calls this (three round trips separate the two: the metadata
   check here, then the views get, then the views set — not one). A delete
   landing in that gap has already run purge()'s `views.delete` by the time
   this write happens, and an unconditional write here resurrects exactly the
   row purge() just removed, holding {"n":1} for a passport that no longer
   exists.

   This check narrows the window to metadata-check-then-write; it does not
   close it, which is the honest limit of anything run from the writing side of
   a race. Closing it needs the DELETE side to also reach into `views`, which
   purge() already does; this is defence in depth against the one path purge()
   cannot see coming. A metadata read, not a body read, because this function
   never needed the row's content, only whether the key still exists. It also
   adds one more round trip to every passport page view, on top of the row
   read and the views read/write already there.

   A ROW ALREADY ORPHANED BEFORE THIS CHECK EXISTED is reclaimed by sweep()'s
   own rotating-prefix pass over `views`, not by anything here — see
   VIEWS_SLICES and the block near the end of sweep() (both in _store-expiry.mjs). An earlier version
   of this comment said no bounded reclaim of an already-orphaned row was
   possible, because `views` keys carry no time signal the way every other
   swept store's keys do. That claim was wrong: a critic reviewing this branch
   built a working counterexample by rotating scan()'s existing `prefix`
   argument across runs, which reaches the whole keyspace over many sweeps
   while keeping any single run's read bounded. Recorded rather than quietly
   fixed in place, because getting a load-bearing negative claim wrong and
   correcting it is worth more to the next reader than a comment that reads as
   though this were right the first time. */
export async function bumpViews(deploy, id) {
  try {
    if (!(await strong(deploy, 'passports').getMetadata(id))) return;
    const store = strong(deploy, 'views');
    const cur = await store.get(id, { type: 'json' });
    /* The integer and nothing else. It carried `last`, a wall-clock timestamp
       of the most recent read that no code ever looked at, under a privacy page
       saying this number "records no time". */
    await store.setJSON(id, { n: ((cur && cur.n) || 0) + 1 });
  } catch { /* a lost view count is not worth failing a page render over */ }
}

/* Copies: presses of the copy control on a passport page (GALLERY-SPEC.md
   §7b). The nearest honest thing to an install count, and labelled "copied"
   on every surface, never "installed": nothing in the installer text ever
   phones home. Any live passport counts, listed or not, so a passport listed
   later brings its count with it. Same shape as views, for the same reasons:
   one integer in its own store, never a field on the row, checked against the
   row's existence immediately before the write, deleted by purge() and
   reclaimed by the same rotating sweep if a late bump lands after a delete. */
export async function readCopies(deploy, id) {
  try {
    const cur = await strong(deploy, 'copies').get(id, { type: 'json' });
    return (cur && cur.n) || 0;
  } catch {
    return 0;
  }
}

export async function bumpCopies(deploy, id) {
  try {
    if (!(await strong(deploy, 'passports').getMetadata(id))) return;
    const store = strong(deploy, 'copies');
    const cur = await store.get(id, { type: 'json' });
    await store.setJSON(id, { n: ((cur && cur.n) || 0) + 1 });
  } catch { /* a lost copy count is not worth a failed request */ }
}

/* /create's two capture-path prompts. No passport id and nothing to look
   up: unlike bumpCopies above there is no `passports.getMetadata`
   existence check, because there is no entity whose existence this could
   assert. The one validation that matters — is `path` exactly "f" or "w" —
   lives at the call site (netlify/functions/copied-prompt.mjs), the same
   asymmetry bumpCopies above has with UUID.test: this function trusts the
   caller rather than re-checking, so there is exactly one place a dropped
   check can be mutated away and exactly one place a test has to watch.
   PROMPT_COPY_PATHS is exported so the handler's check and this store's
   key prefixes are read from the same set rather than kept in sync by hand.

   NOT the {n} get-then-increment shape views/copies above use, and that is
   the whole point rather than an oversight. Those key on a passport uuid,
   so contention spreads across however many passports are live; here there
   are exactly two keys in the entire store, so EVERY press of the same
   button in the world contends for the same read-modify-write. A round-1
   critic built the counterexample: 50 simultaneous "f" presses through the
   real handler landed on a FakeStore with a few ms of latency per op and
   the counter read 1, not 50 — 49 lost, and the loss is biased toward
   whichever path is busier, so the number this endpoint exists to produce
   can name the WRONG capture path as more popular. Reproduced independently
   before this was rewritten (2, 5, 20 and 50 concurrent presses of "f" via
   the old get→+1→setJSON shape all read back as 1).

   The fix already lives in this family: `rateLimit` (in _store-ratelimit.mjs)
   never reads before
   it writes, because every attempt gets its OWN key and is counted by
   listing, the same shape `recordMetrics`/`recordRejection` use for a
   corpus that must never lose a row. This store copies that shape: one key
   per press, `${path}:${randomUUID()}`, value irrelevant, counted by
   listing the "f:" and "w:" prefixes. NOT SWEPT, like metrics/attempts and
   for the same reason — there is no identifier in a press to expire and
   nothing to look up. Nothing reads this store outside tests yet (no
   digest, no endpoint); when something does, it should read it the way
   readCorpusDay reads metrics/attempts, not assume a cheap single get. */
export const PROMPT_COPY_PATHS = new Set(['f', 'w']);

/* THROWS rather than swallowing, unlike every other helper in this file —
   deliberately, and only because of what calls it. readPromptCopies below
   wraps BOTH prefixes in one try, so a failure on "w:" alone still fails
   the whole read rather than being caught here and returning a silent 0
   for "w:" beside a real count for "f:". A round-2 critic built that
   counterexample against an earlier version of this function that caught
   its own errors: truth f=40/w=60, only the "w:" listing made to fail,
   and it returned {f:40, w:0} — a wrong comparison, not a visible
   no-data answer, the same class of bug the write-side fix above exists
   to remove. Fail one prefix and this makes both look like they were
   never read, which is the honest state. */
async function countPromptCopyPrefix(store, prefix) {
  let n = 0;
  for await (const page of store.list({ prefix, paginate: true })) {
    n += (page.blobs || []).length;
  }
  return n;
}

/* ONE try around `strong()` AND both prefix reads, not two. `strong()`
   calls `getStore()`, which THROWS SYNCHRONOUSLY on a name the platform
   refuses (see the comment on `strong` in _store-core.mjs) — a second round-2
   counterexample found this function let that throw escape uncaught,
   where bumpPromptCopy already catches the same class of failure. A
   caller of this function that does not expect a rejected promise is
   exactly the caller most likely to be added later without reading this
   comment, so this fails closed to {f:0, w:0} instead. */
export async function readPromptCopies(deploy) {
  try {
    const store = strong(deploy, 'prompt-clicks');
    const [f, w] = await Promise.all(
      [...PROMPT_COPY_PATHS].sort().map(p => countPromptCopyPrefix(store, `${p}:`))
    );
    return { f, w };
  } catch {
    return { f: 0, w: 0 };
  }
}

/* No internal validation of `path` — see the comment above. Called with
   anything outside PROMPT_COPY_PATHS this would write a third, unintended
   key prefix into the store, so the handler's check is load-bearing, not a
   nicety. Fresh randomness in the key, like recordMetrics: nothing here
   joins a press to a request, an address or a session. */
export async function bumpPromptCopy(deploy, path) {
  try {
    const store = strong(deploy, 'prompt-clicks');
    await store.set(`${path}:${randomUUID()}`, '1');
  } catch { /* a lost copy count is not worth a failed request */ }
}

/* The daily digest: one plain-text mail describing a day, built from the two
   corpora and from nothing else.

   Raffael chose a daily mail over a CLI or a dashboard, so this is the only
   surface through which the beta is watched. That makes two things load bearing
   rather than nice.

   FIRST, THE RULE FROM _metrics.mjs FOLLOWS THE DATA HERE. A digest is exactly
   where "just include the agent's title so I can see what it was" feels
   reasonable, and it would break the promise privacy.html makes to whoever
   published it. There is no title in the corpus to include, and this file must
   never become the reason one is added.

   That is enforced rather than asserted. `label()` below passes a string through
   only if it matches the shape of a vocabulary id, an enum or an error code.
   Anything else becomes `(unrecognised)`. So even a corrupt or hand-written row
   cannot put prose into an email: the worst it can do is print a bucket saying
   something was not recognised, which is also the only honest thing to print.

   SECOND, IT IS PURE. No store, no mail, no clock, no environment. It takes two
   arrays of rows and a day and returns a subject and a body. Everything that can
   be wrong with the numbers can therefore be tested without a Netlify runtime,
   which is the difference between a digest that has been checked and one that
   has only ever been looked at. */

export const DIGEST_VERSION = 1;

/* A vocabulary id (`web.fetch`, `money.*`), a spec enum (`read-notify`,
   `scheduled`, `0.1`), or an error code (`E_SCRUB_GATE`). Deliberately a shape
   check rather than a membership check against the vocabulary: this file should
   not have to be edited when v0.2 widens the envelope, and the shape is narrow
   enough that no sentence a person wrote can pass it. A space is the thing prose
   always has and none of these ever do. */
const SAFE = /^(?:[a-z][a-z0-9]*(?:\.[a-z0-9*]+)+|[a-z][a-z0-9_-]*|E_[A-Z0-9_]+|\d+\.\d+)$/;

/* A LENGTH CAP, AND IT IS NOT BELT AND BRACES. It is the only defence that
   covers rows written before the fix upstream.

   `SAFE` matches the SHAPE of an id and a shape has no length. A ref of
   `money.` followed by seventy lowercase letters is a legal capability id under
   spec/vocabulary.md:43, passes `SAFE`, and reads as a sentence. That was a live
   path into this mail: a passport could carry `capability_ref: money.<a sentence
   a stranger chose>`, validate, publish, and have the sentence printed to the
   operator — which turns a stored-text problem into a phishing channel aimed at
   the one person who reads these numbers.

   _metrics.mjs now collapses every money ref to `money.*` so nothing new can
   reach here. That does not help with rows ALREADY IN THE STORE, and this
   corpus is deliberately never swept, so anything written before the fix is
   permanent and this function will read it every day forever.

   32 is generous by a wide margin: the longest real vocabulary id is
   `calendar.read` at 13 and the longest error code is `E_SEND_PASSPORT_LIMIT`
   at 21. Nothing legitimate is near it and nothing readable fits under it. */
const MAX_LABEL = 32;

/* Money refs are collapsed HERE TOO, not only in _metrics.mjs where they are
   written. A cap alone does not close it: `money.callus18005551212now` is 26
   characters, passes a 32-character cap, and still reads as an instruction.
   Since `money.` admits anything by design, the only safe rendering of any ref
   under it is the prefix itself, whatever its length.

   Doing it at read time as well as write time is what covers the rows already
   in the store. That corpus is never swept, so anything written before the
   write-side fix is permanent and this function reads it every day forever. */
/* EXPORTED so tools/metrics.mjs applies the identical rule. It was private
   while the digest was the only reader of this corpus; it is not any more, and
   two readers of the same rows sanitising differently is how one of them ends
   up being the soft one. */
export const label = v => {
  if (typeof v !== 'string') return '(unrecognised)';
  if (v.startsWith('money.')) return 'money.*';
  return v.length <= MAX_LABEL && SAFE.test(v) ? v : '(unrecognised)';
};

const pad = (n, w) => String(n).padStart(w);

/* Counted highest first, then alphabetically, so two runs of the same numbers
   print identically and a diff between two days is readable. */
function tally(rows, pick) {
  const t = new Map();
  for (const r of rows) {
    for (const v of [].concat(pick(r) ?? [])) {
      if (v === undefined || v === null) continue;
      const k = label(v);
      t.set(k, (t.get(k) || 0) + 1);
    }
  }
  return [...t.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const mean = (rows, pick) =>
  rows.length ? (rows.reduce((s, r) => s + (Number(pick(r)) || 0), 0) / rows.length).toFixed(1) : '0.0';

/* The gate is a designed two-step: refused once, ticket issued, retried. A
   passport that publishes on the retry leaves a row in BOTH corpora, so the
   naive total counts one upload twice. The digest says so where the number is
   rather than in a footnote, because the footnote is the part nobody reads.

   THE OVER-COUNT IS COUNTED, NOT ESTIMATED, and it took establishing rather
   than assuming. Raffael chose a single `attempted` figure with its error
   stated, over a range. A stated error that is itself a guess is worse than the
   range it replaced, so this had to be exact before the format could change.

   It is exact, by this chain:

   - A publish whose record says `owner_confirmed: false` can only have happened
     by presenting a valid ack (`upload.mjs`, the owner review gate).
   - `readAck` (_store.mjs) accepts only a ticket THIS SITE minted, matched to
     the file's fingerprint; `burnAck` deletes it on use, once the publish it
     gates has actually happened (ROW-128 split the one function that used to
     do both, because deleting the ticket ahead of a publish that then failed
     spent a one-shot claim on a success that never happened).
   - A ticket is minted in exactly one place: the refusal, which is also where
     the E_OWNER_UNCONFIRMED row is written.

   So every gated publish is downstream of exactly one gate refusal, and
   `gatedPublishes` counts them directly. No join between the corpora is needed
   or exists.

   `min` with the refusal count, and it is not defensive padding. Somebody who
   retries WITHOUT the ack is refused again: two refusals, one publish. The
   second refusal is not the design inflating the number, it is a genuine extra
   bounce, so only one is subtracted. `min` also makes it impossible to subtract
   more refusals than were counted, which would print a total below the truth.

   THE ONE RESIDUAL INACCURACY, stated because a number claiming exactness has
   to name its edge: a session that is refused before midnight UTC and publishes
   after it puts its two rows in two different days. Each day is then internally
   correct and self-consistent, and only a sum ACROSS days double counts, by one
   per straddling session. Both stores key by UTC date and so does the handler,
   so the two halves never disagree about which day they are in.

   A SECOND INACCURACY, added 2026-09-08 and NOT counted the way the one above
   is: ROW-228's combined write-consent gate writes one `attempts` row per
   entry in the endpoint's `refusals[]`, not one per POST (spec §8c; see
   upload.mjs's own note beside `recordRejection`). One browser passport that
   trips both the owner-review and write-consent gates on the same POST is one
   bounce and two rows, so `refused` and `attempted` both over-count it by one,
   silently — nothing below subtracts it, unlike the owner-review retry case
   `over` exists for. The two inaccuracies are NOT the same shape: `over`
   corrects a refusal matched to a LATER publish by the same session, which
   this corpus can prove from `owner_confirmed: false`; this one would need to
   tell "two rows, one POST" from "two separate POSTs, one E_OWNER_UNCONFIRMED
   and one E_WRITE_UNCONFIRMED", which no row here carries evidence for —
   an exact correction, matching this file's own bar, needs a schema field
   this delta did not add. Until it does, `refused`/`attempted` runs slightly
   high on any day a combined refusal happened, and this paragraph is the
   disclosure the header comment above promised for a stated number's edge. */
export const GATE = 'E_OWNER_UNCONFIRMED';

export function digestReport({ day, metrics = [], attempts = [], listed = true, unreadable = 0 }) {
  const safeDay = (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)) ? day : '(undated)';
  const published = metrics.length;
  const refused = attempts.length;
  const gatedRefusals = attempts.filter(r => r && r.code === GATE).length;
  const gatedPublishes = metrics.filter(r => r && r.owner_confirmed === false).length;
  const over = Math.min(gatedRefusals, gatedPublishes);
  const ours = attempts.filter(r => r && r.code === 'E_INTERNAL').length;

  const out = [];
  const line = s => out.push(s);
  const section = t => { line(''); line(t); line('─'.repeat(t.length)); };
  const rows = pairs => pairs.forEach(([k, c]) => line(`  ${pad(c, 4)}  ${k}`));

  /* `day` IS GATED, and the first version of this line only looked like it was:
     `label(day) === '(unrecognised)' ? day : day` has the same expression in
     both branches, so it was a no-op that read as a guard. A critic deleted the
     whole ternary and both suites stayed green.

     Nothing reaches it today, because the handler builds `day` from `getDay`.
     That is the same "it holds because of who happens to call it" defect this
     repository already spends eleven lines warning about in _metrics.mjs, about
     this exact field. `day` also reaches the SUBJECT, which was ungated
     entirely, and a subject line is the part that travels. */
  line(`Agent Passport — ${safeDay}`);
  line('');
  line(`  published        ${pad(published, 4)}`);
  line(`  refused          ${pad(refused, 4)}`);

  /* Stated as a range rather than a number, because the exact figure is not
     recoverable and printing one would be a fabrication. Nothing joins a
     refusal to a later publish, deliberately, so a gated attempt that then
     published is indistinguishable from one that gave up. */
  /* "attempted", never "people". One person can upload five times, and this
     corpus cannot tell that from five people uploading once: nothing in a row
     identifies anybody, which is the design and not a gap. A digest that said
     "people" would be inventing a number the record refuses to hold, in the one
     document where the number gets read and repeated. */
  line(`  attempted        ${pad(published + refused, 4)}`);

  /* The caveat fires only when the over-count actually happened. A warning
     printed on a clean day is a warning that gets skipped on a dirty one, and
     this line now carries the whole honesty burden that the range carried by
     construction. */
  if (over) {
    line('');
    line(`  Over-counts by ${over}: the owner-review gate refuses`);
    line('  once by design, then accepts on retry.');
  }

  if (published || refused) {
    line('');
    line('  Uploads, not people. Nothing here can tell one person uploading five');
    line('  times from five people uploading once.');
  }

  /* AN UNREACHABLE STORE IS NOT A QUIET DAY, and telling them apart is the whole
     reason readCorpusDay returns `listed`. Zero rows because nobody uploaded and
     zero rows because the store did not answer are the same two numbers and
     opposite news. */
  if (!listed) {
    line('');
    line('One or both stores could not be listed, so these numbers are incomplete');
    line('and the zeroes above mean nothing. This is a failure to read, not a');
    line('quiet day. Check the function log for the store error.');
    return {
      subject: `Agent Passport ${safeDay}: INCOMPLETE, a store could not be read`,
      text: out.join('\n') + '\n'
    };
  }

  if (unreadable) {
    line('');
    line(`  ${unreadable} row${unreadable === 1 ? '' : 's'} could not be parsed and ${unreadable === 1 ? 'is' : 'are'} missing from`);
    line('  everything below. The counts above already exclude them.');
  }

  if (!published && !refused) {
    line('');
    line('Nothing was uploaded on this day. Not an error: no rows exist for it in');
    line('either store, and both were read successfully.');
    return { subject: `Agent Passport ${safeDay}: nothing uploaded`, text: out.join('\n') + '\n' };
  }

  if (refused) {
    section('Why uploads were refused');
    rows(tally(attempts, r => r.code));
    line('');
    line('  Refusals past the rate limit are not counted here; the limiter counts');
    line('  those and its records expire. So this understates a bad day.');

    /* E_INTERNAL IS OURS, NOT THEIRS, and listing it unqualified beside user
       errors makes an outage read as a day of bad uploads. It is the one code
       in the table that means the site failed rather than the file did, and it
       is the one worth waking up for. */
    if (ours) {
      line('');
      line(`  ${ours} of those ${ours === 1 ? 'is' : 'are'} E_INTERNAL, which is our fault and not`);
      line('  theirs: the upload was well formed and the site failed to store it.');
    }
  }

  if (published) {
    section('What the published agents need');
    rows(tally(metrics, r => r.refs));

    const outside = tally(metrics, r => r.refs_outside_envelope);
    section('Declared but not installable here');
    if (outside.length) rows(outside);
    else line('  none. Every agent fits the read-and-notify envelope.');

    section('How they run');
    rows(tally(metrics, r => r.trigger));

    section('Where they were captured');
    rows(tally(metrics, r => r.capture_path));

    section('Owner review');
    rows(tally(metrics, r => (r.owner_confirmed ? 'confirmed' : 'not-confirmed')));
    rows(tally(metrics, r => (r.scrub_reviewed ? 'scrub-reviewed' : 'scrub-not-reviewed')));

    section('Shape, mean per passport');
    line(`  inputs           ${mean(metrics, r => r.inputs)}`);
    line(`  personal slots   ${mean(metrics, r => r.slots)}`);
    line(`  checks           ${mean(metrics, r => r.checks)}`);
    line(`  golden examples  ${mean(metrics, r => r.goldens)}`);
    line(`  consent rows     ${mean(metrics, r => r.consent && r.consent.rows)}`);
    line(`  of those, required ${mean(metrics, r => r.consent && r.consent.required)}`);
  }

  line('');
  line('This mail carries counts, capability ids and error codes. It carries no');
  line('title, no description, no agent name and no address, because none of');
  line('that is in the record it is built from.');

  /* THE SUBJECT IS THE ONLY LINE THAT TRAVELS. It gets forwarded, screenshotted
     and read off a lock screen, and the body's careful paragraph does not go
     with it. "5 published, 7 refused" reads as a 58% failure rate to anybody
     skimming, and on a gate-heavy day most of those refusals are the design
     working exactly as intended. Qualify it here or the qualification does not
     exist where it is read. */
  const gateNote = over ? `, incl. ${over} owner-gate` : '';
  const subject = `Agent Passport ${safeDay}: ${published} published, ${refused} refused${gateNote}`;
  return { subject, text: out.join('\n') + '\n' };
}

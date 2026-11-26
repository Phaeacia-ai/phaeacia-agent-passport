/* POST /api/upload — the five stages of site/spec/upload-validation.md.

   No PASSPORT ROW is written before stage 5. There is no draft state and no
   partial acceptance: the endpoint rejects rather than repairs, and there is
   no auto-correction anywhere in this file.

   THIS COMMENT HAS NOW BEEN WRONG TWICE, AND BOTH VERSIONS ARE KEPT BECAUSE
   EACH IS WHAT SOME EARLIER READER REASONED FROM.

   It first said "Nothing is written before stage 5", which was false of four
   things, one of which caused ROW-128.

   It then said "no temporary passport and no orphan blob", which a critic
   showed is also false. `createPassport` writes the EXPIRY INDEX KEY before
   the row, deliberately and with its own argument at lib/_store.mjs: an index
   entry with no row is harmless because the sweeper drops it, while a row with
   no index entry can never be deleted. So a failed publish DOES leave an
   orphan blob, by design, and the new test in run-tests.mjs creates one every
   time it runs. The sentence narrowed "Nothing" to "No PASSPORT" to fix one
   false clause and left a false clause beside it, in the same paragraph, about
   the same failure.

   SIX THINGS ARE WRITTEN BEFORE THE PASSPORT, not five. The fifth was found
   by a critic reading this list against the code rather than reading the list;
   the sixth is PH-507's Jev record, added when the check moved from after
   `createPassport` (shadow mode) to before it (the gate). All of them
   deliberate, each with its reason where it is written:

     1. RATE LIMITER COUNTERS — `up-h` and `up-d` at the top of the handler, and
        `bad-h` on every refusal EXCEPT ONE. A limiter that only counted
        requests it approved would not be a limiter. `refundLimit` DELETES one
        of these, and a delete is a write; it is named here because the word
        "counters" reads as though only increments happen. THE EXCEPTION is
        PH-507's Jev refusal, found by a gate-code critic reading this very
        sentence against the code it now contradicts: every refusal above it
        refunds `up-h`/`up-d` into `bad-h` via `chargeAsFailure()`, but a Jev
        refusal already cost a real network call with the full passport text,
        so refunding it too would have let one IP trigger far more such calls
        per hour than the 5 a legitimate publisher gets (measured: 35 before
        the fix). The Jev refusal spends its `up-h`/`up-d` charge permanently
        instead, which is also the one place on this path where a refusal
        costs the same real budget a success would have.
     2. REJECTION ROWS — one per refusal, so the uploads that did NOT publish
        are countable. See the block below on what is deliberately not counted.
     3. THE ACK TICKET — minted when an unconfirmed passport is refused, because
        the ticket IS the refusal's receipt.
     4. THE METRICS ROW — written immediately before `createPassport`, on
        purpose. The comment there is the argument: a row describing a passport
        that failed to store is a countable inaccuracy, while a row written
        after the response may never be written at all.
     5. THE JEV LOG RECORD — written right after the Jev call, before the gate
        even decides whether to act on it, unconditionally of `JEV_DISPOSITION`.
        Holds only scores, an outcome enum, and a model string, never passport
        content (see `_jev.mjs`'s own comment on that). Same argument as the
        metrics row: written before the write it might refuse, so the
        shadow-mode corpus keeps collecting on every call, including the ones
        this same check goes on to refuse.

     6. NOTHING ELSE. Two things used to be on this list and are not any more,
        and they are the same defect twice:

        THE FINGERPRINT, which is ROW-128. Claimed before the passport existed,
        so a storage failure at publish locked the same file out for up to an
        hour behind a 409 saying "use the link you already have". Now claimed
        after `createPassport` succeeds.

        THE ACK TICKET'S CONSUMPTION, which is the same shape and was missed by
        the first version of this very comment. `consumeAck` read the ticket AND
        deleted it, ahead of the publish. A publish that then failed spent the
        ticket: the retry was refused E_OWNER_UNCONFIRMED again, paid the
        failure ceiling again, and got a fresh ticket, so the sharer bought a
        third round trip for a success that never happened. It is `readAck`
        before and `burnAck` after now. Milder than ROW-128 and structurally
        identical, which is why finding it in a comment claiming completeness
        is the useful part.

   THE PATTERN IN ALL OF THEM: what is written before the passport is either
   accounting that must count failures, or a receipt for a refusal. Nothing
   written before stage 5 may be a CLAIM ON A FUTURE SUCCESS, because the
   success may not happen and the claim outlives it.

   ONE MORE WRITE SITS INSIDE STAGE 5 SINCE THE GALLERY, not before it: when
   the upload carries the list header, createPassport writes the gallery
   CARD before the row, the same order and the same argument as the expiry
   index. A card with no row is repaired by the listing page, which skips
   and deletes it; a listed row with no card is a passport its owner was told
   is in the gallery and is not, which nothing on a request path would ever
   notice. It is not a claim on a future success in the sense above, because
   it does not outlive the failure: the next render of /gallery removes it.

   AND THE RULE HAS A COST THAT IS NOT FREE, stated because the comment forty
   lines below states the opposite rule and this file should not pretend they
   agree. The sweep comment says: "If anything ever needs to run on this path
   again, it goes HERE, ahead of the write", because a request killed between
   `createPassport` and the response loses a delete token that exists nowhere
   else, and that was reproduced with a client abort at 150 ms. Both one-shot
   claims now run after the write, which is the position that comment forbids.

   The two rules cannot both be satisfied. A claim that the passport exists is
   only true after it exists, so no correct version of it can run ahead of the
   write. This file takes the ordering rule and pays the latency: roughly one
   store round trip, on a path whose measured worst case was 5290 ms against a
   ceiling around 10 s BEFORE PH-507's gate. A gate-code critic pointed out
   that number is now stale rather than wrong: the Jev call sits ahead of
   `createPassport` with its own ~2000 ms budget (`_jev.mjs`'s `TIMEOUT_MS`),
   so the worst case in front of the write sequence is now roughly 7290 ms
   against the same ~10 s ceiling -- headroom cut from about 4710 ms to about
   2710 ms, a real reduction quantified here rather than reproduced as an
   actual timeout (nothing in this repo can drive a real Netlify deadline).
   Both writes swallow their own failure, which answers throwing and does NOT
   answer timing out, and the sweep comment was about timing out. Named rather
   than resolved, because pretending it is resolved is how the next person
   deletes one of the two rules.

   WHAT A LOST CLAIM COSTS, corrected. An earlier version of this reasoning said
   a claim lost to a timeout "costs the same mild thing" as the widened race:
   two links to one passport. That is wrong. If the function dies after
   `createPassport` and before the claim, the passport exists, its delete token
   was in a response that never arrived, and the sharer saw a failure. Before
   ROW-128 the claim was already written, so the retry hit 409 and no second
   passport was made. Now the retry publishes. Under the exact condition this
   fix exists for — a store slow enough to time out repeatedly — EACH retry
   mints another passport that is public, undeletable and unrenewable for
   thirty days. The old order was accidentally capping that at one per file per
   hour and this removes the cap.

   It is still the right trade, because that accidental cap is also what
   produced the hour-long lockout in the far commoner throw-fast case, which is
   the actual ROW-128. But it is a different and larger cost than "two links",
   and the sentence that said otherwise is the sentence somebody would have
   reasoned from later. */

import { transport, validate, err, isDeclaredOnly } from '../../lib/_validate.mjs';
import { isCategory } from '../../lib/_categories.mjs';
import { CANONICAL } from '../../lib/_site.mjs';
import { derive } from '../../lib/_derive.mjs';
import { metricsRecord, rejectionRecord } from '../../lib/_metrics.mjs';
import {
  shadowCheck, secretCheck, secretCandidates, jevLogRecord, jevDisposition, jevFlagged, secretDisposition, secretFlagged,
  JEV_DISPOSITIONS, holdAlertTo
} from '../../lib/_jev.mjs';
import {
  clientIp, rateLimit, refundLimit, seenRecently, claimFingerprint, sha256,
  createPassport, createHold, mintAck, readAck, burnAck, recordMetrics, recordRejection,
  recordJev, TTL_DAYS, HOLD_TTL_DAYS, HOLD_MAIL_TIMEOUT_MS
} from '../../lib/_store.mjs';
import { sendMail, holdAlertMessage } from '../../lib/_email.mjs';
import { crossSite } from '../../lib/_origin.mjs';
import { archiveMode, archivedResponse, UPLOAD_CLOSED_MESSAGE } from '../../lib/_archive.mjs';

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

/* One failure, in the documented shape. */
const fail = (status, e) => json(status, { ok: false, ...e });

/* Several failures. Stages 2 and 3 collect, so a passport with four problems is
   fixed in one pass rather than four round trips. The first error is mirrored at
   the top level so a client reading the single-error shape still works. */
const failMany = (errors) => json(422, { ok: false, ...errors[0], errors });

/* ROW-228's write-consent gate payload: two lists, not a pairing, per
   record/proposals/where-the-owners-yes-no-on-a-declared-only-write-row-lives.md
   and record/proposals/row-228-refusal-code-and-payload-shape.md.

   `capability_markers`: one entry per declared-only id in `d.blockRefs`
   (`capabilityBlockRefs()`, anchored, block-scoped, NOT entry-paired), for
   its literal ref and status line text looked up in `d.capabilityEntries`
   (`capabilityBlockEntries()`, entry-paired, best effort). **Corrected
   2026-09-08, spec §8c (upload-gate-spec, `5d3e8b3`): scoped to the block,
   not to `d.declaredOnlyRefs`'s wide section-3 scan.** An id that appears
   only on an `inputs:` entry is explicitly not a marker for this gate — an
   input entry carries no `status`, the gate reads the passport's own
   statements about capabilities. The first memo said "inputs included";
   the spec follows the proposal instead, and this file now follows the
   spec.

   **Corrected again, same day: the id list itself must come from
   `d.blockRefs`, not from `d.capabilityEntries`.** A critic on this exact
   branch built the case: `capabilityBlockEntries()` pairs a ref with a
   status per ENTRY and is unanchored on purpose, for parity with
   tools/validate.py check 16a (see that function's own comment) — so it is
   last-match-wins WITHIN an entry, and an honest `capability_ref:
   email.send` entry whose own `tacit_notes` field happens to mention a
   different id mid-line (`tacit_notes: "the old config had capability_ref:
   msg.send..."`) gets attributed to msg.send instead. Before this fix that
   only cost a line lookup (the id source was `d.declaredOnlyRefs`, correct
   but too wide per the first correction above); sourcing ids from
   `capabilityEntries` too would have shown the owner a fabricated id with
   real-looking lines to delete, and deleting them breaks the honest entry
   it actually belongs to. `d.blockRefs` cannot misattribute — it is
   anchored, so a mid-line mention never sets it — but it also cannot pair a
   ref with lines, which is why the line lookup below still goes through
   `capabilityEntries` and degrades to an empty `lines` array when that
   walk's entry-pairing missed or misattributed the entry. An empty list is
   the honest admission "this id is real, this file cannot show you where it
   is written"; a wrong id is not.

   THE INPUT-ONLY ID IS NOT ALWAYS NAMED SOMEWHERE ELSE. `E_DERIVE_ENVELOPE_INPUT`
   only fires when `derive()`'s own arithmetic check fires, which requires
   NO non-installable consent row to exist. When one does — the shape this
   gate exists for, a `capture_path: browser` passport with a genuine "no,
   declared only" row — the floor is satisfied and never runs, so an
   input-only id sits unmentioned by both the floor and this gate's markers;
   this gate still fires (from the row), but names nobody the input-only id.
   A critic on this exact branch caught an earlier version of this comment
   claiming unconditional coverage.

   `consent_rows`: one entry per section 2 row whose Installable column
   starts with `no`, as its raw table-row text (`d.consentRowsRaw`, same
   index as `d.record.needs`, added in _derive.mjs for exactly this — kept
   OUT of `needs[]` itself because that shape is what tools/run_tests.sh's
   parity harness compares field for field against scripts/passport-to-page.py's
   twin parser, and a field only one side carried was exactly the
   disagreement that harness caught the first time this was written straight
   onto `needs[]`).

   Neither list is money-collapsed through safeRefLabel/safeCellEcho, unlike
   every other message in lib/_validate.mjs: this response is never logged
   (recordRejection stores only {day, code}) and reaches nobody but the
   browser that uploaded these bytes, so echoing an owner's own money id back
   to her is not the leak those two helpers exist to prevent. */
function writeMarkers(d) {
  /* EVERY entry for a ref, not just one: a Map keyed by ref and built
     last-wins reported one pair of lines when a passport carried the same
     declared-only ref twice in the capabilities: block (a legal passport —
     validate() accepts a repeated capability_ref), so the owner who deleted
     exactly what she was shown left the other pair standing and the gate
     refused her again for a line it had never shown her. Found by the
     critic on the first draft, confirmed against validate()/derive() before
     fixing (record/proposals/row-228-refusal-code-and-payload-shape.md's
     defect log, if this lands there). Best-effort only, per the header
     comment above: a ref key here can still be absent, or (pre-existing,
     not closed by this file) attached to the wrong entry. */
  const byRef = new Map();
  for (const e of d.capabilityEntries) {
    if (!byRef.has(e.ref)) byRef.set(e.ref, []);
    byRef.get(e.ref).push(e);
  }
  const capability_markers = [...d.blockRefs].filter(isDeclaredOnly).map(id => {
    const entries = byRef.get(id) || [];
    const lines = entries.flatMap(e => [e.refLine, e.statusLine].filter(l => l !== null));
    return { id, lines };
  });
  const consent_rows = d.record.needs
    .map((n, i) => ({ n, raw: d.consentRowsRaw[i] }))
    .filter(({ n }) => !n.installable)
    .map(({ raw }) => ({ line: raw }));
  return { capability_markers, consent_rows };
}

/* ── counting the uploads that did NOT publish ─────────────────────────────
   Every refusal below goes through one of these two, so the set of codes that
   reaches the corpus is readable in one place rather than inferred from eight
   return statements. `refuse` is `fail` plus a row; `refuseMany` is `failMany`
   plus a row for the FIRST error only, because that is the one the client is
   shown at the top level and one attempt should be one row. A passport with four
   validation problems is one person bouncing once, not four.

   THE ROW-228 COMBINED GATE IS THE ONE EXCEPTION TO "ONE ATTEMPT, ONE ROW",
   named here because a critic caught the sentence above stated as if it had
   none. Per spec §8c, that path calls `recordRejection` once per entry in
   `refusals[]`, not once per POST — one POST tripping both the owner-review
   and write-consent gates writes TWO rows. This is deliberate (the write
   gate must not be invisible in the corpus whenever owner-review fires
   first, which it always does) and it is also a REAL, currently
   undercorrected inflation of `_digest.mjs`'s `refused`/`attempted` counts:
   that file's existing `over` correction only accounts for the
   owner-review refuse-then-retry double count (one refusal row plus one
   later publish row for the SAME person), not for two refusal rows from
   ONE bounce. Flagged to HAL 2026-09-08 rather than fixed here: an exact
   correction needs a way to tell "two rows, one POST" from "two rows, two
   POSTs", which the corpus does not carry and adding costs a schema
   version bump this delta did not budget for. See _digest.mjs's own note
   beside `refused`/`attempted` for the honest current state of the number.

   WHAT IS DELIBERATELY NOT COUNTED, and both exclusions change what the number
   means, so they are stated here rather than discovered later by whoever reads
   the report:

   - `E_METHOD`. A GET or HEAD to /api/upload is a link preview fetcher or a
     monitor, not somebody trying to publish. Counting it would put crawler
     traffic in a corpus whose whole purpose is "what did a person try".
   - `E_CROSS_SITE`. A publish that a page on another site sent from its
     visitor's browser is not that visitor trying to publish either. It is
     refused ahead of the limiter, so a row for it would be a write per request
     that no ceiling ever stops.
   - `E_RATE_LIMIT`. Excluded, and the first version of this comment gave the
     wrong reason. It said recording past the ceiling is an unbounded write. That
     argument does not survive contact with the limiter: `rateLimit` writes a
     fresh key BEFORE it counts (_store.mjs:186-192) and the 429 below returns
     after that write, so this endpoint already performs an unbounded write one
     line above the point where I declined to perform one. The reason cannot be
     unboundedness, because unboundedness is already there.

     The real reason is LIFETIME. Limiter keys are swept — `sweepStale` scans the
     `ratelimit` store and drops dead buckets (_store.mjs:918-927) — so a
     refusal's trace expires with its window, and privacy.html:143-147 says
     exactly that and is accurate. This corpus is deliberately never swept. So
     recording a rate-limited request would convert a trace that expires into one
     that does not, which is a different and larger promise than the one the site
     currently makes.

     The honest consequence is unchanged: "attempts that bounced" excludes
     anybody who bounced off the ceiling itself.

   So the count is refusals that got as far as being looked at.

   AWAITED, NOT FIRE AND FORGET, and this is the one line in here that is easy to
   get wrong. Writing `recordRejection(...)` without awaiting and returning the
   Response immediately reads like a free optimisation: the caller does not wait
   for a statistic. It is not free, it is a silent loss. A serverless function
   that has returned its response may be frozen or torn down before a pending
   promise ever runs, which is the same reasoning written at the sweep's grave
   further down this file. An unawaited row is a row that lands sometimes, and a
   corpus that drops rows in exactly the conditions the function is slowest under
   is worse than no corpus, because nothing in it says which ones are missing.

   It costs the refusal one store operation, measured at a median of 310 ms
   against production. That is spent on a path where nothing irreplaceable is in
   flight: a refusal carries no delete token, and the caller is going to fix
   their file and come back. It is NOT spent on the publish path, where it would
   be.

   ONE SITE WHERE THAT IS NOT QUITE FREE, and the blanket sentence above does not
   cover it. The E_INTERNAL return sits inside the catch around `createPassport`,
   so it adds a blob write to a request that is already there BECAUSE a blob
   write failed. `recordRejection` swallows the error but not the latency, and if
   the storage layer is failing by timing out rather than by throwing fast, this
   is another round trip on a request near its deadline.

   Kept anyway, deliberately. A cluster of E_INTERNAL is the one thing in this
   corpus that means the fault is ours: an outage nobody reported, in a beta with
   no monitoring. Dropping it to save a round trip on an already-failed request
   would lose the only signal that says "this was not the uploader's fault". The
   response carries no delete token, so the worst case is a slower 500. */
const today = () => new Date().toISOString().slice(0, 10);

async function refuse(deploy, status, e) {
  await recordRejection(deploy, rejectionRecord({ day: today(), code: e.code }));
  return fail(status, e);
}
async function refuseMany(deploy, errors) {
  await recordRejection(deploy, rejectionRecord({ day: today(), code: errors[0].code }));
  return failMany(errors);
}

export default async (req, context) => {
  if (req.method !== 'POST') return fail(405, err('E_METHOD'));

  /* Archive mode (lib/_archive.mjs): 410 and code `archived`, before the
     limiter and before the body is read, so a refused upload writes nothing.
     The capture skill's publish.py keys on the 410. */
  if (archiveMode()) return archivedResponse(UPLOAD_CLOSED_MESSAGE);

  /* A publish that a page on another site sent from its visitor's browser.
     Refused before the limiter, so it spends none of that visitor's five, and
     before the body is read; not counted, for the reason in the list above.
     scripts/publish.py sends no Origin and passes. lib/_origin.mjs has the
     rule. */
  if (crossSite(req)) return fail(403, err('E_CROSS_SITE'));

  /* ROW-37: which store this request touches. See _store.mjs's "deploy
     scoping" section. This is the sharpest instance in the whole system: a
     preview publish must land in a preview-scoped `passports` store, not the
     production one, or a stranger poking a deploy preview writes a live,
     public, undeletable-by-anyone-but-them row into production. */
  const deploy = context && context.deploy;

  const ip = clientIp(req);

  /* §3's two ceilings, and why only one of them is a gate.

     The failure ceiling used to be checked here, before the work. That turned
     out to lock people out rather than protect anything: once an address spent
     30 failures it could not publish AT ALL for the rest of the hour, so on a
     shared office egress one person's malformed file locked out everybody, and
     the comment claiming "somebody fixing a malformed passport is not spending
     their publishes on it" became exactly backwards at the thirtieth fix.

     It is not needed as a gate. up-h is charged up front and bounds everything
     to 5 an hour by itself. A refusal MOVES that attempt to bad-h, and when
     bad-h is full the move fails and the attempt stays on up-h. So the ceiling
     on full validator runs per hour is 30 moved plus 5 that could not move, and
     a publisher always has their five whatever anybody else on their network
     has been doing.

     35 rather than 30, and nobody locked out. Both windows are fixed rather
     than rolling, so a boundary allows a second set immediately; §3 says so. */
  const hourTicket = await rateLimit(deploy, ip, 'up-h', 5, 3600e3);
  const dayTicket = hourTicket ? await rateLimit(deploy, ip, 'up-d', 20, 86400e3) : null;
  if (!hourTicket || !dayTicket) {
    /* The daily ceiling refusing does not entitle the hourly one to keep the
       attempt it just charged for. This refund is on a path the SERVER chose,
       which is the only kind of refund that is safe: see refundLimit. */
    if (hourTicket && !dayTicket) await refundLimit(deploy, hourTicket);
    return fail(429, err('E_RATE_LIMIT'));
  }

  const buffer = new Uint8Array(await req.arrayBuffer());

  /* A refusal moves its attempt from the publish ceiling to the failure
     ceiling. Both halves matter: refunding without charging is what made the
     owner-review gate a free-validation service twice over, and charging
     without refunding is what made bad-h unreachable. See refundLimit. */
  const chargeAsFailure = async () => {
    const charged = await rateLimit(deploy, ip, 'bad-h', 30, 3600e3);
    /* Only if the charge actually landed. If the failure ceiling is full or the
       store refuses the write, the attempt stays where it is rather than being
       refunded into nothing, which is the rule in refundLimit and the one this
       endpoint has now broken twice. */
    if (charged) await Promise.all([refundLimit(deploy, hourTicket), refundLimit(deploy, dayTicket)]);
  };

  /* stage 1, fail fast */
  const t = transport(buffer, req.headers.get('content-type'));
  if (t.error) {
    await chargeAsFailure();
    const status = t.error.code === 'E_TOO_LARGE' ? 413
                 : t.error.code === 'E_CONTENT_TYPE' ? 415 : 422;
    return refuse(deploy, status, t.error);
  }
  const text = t.text;

  /* stages 2 and 3, collecting */
  const v = validate(text);
  if (v.errors.length) {
    await chargeAsFailure();
    return refuseMany(deploy, v.errors);
  }

  /* stage 4, fail fast. If any field cannot be derived, nothing is stored. */
  const d = derive(v.front, v.lines);
  if (d.error) {
    await chargeAsFailure();
    return refuse(deploy, 422, d.error);
  }

  const fingerprint = sha256(text);

  /* ── the listing headers (GALLERY-SPEC.md §3) ───────────────
     Two request headers on the same POST, matching the X-Passport-Owner-Ack
     pattern; transport() reads only content-type, so they pass untouched.
     `X-Passport-List` PRESENT means the owner ticked the box; its value is
     not read. `X-Passport-Category` must then be one of the slugs in
     lib/_categories.mjs, or the upload is refused 422 E_CATEGORY, charged as
     a failure and counted in the rejection corpus like any other refusal.
     Refused rather than published unlisted: an owner who ticked the box and
     was told "published" would believe the passport is in the gallery.

     Checked here, after stage 4 and before the owner-review gate, so an
     unreviewed passport that is also mis-categorised is told about the
     category first and pays one refusal for it, and so the headers are read
     on the retry too: share.js re-enters publish(ticket) after a 409 and
     must resend both, which the endpoint test named "unreviewed and listed"
     pins. */
  const wantsList = req.headers.get('x-passport-list') !== null;
  const category = req.headers.get('x-passport-category');
  if (wantsList && !isCategory(category)) {
    await chargeAsFailure();
    return refuse(deploy, 422, err('E_CATEGORY'));
  }

  /* ── the owner-review gate, and ROW-228's write-consent gate ─
     Two gates, evaluated together and refused together, per HAL's ruling on
     path-w-ruling-2026-09-08-evening: a browser passport that trips both on
     the same POST gets one 409 with two problems, not two round trips. Each
     is still its own gate with its own ticket and its own reason — see
     lib/_store.mjs's comment on mintAck/readAck — so a client can also trip
     only one and see only one problem.

     THE OWNER-REVIEW GATE. A passport whose frontmatter says owner_confirmed:
     false is well formed and may be published. It just has not been read by
     the person it is about, so the endpoint refuses it once and says why.

     This took two goes to get right and both failures are worth keeping.
     First it took a fixed header string, `unconfirmed`, which any client
     could send on its first request. That made "unskippable" untrue, and
     because the refusal refunded both limiter attempts, it also made this
     endpoint a free full-validation service: sixteen 256 KB bodies against a
     ceiling of five. Then the refusal minted a server ticket carrying the
     attempts to refund on consume. That closed the unbounded hole but not the
     arithmetic: alternating refuse and retry still bought two full
     validations per recorded attempt, because the refusal itself still cost
     nothing. Now the refusal is priced like every other refusal — the
     attempt moves to the failure ceiling — and the ticket carries nothing at
     all. It is proof that this request is downstream of a refusal we issued,
     and it buys the right to publish rather than a discount on it. What this
     still does not do is verify that a person read the paragraph. No
     stateless endpoint can. What it enforces is that the exchange happened,
     and the passport page prints "Did not confirm this description"
     regardless.

     THE WRITE-CONSENT GATE (ROW-228). A `capture_path: browser` passport
     carrying a declared-only write marker in either place the format can
     carry one — a declared-only id in `d.blockRefs` (`capabilityBlockRefs()`,
     anchored and block-scoped, **not** `d.declaredOnlyRefs`'s wide
     section-3 scan and, since a same-day critic-found fix, **not**
     `d.capabilityEntries` either — corrected 2026-09-08 to match spec §8c,
     which excludes an id found only on an `inputs:` entry: that shape has
     no `status` and is not the passport's own statement about the
     capability), or a consent row whose Installable column starts with `no`
     (`needs[].installable === false`) — is refused with a listing of every
     marker found, not a pairing: nothing in the format links a consent row
     to a section 3 id unless the author happened to backtick one, and the
     memo's second and third critics both confirmed no read here can build
     that pairing reliably. `capabilityEntries` (`capabilityBlockEntries()`)
     is unanchored on purpose, for parity with tools/validate.py check 16a,
     and can misattribute an entry's ref from prose in its own `tacit_notes`
     field; it is used below only for line text, never for whether this
     gate fires or which ids it names — see writeMarkers()'s own comment.

     THE FIRST DISJUNCT NEVER FIRES THIS GATE ON ITS OWN, a critic on this
     exact branch pointed out and I verified: by the time this line runs,
     `derive()` has already succeeded, which for a passport that declares a
     write anywhere in section 3 (`declaresWrite`, a superset of "a
     capabilities: block entry is declared-only") means its own envelope
     floor already required at least one non-installable consent row to
     exist — the second disjunct. So whenever the first disjunct is true,
     the second already is too, and it is kept anyway because
     `needsWriteConsent`'s truth value is not what `blockRefs` is FOR here:
     `writeMarkers()` reads the same set independently, to build
     `capability_markers`, and dropping the disjunct would not change one
     line of behaviour, only make the "why does this gate read `blockRefs`
     at all" question harder to answer from this line alone.

     record/proposals/where-the-owners-yes-no-on-a-declared-only-write-row-lives.md
     recommends refuse-and-explain over the app editing the passport: nothing
     on this endpoint has ever rewritten a passport before storing it, and
     Raffael's ruling keeps it that way. The owner deletes the lines herself;
     see writeMarkers() below for what she is handed to delete. */
  const needsOwnerReview = d.record.owner_confirmed !== true;
  const needsWriteConsent = d.record.capture_path === 'browser' &&
    ([...d.blockRefs].some(isDeclaredOnly) ||
     d.record.needs.some(n => !n.installable));

  let ackKeyToBurn = null;
  let writeAckKeyToBurn = null;

  if (needsOwnerReview || needsWriteConsent) {
    const problems = [];

    if (needsOwnerReview) {
      const presented = req.headers.get('x-passport-owner-ack') || '';
      /* READ ONLY. The ticket is burned after the passport exists, not here:
         see item 5 of the header and lib/_store.mjs. Spending it in front of
         a publish that then fails costs the sharer a whole extra round trip
         and a second failure charge, for a success that never happened. */
      const ack = presented ? await readAck(deploy, presented, fingerprint) : null;
      if (ack && ack.reason === 'owner_review') {
        /* A good ticket proves this request is downstream of a refusal we
           issued. It buys the right to publish, not a discount: the retry
           pays its own up-h and up-d like any other publish. */
        ackKeyToBurn = ack.key;
      } else {
        const ticket = await mintAck(deploy, fingerprint, [], 'owner_review');
        problems.push({ ...err('E_OWNER_UNCONFIRMED'), ack: ticket });
      }
    }

    if (needsWriteConsent) {
      const presented = req.headers.get('x-passport-write-ack') || '';
      const ack = presented ? await readAck(deploy, presented, fingerprint) : null;
      if (ack && ack.reason === 'write_consent') {
        writeAckKeyToBurn = ack.key;
      } else {
        const ticket = await mintAck(deploy, fingerprint, [], 'write_consent');
        problems.push({ ...err('E_WRITE_UNCONFIRMED'), ack: ticket, ...writeMarkers(d) });
      }
    }

    if (problems.length) {
      /* One priced attempt for this POST whether it carries one problem or
         two: the attempt moves to the failure ceiling once, matching every
         other refusal on this path, not once per problem. See
         chargeAsFailure's own comment for why an unpriced refusal is a free
         validation service. */
      await chargeAsFailure();
      /* Counted like every other refusal, and not through `refuse`, because
         this response carries fields (`ack`, and for a write problem the
         marker lists) the others do not.

         ONE ROW PER ENTRY IN `refusals`, not one row per POST. Corrected
         2026-09-08 per spec §8c: this used to record only `problems[0].code`,
         which is what a single-error client reads at the top level, but
         owner-review is always listed first (`needsOwnerReview` is checked
         before `needsWriteConsent` above), so on every passport that trips
         both gates at once, `E_WRITE_UNCONFIRMED` would never reach the
         corpus — the write gate would be invisible in the one place this
         site counts what it refused and why. failMany's single-row-per-POST
         convention is right for its own case (mutually exclusive validation
         errors, one client-visible cause); it does not hold here, where two
         independently true problems are reported together on purpose. */
      for (const p of problems) {
        await recordRejection(deploy, rejectionRecord({ day: today(), code: p.code }));
      }
      return json(409, { ok: false, ...problems[0], refusals: problems });
    }
  }

  /* Duplicate body inside an hour, per section 3. READ ONLY: the fingerprint is
     claimed after the passport exists, not here. See the header, item 5, and
     lib/_store.mjs. */
  if (await seenRecently(deploy, fingerprint)) {
    await chargeAsFailure();
    return refuse(deploy, 409, err('E_DUPLICATE'));
  }

  /* PH-507: the Jev check, moved here from its shadow-mode position after
     `createPassport` (see _jev.mjs's header for the full reasoning and the
     privacy consequence of the move). This is the only place it can run and
     still be able to refuse anything: every check above this line already
     ran, including validate()'s secret scan, so this text has already
     passed the code gate; nothing below this line has written anything yet,
     so a refusal here costs nothing irreversible -- no passport, no delete
     token, no claimed fingerprint or ack ticket exists.

     ALWAYS calls Jev and ALWAYS logs, regardless of disposition. Shadow
     mode's own contract is that the corpus keeps collecting even when
     nothing acts on it, and `JEV_DISPOSITION=off` must not silently stop
     the logging shadow mode already promised -- only stop ACTING on the
     result. Only `jevFlagged()` below, gated on `jevDisposition()`, may
     ever turn this into a refusal; nothing else here reads the score.

     FAILS OPEN, matching `shadowCheck`'s own contract: a caught error here
     is treated as `jev = null`, which `jevFlagged(null)` reads as "not
     flagged", so an infrastructure problem in this diagnostic path can
     never itself cost a legitimate publisher their upload. */
  let jev = null;
  let secret = null;
  try {
    /* The password check (lib/_jev.mjs secretCheck, design S) runs BESIDE the consent check, not
       after it: each has its own 2 s budget and neither throws, so the pair costs one budget. Both
       are logged in the one row. Its only possible effect is the hold branch below, and only when
       JEV_SECRET_DISPOSITION is 'hold'; it has no refuse path (Raffael, 2026-09-24). */
    const found = secretCandidates(text);     // BEFORE either request starts, so no timer is running while it works
    [jev, secret] = await Promise.all([shadowCheck(text), secretCheck(text, found)]);
    await recordJev(deploy, jevLogRecord({ day: today(), result: jev, secret }));
  } catch { /* fail open: never worth costing a legitimate publish */ }

  if (jevDisposition() === JEV_DISPOSITIONS.REFUSE && jevFlagged(jev)) {
    /* NOT "final: will not be accepted on a retry" -- a first version of this
       message said exactly that, and both gate-code critics reproduced it
       false end to end: identical bytes, two calls, scores 0.97 then 0.62 (or
       0.93 then 0.87), refused then published at a live URL. Nothing on this
       path makes a Jev refusal deterministic or persisted -- no fingerprint is
       claimed, no deny-list entry is written, nothing here joins one request
       to the next -- so record/findings/the-frozen-jev-battery-is-not-
       deterministic-at-the-0.9-boundary-2026-09-17.md is a reason to expect a
       retry to sometimes succeed, not a reason to promise it will fail.

       NOT "Nothing was stored" either -- a first correction of the message
       said exactly that, and HAL caught it by reading privacy.html rather
       than trusting the sentence: three things ARE stored on this path
       (the jev log record above, the rejection row `refuse()` writes below,
       and the rate-limit charge this block deliberately no longer refunds),
       and privacy.html itself already discloses two of them ("A refused
       upload leaves one row: the date, and which refusal it was... It
       leaves the same hashed-address entry that rate limiting writes for
       every attempt"). "Nothing was stored" contradicts the page a reader
       is invited to check this exact claim against.

       NOT subjectless "no text you wrote was kept" either -- a second
       correction said that, checked it against privacy.html, and it was
       still wrong: "kept" with no subject reads as "your text is gone",
       and on this specific path it is not. Jev already read and returned
       the full passport text over the network before this line runs (see
       `_jev.mjs`'s header on the privacy consequence of that), and nothing
       here can speak for what a third party retains. THIS message's job
       is only to say what WE did, so the clause needs a subject: we kept
       none of it. Where the text actually went is privacy.html's job, not
       a refusal message's, and that page's own paragraph on this exact
       shape ("holds no text you wrote" being true of our storage and
       silent on TypeSafe's) is being redrafted separately for the same
       reason. Three revisions to reach this: "final" (checked against
       nothing, wrong), "nothing was stored" (checked against privacy.html,
       still wrong because "stored" and "sent" are different verbs and the
       rate-limit charge and log record ARE stored), "kept" with no
       subject (checked against privacy.html again, still wrong because a
       true claim about our systems read as a claim about the reader's
       exposure). Each check had a range that excluded the next error.
       Check any future change to this sentence against privacy.html AND
       ask whose claim each clause is making, not only whether it is
       true of us.

       Making the refusal itself deterministic ("final") needs a persisted
       refusal keyed on the fingerprint, which is new state and new scope
       (closer to the 'hold' disposition's own unbuilt infrastructure than
       to 'refuse'), not a wording fix -- left to Raffael/frontend once that
       is decided, not invented here. No reason is named, matching the
       owner-review and write-consent refusals above: naming which question
       fired would hand the next upload the recipe to avoid it.

       NOT `chargeAsFailure()`, unlike every other refusal on this path, and
       that asymmetry is deliberate, not an omission. Every other refusal
       above this line is cheap, local computation; chargeAsFailure's own
       reasoning ("somebody fixing a malformed passport is not spending their
       publishes on it") assumes the refusal cost nothing worth protecting
       against a retry loop. This one already cost a real network call to a
       third party with the full passport text. Refunding it back into the
       30-per-hour failure ceiling -- as a first version of this code did --
       let one IP trigger up to 35 such calls an hour instead of 5, since
       Jev only ever ran on a successful publish in shadow mode. Leaving the
       up-h/up-d charge spent keeps the ceiling on how often this endpoint
       will send passport text to TypeSafe at 5 an hour per IP, the same
       ceiling shadow mode had, whatever JEV_DISPOSITION is set to. */
    return refuse(deploy, 422, {
      code: 'E_JEV_REFUSED',
      message: 'This upload was not accepted: no passport was published, and we kept no text you wrote.'
    });
  }

  /* PH-507's hold disposition. Neither publish nor refuse: the upload is
     held for a human to review, for HOLD_TTL_DAYS (five days), after which
     the held text and any address left on it are deleted together --
     Raffael's ruling; see lib/_store.mjs's createHold/sweepHolds and
     record/proposals/jev-gate-disposition-options-2026-09-17.md.

     jevDisposition() ALREADY REFUSED TO RETURN 'hold' UNLESS
     holdAlertReachable() WAS TRUE at the moment it was called (see
     _jev.mjs's pre-flip checklist item 4: a hold nobody is told about is
     not a hold). That is not re-checked here. Re-reading it could only
     make this branch and jevDisposition()'s own decision disagree if the
     environment changed between the two calls inside a single request,
     which is not a case worth coding for: either the coupling held and
     this branch is reachable, or it did not and jevDisposition() already
     sent this request down JEV_DISPOSITIONS.OFF instead, past both jev
     branches entirely.

     NOT `chargeAsFailure()`, matching the refuse branch immediately above
     and for the identical reason given there: this request has already
     cost a real network call to Jev with the full passport text, and
     refunding the up-h/up-d charge would let one IP trigger far more than
     the ordinary 5-an-hour ceiling on how often this endpoint will send
     passport text to a third party. */
  const heldByConsent = jevDisposition() === JEV_DISPOSITIONS.HOLD && jevFlagged(jev);
  const heldBySecret = secretDisposition() === JEV_DISPOSITIONS.HOLD && secretFlagged(secret);
  if (heldByConsent || heldBySecret) {
    let hold;
    try {
      /* What the reviewer sees under `jev` in `show`: the consent scores as before, and when the
         password check scored, its score, the 1-based line and the candidate count. Numbers only;
         the row is deleted with the hold. */
      const heldJev = { ...(jev || {}) };
      if (secret && secret.outcome === 'scored') {
        heldJev.secret = { score: secret.score, line: secret.line, n: secret.n };
      }
      hold = await createHold(deploy, {
        record: d.record, text, gallery: wantsList ? { category } : null, jev: heldJev
      });
    } catch (e) {
      console.error('upload hold-storage failure', {
        name: d.record.name,
        validator_version: d.record.validator_version,
        reason: e && e.message
      });
      return refuse(deploy, 500, err('E_INTERNAL'));
    }

    /* THE FINGERPRINT IS CLAIMED HERE, AND NOWHERE EARLIER -- the same
       ROW-128 discipline the publish path below keeps, applied to the hold
       row instead of a passport row. The hold now exists, so the claim is
       no longer a lie if the write above had failed. claimFingerprint
       never throws (see lib/_store.mjs). */
    await claimFingerprint(deploy, hold.fingerprint, hold.fingerprint_bucket);

    /* The reviewer alert. FAILS OPEN: nobody's upload may be lost because a
       notification could not be sent, and holdAlertMessage's own header
       explains why it carries no passport text -- only the hold id a
       reviewer needs to find the row, when it was created, and the
       requested listing. `to` is re-read rather than assumed, because the
       only thing jevDisposition() proved is that a reachable address
       existed at ITS call time a few lines up; asking again here costs one
       function call and removes any dependence on that not having changed
       in between. */
    try {
      const to = holdAlertTo();
      if (to) {
        /* The same 3 s as every hold mail: a provider that never answers must not hold an upload at
           the platform ceiling (measured 10,036 ms with the default, PH-518 final critic). */
        const sent = await sendMail({
          to,
          timeoutMs: HOLD_MAIL_TIMEOUT_MS,
          ...holdAlertMessage({
            hold_id: hold.hold_id,
            created_at: new Date().toISOString(),
            category: wantsList ? category : null
          })
        });
        /* sendMail never throws: a provider error resolves to
           { ok: false, reason }, so the catch below cannot see it. Read the
           return value, as releaseHold does, or a hold nobody was told about
           leaves no trace at all (PH-507 gate-code critics r1). The hold id
           and the reason are logged, never the address. */
        if (!sent || sent.ok !== true) {
          console.error('hold alert mail failed', { hold_id: hold.hold_id, reason: sent && sent.reason });
        }
      }
    } catch { /* fail open: an alert that cannot be sent must not cost a hold */ }

    // Not logged, matching the publish response below: no response-body logging on this route.
    /* NOT ok:true, and this is the whole point of the shape. assets/share.js
       treats any ok:true as a publish and draws the success screen: "Published",
       the string "undefined" as the link and the delete token, and a 30-day
       lifetime caption for what is a 5-day hold (PH-507 gate-code critics r1,
       HAL ruling 2026-09-21). A held upload is not a publish. `ok:false` with a
       code and a message is the shape a client renders as a refusal, which is
       also what an old cached page does. assets/share.js now recognises code
       E_HELD with status 'hold' and draws the hold screen (showHeld, PH-518),
       and passes hold_id and hold_token to the address box that posts to
       /api/hold-email. 202, not 2xx-with-ok:true and not a 4xx: the upload was
       accepted for review and the client does not read the status. */
    return json(202, {
      ok: false,
      code: 'E_HELD',
      message: 'This passport was not published. It has been set aside for a person to look at first, and if that has not happened within ' + HOLD_TTL_DAYS + ' days it will be deleted.',
      status: 'hold',
      hold_id: hold.hold_id,
      hold_token: hold.hold_token,
      expires_at: hold.expires_at,
      hold_ttl_days: HOLD_TTL_DAYS,
      /* For the hold screen (web-frontend, PH-518): why, and where. `flagged_line` is the 1-based
         number of the line the password check scored highest, present only when that check is what
         held the upload; the line's text is never in any response. */
      held_for: heldBySecret ? 'possible_secret' : 'consent_table',
      flagged_line: heldBySecret ? secret.line : null
    });
  }

  /* stage 5, fail closed. A refusal here means this endpoint and the storage
     layer have drifted, which is a bug in the system and not in the upload. */
  /* THE SWEEP USED TO RUN HERE, IN FRONT OF THIS WRITE. It is now a scheduled
     function, netlify/functions/sweep.mjs. Removing the call is safe; MOVING it
     was not, and the reason is worth keeping because it is not obvious.

     It ran before the write rather than after because the delete token is 20
     bytes of randomness that exists nowhere but the upload response, and this
     site says so and says it cannot be reissued. Anything that killed the
     request between createPassport and that response left a passport published,
     public, undeletable and unrenewable for thirty days, in front of a sharer
     who saw a failure and will publish it again. What kills a serverless
     function is running out of time, which `.catch()` does not catch, so a slow
     sweep after the write was exactly that. Reproduced with a client abort at
     150 ms.

     If anything ever needs to run on this path again, it goes here, ahead of the
     write, for that reason and not for tidiness. */


  /* The shape of what is about to be published, recorded before it is
     published. Order matters for the same reason the sweep used to run ahead of
     the write: what kills a serverless function is running out of time, and
     `.catch()` does not catch that, so anything left until after the response
     may simply never run. Ahead of the write, the worst case is a row
     describing a passport that failed to store, which is a countable
     inaccuracy. Behind it, the failure mode is a corpus with holes in exactly
     the places the function was slowest, and no way to know which.

     It carries no identifier and no text: see _metrics.mjs. It cannot fail the
     upload, and a publish that loses its metric is a publish, not an error. */
  try {
    await recordMetrics(deploy, metricsRecord({
      front: v.front, lines: v.lines, needs: d.record.needs,
      body: text, day: new Date().toISOString().slice(0, 10)
    }));
  } catch { /* a metric is worth less than a publish */ }

  try {
    const { id, token, expires_at, fingerprint_bucket, listed } =
      await createPassport(deploy, d.record, text, wantsList ? { gallery: { category } } : {});

    /* THE FINGERPRINT IS CLAIMED HERE, AND NOWHERE EARLIER. The passport now
       exists, so a 409 telling the next identical upload to "use the link you
       already have" is true. Claimed before this line it was a lie whenever the
       write failed, which is ROW-128.

       It cannot throw and it must not: this line runs AFTER a passport is
       public and after a delete token has been minted that exists nowhere but
       the response below. Anything that turned a successful publish into the
       E_INTERNAL at the bottom of this file would leave that passport
       published, public, undeletable and unrenewable for thirty days, in front
       of a sharer who saw a failure — which is the exact scenario the sweep
       comment above describes and was moved off this path to avoid. The
       swallow is in claimFingerprint itself so no caller can forget it.

       THE BUCKET COMES FROM THE ROW, not from a second clock read. purge()
       deletes fpKey(row.fingerprint, row.fingerprint_bucket), so a claim that
       read its own clock could land one bucket later and survive its own
       passport's deletion. Reproduced across an hour boundary; see
       claimFingerprint in lib/_store.mjs. */
    await claimFingerprint(deploy, fingerprint, fingerprint_bucket);

    /* AND THE ACK TICKET IS SPENT HERE, for the same reason and not a moment
       earlier. Both are one-shot claims, both become true only once the
       passport exists, and both swallow their own failure because this line
       runs after a delete token has been minted that exists nowhere but the
       response below. Two burn slots since ROW-228: the write-consent ticket
       is the same kind of one-shot claim as the owner-review one, becomes
       true only once the passport exists, and swallows its own failure for
       the identical reason. burnAck no-ops on a null key, so a POST that
       tripped only one of the two gates burns only the one it used. */
    await burnAck(deploy, ackKeyToBurn);
    await burnAck(deploy, writeAckKeyToBurn);

    /* CANONICAL, NOT THE REQUEST. Lower stakes than send.mjs — this response
       goes back to the browser that set the Host — but the same reasoning and
       the same fix. The publisher pastes `url` to someone else and stores
       `manage_url`, so both outlive the tab they were produced in, and on a
       preview or branch deploy both named a hostname that stops existing when
       that deploy is cleaned up. See lib/_site.mjs. */

    // Not logged. Standard access logging of the request line is fine;
    // response body logging must be off for this route.
    return json(200, {
      ok: true,
      id,
      url: `${CANONICAL}/p/${id}`,
      delete_token: token,
      manage_url: `${CANONICAL}/manage#${id}:${token}`,
      expires_at,
      ttl_days: TTL_DAYS,
      /* Whether the passport is in the gallery, and where the gallery is.
         `expires_at` above is null for a listed passport; the success screen
         reads `listed` rather than inferring it from the null. */
      listed,
      gallery_url: `${CANONICAL}/gallery`,
      title: d.record.title,
      summary: d.record.summary,
      /* The success screen draws a card of the passport that was just
         published, and every element on that card has to be backed by real
         passport data rather than by decoration. The client holds the file it
         uploaded and could parse it again, but a second parser is a second
         reading: it would drift from _derive.mjs and the card would then
         disagree with the passport page about the same file. So the derivation
         that already happened is echoed back instead.

         Nothing here is new information. Every field is either already in this
         response or already public at the link this response returns. */
      passport: {
        name: d.record.name,
        created: d.record.created,
        envelope: d.record.envelope,
        capture_path: d.record.capture_path,
        passport_version: d.record.passport_version,
        owner_confirmed: d.record.owner_confirmed,
        capabilities: d.record.needs.map(n => ({
          label: n.capability,
          granted: n.installable,
          required: n.required
        })),
        /* `declared_only`, not `declared`. This site uses "declared" for two
           different quantities one line apart: the passport page's permit note
           reads "5 declared, 4 installable, 1 declared only", where the bare
           word is the TOTAL and the qualified one is the not-installable
           bucket. A field called `declared` therefore means the opposite thing
           to each of the two readers who would reach for it, and the card
           already computes a local `declared` meaning the total. Naming the
           narrow quantity narrowly is the only version of this that cannot be
           read two ways. */
        installable: d.record.needs.filter(n => n.installable).length,
        declared_only: d.record.needs.filter(n => !n.installable).length
      }
    });
  } catch (e) {
    console.error('upload storage failure', {
      name: d.record.name,
      validator_version: d.record.validator_version,
      reason: e && e.message
    });
    return refuse(deploy, 500, err('E_INTERNAL'));
  }
};

export const config = { path: '/api/upload' };

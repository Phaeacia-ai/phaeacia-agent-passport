/* _store-holds.mjs

   Held uploads (PH-507's `hold` disposition): the hold row awaiting human
   review, the optional owner address, the pointer that outlives a released
   hold, and `sweepHolds`. This is the one module that imports _email.mjs;
   the comment on that import says why.

   Stores opened here: hold-expiry, holds, hold-pointers, hold-email, hold-pointer-expiry.

   Exports that _store.mjs does not re-export are internal to the _store-*.mjs family. */

import { randomUUID } from 'node:crypto';
import { isExpired } from './_row.mjs';
/* Used only by releaseHold, to tell a hold's owner where their passport
   went before the address that would reach them is deleted. A store module
   importing an email composer is a real layering exception, made because
   releaseHold is the one function that has the address and does the
   deletion, and the ordering between "send" and "delete the only channel
   to a person who is owed an answer" has to be enforced inside one
   function to be provably right rather than trusted across two files. */
import { holdExpiredMessage, holdRefusedMessage, holdReleaseMessage, sendMail } from './_email.mjs';
import { CANONICAL } from './_site.mjs';
import { HOUR_MS, scan, sha256, strong, UUID } from './_store-core.mjs';
import { expiryFrom, expiryKey, TTL_DAYS } from './_store-expiry.mjs';
import { createPassport, hashMatches, mintDeleteToken } from './_store-passport.mjs';

/* ── held uploads: PH-507's `hold` disposition ─────────────────────────
   Raffael's ruling, 2026-09-17: a hold lasts 5 days. After that, both the
   text and the email are deleted together, in one operation -- if the
   person still wants it published, they upload again. See
   record/proposals/jev-gate-disposition-options-2026-09-17.md for the
   full design and the retention reasoning put to him before he set the
   number: a hold record joins an identity, a document and a judgement
   about that document in one row, a stronger link than anything else this
   site stores.

   THE SAME TOKEN DISCIPLINE AS A DELETE TOKEN, reused rather than
   duplicated: `mintDeleteToken()` mints 20 bytes of randomness and its
   sha256 hash regardless of what the token is FOR, so a hold token is
   minted with the same function a delete token is, and compared with the
   same `hashMatches`. There is one token-minting function in the _store-*.mjs family
   (`mintDeleteToken`, in _store-passport.mjs), not two that happen to agree today and can drift tomorrow.

   THE SAME INDEX-FIRST INVARIANT createPassport uses: write the recoverable
   thing (an index entry pointing at a hold that turns out not to exist,
   harmless, the sweep clears it) before the unrecoverable one (a hold row
   with no index entry, unreachable forever). A SEPARATE index,
   `hold-expiry`, not `expiry` -- a hold id and a passport id are different
   id spaces minted by different calls to randomUUID(), and sweepHolds()
   below must never be able to read a passport id out of the wrong index
   and delete the wrong store's row by construction. `expiryKey` itself is
   pure key-formatting with no passport-specific logic, so it is reused
   directly rather than copied under a new name.

   WHAT IS STORED: the full `record` and `text` a normal publish would
   need, because release has to be able to call createPassport with exactly
   those two arguments later, not a summary reconstructed from something
   thinner. `gallery` carries the owner's original listing intent (null, or
   `{ category }`) so a released hold honours the same choice a straight
   publish would have. `jev` is the flagged result, so a reviewer sees why
   this needed a human. The owner's address is not in this row; see hold-email
   and attachHoldEmail. */

export const HOLD_TTL_DAYS = 5;
/* One definition of "this hold is past its five days", used wherever a hold row is
   read for action. An unparseable expires_at counts as expired: a row whose
   deadline cannot be read must not be publishable forever. */
const holdExpired = (row, now = Date.now()) => !(Date.parse(row && row.expires_at) > now);

export async function createHold(deploy, { record, text, gallery = null, jev }) {
  const hold_id = randomUUID();
  const { token, hash } = mintDeleteToken();
  const now = Date.now();
  const created_at = new Date(now).toISOString();
  const expires_at = expiryFrom(now, HOLD_TTL_DAYS);
  const expiresMs = Date.parse(expires_at);
  /* Same discipline as createPassport: read the fingerprint and its hour
     bucket ONCE, at creation time, and hand both back so the CALLER claims
     them only after this write has actually succeeded (ROW-128 -- the store
     itself never self-claims, because a claim made before the row exists
     survives a write failure that the row does not). This is the claim
     releaseHold's and refuseHold's comments describe as already made "at
     hold-creation time": without recording it here, that sentence was a
     claim about code that did not exist yet. */
  const fingerprint_bucket = Math.floor(now / HOUR_MS);
  const fingerprint = sha256(text);

  await strong(deploy, 'hold-expiry').set(expiryKey(expiresMs, hold_id), '1');

  await strong(deploy, 'holds').setJSON(hold_id, {
    record, text, gallery, jev,
    fingerprint, fingerprint_bucket,
    token_hash: hash, created_at, expires_at
  }, { metadata: { h: hash, x: expiresMs } });

  return { hold_id, hold_token: token, expires_at, fingerprint, fingerprint_bucket };
}

/* Reads a hold row for a caller who already holds hold_id and hold_token --
   the owner's own receipt, exactly the shape of a delete-token check. An
   unknown id, a wrong token and an expired-but-not-yet-swept hold are the
   same answer for the same reason a wrong delete token and a missing
   passport are: nothing here may tell an owner "the id is right but the
   token is wrong", which is a scanner's oracle. */
async function readHoldForOwner(deploy, hold_id, hold_token, now) {
  if (!UUID.test(hold_id || '')) return null;
  let row;
  try {
    row = await strong(deploy, 'holds').get(hold_id, { type: 'json' });
  } catch {
    return null;
  }
  if (!row || isExpired(row, now)) return null;
  if (!hashMatches(row.token_hash, hold_token)) return null;
  return row;
}

/* Three states, not two. A two-state version (pending / not_found) was
   built first and was wrong: release deletes the hold row, so a returning
   owner who left no email would get 'not_found' for a passport that was
   actually published -- indistinguishable from an expired hold or a
   mistyped token, and strictly worse than a refusal, because the one case
   that worked left them with no way to learn their own passport's address.
   HAL caught this before it shipped.

   'released' carries the published id, read from hold-pointers -- a record
   that outlives the hold row on purpose (see releaseHold and the store list
   in _store.mjs) and carries nothing else: no text, no email, no
   score. It is deliberately NOT gated on hold_token: by the time a hold is
   released there is no hold row left for a token to match against, and the
   pointer's own key is the hold's id, a v4 UUID with the same guessing
   resistance the published passport's own bare id already relies on for
   read access (viewing /p/<id> has never needed a token, only deleting or
   renewing it does). This is not a new exposure, it is the same one the
   product already accepted for every passport.

   Refusal still has nothing to point at and stays a plain not_found: there
   is no id, and reporting anything more specific for a refusal than for an
   unknown hold would let a guess distinguish "wrong id" from "your text was
   refused". */
export async function checkHold(deploy, hold_id, hold_token, now = Date.now()) {
  const row = await readHoldForOwner(deploy, hold_id, hold_token, now);
  if (row) return { status: 'pending' };

  if (!UUID.test(hold_id || '')) return { status: 'not_found' };
  let ptr;
  try {
    ptr = await strong(deploy, 'hold-pointers').get(hold_id, { type: 'json' });
  } catch {
    return { status: 'not_found' };
  }
  if (ptr && typeof ptr.id === 'string') return { status: 'released', id: ptr.id };
  return { status: 'not_found' };
}

/* Attaches an email to an existing, still-pending hold. Same validation
   discipline as the check above -- wrong token and unknown id both read as
   not_found, never distinguished -- because this is also reachable by
   anyone who can guess a UUID, and the token is the only thing standing
   between a guess and reading (here, overwriting) somebody else's hold.
   Overwrites rather than merges: one hold, one owner, one address; a
   second call with a different address corrects the first rather than
   creating a second recipient nobody asked for.

   THE ADDRESS IS ITS OWN KEY, AND THE HOLD IS RE-READ AFTER IT IS WRITTEN.
   This used to read the row and write the whole row back with the address
   in it. Nothing conditioned that write on the row still existing (the
   store version this app pins has no conditional write), so a save that
   overlapped a refusal, a release or the sweep brought the row back with
   the passport text and the address and no expiry-index key, and nothing
   ever deleted it (PH-518 critic r1, measured: 0 removed at +1 h, +7 d and
   +365 d, while the client said Saved). Now the row is never rewritten. The
   address is written to hold-email, then the hold is read again: if it is
   gone or expired, this call takes its own address out and answers
   not_found. Why that closes it: endHold deletes the row first and
   reads the address after, so either this re-read still sees the row, in
   which case the ending has not yet read the address and will read it (and
   mail it, then delete it), or it sees no row, and this call removes it and
   answers not_found, never Saved. There is no third order. What is
   left is a process dying between the write and the re-read during a race
   that has to hit the same few milliseconds: an orphan address, never
   passport text, and sweepHolds removes it when the hold's index key comes
   due, provided the delete that raced this call did not remove that key
   first (it does so last, and only after everything else succeeded). */
export async function attachHoldEmail(deploy, hold_id, hold_token, email, now = Date.now()) {
  const row = await readHoldForOwner(deploy, hold_id, hold_token, now);
  if (!row) return { status: 'not_found' };
  await strong(deploy, 'hold-email').setJSON(hold_id, { email });
  let still = null;
  try {
    still = await strong(deploy, 'holds').get(hold_id, { type: 'json' });
  } catch {
    still = null; // cannot tell; the safe reading is "gone", which removes the address
  }
  if (!still || holdExpired(still, now)) {
    await strong(deploy, 'hold-email').delete(hold_id).catch(() => {});
    return { status: 'not_found' };
  }
  return { status: 'ok' };
}

/* The address left on a hold, or null. A read that fails is null and is logged,
   never thrown: every caller is about to act on a hold (publish it, refuse it,
   let it expire) and none of those should stop because the address could not
   be read; the cost is one message not sent, and the address is deleted with
   the hold either way. */
async function readHoldEmail(deploy, hold_id) {
  try {
    const r = await strong(deploy, 'hold-email').get(hold_id, { type: 'json' });
    return r && typeof r.email === 'string' && r.email ? r.email : null;
  } catch (e) {
    console.error('hold address unreadable', { hold_id, reason: e && e.message });
    return null;
  }
}

/* THE ONE WAY A HOLD ENDS, for release, refusal and expiry alike: delete the row, THEN read the
   address, THEN send the one message, THEN delete the address, THEN the index key, one at a time.
   The address is read after the row is gone, not before, on purpose (PH-518 critic, F1): an
   attachHoldEmail that answers Saved did so because its re-read still saw the row, which means the
   row delete came after that re-read and this read comes after the row delete, so it sees the
   address. An attach that lands later finds no row, removes its own address and answers not_found,
   which the owner is told. So "Saved" always means "this ending will see the address", and the
   owner never hears Saved for an address nobody read. `buildMessage(email)` returns the message for
   this ending or null.

   The index key goes last and only when both deletes worked, so a failure leaves the key. WHEN a
   failed delete is retried is when that key comes due: it is named for the hold's original expiry,
   which is up to 5 days away, and sweepHolds only takes keys at or before now. It is not the next
   hourly sweep, and until then a row whose delete failed is still listed as pending and could be
   released again (measured by the critic; the version before this change was worse, with the key
   deleted in parallel and the row never swept).

   Two endings racing on the SAME hold (a reviewer's release and the hourly sweep within about a
   second of each other, on a hold that expires in that second) can both read the address and both
   send. Nothing in this store version can make the read-and-delete atomic. The cost is a second
   message, never a retained address. The claim in the tests is therefore one message per ending, and
   one per hold unless two endings collide. */
async function endHold(deploy, hold_id, row, buildMessage, what, { deferMail = false } = {}) {
  let clean = true;
  try { await strong(deploy, 'holds').delete(hold_id); } catch { clean = false; }
  const email = await readHoldEmail(deploy, hold_id);
  const message = email ? buildMessage(email) : null;
  /* `deferMail` is the sweep's mode (see sweepHolds): everything is deleted first and the message
     is handed back for the caller to send, or drop, once every hold in the run is gone. */
  const mailed = message && !deferMail ? await mailHoldOwner(deploy, hold_id, email, message, what) : false;
  try { await strong(deploy, 'hold-email').delete(hold_id); } catch { clean = false; }
  if (clean && row && row.expires_at) {
    await strong(deploy, 'hold-expiry')
      .delete(expiryKey(Date.parse(row.expires_at), hold_id)).catch(() => {});
  }
  return { email, message: deferMail ? message : null, mailed, clean };
}

/* `HOLD_MAIL_TIMEOUT_MS`: a hold mail that never answers must not overrun the sweep's share of the
   scheduled run (sweep.mjs gives holds 5 s of a 30 s ceiling). 3 s, and the sweep does not START a
   hold unless that much of its budget is left. */
export const HOLD_MAIL_TIMEOUT_MS = 3000;

/* One mail for an address a hold is ending with. The send's result is returned so a caller can
   report `mailed` honestly; a throw is swallowed and logged for the reason releaseHold always
   did: a publish or a deletion that already happened is not undone by a mail. */
async function mailHoldOwner(deploy, hold_id, email, message, what) {
  if (!email) return false;
  /* Nothing here may print the address, and a reason string comes from code this file does
     not own (a network error can quote the request). Cut the address out of whatever is
     logged. sendMail catches its own fetch errors, so the catch below is a second line of
     defence for a throw from sendMail itself, which it does not do today. */
  const clean = m => String(m).split(email).join('[address]');
  try {
    const sent = await sendMail({ to: email, ...message, timeoutMs: HOLD_MAIL_TIMEOUT_MS });
    if (sent.ok !== true) console.error(`hold ${what} mail failed`, { hold_id, reason: clean(sent.reason) });
    return sent.ok === true;
  } catch (e) {
    console.error(`hold ${what} mail threw`, { hold_id, reason: clean(e && e.message) });
    return false;
  }
}

/* A hold past its five days: say so once, then delete text and address together. The one place
   both the sweep and a release attempt on an expired hold converge. */
async function expireHold(deploy, hold_id, row, opts) {
  return endHold(deploy, hold_id, row, () => holdExpiredMessage(), 'expiry', opts);
}

/* Writes the pointer checkHold reads once a hold's own row is gone. Index
   first, same reasoning as createPassport and createHold: a pointer that
   silently failed to write would strand the one owner it exists to help,
   which is a worse outcome than the write throwing and releaseHold's caller
   seeing an error. `listed` mirrors createPassport's own gallery/no-gallery
   split exactly -- no expiry entry at all for a gallery release, because
   "gallery is lifetime" is Raffael's ruling about the passport, and a
   pointer that outlived what it points to would answer questions about a
   passport that no longer exists, while a pointer that expired before it
   would strand an owner whose passport is still live. */
/* ALWAYS thirty days, gallery release or not -- HAL's correction, the same
   day the "mirror the passport's own policy" version shipped. A gallery
   PASSPORT is lifetime, correctly, because "gallery is lifetime" is
   Raffael's ruling about the passport. But the pointer is not the passport:
   it is a row that exists only because our own automatic check flagged
   this document, and a version that never expired for gallery releases
   made that fact -- document plus judgement, with the identity already
   gone -- permanent and growing forever, unbounded, never disclosed to
   Raffael as its own retention decision. Its only job is letting a
   returning owner find their link after a hold; thirty days is already the
   longest anything unlisted lives here, and after that they have either
   found it or they have not. One rule, no conditional: pointers always
   expire, holds always expire, only a published passport itself can be
   permanent. */
const HOLD_POINTER_TTL_DAYS = TTL_DAYS;

async function createHoldPointer(deploy, hold_id, published_id, expiresMs) {
  await strong(deploy, 'hold-pointer-expiry').set(expiryKey(expiresMs, hold_id), '1');
  await strong(deploy, 'hold-pointers').setJSON(hold_id, { id: published_id },
    { metadata: { x: expiresMs } });
}

/* Reviewer-only. Not a public endpoint and takes no token: whoever calls
   this already has direct store access (a script run with real Netlify
   Blobs credentials, per the design's explicit choice not to build a
   second, public, authenticated admin surface for a feature that does not
   need one). Reuses createPassport with exactly the record/text/gallery a
   normal publish would have supplied, so a released hold is indistinguishable
   from a passport published directly -- same expiry, same TTL, same
   fingerprint duplicate-guard row already claimed at hold-creation time and
   left alone here rather than re-claimed.

   ORDER, all three steps load-bearing:
     1. publish
     2. mail the owner their link, if they left an address
     3. write the pointer
     4. delete the hold row (text and email, together, one call)
   Mail before delete because the address lives nowhere else once step 4
   runs, and an owner who is owed an answer must not lose the only channel
   to it -- HAL caught a two-state design that got this backwards by
   construction (checkHold could never answer once the row was gone) and
   asked for this ordering specifically, with a test that pins it. The
   pointer is written before the delete for the same reason its own write
   is index-first: if it never gets written, the row must still be there
   for a retry to find, not silently gone with nothing left to point at.

   THE SEND'S RETURN VALUE IS READ, NOT JUST AWAITED. A gate-code critic
   (critic-ph507-hold-r1) found that `sendMail` never throws -- a network
   failure and a provider error both resolve to `{ ok: false, reason }`,
   never a rejection -- so a `try { await sendMail(...) } catch {}` around
   it is dead code: the catch clause can never run, and every send, failed
   or not, fell through to write the pointer and delete the row exactly the
   same way. The row (and the only copy of the address) was destroyed
   whether or not the owner was actually told, and `tools/review-holds.mjs`
   printed "Mailed the owner… (address now deleted)" on a call that never
   left this process. `mailed` on the return value below is what that
   script now gates its message on, and a failure is logged (hold id and
   reason, never the address, matching every other outbound-mail failure
   this file logs) so there is at least an audit trail once the address
   itself is gone. Deletion still proceeds regardless: undoing a real
   publish, or keeping full passport text and an address alive past the
   point where the passport already carries that text, over a notification
   that can no longer be retried once the address is gone anyway, would
   trade one failure for a worse one. What changed is that the failure is
   now reported rather than papered over.

   THE DELETE TOKEN IS CAPTURED AND FORWARDED, WHICH IT DID NOT USED TO BE.
   A second gate-code critic (critic-ph507-hold-r2) found that
   `createPassport` mints a token exactly as it does for a normal publish,
   and this function threw it away: not in the return value, not in the
   pointer, not in the mail. A released hold was a passport neither its
   owner nor anyone here could ever delete or renew through any product
   surface -- worse than an owner losing their own token by accident,
   because here the token existed and was deliberately discarded. The
   token is shown exactly once, the same rule every other path on this
   site keeps: in the release mail (holdReleaseMessage, now taking
   `manageUrl`) for an owner who left an address, and on the return value
   for tools/review-holds.mjs to print for one who did not -- the
   reviewer's terminal is that owner's only "shown once" surface, since
   they never see a success screen. */
export async function releaseHold(deploy, hold_id) {
  let row;
  try {
    row = await strong(deploy, 'holds').get(hold_id, { type: 'json' });
  } catch {
    return { ok: false, reason: 'store_error' };
  }
  if (!row) return { ok: false, reason: 'not_found' };

  /* Expiry is the promise the owner was given ("deleted after 5 days"), and
     until now only the sweep enforced it: a hold the sweep had not reached yet
     was still listed and still publishable and mailable. An expired hold is
     deleted here, text and address together, and reported as not_found so the
     reviewer sees the same thing the owner does (checkHold). */
  if (holdExpired(row)) {
    await expireHold(deploy, hold_id, row);
    return { ok: false, reason: 'not_found' };
  }

  /* The pointer's expiry is fixed BEFORE the passport is written and recorded on it, so that
     purge() can delete the pointer and its expiry key when the passport goes. */
  const pointerMs = Date.parse(expiryFrom(Date.now(), HOLD_POINTER_TTL_DAYS));
  const published = await createPassport(deploy, row.record, row.text,
    { ...(row.gallery ? { gallery: row.gallery } : {}), hold: { id: hold_id, x: pointerMs } });
  const manage_url = `${CANONICAL}/manage#${published.id}:${published.token}`;

  await createHoldPointer(deploy, hold_id, published.id, pointerMs);

  const { email, mailed } = await endHold(deploy, hold_id, row,
    () => holdReleaseMessage({ url: `${CANONICAL}/p/${published.id}`, manageUrl: manage_url }), 'release');

  return {
    ok: true, id: published.id, token: published.token, manage_url,
    email, mailed
  };
}

/* Reviewer-only, same access model as releaseHold. Deletes the text and
   the email together and creates nothing. The fingerprint claimed at
   hold-creation time is left in place, same as releaseHold: the duplicate
   guard it enforces is the ordinary hour-bucket window every publish gets,
   not a promise specific to holds, and a refused hold's content should not
   be immediately re-publishable inside that same window any more than any
   other refusal's would be. */
export const REFUSAL_REASON_MAX = 600;
export async function refuseHold(deploy, hold_id, { reason = '' } = {}) {
  let row;
  try {
    row = await strong(deploy, 'holds').get(hold_id, { type: 'json' });
  } catch {
    return { ok: false, reason: 'store_error' };
  }
  if (!row) return { ok: false, reason: 'not_found' };

  /* A refusal with an address on file sends one mail saying why, so the reviewer has to
     say why: without a reason this refuses to act at all rather than deleting the only
     way to tell the owner. No address, no message, no reason needed. */
  const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, REFUSAL_REASON_MAX);
  if (!why && await readHoldEmail(deploy, hold_id)) return { ok: false, reason: 'reason_required' };

  /* An address that arrives after that check, before the row is deleted, is mailed the refusal
     without a reason line (holdRefusedMessage prints it only when there is one): it was told Saved
     and gets told the outcome. */
  const { email, mailed } = await endHold(deploy, hold_id, row, () => holdRefusedMessage({ reason: why }), 'refusal');

  return { ok: true, email, mailed };
}

/* Reviewer-only, same access model as releaseHold/refuseHold: whoever calls
   this already has direct store credentials, so neither function takes a
   token. Together they are the whole read side of the review script
   (tools/review-holds.mjs): list what is waiting, then read one in full to
   decide it. Deliberately two functions rather than one that always
   returns full text -- a listing a reviewer scans to pick what to look at
   next has no reason to carry every held passport's full body over the
   wire (or into a terminal scrollback) at once. */
export async function listPendingHolds(deploy, { pages } = {}) {
  const blobs = pages === undefined ? await scan(deploy, 'holds') : await scan(deploy, 'holds', { pages });
  if (blobs.failed) return { listFailed: true, holds: [] };

  const holds = [];
  for (const b of blobs) {
    let row;
    try {
      row = await strong(deploy, 'holds').get(b.key, { type: 'json' });
    } catch {
      continue; // unreadable now; the next run tries again, same as sweepHolds' own reads
    }
    if (!row || holdExpired(row)) continue;   // an expired-but-unswept hold is gone, as far as anyone can act on it
    holds.push({
      hold_id: b.key,
      created_at: row.created_at,
      expires_at: row.expires_at,
      requested_listing: row.gallery ? row.gallery.category : null,
      has_email: Boolean(await readHoldEmail(deploy, b.key)),
      jev: row.jev
    });
  }
  return { listFailed: false, holds };
}

export async function readHold(deploy, hold_id) {
  if (!UUID.test(hold_id || '')) return null;
  try {
    const row = await strong(deploy, 'holds').get(hold_id, { type: 'json' });
    return row && !holdExpired(row) ? { ...row, email: await readHoldEmail(deploy, hold_id) } : null;
  } catch {
    return null;
  }
}

/* sweepHolds's own share, sized like SCOPE_SWEEP_BUDGET_MS's reasoning
   (_store-scopes.mjs) rather than borrowed from SWEEP_BUDGET_MS (_store-expiry.mjs): holds and hold-pointers
   are a far smaller concern than passports (no gallery card, no
   views/copies, no fingerprint release to chase), and defaulting sweepHolds
   to the 20s passport share would let three scheduled passes add up past
   the 30s ceiling sweep.mjs's own comment describes. Run after sweep() and
   sweepScopes(), same as sweep.mjs's ordering, so neither of the two
   invariant-bearing passes is starved by a third. */
export const HOLD_SWEEP_BUDGET_MS = 5000;

/* The scheduled half. Same shape as sweep()'s core loop -- scan the index
   oldest-first, budget-bounded, re-check the row before trusting the index
   key, drop an orphan index key on sight -- deliberately NOT a call into
   sweep() itself: holds and passports are different rows in different
   stores with different cleanup (no gallery card, no views/copies, no
   fingerprint release), and forcing one function to branch on which of two
   unrelated shapes it is holding is how a passports-only invariant quietly
   grows an exception for holds that the next passports-only reader never
   sees coming. Text and email are deleted in the SAME call, via
   endHold, so an expired hold cannot leave one behind without the
   other -- the exact invariant Raffael's ruling asked for by name.

   TWO PASSES (PH-518, Raffael and HAL 2026-09-24). Pass 1 ends every due hold up to `maxHolds`
   with no mail: row, address and index key, the (address, message) kept in memory. Pointers are
   swept next. Pass 2 sends the mails with the budget that is left and DROPS a mail it cannot start
   (`mailsDropped`), because by then its address is deleted. The deletion promise on privacy.html
   outranks the courtesy of a message. */
/* `mail: false` is archive mode (lib/_archive.mjs, read by sweep.mjs): every deletion happens as
   above and pass 2 sends nothing, counting each message it did not send as `mailsWithheld`. */
export async function sweepHolds(deploy, { now = Date.now(), maxHolds = 200, budgetMs = HOLD_SWEEP_BUDGET_MS, clock = Date.now, mail = true } = {}) {
  const startedAt = clock();
  const removed = { holds: 0, pointers: 0, listFailed: false, budgetSpent: false, mailsDropped: 0, mailsWithheld: 0 };
  /* (address, message) of every hold this run ended, held in memory only for pass 2. */
  const owed = [];

  try {
    const blobs = await scan(deploy, 'hold-expiry');
    if (blobs.failed) removed.listFailed = true;
    const dead = blobs
      .map(b => b.key)
      .filter(k => {
        const cut = k.indexOf(':');
        return cut > 0 && Number(k.slice(0, cut)) <= now;
      })
      .slice(0, maxHolds);

    for (const key of dead) {
      /* Pass 1 makes no network call to a mail provider, so nothing here can hang on one and the
         whole budget is its own. What is left waits for the next run. */
      if (clock() - startedAt >= budgetMs) { removed.budgetSpent = true; break; }

      const hold_id = key.slice(key.indexOf(':') + 1);

      let row = null;
      try {
        row = await strong(deploy, 'holds').get(hold_id, { type: 'json' });
      } catch {
        continue; // unknown is not dead; next sweep asks again
      }

      if (row && !isExpired(row, now)) {
        // stale index key from an id that was already re-read as not-yet-expired
        await strong(deploy, 'hold-expiry').delete(key).catch(() => {});
        continue;
      }

      /* The row is already gone (some other route, or a previous sweep dying
         between endHold's steps) and endHold cannot reconstruct this exact
         index key without row.expires_at -- it only knows how to delete the
         key for a row it can still read. `key` is already in hand from the
         scan, so delete it directly rather than asking endHold to do work it
         has no row to do it with.
         Mirrors sweep()'s own `if (!row)` branch for the same reason: an
         orphan index key is real and worth clearing, and it is not a hold
         that was removed. */
      if (!row) {
        /* No row, but an address may still be here (a delete that died between its two
           steps, or an attach that raced one). Nobody is told: the hold is long gone and
           the address is deleted, not used. */
        let addressGone = true;
        await strong(deploy, 'hold-email').delete(hold_id).catch(() => { addressGone = false; });
        if (addressGone) await strong(deploy, 'hold-expiry').delete(key).catch(() => {});
        continue;
      }

      const ended = await expireHold(deploy, hold_id, row, { deferMail: true });
      removed.holds++;
      if (ended.email && ended.message) owed.push({ hold_id, email: ended.email, message: ended.message });
    }
  } catch {
    removed.listFailed = true;
  }

  /* The pointer half. Simpler than the loop above: a pointer is never
     renewed and never has a competing "not actually expired" reading to
     re-check against, so there is no row to re-read before trusting the
     index -- an index key here always means "delete this pointer too."
     Same clock and the same overall budgetMs, so a scope with both many
     dead holds and many dead pointers still finishes in one bounded sweep
     rather than paying two full budgets back to back. */
  try {
    const blobs = await scan(deploy, 'hold-pointer-expiry');
    if (blobs.failed) removed.listFailed = true;
    const dead = blobs
      .map(b => b.key)
      .filter(k => {
        const cut = k.indexOf(':');
        return cut > 0 && Number(k.slice(0, cut)) <= now;
      })
      .slice(0, maxHolds);

    for (const key of dead) {
      if (clock() - startedAt >= budgetMs) { removed.budgetSpent = true; break; }
      const hold_id = key.slice(key.indexOf(':') + 1);
      await Promise.all([
        strong(deploy, 'hold-pointers').delete(hold_id).catch(() => {}),
        strong(deploy, 'hold-pointer-expiry').delete(key).catch(() => {})
      ]);
      removed.pointers++;
    }
  } catch {
    removed.listFailed = true;
  }

  /* PASS 2, the mails, after every deletion in this run (PH-518, HAL and Raffael). Before this the
     mail was sent inside each hold's ending, so a provider that hangs cost 3 s per hold and the
     budget ended the run after one hold, leaving the rest of the backlog, text and address, on
     disk until the next hour. The promise privacy.html makes is deletion, so deletion is
     first and unconditional up to the budget, and the courtesy of a message takes what is left:
     a mail that cannot start with one full timeout of budget remaining is DROPPED, not deferred,
     because its address is already gone (nothing is retained to retry from) and a run that
     kept it would need somewhere to keep it. The count is `mailsDropped`. A process that dies
     between the passes loses the same messages and nothing else. The order inside pass 2 is the
     order the holds were ended in. */
  for (const m of owed) {
    if (!mail) { removed.mailsWithheld++; continue; }
    if (clock() - startedAt + HOLD_MAIL_TIMEOUT_MS >= budgetMs) { removed.mailsDropped++; continue; }
    await mailHoldOwner(deploy, m.hold_id, m.email, m.message, 'expiry');
  }
  owed.length = 0;

  return removed;
}

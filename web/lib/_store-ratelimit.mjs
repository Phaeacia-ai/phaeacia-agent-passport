/* _store-ratelimit.mjs

   Everything the upload path uses to decide whether to let a request through,
   and the short-lived state it keeps while it decides: the address and mailbox
   keys (`ipKey`, `networkOf`, `mailboxKey`), the rate limiter and its refund,
   the duplicate-body fingerprints, and the owner-review / write-consent
   tickets. All of it is time-bucketed and cleared by key name, which is why
   `sweep()` in _store-expiry.mjs can reach it.

   Stores opened here: ratelimit, fingerprints, acks.

   Exports that _store.mjs does not re-export are internal to the _store-*.mjs family. */

import { randomBytes, randomUUID } from 'node:crypto';
import { opsLog } from './_ops.mjs';
import { HOUR_MS, sha256, strong } from './_store-core.mjs';

/* The address every limiter counts against.

   x-nf-client-connection-ip is set by the platform edge and cannot be spoofed
   from outside it. X-Forwarded-For is a fallback and has to be read from the
   RIGHT: the last element is what the nearest trusted hop appended, the first
   element is whatever the client typed. Reading it from the left, which this
   used to do, meant that on any deployment where the platform header was
   missing every limiter in the system was both free to evade and free to poison
   against a chosen victim.

   Reading from the right is not a guarantee either, only the least wrong
   reading of a header a proxy chain owns. It is a fallback for a header that is
   always present in production, and if it ever stops being present the failure
   should be visible rather than silent. */
export function clientIp(req) {
  const edge = (req.headers.get('x-nf-client-connection-ip') || '').trim();
  if (edge) return edge;
  const chain = (req.headers.get('x-forwarded-for') || '').split(',').map(x => x.trim()).filter(Boolean);
  return chain.length ? chain[chain.length - 1] : 'unknown';
}

/* The limiter's keys used to contain the caller's IP address in the clear, in a
   durable store, while the privacy page said the address "is used to look up
   that count and is then discarded". That was simply false, and an address is
   personal data under both regimes this site is written for.

   Keys now carry a hash. Be precise about what that buys: it is a pseudonym,
   not anonymity. The space of IPv4 addresses is small enough to enumerate, so
   somebody holding this store could confirm a guess. What it does buy is that
   the store is not a readable list of who used the site, and that nothing has to
   be redacted before it can be looked at. The privacy page says exactly this and
   no more.

   It also fixes a smaller thing: a raw IPv6 address contains colons, so
   `kind:2001:db8::1:` was a prefix of the keys for other addresses, and the
   stale-bucket sweep (`sweep` in _store-expiry.mjs) would have deleted them. A hex hash has no
   delimiters in it. */
export const ipKey = ip => sha256(networkOf(ip)).slice(0, 32);

/* WHAT IS COUNTED IS THE NETWORK, and for IPv6 that is not the address.

   An IPv4 address is scarce: a household or an office usually shares one. An
   IPv6 customer is routed a whole block, normally 2^64 addresses that all reach
   the same machine, so a limit counted per IPv6 address was no limit. An IPv6
   caller is therefore counted per block, the first IPV6_BLOCK_BITS bits of the
   address, and an IPv4 caller per address as before. For an IPv4 caller this
   returns the address as the platform wrote it, so the key is the one this file
   always produced and no IPv4 bucket moved when this shipped.

   The price is paid by people who share a block, a household or an office on one
   IPv6 network: they now share one budget, which is what the same people behind
   one IPv4 address always had. 64 bits is the size of one customer network. The
   constant is the dial, and a wider cut groups more neighbours.

   One address is one key however it is spelled: compressed or in full, upper or
   lower case, in brackets with or without a port, with a zone suffix. An IPv4
   address written as IPv4-mapped IPv6 (::ffff:192.0.2.1, dotted or in hex) is
   that IPv4 address. Outside global unicast (2000::/3) the full address is kept,
   because a /64 there is nobody's customer network: it is loopback, a private or
   link-local network, or IPv4 written inside IPv6, and cutting it would put
   unrelated callers into one bucket.

   Anything that does not parse as an address is keyed as the text it is, which
   is what every subject got before this function existed, and that is
   deliberate. Such text names no network, so there is no block to find, and
   mapping all of it to one shared key would let a single caller fill a bucket
   every other unparseable caller then shares. It can only arrive from a header
   the platform writes or from the forwarded-for fallback, and in the fallback a
   caller can name any valid address as easily as an invalid one. The limiter's
   other subjects, a passport id, a mailbox hash and the whole site, never parse
   as addresses and pass through unchanged; the tests pin that. */
export const IPV6_BLOCK_BITS = 64;

const OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])';
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);
const HEXTET = /^[0-9a-f]{1,4}$/;

/* Eight 16-bit groups, or null. Takes lower case with no brackets and no zone.
   Leading zeros in an IPv4 part are refused rather than read, because some
   readers take them as octal and some as decimal. */
function v6Groups(s) {
  let tail = [];
  if (s.includes('.')) {
    const cut = s.lastIndexOf(':');
    const v4 = cut === -1 ? '' : s.slice(cut + 1);
    if (!IPV4.test(v4)) return null;
    const b = v4.split('.').map(Number);
    tail = [(b[0] << 8) | b[1], (b[2] << 8) | b[3]];
    s = s.slice(0, cut + 1);
    if (!s.endsWith('::')) s = s.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const read = part => (part === '' ? [] : part.split(':'));
  const head = read(halves[0]);
  const rest = halves.length === 2 ? read(halves[1]) : [];
  if (![...head, ...rest].every(h => HEXTET.test(h))) return null;
  const given = head.length + rest.length + tail.length;
  if (halves.length === 2 ? given > 7 : given !== 8) return null;
  return [...head, ...Array(8 - given).fill('0'), ...rest].map(h => parseInt(h, 16)).concat(tail);
}

export function networkOf(ip, bits = IPV6_BLOCK_BITS) {
  const text = String(ip);
  let s = text.trim().toLowerCase();
  const bracketed = /^\[([^\]]*)\](?::[0-9]{1,5})?$/.exec(s);
  if (bracketed) s = bracketed[1];
  else {
    const withPort = /^([0-9.]+):[0-9]{1,5}$/.exec(s);
    if (withPort && IPV4.test(withPort[1])) s = withPort[1];
  }
  if (IPV4.test(s)) return s;

  const zone = s.indexOf('%');
  const g = v6Groups(zone === -1 ? s : s.slice(0, zone));
  if (!g) return text;

  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  }
  if ((g[0] & 0xe000) !== 0x2000) return `${g.map(h => h.toString(16)).join(':')}/128`;

  const block = g.map((h, i) => {
    const keep = Math.min(16, Math.max(0, bits - 16 * i));
    return keep === 0 ? 0 : h & ((0xffff << (16 - keep)) & 0xffff);
  });
  return `${block.map(h => h.toString(16)).join(':')}/${bits}`;
}

/* The subject a mail recipient is counted under, for the per-recipient ceiling
   in netlify/functions/send.mjs. The limiter's store never holds the address:
   it holds ipKey of this, a hash of a hash cut to 32 hex characters. Like the
   network hash above it is a pseudonym and not anonymity, since somebody
   holding the store and a guess could confirm the guess.

   Trimmed and lower-cased, and nothing else. No provider in practice treats
   case as a different mailbox, although the standard would allow one, and
   send.mjs only accepts ASCII addresses, so lower-casing has no locale to get
   wrong. Plus-tags and dots are left as typed on purpose: whether two spellings
   reach one mailbox is each provider's own rule, and guessing it is a bug in one
   direction or the other. The site-wide ceiling in send.mjs is what bounds a
   mailbox that has many spellings. */
export const mailboxKey = address => sha256(String(address).trim().toLowerCase());

/* The key, and the order of its parts is the whole design.

   It used to be `${kind}:${windowMs}:${iphash}:${bucket}:${uuid}`, which sorts
   by KIND. Listing is lexicographic, so the store's early pages were whatever
   kind sorted first — `bad-h` — and the sweeper, which reads a bounded number
   of pages, could never reach a dead `up-h` key behind four thousand live
   `bad-h` ones. Reproduced: 4001 live keys in front of 50 dead ones and the
   sweep returned zero, forever.

   Window first, then a zero-padded bucket, so the store sorts oldest-first
   within each window length and the pages the sweeper reads are exactly the
   pages worth reading. Padding matters: without it bucket 9 sorts after
   bucket 10.

   The bucket is also now part of the counting prefix rather than something to
   filter out afterwards, so counting lists one bucket instead of every bucket
   an address has ever had, and no caller has to sweep on the hot path. */
const BUCKET_PAD = 12;
export const limitPrefix = (ip, kind, windowMs) => {
  const bucket = String(Math.floor(Date.now() / windowMs)).padStart(BUCKET_PAD, '0');
  return `${windowMs}:${bucket}:${kind}:${ipKey(ip)}:`;
};

/* ── the limiter ────────────────────────────────────────────
   Rate limits live in the endpoint, per upload-validation.md §3. Source IP is
   trusted only as far as the platform edge: this is a speed bump, not identity.

   The mechanism, and an honest account of what it does and does not guarantee.

   Every attempt writes its OWN key and a key is never written twice, so there
   is no read-modify-write and no update to lose. That is the failure the
   previous counter had: two requests read the same n and both wrote n+1, so a
   simultaneous burst walked straight through a limit it had already spent.

   The order is write first, then count, so a request cannot count itself out of
   existence and any write the store has already published is in our count.

   What this does NOT give is atomicity, and an earlier version of this comment
   claimed it did. Netlify Blobs gives strong consistency on `get`; listing is
   eventually consistent whatever the store is configured with. So under a real burst
   two requests can each list before seeing the other's key and both be allowed.
   The bound on the overshoot is the number of requests in flight inside one
   listing's lag, and the count converges as soon as the writes are visible: the
   keys are all there, so the next request sees them and refuses. That is a
   materially better failure than the old one, which lost the writes permanently
   and could be walked through indefinitely. It is still best-effort, and §3
   already says this is a speed bump rather than identity.

   Keys are bucketed by window, every call sweeps the buckets it is not in for
   its own address, and sweepStale() (the sweep in _store-expiry.mjs) clears the buckets of addresses that
   never came back. The window length is in the key so the sweeper can tell a
   dead bucket from a live one without knowing which endpoint wrote it.

   Returns the key it wrote when the attempt is allowed and null when it is not,
   so `if (!(await rateLimit(...)))` still reads the way it always did. */
export async function rateLimit(deploy, ip, kind, limit, windowMs) {
  const store = strong(deploy, 'ratelimit');
  const prefix = limitPrefix(ip, kind, windowMs);
  const mine = `${prefix}${randomUUID()}`;

  try {
    await store.set(mine, '1');
  } catch {
    /* If the attempt cannot be recorded the limiter is blind, and a blind
       limiter must not silently pass traffic it is not counting.

       Almost every caller answers that null with a 429, "too many attempts"
       (upload.mjs's bad-h charge only skips its refund), so a
       Blobs write outage reads as the visitor's fault on the page and as
       nothing at all in the log. Hence one code-only line (audit,
       2026-10-22). The bucket name and nothing else: `ip` is an address, a
       passport id or a mailbox hash, depending on the caller. */
    opsLog('RATELIMIT_STORE_WRITE_FAILED', { bucket: kind });
    return null;
  }

  try {
    const { blobs } = await store.list({ prefix });
    return blobs.length <= limit ? mine : null;
  } catch {
    /* The write landed but the count failed. Allow this one rather than refuse
       an honest request on a storage hiccup; the next call re-counts and the
       key we just wrote is still in the bucket. */
    return mine;
  }
}

/* Give back one attempt.

   This is a dangerous little function and it earned its warning twice.

   The first time: it was called on the owner-review refusal, which is a path the
   caller controls with a header, so a client that simply omitted the
   acknowledgement could upload without limit forever. Sixteen 256 KB bodies
   fully validated, against a ceiling of five, for zero recorded attempts.

   The second time: the fix made the refund conditional on a server-minted
   ticket, which closed the unbounded hole but not the arithmetic. Alternating
   refuse-and-retry still bought two full validations per recorded attempt,
   because the refusal charged nothing of its own.

   So the rule, and it is the rule for any future caller:

     A REFUND MUST BE ACCOMPANIED BY A CHARGE SOMEWHERE ELSE.

   Moving an attempt from one ceiling to another is fine. Removing one is not,
   whatever gate it happens behind. */
export async function refundLimit(deploy, key) {
  if (!key) return;
  await strong(deploy, 'ratelimit').delete(key).catch(() => {});
}

/* ── the duplicate guard ────────────────────────────────────
   Identical body twice within an hour is a duplicate, per §3.

   Keys are `${hourBucket}:${fingerprint}` rather than the fingerprint alone, for
   two reasons. It lets the sweeper drop a whole dead hour by key name, and the
   old form left one permanent key per upload ever made, which the privacy page's
   list of what publishing stores did not mention and which outlived deletion.

   Read-modify-write is fine here and is not the limiter's problem: the failure
   mode is that two simultaneous identical uploads both succeed and the sharer
   gets two links to the same passport, which is a mild annoyance. */
export const fpKey = (fingerprint, bucket) => `${bucket}:${fingerprint}`;

/* ── THE CHECK AND THE CLAIM ARE TWO FUNCTIONS, AND THEY USED TO BE ONE ────
   `seenRecently()` read the key AND wrote it, and its caller ran it before
   `createPassport()`. So a storage failure at publish left the fingerprint
   claimed for a passport that does not exist: the sharer was told nothing was
   published, retried the same file inside the hour, and got 409 E_DUPLICATE,
   whose message is "use the link you already have" when there is no link to
   have. Both attempts also paid the failure ceiling. One transient blob error
   locked a file out for up to an hour and told the person it had worked.
   ROW-128.

   THE FIX IS ORDER, NOT ERROR HANDLING, and the alternative is worth naming
   because it is the obvious one. Deleting the key in upload.mjs's E_INTERNAL
   catch would also work — while the catch runs. What kills a serverless
   function is running out of time, and `.catch()` does not catch that.
   upload.mjs already says exactly this, twice, in the comments explaining why
   the sweep moved off the publish path and why the metrics row is written
   ahead of the write. A fix that depends on a catch running is defended by the
   one mechanism this file documents as unreliable.

   So: check before the expensive work, claim only once the passport exists.

   WHAT THAT COSTS, stated rather than discovered, and CORRECTED TWICE because
   the first two versions were wrong in opposite directions.

   The window in which two identical uploads can both pass the check widens
   from `seenRecently`'s own read-then-write to the whole of `createPassport`.
   The first version of this paragraph called the old window a
   "read-modify-write race", which reads as instantaneous and was not: it was
   already one or two `get`s and a `setJSON`, so round trips either way. The
   honest statement is that the window roughly doubles, from about one store
   operation to about two, not that it goes from nothing to everything.

   NO NUMBER IS QUOTED AND THAT IS DELIBERATE. The only measured per-operation
   figure this repository has is 310 ms, in
   record/findings/one-production-store-op-costs-310ms.md, and that document's
   own scope section says it was measured on a `get` that MISSES and that `set`
   was never measured, direction of error unknown. Doubling an unmeasured
   number produces a more confident wrong number. Under the exact condition
   this fix exists for, a store degraded rather than dead, it is unbounded
   upward anyway: the same finding records a 5290 ms worst-case `upload`
   invocation over seven days.

   The OUTCOME of the widened race is unchanged and was already accepted above:
   both succeed, the sharer gets two links to one passport, a mild annoyance.

   AND A LOST CLAIM IS NOT FREE, WHICH IS WHAT THIS PARAGRAPH USED TO SAY.
   It said "the claim can be lost without harm" and "the failure mode of a
   missing claim is the mild one". A critic showed that is false, and it is the
   sentence someone would have reasoned from later, so it is corrected here
   rather than deleted.

   Trace it properly. If the function dies after `createPassport` and before the
   claim, the passport EXISTS, its delete token was in a response that never
   arrived, and the sharer saw a failure and will try again. Before this change
   the claim was already written, so that retry hit 409 inside the hour and no
   second passport was made. Now the retry publishes. Under repeated timeouts —
   again, the condition this fix exists for — each retry mints another passport
   that is public, undeletable and unrenewable for thirty days. The old order
   was accidentally capping that at one orphan per file per hour, and this
   removes the cap without replacing it.

   It is still the right trade, and the reason is that the same accidental cap
   is what produced the hour-long lockout in the far commoner throw-fast case,
   which is the actual ROW-128. But a lost claim costs one live link the sharer
   cannot delete, plus one orphan per timed-out retry, on a site whose privacy
   page promises deletion. It does not cost "the same mild thing". */
export async function seenRecently(deploy, fingerprint) {
  const store = strong(deploy, 'fingerprints');
  const now = Date.now();
  const bucket = Math.floor(now / HOUR_MS);
  try {
    for (const b of [bucket, bucket - 1]) {
      const cur = await store.get(fpKey(fingerprint, b), { type: 'json' });
      if (cur && now - cur.at < HOUR_MS) return true;
    }
  } catch { /* treat a read failure as not-seen; the ceiling is the rate limit */ }
  return false;
}

/* Call this ONLY after the passport exists. It never throws: a claim that fails
   costs a possible duplicate link, and letting it fail a publish that has
   already happened would lose a delete token that exists nowhere else.

   THE BUCKET IS AN ARGUMENT AND IT USED TO BE A SECOND CLOCK READ, which was a
   bug a critic found and which existed before ROW-128 as well as after it.
   `createPassport` records `fingerprint_bucket` from ITS `Date.now()`, and
   `purge()` deletes exactly `fpKey(row.fingerprint, row.fingerprint_bucket)`.
   When this function took its own reading, an hour boundary falling between
   the two put the claim in bucket N+1 while the row said N. The delete then
   removed a key that was never written, `deletePassport` returned TRUE, and
   the same file was refused 409 "use the link you already have" for the rest
   of the hour — with no link to have, which is ROW-128's own failure reached
   through the delete path instead of the publish path.

   Reproduced by stepping `Date.now()` 50 ms either side of an exact hour
   boundary: row bucket 496758, claimed key 496759, keys after a successful
   delete 1, still seen true.

   Passing the row's bucket makes the claimed key and the deleted key the same
   key by construction rather than by the two clock reads landing in the same
   hour. */
export async function claimFingerprint(deploy, fingerprint, bucket) {
  if (!Number.isFinite(bucket)) {
    throw new TypeError('claimFingerprint needs the bucket createPassport recorded');
  }
  try {
    await strong(deploy, 'fingerprints').setJSON(fpKey(fingerprint, bucket), { at: Date.now() });
  } catch { /* a duplicate guard is worth less than a publish */ }
}

/* ── the owner-review ticket, and ROW-228's write-consent ticket ───────
   Two gates now mint tickets through these three functions: the owner-review
   gate below, unchanged in shape, and upload.mjs's write-consent gate for a
   browser passport carrying a declared-only marker. Both share one store and
   one TTL because both are "this request is downstream of a refusal we
   issued", not because they mean the same thing.

   THE GATE IS MEANT TO BE UNSKIPPABLE, and it was not: the retry carried a
   fixed header string, which any client can simply send on the first request.
   That made the word wrong AND made the refund on the refusal path free to
   abuse, because a client could keep triggering the refunded 409 forever.

   So the 409 now mints a one-shot ticket, tied to the exact body it refused and
   to the rate-limit attempt it charged for. The retry must present that ticket.
   A client cannot invent one, the ticket is consumed on use, and it expires. The
   refund happens only when a real ticket is consumed, so one publish still costs
   one attempt however many round trips it took, and nobody can buy free
   validation runs with a header. */
export const ACK_TTL_MS = 15 * 60e3;

/* The record is keyed on the ticket AND the body together, so the body's hash
   is not stored at all: a request presenting the wrong body computes a key that
   is not there. The earlier version stored the fingerprint in the value, which
   meant a passport somebody looked at and declined to publish left a hash of
   their file on our disk, on a path where nothing was published, against a
   privacy page that lists what publishing stores.

   The bucket in front of it is what lets sweep() clear this store by key name.
   Nothing here had a sweeper, and the fifteen-minute TTL was enforced on read
   only, so a user who hit the stop and closed the tab left the record forever. */
const ackBucket = at => Math.floor(at / ACK_TTL_MS);
const ackKey = (ticket, fingerprint, bucket) =>
  `${bucket}:${sha256(ticket + '.' + fingerprint)}`;

/* `reason` is required, not optional, and is the second critic's fix on the
   sequential ROW-228 draft: reused as a bare ticket, a ticket minted by one
   gate's refusal satisfied the other gate too, so an `owner_confirmed: false`
   passport could publish on the write-gate's say-so or vice versa. Every
   caller now states which gate it is minting for — 'owner_review' or
   'write_consent' — and readAck's caller must check it matches before
   treating the ticket as valid for that gate. */
export async function mintAck(deploy, fingerprint, chargedKeys, reason) {
  const ticket = randomBytes(18).toString('hex');
  const at = Date.now();
  await strong(deploy, 'acks').setJSON(ackKey(ticket, fingerprint, ackBucket(at)), {
    charged: chargedKeys.filter(Boolean),
    at,
    reason
  });
  return ticket;
}

/* THE CHECK AND THE BURN ARE TWO FUNCTIONS, FOR THE REASON ROW-128 IS ABOUT.

   `consumeAck` used to read the ticket AND delete it, and its caller ran it
   before `createPassport`. That is the same shape as the fingerprint defect
   this file's other half documents, and a critic found it in the commit whose
   header claimed to have enumerated every write on this path. Trace it: an
   unconfirmed passport presents a valid ticket, the ticket key is deleted, the
   publish then fails, and the retry with the same ticket is refused
   E_OWNER_UNCONFIRMED again, pays the failure ceiling again, and is handed a
   fresh ticket. Milder than the hour-long lockout, because a third round trip
   does publish, but the same structure: a one-shot claim spent on a success
   that had not happened.

   So `readAck` reads and `burnAck` deletes, and the delete happens after the
   passport exists. What it costs, stated: a ticket presented twice
   concurrently now buys two publishes rather than one. That is the same trade
   already accepted for the duplicate guard above, and it is the mild direction.

   Returns the key alongside the refunds, so the caller burns exactly the key
   that was read rather than recomputing it against a clock that may have
   crossed a bucket boundary in between. */
export async function readAck(deploy, ticket, fingerprint) {
  if (!/^[0-9a-f]{36}$/.test(ticket || '')) return null;
  const store = strong(deploy, 'acks');
  const now = Date.now();

  /* Current bucket and the one before it, so a ticket minted at 14:59 still
     works at 15:01. Older than that is past the TTL anyway. */
  for (const bucket of [ackBucket(now), ackBucket(now) - 1]) {
    const key = ackKey(ticket, fingerprint, bucket);
    let rec;
    try { rec = await store.get(key, { type: 'json' }); } catch { continue; }
    if (!rec) continue;
    if (now - rec.at > ACK_TTL_MS) {
      /* Expired: burn it here. There is no future success to wait for, and
         leaving it would keep a dead record until the sweeper runs. */
      await store.delete(key).catch(() => {});
      return null;
    }
    return { key, charged: rec.charged || [], reason: rec.reason || null };
  }
  return null;
}

/* Call this ONLY after the passport exists, and it cannot throw, for the same
   reason claimFingerprint cannot: it runs after a delete token has been minted
   that exists nowhere but the response. */
export async function burnAck(deploy, key) {
  if (!key) return;
  try { await strong(deploy, 'acks').delete(key); } catch { /* a spent ticket is cheap */ }
}

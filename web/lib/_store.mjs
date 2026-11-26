/* Storage on Netlify Blobs. The public face of the _store-*.mjs family.

   This file used to hold all of it. It is now a barrel: every name an importer
   could reach before is re-exported from here, unchanged, and nothing else is.
   The modules are the real boundary; edit one of them, not this file, unless
   the public surface itself is changing.

   Modules, lowest first. A module imports only from modules earlier in this
   list, so there are no cycles:
     _store-core       store factory and test seam, deployScope, strong(), sha256, UUID, drop/scan
     _store-listing    a passport's gallery listing: keys, listedMeta, category, card, dropListing
     _store-ratelimit  the upload gate: address keys, rateLimit, fingerprints, ack tickets
     _store-metrics    the corpus: recordMetrics / recordRejection / recordJev, digest claim
     _store-counters   views, copies, prompt-copy clicks
     _store-expiry     TTL, the expiry index, purge, sweep
     _store-votes      readVotes, castVote, recount
     _store-passport   create / read / authorise, delete, status, renew, delete tokens
     _store-gallery    listPassport, unlistPassport, listGallery
     _store-holds      held uploads, sweepHolds
     _store-scopes     preview-scope teardown (sweepScopes) and its dry-run report
     _store-takedown   operator unlist and delete by id, without the token (tools/takedown.mjs)
     _store-backup     export and restore of the durable bare stores (tools/backup-stores.mjs)

   Every store is catalogued here, and each module's header lists the stores it
   opens. The two
   paragraphs that used to surround this catalog moved next to the code they
   explain: the token-minting deviation note into _store-passport.mjs, and the
   view-counter note into _store-counters.mjs.

   The stores, deliberately separate (this list said "five" until the gallery
   landed, while nine existed; it now names all of them):
     passports    the row and the body. Its blob metadata carries the token hash
                  and the expiry, so a token can be checked without reading a
                  10 KB body, which is what keeps a wrong token from taking
                  measurably longer than a missing passport. A listed row also
                  carries `g: 1` and its generation `gg` there; see _store-gallery.mjs.
     views        one integer per passport, written on every page load
     copies       one integer per passport, bumped when somebody presses the
                  copy control on its page; same rules as views
     expiry       one empty key per passport, named for when it dies, so the
                  sweeper can find dead passports from key names alone. A
                  listed passport has no entry here, which is why the sweeper
                  never reaches it.
     fingerprints the duplicate guard, bucketed by hour so it clears itself
     ratelimit    one key per attempt, see the note on the limiter in _store-ratelimit.mjs. A
                  send's per-recipient keys carry a hash of the recipient's
                  address, never the address; see mailboxKey
     metrics      one row per publish, never swept, see recordMetrics
     attempts     one row per refused upload, never swept, see recordRejection
     acks         the owner-review tickets, see _store-ratelimit.mjs
     digest       the once-a-day claim the digest mail makes, see claimDigestDay
     gallery      one card per listed passport, what the gallery page reads
     gallery-categories  category changes per listing generation; the original
                         category stays on the row as the fallback
     votes        one key per (passport, listing generation, voter), value "1" or "-1"
     votes-count  the up and down tally per listing generation
     jev          one row per upload for which the Jev check ran (day:uuid,
                  never swept, see recordJev in _metrics.mjs); pre-existing,
                  not added to this list when it landed, fixed here.
     holds        a held upload (PH-507's `hold` disposition): the full
                  passport text and derived record a human has to review, the
                  Jev result that triggered it, and a token hash checked the
                  same way delete_token_hash is. NOT the owner's address any
                  more: see hold-email.
                  Keyed by a fresh hold id, never the passport id -- no
                  passport exists yet. 5 days, then swept by sweepHolds(),
                  same shape as the passport sweep: text and email deleted
                  together, in the same operation, so neither outlives the
                  other. See _store-holds.mjs.
     hold-email   the optional address an owner left on a held upload, one
                  key per hold id, `{ email }`. Its own store, not a field of
                  the hold row, because a save that read the row and wrote it
                  back could bring a refused, released or swept hold back to
                  life with its text and no expiry-index key (PH-518 critic
                  r1). Written only by attachHoldEmail, which re-reads the
                  hold afterwards and takes the address out again if the
                  hold is gone; deleted by endHold, always AFTER the
                  hold row, and by sweepHolds for a hold whose row is
                  already gone. The address is used for one message, the
                  release, refusal or expiry mail, and then deleted.
     hold-expiry  one empty key per hold, named for when it dies, exactly
                  parallel to `expiry` above but a separate index: a hold id
                  and a passport id are different id spaces, and sweepHolds()
                  must never be able to reach into `passports` by mistaking
                  one for the other.
     hold-pointers  what survives a hold's own row after release: `{ id }`,
                  the published passport's id, and nothing else -- no text,
                  no email, no score. Written by releaseHold before it
                  deletes the hold row, so checkHold can still answer a
                  returning owner once there is no hold left to read. Not
                  written on refusal, which has nothing to point at. ALWAYS
                  expires in 30 days via hold-pointer-expiry, swept by
                  sweepHolds() alongside the hold rows themselves, gallery
                  release or not: the passport it points at may be lifetime
                  ("gallery is lifetime" is Raffael's ruling about the
                  passport), but this row is document-plus-judgement --
                  which of our public passports our own check once
                  flagged -- with the identity already gone, and a version
                  that never expired for gallery releases made that fact
                  permanent and growing forever with no retention decision
                  ever made about it. See "held uploads" below.
     hold-pointer-expiry  one empty key per pointer that will expire, same
                  shape as hold-expiry, written for every pointer with no
                  exception.
     prompt-clicks  one key per press of the copy control on /create, keyed
                  "f:<uuid>" or "w:<uuid>" for whichever capture path
                  (folder-on-your-computer or browser-chat) a visitor
                  copied, counted by listing rather than by a single
                  get-then-increment key — see the comment on
                  bumpPromptCopy for why the two counters above's shape
                  loses writes here specifically. Hangs off neither a
                  passport id nor any other entity, so there is nothing to
                  look up and no existence check before the write. Not
                  named create-copies: that name shares a dash-joined
                  suffix with the copies store above and a future preview
                  whose deploy id or branch happened to end "...-create"
                  would have collided with it under a different preview's
                  copies store at the identical physical name — narrow (the
                  Netlify context has no branch field today, only id) and
                  preview-only, but free to avoid by not choosing a store
                  name ending in "-" + an existing one.

 */

// _store-core
export {
  __useStoreFactory,
  deployScope,
  __forgetRegistrations,
  seenKey,
  scopeKey,
  parseSeenKey,
  sha256,
  UUID
} from './_store-core.mjs';

// _store-listing
export {
  listedMeta
} from './_store-listing.mjs';

// _store-ratelimit
export {
  clientIp,
  ipKey,
  IPV6_BLOCK_BITS,
  networkOf,
  mailboxKey,
  limitPrefix,
  rateLimit,
  refundLimit,
  seenRecently,
  claimFingerprint,
  mintAck,
  readAck,
  burnAck
} from './_store-ratelimit.mjs';

// _store-metrics
export {
  recordMetrics,
  recordRejection,
  recordJev,
  getDay,
  readCorpusDay,
  claimDigestDay
} from './_store-metrics.mjs';

// _store-counters
export {
  readViews,
  bumpViews,
  readCopies,
  bumpCopies,
  PROMPT_COPY_PATHS,
  readPromptCopies,
  bumpPromptCopy
} from './_store-counters.mjs';

// _store-expiry
export {
  TTL_DAYS,
  RENEW_DAYS,
  expiryFrom,
  VIEWS_SLICES,
  SWEEP_BUDGET_MS,
  EXPIRY_SHARE,
  sweep
} from './_store-expiry.mjs';

// _store-votes
export {
  readVotes,
  castVote,
  recount
} from './_store-votes.mjs';

// _store-passport
export {
  mintDeleteToken,
  createPassport,
  readPassport,
  hashMatches,
  tokenMatches,
  authorise,
  deletePassport,
  statusOf,
  renewPassport
} from './_store-passport.mjs';

// _store-gallery
export {
  listPassport,
  unlistPassport,
  listGallery
} from './_store-gallery.mjs';

// _store-holds
export {
  HOLD_TTL_DAYS,
  createHold,
  checkHold,
  attachHoldEmail,
  HOLD_MAIL_TIMEOUT_MS,
  releaseHold,
  REFUSAL_REASON_MAX,
  refuseHold,
  listPendingHolds,
  readHold,
  sweepHolds,
  HOLD_SWEEP_BUDGET_MS
} from './_store-holds.mjs';

// _store-scopes
export {
  SCOPED_STORE_NAMES,
  SCOPE_ABANDON_MS,
  SCOPE_SWEEP_BUDGET_MS,
  sweepScopes,
  UNREACHED_NAMES_CAP,
  dryRunFingerprint,
  dryRunSetChanged,
  dryRunCursor,
  saveDryRunCursor,
  dryRunReport
} from './_store-scopes.mjs';

/* Operator-only from here down, like releaseHold and refuseHold above: the
   tools in web/tools call these with real credentials, and no endpoint does
   (tools/takedown.test.mjs fails if one starts to). */

// _store-takedown
export {
  operatorUnlist,
  operatorDelete
} from './_store-takedown.mjs';

// _store-backup
export {
  BACKUP_STORES,
  NOT_BACKED_UP,
  BACKUP_NOTICE,
  exportStores,
  serialiseBackup,
  parseBackup,
  restoreStores
} from './_store-backup.mjs';

/* Moved to `_row.mjs` 2026-09-29 (imported at the top of this file, re-
   exported here) so no call site in this file (or anywhere else, checked
   first) had to change its import path. A bare `export { isExpired } from
   './_row.mjs'` here instead of an import-then-re-export forwards the name to
   outside importers but binds nothing locally, and this file calls
   isExpired directly at multiple sites below — that version threw
   ReferenceError at every one, caught by run-tests.mjs. See _row.mjs's
   header for why this predicate cannot live where it can import the store:
   _render.mjs, which also needs it, must stay importable with no Netlify
   runtime present.

   2026-09-29, when this file became a barrel: the sentence above about this
   file calling isExpired directly now describes the _store-*.mjs modules, not
   this file. Each module that calls it imports it from ./_row.mjs itself; the
   bare re-export below is for outside importers only, and binds nothing here. */
export { isExpired } from './_row.mjs';

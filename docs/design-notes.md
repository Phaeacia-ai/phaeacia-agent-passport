# Design notes for the hosted app

Comments in `web/` cite three planning documents by name and section number:
`WEBSITE-SPEC.md`, `BACKEND-PLAN.md` and `GALLERY-SPEC.md`. They were working
documents, written for the people and agents building the app, and they are not
published. This page records what each one settled, so that a comment citing one has
somewhere to land. A fourth, `CORPUS-PLAN.md`, proposed work that was never built and
is summarised at the end.

The code is the record of what exists. Where this page and the code differ, the code
is right. `web/README.md` describes the mechanisms in detail.

## WEBSITE-SPEC: the brief for the web build

The product in one sentence: upload a passport file, get a page with a link, optionally
have the link emailed to the recipient, and be able to delete it at any time.

Its rules, each of which the app kept:

1. **Nothing is gated behind an email address.** Creating, viewing, copying and
   deleting all work anonymously.
2. **Pages expire by default**, after thirty days, renewable from the management page.
3. **No enumeration.** Identifiers are unguessable, and a deleted, an expired and a
   never-existing page are indistinguishable by status, body and headers.
4. **Analytics on metadata only**, never on passport body text.
5. **No secrets.** An upload that looks like it carries a credential is refused with
   the reason.

Its section 3 asked for the email step in a particular shape; `web/lib/_email.mjs`
records where and why the app deviates from it. Accounts, versions and a gallery were
out of scope for that brief; the gallery was built later.

## BACKEND-PLAN: measurement and storage (August 2026)

**Purpose of the measurement.** Learn what shape of agent people actually capture, so
the next thing built answers to that rather than to a plan. Nothing about a person,
no growth or funnel measurement.

**Section 2, the record.** One record per publish, derived without a model from what
the gates already compute: the capability ids, the trigger kind, `comparison_mode`, the
number of golden examples, and counts from the consent table and the functional spec.
Deliberately excluded: the passport id, title, summary and name, `source_stack`, the
capture date, the body hash, the IP hash, any time finer than a day, and page views.
Every string in a record is a vocabulary id, a spec enum or a date. The record has no
key that joins it to its passport, so it is not deleted with the passport.

**Section 4, storage.** Netlify Blobs, a separate `metrics` store keyed by day and a
random id, rather than a database. The plan weighed Supabase and rejected it for this
use: on the free plan, as its pricing page read on 2026-08-10, a project paused after
a week of inactivity, and the publish path, the only writer, would have met a sleeping
database exactly in the quiet periods the measurement was for. The record is written
before the passport is stored and its failure never fails a publish.

**Section 5, the rest of the backend.** Email through Resend, staying on its free tier
until a rate-limit error showed it was needed; the behaviour at larger volumes; and what
sharing would need that did not exist yet. `web/README.md` has what was built.

## GALLERY-SPEC: the public gallery (September 2026, version 0.1.1)

**Decisions (section 0).**

| question | answer |
|---|---|
| where it lives | `/gallery`, served by a function from Blobs, no static generation |
| expiry | a listed passport does not expire; the owner agrees to that when listing |
| moderation | none; a listed passport appears immediately; takedown is a store operation run by hand (section 12) |
| votes | up and down, anonymous, one per browser per listing |
| comments | not built |
| category | one required pick from a fixed list, asked only when listing (section 5; the list is `web/lib/_categories.mjs`) |
| indexing | listed passport pages and `/gallery` are indexable; unlisted pages stay `noindex` |
| listing later | from `/manage` with the delete token, and unlisting too |
| delete | deleting a passport removes it from the gallery with its votes |
| copies | presses of the copy control are counted and labelled "copied", never "installed"; the installer never reports back (section 7b) |

**Section 2, the data model.** A gallery entry is the passport's own row with a flag,
not a second copy of the body, because two objects drift. The rest of the document
specifies listing at publish (3), listing from `/manage` (4), the page (6), votes (7),
rate limits and error codes (8), the wording each page that makes a promise had to
change (9), and the checks run before the work counted as done (11).

## CORPUS-PLAN: reading the corpus (not built)

A proposal from August 2026 for learning from published passports in three tiers:
structure, which the BACKEND-PLAN record already provides; purpose, one question at
capture once the gallery existed; and verbatim retention of passports past their
expiry, opt-in only. The third tier was not built. Its stated precondition was never
met: nothing in a stored passport proves that it was scrubbed. The thirty-day expiry
stayed as it was.

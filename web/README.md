# Agent Passport web app

**Archived.** Phaeacia built the Agent Passport web app in 2026 and no longer develops it. It is
published as-is under the Apache License 2.0 so the work stays available to study, run and fork.
There is no support, no roadmap and no security fixes.

This directory is the app that ran at `app.phaeacia.ai`: the page a recipient opens to read and
install an agent passport, the flow for publishing one, a public gallery of listed passports,
management and deletion by token, and the legal pages. It runs on Netlify: static pages, Netlify
Functions for everything dynamic, and Netlify Blobs for storage. There is no database and no
account system.

Phaeacia keeps its own instance up in **archive mode** (below): it shows what was published and
accepts nothing new. A copy you deploy yourself runs the full app unless you turn that mode on.

## How it works

1. **Publish.** `POST /api/upload` takes one Markdown passport file. `lib/_validate.mjs` checks
   transport, frontmatter, the six sections, the capability vocabulary, credential-shaped strings,
   HTML and active content; `lib/_derive.mjs` derives the stored record (title, summary, the
   consent table as structured rows). A passport whose `owner_confirmed` is false is refused once
   with a one-shot ticket that the retry must present. On success the response carries the link,
   a delete token (160 random bits, shown once, only its sha256 stored) and a manage link.
2. **Read.** `GET /p/<id>` renders the stored passport (`lib/_render.mjs`) as a paged travel
   document plus an install block per assistant, assembled in the browser from `assets/installer/`.
   A deleted, expired and never-existing id all get the same 404, byte for byte.
3. **Expire.** An unlisted passport expires 30 days after it was published or last renewed. Past
   that date every read treats it as absent, and the hourly sweep deletes it.
4. **List.** An owner can list a passport in the gallery, at publish or later from `/manage`. A
   listed passport does not expire. Visitors vote up or down, one vote per browser, identified by
   one signed cookie (`pv`), the only cookie the app sets.
5. **Withdraw.** The delete token deletes the passport at once, with everything stored about it.
   Unlisting puts it back on the 30-day clock.

`lib/` holds the shared code and sits outside `netlify/functions/` on purpose: Netlify turns every
top-level file in the functions directory into an endpoint.

## Routes

Pages: `/` and `/create` (the create page, twins kept identical by `tools/check-html-twins.py`),
`/upload`, `/gallery`, `/p/<id>` (including `/p/example`, a synthetic specimen), `/manage`,
`/delete`, `/about`, `/changelog`, `/privacy`, `/imprint`. Netlify serves `x.html` at `/x`;
`/p/<id>` and `/gallery` are rendered by functions. `about.html` section 05 is the human-readable
route table and `tools/check-route-table.py` checks it against the code.

| endpoint | function | what it does |
|---|---|---|
| `POST /api/upload` | `upload.mjs` | validate and publish a passport |
| `POST /api/delete` | `delete-passport.mjs` | delete with the token |
| `POST /api/manage` | `manage.mjs` | `status`, `renew`, `list`, `unlist` with the token |
| `GET, POST /api/send` | `send.mjs` | mail the link to one recipient through Resend |
| `GET, POST /api/subscribe` | `subscribe.mjs` | add an address to a Resend segment, with consent |
| `POST /api/vote` | `vote.mjs` | vote on a listed passport, JSON or a plain form |
| `POST /api/copied` | `copied.mjs` | count a press of the copy control on a passport page |
| `POST /api/copied-prompt` | `copied-prompt.mjs` | count a copy of a capture prompt on `/create` |
| `POST /api/check-hold` | `check-hold.mjs` | status of an upload held for review |
| `POST /api/hold-email` | `hold-email.mjs` | leave an address for a held upload's outcome |
| `GET /gallery.json` | `gallery-json.mjs` | listed cards as versioned JSON (consumed by phaeacia.ai) |
| `GET /og/<id>.png` | `og.mjs` | per-passport social card, rendered with satori and resvg |
| hourly | `sweep.mjs` | delete expired passports, holds and limiter keys |
| hourly | `recount.mjs` | rebuild vote tallies and gallery cards, clean orphans |
| none | `digest.mjs` | a daily summary mail; ships unscheduled and off |
| every page | `netlify/edge-functions/count.ts` | anonymous page counter, production only |

Every endpoint a page calls to change something refuses a request that a page on another site sent
(`lib/_origin.mjs`), and every endpoint is rate limited per network (an IPv4 address or an IPv6
/64). The limits are in each function.

## Storage

Netlify Blobs only. The stores are listed in `SCOPED_STORE_NAMES` in `lib/_store-scopes.mjs`
(22 at the time of archiving), and `tools/check-store-split.mjs` checks that list against every
store the code opens. `lib/_store.mjs` is the one entry point; the `_store-*.mjs` modules behind
it are split by concern (passports, expiry, gallery, votes, counters, holds, rate limits, metrics).

- A passport row and its view and copy counters live in separate stores, so a late counter write
  cannot resurrect a deleted row.
- The `expiry` store holds one empty key per unlisted passport, named for the moment it dies, so
  the sweep finds dead passports with a key listing. The sweep re-reads the row before deleting.
- `metrics`, `attempts`, `jev` and `prompt-clicks` keep one row per publish, refusal, classifier
  call or prompt copy: vocabulary ids, enums, scores and a date, never passport text and no key that
  joins a row to a passport. They are not swept.
- Deploys other than production read and write separately scoped stores (`lib/_store-core.mjs`),
  so a deploy preview never touches production data. The sweep lists abandoned preview scopes and,
  while `SCOPE_SWEEP_DRY_RUN` in `sweep.mjs` is true, deletes none of them.

## Configuration

Set these as Netlify environment variables. Every one is optional; without it the feature it
drives is off and the rest of the app works.

| variable | what it does |
|---|---|
| `ARCHIVE_MODE` | `1` turns on archive mode (below). Unset, empty, `0`, `false`, `off` or `no` leave it off; any other value turns it on. Needs the Builds and Functions scopes. |
| `VOTE_SECRET` | HMAC key for the vote cookie. Without it every vote fails closed. Use a long random string. |
| `RESEND_API_KEY` | Resend key. Without it `/api/send` answers `enabled: false` and no mail is ever sent. |
| `MAIL_FROM` | sender, on a domain verified in Resend, e.g. `Agent Passport <passport@example.com>`. The built-in default is Phaeacia's address, which your Resend account cannot send as. |
| `MAIL_REPLY_TO` | optional reply address |
| `MAIL_API_BASE` | points mail at a local mock for tests; never set in production |
| `SUBSCRIBE_SEGMENT_ID` | Resend segment for the "keep me posted" box; with `RESEND_API_KEY` it switches the box on |
| `TYPESAFE_API_KEY` | key for an optional third-party classifier (TypeSafe's Jev model, `lib/_jev.mjs`) that scores each upload's consent table and suspected secrets. Unset, no upload text leaves the server. |
| `JEV_DISPOSITION`, `JEV_CUTOFF`, `JEV_SECRET_DISPOSITION`, `JEV_SECRET_HOLD` | what the classifier's score does: `off` (log only, the default), `refuse`, or `hold` for a person to review; thresholds in (0, 1] |
| `HOLD_ALERT_TO` | address told when an upload is held. `hold` falls back to `off` without it. |
| `DIGEST_TO` | recipient of the daily digest; the digest also needs a `schedule` added in code |
| `CONTACT_EMAIL`, `ENTITY_NAME`, `LEGAL_FORM`, `REGISTER_OFFICE`, `REGISTER_NUMBER`, `VAT_NUMBER` | filled into the imprint and privacy page at deploy by `tools/substitute.py`; unset ones render as visible placeholders |
| `NODE_VERSION` | set it to 20.10 or later on the site; `passport.mjs` uses JSON import attributes |

Netlify applies environment variables per deploy, so a change takes effect with the next deploy.

## Archive mode

`ARCHIVE_MODE=1` makes the app a read-only showcase. The code is `lib/_archive.mjs`; each function
reads the flag on every request.

| part | in archive mode |
|---|---|
| `upload` | `410`, body `{ ok: false, code: "archived", message }`; the message names the GitHub repository and says the uploader's file is unchanged on their machine. Nothing is stored and no limiter key is written. The capture skill's `publish.py` relies on the 410. |
| `vote` | `410 archived` for JSON; the no-script form redirects back to the page. No vote, no cookie. |
| `manage` | `list` and `renew` answer `410 archived`; `status` and `unlist` work as before |
| `send`, `subscribe` | `GET` says `enabled: false`, so no page draws the box; `POST` is `410 archived` |
| `hold-email` | `410 archived`, so no new address is stored |
| `copied`, `copied-prompt` | `410`, nothing counted |
| `passport` | served with the archive notice; the vote control becomes a read-only tally; no view is counted |
| `gallery` | served with the notice; the same cards, tallies instead of vote controls, no invitation to publish |
| `gallery-json`, `og`, `check-hold` | unchanged |
| `delete-passport`, takedown tools | unchanged: an owner can always delete |
| `sweep` | unchanged deletion; the "your held upload expired" mail is withheld and counted as `holdMailsWithheld` |
| `recount` | unchanged (it repairs cards and cleans up after unlists and deletes; it sends nothing) |
| `digest` | sends nothing and claims no day |
| edge `count.ts` | writes nothing |
| static pages | `tools/archive-dist.mjs`, run in the Netlify build, adds the notice to every page in `dist/` and replaces the create and upload forms with a short "Agent Passport is archived" page. `manage.html` hides send, list and renew through `data-archive-hide`. |

Archive mode changes no retention rule. Unlisted passports keep expiring and being deleted, so
every unlisted link is gone within 30 days of switching it on, because none can be renewed.
Listed passports do not expire, so the gallery stays as it is until owners unlist or delete their
own, or the operator takes one down. `gallery.json` answers byte for byte as it does with the flag
off; a test pins that.

To preview the static half locally, build `dist/` and run
`ARCHIVE_MODE=1 node tools/archive-dist.mjs dist`.

## Run it locally

Node 20.10 or later and Python 3.

```bash
cd web
npm ci
./build.sh             # generates assets/installer/ and assets/example.json, then runs every check
npx netlify dev        # serves this directory and the functions on one port
```

`build.sh` copies the installer text from `../installer/`, the judge prompt from
`../verification/judge-prompt.md` and the browser capture prompt from `../capture/path-w-prompt.md`,
so run it from a full checkout. `netlify dev` serves the source pages; without `VOTE_SECRET`
voting fails closed and without `RESEND_API_KEY` sending is off, which is a normal local setup.
`npx netlify dev` downloads the Netlify CLI on first use, which is not a dependency of this
package; in November 2026 the current CLI declared Node 22.13 or later.

## Tests

All of these run from `build.sh` and need no network and no credentials:

```bash
node tools/check-store-split.mjs              # the store modules and every store they open
node --test tools/*.test.mjs                  # lib/, against an in-memory blob store
node --test tools/run-endpoint-tests.mjs      # every function, called as a handler
node --test tools/run-og-tests.mjs            # the social card renderer, for real
node --test tools/run-og-bundle-test.mjs      # the og function as Netlify's bundler packs it
node tools/parity.mjs                         # this validator against ../tools/validate.py, one corpus
python3 tools/check-html-twins.py             # index.html and create.html stay identical
python3 tools/check-route-table.py            # about.html's route table against the code
python3 tools/check-preflight-list.py         # create page's file list against the capture skill
python3 tools/check-comment-balance.py .      # every HTML comment closes
python3 tools/check-served-clean.py --self-test
python3 tools/build-dist.py --self-test
```

The library suite refuses any network request a test did not stub and removes the site's
environment variables before it runs (`tools/_helpers.mjs`). The endpoint and og suites take
`ARCHIVE_MODE` out of their environment too, because a deploy with archive mode on runs them in
its build. The store double proves the logic in `lib/`, not that Netlify Blobs behaves as that
logic assumes.

## Deploy your own copy on Netlify

1. Create a Netlify site from your fork and set its **base directory** to `web`. Netlify then
   reads `web/netlify.toml`.
2. Set `NODE_VERSION` and `VOTE_SECRET`, and the mail variables if you want sending.
3. Deploy. The build command is in `netlify.toml`: `build.sh`, then `tools/substitute.py` (fills
   the imprint placeholders), `tools/build-dist.py` (copies an allowlist into `dist/`, the only
   published directory), `tools/archive-dist.mjs`, then `tools/strip-served-comments.py` and
   `tools/check-served-clean.py`, which remove developer comments from `dist/` and fail the build
   if any are left.
4. Replace the Phaeacia name, logo, imprint and privacy page with your own. No licence covers
   the name or the logo (see Licence).

`netlify.toml` also sets the content security policy for static pages; `passport.mjs` sets the same
policy on the pages it renders, and `build.sh` fails if the two disagree. The `ignore` rule skips a
build when nothing under `web/`, `installer/`, `examples/` or the two prompt files changed.

## Operator tools

These scripts reach a live site's stores and need `NETLIFY_SITE_ID` and `NETLIFY_AUTH_TOKEN` in the
environment. Their logic lives in `lib/` and is tested against the in-memory store.

| script | what it does | writes |
|---|---|---|
| `tools/metrics.mjs` | reads the publish and refusal corpora | never |
| `tools/review-holds.mjs` | lists held uploads; releases or refuses one | on release and refuse |
| `tools/takedown.mjs unlist\|delete <id>` | removes a passport without its token, for an abuse report or an erasure request | only with `--apply` |
| `tools/backup-stores.mjs export --out=<dir>` | copies the durable stores to a directory | never |
| `tools/backup-stores.mjs restore --from=<dir>` | puts a copy back | only with `--apply --confirm-site=<id>` |

A backup holds published passport text, including passports deleted after it was taken. Keep that
in mind before keeping one.

## Known limitations

- The rate limiter is best effort. Each attempt writes its own key and counts by listing, and
  Netlify Blobs lists with eventual consistency, so a burst can overshoot a limit briefly.
- Limits trust the platform's client address header. They are speed bumps, not identity.
- `lib/_validate.mjs` does not implement two checks that `../tools/validate.py` has (a credentialed
  input's `binding` must name a slot; a check comparing against an earlier run needs a `state`
  block). `tools/parity.mjs` records the divergence fixture by fixture.
- Netlify's "Run now" button can run a scheduled function on a deploy preview. The functions refuse
  any context other than production, and stores are scoped per deploy, but that path exists.
- The digest is not scheduled and the scope teardown runs as a dry run; both are deliberate
  states, not finished features.

## Notes on the source

Comments in this directory cite tracker ids (`ROW-` or `PH-` followed by a number) and paths under
`record/`. They point at Phaeacia's private history, which is not published, and are kept because
they tell a reader that a decision was made and when. Some comments also name paths in Phaeacia's
private workspace (`~/Phaeacia/…`) and the roles of the people and agents who worked on the app,
and some cite planning documents whose decisions are summarised in `../docs/design-notes.md`.

## Licence

The code in this directory is licensed under the Apache License 2.0; see `../LICENSE`. The passport
format, specification, vocabulary, installer text and browser capture prompt are licensed under
CC BY 4.0 as the repository's licence map states, and so are their copies that `build.sh` places in
`assets/installer/`; the judge prompt's copy there (`judge.md`) is Apache 2.0, like its source in
`../verification/`. The fonts in `assets/fonts/` are under the SIL Open Font License 1.1
(`assets/fonts/OFL.txt`). Dependencies installed by `npm ci` keep their own licences.

The Phaeacia name and logo are not licensed at all. The logo files in `assets/mark/`,
`assets/favicon/` and `assets/og/og-card.png` are here so the app builds; no licence of any kind
covers them (`../LICENSE-MAP.md`, *Not licensed*). They and the name appear throughout the pages,
and a fork must replace them with its own.

## History

The app was built between August and October 2026 as the hosted half of Agent Passport: a capture skill
writes a passport on the owner's machine, and this site publishes it as a link a recipient can read
and install from. It went from a single upload page to the create, share and gallery flow, with
expiry, token management, an optional third-party content check and a held-for-review path added
along the way. In November 2026 Phaeacia stopped developing Agent Passport, switched the hosted
instance to archive mode and published the code.

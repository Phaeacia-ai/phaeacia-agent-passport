# Agent Passport

A file format and tools for moving an agent you built for yourself from one AI platform
to another, without moving any credential.

**Archived.** Phaeacia built Agent Passport in 2026 and no longer develops it. It is
published as-is, the code under the Apache License 2.0 and the passport format,
specification, installer text, capture skill instructions and browser capture prompt
under CC BY 4.0 (`LICENSE-MAP.md` has the per-file map), so the work stays available to
study, run and fork. The Phaeacia name and logo are not licensed. There is no support,
no roadmap and no security fixes.

The hosted site at `app.phaeacia.ai` stays up read-only. It no longer accepts uploads:
its upload endpoint answers HTTP 410. Everything else here runs on your own machine.

## What an Agent Passport is

One readable Markdown file that describes an agent someone built for themselves (a
morning brief, a job scanner, a report writer) well enough that another person, on a
different AI platform, can rebuild a working version of it with their own accounts,
and an honest account of what did not survive the move.

A passport has YAML frontmatter and six sections, always in this order:

1. **What this agent is.** Three sentences for the person deciding whether to install it.
2. **What it needs from you.** The consent table: one row per capability, why it is
   needed, whether it is required, what happens without it, and whether the format
   allows installing it.
3. **Functional spec.** A YAML block: inputs, processing, output, trigger, the
   questions to ask the new owner (personal slots), and the checks a judge runs on
   the first output.
4. **Golden examples.** One to three real outputs of the original agent.
5. **Installer.** A placeholder in the captured file; the installer text is inserted
   when the passport is assembled for a particular platform.
6. **Losses.** What did not survive the move. Filled in during install.

Three rules hold everywhere in the format and the tools:

- **Capabilities travel, credentials never do.** A passport names the kind of access
  an agent needs ("a mailbox you can read") and never a credential value. Granting
  happens on each platform's own consent screen, by the person who owns the account.
  The scrubber removes credential-shaped values before anything is shared, and the
  validator and the upload gate refuse a passport that still carries one.
- **Installs are read-only.** Format version 0.1 installs only read capabilities and
  in-chat delivery (the `read-notify` envelope). Anything that writes to the world is
  described as "declared only" and is not installed.
- **The losses table always renders**, even when it is empty.

The normative definition is `spec/passport-0.1.md`. The closed list of capabilities is
`spec/vocabulary.md`.

## How it works

```
CAPTURE (the owner's side)          ASSEMBLE                  INSTALL (the recipient's side)
skills/agent-passport/  path F  ─┐                            the recipient pastes the
  runs in the owner's coding     │  scripts/assemble.py        assembled passport into their
  agent and reads its files      ├─► inserts installer/core.md ─► own assistant, which follows
capture/path-w-prompt.md path W ─┘  + one branch + the judge    the installer text: consent,
  runs in the owner's ChatGPT       prompt into section 5       setup, first run, losses table
  or claude.ai and interviews
```

No component calls a model API. Every inference runs inside somebody's own assistant:
the owner's during capture, the recipient's during install.

- **Capture, path F.** `skills/agent-passport/` is an Agent Skills folder for Claude
  Code. Run from the folder that holds an agent, it reads the files (never the paths
  on its deny list), asks the owner what files cannot answer, shows a scrub review of
  every value it removed, and writes `<name>-passport.md` next to the agent.
- **Capture, path W.** `capture/path-w-prompt.md` is the same capture for agents that
  live in a browser (a custom GPT, a claude.ai Project, a Gemini Gem). The owner pastes
  part B (the text between the five-backtick fences under PART B) into their own chat
  and gets the passport back as one fenced block.
- **Check.** `tools/scrub.py` finds and removes credential-shaped values.
  `tools/validate.py` is the executable form of the format specification.
  `tools/preflight.py` predicts what the hosted upload endpoint would refuse. The
  skill does not finish until validate and preflight both pass.
- **Assemble.** `scripts/assemble.py PASSPORT OUT [--branch=NAME]` inserts the
  platform-agnostic installer core (`installer/core.md`), one platform branch
  (`installer/branches/`: ChatGPT, claude.ai, Claude Code, any other assistant) and the
  judge prompt (`verification/judge-prompt.md`) into section 5.
- **Install.** The recipient's assistant follows the installer text: it resolves the
  consent table against the platform, sets up each capability on the platform's own
  consent screens, substitutes sources the recipient cannot reach, asks the personal
  questions, runs the agent once, has the judge check the first output, and fills in
  the losses table.
- **Host (closed).** `web/` is the app that served passports at `app.phaeacia.ai`:
  an upload endpoint that runs the same gates, a page per passport with a platform
  picker and a copy button, a delete token, thirty-day expiry and an opt-in gallery.
  `scripts/publish.py` was the skill's last step and posted the passport there.

`docs/how-it-works.md` has more detail on each step, the gates and what was measured.
`docs/design-notes.md` summarises the design decisions behind the hosted app.

## Repository map

| path | what it is |
|---|---|
| `spec/` | the format: specification, capability vocabulary, template, JSON schema, and `resolution.d/`, the capability-by-platform facts. `spec/resolution.yaml` is generated |
| `installer/` | the installer core and one branch per platform |
| `skills/agent-passport/` | capture path F. `SKILL.md` is authored; `references/` and `scripts/` are generated by `scripts/build.sh` |
| `capture/` | capture path W, plus a kit for running it with a real owner (`scripts/stage-owner-run.sh` stages it) |
| `commands/share.md` | the `/share` slash command for Claude Code, which starts the skill |
| `tools/` | `validate.py`, `scrub.py`, `preflight.py`, `to_json.py`, the test suite and its fixtures |
| `scripts/` | `build.sh`, `assemble.py`, `publish.py`, `doctor.sh`, `verify.sh`, `passport-to-page.py` (the reference derivation the upload endpoint ports), `export-public.sh` |
| `examples/` | `daily-brief-passport.md`, the worked example the tools and tests read |
| `verification/` | the judge prompt, the generality test procedure and the capture-loop rubric |
| `web/` | the hosted app: Netlify functions, pages, libraries and its own tests. See `web/README.md` |
| `site/` | the static page that came before `web/`, and `site/spec/`, the written upload, derivation and storage rules |
| `publish/` | the source files for the public skill repository that `scripts/export-public.sh` builds |
| `docs/` | how it works and design notes |

## Quick start

Python 3.7 or newer runs the capture tools; they use only the standard library.

```bash
git clone https://github.com/Phaeacia-ai/phaeacia-agent-passport
cd phaeacia-agent-passport
./scripts/build.sh
python3 scripts/assemble.py examples/daily-brief-passport.md /tmp/out.md --branch=chatgpt
python3 tools/validate.py /tmp/out.md          # prints PASS
```

`/tmp/out.md` is now what a recipient on ChatGPT would paste into their assistant.

To capture one of your own agents with Claude Code, link the skill and the command
into `~/.claude` and run `/share` from the agent's folder. If you installed the public
skill by cloning it into `~/.claude/skills/agent-passport`, move that folder aside
first; `doctor.sh` reports it if you do not.

```bash
mkdir -p ~/.claude/skills ~/.claude/commands
ln -sfn "$PWD/skills/agent-passport" ~/.claude/skills/agent-passport
ln -sfn "$PWD/commands/share.md" ~/.claude/commands/share.md
./scripts/doctor.sh                            # exit 0 means /share will run this checkout
```

The capture ends with `<name>-passport.md` beside the agent. Assemble it as above and
send the result to whoever should have the agent.

## Tests

```bash
./scripts/build.sh
( cd tools && ./run_tests.sh )                 # prints ALL TESTS PASSED
python3 scripts/assemble.py examples/daily-brief-passport.md /tmp/out.md
python3 tools/validate.py /tmp/out.md          # prints PASS
```

`tools/run_tests.sh` covers the validator, the scrubber, preflight, the installer paste
budget, the publish script and the agreement between the Python tools and the app's
JavaScript gate. The full run needs Node.js 20 or newer and Python with PyYAML and
jsonschema (`python3 -m pip install pyyaml jsonschema`; CI uses Node 24 and Python
3.11). Without them, the checks that need them print a line saying they were skipped;
a skipped check is not a pass.

`scripts/verify.sh` runs the above plus the app's own suites, after `npm ci` in `web/`.
`.github/workflows/checks.yml` runs the same loop and the app's build chain.

`skills/agent-passport/references/`, `skills/agent-passport/scripts/` and
`spec/resolution.yaml` are generated. Edit the canonical files in `spec/`,
`installer/`, `tools/`, `scripts/` and `verification/`, then run `./scripts/build.sh`.

### Paste budget

A recipient pastes the passport, the installer core, the judge prompt and one branch
as one block. `tools/test_paste_budget.py` assembles the example once per branch and
fails when a block passes its ceiling. Measured on 2026-10-22: ChatGPT 76,904 bytes,
claude.ai 70,773, Claude Code 79,561, any other assistant 61,335, roughly 15,000 to
20,000 tokens each. The ceilings are those sizes plus about 3%. If the branches grow,
trim the branch rather than the losses table or the consent step; raising a ceiling is
a decision, not a fix.

## Running your own copy of the app

The app in `web/` is a Netlify site: static pages, Netlify Functions and Netlify Blobs
for storage. `web/README.md` covers running it locally, deploying your own copy, its
configuration and the archive mode the hosted copy now runs in.

To have the capture skill publish to your deployment, set the upload address before
you run it:

```bash
export PHAEACIA_UPLOAD_ENDPOINT=https://<your-host>/api/upload
```

`scripts/publish.py` also takes `--endpoint`. With neither set it posts to
`app.phaeacia.ai`, which answers 410; the script then prints "hosting at
app.phaeacia.ai is closed to new uploads; your passport file is kept locally at
<path>", leaves the file untouched and exits 5. A fork that runs the app publicly
should use its own name and logo (see `NOTICE`).

## Licence

Mixed, because the parts are different things. `LICENSE-MAP.md` maps every directory
and decides wherever a summary, including this one, is shorter than it.

- **Code** (`tools/`, `scripts/`, `web/`, and everything not listed below): Apache
  License 2.0, `LICENSE` and `NOTICE`.
- **The format and the installer text** (`spec/`, `installer/`, the worked example),
  the skill's `SKILL.md` and the skill export's prose in `publish/`: CC BY 4.0, with
  notices in `spec/LICENSE.md`, `installer/LICENSE.md`, `skills/LICENSE.md` and
  `publish/LICENSE-MAP.md`.
- **The browser capture prompt** (`capture/`): CC BY 4.0 since the project was archived,
  notice in `capture/LICENSE.md`.
- **Fonts** in `web/assets/fonts/` are third-party, under the SIL Open Font License 1.1.
- **The Phaeacia name and logo** are not licensed at all. The logo files
  (`web/assets/mark/`, `web/assets/favicon/`, `web/assets/og/og-card.png`) are in the
  repository so the app builds; no licence of any kind covers them, and a fork must
  replace them.

A passport you produce with these tools is yours.

## History

Phaeacia built Agent Passport in 2026 as a way to share a working agent between people
who use different AI platforms. The format reached version 0.1 in August 2026, together
with the capture skill, the installer text and its platform branches, and the validator.
The hosted app at `app.phaeacia.ai` followed, with upload, a page per
passport, deletion by token, thirty-day expiry and later an opt-in gallery. The capture
skill was published separately as
https://github.com/Phaeacia-ai/phaeacia-agent-passport-skill. In November 2026 Phaeacia
stopped the work, closed the hosted site to new uploads and published this repository.
Phaeacia Enterprise, a workspace for distributing agents written as passports within a
company, is archived separately at
https://github.com/Phaeacia-ai/phaeacia-enterprise-agentpassports. Phaeacia's own page
about the published work is https://phaeacia.ai/agent-sharing.
The end-to-end tests the project set itself, the generality test in
`verification/generality-test.md` and installs by people outside the project on each
platform, are described here as procedures; their results are not part of this
repository.

Code comments, and some of the specification prose under `site/spec/`, cite internal
tracker IDs (`ROW-…`, `PH-…`), planning documents and a private record (`record/…`)
that are not public. Some comments also name paths in Phaeacia's private workspace
(`~/Phaeacia/…`) and the roles of the people and agents who worked on it. What the
planning documents settled is summarised in `docs/design-notes.md`.

## Credits

Agent Passport was built by Phaeacia, a project by Raffael Hüberli. Krunal Rathod
contributed to its design and code.

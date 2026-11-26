# How Agent Passport works

This page follows one passport from the owner's agent to the recipient's assistant,
naming the file that does each step. The normative rules are in `spec/passport-0.1.md`;
where this page and the specification differ, the specification is right.

Two people appear throughout, as they do in the specification. **A** owns the agent
being captured. **B** installs it afterwards, usually on a different platform, with
their own accounts. They may never speak, so everything B needs has to be in the file.

## 1. Capture

### Path F: an agent made of files

`skills/agent-passport/SKILL.md` is a procedure that A's coding agent follows (written
for Claude Code, in the Agent Skills folder layout). In order:

| step | what happens |
|---|---|
| 0 | checks that Python 3.7 or newer runs and that the skill folder is complete, then finds the agent |
| 1 | inventories the folder and classifies each file, skipping everything on its deny list (`.env*`, `credentials*`, `*token*`, `*secret*`, keys, and the tool's own earlier outputs) |
| 2 | reads for function, not for code review |
| 3 | fills the functional spec: inputs and how each is bound, processing, output, trigger, `comparison_mode` |
| 4 | turns every value that belongs to A (their city, their topics, their senders) into a question for B, a personal slot |
| 5 | picks one to three real outputs as golden examples |
| 6 | scrubs credential-shaped values with `scripts/scrub.py` and records each replacement |
| 7 | the check-in: a short summary, one round of questions, the scrub review, and, only when a self-hosted endpoint is configured, the publishing question |
| 8 | derives two to four checks a judge can run on B's first output |
| 9 | writes `<name>-passport.md` and `corrections.tsv`, and runs `validate.py` and `preflight.py` until both pass |
| 10 | hands over the file, or publishes it to a configured deployment |

*Unattended mode*, at the end of `SKILL.md`, covers a capture with no owner present: it
records defaults instead of asking and ends at an unreviewed draft, never at a link.

### Path W: an agent that lives in a browser

`capture/path-w-prompt.md` part B is pasted by A into their own ChatGPT or claude.ai
chat. It reads the agent where the chat has tools to do so, says what it found and
waits for one confirmation, asks for one real reply of the agent, writes the spec
silently, shows the scrub review, and emits the passport as one fenced block. Part A
holds the notes for whoever maintains the prompt. This directory is CC BY 4.0; see
`capture/LICENSE.md`.

`scripts/stage-owner-run.sh` packages part B with a run sheet and `check.sh`, which
runs one passport through `validate.py`, `preflight.py` and the app's own gate side by
side, so that a real owner's run shows any disagreement between them.

## 2. The gates

Four implementations look at a passport, and they divide the work on purpose.

| gate | file | question it answers |
|---|---|---|
| scrubber | `tools/scrub.py` | which values look like credentials, and what replaces them |
| validator | `tools/validate.py` | does the file follow the format (spec section 7) |
| preflight | `tools/preflight.py` | would the upload endpoint refuse this content |
| upload gate | `web/lib/_validate.mjs` | transport, format and untrusted-content checks, run on every upload |

`validate.py` is the reference implementation of the format and has no secret scan.
`preflight.py` predicts the upload gate, so a capture learns about a refusal on A's
machine rather than at an upload box. `web/tools/parity.mjs` runs the whole fixture
corpus through the Python and JavaScript implementations and fails on any
disagreement; `tools/run_tests.sh` runs it. `site/spec/upload-validation.md` is the
written contract for the endpoint's four stages: transport, format, untrusted content
and derivation.

`tools/to_json.py` converts an accepted passport into a JSON projection that
`spec/passport.schema.json` describes. The Markdown file stays the source of truth.

## 3. Assemble

A captured passport's section 5 is one placeholder line. The installer text is
maintained separately so that it can change without every passport going stale.
`scripts/assemble.py` replaces the placeholder with:

1. `installer/core.md`, the platform-agnostic steps;
2. one branch from `installer/branches/` (`chatgpt`, `claude-ai`, `claude-code` or
   `generic`), or all four without `--branch`;
3. the judge prompt from `verification/judge-prompt.md`.

It refuses two hazards that only appear in the assembled file: a literal
`comparison_mode:` assignment anywhere in installer text, which would break the
one-per-passport rule, and a denied-path string such as `credentials/` in a branch.

The branches are written from `spec/resolution.d/`, one YAML file per platform that
records, per capability, the mechanism, the plan it needs, its limits, what it degrades
to, a confidence and the date it was checked. `scripts/build.sh` merges them into
`spec/resolution.yaml`. Every fact there is dated; a platform's interface changes
faster than this repository did.

### Paste budget

B pastes the passport, the core, the judge prompt and one branch as one block. On
2026-10-22 those blocks measured between 61,335 and 79,561 bytes for the example
passport. `tools/test_paste_budget.py` fails when a branch passes its ceiling.

## 4. Install

B's assistant follows `installer/core.md` and its branch:

1. orientation and consent, with the consent table already resolved against the
   platform, and declared-only rows read out as things this install will not do;
2. an environment check;
3. capability setup, on the platform's own consent screens;
4. source substitution, as a ladder: B's own system that serves the role, then an
   open equivalent with the difference said out loud, then a recorded loss;
5. personal slots, asked of B;
6. assembling and installing the agent from the spec;
7. a first run, checked by the judge prompt against the passport's verification checks;
8. the losses table, which renders even when every row says delivered;
9. the hand-over.

The judge is advisory. Its prompt says where it is weak.

## 5. Corrections found against the platforms

Three assumptions in the original plan did not survive contact with the platforms,
and the code and the resolution map follow what was found:

1. **Claude Code does not implement the Agent Plugins standard.** It reads
   `.claude-plugin/plugin.json` and `.mcp.json`, while the standard specifies
   `plugin.json` and `mcp.json` at the root. Only `skills/<name>/SKILL.md` is common to
   both. The Claude Code branch writes both layouts and says which one loads.
2. **The ChatGPT scheduled-task cap is per plan**, not a flat five, and tasks run at
   most hourly. `spec/resolution.d/chatgpt.yaml` records the numbers and the date.
3. **ChatGPT connectors needed a paid plan and claude.ai connectors did not**, while
   scheduling was first-class on ChatGPT and a separate beta on claude.ai. Both
   branches state the comparison the same way.

These were true on the dates recorded in `spec/resolution.d/`. Check them again before
relying on them.

## 6. The hosted app, while it was open

`web/` accepted a passport at `/api/upload`, ran the four stages above, stored it,
assembled the installer text in the page for the platform B picked, and returned a
link, a management link and a delete token that existed only in that one response.
A passport expired after thirty days unless its owner listed it in the gallery.
`scripts/publish.py` was the capture's last step and wrote the link and token to
`<name>-passport.link.md` beside the passport, created with mode 0600.

The hosted copy no longer accepts uploads. `web/README.md` describes the app, its
routes, its storage and its archive mode. `docs/design-notes.md` records why it was
built the way it was.

## 7. What was not built

Accounts, editing, versioning, private or organisation libraries, payments, an install
wizard, and telemetry beyond a page view counter, a copy counter and the per-publish
structural record described in `docs/design-notes.md`. The platform picker on a
passport page is the first question such a wizard would have asked; everything it
would need is a lookup in `spec/resolution.yaml`.

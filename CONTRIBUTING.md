# Contributing

Agent Passport is archived. Issues and pull requests are not read and will not be
merged. If you want to change something, fork the repository and change it there.
Please use your own name and logo for a fork that you publish or run; see `NOTICE`.

## Working on a fork

Requirements: Python 3.7 or newer for the capture tools, which use only the standard
library. The full test suite also needs Python with PyYAML and jsonschema, and Node.js
20 or newer (CI uses Python 3.11 and Node 24). The app in `web/` needs `npm ci`.

Edit the canonical files, never the generated ones:

| generated | edit instead |
|---|---|
| `spec/resolution.yaml` | `spec/resolution.d/*.yaml` |
| `skills/agent-passport/references/` | `spec/`, `installer/`, `verification/judge-prompt.md` |
| `skills/agent-passport/scripts/` | `tools/` and `scripts/` |

`skills/agent-passport/SKILL.md` is authored, not generated.

## Checks

Run all of these after any change, from the repository root:

```bash
./scripts/build.sh
( cd tools && ./run_tests.sh )                     # must print ALL TESTS PASSED
python3 scripts/assemble.py examples/daily-brief-passport.md /tmp/out.md
python3 tools/validate.py /tmp/out.md              # must print PASS
```

`scripts/verify.sh` runs those plus the app's suites (`npm ci` in `web/` first).
`./scripts/doctor.sh` checks that `~/.claude/skills/agent-passport` and
`~/.claude/commands/share.md` point at your checkout, and prints the repair if not.
`.github/workflows/checks.yml` runs the same loop in CI, and
`.github/workflows/gitleaks.yml` scans the history for secrets.

A check that prints that it was skipped did not pass. Install what it names and run it
again.

Some rules the suite enforces that are easy to trip over:

- The two Python and JavaScript implementations of the gates must agree on every
  fixture (`web/tools/parity.mjs`). Change both or neither.
- Nothing in a shipped folder (`skills/agent-passport/`, `installer/`, `spec/`,
  `capture/`) may name a path on one particular machine, and nothing there may be a
  binary file, including a stray `__pycache__`.
- Installer text must not contain a literal `comparison_mode:` assignment or a denied
  path such as `credentials/`; `assemble.py` refuses both.
- Each installer branch has a size ceiling in `tools/test_paste_budget.py`. Trim the
  branch before raising the ceiling.

## The public skill repository

https://github.com/Phaeacia-ai/phaeacia-agent-passport-skill is generated from this
repository by `scripts/export-public.sh OUTDIR`, which needs `gitleaks` on `PATH`. The
export's README and licence map are `publish/README.md` and `publish/LICENSE-MAP.md`.

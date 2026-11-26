# Transport fixtures: stage 1, the bytes before any rule reads a line

Passports that differ from `fixtures/passports/valid_minimal.md` in the one
place the upload endpoint's `transport()` (`web/lib/_validate.mjs`) looks: size,
encoding, control characters, the byte-order mark and the line break. Named for
the endpoint's verdict, as everywhere else.

| fixture | what the endpoint does with it |
|---|---|
| `invalid_control_char_esc.md` | `E_CONTROL_CHARS`: an ANSI colour escape (0x1B), as a terminal log is quoted |
| `invalid_control_char_nul.md` | `E_CONTROL_CHARS`: U+0000, the one control the spec names outright |
| `invalid_not_utf8.md` | `E_NOT_UTF8`: one Latin-1 e-acute |
| `invalid_too_small.md` | `E_TOO_SMALL`: 501 bytes that `validate.py` passes |
| `invalid_too_large.md` | `E_TOO_LARGE`: a valid passport padded past 262,144 bytes |
| `valid_lone_cr_in_prose.md` | accepted: a lone CR inside a line survives `transport()`, so it is not a control character to either gate (the spec says otherwise, see below) |
| `invalid_lone_cr_line_endings.md` | `E_FRONTMATTER`: every break a lone CR, so the endpoint reads one line |
| `valid_leading_bom.md` | accepted: the BOM is stripped and is not an error |

**Why they are not in `fixtures/passports/`.** Three checks in
`tools/run_tests.sh` open every file there as UTF-8 text, and one of these is
not UTF-8 by construction. They also need `tools/preflight.py` on the capture
side to be judged at all: `validate.py` is blind to stage 1 by design, so
`web/tools/parity.mjs`, which walks this directory, `fixtures/passports/` and
`fixtures/validator/`, compares `validate.py` and `preflight.py` together
against `transport()`, `validate()` and `derive()`.

**Two of them are recorded divergences, not agreements**, and `parity.mjs`
names both in `ALLOWED` with the reason: `validate.py` reads a lone CR as a line
break and passes `invalid_lone_cr_line_endings.md`, and its check 1 refuses the
BOM that `valid_leading_bom.md` carries. Both are the format reference's call,
not stage 1's. `tools/run_tests.sh` pins what `preflight.py` says about every
file here, so a run without node sees them too.

**On CR and DEL the spec and the endpoint disagree, and this directory follows
the endpoint.** `site/spec/upload-validation.md` section 2 says "No C0 control
characters other than LF and TAB", under which a lone CR left after the CRLF
fold is `E_CONTROL_CHARS`. `transport()`'s class skips 0x0D, and refuses DEL
(0x7F), which is not C0. `preflight.py` predicts what the endpoint does, so it
follows the code, and both lone-CR fixtures pin the code's reading. Which one is
right is an open question for the owner (2026-10-23): make `transport()` refuse
a lone CR as section 2 says, which turns `invalid_lone_cr_line_endings.md` into
a stage-1 refusal `preflight.py` predicts and `valid_lone_cr_in_prose.md` into
an `invalid_` file, or amend section 2 to exempt CR and name DEL.

**What one file per refusal cannot show** is each byte limit at its exact edge,
the floor counted with a BOM inside it, and the order the refusals come in when
a file earns two. Those are byte probes in `parity.mjs` ("stage 1 probes"), run
through `transport()` and `preflight.py` both.

Every line break in these files is LF except where the fixture is about the CR.
Do not open and re-save one in an editor: most of them will "fix" the very byte
the file exists for.

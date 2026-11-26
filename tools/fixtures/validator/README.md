# Validator fixtures, and how the parity corpus treats them

Ten passports that `tools/validate.py` must refuse, one per branch of checks 12
(binding), 13 (state behind a run-to-run check), 14 (fidelity) and 15 (access),
plus one compliant passport, and the mapping from fixture to the message it must
produce in `tools/run_tests.sh` test 12. A fixture here that is not named in
that test's `EXPECTED` table fails the suite, because a fixture nothing asserts
against is decoration.

**The rules are on `main` and normative; the upload endpoint does not run them.**
Checks 12 to 14 landed in `validate.py` in 2d2de8d (2026-08-10) and check 15 in
d1dac7c (2026-09-03), and
`spec/passport-0.1.md` section 7 lists them among the checks while saying the
hosted endpoint "does not implement the input checks". So every `invalid_` file
here is refused by `validate.py` and accepted by `transport()`, `validate()` and
`derive()` in `web/lib/`. This README said until 2026-10-22 that the rules were
not on `main` yet, which had been false for ten weeks.

**They are in the parity corpus, as recorded divergences.** `web/tools/parity.mjs`
walks this directory beside `fixtures/passports/` and `fixtures/transport/`. Each
of the ten has an `ALLOWED` entry there that pins the divergence exactly, which
side accepts and every `FAIL` number `validate.py` reports, with the reason
beside it. Any other divergence on these files fails parity, and so does one of
these closing without its entry being deleted. Until 2026-10-22 they were kept
out of that loop instead, so the build could not see them at all.

**Closing the gap is the owner's call, not parity's.** Porting checks 12 to 15
into `web/lib/_validate.mjs` tightens a live gate that has published passports
without them, written by older skills and by hand, under a `RULES_VERSION` that
has not moved since 0.1.0, so rows admitted under the old rules cannot be told
apart. When a check is ported, bump `RULES_VERSION`, delete its `ALLOWED`
entries, and move its fixtures into `fixtures/passports/`. `web/README.md`
carries the port note, the exact failure strings and both of check 13's
exemptions.

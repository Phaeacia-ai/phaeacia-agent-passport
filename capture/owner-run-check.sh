#!/usr/bin/env bash
# Check an emitted passport locally. Nothing here contacts the network and
# nothing here publishes.
#
# WHY THIS RUNS THREE THINGS AND PRINTS ALL THREE. The bench this replaces
# (the 2026-09-01 pathw-test bench) ran two Python gates and labelled one of them
# "what the upload endpoint refuses". That label was measured on 2026-09-17 and
# it holds for the shapes tested: preflight.py agreed with the live gate on 38
# of 39, and check.sh as a whole never cleared a file the live gate refuses.
# But preflight.py is a SEPARATE IMPLEMENTATION of the same rules, and a mirror
# that agrees today is not a mirror. So this script runs the gate itself,
# `web/lib/_validate.mjs`, which is the module `web/netlify/functions/upload.mjs`
# imports, and runs it as upload.mjs does: transport() on the file's bytes,
# then validate(), then derive(). No proxy, nothing to drift. (It called
# validate() alone until 2026-10-23, so a file the upload refuses at stage 1,
# an ANSI escape or under 512 bytes, read "will accept" here, and once
# preflight.py predicted stage 1 the mirror banner blamed the mirror.)
#
# It prints every verdict instead of one. The live gate's is the one the upload
# will give; the others are there so that a difference between our own
# implementations shows up on a real owner's file, which is the only place we
# would otherwise never see it. Which engine was wrong is ours to work out, never
# the owner's, so the banners at the end report a difference without assigning
# it. (Until 2026-09-21 the banner called any difference "the known open question
# PH-512, not a mistake you made". PH-512 is settled, and validate.py has no
# secret scan by design, so that banner told an owner whose file carried a
# credential that the refusal was not their doing. PH-542.)
set -u
# WHICH GATE. scripts/stage-owner-run.sh snapshots the gate files from the
# commit PROVENANCE.txt names into owner-run-gates/<commit>/ beside the run
# folder, and fills in the three values below. So this script gives the same
# answer whatever state any checkout on this machine is in. It used to run the
# main checkout, and the main checkout is not main
# (record/findings/owner-run-check-sh-runs-the-main-checkout-and-the-main-checkout-is-not-main.md).
GATE="@@GATE_DIR@@"
GATE_COMMIT="@@GATE_COMMIT@@"
GATE_MANIFEST_SHA="@@GATE_MANIFEST_SHA@@"
if [ "$GATE" = "@@""GATE_DIR@@" ] || [ "$GATE_COMMIT" = "@@""GATE_COMMIT@@" ] \
   || [ "$GATE_MANIFEST_SHA" = "@@""GATE_MANIFEST_SHA@@" ]; then
    echo "This checker was copied without its gate filled in." >&2
    echo "Re-stage with scripts/stage-owner-run.sh." >&2
    exit 2
fi
# A deliberate override, for re-checking an old run against a newer gate. Named
# so that nothing exported for another tool (the website's build reads
# PASSPORT_REPO) can redirect it by accident, and loud when used.
if [ -n "${OWNER_RUN_GATE_OVERRIDE:-}" ]; then
    GATE="$OWNER_RUN_GATE_OVERRIDE"
    echo ">>> OWNER_RUN_GATE_OVERRIDE is set: running the gate at $GATE,"
    echo ">>> NOT the one this run was staged with ($GATE_COMMIT). Do not"
    echo ">>> record these verdicts as the run's own."
    echo
else
    [ -d "$GATE" ] || { echo "No gate snapshot at $GATE. Re-stage with scripts/stage-owner-run.sh." >&2; exit 2; }
    # The snapshot is written once and made read-only; this proves it is still
    # the bytes that were staged, so a verdict below is a verdict of $GATE_COMMIT.
    [ "$(cat "$GATE/GATE-COMMIT" 2>/dev/null)" = "$GATE_COMMIT" ] || {
        echo "The gate at $GATE does not say it is $GATE_COMMIT. Refusing to guess." >&2; exit 2; }
    python3 - "$GATE" "$GATE_MANIFEST_SHA" <<'VERIFY' || exit 2
import hashlib, os, sys
gate, want = sys.argv[1], sys.argv[2]
# The manifest first, against the hash stamped into this file at staging.
# Checking the files against the manifest alone proves nothing when the
# manifest can be edited too, and it could: emptied, it listed nothing and
# passed as verified.
try:
    got = hashlib.sha256(open(os.path.join(gate, "MANIFEST"), "rb").read()).hexdigest()
except OSError:
    got = None
if got != want:
    sys.exit("The gate snapshot's MANIFEST is not the one it was staged with. Refusing to run it.")
bad, listed = [], {"MANIFEST", "GATE-COMMIT"}
for line in open(os.path.join(gate, "MANIFEST"), encoding="utf-8"):
    digest, name = line.rstrip("\n").split("  ", 1)
    listed.add(name)
    try:
        ok = hashlib.sha256(open(os.path.join(gate, name), "rb").read()).hexdigest() == digest
    except OSError:
        ok = False
    if not ok:
        bad.append(name)
# Nothing may sit beside the listed files either. A file ADDED to the snapshot
# changes what runs without changing any listed byte: Python puts a script's
# own directory first on the import path, so a planted tools/re.py replaced
# the standard library for validate.py and preflight.py under the verified
# banner (round-2 critic, 2026-09-21). The engines also run with -I below.
for root, dirs, files in os.walk(gate):
    for f in files:
        rel = os.path.relpath(os.path.join(root, f), gate)
        if rel not in listed:
            bad.append(rel + " (not in the snapshot)")
if bad:
    sys.exit("The gate snapshot has been altered since it was staged: %s. Refusing to run it." % ", ".join(bad))
VERIFY
    echo "gate: $GATE_COMMIT (snapshot verified against its manifest)"
    echo
fi
REPO="$GATE"
F="${1:-}"
if [ -z "$F" ]; then
    echo "usage: $(basename "$0") <passport.md>" >&2
    echo "  paste the emitted block into a file first, then pass it here" >&2
    exit 2
fi
[ -f "$F" ] || { echo "No passport at $F." >&2; exit 2; }

# Every section is run first and printed afterwards, because what may be
# printed depends on what the later sections find. validate.py's and the
# gate's own messages quote field values ("passport must be 0.1, got '...'",
# "format version ..."), so on a file that carries a credential they print it,
# and everything here is meant to be copied into RUN-NOTES.md, which comes back
# to us. When the gate or section 4 recognises a credential, sections 1 to 3
# show only their verdicts, the gate's codes, and the credential's line numbers.
# A credential nothing recognises cannot be withheld this way (PH-542).
VOUT=$(python3 -I "$REPO/tools/validate.py" "$F" 2>&1); V=$?
POUT=$(python3 -I "$REPO/tools/preflight.py" "$F" 2>&1); P=$?
GOUT=$(node --input-type=module -e "
import fs from 'node:fs';
const repo = process.argv[1], file = process.argv[2];
const { validate, transport } = await import('file://' + repo + '/web/lib/_validate.mjs');
const { derive }   = await import('file://' + repo + '/web/lib/_derive.mjs');
const t = transport(fs.readFileSync(file), 'text/markdown');
if (t.error) {
  console.log('The live upload endpoint will REFUSE this passport:');
  console.log('  ' + t.error.code);
  console.log('    ' + t.error.message);
  process.exit(1);
}
const v = validate(t.text);
if (v.errors.length) {
  console.log('The live upload endpoint will REFUSE this passport:');
  for (const e of v.errors) {
    console.log('  ' + e.code);
    for (const d of (e.details ?? [])) console.log('    ' + d);
    if (e.message) console.log('    ' + e.message);
  }
  process.exit(1);
}
const d = derive(v.front, v.lines);
if (d.error) { console.log('The live upload endpoint will REFUSE this passport:');
               console.log('  derive: ' + (d.error.code ?? d.error)); process.exit(1); }
console.log('The live upload endpoint will accept this passport.');
" "$REPO" "$F" 2>&1); J=$?
# The gate's codes, one per line, as section 3 prints them. E_SECRET_FOUND is
# the one code that means "a credential is in the file"; validate.py never
# looks for credentials, so a refusal for that alone is not a difference
# between our engines and must not be reported as one. Nor is a refusal at
# stage 1, transport()'s codes below: validate.py never reads the bytes as
# bytes, by design, and preflight.py is stage 1's mirror, which the mirror
# banner compares. Digits too in a code: E_NOT_UTF8 is one, and only stage 1
# returns it.
GCODES=$(printf '%s\n' "$GOUT" | sed -n 's/^  \(E_[A-Z0-9_]*\)$/\1/p; s/^  derive: \(.*\)$/derive:\1/p')
SECRET=0; OTHER=0; STAGE1=0
for c in $GCODES; do
    case "$c" in
        E_SECRET_FOUND) SECRET=1 ;;
        E_TOO_LARGE|E_TOO_SMALL|E_NOT_UTF8|E_CONTROL_CHARS) STAGE1=1; OTHER=1 ;;
        *) OTHER=1 ;;
    esac
done
# Section 4: line numbers only, never the matching text. Byte-wise, in the C
# locale and with -a: in a UTF-8 locale macOS grep skips any line carrying one
# invalid byte (a Latin-1 e-acute is enough) and cut stops on it, so SHAPES came
# back empty, nothing was withheld, and the gate's message printed the key
# (round-2 critic). -a also stops a NUL byte turning the answer into "Binary
# file <path> matches". sk- needs a non-alphanumeric before it, or
# "task-scheduler-for-weekly-reports" is a credential and a clean file is
# withheld; OPENAI_sk-... still matches.
SHAPES=$(LC_ALL=C grep -anE 'ntn_[A-Za-z0-9]{20,}|(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|xox[abprs]-|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN' "$F" | LC_ALL=C cut -d: -f1 | paste -sd, - | sed 's/,/, /g')
WITHHOLD=0
if [ "$SECRET" -eq 1 ] || [ -n "$SHAPES" ]; then WITHHOLD=1; fi

echo "=== 1. tools/validate.py  (the format contract, spec section 7) ==="
if [ "$WITHHOLD" -eq 1 ]; then echo "validate.py exit $V. Details withheld, see below."
else printf '%s\n' "$VOUT"; fi
echo
echo "=== 2. tools/preflight.py (a Python mirror of the endpoint's content scans) ==="
if [ "$WITHHOLD" -eq 1 ]; then echo "preflight.py exit $P. Details withheld, see below."
else printf '%s\n' "$POUT"; fi
echo
echo "=== 3. web/lib/_validate.mjs + _derive.mjs  (THE GATE ITSELF: the module"
echo "       upload.mjs imports, run here on your file) ==="
if [ "$WITHHOLD" -eq 1 ]; then
    # The verdict line, each code, and E_SECRET_FOUND's "line N: kind" details,
    # the kind kept only when it is plain words. Nothing else the gate wrote.
    printf '%s\n' "$GOUT" | awk '
        /^The live upload endpoint will (REFUSE this passport:|accept this passport\.)$/ { print; next }
        /^  E_[A-Z0-9_]*$/ { print; insecret = ($1 == "E_SECRET_FOUND"); next }
        /^  derive: [A-Z_]+$/ { print; insecret = 0; next }
        /^  derive: / { print "  derive: (detail withheld)"; insecret = 0; next }
        insecret && /^    line [0-9]+: / {
            n = $2; sub(/:$/, "", n); k = $0; sub(/^    line [0-9]+: /, "", k)
            if (k ~ /^[A-Za-z][A-Za-z ]*$/) print "    line " n ": " k; else print "    line " n
        }'
    echo "    (the gate's other details and messages withheld, see below)"
else
    printf '%s\n' "$GOUT"
fi
echo
echo "=== 4. raw credential shapes, independent of all three ==="
if [ -n "$SHAPES" ]; then
    echo ">>> A CREDENTIAL SHAPE IS IN THE PASSPORT, on line $SHAPES. Do not upload."
    echo ">>> In RUN-NOTES.md, record that this happened and the line number, never the value."
else
    echo "none found by these patterns. This is my pattern list, not a guarantee: a credential shaped unlike all of them reads the same as none."
fi
echo
echo "------------------------------------------------------------------"
echo "validate.py exit $V   preflight.py exit $P   live gate exit $J"
if [ "$P" -ne "$J" ]; then
    echo
    echo ">>> THE MIRROR AND THE GATE DISAGREE ON YOUR FILE. That is a finding"
    echo ">>> worth more than the run. Copy all of the above into RUN-NOTES.md."
fi
if [ "$SECRET" -eq 1 ]; then
    echo
    echo ">>> THE LIVE GATE FOUND WHAT LOOKS LIKE A CREDENTIAL IN YOUR FILE."
    echo ">>> Section 3 above names the line. Remove it from the passport and run this check again."
    echo ">>> Treat that credential as exposed and rotate it."
    echo ">>> In RUN-NOTES.md, record that this happened and the line number, never the value."
fi
if [ "$WITHHOLD" -eq 1 ]; then
    echo
    echo ">>> Details from sections 1 to 3 are withheld because this file appears to contain a"
    echo ">>> credential, and those details can repeat it. Remove it and run this check again to see them."
fi
# A refusal for a credential alone, or at stage 1, is not a disagreement (see
# GCODES above).
if [ "$V" -ne "$J" ] && ! { [ "$V" -eq 0 ] && { [ "$STAGE1" -eq 1 ] || { [ "$SECRET" -eq 1 ] && [ "$OTHER" -eq 0 ]; }; }; }; then
    echo
    echo ">>> validate.py and the live gate reached different verdicts on this file."
    echo ">>> The upload will give the live gate's verdict. Copy all of the above into RUN-NOTES.md."
fi
# Exit with the live gate's verdict, so the stager's smoke test can read it.
exit "$J"

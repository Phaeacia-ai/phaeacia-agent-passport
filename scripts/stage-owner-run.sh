#!/usr/bin/env bash
# Stage a real-owner Path W run from the prompt that is ON MAIN RIGHT NOW.
#
# WHY THIS EXISTS. ~/Phaeacia/pathw-test/PASTE-THIS.md was a hand-cut copy of
# PART B frozen on 2026-09-01. By 2026-09-17 the prompt had moved 18 commits and
# nothing anywhere connected the two, so the copy rotted silently and a real
# owner's run on 2026-09-16 was conducted on a prompt we had already replaced.
# That is the failure class in record/findings/a-copy-with-no-link-back-to-its-source.md.
# A generated file with its source commit stamped in it cannot rot silently:
# re-run this and diff.
#
# THE EXTRACTION IS THE SITE'S, NOT A LINE RANGE. web/build.sh takes PART B as
# the text between the two four-or-more-backtick fences, and refuses to finish
# if there are not exactly two or if the body does not begin with the expected
# sentence. Copying that logic here rather than cutting lines 31-464 is the
# whole point: an owner staged from this file and an owner who clicks Copy on
# /create must be running the same bytes. This script CHECKS that they are.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-}"
if [ -z "$OUT" ]; then
    echo "usage: $(basename "$0") <output-directory>" >&2
    echo "  writes PASTE-THIS.md and PROVENANCE.txt there" >&2
    exit 2
fi
mkdir -p "$OUT"

SRC="$REPO/capture/path-w-prompt.md"
[ -f "$SRC" ] || { echo "FAIL: no prompt at $SRC" >&2; exit 1; }

# Refuse to stage from a dirty or unknown tree. An owner run is an experiment,
# and "which prompt was this?" must have an answer that is not "roughly main".
COMMIT="$(git -C "$REPO" rev-parse HEAD)"
if ! git -C "$REPO" diff --quiet -- capture/path-w-prompt.md; then
    echo "FAIL: capture/path-w-prompt.md has uncommitted changes." >&2
    echo "  Stage a run only from a committed prompt, or the provenance line is a guess." >&2
    exit 1
fi

python3 - "$SRC" "$OUT" "$COMMIT" <<'PY'
import sys, pathlib, hashlib, subprocess, datetime
src, out, commit = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
EXPECTED = "You are running an Agent Passport capture, format version 0.1, capture path W (browser)."
lines = src.read_text(encoding="utf-8").split("\n")
fences = [i for i, l in enumerate(lines) if l.startswith("````")]
if len(fences) != 2:
    sys.exit("FAIL: expected exactly 2 four-plus-backtick fence lines, found %d at %s"
             % (len(fences), [i + 1 for i in fences]))
body = "\n".join(lines[fences[0] + 1:fences[-1]]).strip() + "\n"
if not body.startswith(EXPECTED):
    sys.exit("FAIL: PART B does not begin with the expected line; got %r"
             % (body.splitlines()[0] if body else ""))

# The date line is optional input, documented in PART A. It is prepended here
# rather than left to the owner because a capture writes `created:` from it and
# an owner pasting on a later day would otherwise date the passport wrong.
today = datetime.date.today().isoformat()
staged = "Today is %s.\n\n%s" % (today, body)
(out / "PASTE-THIS.md").write_text(staged, encoding="utf-8")

(out / "PROVENANCE.txt").write_text(
    "PART B of capture/path-w-prompt.md\n"
    "commit        %s\n"
    "prompt sha256 %s\n"
    "block sha256  %s\n"
    "staged        %s\n"
    "date line     Today is %s.\n"
    "gate commit   %s  (the gate check.sh runs, snapshotted from the same commit)\n"
    "\n"
    "Regenerate with scripts/stage-owner-run.sh and diff. If this file and the\n"
    "prompt on main disagree, the staged copy is the stale one.\n"
    % (commit,
       hashlib.sha256(src.read_bytes()).hexdigest(),
       hashlib.sha256(body.encode()).hexdigest(),
       today, today, commit),
    encoding="utf-8")
print("   staged PART B from %s" % commit[:12])
print("   block sha256 %s" % hashlib.sha256(body.encode()).hexdigest())
PY

# The check that makes this more than a copy: the staged block must equal what
# the site serves, when the site's copy has been built. If web/build.sh has not
# run, say so rather than passing silently.
# The observation sheet is versioned in capture/ and copied, never authored in
# the output directory, for the same reason as the block: a bench that lives
# only in an untracked folder drifts away from the prompt it scores. The one in
# pathw-test/ was written for a prompt whose R5 said "You have no tools", a
# sentence the current prompt does not contain.
cp "$REPO/capture/owner-run-notes-template.md" "$OUT/RUN-NOTES.md"
echo "   RUN-NOTES.md copied from capture/owner-run-notes-template.md"

# The checker is copied for the same reason as the notes: versioned here, never
# authored in the output directory. It runs the gate itself rather than a mirror
# of it, so it cannot drift from what the live endpoint does. See its header.
#
# WHICH GATE IT RUNS. It runs a snapshot of the gate taken from $COMMIT, the
# same commit PROVENANCE.txt names for the prompt. Until 2026-09-21 it was
# stamped with the main checkout's path, and the main checkout is not main:
# nothing moves it when origin/main moves, and on 2026-09-21 it sat on a commit
# whose _validate.mjs was 117 lines older than main's, so a run folder whose
# PROVENANCE named a main commit ran a gate that commit had replaced
# (record/findings/owner-run-check-sh-runs-the-main-checkout-and-the-main-checkout-is-not-main.md).
# Before that it was stamped with $REPO, which breaks when a worktree is deleted.
# Any path to a live tree has one of those two failures; a snapshot of a commit
# has neither.
#
# The snapshot lives BESIDE the run folder, not inside it, because the run
# folder is what gets handed to an outside runner and the gate is our source
# code. It is content-addressed by commit and written once: a second staging
# from the same commit reuses it after checking it is byte-identical.
GATE_FILES="tools/validate.py tools/preflight.py web/lib/_validate.mjs web/lib/_derive.mjs web/lib/_sections.mjs"
OUT_ABS="$(cd "$OUT" && pwd)"
GATE_DIR="$(dirname "$OUT_ABS")/owner-run-gates/$COMMIT"
GATE_TMP="$(mktemp -d)"
# shellcheck disable=SC2086
git -C "$REPO" archive --format=tar "$COMMIT" $GATE_FILES | tar -x -C "$GATE_TMP"
( cd "$GATE_TMP" && python3 - $GATE_FILES > MANIFEST <<'MANI'
import hashlib, sys
for f in sys.argv[1:]:
    print("%s  %s" % (hashlib.sha256(open(f, "rb").read()).hexdigest(), f))
MANI
)
echo "$COMMIT" > "$GATE_TMP/GATE-COMMIT"
if [ -d "$GATE_DIR" ]; then
    if ! diff -r "$GATE_TMP" "$GATE_DIR" >/dev/null; then
        echo "FAIL: $GATE_DIR exists and differs from a fresh snapshot of $COMMIT." >&2
        echo "  A gate snapshot is written once. Something edited it; find out what before re-staging." >&2
        rm -rf "$GATE_TMP"; exit 1
    fi
    rm -rf "$GATE_TMP"
    echo "   gate snapshot reused, identical: $GATE_DIR"
else
    mkdir -p "$(dirname "$GATE_DIR")"
    mv "$GATE_TMP" "$GATE_DIR"
    chmod -R a-w "$GATE_DIR"
    echo "   gate snapshot written: $GATE_DIR"
fi

# The manifest's own hash goes into check.sh. Without it the manifest is
# checked only against itself, so a snapshot edited together with its manifest,
# or with the manifest emptied, read as verified and ran whatever was there: a
# critic did exactly that with ebc499d's _validate.mjs and got "live gate exit 0"
# on a homoglyph credential under a banner naming $COMMIT. check.sh lives in the
# run folder, not in the snapshot, so the anchor sits outside what it anchors.
MANIFEST_SHA="$(python3 -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$GATE_DIR/MANIFEST")"
sed -e "s|@@GATE_DIR@@|$GATE_DIR|" -e "s|@@GATE_COMMIT@@|$COMMIT|" \
    -e "s|@@GATE_MANIFEST_SHA@@|$MANIFEST_SHA|" \
    "$REPO/capture/owner-run-check.sh" > "$OUT/check.sh"
chmod +x "$OUT/check.sh"
grep -q '@@GATE_' "$OUT/check.sh" && { echo "FAIL: gate path or commit not substituted into check.sh" >&2; exit 1; }
echo "   check.sh copied from capture/owner-run-check.sh"

# A snapshot that cannot run is worse than none, because check.sh would print
# a refusal that is really a missing import. So run it here, on one file the
# gate must accept and one it must refuse; either wrong answer stops staging.
if ! "$OUT/check.sh" "$REPO/tools/fixtures/passports/valid_minimal.md" 2>&1 \
     | grep -q '^validate.py exit 0   preflight.py exit 0   live gate exit 0$'; then
    echo "FAIL: the staged check.sh does not ACCEPT tools/fixtures/passports/valid_minimal.md on all three engines." >&2
    echo "  Run it by hand to see why: $OUT/check.sh $REPO/tools/fixtures/passports/valid_minimal.md" >&2
    exit 1
fi
if "$OUT/check.sh" "$REPO/tools/fixtures/passports/invalid_bad_envelope.md" >/dev/null 2>&1; then
    echo "FAIL: the staged check.sh ACCEPTS tools/fixtures/passports/invalid_bad_envelope.md." >&2
    exit 1
fi
echo "   check.sh smoke-tested: accepts valid_minimal, refuses invalid_bad_envelope"

cp "$REPO/capture/owner-run-readme.md" "$OUT/README.md"
echo "   README.md copied from capture/owner-run-readme.md"

SERVED="$REPO/web/assets/installer/path-w-block.txt"
if [ -f "$SERVED" ]; then
    A="$(python3 -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read().strip()+b'\n').hexdigest())" "$SERVED")"
    B="$(python3 -c "import hashlib,sys;d=open(sys.argv[1]).read().split('\n\n',1)[1];print(hashlib.sha256(d.encode()).hexdigest())" "$OUT/PASTE-THIS.md")"
    if [ "$A" = "$B" ]; then
        echo "   MATCHES the block served by /create"
    else
        echo "   WARNING: staged block differs from web/assets/installer/path-w-block.txt"
        echo "   Run web/build.sh; if they still differ, an owner staged from this file and"
        echo "   an owner clicking Copy on /create are running different prompts."
    fi
else
    echo "   NOTE: web/assets/installer/path-w-block.txt absent (web/build.sh not run here),"
    echo "   so the match against what /create serves was NOT checked."
fi

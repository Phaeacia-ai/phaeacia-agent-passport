#!/usr/bin/env bash
# Build the exact tree that would be published as the public skill repository.
#
# This creates no repository and pushes nothing.
#
# Usage: scripts/export-public.sh [OUTDIR]     (default: /tmp/agent-passport-public)
#
# SHAPE. The repository root IS the skill folder, so that installing is
# `git clone <url> ~/.claude/skills/agent-passport` and updating is `git pull`.
# That is a CHOICE, not a constraint, and the earlier version of this comment
# said otherwise. A skill also loads from a symlink and from a nested
# <root>/skills/<name>/SKILL.md, both demonstrated on this machine, so a source
# repository would install too, at the cost of a second command. We buy the
# one-command install and pay for it by publishing generated output, which
# cannot take pull requests. publish/README.md states that as a trade.

set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-/tmp/agent-passport-public}"

fail() { echo "REFUSING: $*" >&2; exit 1; }

# Any exit other than a clean one removes the output directory. A refusal that
# leaves a PARTIAL tree on disk is worse than one that leaves none: the next
# person sees a directory full of plausible files and has no way to tell it
# from a finished export. Observed leaving 18 of 22 files behind when the
# NOTICE check fired.
CLEAN_EXIT=0
trap '[ "$CLEAN_EXIT" = 1 ] || { [ -n "${OUT:-}" ] && [ -d "$OUT" ] && rm -rf "$OUT" && echo "   (removed the partial tree at $OUT)" >&2; }' EXIT

# --- tools, checked BEFORE anything is written -----------------------------
# The previous version ran gitleaks after building the tree and reported a
# missing binary as "gitleaks found something", which is a lie about a
# command-not-found, and left the unscanned tree on disk ready to push.
command -v gitleaks >/dev/null || fail "gitleaks is not on PATH. It is the leak check for the artefact that crosses from private to public; without it this refuses rather than exporting unscanned."

# --- the licence gate, stated POSITIVELY -----------------------------------
# This used to grep for the absence of "NOT OPEN SOURCE". An absence-based gate
# fails OPEN: deleting skills/LICENSE.md passed it and wrote a full tree, which
# is exactly what somebody does who thinks relicensing means removing the
# notice, and it produced the worst possible artefact. Rewording or changing
# case passed too. So require a positive marker instead: the notice must exist
# and must name the licence SKILL.md ships under.
SKILL_SPDX="CC-BY-4.0"
[ -f skills/LICENSE.md ] || fail "skills/LICENSE.md does not exist. SKILL.md must ship with a notice naming its licence; publishing it without one is worse than not publishing it."
grep -q "SPDX-License-Identifier: ${SKILL_SPDX}" skills/LICENSE.md \
  || fail "skills/LICENSE.md carries no 'SPDX-License-Identifier: ${SKILL_SPDX}' line. SKILL.md is the skill itself and this export will not ship it under a licence nobody has stated."

echo "── regenerating the skill tree from canonical sources"
./scripts/build.sh >/dev/null

# --- the manifest, so cp -R cannot ship a stray file ------------------------
# `cp -R skills/agent-passport/.` copies whatever is sitting in that folder. A
# .DS_Store, a __pycache__/*.pyc and a stray notes file carrying a key were all
# shipped by the previous version, and gitleaks passed. A test passport with a
# real owner's data ships identically. So the tree is named, not swept.
EXPECTED_SKILL_FILES="SKILL.md
references/installer-branches/chatgpt.md
references/installer-branches/claude-ai.md
references/installer-branches/claude-code.md
references/installer-branches/generic.md
references/installer-core.md
references/judge-prompt.md
references/passport-template.md
references/resolution.yaml
references/spec-schema.md
references/vocabulary.md
scripts/assemble.py
scripts/preflight.py
scripts/publish.py
scripts/scrub.py
scripts/validate.py"

ACTUAL=$(cd skills/agent-passport && find . -type f | sed 's|^\./||' | sort)
if [ "$ACTUAL" != "$(echo "$EXPECTED_SKILL_FILES" | sort)" ]; then
  echo "REFUSING: the skill folder does not match the manifest." >&2
  echo "  only in the folder (would have shipped):" >&2
  comm -23 <(echo "$ACTUAL") <(echo "$EXPECTED_SKILL_FILES" | sort) | sed 's/^/    /' >&2
  echo "  only in the manifest (missing):" >&2
  comm -13 <(echo "$ACTUAL") <(echo "$EXPECTED_SKILL_FILES" | sort) | sed 's/^/    /' >&2
  echo "  If a file was added on purpose, add it here too. This list is the boundary." >&2
  exit 1
fi

rm -rf "$OUT"; mkdir -p "$OUT"
echo "── copying the $(echo "$EXPECTED_SKILL_FILES" | wc -l | tr -d ' ') named files"
while IFS= read -r f; do
  mkdir -p "$OUT/$(dirname "$f")"
  cp "skills/agent-passport/$f" "$OUT/$f"
done <<< "$EXPECTED_SKILL_FILES"

# --- licences ---------------------------------------------------------------
# Root LICENSE is CC BY 4.0, which is what GitHub reads to badge the repository.
# That is accurate for the work this repository IS: SKILL.md and everything
# under references/ is CC BY. The five scripts are Apache 2.0 and ship with
# their own full text and NOTICE beside them, and LICENSE-MAP.md is the
# authoritative per-file map.
#
# The previous version put Apache 2.0 at root, which would have badged the whole
# tree Apache including SKILL.md, and shipped no notice for SKILL.md at all
# while LICENSE-MAP told the reader to go and read it.
# Root LICENSE is the VERBATIM CC BY 4.0 legal code, not our notice about it.
# GitHub's licence detector is a text matcher: given the notice, it reported the
# repository as "Other", which is also what an UNLICENSED repository shows. A
# stranger could not tell "carefully dual-licensed" from "no rights granted" at
# a glance, which defeats the reason for publishing. The notice carries nuance a
# badge cannot, so it ships too, as LICENSE-FORMAT.md.
cp publish/LICENSE-CC-BY-4.0.txt "$OUT/LICENSE"           # verbatim, for detection
cp spec/LICENSE.md      "$OUT/LICENSE-FORMAT.md"          # our notice and its reasoning
cp LICENSE              "$OUT/LICENSE-Apache-2.0.txt"     # covers scripts/
# NOTICE is REQUIRED, not conditional. Apache 2.0 section 4(d) makes it part
# of redistribution, so shipping the five Apache scripts without it is a
# compliance failure rather than an omission. The conditional form this
# replaces exported 21 files and exited 0 when NOTICE was absent: a silent
# pass, which is the same fail-open shape as the old licence gate. `set -e`
# does not catch it, because bash exempts the left side of an && list from
# errexit exactly as it exempts an if condition.
[ -f NOTICE ] || fail "NOTICE is missing. Apache 2.0 4(d) requires it to travel with the code in scripts/."
cp NOTICE "$OUT/NOTICE"
cp skills/LICENSE.md    "$OUT/LICENSE-SKILL.md"           # the notice LICENSE-MAP points at
cp publish/README.md    "$OUT/README.md"
cp publish/LICENSE-MAP.md "$OUT/LICENSE-MAP.md"
# .gitignore, because the five scripts are Python and running any of them by
# import writes scripts/__pycache__/*.pyc into the clone. A critic auditing this
# tree did exactly that and briefly turned 23 files into 25. Without this, the
# first thing a cloner who imports the scripts can do is commit compiled
# bytecode that no licence row covers.
cp publish/gitignore-for-export "$OUT/.gitignore"

# --- the boundary, actually computed ---------------------------------------
# The previous version printed this heading and ran no command: two echoes and
# an empty body, advertising the one check it did not perform.
echo "── the private/public boundary"
echo "   repository tracks $(git ls-files | wc -l | tr -d ' ') files; this export ships $(find "$OUT" -type f | wc -l | tr -d ' ')."
echo "   directories in the repo that do NOT cross, by name:"
git ls-files | awk -F/ '{print $1}' | sort -u | while read -r d; do
  case "$d" in
    skills|spec|installer|LICENSE|NOTICE|publish) ;;
    *) echo "     $d" ;;
  esac
done

# --- the restructure leaves prose pointing at the old layout -----------------
# The export MOVES files: installer/core.md becomes references/installer-core.md,
# tools/validate.py becomes scripts/validate.py, spec/ becomes references/. The
# prose that names those files was written for the source repository and is
# correct THERE, so the fix belongs here rather than in the canonical text: a
# generator that restructures a tree must restructure the references into it.
#
# Measured 2026-08-23 before this existed: seven cited paths did not exist in the
# export. Four were broken cross-references, including spec-schema.md telling a
# reader "tools/validate.py is the executable form of this specification" when it
# ships as scripts/validate.py, so anyone who followed the sentence found nothing.
# Three disclosed private repository structure to a public reader.
echo "── rewriting paths for the published layout"
python3 - "$OUT" <<'REWRITE'
import os, re, sys
out = sys.argv[1]
MAP = [
    (r"spec/resolution\.d/[A-Za-z0-9._-]+\.yaml", "references/resolution.yaml"),
    (r"installer/branches/([A-Za-z0-9._-]+)\.md",  r"references/installer-branches/\1.md"),
    # The BARE directory, which the rule above cannot see because it needs a
    # filename after the slash. assemble.py's LAYOUTS table holds
    # "installer/branches" as a plain string, so the private directory shipped
    # in working code while every prose mention of it was being rewritten. This
    # entry must stay AFTER the one above, or it would rewrite the prefix and
    # leave the filename behind.
    (r"installer/branches",                        "references/installer-branches"),
    (r"installer/core\.md",                        "references/installer-core.md"),
    (r"spec/passport-0\.1\.md",                   "references/spec-schema.md"),
    (r"spec/passport-template\.md",                "references/passport-template.md"),
    (r"spec/resolution\.yaml",                     "references/resolution.yaml"),
    (r"spec/vocabulary\.md",                       "references/vocabulary.md"),
    (r"verification/judge-prompt\.md",             "references/judge-prompt.md"),
    (r"tools/(scrub|validate|preflight)\.py",      r"scripts/\1.py"),
    # The source repository is public since the project was archived, so a file
    # under web/ that a shipped comment names becomes a link a reader can follow.
    # Before that it was a private path and the gate below refused it, which is
    # why the export had stopped running: assemble.py and preflight.py both cite
    # the site's own modules.
    (r"(?<![\w./-])web/((?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+\.(?:mjs|js|html|css|md|py|toml|json))",
     r"https://github.com/Phaeacia-ai/phaeacia-agent-passport/blob/HEAD/web/\1"),
]
changed = 0
for root, _, files in os.walk(out):
    for name in files:
        if not name.endswith((".md", ".yaml", ".py")):
            continue
        path = os.path.join(root, name)
        src = open(path, encoding="utf-8").read()
        new = src
        for pat, rep in MAP:
            new = re.sub(pat, rep, new)
        if new != src:
            open(path, "w", encoding="utf-8").write(new)
            changed += 1
            print("   rewrote %s" % os.path.relpath(path, out))
print("   %d file(s) rewritten" % changed)
REWRITE

# --- and then REFUSE if anything still points at a file we do not ship -------
# The rewrite above is a list, and a list is a guess about what is there. This
# is the check that does not depend on the guess being complete.
#
# WIDENED 2026-08-23, because the first version only saw BACKTICKED paths in
# markdown. A critic found 23 private artefacts across 13 of the 16 content
# files, and every serious one was a BARE path inside a Python comment:
# web/lib/_validate.mjs, web/tools/parity.mjs, tools/scrub.py,
# scripts/passport-to-page.py, site/spec/upload-validation.md,
# web/lib/_sections.mjs. Six of six were invisible to the first gate. A check
# written from the examples you already have will only ever find those examples,
# so this one matches on shape rather than on decoration.
echo "── every cited path must exist in the export"
python3 - "$OUT" <<'DANGLE'
import os, re, sys
out = sys.argv[1]
# Paths deliberately named although they are not shipped. Each needs a REASON,
# because an allow list without one becomes a place defects go to be forgotten.
ALLOWED = {
    "scripts/build.sh":   "named as the generator; the public tree is its output, not its source",
    "installer/branches": "a key in assemble.py's LAYOUTS table, which resolves BOTH the source layout and this one; it is working code, not a citation",
    "spec/resolution.d/": "named in the generated resolution header as the directory the map is built from",
    "build.sh":           "the generator, named as the thing whose output this tree is",
    "plugin.json":        "a Claude Code platform file the installer branch must name; we happen to track one too",
    "scalar_probes.json": "read only by validate.py's developer flag --dump-scalar, from a fixtures folder beside the script; the skill never passes that flag",
}
TOPS = ("spec","installer","tools","verification","capture","examples",
        "skills","scripts","publish","web","site","record")
EXTS = ("md","py","mjs","js","yaml","yml","sh","txt","json","toml","html")

# Bare or backticked, in prose or in a comment. A leading ../ is stripped and
# still checked, because "../capture/LICENSE.md" names a private file just as
# plainly as "capture/LICENSE.md" does.
path_re = re.compile(
    r"(?<![\w./-])(?:\.\./)*((?:%s)/[A-Za-z0-9._/-]*\.(?:%s))"
    % ("|".join(TOPS), "|".join(EXTS)))
# A directory reference, which leaks structure without naming a file.
dir_re = re.compile(r"(?<![\w./-])(?:\.\./)*((?:%s)/[A-Za-z0-9._-]+)/" % "|".join(TOPS))
# A BARE FILENAME with no directory in front of it. Added 2026-08-23 after five
# leaks walked through the directory-anchored patterns above: run-tests.mjs twice,
# upload-validation.md, redos_seeds.json (which this script's own author put there
# while fixing the previous round), and a timing constant beside them. A private
# file does not stop being private because nobody wrote its directory down.
# NOT a generic bare-name rule: that flagged settings.json and mcp.json, which are
# the INSTALLER'S platform files and must be named. The signal is ownership, so it
# is taken from the source repository: a basename that git tracks here and that the
# export does not ship is ours and is private. Structural, not a hand-kept list.
#
# The leading underscore is in the first character class deliberately, added
# 2026-08-31. Without it this rule could not see _validate.mjs, and that is not
# an edge case: every private library module on the site is named that way,
# _validate, _metrics, _sections, _store, _derive and a dozen more, so the one
# rule meant to catch a private filename with no directory in front of it was
# blind to the entire naming convention of the private files most likely to be
# cited. Found when the directory-anchored rule caught web/lib/_validate.mjs in
# a comment and this rule had been silently passing the bare form of the same
# name in preflight.py for eight days. The underscore cannot start a match
# mid-word: the lookbehind excludes \w, so redos_seeds.json is still one token.
BARE_EXTS = ("mjs", "js", "json", "sh", "toml", "yaml", "yml", "py", "md")
bare_re = re.compile(r"(?<![\w./-])([A-Za-z0-9_][A-Za-z0-9._-]*\.(?:%s))\b" % "|".join(BARE_EXTS))
TRACKED = {os.path.basename(f) for f in
           os.popen("git ls-files").read().split("\n") if f.strip()}
# Git object names. Seven to forty hex, not part of a longer word, and not a
# plausible hash EXAMPLE (those live beside the word sha256 or in a fixture).
# The underscore is in BOTH boundaries, added 2026-08-31. Without it this rule
# fires on "ed25519" inside "id_ed25519": seven characters, every one of them a
# hex digit, preceded by an underscore rather than a letter. It refused a commit
# that was widening the validator's denied-path list to catch modern SSH key
# names, which is the worst kind of false positive, one that blocks a security
# fix. A commit sha is not written as one half of a snake_case identifier.
sha_re = re.compile(r"(?<![0-9a-zA-Z_])[0-9a-f]{7,40}(?![0-9a-zA-Z_])")

bad, shas = [], []
for root, _, files in os.walk(out):
    for name in files:
        path = os.path.join(root, name)
        rel = os.path.relpath(path, out)
        if rel in ("LICENSE", "LICENSE-Apache-2.0.txt"):
            continue                      # verbatim licence texts, not ours to edit
        try:
            text = open(path, encoding="utf-8").read()
        except (UnicodeDecodeError, OSError):
            continue
        candidates = set(path_re.findall(text))
        candidates |= set(d + "/" for d in set(dir_re.findall(text)))
        # A bare name counts only if the export contains no file by that name;
        # package.json inside a code example is not a leak.
        shipped = {f for _, _, fs in os.walk(out) for f in fs}
        candidates |= {b for b in bare_re.findall(text)
                       if b in TRACKED and b not in shipped}
        for m in candidates:
            if m in ALLOWED or m.rstrip("/") in ALLOWED:
                continue
            if not os.path.exists(os.path.join(out, m.rstrip("/"))):
                bad.append((rel, m))
        for line in text.splitlines():
            if "sha256" in line.lower() or "sha1" in line.lower():
                continue                  # a documented hash, not a commit
            for h in sha_re.findall(line):
                if len(h) in (7, 8, 9, 10, 40) and not h.isdigit():
                    shas.append((rel, h, line.strip()[:90]))

if bad or shas:
    print("REFUSING: the export names things it does not contain.", file=sys.stderr)
    for f, m in sorted(set(bad)):
        print("    path  %s  ->  %s" % (f, m), file=sys.stderr)
    for f, h, ctx in sorted(set(shas)):
        print("    commit-shaped  %s  ->  %s   in: %s" % (f, h, ctx), file=sys.stderr)
    print("  Rewrite it, delete it, or name it in ALLOWED with a reason.", file=sys.stderr)
    sys.exit(1)
print("   no unresolved path or commit reference (%d allowed by name)" % len(ALLOWED))
DANGLE

# --- and REFUSE if anything names the private side of this project ----------
# The gate above asks whether a cited path EXISTS in the export. That is a
# different question from whether a string names something a reader is not
# supposed to know about, and three internal issue identifiers walked straight
# through it on 2026-08-31: they are not paths, so nothing looked at them.
#
# A tracker key is the cheap case and it is not the reason this exists. The
# reason is that every one of these strings is a pointer into a place the reader
# cannot reach, and a pointer into a private place discloses the place. ROW-108
# tells a stranger there is a board, that it has at least 108 issues, and that
# this rule came out of one of them.
#
# WHAT THE FIRST VERSION OF THIS GATE GOT WRONG, both directions, in one pass:
#
#   MISSED. It hardcoded one prefix, case-sensitive, hyphen-only, so PHA-412,
#   AP-77, ROW_108, row-108, ROW-108 with an en dash and "issue #108 on the
#   board" all passed it, and it matched line by line, so a machine path wrapped
#   across two lines of a comment passed as well.
#
#   REFUSED WRONGLY. It refused "a publish/subscribe channel", "the
#   verification/validation split", "an orchestrator agent" and /Users/CHANGEME.
#   The last is not a hypothetical: tools/run_tests.sh test 4 tells a developer
#   in its own failure text to write /Users/CHANGEME, and this gate refused the
#   remediation the test suite prescribes. Two gates on one property that
#   disagree about it is worse than one gate, so the placeholder and home
#   allowances below are taken from that test rather than invented here.
#
# A gate that refuses ordinary English is a gate somebody disables on a launch
# night, and a disabled gate is the one failure mode this whole script exists
# to prevent. False positives are treated as defects here, not as caution.
echo "── nothing may name the private side of this project"
python3 - "$OUT" <<'INTERNAL'
import os, re, sys
out = sys.argv[1]

# A tracker key is PREFIX-NUMBER, and so is half of every standards name ever
# written. The shape cannot tell them apart, so the shape rule carries an
# exclusion list, and each entry needs a REASON for the same argument the
# ALLOWED list above makes: a list without reasons becomes a place defects go to
# be forgotten. This list is the weakest thing in this file. It is a guess about
# what a future author writes, and the rule beneath it, which matches OUR key in
# every way a person mistypes it, is the one that does the real work.
NOT_A_TRACKER_KEY = {
    "UTF":  "UTF-8 and UTF-16, named all through the encoding rules",
    "AES":  "AES-128 and AES-256, named where key material is described",
    "SHA":  "SHA-1 and SHA-256, named beside digests",
    "RFC":  "RFC-3986 and friends, cited as normative sources",
    "ISO":  "ISO-8601, the date format the spec requires",
    "BY":   "CC BY-4.0, which is the licence this repository ships under",
    "CC":   "CC-BY-4.0, the same licence written the other way",
    "HMAC": "HMAC-SHA256, named in signed-URL examples",
    "US":   "US-ASCII, named where character classes are described",
}

# OUR key, in every form a person retypes it: any case, hyphen, underscore, en
# or em dash, and with or without a space. Narrow enough to carry no exclusion
# list at all, which is why it is separate from the shape rule above.
OURS = re.compile(r"(?<![A-Za-z0-9])[Rr][Oo][Ww][-_–—]\s?[0-9]{1,5}(?![0-9])")
SHAPE = re.compile(r"(?<![A-Za-z0-9])([A-Z]{2,6})-([0-9]{1,5})(?![0-9])")
# "#108" alone is a markdown anchor, a CSS id and a colour. It is an issue
# reference only when something says so.
NUMBERED = re.compile(r"(?i)(?<![A-Za-z0-9])(issue|ticket|board item|card)\s+#?[0-9]{1,5}(?![0-9])")

# Taken verbatim from tools/run_tests.sh test 4, so the two gates cannot drift
# into disagreeing about the same property. Changing one without the other is
# the defect, not the duplication.
GENERIC_HOME = {".claude", ".config", ".local", "Library",
                "Downloads", "Desktop", "daily-brief"}
PLACEHOLDER = re.compile(
    r"^(CHANGEME|USERNAME|USER|YOU|YOURNAME|YOUR_NAME|YOUR-NAME|NAME|"
    r"\{\{?[^}]+\}?\}|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)$")
USER_PATH = re.compile(r"/(?:Users|home)/([^/\s\"'<>`]*)")
HOME_PATH = re.compile(r"(?:~|\$HOME|\$\{HOME\})/([A-Za-z0-9._-]+)")

# ANCHORED, not bare tokens. "publish/", "verification/", "website/",
# "observer/" and "research/" are ordinary English with a slash in it, and the
# gate above already refuses any of them followed by a filename it does not
# ship. What is left for this rule is the shape that gate cannot see: our tree
# by name.
# THE LEADING SLASH IS THE FORM THIS LEAK ACTUALLY TAKES, so "/" is deliberately
# NOT in the lookbehind class. It was, and that excluded every path written the
# way a served document writes one: an href, a Disallow line, a URL. Measured on
# the shipped form, all four missed and all four are caught now:
#
#     /record/findings/x.md              a root-relative link
#     https://x/record/decisions/y.md    a URL
#     Disallow: /worktrees/row-135       a robots.txt line
#     a/design-studies/b                 any path with a parent segment
#
# The class exists to stop a match inside a longer word, and the remaining
# characters do that job on their own: "myrecord/findings" and
# "the_record/findings" are still not matched, because "y" and "_" are still in
# the class. The slash bought nothing for that purpose and cost those four.
PRIVATE_DIR = re.compile(
    r"(?<![A-Za-z0-9._-])(?:record/(?:findings|decisions|proposals|root-snapshot)"
    r"|worktrees/|design-studies/|~/Phaeacia|~/Local)")

# ACCEPTED MISS, stated rather than discovered later: bare "orchestrator" is not
# here. It is an ordinary word for an ordinary thing in this product's own
# subject matter, and refusing it costs more than the leak it prevents. The four
# hyphenated lane names are unambiguous and stay.
CREW_ROLE = re.compile(
    r"(?<![A-Za-z-])(?:passport-engineer|skill-engineer|web-frontend|web-backend)"
    r"(?![A-Za-z-])")

TRACKER_URL = re.compile(r"linear\.app|\.atlassian\.net|notion\.so/[A-Za-z0-9-]")

# A leak wrapped across two lines of a comment matched nothing when this scanned
# line by line: "/Users/" ended one line and the account name began the next,
# and "web-" ended one and "frontend" began the next. So each file is scanned
# twice, once as written and once with every line break and comment leader
# folded away to NOTHING rather than to a space. A space is what a reader sees
# and it is not what the split identifier is; folding to a space leaves the two
# halves as separate tokens and catches nothing, which is what the first attempt
# at this did. The second pass reports no line number, because the offset no
# longer corresponds to one; it reports the file.
FOLD = re.compile(r"\n[ \t]*(?:#|//|\*|--)?[ \t]*")

def scan(text):
    hits = []
    for m in OURS.finditer(text):
        hits.append(("issue identifier", m.group(0),
                     "the private issue tracker's key. A reader cannot open it, "
                     "and the number discloses the size of the board"))
    for m in SHAPE.finditer(text):
        if m.group(1) in NOT_A_TRACKER_KEY:
            continue
        hits.append(("issue identifier, by shape", m.group(0),
                     "PREFIX-NUMBER is what a tracker key looks like. If this is "
                     "a standard rather than an issue, add its prefix to "
                     "NOT_A_TRACKER_KEY with the reason"))
    for m in NUMBERED.finditer(text):
        hits.append(("issue reference in words", m.group(0),
                     "an issue number is a pointer into a board a reader cannot open"))
    for m in TRACKER_URL.finditer(text):
        hits.append(("tracker or workspace URL", m.group(0),
                     "a link into a private workspace"))
    for m in USER_PATH.finditer(text):
        # An account name stops at the first piece of sentence punctuation.
        # Without this, "/Users/{user}." in prose reads as the account
        # "{user}." and the placeholder test, which requires a closing brace at
        # the end, refuses the one form the installer branch is required to
        # use; and in the folded pass the next line runs on, giving
        # "{user}.Notes". Truncating rather than stripping handles both. A real
        # account name loses nothing: the capture class already stops at "/".
        seg = re.split(r"[.,;:)\]!?]", m.group(1))[0]
        if seg and not PLACEHOLDER.match(seg):
            hits.append(("machine path", m.group(0),
                         "one account on one machine. Write it under $HOME, or "
                         "use /Users/CHANGEME, which is what test 4 asks for"))
    for m in HOME_PATH.finditer(text):
        if m.group(1) not in GENERIC_HOME:
            hits.append(("private home directory", m.group(0),
                         "this machine's layout, not every reader's. Generic: "
                         + ", ".join("~/" + d for d in sorted(GENERIC_HOME))))
    for m in PRIVATE_DIR.finditer(text):
        hits.append(("private directory", m.group(0),
                     "a directory that exists only on the private side"))
    for m in CREW_ROLE.finditer(text):
        hits.append(("crew role name", m.group(0),
                     "the name of a lane in the private crew, which discloses "
                     "how this is built and by what"))
    return hits

bad, unreadable = [], []
for root, _, files in os.walk(out):
    for name in files:
        path = os.path.join(root, name)
        rel = os.path.relpath(path, out)
        if rel in ("LICENSE", "LICENSE-Apache-2.0.txt"):
            continue                      # verbatim licence texts, not ours to edit
        try:
            text = open(path, encoding="utf-8").read()
        except (UnicodeDecodeError, OSError) as e:
            unreadable.append((rel, type(e).__name__))
            continue
        lines = text.splitlines()
        for label, hit, why in scan(text):
            i = text[:text.index(hit)].count("\n") + 1 if hit in text else 0
            bad.append((rel, i, label, hit,
                        (lines[i-1].strip()[:80] if 0 < i <= len(lines) else ""), why))
        # Second pass, unwrapped. Only report what the first pass did not.
        seen = {h for _, _, _, h, _, _ in bad}
        for label, hit, why in scan(FOLD.sub("", text)):
            if hit not in seen:
                bad.append((rel, 0, label + ", wrapped across lines", hit,
                            "(found only after folding line breaks)", why))

# A file this could not read is a file it did not check, and printing the green
# line anyway is the fail-open shape this script exists to remove.
if unreadable:
    print("REFUSING: %d file(s) could not be read, so they were not checked."
          % len(unreadable), file=sys.stderr)
    for rel, kind in unreadable:
        print("    %s  (%s)" % (rel, kind), file=sys.stderr)
    sys.exit(1)

if bad:
    print("REFUSING: the export names the private side of this project.",
          file=sys.stderr)
    seen = set()
    for rel, i, label, hit, ctx, why in sorted(set(bad)):
        print("    %s:%s  %s  ->  %s" % (rel, i or "?", label, hit), file=sys.stderr)
        if ctx:
            print("        in: %s" % ctx, file=sys.stderr)
        if label not in seen:
            print("        %s is %s." % (label, why), file=sys.stderr)
            seen.add(label)
    print("  Keep the substance and drop the pointer: say what was measured, "
          "not which issue asked for it.", file=sys.stderr)
    sys.exit(1)
print("   no internal identifier, machine path, private directory or crew name")
INTERNAL

echo "── leak check on the tree that would be published"
gitleaks dir "$OUT" --redact >/dev/null 2>&1 || fail "gitleaks flagged the export. Read it before doing anything else; this is the artefact that crosses to the public."

echo
echo "manifest: $(find "$OUT" -type f | wc -l | tr -d ' ') files, $(du -sh "$OUT" | cut -f1)"
find "$OUT" -type f | sed "s|$OUT/|   |" | sort
echo
echo "written to $OUT"
CLEAN_EXIT=1
echo "NOT created as a repository and NOT pushed."

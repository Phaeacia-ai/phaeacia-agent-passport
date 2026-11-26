#!/usr/bin/env python3
"""Fail the build when index.html and create.html drift apart.

index.html and create.html are the same page. They have been maintained by hand
as byte-identical twins since 490e80c, with nothing checking they stayed in step:
build.sh does not generate one from the other, and nothing else in this repo reads
them together. The header marks / as the Create page (aria-current="page"), so /
is what a stranger actually lands on -- index.html is the more important twin, not
the lesser, and today's one intentional difference is the og:url meta tag each
carries for its own address.

This has already bitten twice. frontend/row-262-create-browser-chat added the
path-W browser-chat copy button to create.html only. Separately, HAL's own brief
for the path-F copy-count work named create.html only, and its copy-count
attribute went into one file until a critic and HAL independently caught it before
either shipped. Neither divergence would have been visible to a build that never
compares the two files.

WHAT THIS CHECKS: index.html and create.html must be identical, line for line,
except for the ONE line named in ALLOWED_DIVERGENCE below, matched by its EXACT
text, not by a pattern. A rule guessed from a single instance -- "the lines may
differ if both contain a URL", say, or "if the only difference is the path
segment after the host" -- would also silently pass a change to the page <title>,
a script tag, or anything else that happened to fit the pattern, which is exactly
the failure mode that bit twice: a difference nobody looked at. Hard-coding the
one allowed pair forces a human to open this file and update
ALLOWED_DIVERGENCE, and read this docstring, on the day the difference legitimately
needs to change shape, rather than letting a broader rule absorb it unread. The
cost: a second legitimately-twinned pair, or a second allowed line on this same
pair, has to be added here by hand. That is cheap, and it is meant to be a
deliberate, visible edit rather than a maintenance-free rule.

THE ALLOWED DIVERGENCE MUST BE ANCHORED, NOT MERELY PRESENT. A round-1 critic
showed `cp create.html index.html` passed this check: the original version only
consulted ALLOWED_DIVERGENCE where a line actually differed, so two files that
agreed (wrongly) on a line never triggered it at all. That version was fixed by
counting how many times the substitution fired -- and a round-2 critic broke the
fix in turn: with the real og:url line made identical (and wrong) on both sides,
and a DECOY copy of the allowed pair inserted at some other line in both files,
the count still reached exactly one, satisfied by the decoy, while the real line
sat there silently wrong. So this version does not count occurrences across the
whole file. It requires the source text to appear in index.html EXACTLY ONCE, the
destination text to appear in create.html EXACTLY ONCE, and both at the SAME line
index -- which the decoy attack cannot satisfy, because it necessarily leaves the
source text appearing twice in index.html (the real, now-wrong line, plus the
decoy) and the destination text appearing only at the decoy in create.html, never
at the same index as index.html's real line.

SCOPE: this checks exactly the one known twin pair (index.html, create.html), not
"every page carrying a copy-button block." Those are different, and weaker,
invariants. Two files that must be byte-identical except one named line is a
precise, mechanical comparison. "A block shared across N pages that otherwise
differ on purpose" needs a marker convention, a rule for what counts as the same
block, and a decision about what is allowed to vary page to page -- a different
tool, with its own false-positive risk (a block that legitimately needs
page-specific wording would trip it). That need is speculative today -- raised as
a future concern during this same round of work, not a present instance -- so it
is not built here. Extend TWINS and ALLOWED_DIVERGENCE, or write that second tool,
the day a second real instance shows up.

WHAT THIS DOES NOT CATCH: a change made identically to both files that is wrong in
both, and any divergence between either twin and a THIRD page that also needs the
same content (there is no third page sharing this content today). Twins agreeing
is not twins being right.

Also not caught, found by a round-1 critic and left as is: a twin whose trailing
newline was stripped, or that was converted wholly to CRLF, still reads as
line-for-line identical and passes -- `str.splitlines()` normalizes both. Neither
affects what a browser renders or what a server sends, so this is stated as a
known limit rather than fixed at the cost of the line-level diff this check exists
to print. NOT included in that limit, despite an earlier version of this docstring
claiming otherwise until a round-2 critic ran it and found the claim false: a bare
`\\r` INSERTED INTO a line is not silently absorbed. `splitlines()` treats a lone
`\\r` as its own line break, so it changes the line count and this check's
length-mismatch guard catches it. Only a whole-file line-ending convention and a
missing final newline are invisible here.
"""
import difflib
import pathlib

WEB = pathlib.Path(__file__).resolve().parent.parent

# Every pair this check enforces. Add a pair here, and its allowed divergence (if
# any) below, the day a second genuine twin exists; do not generalize ahead of it.
TWINS = [
    ("index.html", "create.html"),
]

# The ONE difference each pair is allowed to carry, keyed by the pair and matched
# by the EXACT line text on each side -- see the docstring for why this is a
# lookup table of literal strings and not a pattern.
ALLOWED_DIVERGENCE = {
    ("index.html", "create.html"): {
        '<meta property="og:url" content="https://app.phaeacia.ai/">':
            '<meta property="og:url" content="https://app.phaeacia.ai/create">',
    },
}


def anchor(a_lines, b_lines, allowed):
    """Where each allowed (src, dst) pair actually sits, verified rather than
    trusted: src must appear in a_lines exactly once, dst must appear in b_lines
    exactly once, and they must be at the SAME index. Returns (anchored, issues):
    anchored maps that index -> (src, dst) for every pair that checked out;
    issues lists a human-readable problem for every pair that did not, naming
    where each side was actually found so a real drift and a moved line read
    differently."""
    anchored = {}
    issues = []
    for src, dst in allowed.items():
        a_hits = [i for i, line in enumerate(a_lines) if line == src]
        b_hits = [i for i, line in enumerate(b_lines) if line == dst]
        if len(a_hits) == 1 and len(b_hits) == 1 and a_hits[0] == b_hits[0]:
            anchored[a_hits[0]] = (src, dst)
        else:
            issues.append(
                "the allowed divergence is not anchored where it should be:\n"
                f"    expected exactly once, same line, on both sides\n"
                f"    found {src!r} at line(s) {[i + 1 for i in a_hits]}\n"
                f"    found {dst!r} at line(s) {[i + 1 for i in b_hits]}"
            )
    return anchored, issues


problems = []
for a_name, b_name in TWINS:
    a_path, b_path = WEB / a_name, WEB / b_name
    if not a_path.exists() or not b_path.exists():
        problems.append(f"{a_name} and {b_name} are declared twins but one of them is missing")
        continue

    a_lines = a_path.read_text(encoding="utf-8").splitlines()
    b_lines = b_path.read_text(encoding="utf-8").splitlines()
    allowed = ALLOWED_DIVERGENCE.get((a_name, b_name), {})

    pair_problems = []

    anchored, anchor_issues = anchor(a_lines, b_lines, allowed)
    pair_problems.extend(anchor_issues)

    # Every line NOT anchored as an allowed exception must match exactly. A
    # line-count mismatch (an inserted or removed line) is reported on its own:
    # zip() would silently stop at the shorter file and hide everything past it.
    if len(a_lines) != len(b_lines):
        pair_problems.append(
            f"{a_name} has {len(a_lines)} lines, {b_name} has {len(b_lines)}; "
            "this check only compares line-for-line and cannot align an insertion or deletion"
        )
    else:
        for i, (la, lb) in enumerate(zip(a_lines, b_lines)):
            if i in anchored:
                continue
            if la != lb:
                pair_problems.append(f"line {i + 1} differs and is not the allowed exception")

    if pair_problems:
        problems.append(f"{a_name} and {b_name} have drifted:")
        problems.extend("  " + p for p in pair_problems)

        # The full diff, for a human to actually read -- printing PROBLEMS is not
        # enough on its own; HAL asked for the differing lines to be exhibited.
        # Anchored lines are marked so a reader does not "fix" them: the ORIGINAL
        # failure this check exists to prevent was produced by a human doing
        # exactly that in response to an unmarked diff.
        anchored_src = {src for src, _dst in anchored.values()}
        anchored_dst = {dst for _src, dst in anchored.values()}
        problems.append("  full diff:")
        for line in difflib.unified_diff(a_lines, b_lines, fromfile=a_name, tofile=b_name, lineterm=""):
            mark = ""
            if line.startswith("-") and not line.startswith("---") and line[1:] in anchored_src:
                mark = "   <- the allowed exception, correct as is, do not change"
            elif line.startswith("+") and not line.startswith("+++") and line[1:] in anchored_dst:
                mark = "   <- the allowed exception, correct as is, do not change"
            problems.append("    " + line + mark)

if problems:
    print("FAIL: twin pages have drifted apart.")
    for p in problems:
        print(f"  {p}")
    print("  Make the files identical again, except any line marked above as the")
    print("  allowed exception -- or, if the new difference belongs, add it to")
    print("  ALLOWED_DIVERGENCE in tools/check-html-twins.py by hand and say why.")
    raise SystemExit(1)

print(f"html twins: {len(TWINS)} pair(s) checked, identical except the allowed divergence")
print("  NOT checked: a change made identically to both twins, and any third page")
print("  sharing the same content")

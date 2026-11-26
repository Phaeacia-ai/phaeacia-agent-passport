#!/usr/bin/env python3
"""Fail the build when an HTML comment does not close, so the working notes
inside it stop being working notes and become the page.

    python3 tools/check-comment-balance.py .

ROW-122. On 2026-09-01 an edit to create.html consumed the opening `<!--` of the
comment that followed and orphaned 57 lines of its body: a field-by-field
conformance table and a sentence naming what the product does not claim,
rendered as visible prose above the install block, ending in a literal `-->`
sitting in the page like a typo. Every check that ran stayed green:
check-preflight-list.py, run_tests.sh, run-tests.mjs. None of them reads the
page as a page; all of them read structure or lists. It was found by taking a
screenshot at 1440x900 and looking at it.

It happened again on 2026-09-03, same file, same general failure (working
notes rendering as page prose), a DIFFERENT shape, caught only by a critic
re-rendering the page rather than by any check. The second time was not a
consumed marker: an edit closed one comment early and opened a new one right
after it, both individually well-formed, with a live paragraph sitting
unguarded in the gap between them. Counted across the file, that edit was
`<!--` and `-->` in equal numbers throughout, both before and after — this
check would have printed green on the exact defect that motivated writing it.
Left in the docstring rather than quietly fixed, because a check whose limits
are undocumented gets trusted past them; see the record on a control aimed at
something it never actually verifies.

WHAT THIS CHECKS, AND THE HALF IT CANNOT. It counts `<!--` and `-->` per file
and fails if they disagree. That catches the 2026-09-01 shape: a marker
consumed, the rest of a comment spilling into rendered text as an odd count.
It does NOT catch the 2026-09-03 shape, where every marker is present and
matched but real content sits between two adjacent, individually valid
comments — an arithmetic check cannot distinguish "this stray paragraph used
to be inside the comment above it" from "this is legitimate visible copy
between two unrelated comments," because both look identical to a counter.
Catching that shape needs something that knows what the surrounding prose is
supposed to say, which is a different and harder check than this one. It
also does NOT parse HTML and does not know whether a `-->` sits inside a
`<script>` or a `<pre>` where it would not open a real comment in the first
place; none of the files here do that, and if one ever does, this check
needs a real parser, not a sharper regex.

WHY A COUNT AND NOT A PARSE. A balanced count is the cheap, total, structural
version of the same argument `check-served-clean.py` makes for stripping
comments rather than pattern-matching their contents: it does not depend on
predicting what an unclosed comment will contain, only on whether one exists.
The failure mode this exists to catch is arithmetic, so the check is
arithmetic.

WHY EVERY .html FILE AND NOT JUST create.html. The defect is in how an edit is
made, not in what the file is about; the next one could land anywhere. Cheap
enough to run against all of them.
"""
import pathlib
import sys

if len(sys.argv) != 2:
    print("usage: check-comment-balance.py <web-dir>")
    raise SystemExit(2)

WEB = pathlib.Path(sys.argv[1]).resolve()

problems = []
checked = 0
for f in sorted(WEB.glob("*.html")):
    checked += 1
    src = f.read_text(encoding="utf-8")
    opens = src.count("<!--")
    closes = src.count("-->")
    if opens != closes:
        problems.append(
            f"{f.name}: {opens} '<!--' but {closes} '-->'. "
            "An edit consumed or orphaned a comment marker; the working notes "
            "inside it are about to render as the page."
        )

if problems:
    print("FAIL: an HTML comment does not close.")
    for p in problems:
        print(f"  {p}")
    print("  Find the edit that touched the unbalanced marker and re-close the comment.")
    raise SystemExit(1)

print(f"comment balance: {checked} html file(s), every <!-- closes")

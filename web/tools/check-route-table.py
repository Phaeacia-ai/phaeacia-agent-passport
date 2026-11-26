#!/usr/bin/env python3
"""Fail the build when about.html's route table and the app's real routes disagree.

The table at about.html section 05 is the app describing itself: every route, what
it does, whether it needs an account. Nothing checked it, and on 2026-08-18 its
caption said "four endpoints ... and that is all of it" while five were deployed.
The fifth, /api/subscribe, is the one that takes an email address. Two further
claims in the same paragraph rested on the same omission.

WHAT THIS CHECKS, AND THE HALF IT CANNOT.

It compares route EXISTENCE in both directions, and it counts. It does not read
the descriptions, and that gap is the point rather than an oversight.

When a route changes MEANING the table does not change shape. If / stops being the
upload page it does not disappear: its row still matches a route, the counts still
agree, and this checker passes while the row lies. The upload-to-router move is
exactly that change, so the commit that lands it must rewrite / 's row BY HAND and
nothing here will remind anyone.

The checker catches "four" against five only because the number is checked, which
is exactly the argument for checking numbers and not sentences. A description is
prose and no checker knows what a page does. One that tried to judge prose would
join the four controls this crew found decorative in a week: correct over what
they examined, and never examining the thing.

WHY COUNTS ARE WORTH CHECKING AT ALL. Five count defects turned up in two days,
every one a completeness claim beside the list it counts, every one arithmetic,
every one drifted the same way: the list grew and the number stayed. None was
wrong when written. See record/findings/a-count-in-prose-is-an-unchecked-assertion.md.

ENDPOINTS ARE COUNTED FROM DECLARATIONS, NOT FROM RESPONSES. The count reads
`path:` out of each function's `export const config`, and out of nothing else:
it used to read the whole file and picked a path out of a COMMENT explaining why
that path had been removed. The note beside the code says what that cost. It does
not ask whether the path it finds answers.
On 2026-08-18 the marketing site ran a two-hour outage in which `/api/access`
declared its path correctly and returned 404 to every POST, and a test pinning
the config's shape passed green throughout.

That is the right question for this check — the caption claims how many endpoints
the app HAS, not how many are up — but it is stated because an unstated limit is
one somebody trusts past its range. Uptime is a probe's job and this is not one.

DYNAMIC ROUTES ARE DECLARED, NOT DERIVED. /p/:id is rendered by a function and has
no file, so it is listed below by hand. That is honest: this file verifies what is
mechanical and states what is not, rather than pretending the whole set is derived.

THE ONE THING THIS CHECK CANNOT SEE, AND BOTH ITS EARLY BUGS WERE IT. The check
compares two sets it builds itself. Anything absent from BOTH is invisible: a
declared path that is neither a page nor /api/*, and a table row whose markup
drifted so the row regex missed it. web-backend found both by running it against
inputs it had not seen, on the day it was written, in the checker whose own
subject is that class.

Both are now caught by asserting the leftovers rather than trusting them: every
declared path must land in pages, /api/*, or DECLARED_DYNAMIC, and the count of
capname cells must equal the count of rows parsed.

THE THREE CHECKS ARE NOT REDUNDANT AND A SIMPLIFIER SHOULD NOT DROP ONE. Each
covers a blind spot of the others, verified by running each failure rather than
reasoning about it:

  leftovers   catches a declared path that is neither a page nor /api/*, which
              the other two never see because it reaches neither set
  cell count  catches a row whose class drifted to "capname wide", for BOTH a
              discoverable route and the dynamic one, since it compares cells to
              rows and never consults set membership
  discovery   catches a row whose class is renamed entirely, which defeats the
              row pattern AND the cell pattern together, so cells and rows fall
              equal and stay silent

The only silent case left is an EXEMPT route whose row also drifted: absent from
both sets by design. EXEMPT is empty, and the comment beside it says why adding a
member without a reason is how this starts lying.

An earlier version of this docstring justified the cell count by a narrower
boundary: drift for a discoverable route was caught, drift for an invisible one
was not. That was true of the checker before the fix and the fix superseded it.
Left recorded because a reason that no longer holds is worth more than a silent
correction: the cell count is stronger than the argument that motivated it. An earlier version of this
docstring claimed a markup change "fails loudly". That was true only if EVERY row
stopped matching, because the loud failure was `if not rows`. A guard asserting
rows > 0 when the question is all-rows-found is the same defect one layer up.
"""
import pathlib, re, sys

WEB = pathlib.Path(__file__).resolve().parent.parent
ABOUT = WEB / "about.html"

# Rendered by netlify/functions/passport.mjs at path '/p/:id', and by
# netlify/functions/gallery.mjs at '/gallery'. Neither has an .html file, so
# neither can be discovered by listing pages, and both belong in the table.
#
# ROW-169 added netlify/functions/og.mjs at '/og/:id', the social-card image.
# Its row's label carries the .png so the table says it is a picture, not a
# page; the label here must match that anchor text exactly.
DECLARED_DYNAMIC = {"/p/…", "/gallery", "/gallery.json", "/og/….png"}

# Pages that exist but are deliberately absent from the table would go here, with
# the reason. Empty on purpose: today every page is listed, and an exception with
# no reason beside it is how a checker starts lying on somebody's behalf.
EXEMPT: set = set()

src = ABOUT.read_text(encoding="utf-8")

# ── what the table says ────────────────────────────────────────────────────────
rows = re.findall(r'<td class="capname"><a href="([^"]+)">(.*?)</a></td>', src)
if not rows:
    print("FAIL: no route rows found in about.html.")
    print("  The table's markup changed. Re-point this pattern; do not delete the check.")
    raise SystemExit(1)
declared = {label.replace("&hellip;", "…").strip() for _href, label in rows}

# Every capname cell must have parsed. `if not rows` above only fires when the
# markup changes for ALL of them; one row drifting to class="capname wide" left
# the rest matching and the miss silent, and it stayed silent whenever the route
# it named was also invisible to discovery below.
cells = len(re.findall(r'<td class="capname[^"]*">', src))
if cells != len(rows):
    print(f"FAIL: {cells} route cells in about.html but only {len(rows)} parsed.")
    print("  A row's markup drifted. Re-point the row pattern; do not delete the check.")
    raise SystemExit(1)

# ── what actually exists ───────────────────────────────────────────────────────
pages = {f"/{p.stem}" if p.stem != "index" else "/" for p in WEB.glob("*.html")}
actual = (pages | DECLARED_DYNAMIC) - EXEMPT

# Endpoints, for the caption's arithmetic. sweep has no path: it is scheduled and
# no visitor can reach it, so it is not an endpoint in the sense the caption means.
#
# READ OUT OF `export const config`, NOT OUT OF THE FILE. The first version of
# this scanned each function's whole source for a `path:` literal, and on
# 2026-08-23 it reported six endpoints where five are declared. The sixth was
# digest.mjs, which ships `export const config = {}` and carries a comment
# saying, in the words "I gave this `path: '/api/digest'`", why the path was
# taken out: it was a public send button that bought nothing. So the checker
# read a path out of the paragraph explaining that the path was removed, and it
# would have gone on doing that for as long as the explanation stayed.
#
# This is the checker's own subject one layer down. It compared a claim in prose
# against a grep over prose. The declaration is the thing Netlify reads, so the
# declaration is the thing to read, and the block below is bounded by
# `export const config = { ... }` rather than by the file.
#
# THE FIRST FIX WAS NOT ENOUGH AND A CRITIC BROKE IT IN FIVE WAYS. It bounded the
# scan with `\{([^}]*)\}`, which stops at the FIRST closing brace, and it did not
# strip comments at all. Each of these was run, not argued:
#
#   config = { rateLimit: { windowLimit: 10 }, path: '/api/upload' }
#       -> no path. `rateLimit` with that nested shape is a real Netlify option.
#   config = { cache: { mode: 'manual' }, path: '/q/:id' }
#       -> no path, and SILENTLY: a second dynamic route is not /api/*, so the
#          leftovers assertion never sees it and the caption's arithmetic never
#          sees it. That is the exact case the DECLARED_DYNAMIC note calls the
#          most likely one, re-opened by the fix meant to harden this.
#   config = { // was path: '/api/digest', removed
#              path: '/api/send' }
#       -> BOTH. The original defect, one layer in. Moving the boundary is not
#          the same as reading code instead of prose, and digest.mjs is one edit
#          away from putting that comment inside its own braces.
#   config = { excludedPath: '/api/*{x}', path: '/api/a' }  -> no path.
#   config: Config = { path: '/api/a' }                     -> no declaration.
#
# So: strip comments first, then take the brace block up to the `};` that closes
# the statement, and allow a type annotation. What cannot be read is now stated
# rather than dropped, which is what turns the remaining hole (`path` as an
# array, which Netlify accepts) from a silent miss into a build failure naming
# the file.
#
# THE LIMIT, because an unstated one is trusted past its range: COMMENT_RE would
# also eat a `//` inside a string literal. No config value in this directory is a
# URL and none can be, since these are paths and cron expressions. If one ever
# is, this stops being adequate and the answer is to import the module rather
# than to add a cleverer regex.
COMMENT_RE = re.compile(r"/\*[\s\S]*?\*/|//[^\n]*")
CONFIG_RE = re.compile(r"export\s+const\s+config\s*(?::[^=]*)?=\s*(\{[\s\S]*?\})\s*;")
PATH_RE = re.compile(r"""path:\s*['"]([^'"]+)['"]""")

problems = []
endpoints = set()
for f in sorted((WEB / "netlify" / "functions").glob("*.mjs")):
    decl = CONFIG_RE.search(COMMENT_RE.sub("", f.read_text(encoding="utf-8")))
    if decl is None:
        # Not cosmetic. A function with no config is published by Netlify at
        # /.netlify/functions/<name>, which is a reachable route this check
        # would never see, and the absence would look exactly like a function
        # that correctly declares nothing.
        problems.append(f"netlify/functions/{f.name} has no readable `export const config = {{...}};`; "
                        "it is still reachable at /.netlify/functions/ and this check cannot see it")
        continue
    body = decl.group(1)
    found = PATH_RE.findall(body)
    if "path" in body and not found:
        # The array form, or anything else this parse cannot read. Refusing out
        # loud is the whole point: the failure mode this file exists to stop is a
        # route that no instrument sees.
        problems.append(f"netlify/functions/{f.name} declares a path this check cannot read: "
                        f"{' '.join(body.split())[:120]}. Widen the parse; do not leave it unread")
    endpoints.update(found)
api = {e for e in endpoints if e.startswith("/api/")}

# Everything declared must be accounted for somewhere. The first version filtered
# to /api/* and silently discarded the rest, so a function declaring path
# '/newthing' passed green and appeared in neither half. DECLARED_DYNAMIC is
# hand-maintained, and nothing checked it was complete; the router is the change
# most likely to add a second dynamic route.
unclassified = {e for e in endpoints
                if not e.startswith("/api/") and e not in {"/p/:id", "/gallery", "/gallery.json", "/og/:id"}}

for u in sorted(unclassified):
    problems.append(f"a function declares {u}, which is neither a page nor an /api/ endpoint; "
                    "add it to DECLARED_DYNAMIC and to the table, or this check cannot see it")
for missing in sorted(actual - declared):
    problems.append(f"route exists and the table does not list it: {missing}")
for extra in sorted(declared - actual):
    problems.append(f"table lists a route that does not exist: {extra}")

# ── the caption's counts ───────────────────────────────────────────────────────
# Flattened, because this sentence wraps across source lines and a grep for it on
# one line returns nothing. That empty result read as an absence twice on the day
# the caption was found wrong.
flat = re.sub(r"\s+", " ", src)
cap = re.search(r"(\w+) pages and (\w+) endpoints", flat)
WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
         "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13}
if not cap:
    problems.append("the caption's 'N pages and N endpoints' sentence is gone or reworded; "
                    "re-point this check rather than dropping it")
else:
    said_pages, said_eps = (WORDS.get(g.lower()) for g in cap.groups())
    if said_pages != len(actual):
        problems.append(f"caption says {cap.group(1)} pages; the table has {len(actual)} routes")
    if said_eps != len(api):
        problems.append(f"caption says {cap.group(2)} endpoints; {len(api)} are deployed: "
                        + ", ".join(sorted(api)))

if problems:
    print("FAIL: about.html's route table disagrees with the app.")
    for p in problems:
        print(f"  {p}")
    print("  This table is the app describing itself. Fix the table, or the routes.")
    raise SystemExit(1)

print(f"route table: {len(actual)} routes and {len(api)} endpoints, table and caption agree")
print("  descriptions are NOT checked: a route that changes meaning passes this")

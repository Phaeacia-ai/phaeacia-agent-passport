#!/usr/bin/env python3
"""Fail the build when the deploy would serve internal engineering material.

    python3 tools/check-served-clean.py dist

THIS IS THE PART THAT HOLDS. Stripping the commentary once is a cleanup; it
decays the first time somebody writes a helpful comment, which is a shape this
crew has rediscovered often enough to have a folder of findings about it. This
runs on every deploy, on dist/ as it will be served, after the strip.

TWO RULES, AND THEY CATCH DIFFERENT THINGS.

  RULE 1, STRUCTURAL: a served text file contains no comments at all.
  Exact, total, and not a pattern match. It is the direct expression of the
  ruling — internal engineering commentary is not served — and it does not
  depend on anyone predicting which words a leak will use. `Raffael decided
  this in a meeting` matches no identifier pattern ever written and is caught
  by this rule the moment it is in a comment.

  RULE 2, CONTENT: no internal identifier anywhere in a served file, comment or
  not. This is the one rule 1 cannot cover, because some leaks are in live
  text: sitemap.xml carried `ROW-127` in a place the strip does reach, but a
  `ROW-` in a visible paragraph or an href would survive any stripper.

Rule 1 without rule 2 misses live text. Rule 2 without rule 1 is a guessing
game about vocabulary. Neither alone is the check.

WHY `Raffael` IS NOT IN THE PATTERN LIST. He is the company's representative
and his name is on imprint.html on purpose, in public, because Swiss law
requires it. A pattern banning it would fail the build on a correct page. Rule
1 is what covers his name appearing in a JS comment, and it covers it exactly.

KNOWN-POSITIVE CONTROL, and this gate does not get to be trusted without it.
`--self-test` writes deliberately dirty files to a temporary directory and
asserts this gate fails on each FOR THE NAMED RULE, plus clean ones it must
accept and a set of stripper fixtures with exact expected output. Counts are
deliberately not written into prose here: they have been stale twice in one
day, and the suite prints its own. An instrument
nobody has watched fail is indistinguishable from one that cannot fail, and on
2026-09-01 this crew shipped four of those in one day.

MOST OF THE DIRTY CONTROLS ARE LEAKS THAT ONCE PASSED THIS GATE. Critics and a
review built them against earlier versions and every one returned exit 0 with "no comments,
no internal identifiers" while serving internal commentary. They are pinned
here rather than described in a commit message, because a leak that is only
recorded in prose is a leak that comes back.
"""
import contextlib
import io
import pathlib
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import served_text as S                                    # noqa: E402


# ── the identifier rules ────────────────────────────────────────────────────
#
# LIFTED VERBATIM FROM products/agent-passport/scripts/export-public.sh, the
# INTERNAL block. Not re-derived, and not narrowed. That scanner was hardened by
# a critic on 2026-08-31 after the narrow forms were defeated, and this file's
# first version re-derived a weaker set from scratch. Measured against the same
# inputs, this gate before the lift:
#
#     ROW-135   caught      row-135   MISSED      ROW_135   MISSED
#     Row-135   MISSED      ROW–135   MISSED      ROW 135   missed by both
#
# Four of six forms walked straight through the gate whose whole job is to catch
# what the strip misses. A lowercase `row-135` in a comment shipped.
#
# WHY A COPY AND NOT AN IMPORT, stated because the duplication is the obvious
# criticism. Those rules live inside a bash heredoc, in a different repository.
# The website build cannot import them and cannot read that tree. So this is a
# copy, deliberately, and it follows the precedent the source file sets for its
# own copy of run_tests.sh's rules: "Taken verbatim ... so the two gates cannot
# drift into disagreeing about the same property. Changing one without the other
# is the defect, not the duplication." The same sentence applies here, and the
# drift risk is the accepted cost of two repositories rather than a thing I
# think is fine.
#
# THE ONE DELIBERATE DIFFERENCE is the machine-path rule. export-public.sh
# scans a source tree; this scans SERVED PRODUCT, where `~/.claude/skills/` and
# `~/Library/LaunchAgents/` are the installer telling a stranger where to look
# on their own machine. A blanket `~/` fired 17 times here, every one a false
# positive, and a gate that fails a correct build is a gate somebody switches
# off. So HOME_PATH is narrowed to our own trees by name and USER_PATH is kept
# whole.

# OUR key, in every form a person retypes it: any case, hyphen, underscore, en
# or em dash, with or without a space.
OURS = re.compile(r"(?<![A-Za-z0-9])[Rr][Oo][Ww][-_\u2013\u2014]\s?[0-9]{1,5}(?![0-9])")

# "#108" alone is a markdown anchor, a CSS id and a colour. It is an issue
# reference only when something says so.
NUMBERED = re.compile(
    r"(?i)(?<![A-Za-z0-9])(?:issue|ticket|board item|card)\s+#?[0-9]{1,5}(?![0-9])")

PATTERNS = [
    ("issue identifier", OURS,
     "the private issue tracker's key. A reader cannot open it, and the number "
     "discloses the size of the board"),
    ("issue reference", NUMBERED,
     "a numbered reference to something on a private board"),
    # THE LOOKBEHIND DROPPED `/`, AND THAT IS A DELIBERATE DIVERGENCE FROM
    # export-public.sh, REPORTED UPSTREAM. Its version excludes `/` so that
    # `myrecord/findings` cannot match, which also means `/record/findings/x.md`
    # with a leading slash does not match — and a leading slash is exactly the
    # form a leak takes in served content: an href, a Disallow line, a URL.
    # Found by a control that fired nothing when it should have fired this rule.
    # `a-record/findings` and `myrecord/findings` are still excluded by the
    # remaining character class.
    ("private tree", re.compile(
        r"(?<![A-Za-z0-9._-])(?:record/(?:findings|decisions|proposals|root-snapshot)"
        r"|worktrees/|design-studies/|~/Phaeacia|~/Local|~/Agents|~/career-ops)"),
     "a path into one of this crew's private working trees"),
    ("machine path", re.compile(r"/(?:Users|home)/[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]*"),
     "an absolute path inside a developer's home directory"),
    ("crew role", re.compile(
        r"(?<![A-Za-z-])(?:passport-engineer|skill-engineer|web-frontend|web-backend)"
        r"(?![A-Za-z-])"),
     "an internal lane name. Bare `orchestrator` is deliberately NOT here: it is "
     "an ordinary word for an ordinary thing in this product's subject matter, "
     "and refusing it costs more than the leak it prevents"),
    ("tracker url", re.compile(r"linear\.app|\.atlassian\.net|notion\.so/[A-Za-z0-9-]"),
     "a link into a private tracker or workspace"),
    # Deliberately narrow. A commit hash is 7-40 hex; so is a great deal of
    # innocent text, so this requires a mixed letter/digit run standing alone
    # and never preceded by `#`, which is what a CSS colour looks like. The
    # false-positive rate was measured against the whole served tree: the
    # passport renderer's MRZ fields 2608064 and 2609016 and the app's 00000000
    # placeholders are pure digits and never fire, and they are pinned as clean
    # controls so nobody drops the a-f requirement.
    ("commit hash", re.compile(r"(?<![#\w/&.-])(?=[0-9a-f]{7,40}(?![\w-]))"
                               r"(?=[a-f0-9]*[a-f])(?=[a-f0-9]*[0-9])"
                               r"[0-9a-f]{7,40}"),
     "what reads as a git commit hash"),
]

# A LEAK WRAPPED ACROSS TWO LINES MATCHES NOTHING when a file is scanned as
# written: `/Users/` ends one line and the account name begins the next, and
# `web-` ends one and `frontend` begins the next. That actually occurred in the
# passport repo. So every file is scanned TWICE, once as written and once with
# line breaks and comment leaders folded away to NOTHING rather than to a space.
# A space is what a reader sees and it is not what the split identifier is;
# folding to a space leaves the two halves as separate tokens and catches
# nothing, which is what the first attempt at this did upstream. The folded pass
# reports no line number, because the offset no longer corresponds to one.
FOLD = re.compile(r"\n[ \t]*(?:#|//|\*|--)?[ \t]*")

# Paths where a pattern is allowed, each with the reason. An entry here is a
# decision, not a mute button, so it carries prose and the rule it exempts.
ALLOW = {
    # (path, rule name): why
}


def scan(root, verbose=False):
    root = pathlib.Path(root).resolve()
    try:
        files = S.served_files(root)
    except S.Refuse as e:
        print(f"::error::{e}")
        return 1

    comment_hits, pattern_hits = [], []

    for path, syntax in files:
        rel = path.relative_to(root).as_posix()
        if syntax == "binary":
            # RULE 2 APPLIES TO EVERY SERVED FILE, and a binary one used to
            # leave the set before this loop ever saw it. Decoded permissively
            # rather than parsed: PDF metadata, font name tables and wasm name
            # sections are readable ASCII sitting in a binary container, and a
            # /Users/<name>/ in a PDF's /Creator is exactly one of the six
            # things below. Rule 1 does not apply; a binary file has no
            # comment syntax to have.
            src = path.read_bytes().decode("latin-1", "replace")
            for name, rx, why in PATTERNS:
                if (rel, name) in ALLOW:
                    continue
                for m in rx.finditer(src):
                    pattern_hits.append((rel, 0, name, m.group(0)[:70],
                                         why + " (inside a binary file)"))
            continue
        src = path.read_text(encoding="utf-8")

        try:
            spans = S.comments(path, syntax, src)
        except S.Refuse as e:
            print(f"::error::{rel}: {e}")
            return 1
        for a, b, kind in spans:
            line = src.count("\n", 0, a) + 1
            comment_hits.append((rel, line, b - a, src[a:min(b, a + 90)]))

        folded = FOLD.sub("", src)
        for name, rx, why in PATTERNS:
            if (rel, name) in ALLOW:
                continue
            seen = set()
            for m in rx.finditer(src):
                line = src.count("\n", 0, m.start()) + 1
                seen.add(m.group(0))
                pattern_hits.append((rel, line, name, m.group(0)[:70], why))
            # The folded pass reports 0 for the line, because the offset no
            # longer corresponds to one. Only hits the plain pass did NOT see
            # are reported, so a wrapped leak is not double-counted.
            for m in rx.finditer(folded):
                if m.group(0) not in seen:
                    pattern_hits.append((rel, 0, name, m.group(0)[:70],
                                         why + " (found only when the line "
                                         "wrapping is folded away)"))

    if verbose and not (comment_hits or pattern_hits):
        # COUNTED SEPARATELY BECAUSE THE TWO RULES DO NOT BOTH APPLY. Binary
        # files entered the served set so that rule 2 could read their
        # metadata; rule 1 is meaningless for them. Reporting one total called
        # "text files" was wrong the moment they were added.
        n_bin = sum(1 for _, s in files if s == "binary")
        print(f"  {len(files) - n_bin} served text files, no comments, no "
              f"internal identifiers; {n_bin} binary files, no identifiers")

    if comment_hits:
        total = sum(h[2] for h in comment_hits)
        print(f"::error::{len(comment_hits)} comment(s), {total} bytes, would be "
              f"SERVED to the public. Internal engineering commentary does not ship.")
        print("  The reasoning belongs in git, where it stops the next person "
              "undoing a deliberate choice. It does not belong on the page.")
        print("  If tools/strip-served-comments.py ran before this, it did not "
              "reach these files and that is the bug to fix, not this gate.")
        for rel, line, n, text in comment_hits[:25]:
            flat = " ".join(text.split())
            print(f"  {rel}:{line}  ({n} bytes)  {flat[:70]}")
        if len(comment_hits) > 25:
            print(f"  ... and {len(comment_hits) - 25} more")

    if pattern_hits:
        print(f"::error::{len(pattern_hits)} internal identifier(s) in the "
              f"served tree, outside any comment or inside one.")
        for rel, line, name, text, why in pattern_hits[:25]:
            print(f"  {rel}:{line}  [{name}] {text}")
            print(f"      {why}")
        if len(pattern_hits) > 25:
            print(f"  ... and {len(pattern_hits) - 25} more")

    return 1 if (comment_hits or pattern_hits) else 0


DIRTY = {
    # Each of these must fail, and must fail for the reason named. A gate that
    # passes one of them is blind in that direction and the build should not
    # use it.
    "a.html": ('<!doctype html><title>t</title>'
               '<!-- the horizon line is deliberate, do not tidy it away -->\n<p>hi</p>\n',
               "an HTML comment naming a record path"),
    "b.js":   ('var a = 1;\n/* kept because the tidy version broke the rail. */\nvar b = 2;\n',
               "a JS block comment naming an issue id"),
    "c.css":  (":root{--x:1px}\n/* the hack that survives a reflow. */\n",
               "a CSS comment naming a home directory path"),
    "d.xml":  ('<?xml version="1.0"?>\n<urlset><!-- the noindex went, so this stays --></urlset>\n',
               "an XML comment, the sitemap case"),
    "e.txt":  ('User-agent: *\nDisallow: /record/decisions/y.md\n',
               "an identifier in a LIVE value, not in a comment, in a file type "
               "whose comment rule cannot reach it"),
    "f.html": ('<!doctype html><title>t</title>\n'
               '<p>Filed as ROW-42 after commit a1b2c3d4e5.</p>\n',
               "identifiers in VISIBLE text, which no stripper would remove"),

    # ── LEAKS THAT PASSED AN EARLIER VERSION OF THIS GATE ───────────────────
    # The first three all had one cause: the type-attribute test searched the
    # raw attribute string for `type=`, so any attribute ENDING in those four
    # letters was read as the script's type, the block was classified as data,
    # its body was blanked and never lexed. There is no such attribute in
    # either repository today. There was nothing stopping one.
    "g.html": ('<!doctype html><title>t</title>\n'
               '<script data-type="analytics">/* internal note, no identifier */</script>\n',
               "`data-type` read as the script type, body never lexed"),
    "h.html": ('<!doctype html><title>t</title>\n'
               '<script itemtype="https://schema.org/Thing">'
               '/* internal note, no identifier */</script>\n',
               "`itemtype` captured a URL as the script type"),
    "i.html": ('<!doctype html><title>t</title>\n'
               '<script type="text/javascript;charset=utf-8">'
               '/* internal note, no identifier */</script>\n',
               "a legal MIME parameter defeated an exact three-string allowlist"),
    "j.html": ('<!doctype html><title>t</title>\n'
               '<script type="text/ecmascript">/* internal note */</script>\n',
               "a legal alternative JS media type was treated as data"),
    "k.html": ('<!doctype html><title>t</title>\n'
               '<script type="text/quite-unknown">var x=1;</script>\n',
               "an unrecognised script type must REFUSE, not be assumed inert"),
    "l.txt":  ('User-agent: *\n'
               '# internal: ask in the channel before changing this\n',
               "a robots.txt `#` comment, which `syntax = none` did not see"),
    "m.txt":  ('User-agent: *\n'
               'Disallow: /admin   # internal, trailing form\n',
               "a TRAILING `#`, which robots.txt's format allows and crawlers "
               "honour, and which a line-leading-only rule did not see"),
    "n.html": ('<!doctype html><title>t</title>\n'
               '<script type="text/template"><!-- internal note --></script>\n',
               "a client-side template body is MARKUP, and was waved through "
               "as inert data because it is not JavaScript"),

    # ── FORMS THAT WALKED THROUGH THE NARROW RULE ───────────────────────────
    # Four of six spellings of our own issue key were missed until the rules
    # were lifted from export-public.sh. `ROW 135` with a space is missed by
    # both gates and is an accepted miss upstream.
    "o.html": ('<!doctype html><title>t</title>\n<p>see row-135</p>\n',
               "lowercase, which the narrow \\bROW-\\d+\\b did not catch"),
    "p.html": ('<!doctype html><title>t</title>\n<p>see ROW_135</p>\n',
               "underscore, same"),
    "q.html": ('<!doctype html><title>t</title>\n<p>see Row\u2013135</p>\n',
               "mixed case with an en dash, same"),
    "r2.html": ('<!doctype html><title>t</title>\n<p>filed as issue 135</p>\n',
                "a numbered reference to a private board"),
    "s.html": ('<!doctype html><title>t</title>\n<p>ask web-backend about it</p>\n',
               "an internal lane name in served copy"),
    "t.html": ('<!doctype html><title>t</title>\n'
               '<p>see https://linear.app/phaeacia/issue/ROW-1</p>\n',
               "a link into the private tracker"),
    # A LEAK WRAPPED ACROSS TWO LINES matched nothing before the fold pass, and
    # this shape actually occurred in the passport repo.
    "u.html": ('<!doctype html><title>t</title>\n'
               '<p>path is /Users/\n   someone/Phaeacia/record</p>\n',
               "a machine path split across a line break, invisible without "
               "the folded second pass"),

    # THE PUBLISH DIRECTORY HAS NO EXEMPT PATH. Until dist/ existed, this gate
    # skipped every path a force-404 rule in netlify.toml covered, lib/
    # included, and /LIB/... was served anyway (H1, 2026-09-30). A comment in
    # a file under lib/ inside the publish directory is found like any other.
    "lib/x.js": ('var a = 1;\n/* a note nobody meant to publish */\nvar b = 2;\n',
                 "a comment in a file under lib/, which no path exemption may skip"),
}

CLEAN = {
    # And it must NOT fail on these. A gate that fails the build on a correct
    # page gets switched off, which is the other way an instrument dies.
    "ok.html": '<!doctype html><title>t</title>\n<p>Colour <b>#a1b2c3</b>.</p>\n',
    "ok.css":  ':root{--bg:#0a0f14;--fg:#e8eef2}\nbody{background:var(--bg)}\n',
    "ok.js":   'var re = /a\\/b/; var q = a / b / c;\nvar s = "http://x/y";\n',
    "ok.txt":  'User-agent: *\nAllow: /\nSitemap: https://phaeacia.ai/sitemap.xml\n',
    # THE FOUR FALSE POSITIVES A REVIEWER PREDICTED FOR THE HASH RULE, PINNED
    # HERE AS CONTROLS RATHER THAN ARGUED ABOUT. `2608064` and `2609016` are
    # MRZ date-and-check-digit fields the passport renderer emits, and they
    # change with every passport, so a rule that fired on them would fail the
    # build forever. `00000000` is the app's delete and manage placeholder.
    # All four are pure digits, and the rule requires at least one a-f, which
    # is why it does not fire. Written down so that anyone who later "improves"
    # the pattern by dropping that requirement is told immediately.
    "mrz.html": '<!doctype html><title>t</title>\n'
                '<p>P&lt;CHE 2608064 2609016 00000000 000000000000</p>\n',
    # And a colour, a font hash in a URL, and a base64-ish run: all legitimate.
    "hex.css":  ':root{--a:#a1b2c3;--b:#0a0f14}\n'
                '@font-face{src:url(/f/ab12cd34ef.woff2)}\n',
    # RCDATA. `<!--` inside these is TEXT A READER SEES, not a comment, so the
    # gate must not report it and the stripper must not remove it. The first
    # version turned `<title>Docs <!-- see also --> v3</title>` into
    # `<title>Docs  v3</title>`, silently, exit 0.
    "raw.html": '<!doctype html><title>Docs <!-- see also --> v3</title>\n'
                '<textarea>paste: <!-- your key --></textarea>\n',
    # ROW-141. Legal constructs that made the lexer refuse and fail the build.
    "url.css":  'a{background:url(/img/*.png)}\n'
                'b{background:url("data:image/svg+xml,<svg/*x*/>")}\n'
                '@import url(//cdn.example.com/x.css);\n',
    "regex.js": 'function f(x){ return /a\\/*b/.test(x); }\n'
                'var q = a / b / c;\n'
                'var re = /a\\/b/;\n',
    # The word "orchestrator" is deliberately NOT a crew-role match: it is an
    # ordinary word in this product's own subject matter.
    "orch.html": '<!doctype html><title>t</title>\n'
                 '<p>The agent acts as an orchestrator for the run.</p>\n',
}


# Which rule each dirty control must trip. NOT decoration: see _fired().
EXPECT = {
    "a.html": "comment", "b.js": "comment", "c.css": "comment",
    "d.xml": "comment", "g.html": "comment", "h.html": "comment",
    "i.html": "comment", "j.html": "comment", "l.txt": "comment",
    "m.txt": "comment", "n.html": "comment",
    "e.txt": "identifier", "f.html": "identifier", "o.html": "identifier",
    "p.html": "identifier", "q.html": "identifier", "r2.html": "identifier",
    "s.html": "identifier", "t.html": "identifier", "u.html": "identifier",
    "k.html": "refusal", "lib/x.js": "comment",
}


def _fired(root):
    """Run scan() and report WHICH rule tripped, not merely that one did.

    THE EXIT CODE ALONE IS NOT A CONTROL, and this suite ran on it for most of
    a day. Nine of the dirty controls carried an identifier inside their
    payload — `record/findings/x.md`, `ROW-9`, a home path — as flavour text.
    So a control written to prove that COMMENT DETECTION works also tripped the
    IDENTIFIER rule, and would have returned exit 1, and shown [PASS], with
    comment detection entirely removed. Nine of twenty-one could not fail in
    the direction they claimed to test.

    That is the third failure mode in the crew's shared rules, arriving in the
    suite I had already named as the one I trust least: a control that goes red
    for the wrong reason, where red feels like proof in a way green never does.
    The rule there is the fix here — run the control, then read the failure
    message, and if it is not the assertion that names the property you claim
    to be testing, the control is measuring something else.

    The payloads are identifier-free now, so each isolates one rule, and this
    checks the rule rather than the code.
    """
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = scan(root)
    out = buf.getvalue()
    fired = set()
    if "comment(s)" in out:
        fired.add("comment")
    if "internal identifier" in out:
        fired.add("identifier")
    if "::error::" in out and not fired:
        fired.add("refusal")
    return rc, fired


def _quiet(root):
    return _fired(root)[0]



# ── controls for the STRIPPER, which had none ───────────────────────────────
#
# THE GATE HAD 31 CONTROLS AND THE STRIPPER HAD ZERO, which is the wrong way
# round: the gate only reads and refuses, and every silent corruption found in
# this work has been on the mutation side. Each case is (name, syntax, input,
# expected output), so a wrong output is a named failure rather than a diff
# somebody reads later.
#
# The first four are the corruptions a review actually built. Suggested as
# permanent regressions by web-frontend, whose render comparison catches them
# only on a page that happens to contain the input; a fixture catches them on
# every run.
STRIP_CASES = [
    ("a comment inside an attribute VALUE is characters, not an opener",
     "html", '<p data-x="<!--">one</p>\n<p>TWO</p>\n<p data-y="-->">three</p>',
            '<p data-x="<!--">one</p>\n<p>TWO</p>\n<p data-y="-->">three</p>'),
    ("`type=` inside another attribute does not classify the script",
     "html", '<script data-note="a type=text/plain b">/* n */ var x=1;</script>',
            '<script data-note="a type=text/plain b">  var x=1;</script>'),
    ("a literal <script> inside a raw-text element is not code",
     "html", '<textarea>paste <script>/* k */</script></textarea>',
            '<textarea>paste <script>/* k */</script></textarea>'),
    ("an SVG keeps its geometry when a script holds a comment opener",
     "xml", '<svg><script>var o="<!--";</script><path d="M0 0"/><!-- m --></svg>',
            '<svg><script>var o="<!--";</script><path d="M0 0"/></svg>'),
    ("inline CSS gets a separator, so tokens cannot fuse",
     "html", '<style>a{border:1px/**/solid red}</style>',
            '<style>a{border:1px solid red}</style>'),
    ("inline JS keeps the newline, so ASI does not change meaning",
     "html", '<script>function f(){return /*\nx\n*/ 5}</script>',
            '<script>function f(){return \n 5}</script>'),
    ("a robots.txt value containing # is never touched",
     "hash", 'User-agent: *\nDisallow: /a#b\n', None),   # None = must REFUSE
    ("a whole-line robots.txt comment goes, newline and all",
     "hash", 'User-agent: *\n# note\nAllow: /\n', 'User-agent: *\nAllow: /\n'),
]


def _strip_controls():
    ok = True
    for why, syn, src, want in STRIP_CASES:
        try:
            spans = S.comments(pathlib.Path("x." + syn), syn, src)
            got = S.strip(src, spans)
            refused = False
        except S.Refuse:
            got, refused = None, True
        right = (want is None and refused) or (not refused and got == want)
        if not right:
            ok = False
        print(f"  [{'PASS' if right else 'FAIL'}] strip: {why}")
        if not right:
            print(f"        wanted {want!r}\n        got    {got!r}")
    return ok


# ── ROW-153: the outer pipeline, not just this module's internals ──────────
# netlify.toml's build command is
#   strip-served-comments.py dist --deploy  &&  check-served-clean.py dist
# and until this was added, nothing outside that build ever ran that command.
# `_strip_controls()` above calls `S.comments`/`S.strip` directly, which
# proves the LEXER is correct. It does not touch strip-served-comments.py's
# own outer plumbing — its `--deploy` refusal, its own internal byte-count
# assertion, and its own internal fixed-point re-check are all in main() in
# that file, and a bug there (say, the "logic exactly inverted" defect this
# file's own docstring describes, now fixed) is invisible to a check that
# never subprocesses the real script.
#
# WHAT THIS ACTUALLY PROVES, STATED PRECISELY, after a critic (2026-09-03)
# found the first version of this claimed more than it checked. It shells
# out to the real CLI, twice, against a temp copy of a real DIRTY fixture,
# and compares the result BYTE FOR BYTE against a hand-verified expected
# string — not "no comments" and not "no `<!--`". That distinction is the
# whole fix: a stripper that deletes only the `<!--`/`-->` delimiter tokens
# and leaves the comment BODY as visible page text produces something with
# no `<!--` in it and nothing check-served-clean.py's own rules fire on
# either, because the fixture's payload is deliberately identifier-free so
# it isolates the comment rule. A critic built exactly that mutant, paired
# with a broken byte-count assertion, and the earlier version of this
# function passed it while the real script shipped internal prose to the
# page. The byte-exact comparison below closes that hole: any output other
# than the one correct answer fails control 2, regardless of what the
# script's own internal assertions did or didn't catch.
#
# WHAT THIS STILL DOES NOT PROVE. It does not exercise
# strip-served-comments.py's internal byte-count assertion or fixed-point
# re-check AS GUARDS — i.e. it does not construct an input where a correct
# `served_text.strip()` legitimately trips either one and the script must
# REFUSE. Doing that needs an input crafted against the lexer's own
# semantics, not a bigger DIRTY fixture, and is not attempted here. What
# stands in for it is weaker but real: the byte-exact check means a script
# whose internal guards are absent or broken still gets caught the moment
# its OUTPUT is wrong, which is the failure that matters to a deploy. A
# script that produces the right bytes through a broken guard and wrong
# bytes through no guard at all is not a case this control distinguishes
# from "guard works" — flagged rather than closed, ROW-153 follow-up.
STRIP_SCRIPT = pathlib.Path(__file__).resolve().parent / "strip-served-comments.py"

# Hand-verified against the real, unmutated script: DIRTY["a.html"] with the
# comment span removed, nothing else touched. Recompute by hand if a.html's
# fixture text ever changes; do not derive this from the script under test.
A_HTML_STRIPPED = '<!doctype html><title>t</title>\n<p>hi</p>\n'


def _cli_controls():
    ok = True
    name, (body, why) = "a.html", DIRTY["a.html"]
    assert A_HTML_STRIPPED != body, "fixture and expected output must differ"

    with tempfile.TemporaryDirectory() as d:
        root = pathlib.Path(d)
        target = root / name
        target.write_text(body, encoding="utf-8")

        # 1. Without --deploy, the real script must refuse FOR THE STATED
        # REASON and touch nothing. A nonzero exit alone is not enough: a
        # critic renamed the script out of the way and got the same PASS
        # from a bare "file not found", which proved nothing about the
        # refusal this control exists to check.
        before = target.read_text(encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(STRIP_SCRIPT), str(root)],
            capture_output=True, text=True)
        after = target.read_text(encoding="utf-8")
        right = (proc.returncode != 0 and after == before
                 and "--deploy is required" in proc.stdout)
        if not right:
            ok = False
        print(f"  [{'PASS' if right else 'FAIL'}] strip-served-comments.py "
              f"without --deploy refuses, names why, and writes nothing"
              + ("" if right else f"  <- exit {proc.returncode}, "
                 f"file {'unchanged' if after == before else 'CHANGED'}, "
                 f"stdout {proc.stdout!r}"))

        # 2. With --deploy, the output must be EXACTLY the known-correct
        # stripped text, not merely "different" or "missing <!--". This is
        # the control that actually distinguishes "the comment is gone" from
        # "the comment's delimiters are gone and its body is now on the
        # page" — the second is the shape a critic's mutant produced and the
        # substring check in an earlier version of this function missed.
        proc = subprocess.run(
            [sys.executable, str(STRIP_SCRIPT), str(root), "--deploy"],
            capture_output=True, text=True)
        stripped = target.read_text(encoding="utf-8")
        right = proc.returncode == 0 and stripped == A_HTML_STRIPPED
        if not right:
            ok = False
        print(f"  [{'PASS' if right else 'FAIL'}] strip-served-comments.py "
              f"--deploy produces exactly the known-correct output for a "
              f"real DIRTY fixture ({name}: {why})"
              + ("" if right else f"  <- exit {proc.returncode}\n"
                 f"        wanted {A_HTML_STRIPPED!r}\n"
                 f"        got    {stripped!r}"))

        # 3. The pipeline's second half: check-served-clean.py on the OUTPUT
        # of step 2 must now pass. This is what actually proves the two
        # scripts agree with each other rather than each passing its own
        # fixtures in isolation.
        rc = _quiet(root)
        right = rc == 0
        if not right:
            ok = False
        print(f"  [{'PASS' if right else 'FAIL'}] check-served-clean.py accepts "
              f"what strip-served-comments.py --deploy just produced"
              + ("" if right else f"  <- exit {rc}, still not clean"))

    return ok


def self_test():
    ok = True
    for name, (body, why) in DIRTY.items():
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            (root / name).write_text(body, encoding="utf-8")
            rc, fired = _fired(root)
            want = EXPECT.get(name)
            right = rc == 1 and want in fired and len(fired) == 1
            mark = "PASS" if right else "FAIL"
            if not right:
                ok = False
            extra = "" if right else (
                f"  <- wanted {want}, got {sorted(fired) or 'nothing'}")
            print(f"  [{mark}] must reject {name} on the {want} rule: {why}{extra}")

    for name, body in CLEAN.items():
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            (root / name).write_text(body, encoding="utf-8")
            rc = _quiet(root)
            mark = "PASS" if rc == 0 else "FAIL"
            if rc != 0:
                ok = False
            print(f"  [{mark}] must accept {name}")

    # A SITE ROOT IS REFUSED, for the stated reason. Pointed at web/, this gate
    # would check lib/ and tools/ and miss whatever tools/build-dist.py left
    # out, so the old `check-served-clean.py .` spelling must fail, loudly.
    with tempfile.TemporaryDirectory() as d:
        root = pathlib.Path(d)
        (root / "netlify.toml").write_text('[build]\n  publish = "dist"\n',
                                           encoding="utf-8")
        (root / "ok.html").write_text(CLEAN["ok.html"], encoding="utf-8")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = scan(root)
        right = rc == 1 and "is the site root, not the publish directory" \
            in " ".join(buf.getvalue().split())
        if not right:
            ok = False
        print(f"  [{'PASS' if right else 'FAIL'}] must refuse a site root, a "
              f"directory holding netlify.toml"
              + ("" if right else f"  <- exit {rc}, output {buf.getvalue()!r}"))

    ok = _strip_controls() and ok
    ok = _cli_controls() and ok

    print("\nself-test: " + ("every control behaved" if ok else
                             "A CONTROL DID NOT BEHAVE; this gate is not trustworthy"))
    return 0 if ok else 1


if __name__ == "__main__":
    argv = sys.argv[1:]
    if "--self-test" in argv:
        raise SystemExit(self_test())
    raise SystemExit(scan(argv[0] if argv else "dist", verbose=True))

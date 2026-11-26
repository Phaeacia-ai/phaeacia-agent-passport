#!/usr/bin/env python3
"""What the site actually serves, and where the comments are inside it.

This module is the shared half of two build steps that must agree by
construction rather than by two people keeping two lists in step:

    tools/strip-served-comments.py   removes the commentary from the deploy
    tools/check-served-clean.py      fails the build if any survives

They disagree the moment they enumerate differently, so they do not enumerate
separately. Both import `served_files()` and `comments()` from here.

────────────────────────────────────────────────────────────────────────────
THE SERVED SET IS THE PUBLISH DIRECTORY, AND NOTHING IS DERIVED ANY MORE

Netlify publishes dist/, which tools/build-dist.py builds from an allowlist, so
every file in it is served and every file outside it is not. `served_files()`
is handed that directory and walks all of it.

It used to be handed the site root and DERIVE the served set: everything, minus
dot-paths, minus a set of names it believed Netlify never serves, minus every
path a `force = true` 404 rule in netlify.toml covered, parsed out of the toml.
That derivation was wrong in the one direction that mattered. Netlify matches a
rule's `from` case-sensitively and finds a static file case-insensitively, so
/LIB/_store.mjs and /Package.json answered 200 on 2026-09-30 while this module
counted both as unserved (security review 2026-09-30, H1). "Netlify never
serves package.json" had been our own rule all along. Nothing here reasons
about what a rule hides any more, because no rule hides anything: a file that
is not in dist/ is not published in any spelling.

A ROOT HOLDING netlify.toml IS REFUSED. That is web/, the site root, and a gate
pointed at it would check lib/ and tools/ while missing whatever build-dist.py
left out. The old invocation, `check-served-clean.py .`, therefore fails
loudly rather than checking the wrong set.

REFUSE WHAT THIS CANNOT READ. Taken from web/build.sh's header-parity check,
which learned it the hard way: a header spelled in a way its regex did not
handle dropped silently out of the comparison and the count fell from 4 to 3
while the build stayed green. So: a file extension this does not know is fatal,
not skipped. A symlink is fatal, not skipped. An unterminated comment is fatal,
not skipped. Every one of those, skipped, is a served file nobody checked.
"""
import pathlib
import re
import sys

# ── the served set ──────────────────────────────────────────────────────────

# Exact served-file paths whose content is a verbatim payload: text a reader
# copies and pastes elsewhere, never engineering commentary about our own
# code. NOT A DIRECTORY, ON PURPOSE, AND THAT WAS A REAL BUG IN THIS COMMIT'S
# FIRST DRAFT, found by a critic and confirmed with a built counterexample
# before landing: a `assets/installer/` PREFIX also covers core.md, judge.md
# and the branch .md files, which are NOT foreign text. build.sh copies them
# verbatim from installer/ and verification/, which this team authors, and
# `<!-- -->` is exactly our comment convention there -- it is why SYNTAX maps
# `.md` to `html` at all. assets/passport.js fetches those three files AT
# RUNTIME and assembles the block a reader copies off "Install this agent",
# so an editorial `<!-- -->` left in core.md by a future edit would ship
# straight into a reader's clipboard while this gate printed "no comments".
# Reproduced directly: inserting one `<!-- -->` line into installer/core.md,
# the pre-fix tool stripped it (-74 bytes, confirmed removed); a directory-
# prefix version of this override left it in the served file AND had the
# gate report clean. A directory bypass is not "the general fix"; it is the
# ROW-485 bug's shape, aimed at files that do not have it.
#
# path-w-block.txt is different in kind, not degree: build.sh extracts ONLY
# the fenced PART B out of capture/path-w-prompt.md, a YAML template a reader
# fills in themselves, leaving PART A (operator-only) and everything else
# behind. Nothing in it is ours to apply a comment convention to. That
# distinction cannot be read off a directory path, so it is named here file
# by file, and a future payload file joins this set by a deliberate edit, not
# by landing under the same directory. (A second thing this closes: routing
# by directory also bypassed the module's "unknown extension" refusal for
# anything else dropped under the prefix, silently, which this set does not.)
#
# THIS IS WHAT FAILED THE ROW-485 DEPLOY. path-w-block.txt (`.txt`, `hash`
# syntax) contains a genuine YAML-template line, `state:            # omit
# this whole block if the agent remembers nothing between runs`, and the
# ambiguous-trailing-`#` guard in _hash_spans correctly refused to guess
# whether that was ours to remove -- it is not ours at all.
#
# THIS DOES NOT WEAKEN RULE 2 (no internal identifier anywhere in a served
# file). `check-served-clean.py`'s identifier scan reads the served text
# directly and does not consult `comments()` or SYNTAX at all; a leak in this
# file is exactly as visible to it as a leak in any other syntax="none" file,
# e.g. the JSON ones. Only rule 1 (a served file has zero comment spans),
# which requires a comment CONVENTION to even ask the question of, stops
# applying here -- because no comment convention of ours governs text that
# is not ours.
VERBATIM_PAYLOAD_FILES = frozenset({
    "assets/installer/path-w-block.txt",
})

# Text we can read, mapped to the comment syntax that file type actually has.
#
# `md` is `html` on purpose: Markdown passes HTML through, so `<!-- -->` in a
# .md file is a real HTML comment in whatever renders it.
#
# `txt` is `hash`, and it did not used to be. It was `none`, on the reasoning
# that plain text has no comment syntax. robots.txt does — `#` to end of line —
# and this site's robots.txt is 92% commentary written for a colleague, at a URL
# people read on purpose. `none` is now only JSON, which genuinely has none.
# Files with no structural rule are still scanned for internal identifiers,
# because a leak in live text is still a leak.
#
# VERBATIM_PAYLOAD_FILES overrides this per exact path, not per extension or
# directory, to `none` for the same reason JSON is `none`: no comment
# convention of ours applies, so rule 1 is vacuously satisfied rather than
# silently unenforced, and rule 2 still reads every byte regardless.
SYNTAX = {
    ".html": "html", ".htm": "html", ".md": "html",
    ".svg": "xml", ".xml": "xml",
    ".js": "js", ".mjs": "js", ".cjs": "js",
    ".css": "css",
    ".json": "none", ".txt": "hash",
}

# Binary, by extension. Listed rather than sniffed so that a new binary type
# fails loudly as "unknown extension" instead of being silently skipped by a
# heuristic that happened to find a NUL byte.
BINARY = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".pdf", ".zip", ".mp4", ".webm", ".mov", ".wasm",
}


class Refuse(Exception):
    """Something this cannot read. Never downgraded to a skip."""


def served_files(root):
    """Every file the deploy publishes, as (path, syntax) pairs.

    `root` is the publish directory, dist/, and every file in it is served.
    Raises Refuse on a root holding netlify.toml, which is the site root and
    not what Netlify publishes, and on any file it cannot classify. A served
    file this does not understand is a served file nothing checks, which is
    the failure this module exists to make impossible.
    """
    root = pathlib.Path(root).resolve()
    if (root / "netlify.toml").exists():
        raise Refuse(
            f"{root} holds netlify.toml, so it is the site root, not the "
            "publish directory. Netlify publishes dist/, which "
            "tools/build-dist.py builds: run that, then pass dist.")
    if not root.is_dir():
        raise Refuse(
            f"{root} is not a directory. Run tools/build-dist.py first; it "
            "builds dist/, the publish directory.")

    out, unknown = [], []
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root).as_posix()
        # `.well-known` IS THE EXCEPTION TO THE DOT RULE and the docstring
        # claimed this was handled while no code handled it — a stale claim on
        # top of a live hole, which is worse than the hole. Netlify does not
        # deploy dot-paths EXCEPT `.well-known`, which is exactly where a
        # security.txt or a domain-verification token goes. Verified by a
        # review: a .well-known/security.txt carrying an issue id, a lane name
        # and a home path survived untouched with the gate printing clean.
        # tools/build-dist.py's Guard B keeps every dot-path out of dist/,
        # .well-known included, so today this skips nothing.
        if any(part.startswith(".") and part != ".well-known"
               for part in rel.split("/")):
            continue

        if p.is_symlink():
            # REFUSED, AND IT USED TO BE A BARE `continue` WITH NO COMMENT. A
            # symlink is invisible to both the strip and the gate, so if
            # Netlify resolves and deploys one, its target ships unstripped and
            # unchecked while the gate reports the tree clean. Whether Netlify
            # does resolve it is unsettled and needs a deploy to answer
            # (ROW-138). Until it is answered this fails loudly rather than
            # failing open, which is what every other unclassifiable thing in
            # this module does.
            raise Refuse(
                f"{p.relative_to(root)} is a symlink. Whether Netlify deploys "
                "its target is unsettled, so this will not decide for you: "
                "replace it with a real file, or add an explicit rule here.")
        if not p.is_file():
            continue
        ext = p.suffix.lower()
        if ext in BINARY:
            # RETURNED, NOT DROPPED, and it used to be dropped. Leaving the
            # served set meant the identifier scan never read the file at all,
            # while rule 2 is documented as "no internal identifier anywhere in
            # a served file, comment or not". A PDF exported from a local tool
            # routinely carries /Users/<name>/... in its /Title or /Creator,
            # and its metadata, outline titles and uncompressed streams are
            # readable ASCII. `.wasm` and `.ttf` sit the same way. Listing
            # rather than sniffing correctly makes an UNKNOWN extension fatal;
            # it says nothing about a known one whose bytes carry identifiers.
            out.append((p, "binary"))
            continue
        if rel in VERBATIM_PAYLOAD_FILES:
            # Overrides SYNTAX by exact path, not by extension or directory.
            # A verbatim payload file still has to be a text file this module
            # can read (not "binary", not something rglob should never have
            # reached; both checks above still apply to it), it just has no
            # comment convention of ours to apply. Unlike a directory prefix,
            # this does NOT bypass the unknown-extension refusal below for
            # anything else: a new payload file needs its own line added
            # here, deliberately, the same discipline BINARY and SYNTAX
            # already require of every other served file.
            out.append((p, "none"))
            continue
        if ext not in SYNTAX:
            unknown.append(rel)
            continue
        out.append((p, SYNTAX[ext]))

    if unknown:
        raise Refuse(
            "these served files have an extension this does not know, so it "
            "cannot say whether they carry comments or not. Add them to SYNTAX "
            "or to BINARY in tools/served_text.py; do not leave them "
            "unclassified, because unclassified means unchecked:\n  "
            + "\n  ".join(unknown))
    return out


# ── where the comments are ──────────────────────────────────────────────────
#
# Returns spans as (start, end) half-open index pairs into the source. A
# stripper deletes them; a gate reports them. One implementation, so the two
# can never disagree about what a comment is.


# After these, a `/` begins a regex literal rather than a division. The bare
# previous-character heuristic cannot see them because they all end in a letter.
_REGEX_KEYWORDS = {
    "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
    "throw", "case", "do", "else", "yield", "await",
}
_TRAILING_WORD = re.compile(r"([A-Za-z_$][A-Za-z0-9_$]*)\s*$")


def _js_spans(src, off=0, what="js"):
    """Comment spans in JavaScript or CSS.

    THE HARD PART IS `/`, and it is hard in JS only. A slash begins a regex
    literal or a division depending on what came before it, and getting it
    wrong deletes live code: `a / b /*x*/ c` versus `a.replace(/b/*c*/, d)`.
    The rule used here is the standard one — a slash starts a regex when the
    last significant token cannot end an expression — and where that rule is
    not confident, this REFUSES rather than guesses.

    CSS has no regex literals and no line comments, which is why `what`
    exists rather than one lexer pretending both languages are the same.
    """
    spans = []
    i, n = 0, len(src)
    prev = ""          # last significant character, for the regex decision
    while i < n:
        c = src[i]

        if c in "\"'":
            q, i = c, i + 1
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == q:
                    break
                if src[i] == "\n" and what == "js":
                    raise Refuse(
                        f"unterminated {q} string at offset {off + i}; this "
                        "lexer would mis-read everything after it")
                i += 1
            if i >= n:
                raise Refuse(f"unterminated {q} string at offset {off + i}")
            prev, i = q, i + 1
            continue

        if c == "`" and what == "js":
            i += 1
            depth = 0
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == "$" and i + 1 < n and src[i + 1] == "{":
                    depth += 1
                    i += 2
                    continue
                if src[i] == "}" and depth:
                    depth -= 1
                    i += 1
                    continue
                if src[i] == "`" and not depth:
                    break
                i += 1
            if i >= n:
                raise Refuse(f"unterminated template literal at offset {off + i}")
            prev, i = "`", i + 1
            continue

        if what == "css" and (c in "uU") and src[i:i + 4].lower() == "url(":
            # AN UNQUOTED url() IS NOT A PLACE COMMENTS LIVE. `url(/img/*.png)`
            # is legal CSS and the `/*` in it was read as a comment opener, so
            # the lexer refused and failed the deploy on a valid stylesheet.
            # Quoted URIs were always safe because the string branch above eats
            # them; this covers the unquoted form. ROW-141.
            j = src.find(")", i + 4)
            if j < 0:
                raise Refuse(f"unterminated url( at offset {off + i}")
            prev, i = ")", j + 1
            continue

        if c == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i + 2)
            if j < 0:
                raise Refuse(
                    f"unterminated /* comment at offset {off + i}. Everything "
                    "after it would be read as commentary and deleted.")
            spans.append((off + i, off + j + 2, what))
            i = j + 2
            continue

        if c == "/" and i + 1 < n and src[i + 1] == "/" and what == "js":
            j = src.find("\n", i)
            j = n if j < 0 else j
            spans.append((off + i, off + j, what))
            i = j
            continue

        if c == "/" and what == "js":
            # Regex literal, or division? Decided by the previous significant
            # character, which is the standard heuristic and is not complete.
            # A `/` AFTER A KEYWORD STARTS A REGEX, and the bare
            # previous-character test could not tell `return` from an
            # identifier: the last character of `return` is alphanumeric, so
            # `return /a\/*b/.test(x)` was read as division and then as an
            # unterminated comment, refusing on legal JavaScript. ROW-141.
            word = _TRAILING_WORD.search(src[:i])
            after_keyword = bool(word) and word.group(1) in _REGEX_KEYWORDS
            if not after_keyword and (
                    prev in ")]" or (prev and (prev.isalnum() or prev in "_$`\"'"))):
                prev, i = "/", i + 1          # division
                continue
            k, cls = i + 1, False
            while k < n:
                if src[k] == "\\":
                    k += 2
                    continue
                if src[k] == "[":
                    cls = True
                elif src[k] == "]":
                    cls = False
                elif src[k] == "/" and not cls:
                    break
                elif src[k] == "\n":
                    raise Refuse(
                        f"a `/` at offset {off + i} reads as the start of a "
                        "regex literal but no closing `/` appears before the "
                        "line ends. This lexer will not guess whether it is a "
                        "regex or a division; rewrite the line or add it to "
                        "the exclusions with a reason.")
                k += 1
            if k >= n:
                raise Refuse(f"unterminated regex literal at offset {off + i}")
            prev, i = "/", k + 1
            continue

        if not c.isspace():
            prev = c
        i += 1
    return spans


def _markup_spans(src, off=0):
    """`<!-- ... -->` spans, refusing anything an HTML parser would read
    differently from the obvious regex.

    A non-greedy `<!--.*?-->` is the obvious implementation and it is the one
    that corrupts pages: an unmatched `<!--` swallows every byte up to the next
    `-->` anywhere in the file, live markup included.

    THE CAUSE IS ONE LINE IN A RENDERER, NOT ONE FILE. `web/lib/_render.mjs`
    escapes `<` and not `>` when it embeds a passport body as a JSON string
    literal, so a body containing `-->` produces a page with an unbalanced
    closer whose opener is unicode-escaped and therefore invisible. Every
    generated passport page has the shape: the static sample at
    website/passport/daily-brief.html, and every `app.phaeacia.ai/p/<id>`
    rendered at request time, which no exclusion list could ever enumerate.

    Counts are deliberately not quoted here. The sample was 15 openers against
    16 closers when this was written and goes to 15/15 the next time
    build-samples.mjs runs, and the per-request pages change with every
    passport. A number in this comment would be stale within a day and would
    read as though the hazard had gone with it. It has not: the hazard is the
    renderer's escaping, and it is tracked separately.

    So: scan forward, and refuse an opener with no closer rather than run to
    the end of the file. Every <script> and <style> body is blanked first, so a
    `-->` inside a string cannot close anything in the first place.
    """
    spans = []
    i = 0
    while True:
        a = src.find("<!--", i)
        if a < 0:
            return spans
        b = src.find("-->", a + 4)
        if b < 0:
            raise Refuse(
                f"a `<!--` at offset {off + a} is never closed. A regex strip "
                "would delete from here to the end of the file.")
        spans.append((off + a, off + b + 3, "markup"))
        i = b + 3


# THE ATTRIBUTE NAME MUST BE `type`, NOT MERELY END IN IT. The first version
# searched the raw attribute string for `type\s*=`, which matches the `type=`
# inside `data-type=`, `itemtype=` or any other attribute ending in those four
# letters. A critic built the leak: `<script data-type="analytics">` was read as
# a non-JS data block, its body was blanked, never lexed, and a
# `/* internal */` inside it passed the gate green.
_TYPE_ATTR = re.compile(
    r'(?:^|[\s"\'])type\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+))', re.I)

# Script types whose body is JavaScript. A MIME type may carry parameters
# (`text/javascript;charset=utf-8` is legal and was a critic's second leak), so
# parameters are cut before the comparison rather than the whole string being
# matched against literals.
_JS_TYPES = {
    "", "module", "text/javascript", "application/javascript",
    "text/ecmascript", "application/ecmascript", "text/jsx",
}

# Bodies that are DATA with no comment syntax at all. Not lexed. The gate's
# identifier rules still read them, because they are still served bytes.
_DATA_TYPES = {
    "application/ld+json", "application/json", "text/json",
    "text/plain", "importmap", "speculationrules",
}

# Bodies that are MARKUP. A critic put `text/template` and `text/html` in the
# data set and showed the consequence: `<!-- internal -->` inside a client-side
# template was served and the gate called the file clean. The mistake was
# reading "not JavaScript" as "not code".
_MARKUP_TYPES = {
    "text/template", "text/x-template", "text/html",
    "text/x-handlebars-template", "text/ng-template",
}


def _tag_end(src, lt):
    """Index of the `>` that closes the tag opening at `lt`, quotes respected.

    THE SCANNER USED TO LOOK FOR `<!--` AND `<script` ANYWHERE, WITH NO IDEA
    WHETHER IT WAS INSIDE A TAG. A review built the consequence:

        <p data-x="<!--">one</p>
        <p>LIVE PARAGRAPH TWO</p>
        <p data-y="-->">three</p>

    became `<p data-x="">three</p>` — two live paragraphs deleted, one span,
    both stages exit 0, no warning. An HTML parser sees ordinary characters in
    an attribute value; the scan saw an opener. The mirror case was a false
    build failure: an unmatched `<!--` in an attribute refused and killed the
    deploy on valid HTML.

    That is the same silent-corruption class `_RAW_TEXT` and `replacement()`
    were built to close, arriving through the one path nobody probed. The
    single-pass rewrite was right and did not reach it, because the entry
    condition sits upstream of the pass: the scan has to know what a tag IS
    before deciding what is inside one.
    """
    i, n = lt + 1, len(src)
    while i < n:
        c = src[i]
        if c in "\"'":
            j = src.find(c, i + 1)
            if j < 0:
                return -1
            i = j + 1
            continue
        if c == ">":
            return i
        i += 1
    return -1


def _attrs(text):
    """`name -> value` for one tag's attribute text, quotes respected.

    A SUBSTRING SEARCH FOR `type=` IS NOT AN ATTRIBUTE LOOKUP. The previous
    version anchored on a preceding quote or whitespace, which still matched
    the `type=` inside ANOTHER attribute's quoted value:

        <script data-note="a type=text/plain b">/* internal */ var x=1;</script>

    returned zero spans: the body was classified as data, never lexed, and the
    comment shipped with both stages green. That reopens what control g.html
    pins, in a form the control does not cover, and it evades rule 2 whenever
    the comment carries no identifier — which is exactly the case rule 1 exists
    for.
    """
    out, i, n = {}, 0, len(text)
    while i < n:
        while i < n and text[i] in " \t\r\n/":
            i += 1
        m = re.match(r"([A-Za-z_:][-A-Za-z0-9_:.]*)", text[i:])
        if not m:
            i += 1
            continue
        name = m.group(1).lower()
        i += len(m.group(1))
        while i < n and text[i] in " \t\r\n":
            i += 1
        if i < n and text[i] == "=":
            i += 1
            while i < n and text[i] in " \t\r\n":
                i += 1
            if i < n and text[i] in "\"'":
                q = text[i]
                j = text.find(q, i + 1)
                j = n if j < 0 else j
                out[name] = text[i + 1:j]
                i = j + 1
            else:
                m2 = re.match(r"[^\s>]*", text[i:])
                out[name] = m2.group(0)
                i += len(m2.group(0))
        else:
            out[name] = ""
    return out


def _script_spans(attrs, body, start):
    """Comment spans inside one <script> body, refusing a type it cannot place.

    A type this does not recognise is FATAL, not skipped. Skipping is what let
    the `data-type` leak through: an unrecognised type meant "data, leave it
    alone", so the way to hide a comment was to give the tag any attribute.
    """
    raw = _attrs(attrs).get("type")
    if raw is None:
        return _js_spans(body, start, "js")
    kind = raw.split(";")[0].strip().lower()
    if kind in _JS_TYPES:
        return _js_spans(body, start, "js")
    if kind in _MARKUP_TYPES:
        return _markup_spans(body, start)
    if kind in _DATA_TYPES:
        return []
    raise Refuse(
        f'<script type="{raw}"> is a type this does not know, so it cannot say '
        "whether the body is code with comments in it or inert data. Add it to "
        "_JS_TYPES, _MARKUP_TYPES or _DATA_TYPES in tools/served_text.py. Do "
        "not leave it unclassified: unclassified means never scanned.")


def _hash_spans(src):
    """`#` line comments, for robots.txt and its kind.

    ONLY A LINE-LEADING `#`, AND A REVIEW CAUGHT THIS CONTRADICTING ITS OWN
    DOCSTRING. An earlier version also treated a trailing `#` as a comment, on
    the reasoning that robots.txt's format allows one. The consequence was a
    live change to what crawlers are told:

        Disallow: /a#b                            ->  Disallow: /a
        Sitemap: https://phaeacia.ai/x.xml#main   ->  Sitemap: ...x.xml

    A broader disallow than the author wrote, and a truncated URL, from a
    stripper whose entire promise is that it removes commentary and nothing
    else. Both guards passed it: the length assertion shares `replacement()`
    and the second pass finds nothing.

    Robots.txt genuinely does allow a trailing `#`, so this is a real conflict
    and it is resolved deliberately rather than by which reading is more
    literal: a value containing `#` is data we must not touch, a whole-line
    comment is commentary we must remove, and when the two readings disagree
    the stripper takes the one that cannot corrupt a served instruction. A
    trailing `#` comment therefore survives the strip and is caught by the
    gate's identifier rules instead, which read the whole file.
    """
    spans, at = [], 0
    lines = src.split("\n")
    for i, line in enumerate(lines):
        s = line.lstrip()
        if s.startswith("#"):
            # A whole-line comment takes its newline with it, or the file keeps
            # one blank line per comment; robots.txt is 92% commentary here and
            # came out of the first version with sixteen blank lines on top.
            end = at + len(line) + (1 if i + 1 < len(lines) else 0)
            spans.append((at, end, "hash"))
        elif "#" in line:
            # REPORTED BUT NEVER REMOVED, kind `hash-trailing`. The gate must
            # see it, because it is commentary on a served surface. The
            # stripper must not touch it, because it cannot tell a comment from
            # a value: deleting to end of line turned `Disallow: /a#b` into
            # `Disallow: /a`, a broader disallow than the author wrote, and
            # truncated a Sitemap URL at its fragment.
            #
            # So the build FAILS rather than guessing, and the message tells
            # the author to rewrite the line. That is the only outcome here
            # that neither corrupts an instruction nor ships commentary.
            spans.append((at + line.index("#"), at + len(line), "hash-trailing"))
        at += len(line) + 1
    return spans


# ELEMENTS WHOSE CONTENT IS VISIBLE TEXT, so `<!--` inside them is characters a
# reader sees rather than a comment. `<title>Docs <!-- v3 --></title>` renders
# the arrow brackets. A critic ran the first version of this on exactly that and
# watched it silently delete visible text from a title and a textarea.
#
# The justification once written into replacement() was "an HTML comment is
# never rendered anywhere, `<pre>` included". True of `<pre>`, which is ordinary
# markup that merely preserves whitespace, and that is why the example was
# convincing. False of these three.
#
# `noscript`, `iframe` and `noframes` WERE IN THIS LIST AND HAVE BEEN REMOVED.
# A review found the consequence: treating them as raw text meant a real HTML
# comment inside either was neither stripped nor reported, so the gate exited 0
# on it. `<noscript>` in particular holds the markup that renders when
# JavaScript is off, which is a surface this site cares about; a comment there
# is a comment.
_RAW_TEXT = ("title", "textarea", "xmp")


def comments(path, syntax, src=None):
    """Every comment span in one served file, tagged with the language it is in.

    ONE LEFT-TO-RIGHT PASS, AND IT USED TO BE THREE OVERLAPPING ONES. The old
    shape blanked raw-text bodies into one copy, then scanned `src` for
    <script>/<style>, then scanned a differently-blanked copy for `<!-- -->`.
    Three passes over three versions of the same bytes, and a review found two
    corruptions and a crash living in the gaps between them:

      A COMMENTED-OUT SCRIPT BLOCK KILLED THE BUILD.
      `<!-- <script>/* old */ var x=1;</script> -->` produced a markup span
      from the blanked copy and a JS span from the raw one, overlapping, and
      `strip()` raised on the overlap. Commenting out a script block is
      ordinary HTML, and the failure was a five-frame traceback with no file
      named, so the deploy log pointed at this lexer instead of at the page.

      A LITERAL <script> INSIDE A <textarea> WAS LEXED AS CODE.
      The raw-text blanking wrote into one copy and the block loop iterated
      the other, so `<textarea>Paste this: <script>/* key */</script></textarea>`
      had its visible text deleted — the identical corruption `_RAW_TEXT` was
      added to prevent, still open on the path nobody had tested.

    Scanning once removes the class rather than the two instances. Whichever
    construct starts first consumes its own extent, so a <script> inside a
    comment is never seen because the comment ate it, and a `-->` inside a JS
    string is never seen because the script ate it. Neither needs the other to
    be blanked first, and there is no second copy to disagree with.
    """
    src = path.read_text(encoding="utf-8") if src is None else src
    if syntax in ("none", "binary"):
        return []
    if syntax == "hash":
        return _hash_spans(src)
    if syntax in ("js", "css"):
        return _js_spans(src, 0, syntax)

    # XML AND SVG TAKE THIS PATH TOO, and used to take a markup-only one. An
    # SVG may legally carry <script> and <style>, which is the usual way an SVG
    # carries behaviour, and a comment inside one was never lexed. Rule 1 says
    # a served text file contains no comments AT ALL; for this file type it was
    # checking one of the three syntaxes the file can contain.
    spans = []
    i, n = 0, len(src)

    while i < n:
        lt = src.find("<", i)
        if lt < 0:
            break

        if src.startswith("<!--", lt):
            j = src.find("-->", lt + 4)
            if j < 0:
                raise Refuse(
                    f"a `<!--` at offset {lt} is never closed. A regex strip "
                    "would delete from here to the end of the file.")
            spans.append((lt, j + 3, "markup"))
            i = j + 3
            continue

        m = re.match(r"</?([A-Za-z][A-Za-z0-9-]*)", src[lt:lt + 64])
        if not m:
            i = lt + 1          # a bare `<` in text, e.g. `a < b`
            continue

        gt = _tag_end(src, lt)
        if gt < 0:
            raise Refuse(f"a <{m.group(1)}> tag at offset {lt} is never closed")
        attrs = src[lt + 1 + len(m.group(0)) - 1:gt]
        tag = m.group(1).lower()
        i = gt + 1

        if src[lt + 1] == "/" or src[gt - 1] == "/":
            continue            # a closing tag or a self-closing one
        if tag not in ("script", "style") and tag not in _RAW_TEXT:
            continue

        close = re.compile(r"</" + tag + r"\s*>", re.I).search(src, i)
        if not close:
            # AN UNCLOSED <script> OR <style> IS FATAL, AND USED TO BE
            # INVISIBLE. A browser tolerates one and runs the rest of the file
            # as script; this module simply failed to match the block, so its
            # body was neither lexed nor checked and the gate reported the file
            # clean. `_script_spans` REFUSES an unrecognised `type=` for
            # exactly this reason, so an absent closing tag was getting the
            # skip that a type attribute is refused.
            raise Refuse(
                f"a <{tag}> at offset {lt} is never closed, so its body would "
                "go unchecked and anything inside it would ship. Close the tag.")

        body = src[i:close.start()]
        if tag == "style":
            spans += _js_spans(body, i, "css")
        elif tag == "script":
            spans += _script_spans(attrs, body, i)
        # else: a raw-text element. Its content is characters a reader sees,
        # so nothing in it is a comment and nothing in it is lexed.
        i = close.end()

    return sorted(spans)


def replacement(src, a, b, kind):
    """What goes where a comment was, and it is not always nothing.

    DELETING A CODE COMMENT CAN FUSE THE TOKENS AROUND IT. `a/**/b` becomes
    `ab`; `1px/**/solid` becomes `1pxsolid`. Every check that would plausibly
    catch that misses it: only the identified spans were removed, so the length
    assertion passes; the result has no comments, so the idempotence check
    passes; the fused text is still valid syntax, so `node --check` passes; and
    a naive-regex differential agrees because it performs the identical
    deletion. Measured on both repositories today: zero instances. Nothing in
    the design would have said when the first one appeared.

    A MULTI-LINE COMMENT ALSO CARRIES A LINE BREAK, AND JAVASCRIPT READS ONE.
    `return /*\n*/ 5` returns undefined, because automatic semicolon insertion
    sees the newline; delete the comment and it returns 5. `node --check`
    cannot see that either, since both parse.

    So a code comment is replaced rather than deleted: one newline if it
    spanned one, otherwise one space. That keeps the tokens apart and keeps the
    line structure the parser reacts to, at a cost of one byte.

    A MARKUP COMMENT IS DELETED OUTRIGHT, and that is not an inconsistency:
    there are no tokens to fuse and no newline anything reacts to. Replacing
    those with newlines instead would leave the served pages full of blank
    lines for no gain.

    THIS PARAGRAPH USED TO JUSTIFY THAT WITH "an HTML comment is never rendered
    anywhere, `<pre>` included, so removing it changes no output by
    construction", AND THAT IS FALSE. It is true of `<pre>`, which is ordinary
    markup that merely preserves whitespace, and that is why the example was
    convincing. It is false of `<title>`, `<textarea>`, `<iframe>`,
    `<noframes>`, `<xmp>` and `<noscript>`, where the parser is not looking for
    comments at all and `<!--` is text a reader sees. A critic ran the first
    version on `<title>Docs <!-- see also --> v3</title>` and watched it come
    out as `<title>Docs  v3</title>`, silently, exit 0.

    Those elements are blanked before the markup scan now, so the case this
    paragraph got wrong cannot arise. The correct statement is narrower: a
    markup comment, in a context where the parser is looking for one, is never
    rendered.

    THE KIND IS THE SPAN'S, NOT THE FILE'S, AND THAT DISTINCTION IS THE WHOLE
    BUG THIS SIGNATURE ONCE HAD. This took the FILE's syntax, so in a .html
    file every JS and CSS comment found inside an inline <script> or <style>
    was deleted outright rather than replaced. The guard above worked perfectly
    for standalone .js and .css and not at all where most of the inline code
    on this site lives. From the same lexer in the same run:

        standalone .js   var c=a/**/b;                    ->  var c=a b;
        inline in .html  <script>var c=a/**/b;</script>   ->  <script>var c=ab;</script>

    and the ASI case changed BEHAVIOUR, not just tokens: a multi-line comment
    between `return` and `5` was deleted rather than replaced by its newline,
    turning a function that returned undefined into one that returns 5.

    A review counted 49 such spans across five served pages at the time, 39 of
    them multi-line, one immediately preceding `window.__BODY`. None fused,
    because the neighbouring bytes happened to be newlines. Nothing in the
    design would have said when the first one did, and no check here could see
    it: `expected_length` calls this same function, so the length assertion
    agreed; the output had no comments, so idempotence agreed; and both forms
    parse, so `node --check` agreed.
    """
    if kind in ("js", "css"):
        return "\n" if "\n" in src[a:b] else " "
    return ""


def strip(src, spans):
    """Remove the spans. Everything outside them is byte-identical."""
    out, at = [], 0
    for a, b, kind in sorted(spans):
        if kind == "hash-trailing":
            raise Refuse(
                f"a trailing `#` at offset {a} is commentary on a served file, "
                "and this will not remove it: in a line like `Disallow: /a#b` "
                "the `#` is part of the value, and deleting to end of line "
                "would silently broaden the rule. Rewrite the line so the "
                "comment is on its own line, or drop it.")
        if a < at:
            raise Refuse("overlapping comment spans; refusing to strip")
        out.append(src[at:a])
        out.append(replacement(src, a, b, kind))
        at = b
    out.append(src[at:])
    return "".join(out)


def expected_length(src, spans):
    """What strip() must produce, computed independently of strip() itself."""
    n = len(src)
    for a, b, kind in sorted(spans):
        n -= (b - a) - len(replacement(src, a, b, kind))
    return n


if __name__ == "__main__":
    # AN INVENTORY, and it is the tool that produced the byte counts quoted in
    # both netlify.toml files. A review found it could not run at all: it
    # unpacked two-tuples from three and tried to decode binary files as text,
    # so nobody could re-derive or check those numbers. Both fixed; a number
    # nobody can reproduce is a number nobody should have quoted.
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "dist").resolve()
    try:
        files = served_files(root)
    except Refuse as e:
        print(f"REFUSED: {e}")
        raise SystemExit(1)
    total = 0
    for p, syn in files:
        if syn == "binary":
            continue
        try:
            src = p.read_text(encoding="utf-8")
            sp = comments(p, syn, src)
        except Refuse as e:
            print(f"  REFUSED {p.relative_to(root)}: {e}")
            raise SystemExit(1)
        cb = sum(b - a for a, b, _ in sp)
        total += cb
        if sp:
            kinds = ",".join(sorted({k for _, _, k in sp}))
            print(f"  {str(p.relative_to(root)):44} {syn:5} {len(sp):4} spans "
                  f"{cb:7} bytes  {cb * 100 // max(len(src), 1):3}%  [{kinds}]")
    n_bin = sum(1 for _, s in files if s == "binary")
    print(f"{len(files) - n_bin} served text files and {n_bin} binary, "
          f"{total} bytes of commentary")

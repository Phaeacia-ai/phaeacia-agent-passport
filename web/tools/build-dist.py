#!/usr/bin/env python3
"""Build dist/, the one directory Netlify publishes, from an explicit allowlist.

    python3 tools/build-dist.py              build web/dist and check it
    python3 tools/build-dist.py --self-test  watch every guard fail on planted files

WHY THIS EXISTS. Until 2026-09-30 netlify.toml said `publish = "."`, so Netlify
was handed all of web/, and eight `force = true` 404 rules hid README.md, lib/,
netlify/, tools/, build.sh and the three manifests. Netlify matches a rule's
`from` case-sensitively and finds a static file case-insensitively, so
/LIB/_store.mjs, /NETLIFY/functions/upload.mjs and /README.MD answered 200 with
the whole server source (security review 2026-09-30, H1). No list of names
closes that, because a name has more spellings than a list has lines. A file
that is not in the publish directory is not deployed, so no spelling reaches
it. The one exception is Netlify's own: it lists netlify.toml in a deploy
whatever the publish directory holds (seen on 2026-09-30 in the file lists of
two sites that keep it outside theirs), and this site answered 404 that day
for /netlify.toml, /Netlify.toml and /NETLIFY.TOML.

WHAT IT DOES, in order. Any failure deletes dist/ and exits 1, so a half-built
or half-checked directory is never left for anything to publish.

  1. Refuses unless netlify.toml publishes exactly "dist", so reverting that one
     line cannot quietly bring the old exposure back. A key or table holding
     publish must be written in lower case, because Netlify folds `Publish` and
     `Build` in a build table and a capitalised override is as real as a plain
     one. It reads the file line by line, not as TOML, so it stops a revert and
     not a workaround: a critic got a production `publish = "."` past it with a
     TOML-escaped key and with a fake table header inside a multi-line string
     (2026-09-30). And it runs only if the build command Netlify resolves calls
     it: a [context.*] table that overrides `command` as well as publish skips
     it, and one that overrides `base` may (a second critic, 2026-09-30; PH-598).
  2. Deletes dist/ and copies in every file PUBLISH names. An exact entry that
     names no file fails, and so does a pattern that matches none: the page or
     asset it stands for would be missing from the site.
  3. GUARD A, NO PAGE LOST. Every file the old configuration served, meaning all
     of web/ except FORMERLY_HIDDEN, dot-paths and node_modules, is in dist/ or
     is named in NOT_PUBLISHED with its reason. A new page or asset nobody added
     to PUBLISH fails the build here instead of answering 404 in production.
  4. GUARD B, NOTHING PRIVATE. dist/ holds nothing under lib/, netlify/, tools/
     or node_modules/, no dot-path, no netlify.toml, build.sh, package*.json or
     deno.lock, no Python or shell file, and no Markdown PUBLIC_MARKDOWN does
     not name. Compared case-insensitively, because that is how Netlify finds a
     file.

RUNS AFTER build.sh AND substitute.py, which generate and fill the served
files, and BEFORE strip-served-comments.py and check-served-clean.py, which run
on dist/: the gate reads the bytes Netlify publishes, and the strip no longer
rewrites tracked source.
"""
import contextlib
import fnmatch
import io
import os
import pathlib
import re
import shutil
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent     # web/

# ── what is published ───────────────────────────────────────────────────────
#
# Exact paths, or patterns where `*` matches within ONE path segment and never
# a leading dot. `assets/*.js` is the scripts in assets/ itself, not in any
# folder below it. Anything this list does not reach stays out of dist/, and
# Guard A makes that a decision rather than an accident.
PUBLISH = [
    # The pages. Each is also a route: Netlify serves /about from about.html.
    "index.html",
    "about.html",
    "changelog.html",
    "create.html",
    "delete.html",
    "imprint.html",
    "manage.html",
    "privacy.html",
    "upload.html",

    # Styles and client scripts, linked from the pages above and from the pages
    # the functions render (/p/<id> in lib/_render.mjs, /gallery in
    # lib/_gallery-render.mjs).
    "assets/*.css",
    "assets/*.js",

    # Faces and their licences. fonts.css, app.css and card.js load the woff2
    # files, and imprint.html links OFL.txt. fonts/og/ is the static TTFs, cmap
    # and notice og.mjs draws the social card with; og.mjs reads them from its
    # own bundle (included_files), not over HTTP, and they stay published
    # because they were public before this change.
    "assets/fonts/*.woff2",
    "assets/fonts/fonts.css",
    "assets/fonts/OFL.txt",
    "assets/fonts/og/*",
    "assets/favicon/*",
    "assets/mark/*.svg",
    "assets/og/og-card.png",

    # Written by build.sh and fetched AT RUNTIME, which is why no page links
    # them and a list read off the markup would miss them. passport.js fetches
    # core.md, judge.md and the reader's platform branch to assemble "Install
    # this agent"; site.js fetches path-w-block.txt behind the browser-chat
    # copy button (data-copy-fetch and data-toggle-fetch on index.html and
    # create.html). LICENSE.md travels with the text it licenses. example.json
    # is the example passport the functions render at /p/example.
    "assets/example.json",
    "assets/installer/core.md",
    "assets/installer/judge.md",
    "assets/installer/LICENSE.md",
    "assets/installer/path-w-block.txt",
    "assets/installer/branches/*.md",
]

# Reachable under the old configuration and deliberately not published now.
# Every entry carries its reason. Short on purpose: a long list here is a
# second allowlist, written backwards.
NOT_PUBLISHED = {
    "netlify.toml": (
        "Netlify's own configuration. Production answered 404 on 2026-09-30 "
        "for /netlify.toml, /Netlify.toml and /NETLIFY.TOML with no rule of "
        "ours naming it, so this drops nothing a visitor had. Netlify is "
        "expected to list it in the deploy by itself even so (see the module "
        "docstring); Guard B keeps a copy out of dist/ regardless."),
}

# The paths the eight force-404 rules covered on 2026-09-30, when this change
# removed them from netlify.toml. Used for ONE thing: to work out which files
# the old configuration served, which is the set Guard A protects. It is not the
# list of what is private now. PUBLISH decides that, and Guard B checks it.
# `x/*` is a Netlify splat and reaches every depth below x/.
FORMERLY_HIDDEN = [
    "README.md",
    "netlify/*",
    "lib/*",
    "tools/*",
    "build.sh",
    "package.json",
    "package-lock.json",
    "deno.lock",
]

# The only Markdown a visitor may fetch: the installer text build.sh copies in.
PUBLIC_MARKDOWN = [
    "assets/installer/*.md",
    "assets/installer/branches/*.md",
]


class Fail(Exception):
    """The build must stop. The message says why and names the path."""


# ── matching ────────────────────────────────────────────────────────────────


def _is_pattern(entry):
    return any(c in entry for c in "*?[")


def _match(rel, pattern):
    """Does a path match a PUBLISH pattern, segment by segment?

    fnmatch alone lets `*` cross a `/`, so `assets/*.js` would also take
    `assets/deep/x.js`, and lets `*` match a leading dot, so it would take
    `assets/.env.js`. Both are refused here: a pattern reaches one directory
    level, and a dot-name only by a pattern segment that starts with a dot.
    """
    names, pats = rel.split("/"), pattern.split("/")
    if len(names) != len(pats):
        return False
    for name, pat in zip(names, pats):
        if name.startswith(".") and not pat.startswith("."):
            return False
        if not fnmatch.fnmatchcase(name, pat):
            return False
    return True


def _formerly_hidden(rel):
    for rule in FORMERLY_HIDDEN:
        if rule.endswith("/*"):
            if rel.startswith(rule[:-1]):
                return True
        elif rel == rule:
            return True
    return False


def _netlify_skips(rel):
    """Netlify does not deploy a dot-path, except .well-known."""
    return any(p.startswith(".") and p != ".well-known" for p in rel.split("/"))


def _walk(top, prune):
    """Every file and symlink under `top`, as sorted posix paths relative to it.

    Symlinks are listed and never followed, so a symlinked directory is one
    entry rather than the tree it points at. `prune(rel)` names directories to
    leave out entirely, and is asked first, so a node_modules that is itself a
    symlink is left out like any other rather than listed.
    """
    found = []
    for dirpath, dirnames, filenames in os.walk(top):
        here = pathlib.Path(dirpath)
        base = here.relative_to(top).as_posix()
        keep = []
        for d in dirnames:
            rel = d if base == "." else base + "/" + d
            if prune(rel):
                continue
            if (here / d).is_symlink():
                found.append(rel)
            else:
                keep.append(d)
        dirnames[:] = keep
        for f in filenames:
            found.append(f if base == "." else base + "/" + f)
    return sorted(found)


# ── the checks ──────────────────────────────────────────────────────────────


def _uncommented(line):
    """A TOML line without its comment. A `#` inside quotes is not one."""
    quote = None
    for i, ch in enumerate(line):
        if quote:
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
        elif ch == "#":
            return line[:i]
    return line


def _check_publish_setting(root):
    """netlify.toml must publish "dist", once, from [build], in lower case.

    A `publish` under [context.*] would override it for that context, and one
    this cannot read could say anything, so both fail. [dev] is allowed: it
    only tells `netlify dev` which folder to serve on a developer's machine.

    CAPITALS ARE REFUSED, NOT FOLDED. Netlify's config reader folds `Build` and
    `Publish` to lower case inside a build table (netlify-cli,
    @netlify/config/lib/case.js), so `Publish = "."` under
    [context.production.build] is a real override: Netlify's resolver gives
    production the base directory, web/. Until 2026-09-30 this skipped it,
    because it looked for "publish" in lower case only. It now finds the word
    in any case and refuses a key, or a table holding it, not written in lower
    case. It does not fold them itself, because Netlify does not fold them
    evenly: it ignores a lone `PUBLISH = "dist"` and publishes web/, so a check
    that folded that one would pass the exposure this file exists to stop.
    """
    toml = root / "netlify.toml"
    if not toml.is_file():
        raise Fail("no netlify.toml beside tools/, so what Netlify publishes "
                   "cannot be checked")
    table, found = "", []
    for raw in toml.read_text(encoding="utf-8").split("\n"):
        line = _uncommented(raw).strip()
        head = re.fullmatch(r"\[\[?\s*([^\[\]]+?)\s*\]\]?", line)
        if head:
            table = head.group(1)
            continue
        if "publish" not in line.lower():
            continue
        kv = re.fullmatch(r'publish\s*=\s*"([^"]*)"', line, re.IGNORECASE)
        if not kv:
            raise Fail("cannot read this netlify.toml line, and it mentions "
                       "publish:\n     " + raw.strip())
        if not line.startswith("publish") or table != table.lower():
            raise Fail("netlify.toml spells publish, or the table holding it, "
                       "with capitals. Netlify folds some capitalised names to "
                       "lower case and not others, so this does not guess; "
                       "write both in lower case:\n     [%s] %s"
                       % (table, raw.strip()))
        found.append((table, kv.group(1)))
    build = [v for t, v in found if t == "build"]
    other = [(t, v) for t, v in found if t not in ("build", "dev")]
    if build != ["dist"] or other:
        raise Fail("netlify.toml must publish exactly \"dist\" from [build] "
                   "and nowhere else; it says " + repr(found) + ". Anything "
                   "else publishes a directory these guards never looked at.")


def _why_private(rel):
    """Why a path must not be in dist/, or None. Case-insensitive throughout."""
    low = rel.lower()
    parts = low.split("/")
    name = parts[-1]
    if parts[0] in ("lib", "netlify", "tools"):
        return "under %s/, the server source and build tooling" % parts[0]
    if "node_modules" in parts:
        return "under node_modules/"
    if any(p.startswith(".") for p in parts):
        # .well-known included. security.txt is worth publishing one day, and
        # when it is, it gets a deliberate exception here, not a free pass.
        return "a dot-path"
    if "__pycache__" in parts or name.endswith((".py", ".pyc", ".sh")):
        return "a Python or shell file"
    if name in ("netlify.toml", "build.sh", "deno.lock") or \
            fnmatch.fnmatchcase(name, "package*.json"):
        return "build or package configuration"
    if name.endswith(".md") and \
            not any(_match(low, p.lower()) for p in PUBLIC_MARKDOWN):
        return "Markdown PUBLIC_MARKDOWN does not name"
    return None


def build(root, publish=None, not_published=None):
    """Build root/dist and check it. Prints what it did; returns an exit code."""
    root = pathlib.Path(root).resolve()
    dist = root / "dist"
    publish = PUBLISH if publish is None else publish
    not_published = NOT_PUBLISHED if not_published is None else not_published
    built = False
    try:
        _check_publish_setting(root)

        tree = _walk(root, lambda rel: rel == "dist" or
                     rel.split("/")[-1] == "node_modules" or _netlify_skips(rel))
        tree_set = set(tree)

        chosen, problems = set(), []
        for entry in publish:
            hits = [rel for rel in tree if _match(rel, entry)] \
                if _is_pattern(entry) else ([entry] if entry in tree_set else [])
            if not hits:
                problems.append("PUBLISH entry %r %s" % (
                    entry, "matches no file" if _is_pattern(entry) else "names no file"))
            chosen.update(hits)
        for rel in sorted(chosen):
            if (root / rel).is_symlink():
                problems.append("%s is a symlink, and its target could be "
                                "anything; publish a real file" % rel)
        for rel, why in sorted(not_published.items()):
            if rel not in tree_set:
                problems.append("NOT_PUBLISHED names %s, which does not exist; "
                                "drop the entry" % rel)
            elif rel in chosen:
                problems.append("%s is both in PUBLISH and in NOT_PUBLISHED" % rel)
        if problems:
            raise Fail("the allowlist does not describe this tree:\n     " +
                       "\n     ".join(problems))

        if dist.is_symlink() or (dist.exists() and not dist.is_dir()):
            raise Fail("dist exists and is not a plain directory; remove it by hand")
        if dist.exists():
            shutil.rmtree(dist)
        dist.mkdir()
        for rel in sorted(chosen):
            (dist / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(root / rel, dist / rel)

        # GUARD A. What the old configuration served, measured on this tree.
        reachable = [rel for rel in tree
                     if not _formerly_hidden(rel) and not _netlify_skips(rel)]
        lost = [rel for rel in reachable
                if rel not in chosen and rel not in not_published]
        if lost:
            raise Fail("GUARD A FAILED: %d file(s) the old configuration served "
                       "are not in dist/:\n     %s\n   Add each to PUBLISH in "
                       "tools/build-dist.py, or to NOT_PUBLISHED with the reason "
                       "it stops being served." % (len(lost), "\n     ".join(lost)))

        # GUARD B. What is actually in dist/, not what was meant to be copied.
        shipped = _walk(dist, lambda rel: False)
        bad = []
        for rel in shipped:
            p = dist / rel
            if p.is_symlink() or not p.is_file():
                bad.append("%s  (not a regular file)" % rel)
                continue
            why = _why_private(rel)
            if why:
                bad.append("%s  (%s)" % (rel, why))
        if bad:
            raise Fail("GUARD B FAILED: dist/ holds %d private path(s):\n     %s"
                       % (len(bad), "\n     ".join(bad)))
        if set(shipped) != chosen:
            raise Fail("dist/ does not hold exactly what was copied into it")
        built = True
    except Fail as e:
        print("   " + str(e))
        return 1
    finally:
        # Also on an exception nobody anticipated, which still exits non-zero
        # with its traceback: what is left must not be a dist/ nobody checked.
        if not built and dist.is_dir() and not dist.is_symlink():
            shutil.rmtree(dist)

    print("   dist: %d files published, %d reachable under the old publish = \".\" "
          "rules, %d deliberately not published (%s)"
          % (len(shipped), len(reachable), len(not_published),
             ", ".join(sorted(not_published)) or "none"))
    return 0


# ── known-positive controls ─────────────────────────────────────────────────
#
# A guard nobody has watched fail cannot be told apart from one that cannot
# fail. Each control plants one thing in a throwaway copy of web/'s shape and
# asserts the build fails FOR THE NAMED REASON, naming the path, and leaves no
# dist/ behind; the accept controls assert the clean shape passes. The planted
# tree is generated from PUBLISH itself, so it follows the list as it changes.


def _plant(root, extra=(), toml='[build]\n  publish = "dist"\n'):
    (root / "netlify.toml").write_text(toml, encoding="utf-8")
    for entry in PUBLISH:
        rel = entry.replace("*", "x") if _is_pattern(entry) else entry
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text("public\n", encoding="utf-8")
    for rel in extra:
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text("planted\n", encoding="utf-8")


def _verdict(root, rc, out, want):
    """An accept control (want None) must build exactly the planted PUBLISH
    files; a failure control must exit 1, print every string in `want`, and
    leave no dist/ behind."""
    if want is None:
        expect = {e.replace("*", "x") if _is_pattern(e) else e for e in PUBLISH}
        got = set(_walk(root / "dist", lambda rel: False)) \
            if (root / "dist").is_dir() else set()
        return rc == 0 and got == expect
    return rc == 1 and all(w in out for w in want) and not (root / "dist").exists()


def self_test():
    cases = [
        # (what, planted files, extra PUBLISH entries, toml or None, must print)
        ("accept: the clean shape builds", (), (), None, None),
        ("accept: private files in their old places, and a dot-file beside the "
         "scripts, are neither demanded nor shipped",
         ("lib/_store.mjs", "netlify/functions/upload.mjs",
          "tools/run-tests.mjs", "README.md", "build.sh", "package.json",
          ".env", "node_modules/x/index.js", "assets/.x.js"),
         (), None, None),
        ("GUARD A: a new root file nobody added to PUBLISH", ("NOTES.txt",),
         (), None, ["GUARD A FAILED", "NOTES.txt"]),
        ("GUARD A: assets/*.js reaches one level, not assets/drafts/x.js",
         ("assets/drafts/x.js",), (), None,
         ["GUARD A FAILED", "assets/drafts/x.js"]),
        ("GUARD A: a stale proprietary copy under assets/, which a directory-"
         "wide allowlist would have shipped", ("assets/capture-prompt.md",),
         (), None, ["GUARD A FAILED", "assets/capture-prompt.md"]),
        ("GUARD B: server source", ("lib/_store.mjs",), ("lib/*",), None,
         ["GUARD B FAILED", "lib/_store.mjs", "under lib/"]),
        ("GUARD B: server source in another case, the H1 spelling",
         ("Lib/_store.mjs",), ("Lib/*",), None,
         ["GUARD B FAILED", "Lib/_store.mjs", "under lib/"]),
        ("GUARD B: README.MD", ("README.MD",), ("README.MD",), None,
         ["GUARD B FAILED", "README.MD", "Markdown"]),
        ("GUARD B: a manifest", ("Package.json",), ("Package.json",), None,
         ["GUARD B FAILED", "Package.json", "configuration"]),
        ("GUARD B: a dot-file", (".env",), (".env",), None,
         ["GUARD B FAILED", ".env", "dot-path"]),
        ("GUARD B: a shell script outside tools/", ("assets/deploy.sh",),
         ("assets/deploy.sh",), None,
         ["GUARD B FAILED", "assets/deploy.sh", "shell"]),
        ("publish reverted to the site root", (), (),
         '[build]\n  publish = "."\n', ["must publish exactly", "'.'"]),
        ("a context overriding publish", (), (),
         '[build]\n  publish = "dist"\n[context.production]\n  publish = "."\n',
         ["must publish exactly", "context.production"]),
        ("a publish spelling this cannot read", (), (),
         "[build]\n  publish = 'dist'\n", ["cannot read", "publish"]),
        # Netlify's resolver reads the second and third as production overrides
        # that publish web/; the first and fourth it does not read as publish at
        # all. This refuses all four, because it does not model which it folds.
        ("a capitalised Publish under a context", (), (),
         '[build]\n  publish = "dist"\n[context.production]\n  Publish = "."\n',
         ["with capitals", "[context.production] Publish"]),
        ("a capitalised Publish under a context's build table", (), (),
         '[build]\n  publish = "dist"\n[context.production.build]\n'
         '  Publish = "."\n',
         ["with capitals", "[context.production.build] Publish"]),
        ("a capitalised table and key", (), (),
         '[build]\n  publish = "dist"\n[context.production.Build]\n'
         '  Publish = "."\n',
         ["with capitals", "[context.production.Build] Publish"]),
        ("an upper-case PUBLISH beside the real one", (), (),
         '[build]\n  PUBLISH = "."\n  publish = "dist"\n',
         ["with capitals", "[build] PUBLISH"]),
        # Why capitals are refused rather than folded: Netlify ignores this key
        # and publishes the base directory, web/, so a check that folded it
        # would pass the very exposure this file exists to stop.
        ("a lone upper-case PUBLISH, which Netlify ignores", (), (),
         '[build]\n  PUBLISH = "dist"\n', ["with capitals", "[build] PUBLISH"]),
        ("a capitalised [Build] is refused even holding \"dist\"", (), (),
         '[Build]\n  publish = "dist"\n', ["with capitals", "[Build] publish"]),
    ]
    ok = True
    for what, extra, more, toml, want in cases:
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            if toml is None:
                _plant(root, extra)
            else:
                _plant(root, extra, toml)
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = build(root, PUBLISH + list(more))
            out = buf.getvalue()
            right = _verdict(root, rc, out, want)
        ok = ok and right
        print("  [%s] %s" % ("PASS" if right else "FAIL", what))
        if not right:
            print("        exit %d, output:\n        %s" % (
                rc, out.strip().replace("\n", "\n        ")))

    # Taking a file away, or swapping one for a symlink, cannot be planted by
    # writing text, so these get their own cases.
    def symlinked(root):
        (root / "assets" / "x.js").unlink()
        (root / "assets" / "x.js").symlink_to(root / "netlify.toml")

    def linked_modules(root):
        (root / "node_modules").symlink_to(root / "assets")

    for what, change, want in [
        ("accept: a node_modules that is a symlink is left out, not listed",
         linked_modules, None),
        ("a page PUBLISH names is missing",
         lambda root: (root / "about.html").unlink(),
         ["PUBLISH entry 'about.html' names no file"]),
        ("a pattern in PUBLISH matches nothing",
         lambda root: (root / "assets" / "x.css").unlink(),
         ["PUBLISH entry 'assets/*.css' matches no file"]),
        ("a symlink in PUBLISH is refused, not followed", symlinked,
         ["assets/x.js is a symlink"]),
    ]:
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            _plant(root)
            change(root)
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = build(root)
            out = buf.getvalue()
            right = _verdict(root, rc, out, want)
        ok = ok and right
        print("  [%s] %s" % ("PASS" if right else "FAIL", what))
        if not right:
            print("        exit %d, output:\n        %s" % (
                rc, out.strip().replace("\n", "\n        ")))

    print("\ndist self-test: " + ("every control behaved" if ok else
                                  "A CONTROL DID NOT BEHAVE; these guards are not trustworthy"))
    return 0 if ok else 1


if __name__ == "__main__":
    if "--self-test" in sys.argv[1:]:
        raise SystemExit(self_test())
    raise SystemExit(build(ROOT))

#!/usr/bin/env python3
"""Remove the engineering commentary from the deploy, never from the repository.

    python3 tools/strip-served-comments.py dist --deploy

RUNS ON dist/ ONLY, the publish directory tools/build-dist.py has just built,
and that distinction is the whole design. The reasoning stays in git, where it
is what stops the next person undoing a deliberate choice, and the served page
carries none of it. Until 2026-09-30 this ran on the whole deploy checkout and
rewrote tracked source there, safe only because Netlify throws its clone away.
tools/served_text.py now refuses a root holding netlify.toml, so pointed at
web/ this stops before it reads a file.

NEVER RUN THIS IN A WORKING TREE YOU INTEND TO COMMIT. It edits files in place
and there is no undo but git. `--deploy` is REQUIRED, unconditionally, and its
absence is the refusal.

THE FIRST VERSION DERIVED PERMISSION FROM TREE STATE and had the logic exactly
inverted. It refused on a DIRTY tree and ran on a CLEAN one, which protects
unsaved work and leaves committed source unprotected — the opposite of what
matters, since uncommitted work is the thing git cannot give back. A critic ran
it against a clean repository and against a directory that was not a repository
at all; both rewrote their files, printed a success line and exited 0. In the
second case the guard was not merely wrong, it was absent: `git status` exits
non-zero outside a repository, the condition tested `returncode == 0`, and the
check fell through in exactly the situation where there is no `git checkout` to
undo it.

Measured blast radius at the time: `~/Phaeacia/website` was clean, so
`python3 tools/strip-served-comments.py .` there would have deleted 301,402
bytes across 22 tracked files and reported success. Recoverable if noticed,
not if committed, and it touches only files a routine `git add -A` sweeps up.

There is a second-order cost worth knowing about: `tools/build-samples.mjs`
parses `/* build-samples:begin */` markers out of `assets/site.js` to check the
SAMPLES list agrees in three places. A local strip deletes those markers and
the generator then fails with "the build-samples block is gone", one step
removed from the cause, so whoever hits it debugs the generator. The deploy is
unaffected: build-samples.mjs is not in the build command and reads the local
repository, never the deploy copy.

WHAT IT WILL NOT DO. It does not run a regex over `<!--.*?-->`. That
implementation is the one most likely to corrupt a page here, and the shape it
would corrupt is a generated passport page: a body containing `-->` produces a
page with a closer whose opener is unicode-escaped and therefore invisible, so
a non-greedy regex swallows every byte between them, live markup included.

NO COUNTS OR LINE NUMBERS ARE QUOTED, and an earlier version of this paragraph
quoted three. The cause is one line in the app's renderer rather than one file,
so the numbers move: the static sample regenerates the moment a merge lets
build-samples.mjs run, and the per-request /p/<id> pages differ per passport.
A stale count here would read as though the hazard had gone with it.

The shared lexer in tools/served_text.py scans ONCE, left to right, parsing
tags with quote awareness. Whichever construct starts first consumes its own
extent, so a `-->` inside a JS string is never a terminator because the script
element consumed it, and a `<!--` inside an ATTRIBUTE VALUE is characters
rather than an opener. An unclosed opener refuses rather than running to the
end of the file.

THIS PARAGRAPH DESCRIBED A DIFFERENT MECHANISM UNTIL A REVIEW CAUGHT IT. It
said the lexer "blanks every <script> and <style> body before it looks for
markup comments", which was true of the three-pass version and was deleted by
the single-pass rewrite that replaced it. The same sentence stood in four other
files. The current design is STRONGER than the one being advertised, which is
the awkward kind of stale: a reader trusts a mechanism that is gone. My own
rule from this morning applies to my own commit — grep the claim, not the file.

IT IS NOT BLIND TO CODE COMMENTS, and that is worth saying because it is easy
to assume. Each block's body is LEXED, as
JavaScript or CSS, and its comment spans are collected; only then is the body
blanked, and only so the markup pass cannot misread its contents. A `/* */`
inside an inline <script> is found and removed like any other. What no build
stage can reach is markup that never exists as a file, which is the whole of
why the app's per-request passport pages need their comments fixed at the
renderer instead.

The same file records the precedent this follows: web/build.sh's header-parity
check, which learned that a thing it cannot read must be fatal rather than
skipped, after a header spelled slightly differently dropped out of a
comparison and took the count from 4 to 3 with the build still green.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import served_text as S                                    # noqa: E402


def main(argv):
    root = pathlib.Path(argv[1] if len(argv) > 1 else ".").resolve()
    deploy = "--deploy" in argv

    if not deploy:
        print("REFUSED: --deploy is required. This rewrites tracked source in "
              "place and there is no undo but git.")
        print("  It belongs in a deploy checkout, which Netlify throws away.")
        print("  If you want to SEE what it would remove without changing "
              "anything, run tools/check-served-clean.py instead: it reports "
              "every comment it finds and writes nothing.")
        print("  Earlier this refused only on a DIRTY tree, which protected "
              "unsaved work and left committed source open. That was backwards.")
        return 1

    try:
        files = S.served_files(root)
    except S.Refuse as e:
        print(f"REFUSED: {e}")
        return 1

    changed = removed = 0
    for path, syntax in files:
        # BINARY FILES ARE IN THE SERVED SET SO THE GATE CAN SCAN THEM FOR
        # IDENTIFIERS, and they are not text. Skipped here rather than filtered
        # out of served_files(), because dropping them from the set is exactly
        # the bug that let a PDF carrying /Users/<name>/ in its metadata go
        # unread by rule 2.
        if syntax == "binary":
            continue

        # EVERY FAILURE FROM HERE ON NAMES THE FILE. A review found that
        # `S.strip()` and the re-scan below sat outside the try, so an
        # ordinary commented-out <script> died with a five-frame traceback and
        # no path in it, and the deploy log pointed at this lexer instead of at
        # the page. The whole loop body is guarded now, including the read: a
        # mis-declared binary extension used to surface as a raw
        # UnicodeDecodeError from pathlib.
        try:
            src = path.read_text(encoding="utf-8")
            spans = S.comments(path, syntax, src)
            if not spans:
                continue
            out = S.strip(src, spans)
        except S.Refuse as e:
            print(f"REFUSED {path.relative_to(root)}: {e}")
            return 1
        except UnicodeDecodeError:
            print(f"REFUSED {path.relative_to(root)}: not valid UTF-8, but its "
                  "extension is classified as text in tools/served_text.py. "
                  "Move it to BINARY there, or fix the file.")
            return 1

        # THE ONLY BYTES THAT MAY DIFFER ARE THE SPANS. Asserted rather than
        # trusted: the arithmetic is cheap and it is the difference between
        # "the stripper removed the comments" and "the stripper removed
        # something". A stripper nobody checks is how a page loses a limb.
        #
        # `expected_length` is computed from the spans and the replacement
        # rule, not from the output, so it is an independent statement of what
        # the output must be rather than a restatement of what it is.
        want = S.expected_length(src, spans)
        if len(out) != want:
            print(f"REFUSED {path.relative_to(root)}: stripping changed "
                  f"{len(src) - len(out)} bytes where the comment spans "
                  f"account for {len(src) - want}. Not writing anything.")
            return 1

        # And it must be a fixed point: a second pass finds nothing. If it
        # does, the first pass created a comment out of two halves that were
        # not one, which is precisely the corruption being guarded against.
        try:
            again = S.comments(path, syntax, out)
        except S.Refuse as e:
            print(f"REFUSED {path.relative_to(root)}: stripping produced "
                  f"output this cannot re-read: {e}")
            return 1
        if again:
            print(f"REFUSED {path.relative_to(root)}: stripping produced "
                  f"{len(again)} NEW comment(s). Two fragments joined into "
                  "something that reads as a comment; the file would be wrong.")
            return 1

        path.write_text(out, encoding="utf-8")
        changed += 1
        removed += len(src) - len(out)
        print(f"  {str(path.relative_to(root)):46} -{len(src) - len(out)} bytes")

    print(f"stripped {removed} bytes of commentary from {changed} served file(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

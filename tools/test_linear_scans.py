#!/usr/bin/env python3
"""test_linear_scans.py: the capture-side scans are linear in a long run inside one line.

The Python half of web/tools/linear-time.test.mjs (2026-10-22). These scans
backtracked on a run inside one line, the same shapes the upload endpoint had
in V8:

  * id_core() in validate.py, ^[^A-Za-z0-9]+|[^A-Za-z0-9]+$, on a run of
    punctuation or blanks in one consent cell: 5.8 s of validate() at 8,000;
  * yaml_field_re() in validate.py, whose head ^[WS]*-?[WS]* puts two
    [WS]* side by side, on a line of blanks inside an input entry: 2.4 s;
  * HTML_TAG in validate.py and TAG in preflight.py, whose [^>]* ran to the
    end of a line of unclosed `<a ` once per tag;
  * the consent separator row test in scripts/passport-to-page.py, where
    three parts could share out one run of blanks, which is cubic;
  * PLACEHOLDER in scripts/passport-to-page.py, whose two [^<>]* overlap
    [ \\t];
  * collapse_money_spans() in validate.py, `[^`]*money\\.[^`]*` on a check 16
    refusal, whose second [^`]* ran to the end of an unclosed span from every
    `money.` in it.

So an owner's own machine hung on a passport the site was also slow on. Two
halves, as in the JavaScript file: EQUIVALENCE, the new code answers exactly
what the old regex answered, over generated strings and with the old regex
rebuilt here; and SCALING, the real functions at N and 4N units, warmed,
alternating, median of five, asserted on the ratio of what the run adds and
never on a millisecond ceiling. Prints LINEAR SCANS PASSED on success.
"""
import contextlib
import importlib.util
import io
import math
import os
import random
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import validate as v  # noqa: E402
import preflight as pf  # noqa: E402

_spec = importlib.util.spec_from_file_location("pg", os.path.join(ROOT, "scripts", "passport-to-page.py"))
pg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pg)

bad = []
EXAMPLE = open(os.path.join(ROOT, "examples", "daily-brief-passport.md"), encoding="utf-8").read()
LINES = EXAMPLE.split("\n")

# ---- EQUIVALENCE --------------------------------------------------------------

OLD_ID_TRIM = re.compile(r"^[^A-Za-z0-9]+|[^A-Za-z0-9]+$")
OLD_PLACEHOLDER = re.compile(r"^<[^<>]*[ \t][^<>]*>$")


def old_field_re(key, value=True):
    head = "^[%s]*-?[%s]*" % (v.WS_ANY, v.WS_ANY)
    tail = ":[%s]*([^%s]+)" % (v.WS_ANY, v.WS_BOTH) if value else ":[%s]*(?:#.*)?$" % v.WS_ANY
    return re.compile(head + re.escape(key) + tail)


def strings(seed, n, alphabet, longest=24):
    """The single characters and their simple neighbours, then random strings
    with runs in them, because a run is where it broke. Seeded, so a failure
    names an input that reproduces."""
    rnd = random.Random(seed)
    out = [""]
    for c in alphabet:
        out += [c, c + "a", "a" + c, "a" + c + "a", c * 3]
    while len(out) < n:
        s, want = "", rnd.randrange(longest)
        while len(s) < want:
            c = rnd.choice(alphabet)
            s += c * (1 + rnd.randrange(6)) if rnd.random() < 0.3 else c
        out.append(s)
    return out


ORDINARY = list("aZ09-_.#|`<>/=\"(:") + ["\u00e9", "\u4e2d", "\u200b", "\u180e", "\U0001F600", "\ud800", "\udc00"]
WS_CHARS = list(v.WS_ANY_CHARS)

for s in strings(20261022, 20000, WS_CHARS + ORDINARY):
    if v.id_core(s) != OLD_ID_TRIM.sub("", s):
        bad.append("id_core(%r) is %r, the old regex said %r" % (s, v.id_core(s), OLD_ID_TRIM.sub("", s)))
        break


# The head changed and nothing after it, so every reader built from it must
# match the same lines and capture the same value. Lines built in the shape
# the head reads, blanks, a dash or two, blanks, a key or a near miss, a colon,
# a value, as well as loose strings, or almost none of them reach the key.
def field_lines(seed, n, key):
    rnd = random.Random(seed)

    def ws():
        return "".join(rnd.choice(WS_CHARS) for _ in range(rnd.randrange(4)))
    out = []
    for _ in range(n):
        out.append(ws() + rnd.choice(["", "-", "-", "--", "x"]) + ws()
                   + rnd.choice([key, key, key[:-1], "x" + key]) + rnd.choice([":", ":", "", "::"]) + ws()
                   + rnd.choice(["", "x", "#", "# c", "credentialed", "\ufeff", "a b"]) + ws())
    return out


FIELD_ALPHABET = WS_CHARS + ["-", ":", "#", "x", "id", "access", "binding", "fidelity", "credentialed"]
for key in ("id", "access", "binding", "fidelity"):
    for value in (True, False):
        new, old = v.yaml_field_re(key, value), old_field_re(key, value)
        for s in field_lines(len(key), 5000, key) + strings(len(key) * 2 + value, 2000, FIELD_ALPHABET):
            a, b = new.match(s), old.match(s)
            if (a and (a.group(0), a.groups())) != (b and (b.group(0), b.groups())):
                bad.append("yaml_field_re(%r, %r) reads %r differently from the old head" % (key, value, s))
                break

for s in strings(7, 20000, ["<", ">", " ", "\t", "a", "-", "\u00a0", "\n"]):
    if bool(pg.PLACEHOLDER.match(s)) != bool(OLD_PLACEHOLDER.match(s)):
        bad.append("passport-to-page.py PLACEHOLDER disagrees with the old regex on %r" % s)
        break

# collapse_money_spans() is the old re.sub read once. Tokens rather than
# characters, with the case variants re.I reads and near misses, or almost no
# string holds a span with `money.` in it.
OLD_MONEY = re.compile(r"`[^`]*money\.[^`]*`", re.I)
MONEY_TOKENS = ["`", "`", "`", "money.", "MONEY.", "Money.", "mOnEy.", "money", "moneyx", "m", ".", "x", " ", "\t",
                "|", "\u00e9", "\u0130", "\U0001F600", "\ud800", "\udc00"]
collapsed = 0
for s in strings(19, 20000, MONEY_TOKENS, 48):
    want = v.clip_echo(v.collapse_bare_money(OLD_MONEY.sub("`money.*`", s)))
    if v.collapse_money_spans(s) != want:
        bad.append("collapse_money_spans(%r) is %r, the old regex said %r" % (s, v.collapse_money_spans(s), want))
        break
    collapsed += OLD_MONEY.search(s) is not None
else:
    if collapsed < 2000:
        bad.append("only %d strings had a money span to collapse, so the comparison compared almost nothing"
                   % collapsed)


# The tag scans, through the live functions: run each once with its regex
# wrapped so it ignores the new end position, which is the old full-line scan,
# and once as it is, and require the same output.
class FullLine:
    def __init__(self, rx):
        self.rx = rx

    def finditer(self, s, *_):
        return self.rx.finditer(s)


AT = next(i for i, l in enumerate(LINES) if l.startswith("Captured 2026")) + 1
TAGGY = ["<a", "<a ", "</b", '<p x="1"', "<i/", "<br>", ">", ">", ">", " ", " ", "\t", "=", '"', "x", "-",
         "1", "<", "/", "\u00a0", "\ufeff"]
rnd = random.Random(11)
compared = 0
for _ in range(300):
    line = "x " + "".join(rnd.choice(TAGGY) for _ in range(2 + rnd.randrange(12)))
    text = "\n".join(LINES[:AT] + [line] + LINES[AT:])
    for label, mod, name, run in (("validate.py", v, "HTML_TAG", v.untrusted_content),
                                  ("preflight.py", pf, "TAG", pf.check)):
        live = getattr(mod, name)
        setattr(mod, name, FullLine(live))
        try:
            old = run(text)
        finally:
            setattr(mod, name, live)
        if run(text) != old:
            bad.append("the %s tag scan reports %r differently when it stops at the last '>'" % (label, line))
    compared += bool(list(v.HTML_TAG.finditer(line)))
if compared < 100:
    bad.append("only %d tag probes held a tag, so the comparison compared almost nothing" % compared)

# The renderer's separator row, through consent_rows() itself:
# ^[ \t]*\|?[ \t:|-]+\|?[ \t]*$ became ^[ \t:|-]+$, so it must refuse (fail()
# exits) exactly the rows the old regex refused.
OLD_SEP = re.compile(r"^[ \t]*\|?[ \t:|-]+\|?[ \t]*$")
SEC2 = LINES[next(i for i, l in enumerate(LINES) if l.startswith("## 2.")):
             next(i for i, l in enumerate(LINES) if l.startswith("## 3."))]
SEP_AT = next(i for i, l in enumerate(SEC2) if l.startswith("|---|"))


def renders_rows(sec2):
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            pg.consent_rows(sec2)
        return True
    except SystemExit:
        return False


seen = set()
for s in strings(13, 300, [" ", "\t", ":", "|", "-", "x", "\u00a0", "\ufeff"]):
    row = "|" + s
    want = bool(OLD_SEP.match(row))
    if renders_rows("\n".join(SEC2[:SEP_AT] + [row] + SEC2[SEP_AT + 1:])) != want:
        bad.append("passport-to-page.py reads the separator row %r differently from the old regex" % row)
        break
    seen.add(want)
if seen != {True, False}:
    bad.append("the separator probes were all %r, so one side went untested" % seen)

# ---- SCALING ------------------------------------------------------------------

RATIO_MAX = 8
TARGET = 0.01   # seconds
SHORT = 6       # one `money.`


def seconds(f, x, reps):
    t = time.perf_counter()
    for _ in range(reps):
        f(x)
    return (time.perf_counter() - t) / reps


def medians(f, short, small, big):
    """Warmed, then a SHORT run, small and big ALTERNATE, five rounds, and each
    is the median of its five, so a slow patch on a shared machine lands on all
    three. Three rounds once a big run is over a second, which is not noise.
    Each timing is of as many calls as the small input needs to take TARGET:
    section_parts() and consent_rows() take a fraction of a millisecond, and a
    ratio of two readings that small is the clock's and not the code's."""
    for _ in range(3):
        f(short)
        f(small)
    reps = max(1, math.ceil(TARGET / max(seconds(f, small, 1), 1e-6)))
    z, a, b = [], [], []
    for i in range(5):
        z.append(seconds(f, short, reps))
        a.append(seconds(f, small, reps))
        b.append(seconds(f, big, reps))
        if i >= 2 and b[-1] * reps > 1:
            break
    return [sorted(x)[len(x) // 2] for x in (z, a, b)]


def growth(z, a, b):
    """How much what the RUN costs grew, as in the JavaScript file. z, the same
    input with a run of SHORT units, is what validating the passport around the
    run costs, and it was most of the small timing: spaces in one consent cell
    read x8.1 with every fix here put back, with x8 the limit. So z comes off
    both sides, and the run's cost at n is floored at z, so a difference of two
    nearly equal timings on linear code reads about x1 rather than a ratio made
    of noise."""
    return (b - z) / max(a - z, z)


def verdict(r):
    """What a result says, without the text the run changes: the check numbers
    of validate(), the codes of check(), the part kinds of section_parts(), or
    whether consent_rows() rendered."""
    if isinstance(r, bool):
        return r
    if isinstance(r, tuple):
        return [k for k, _ in r[0]], r[1]
    return [e.split(":")[0] if isinstance(e, str) else e[0] for e in r]


def place(after, line):
    i = next(k for k, l in enumerate(LINES) if after(l))
    return "\n".join(LINES[:i + 1] + [line] + LINES[i + 1:])


def in_cell(run):
    return EXAMPLE.replace("this is the briefing content", run, 1)


CASES = [
    # what, the function timed, the input at n units, n
    ("validate.py on `#` inside one backticked consent cell", v.validate,
     lambda n: in_cell("`x" + "#" * n + "y`"), 1500),
    ("validate.py on spaces inside one consent cell", v.validate,
     lambda n: in_cell("x" + " " * n + "y"), 1500),
    ("validate.py on U+2000 inside an input entry", v.validate,
     lambda n: place(lambda l: l.strip() == "access: credentialed", "\u2000" * n + "x"), 1500),
    ("validate.py on unclosed `<a ` in a section 4 paragraph", v.validate,
     lambda n: place(lambda l: l.startswith("Captured 2026"), "x" + ("<a " * n)[:n] + "y"), 3000),
    ("preflight.py on unclosed `<a ` in a section 4 paragraph", pf.check,
     lambda n: place(lambda l: l.startswith("Captured 2026"), "x" + ("<a " * n)[:n] + "y"), 4000),
    ("passport-to-page.py section_parts() on a never-closed `<` paragraph", pg.section_parts,
     lambda n: ["<a" + (" b" * n)[:n] + " c"], 20000),
    # Short, because the old renderer regex was CUBIC here, and a red run at
    # the sizes above would take hours.
    ("passport-to-page.py consent_rows() on a separator row of blanks", renders_rows,
     lambda n: "\n".join(SEC2[:SEP_AT] + [" " * n + "|x"] + SEC2[SEP_AT + 1:]), 150),
    # validate.py's own separator test strips the row first and was linear
    # already; pinned so it stays so.
    ("validate.py on a separator row of blanks", v.validate,
     lambda n: EXAMPLE.replace("|---|---|---|---|---|", "|" + " " * n + "x", 1), 1500),
    # A check 16 refusal, so the echo runs: an unclosed span of `money.` in
    # the Installable cell of an installable row.
    ("validate.py on `money.` in an unclosed span of the Installable cell", v.validate,
     lambda n: EXAMPLE.replace("there is no briefing | yes |",
                               "there is no briefing | yes `" + ("money." * n)[:n] + " |", 1), 12000),
]
for what, f, make, n in CASES:
    short, small, big = make(SHORT), make(n), make(4 * n)
    if verdict(f(short)) != verdict(f(big)):
        bad.append("%s: the short run must take the path the long one takes" % what)
        continue
    z, a, b = medians(f, short, small, big)
    g = growth(z, a, b)
    if g >= RATIO_MAX:
        bad.append("%s: %.2f ms at %d units, %.2f ms at %d and %.2f ms at %d, so the run's cost grew x%.1f "
                   "when the run grew x4 (linear is at most x4, quadratic x16)"
                   % (what, a * 1000, n, b * 1000, 4 * n, z * 1000, SHORT, g))

for b in bad:
    print("LINEAR: " + b, file=sys.stderr)
if bad:
    sys.exit(1)
print("LINEAR SCANS PASSED: id_core, yaml_field_re, the two tag scans, PLACEHOLDER, the separator row and the money echo "
      "answer as before, and %d scans stay linear" % len(CASES))

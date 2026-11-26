#!/usr/bin/env python3
"""test_paste_budget.py - the one-paste installer block must not outgrow its budget silently.

The site hands a stranger ONE block to paste: the passport with the installer core, the
judge prompt and one platform branch in section 5 (web/assets/passport.js, the same join
scripts/assemble.py performs). It has to fit the context window of whatever assistant it
lands in, and the windows at risk are the small ones, ChatGPT's instant models and local
models, not Claude Code's. Between v0.1 (2026-08-07) and 2026-10-22 the four blocks grew
32-66% each and nothing failed, while the README number meant to watch them went stale.

So: assemble the reference passport once per branch, with assemble.py itself, and fail if
any block is over its ceiling below. The table it prints (bytes, KB, rough tokens) is where
README.md's "Paste budget" numbers come from. Refresh them from this, not from some other
measurement: the README once compared thousands of characters with KiB and called it growth.

Stdlib only. Exit 0 when every branch is under its ceiling, 1 otherwise.
"""
import os
import subprocess
import sys
import tempfile

# Resolved from this file, the way assemble.py resolves its own root, so run_tests.sh can
# copy the tree with one branch padded to its ceiling and one byte past it, and check that
# this passes on the first and fails on the second.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The passport the CI passport job already assembles and validates (checks.yml). Which
# passport is THE reference for the budget was still an open question when the project
# was archived; changing it means re-measuring every ceiling below.
REFERENCE = "examples/daily-brief-passport.md"

# UTF-8 bytes of the assembled block with LF endings, which is what the site serves and
# its copy button counts. Each is the size on 2026-10-22 (b173546) plus about 3%, rounded
# up to the next 100.
#
# RAISING ONE IS A DECISION, NOT A FIX. When this fails, trim first (README.md "Paste
# budget": trim the branch, not the losses table or the consent step). If the growth is
# wanted, raise the number in a commit of its own that says why, and refresh README.md
# from this script's output. Trim-or-raise was still unanswered when the project was archived.
CEILINGS = {
    "chatgpt":     79_300,   # 76,904 B on 2026-10-22
    "claude-ai":   72_900,   # 70,773 B
    "claude-code": 82_000,   # 79,561 B
    "generic":     63_200,   # 61,335 B
}

# A rule of thumb, not a tokenizer: about four bytes a token for English prose and markdown,
# the same rule as the README's old "call it 20,000 tokens" for 77.4 KB. Good enough to set
# against a context window, not to quote to the token.
BYTES_PER_TOKEN = 4


def measure(branch, workdir):
    """Bytes of the block assemble.py writes for one branch, or (None, why)."""
    out = os.path.join(workdir, branch + ".md")
    r = subprocess.run(
        [sys.executable, os.path.join(ROOT, "scripts", "assemble.py"),
         os.path.join(ROOT, REFERENCE), out, "--branch=" + branch],
        capture_output=True, text=True)
    if r.returncode != 0:
        return None, (r.stderr or r.stdout).strip()
    with open(out, "rb") as f:
        data = f.read()
    # An assemble.py that writes in text mode (main's, on 2026-10-22) sends every "\n"
    # out as "\r\n" on Windows. Undo exactly that, a no-op once it writes LF: a Windows
    # run would read about 1% high, and the margin here is 3%.
    if os.linesep != "\n":
        data = data.replace(os.linesep.encode("ascii"), b"\n")
    return len(data), None


def main():
    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    import assemble

    branches = [f[:-3] for f in assemble.BRANCH_ORDER]
    problems = []
    for b in branches:
        if b not in CEILINGS:
            problems.append("%s has no ceiling. A new branch gets one deliberately, "
                            "at its measured size plus the same margin" % b)
    for b in CEILINGS:
        if b not in branches:
            problems.append("%s has a ceiling but assemble.py has no such branch; remove it" % b)

    print("paste budget: %s assembled once per branch (KB = 1,024 B, tokens ~ B/%d)"
          % (REFERENCE, BYTES_PER_TOKEN))
    print("   %-12s %8s %7s %8s %8s %9s"
          % ("branch", "bytes", "KB", "~tokens", "ceiling", "headroom"))
    with tempfile.TemporaryDirectory() as tmp:
        for b in branches:
            size, why = measure(b, tmp)
            if size is None:
                problems.append("%s did not assemble: %s" % (b, why.replace("\n", " ")[:200]))
                continue
            ceiling = CEILINGS.get(b)
            print("   %-12s %8s %7.1f %8s %8s %9s"
                  % (b, "{:,}".format(size), size / 1024,
                     "{:,}".format(size // BYTES_PER_TOKEN),
                     "{:,}".format(ceiling) if ceiling else "-",
                     "{:,}".format(ceiling - size) if ceiling else "-"))
            if ceiling and size > ceiling:
                problems.append("%s is %s bytes, %s over its ceiling of %s"
                                % (b, "{:,}".format(size), "{:,}".format(size - ceiling),
                                   "{:,}".format(ceiling)))
            elif ceiling and size < ceiling * 0.94:
                # Twice the margin the ceilings were set with: the branch was trimmed, and
                # until the ceiling follows it the trim can grow back unnoticed.
                print("   note: %s is %d%% under its ceiling; if it was trimmed, lower the "
                      "ceiling so the trim holds" % (b, round(100 * (1 - size / ceiling))))

    # What every block shares, so whoever trips a ceiling can see whether the branch or
    # the common part grew. The core alone went 8,842 -> 29,132 B since v0.1.
    core = assemble.resolve("core")
    judge = assemble.judge_prompt() or ""
    with open(os.path.join(ROOT, REFERENCE), "rb") as f:
        passport_n = len(f.read().replace(b"\r\n", b"\n"))
    if core:
        print("   in every block: installer core %s B, judge appendix %s B, passport %s B"
              % ("{:,}".format(len(assemble.read(core).rstrip().encode("utf-8"))),
                 "{:,}".format(len(judge.encode("utf-8"))), "{:,}".format(passport_n)))

    for p in problems:
        print("BUDGET: " + p, file=sys.stderr)
    if problems:
        print("   Trim first (README.md, \"Paste budget\"). If the growth is wanted, raise "
              "CEILINGS in tools/test_paste_budget.py in a commit that says why; that is a "
              "decision, not a fix.", file=sys.stderr)
        return 1
    print("   every branch is under its ceiling")
    return 0


if __name__ == "__main__":
    sys.exit(main())

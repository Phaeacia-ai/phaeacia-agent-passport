#!/usr/bin/env python3
"""Fail the build when create.html's step 4 list and SKILL.md's step 0 disagree.

This is ROW-104. The install block on /create tells a reader to run an `ls -d` over
the skill folder and confirm every path comes back. That list is the SAME list as
the skill's own preflight in SKILL.md step 0, copied into a second file, in HTML,
rephrased for a stranger, with nothing holding the two together.

WHY THIS IS WORSE THAN AN ORDINARY DUPLICATE. The block tells the reader to flag
anything unexpected. If the skill grows a twelfth entry and this page still says
eleven, a reader with a WHOLE folder is told to report it as wrong, and the check
that was supposed to protect them becomes the thing that misleads them. A stale
completeness list is worse than no completeness list, because it fails in the
direction the reader trusts.

WHAT IT ALREADY COST, WHICH IS WHY THIS EXISTS RATHER THAN A COMMENT SAYING
"KEEP THESE IN SYNC". On 2026-08-31 the list moved twice in one day: seven to ten
in 69d2025, ten to eleven in b18de24. The page was corrected both times. The
PARAGRAPH IN THE PAGE'S OWN HEADER COMMENT WARNING ABOUT EXACTLY THIS was not
corrected the second time, so a warning that said "if the preflight grows an
eleventh entry, this block tells the reader to expect ten" sat five lines above a
block that already said eleven, still saying "ten" four times. A critic found it.
The author of both had read the comment twice that day.

That is the argument against signposts. A signpost is prose, prose is not checked,
and prose about a coupling drifts on exactly the same schedule as the coupling.

CHECKS BOTH TWINS, NOT JUST create.html, SINCE 2026-09-16 (backend/row-html-twins-check).
This started reading create.html only, on the reasoning that index.html and
create.html are proven byte-identical (except one og:url line) by
tools/check-html-twins.py, so checking one checks both transitively. HAL asked
whether that transitive argument was good enough to leave as-is, with a one-line
docstring note naming the dependency, or whether this should read both files
directly. Decided: read both directly. The transitive argument is real but makes
this checker silently depend on check-html-twins.py continuing to exist, running
first, and staying scoped to these same two files -- a dependency nothing records
at the point where it would break. check-comment-balance.py already made the
opposite call for the same reason, after ROW-122: its own docstring at line 50
explains why it checks every .html file and not just create.html. One checker
having learned this and the other not is exactly the "guard whose precondition
lives in another file" pattern
(record/findings/a-guard-whose-precondition-lives-in-another-file.md): this file
read correctly on its own, and was still wrong, because the fact that made it
correct lived in a sibling file this one never opens. Cost of checking both
directly: negligible, since SKILL.md's list is read once and compared against
each page in turn.

WHAT THIS CHECKS AND WHAT IT CANNOT.

It compares the two lists as ORDERED SEQUENCES OF PATHS, so it catches an addition,
a removal, a rename and a reordering. It says nothing about whether either list is
right: if SKILL.md itself omits a file the skill needs, both sides agree and this
passes. That already happened. SKILL.md's own note records it: "A completeness
check that protects step 10 and omits step 10's own inputs is not a check, and it
stayed wrong twice because the list was extended by reading rather than by running
the thing it protects." This checker inherits that limit exactly. It makes the two
lists agree; making them CORRECT is what running assemble.py does.

It also does not read the prose count ("the eleven things"). That number is checked
here only because it must equal the length of the list, which is the one thing about
a count that a machine can settle. See
record/findings/a-count-in-prose-is-an-unchecked-assertion.md.

NOT WIRED INTO build.sh YET, AND THE REASON IS THE FIRST THING IT FOUND.

It reads SKILL.md out of the SAME CHECKOUT as the page, which is the only honest
place to read it from: a checker that reaches past its own tree to a branch that is
not deployed is not checking the thing that ships. Run inside
`frontend/real-create-blocks` on 2026-08-31 it fails, and it is right to. That
branch is 23 commits behind main. Its page says eleven, correctly, because 23a11de
updated it "following b18de24" - a commit on MAIN that this branch does not
contain. Its own SKILL.md still says seven.

So the page is correct against a file that is not in the same tree as the page, and
the two only agree after the merge to main. That is a real property of the branch,
not a bug in this checker, and it is exactly the coupling ROW-104 is about showing
up one repository closer to home than anybody was looking.

Wire it in Act 2, after the merge, with one line beside the route table in
build.sh:

    echo "── preflight list"
    python3 tools/check-preflight-list.py

Wiring it before the merge makes the branch's own build fail, which is a true
result nobody can act on until the merge happens.

Pass a path as argv[1] to check against a different checkout's SKILL.md, which is
how the lists were confirmed identical against main before this file existed.
"""

import html
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
# Both twins, not create.html alone -- see the module docstring's
# "CHECKS BOTH TWINS" section for why this stopped relying on
# check-html-twins.py to make checking one enough.
PAGES = [HERE.parent / "index.html", HERE.parent / "create.html"]
SKILL = (
    Path(sys.argv[1])
    if len(sys.argv) > 1
    else HERE.parent.parent / "skills" / "agent-passport" / "SKILL.md"
)

WORDS = {
    1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven",
    8: "eight", 9: "nine", 10: "ten", 11: "eleven", 12: "twelve", 13: "thirteen",
    14: "fourteen", 15: "fifteen", 16: "sixteen", 17: "seventeen",
}


CURRENT_PAGE = None  # set per iteration in main() so die() names which twin failed


def die(msg):
    label = f"{CURRENT_PAGE}: " if CURRENT_PAGE else ""
    print("preflight list: " + label + msg, file=sys.stderr)
    sys.exit(1)


def page_list(text):
    r"""The paths in the block's `ls -d` command, in order.

    THE SKILLS DIRECTORY IS A WILDCARD HERE, AND THAT IS THE POINT OF ROW-130.
    This pattern was anchored on the literal `cd ~/.claude/skills/agent-passport`
    until 2026-09-01, and it exited 1 the moment the install block stopped naming
    one product's load path. The block now asks the reader's agent where it keeps
    skills and calls that SKILLS, so the leading directory is whatever the block
    says today and this check must not care.

    THE FIRST VERSION OF THIS FIX USED \S* AND WAS GENUINELY WEAKER, WHICH IS
    WHAT A CRITIC PROVED AFTER I HAD WRITTEN THAT IT WAS NOT. \S* matches the
    empty string and matches a suffix, so `cd agent-passport`, `cd
    notagent-passport` and `cd ~/x/totally-wrong-agent-passport` all passed. The
    docstring claimed it anchored on the last segment and it anchored on a
    suffix of one. \S+/ requires a real directory and a real separator, so the
    last segment must now actually be agent-passport.

    What it anchors on is the part that carries the meaning: the folder's
    last segment must be agent-passport, because the skill declares that name and
    the format requires the two to match, and the command must be `ls -d`. Those
    are the things whose change should break this check. The path in front of them
    is not.

    ONE CORRECTION TO A CORRECTION, AND THEN READ THE MODULE DOCSTRING INSTEAD.
    The first version of this comment said a deploy would have failed on the
    regex break. It would not: nothing calls this file. I then wrote that I had
    discovered that by running it. I had not. THE MODULE DOCSTRING ALREADY SAID
    SO, in capitals: "NOT WIRED INTO build.sh YET, AND THE REASON IS
    THE FIRST THING IT FOUND", with a real reason and a stated trigger for
    wiring it in. That paragraph is the account of record. Mine restated its
    conclusion as a fresh discovery and dropped its reason, which would have left
    two stories in one docstring: one saying the wiring was an oversight and one
    saying it was a decision. It was a decision.

    The useful residue is one sentence and it is not about this file: an exit
    code is not a gate, the thing that calls it is, and I inferred the first from
    the second without reading the module docstring of the file I was editing.
    """
    m = re.search(
        r"cd \S+/agent-passport &amp;&amp; ls -d (.*?)\n\s*\n",
        text,
        re.S,
    )
    if not m:
        die(
            "could not find the `ls -d` completeness command in create.html.\n"
            "  It is the one inside the path F block, under 'STEP 4'. If the block was\n"
            "  reworded, fix this pattern rather than deleting the check."
        )
    return [t for t in html.unescape(m.group(1)).split() if t != "\\"]


def page_count_word(text):
    m = re.search(r"confirm the ([a-z]+) things the skill checks for itself", text)
    if not m:
        die(
            "could not find the 'confirm the N things the skill checks for itself'\n"
            "  sentence in create.html. That wording is load-bearing: it is what tells a\n"
            "  reader the two lists are meant to be the same list."
        )
    return m.group(1)


def placeholder_drift(text):
    """The block names its skills folder once and uses that name; check they agree.

    THIS IS THE HAZARD ROW-130 CREATED AND DID NOT CLOSE. Before ROW-130 the block
    printed a literal `~/.claude/skills`, so there was nothing to keep consistent.
    It now says "call the folder SKILLS below" and then uses SKILLS in six more
    places, which is a seven-way coupling inside one file with nothing holding it
    together. Rename the declaration and leave one use behind, or rename six uses
    and leave the declaration, and the reader's agent is handed a block that
    defines one name and issues commands against another.

    A CRITIC FOUND THIS AND THE SAME COMMIT THAT CREATED IT WIDENED THE ONE CHECK
    THAT MIGHT HAVE CARRIED IT. The `ls -d` regex in page_list deliberately stops
    caring what the leading directory is called, which is correct for its own job
    and is exactly why it cannot see this. The two checks want opposite things
    from the same string, so they are two checks.

    WHY A COUNT WOULD NOT DO. The obvious check is "SKILLS appears seven times".
    It passes the mutation that actually worries me: `cd SKILLSDIR/agent-passport`
    still contains the substring SKILLS, so a count still reads seven and a
    reader's agent still cds into a folder the block never defined. So this
    compares TOKENS with boundaries, not occurrences, and it does not hardcode
    seven. A hardcoded seven is a count in prose with a `==` in front of it, and
    record/findings/a-count-in-prose-is-an-unchecked-assertion.md is about
    precisely that.

    It checks three things and none of them is the number:
      1. every `X/agent-passport` inside the block has X equal to the declared name
      2. every `NAME/<segment>` has that segment equal to agent-passport, which is
         the same coupling read from the other end
      3. no token in the block starts with the declared name and continues, which
         is the SKILLSDIR shape and the one a substring test cannot see

    RULE 2 WAS MISSING AND A CRITIC FOUND IT BY MUTATING WHAT I HAD NOT. Rule 1
    reads the folder and assumes the last segment; rule 2 reads the last segment
    and assumes the folder. Only the pair is closed. The mutation that proves it
    is `git clone ... SKILLS/passport` while the five later commands still say
    `SKILLS/agent-passport`: rule 1 sees a correct `SKILLS/agent-passport` on every
    line it looks at, a substring count still reads seven, a word-boundary count
    still reads seven, and the reader clones into one folder and cds into another.
    That is the only drift in this set that actually strands somebody, and it was
    the one case my first version could not see.
    """
    m = re.search(r'<(?:pre|div)\b[^>]*\bid="path-f-block"[^>]*>(.*?)</(?:pre|div)>', text, re.S)
    if not m:
        die(
            "could not find the path F install block (pre#path-f-block) in\n"
            "  create.html. If the block moved or was renamed, fix this selector rather\n"
            "  than deleting the check: it is the only thing holding the block's folder\n"
            "  placeholder consistent with itself."
        )
    block = html.unescape(m.group(1))

    names = re.findall(r"call the folder (\S+) below", block)
    if len(names) != 1:
        die(
            f"expected exactly one 'call the folder X below' sentence in the block, found\n"
            f"  {len(names)}. That sentence is the block's only definition of where it is\n"
            "  writing. Without it, or with two of them, the commands below name a folder\n"
            "  the reader was never told about."
        )
    name = names[0]
    if not re.fullmatch(r"[A-Z][A-Z0-9_]*", name):
        die(
            f"the block calls its skills folder {name!r}, which does not read as a\n"
            "  placeholder. It has to be visibly not-a-path, or a reader's agent will try\n"
            "  to cd into it literally."
        )

    used = sorted(set(re.findall(r"([A-Za-z0-9_~./$-]+)/agent-passport", block)))
    wrong = [u for u in used if u != name]
    if wrong:
        die(
            f"the block defines its skills folder as {name} and then writes "
            + ", ".join(f"{w}/agent-passport" for w in wrong)
            + ".\n  Every command in the block has to use the name the block declared. Fix\n"
            "  whichever side is wrong; they cannot both be right."
        )

    segs = sorted(set(re.findall(re.escape(name) + r"/([A-Za-z0-9_.-]+)", block)))
    wrong_seg = [s for s in segs if s != "agent-passport"]
    if wrong_seg:
        die(
            f"the block writes {name}/" + f", {name}/".join(wrong_seg) + ".\n"
            "  Every path under the declared folder has to end in agent-passport, because\n"
            "  the skill declares that name and the format requires the folder to match it.\n"
            "  This is the drift that actually strands a reader: a clone destination that\n"
            "  disagrees with the four later commands clones to one folder and cds into\n"
            "  another, and every check that counts occurrences of the placeholder still\n"
            "  reads the same number."
        )

    drifted = sorted(set(re.findall(r"\b" + re.escape(name) + r"[A-Za-z0-9_]+", block)))
    if drifted:
        die(
            f"the block defines {name} and also contains " + ", ".join(drifted) + ".\n"
            "  One of those is a rename that did not finish. A check that counted\n"
            f"  occurrences of {name} would pass this, which is why this one does not."
        )

    return name, len(re.findall(r"\b" + re.escape(name) + r"\b", block))


def skill_list(text):
    """The paths in SKILL.md step 0's completeness check, in order."""
    lines = [l for l in text.split("\n") if "Confirm all " in l and " exist" in l]
    if len(lines) != 1:
        die(
            "expected exactly one 'Confirm all N exist' line in SKILL.md step 0, found "
            f"{len(lines)}."
        )
    paths = re.findall(r"`([^`]+)`", lines[0])
    return [re.sub(r"^\$SKILL_DIR/", "", p) for p in paths]


def check_page(page_path, skill_text, want):
    global CURRENT_PAGE
    CURRENT_PAGE = page_path.name

    page_text = page_path.read_text(encoding="utf-8")
    got = page_list(page_text)

    if got != want:
        only_page = [p for p in got if p not in want]
        only_skill = [p for p in want if p not in got]
        detail = []
        if only_skill:
            detail.append("  in SKILL.md and NOT on the page: " + ", ".join(only_skill))
        if only_page:
            detail.append("  on the page and NOT in SKILL.md: " + ", ".join(only_page))
        if not detail:
            detail.append("  same paths, different order")
            detail.append("  page:  " + " ".join(got))
            detail.append("  skill: " + " ".join(want))
        die(
            f"{page_path.name} step 4 and SKILL.md step 0 disagree (ROW-104).\n"
            + "\n".join(detail)
            + "\n  Fix the PAGE to match the skill, not the other way round: the skill is\n"
            "  what actually runs. Update the `ls -d` list, the 'confirm the N things'\n"
            "  wording, and the header comment that talks about the count."
        )

    word = page_count_word(page_text)
    expected = WORDS.get(len(want))
    if expected is None:
        die(
            f"the list has {len(want)} entries and this checker has no word for that.\n"
            "  Add it to WORDS."
        )
    if word != expected:
        die(
            f"the page says 'the {word} things the skill checks for itself' and the list\n"
            f"  has {len(want)} entries, so it should say '{expected}'."
        )

    return placeholder_drift(page_text)


def main():
    if not SKILL.exists():
        die(
            f"{SKILL} does not exist.\n"
            "  This check reads the skill from the repo one level up from web/. If the\n"
            "  repo moved, that is the thing to fix; a missing skill is not a pass."
        )
    for page_path in PAGES:
        if not page_path.exists():
            die(f"{page_path} does not exist.")

    skill_text = SKILL.read_text(encoding="utf-8")
    want = skill_list(skill_text)

    results = [(p.name, *check_page(p, skill_text, want)) for p in PAGES]

    print(
        f"preflight list: {len(want)} paths, {' and '.join(PAGES[i].name for i in range(len(PAGES)))} "
        "step 4 and SKILL.md step 0 agree, on both twins"
    )
    print("  order is checked; whether the list is CORRECT is not, and cannot be here")
    for page_name, name, uses in results:
        print(
            f"  {page_name} block placeholder: {name}, {uses} uses, all agreeing; the NAME\n"
            "  is checked and whether the reader's agent can resolve it is not, and cannot\n"
            "  be here"
        )


if __name__ == "__main__":
    main()

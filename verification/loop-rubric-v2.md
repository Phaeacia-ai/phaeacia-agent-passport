# Capture-loop rubric v2 — frozen 2026-08-10

Scoring criteria for the automated skill-improvement loop. Supersedes
v1, against which rounds 1 to 5 were scored. Neither v1 nor the loop's own
run reports are part of this repository. The critic scores against this file and nothing else; a criterion not
listed here is out of scope, however tempting. Changing this file mid-loop
invalidates the loop's stop condition.

## Why there is a v2

v1 scored the passport. It had no criterion for anything the owner actually
sees, so the first live run passed every dimension while reading, to the owner,
as a wall of developer-facing text: schema words in the questions, the whole
check-in delivered as prose, and more of it than anyone would read. Under v1 that
was `cosmetic`, and cosmetic findings never drive a skill edit, so the loop could
not have found it and did not. v2 adds dimension 9 and a severity class that lets
it bite. Dimensions 1 to 8 are unchanged in substance; 6 is rewritten to the new
cap and the new delivery.

## Setup per round

Three agents, structurally different on purpose: `newsletter` (prose brief),
`jobscan` (scheduled scraper, accumulating store), `linkedin` (analytics
pipeline). Captures run without an owner present: the check-in is not answered,
the passport stays `owner_confirmed: false`, and the capture records the check-in
verbatim as it would have been shown, which per SKILL.md step 7 means the summary
text and then both pop-ups with every question, its header and its options. The
critic gets the passport, that recorded check-in, the capture's own chat
transcript, and read access to the agent's actual folder. The deny list from
SKILL.md step 1 binds the critic exactly as it binds the capture.

The transcript is new in v2 and dimension 9 cannot be scored without it: what the
owner had to read is not visible in the passport.

## The nine dimensions, scored 1 to 5

1. **Fidelity.** Every filled spec field checked against the files. A field the
   files contradict is a finding with both sides quoted. A confessed unknown
   tagged `low` is honest, not a finding.
2. **Slot discipline.** No value that belongs to the owner (locations, beats,
   sources, times, names, thresholds tuned to taste) appears as a field value.
   Each such value is a personal slot with a usable question and a safe default.
   A leak is a finding; a missing slot is a finding.
3. **Scrub.** No secrets, no personal identifiers, no third-party names in any
   passport text, golden examples included. Slot-bound structure in examples is
   marked as such per SKILL.md step 5.
4. **Comparison mode.** Correct for the agent's actual shape: changing output by
   design → `structural`; same input, same output → `exact`; depends on private
   data → `input_relative`. Habit-`structural` on a non-structural agent is a
   finding, per the generality test.
5. **Verification checks.** Two to four, each checkable by a model holding only
   the first-run output, about shape, counts, freshness and inputs-read, never
   content. An uncheckable or content-bound check is a finding.
6. **Question quality. Four in total, the goal check included, delivered as one
   exchange.** The ceiling is four because the check-in is one exchange and not
   a series, which is a fact about the owner's attention rather than about any
   tool's limit; a capture that splits the check-in into rounds fails this
   dimension even if each round is short. Both capture paths are held to the
   same four, so an owner is not asked more questions because of which path
   captured their agent.

   The goal check is first, always asked, and is a yes or no whose second
   option carries its cost ("No, and here is what it actually does", not a bare
   "No"). Handing the goal back and asking which part is wrong is the old shape
   and is now a finding: it assumes an error and invites a rewrite of a sentence
   that was fine.

   At most three more, and each must have survived the three-test gate, which
   deletes a candidate outright rather than rewording it: the answer is already
   a personal slot, the question is about the owner's environment rather than
   the agent, or the files already answer it. This gate replaces the older
   low-or-install-breaking-medium rule rather than sitting beside it, and a
   capture applying both is applying neither. A surviving question must still be
   phrased so yes or no cannot answer it. **Zero extra questions is legitimate
   and common**; padding toward three is a finding, and fewer is never worse.
7. **Install sufficiency.** Could a competent assistant, holding only the
   passport (spec, slots, tacit notes, examples) plus the installer texts, build
   a faithful copy without inventing anything? Every invention it would be
   forced into is a finding. In the final gate this is tested by an actual
   dry install, not imagined.
8. **Envelope honesty.** Write capabilities are `declared_only`. What cannot
   survive read-and-notify is said loudly, not quietly reshaped into something
   installable. Said in the owner's words at the check-in, not in the schema's.
9. **The owner's side.** Scored against the transcript and the recorded
   check-in, never against the passport. Five things, any one of which is a
   finding on its own:
   - **Register.** Nothing the owner sees names a field, a capability id,
     `comparison_mode`, `declared_only`, `tacit_notes`, a confidence tag, or the
     words "slot", "capture" or "envelope". Every question is answerable by
     someone who has never opened the code. A question that reads as though it
     were written for the maintainer of a published tool, rather than for the
     person who built this one for themselves, is a finding even when it is
     technically answerable.
   - **Delivery.** Where the capture environment has a structured question tool,
     everything with candidate answers arrives as a pop-up with two to four
     options and a header of at most twelve characters, and a question delivered
     as prose instead is a finding. Two exceptions are not: the one question with
     no candidate answers at step 0, and a capture path that has no such tool at
     all, which asks in prose and is scored on the questions rather than the
     mechanism. Everywhere, options are candidate answers in the owner's own
     words, not "yes / no / not sure", never an option the owner would have to
     open the code to choose between, and no hand-written "Other".
   - **Volume.** The summary is five short lines and about eighty words, plus
     the slot line, plus the declared-only line where the agent earns one.
     Count what the owner would have read before the first pop-up; over the cap
     is a finding, and so is a summary sentence that would be equally true of
     any other agent.
   - **Silence.** Nothing addressed to the owner between step 0 and the
     check-in, and nothing between the check-in and the handover: no step
     announcements, no inventory listings, no findings narrated on the way, and
     no passport text pasted into the chat at any point.
   - **Handover.** Step 10 closes in three lines: where the passport is, where
     the page is, what to do with it.

## Severity, defined once

- `breaks_install`: an installer following the passport builds the wrong agent
  or none.
- `degrades_output`: the agent builds but the output measurably misses the
  original's shape, register or coverage.
- `fails_the_owner`: the passport is right and the owner's side is not. Any
  dimension 9 finding, and any dimension 6 finding about a wasted or padded
  question. New in v2, and it exists for one reason: these defects are invisible
  in the artifact, so under v1's three classes they landed in `cosmetic` and were
  barred from driving an edit. They drive edits now.
- `cosmetic`: everything else. Cosmetic findings never drive skill edits alone.

## What the critic produces

Per agent: the nine scores; findings with severity, the passport's claim and the
files' contradiction quoted, or for dimension 9 the offending text quoted from
the transcript with the cap or rule it broke; and for each finding the defect in
SKILL.md that allowed it plus the smallest edit that would have prevented it. The
critic proposes; it never edits.

## Edit discipline, for the editor between rounds

Only findings at `breaks_install`, `degrades_output` or `fails_the_owner`
justify a skill edit. An edit must be justified against all three agents, not
one: a rule that fixes the scraper and bloats the brief is rejected. Prefer
deleting or tightening an existing instruction over adding a new one; the failure
mode of critic-driven editing is rule bloat, and SKILL.md is already long enough
that its edges degrade. A `fails_the_owner` fix that adds more instruction than
it removes should be looked at twice: the defect is usually a missing cap or a
banned word, not a missing paragraph. Every round: rebuild, run the test suite,
commit, so a regressing round can be reverted whole.

## Stop condition

Two consecutive rounds with zero findings at `breaks_install`,
`degrades_output` or `fails_the_owner` across all three agents, then one final
gate: a dry install from each passport (generic branch, no real connectors)
whose built instruction text the critic scores against dimension 7. Hard cap:
four editing rounds plus the gate. "The critic is impressed" is not a stop
condition; the counts are.

## What this loop cannot prove

Generality beyond these three agents. It also cannot prove the owner's side,
only its absence of stated defects: an owner-less capture has nobody to be
confused by a question that is well formed and still misses the point, and
nobody to answer the goal check wrong. Dimension 9 measures the shape of the
check-in, not whether it worked. Run 5 of the generality test (a stranger's
agent, stranger present) stays the final exam; wall-clock and the amount the
owner had to read are recorded on the scoring sheet there, and are tracked
numbers rather than pass conditions.

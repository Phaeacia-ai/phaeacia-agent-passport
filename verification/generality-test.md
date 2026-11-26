# The generality test v0.1

A runnable procedure for the builder. Not a prompt, not something an agent executes on its own.

This is the method as it was written during development. No results of it are published in this repository, and the project is archived, so it is here as a procedure you can run yourself.

## Premise

The capture skill is only done when it produces correct passports for agents it was not written against.

Everything up to that point is calibration. A capture procedure written while staring at one agent will encode that agent: its file layout, its vocabulary, its idea of what a "section" is. The procedure will look general and be specific, and the only way to tell the difference is to point it at agents whose shape it has never seen and see whether it still asks the right questions.

The test is adversarial toward our own work. It is designed so that the comfortable outcome (it worked, small tweak, moving on) is not available.

## What is under test

`skills/agent-passport/SKILL.md` and everything it references: the capture procedure, the check-in, the scrub gate, the functional spec schema as filled in practice, and the capture-time generation of `comparison_mode` and the `verification:` checks.

Not under test: the installer, the branches, the site. Those have their own failures and their own tests. A generality run does include one install, because a passport that validates but cannot be installed is not a correct passport, but install-side breakage is logged separately from capture-side breakage.

## The test set, in order

Run them in this order. The order matters: it goes from known to unknown, and from your environment to someone else's.

**Run 1. The daily brief agent. Calibration.**
The agent the skill was written against. It should pass. If it does not, the skill is broken outright and there is nothing to generalise from yet. Fix it, then start the set at run 1 again. Run 1 passing proves nothing about generality; it proves the harness is measuring something.

**Run 2. The analytics pipeline agent, same machine.**
Referred to by role, not by path: the agent on this machine whose job is periodic data pull, transform, and report. Structurally different from the brief in the ways that matter: its output is tabular rather than prose, its inputs are credentialed rather than open web, and its `comparison_mode` should come out `exact` or `input_relative` rather than `structural`. If capture calls it `structural` out of habit, that is a finding, not a rounding error.

**Run 3. The scraper agent, same machine.**
Again by role: the agent that fetches from a site on a schedule and accumulates results. It stresses different parts of the schema: `schedule.run` as genuinely core rather than nice-to-have, an output that is a growing store rather than a message, and a real chance that the honest answer is "most of this does not survive the read-and-notify envelope". A passport that says so loudly is a pass. A passport that quietly reshapes the agent into something installable is a failure.

**Run 4. A browser-built agent, capture path W.**
One custom GPT or one claude.ai Project, captured through the interview path with no filesystem access. This is the path with the weakest evidence base, so expect the correction count to jump. The question is not whether it is worse than path F. It will be. The question is whether the corrections cluster in a way the procedure could ask about.

**Run 5. An agent belonging to a different person.**
Someone else's agent, captured with them, on their machine or in their browser. This is the only run that tests whether the procedure works without your tacit knowledge filling the gaps. Their corrections at the check-in are the single most valuable data point in the whole test set, because you cannot unconsciously supply the right answer on their behalf.

## Pass criteria

**Zero edits to `SKILL.md` between run 1 and run 5.** That is the criterion. An edit means the procedure was specific to the last agent it saw, which is exactly the failure mode being tested for.

This is stated so it cannot be fudged, because it will be tempting to fudge. The tempting edits are the small ones: a clarifying sentence, one more example, a reordered question. Those are precisely the encoding of the last agent into the procedure.

**The rule when an edit is needed:**

1. Stop the run set. Do not finish the current run and then edit.
2. Log the edit in the run log: what you changed, which run exposed it, and what the agent did that the procedure could not handle.
3. Make the edit.
4. Restart the whole test set from run 1. Not from the run that failed. From run 1.

Restarting from run 1 is the expensive part and it is the point. The cost is what stops small accommodating edits from accumulating into a procedure that is a union of five special cases. Expect the first attempt at the set to die on run 2 or 3. Expect two or three full restarts before a clean pass. A clean pass on the first attempt should make you suspect the test set is too similar, not that the skill is excellent.

Secondary criteria, recorded but not gating:

- Every passport produced passes `tools/validate.py` without hand editing.
- Every passport reaches a working install on at least one branch, with the losses table rendered.
- The owner recognises their own agent in section 1 without prompting. If they read the three sentences and ask "which agent is this", the capture failed at the level that matters most and validation will not have caught it.

## The correction log

Every correction the owner makes at the check-in is logged. This is not paperwork. It is the research payload: the corrections are the only direct measurement of whether the binding constraint on this product is comprehension fidelity (capture read the agent and understood it wrong) or environment divergence (capture understood it correctly, but the target environment cannot hold it), with a third bucket for vocabulary gaps (capture understood it, the environment could hold it, and the schema had nowhere to put it).

The fields are designed around exactly that three-way split. Everything else is context for reading it.

**Location.** One append-only tab-separated file for the whole programme, at `verification/corrections/log.tsv` (create it on the first run), plus one scoring sheet per run at `verification/corrections/run-<attempt>-<NN>-<slug>.md`. Attempt number increments on every restart, so a restart never overwrites the previous evidence. The old runs are the record of what the edits cost.

**One row per correction, fields in this order:**

| field | meaning |
|---|---|
| `attempt` | test-set attempt number, incremented on every restart |
| `run` | 1 to 5, per the test set above |
| `agent_role` | short role phrase, never a path and never a person's name |
| `capture_path` | `file` or `browser` |
| `field` | the schema field corrected, dotted: `inputs[1].criticality`, `processing.length`, `comparison_mode`, `personal_slots[0].question`, `verification[2].check` |
| `capture_said` | what capture wrote, verbatim, truncated to one line |
| `owner_said` | what the owner corrected it to, verbatim, truncated to one line |
| `class` | `comprehension` \| `environment` \| `vocabulary` \| `scrub` \| `other` |
| `capture_confidence` | the `confidence` capture assigned to that field: `high`, `medium`, `low` |
| `flagged` | `yes` if this field was already surfaced on the check-in as uncertain, `no` if capture was quietly wrong |
| `severity` | `breaks_install` \| `degrades_output` \| `cosmetic` |
| `note` | one line, free text, for what the table cannot hold |

**How to classify, since this is where the log gets soft:**

- `comprehension`: capture had the evidence available and drew the wrong conclusion. The file was readable and said otherwise; the owner had already answered this in the interview. This is our failure and the procedure can be improved.
- `environment`: capture was right about A's agent, and the correction exists because B's world differs. Not fixable by better capture. Fixable only by better slots, better substitution or a wider envelope.
- `vocabulary`: capture and owner agreed on what the agent does and the schema had no correct place to record it. Format feedback, per `vocabulary.md` rule 4.
- `scrub`: the correction was about redaction, over- or under-scrubbing, not about the agent's behaviour.
- `other`: use sparingly, and if `other` exceeds one in ten rows, the classification scheme is wrong and that is itself a finding.

The two cross-tabs worth reading at the end: `class` against `run` (does comprehension failure rise on someone else's agent, or on path W), and `capture_confidence` against `flagged` (when capture was wrong, did it know it was uncertain). A pile of `high` confidence, `flagged: no`, `class: comprehension` rows is the worst result the log can produce, because it means capture is confidently wrong and the check-in is the only thing standing between the owner and a bad passport.

## Scoring sheet, one per run

Written at the end of each run, in the file named above.

- **Agent role, capture path, date, attempt and run number.**
- **Schema fields right first time.** List them. Count them.
- **Schema fields corrected.** List them, with the correction-log row numbers.
- **Fidelity ratio.** Fields right first time over fields the passport actually filled. Not a target to optimise, a number to watch move across attempts.
- **Did validation pass unaided?** Yes or no, with the failure numbers if no.
- **Did the install produce a working agent?** Which branch, did it run once, did the judge verdict come out `match` on structure.
- **What the losses table said.** Reproduce it. A losses table that says everything was delivered on a scraper agent is a suspicious result, not a good one.
- **Did the owner recognise their agent in section 1?** Yes or no, plus what they said.
- **Edits demanded.** Any change you wanted to make to `SKILL.md` during this run, whether or not you made it. Wanting to edit and not editing is data too; it says where the procedure strains.

## What failure of the whole test looks like

The test has failed if any of these hold after three or more attempts:

1. **Edits never stop.** Every attempt dies on a new run with a new required edit, and the edits do not converge on anything general. The procedure is a stack of special cases.
2. **Comprehension corrections stay high on runs 2, 3 and 5,** while staying low on run 1. Capture works on agents it has seen and not on agents it has not. That is the exact thing this test exists to detect.
3. **Run 5 produces a passport the other person does not recognise.** Capture depends on the builder's tacit knowledge of the agent, which means it depends on the one thing a passport is supposed to make transferable.
4. **Passports validate and installs work, but the losses tables are all clean.** Honest capture of structurally different agents inside a read-and-notify envelope should produce real losses. Uniformly clean tables mean capture is reshaping agents to fit rather than describing them.

## What that would mean for the product

It depends on which failure.

Failure 1 or 2 means capture is not yet a procedure, it is a demonstration. The product response is to narrow the claim rather than widen the skill: state which classes of agent are supported, test those, and refuse the rest at the capture step with a clear message. A capture skill honest about its range is shippable. One that silently produces plausible wrong passports is not, because the failure surfaces at B's install, on someone else's machine, with no way to trace it back.

Failure 3 means the format is fine and the capture path is wrong. The response is to move weight from inference to interview: fewer things capture concludes, more things it asks, a longer check-in. Slower, and correct.

Failure 4 is the most dangerous one because everything looks green. The response is to treat the losses table as the primary output of the install rather than the last step of it, and to test capture on agents that cannot survive the envelope, where the correct passport is mostly a list of what will not work.

If the correction log ends up dominated by `environment` rather than `comprehension`, that is not a failure at all. It is the finding: comprehension is tractable and environment divergence is the real constraint, which points the next version at slots, substitution and the resolution map rather than at better reading of source files.

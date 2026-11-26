# Run notes

Fill this in **as you go, not afterwards.** A sheet filled in from memory an hour later is worth
much less, and a blank one beside a finished passport is worth nothing: that is what happened on
the last run, and everything we know about it had to be reconstructed from the output file.

**Do not read the last section until you have finished.** It explains what we were hoping to
learn, and knowing that in advance changes what you notice. The questions above it are
deliberately neutral.

## Setup

- Which agent, and on which product (ChatGPT / Claude / Gemini / other):
- Did the chat already contain the agent, or did you paste its instructions in:
- Date and start time:
- Where did you get the text you pasted: this folder's `PASTE-THIS.md`, or copied from a web
  page:

## What it did, before any opinion about it

- **What did it do first?** In your words, before you judged it.
- Did it try to look at your agent on its own, or did it ask you to paste something?
- Before it asked you its first question, did it tell you anything about your agent that it had
  worked out for itself? If so, was it right?
- How many questions did it ask you in total:
- Did it ever ask the same thing twice, or ask something you had already told it:
- When you gave a vague or lazy answer, what did it do:

## Turn log

One line per message of its. Rough is fine, and an incomplete log beats no log.

| # | what it asked or told you | what you answered | what you thought at the time |
|---|---|---|---|
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | | | |
| 5 | | | |

- Number of turns until it produced the finished block:
- Wall clock, start to finished block:
- How much text did you have to read (fine / a lot / too much):

## Before it finished

- Did it show you a list of things it was removing from the output, and wait for you:
- Is anything of yours in the passport that should not be there (a name, a client, a URL, a
  credential):
- Did it remove anything that was harmless and that you would rather have kept:

## The second half: giving it to a different product

This is the part that matters most and it is the part every previous run has skipped. Please do
it even if the passport looks imperfect.

- Which second product:
- Did you upload the file to a deployment of the app first, or hand it straight to the second product:
- **If you uploaded and it was refused, paste the exact refusal message here.** Do not
  paraphrase it. This is a known open problem and the wording is the thing we need:
- What did the second product ask you:
- What did it say it had set up? Copy its words rather than summarising:
- Did it tell you, without being asked, what the agent is *not* allowed to do:
- **Then use it.** Did the agent actually run, and was the output right? *Set up* is not
  *working*:

## Anything that surprised you

The most valuable box on the sheet, because everything else here is a question we already knew
to ask. In your words, at any length.

-

## Verdict

- Would you hand this passport to someone who is not you:
- The single thing that most needs fixing:
- Anything you would not have been able to do without someone from the project nearby:

---

## Read this only after you have finished

The prompt you pasted is supposed to **read first and ask last**: where the assistant has tools
it should look at your agent itself, tell you in one message what it found, and ask you for a
single confirmation. Where it has no tools it should say so plainly and ask for one paste.

An earlier version of this prompt told the assistant flatly that it had no tools, and the
previous real run was done on that stale copy, so the assistant never tried. That is why the
questions above ask what it *did* rather than whether it read your agent: we wanted your
unprimed answer.

**The one thing we cannot answer without you** is whether it took the right branch for the
product you were on. An assistant that asked you to paste, on a product where it could have
looked for itself, is exactly the failure this version was written to fix, and it would look
perfectly normal from the inside.

If anything above now reads differently to you in that light, add it here rather than changing
what you wrote:

-

# Path W run: what to do

You are going to spend about half an hour letting an AI assistant interview you about an agent
you already use, so that it can write a portable description of that agent. Then you hand that
description to a **different** AI product and see whether it can pick the agent up.

The second half is the part that matters and it is the part everyone skips.

**You do not need to know anything about this project.** Everything you need is in this folder.

## What you need

- An agent you actually use: a custom GPT, a Claude Project, a Gemini Gem, a scheduled task, or
  just a chat where you paste the same standing instructions every time. A real one beats a
  tidy one.
- **A second AI product**, different from the first. That is where you will try to install it.
- About 30 minutes. The one recorded run took 27.

## The run

1. **Check your agent's instructions for a real password, API key or token.** If there is one,
   pick a different agent or delete that line before you start. A previous run copied a live
   token into the output. **Do not use this to test whether credentials are caught.**

2. **Open a new chat** in the product where your agent lives, so the assistant has the best
   chance of reading it. If that is not possible, any new chat works and you paste the agent's
   instructions in yourself.

3. **Copy the whole of `PASTE-THIS.md` and paste it as your first message.** All of it,
   including the first line that begins `Today is`. That line is there because a model once
   invented a date.

4. **Answer as yourself.** Answer honestly, including badly. If it asks something vague, give it
   a vague answer once and see whether it pushes back. It is supposed to.

5. **Fill in `RUN-NOTES.md` as you go, not afterwards.** It is short and it asks for the things
   that are easy to forget an hour later.

6. **When it prints a block of text as the finished result, save it here as `passport.md`.**
   Copy the whole block. If you are not sure where it starts and ends, save more rather than
   less.

7. **Then do the second half**, which is step 8 below and is the whole point.

8. **Open your second AI product, in a new chat, and give it `passport.md`.** Upload the file
   or paste its contents; either is fine, and `RUN-NOTES.md` asks which you did. Then ask it to
   set itself up as that agent. **Write down what it asks you, what it says it has done, and
   whether the result actually behaves like your agent.** If it refuses or gets confused, that
   is a result, not a failed run.

## If it goes wrong, stop

Paste the error or the strange message into `RUN-NOTES.md` and stop there. **Do not re-prompt it,
do not start over, do not fix it.** A run you repaired tells us nothing, and the thing that went
wrong is more useful to us than a clean result.

The same goes for a run that is merely disappointing. A mediocre passport is data.

## Publishing

- **There is nothing to publish to by default.** Hosting at `app.phaeacia.ai` is closed to new
  uploads; the project is archived. Handing the file straight to the second product in step 8
  publishes nothing, which is what this run is for.
- **If you run your own deployment of the app** (`web/` in this repository) and upload to it,
  remember that a passport becomes a public web page the moment it is uploaded. If it is
  refused, keep the exact wording of the refusal. If the refusal says it found a credential,
  remove it from the file and rotate it.

## Checking it locally

```
./check.sh passport.md
```

This works only on a machine with a checkout of the Agent Passport source and Node.js, which is
where `scripts/stage-owner-run.sh` staged this folder. **If you are running this anywhere else,
skip it.**

It prints four verdicts rather than one. If two of them disagree about your file, it says so
loudly and asks you to copy the output into `RUN-NOTES.md`. **That disagreement is a better
result than a pass**, so please do copy it.

---

# How this folder was made, for whoever staged it

**Staged by `scripts/stage-owner-run.sh`.** The commit and both hashes are in `PROVENANCE.txt`.
This file is versioned at `capture/owner-run-readme.md` and copied, never authored here, so the
staged copy cannot drift from the source. `RUN-NOTES.md` and `check.sh` are copied the same way.

**What the block is.** `PASTE-THIS.md` is PART B of `capture/path-w-prompt.md` at the commit in
`PROVENANCE.txt`, extracted by the fence rule `web/build.sh` uses, plus the date line. The
script refuses an uncommitted prompt but does not know which commit you meant to test; record it
in `RUN-NOTES.md`.

**`check.sh` runs the gate itself**, importing `web/lib/_validate.mjs` and `_derive.mjs`, the
modules `web/netlify/functions/upload.mjs` imports, rather than a mirror of them, and calls them
in upload.mjs's order: `transport()` on the file's bytes, then `validate()`, then `derive()`. It
prints all four verdicts: `validate.py`, `preflight.py`, the gate, and a scan for credential
shapes. The gate's verdict is the one an upload would get, and the others are there so that a
difference between the implementations shows up on a real owner's file.

**The disagreement banner** is the only sensor here: the one thing that can show that an owner's
file exposed a difference between the gates. It reports the two verdicts and never says whose
fault the difference is.

**A credential is not a disagreement.** `validate.py` has no secret scan by design, so a file the
gate refuses with `E_SECRET_FOUND` alone always differs from it. `check.sh` then says plainly that
the gate found what looks like a credential and asks the owner to remove it, rotate it and run
again, and does not print the disagreement banner.

**Nor is a refusal at stage 1.** The gate runs as the upload does, `transport()` on the file's
bytes first, and `validate.py` never looks at those by design. So a file the gate refuses for its
size, its encoding or a control character (`E_TOO_LARGE`, `E_TOO_SMALL`, `E_NOT_UTF8`,
`E_CONTROL_CHARS`) differs from `validate.py` too, and gets no banner. `preflight.py` predicts
stage 1, and the mirror banner still compares the two.

**`check.sh` withholds details when it recognises a credential.** Everything it prints is meant to
be copied into `RUN-NOTES.md`, and the validators' messages quote field values. So when the gate
or the credential scan recognises a credential, sections 1 to 3 show only their verdicts, the
gate's codes and the credential's line numbers, and section 4 never prints the matching text. It
cannot withhold a credential nothing recognises: a field value the validators quote is printed
whatever it is.

**One measured gap.** `preflight.py` is blind to the envelope, so `envelope: read-write` gets
`OK: the upload endpoint will accept this passport's content` from it while the gate refuses
with `E_BAD_ENVELOPE`; the word *content* carries the whole qualification. `validate.py` catches
that row, so the script still stops.

**`check.sh` runs a snapshot of the gate taken from the commit `PROVENANCE.txt` names**, kept
in `owner-run-gates/<commit>/` beside this folder (not inside it, because this folder is what an
outside runner receives). It verifies the snapshot against its manifest before every run and
refuses to run an altered one, so its verdict is the verdict of that commit whatever state any
checkout on the machine is in. The snapshot is read-only; `chmod -R u+w` it before deleting. To
re-check an old run against a newer gate on purpose, set `OWNER_RUN_GATE_OVERRIDE` to a
checkout; the script says loudly that those verdicts are not the run's own.

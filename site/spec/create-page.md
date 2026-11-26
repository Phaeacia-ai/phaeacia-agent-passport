# Create page specification, share layer v0.1

**Status:** normative for `/create` on the Agent Passport site. Clients: whoever builds the page, and whoever writes the upload endpoint (`site/spec/upload-validation.md`).

**Who this page is for:** A, the person whose agent is being captured. A has an agent that works and wants to give it to someone else. A is not necessarily technical, has not read the spec, and has about thirty seconds of patience before deciding this is not for them.

**What this page must accomplish, in order:** tell A what this is, find out which of two capture paths applies, hand A the right tool for that path, warn A that publishing is public, take the resulting file, and give back a link and a delete token.

**Copy rules for everything in this document:** the copy below is final and shippable as written. Plain register. No marketing voice. No emoji. No em-dashes. No exclamation marks. Second person. Short sentences. Where a placeholder appears in braces, it is filled by the implementation, and every placeholder is listed in section 9.

---

## 1. Wireframe

Section order is fixed. Do not reorder, do not move section 4 below section 5, do not collapse section 4 into a footer.

```
+------------------------------------------------------------------+
|  0  HEADER                                                        |
|     Product name, one line of what it is                          |
+------------------------------------------------------------------+
|  1  WHAT THIS IS                                                  |
|     Three sentences. No graphics. No feature list.                |
+------------------------------------------------------------------+
|  2  PICK YOUR STARTING POINT                                      |
|     Two cards, side by side on desktop, stacked on mobile.        |
|     [ A: My agent lives in files      ]                           |
|     [ B: My agent lives in ChatGPT or Claude ]                    |
|     Neither is preselected.                                       |
+------------------------------------------------------------------+
|  3  THE PANEL FOR THE CHOSEN PATH                                 |
|     Hidden until a card is chosen. Only one panel shows.          |
|                                                                   |
|     3A  FILES PATH                                                |
|         Install line in a copy block   [copy]                     |
|         Three numbered steps                                      |
|         Link to the skill documentation                           |
|                                                                   |
|     3B  BROWSER PATH                                              |
|         The capture prompt in a copy block   [copy]               |
|         Four numbered steps                                       |
|         Note on what browser capture cannot see                   |
+------------------------------------------------------------------+
|  4  BEFORE YOU UPLOAD                                             |
|     The public-once-linked warning. Always visible once a path    |
|     is chosen. Directly above the upload box. Never in a footer,  |
|     never behind a disclosure triangle, never a tooltip.          |
+------------------------------------------------------------------+
|  5  UPLOAD                                                        |
|     One box serving both paths.                                   |
|     File drop zone + "choose a file"                              |
|     or a large paste area                                         |
|     [ Publish this passport ]                                     |
|     State machine per section 6.                                  |
+------------------------------------------------------------------+
|  6  RESULT                                                        |
|     Replaces section 5 on success. Link, then delete token,       |
|     then the shown-once warning.                                  |
+------------------------------------------------------------------+
|  7  FOOTER                                                        |
|     What this does not do. Link to the format spec.               |
+------------------------------------------------------------------+
```

Both paths end at the same upload box. The files path produces a file on A's disk; the browser path produces a block of text in A's chat window. One box takes either. Do not build two upload flows.

---

## 2. Final copy, sections 0 to 3

### Section 0, header

> **Agent Passport**
>
> Describe an agent you built well enough that someone else can rebuild it in their own assistant.

### Section 1, what this is

> Capture turns your agent into one Markdown file: what it does, what it needs access to, what it produces, and which parts of it are about you rather than about the agent. You get a link. The person you send it to reads what the agent will ask of them before anything is installed, and their own assistant does the installing.
>
> Nothing here runs your agent, stores your credentials, or calls a model. The capture happens inside the assistant you already pay for.

### Section 2, pick your starting point

> **Where does your agent live?**

Card A:

> **In files on my computer**
>
> Scripts, config files, a scheduled job, a folder of prompts. You run it from a terminal or it runs itself.

Card B:

> **In ChatGPT or Claude**
>
> A custom GPT, a Project, or a long-running conversation with instructions you wrote.

Below both cards, one line:

> Not sure? If you can point at a folder, choose the first one.

### Section 3A, files path

> **Install the capture skill**
>
> This is an Agent Skill. It runs inside the coding assistant you already use, reads the folder your agent lives in, and writes the passport file. It needs no network access and no keys.

Copy block, one line:

```
{{SKILL_INSTALL_LINE}}
```

> 1. Run that line, then open your assistant in the folder where your agent lives.
> 2. Ask it to capture this agent as a passport.
> 3. It will show you everything it found, ask you about the parts it was unsure of, and show you every value it redacted. Confirm those, and it writes the passport file into that folder.
>
> The capture reads config files, entry points and recent outputs. It refuses to read anything that looks like a credential store: files named for keys, tokens, secrets or environments, private key files, browser profiles, and any folder locked to your user account. Those are named in the passport as refused, and their contents never enter the file.
>
> [What the capture reads, in detail]({{SKILL_DOCS_URL}})

### Section 3B, browser path

> **Copy this prompt into the chat where your agent lives**
>
> There are no files to read, so the capture works by interview. It asks you for your agent's instructions and for real examples of its output, and it marks everything it could not verify as low confidence so the person installing it knows which parts to check.

Copy block containing the path W capture prompt, with a copy button.

> 1. Open the ChatGPT or Claude conversation where your agent lives. For a custom GPT, open its editor and copy the instructions. For a Project, copy the custom instructions.
> 2. Paste this prompt, then paste your agent's instructions when it asks.
> 3. Paste one to three real outputs. This part is not optional. Without real output there is no evidence of what your agent actually does, and the capture will stop.
> 4. Answer the confirmation questions. It ends by printing the whole passport in one block. Copy that block and paste it below.

---

## 3. Section 4, the warning

This is the one piece of copy on the page that must not be softened, shortened, or moved. It sits directly above the upload box, in the normal reading flow, at body text size or larger, always visible once a path is chosen.

> **Read this before you upload**
>
> Publishing a passport puts it on a public web page. The link is long and random, so it will not turn up in search and nobody can guess it, but anyone who has the link can read the whole passport. There are no accounts and no permissions. Treat it the way you would treat a public document you have not announced.
>
> The capture is built to keep secrets out, and it will have shown you everything it redacted. It is not perfect. Read the file before you upload it. If your agent's instructions contain something you would not want a stranger to read, that is your last chance to take it out.
>
> You can delete a passport later. You cannot un-publish something a person already read.

---

## 4. Section 5, the upload box

### 4.1 Copy

> **Upload your passport**
>
> Drop the .md file here, choose it from your computer, or paste the whole thing as text.

Button label, idle:

> Publish this passport

Below the button, one line, always shown:

> Your file is checked before it is stored. Nothing is published if the check fails.

### 4.2 Behaviour

- The drop zone and the paste area are two views of one input. Filling either disables the other until it is cleared.
- The button is disabled while the input is empty.
- Accepted file extensions: `.md`, `.markdown`, `.txt`. Extension is a hint only. The endpoint decides on content, per `upload-validation.md` section 2.
- The client may check size before sending and show `E_TOO_LARGE` locally to save a round trip. It must not perform any other validation locally. There is exactly one validator and it is on the server. A second, friendlier client-side validator would drift within a month and start disagreeing with the one that decides.

---

## 5. Section 6, upload flow states

Five states. The page is always in exactly one.

### 5.1 Idle

The upload box as described. No message area. If a previous attempt failed, its errors clear the moment the input changes.

### 5.2 Validating

Button disabled and relabelled:

> Checking

The input becomes read-only, not hidden. A person who waited eight seconds should still be able to see what they submitted.

No progress bar and no spinner claiming steps it is not performing. Validation is fast enough that a bar would be theatre.

### 5.3 Failed

The upload box stays exactly as it was, with the content intact. Failures appear directly above the button, not as a toast and not as a modal.

Rendering rules:

- The heading is fixed: **Not published.**
- Under it, one line per error, using the exact `message` string from the failure table in `upload-validation.md` section 7. Do not paraphrase these messages on the page. There is one copy of each string, in that table, and this page renders it.
- If the response carries `details`, render them as an indented plain list under their message. Never render body content, only locations and identifiers.
- If several errors come back, show all of them. The endpoint collects errors precisely so a person can fix them in one pass.
- Below the list, one fixed line:

> Nothing was stored. Fix the file and upload it again.

- For `E_SECRET_FOUND` only, one additional fixed line below that:

> Assume that credential is exposed and replace it. It was in a file you were about to publish.

### 5.4 Succeeded

Section 5 is replaced by section 6. Do not keep the upload box on screen. A second publish is a fresh page load.

> **Published.**
>
> This is the link. Send it to the person who is going to install the agent.

Copy block with the full URL and a copy button.

> **This is the delete token.**

Copy block with the token and a copy button.

> This token is shown once. It is not stored anywhere in a form that can be read back, it is not emailed, and it cannot be recovered or reissued. Save it now, in whatever you use for passwords or notes.
>
> Without it the passport stays up. With it, deleting is immediate and permanent.

Then, in the same panel, quieter but present:

> [Open the passport page]({{PASSPORT_URL}}) to see what the other person will see.

### 5.5 Failed at storage

`E_INTERNAL`. Distinct from 5.3 because it is not the uploader's fault and there is nothing for them to fix.

> **Not published.**
>
> Something failed on our side. Your passport was not stored and nothing was published. Try again in a few minutes. If it keeps failing, the file is fine and we are not.

The input keeps its content.

---

## 6. Section 7, footer copy

> **What this does not do**
>
> It does not copy your credentials. It carries the fact that your agent reads a mailbox, not the account or the token. The person installing grants their own access on their own platform.
>
> It does not install agents that write to the world. Version 0.1 installs agents that read and report. If your agent sends email, posts, or moves money, the passport lists those capabilities plainly and marks them as not installable here.
>
> It does not promise the copy will behave identically. Every install ends with a list of what transferred, what was substituted, and what was lost.
>
> [The passport format]({{SPEC_URL}})

---

## 7. The path chooser and the platform picker

Two questions, asked of two different people, on two different pages, that belong to the same decision tree.

- **This page** asks A: where does your agent live? Answers: `files`, `browser`.
- **The passport page** asks B: which platform are you installing into? Answers: `chatgpt`, `claude-ai`, `claude-code`.

In v0.1 the second one swaps a copy block. In v0.2 it becomes the first question of an install wizard that walks B through platform, then plan tier, then capability requirements, then warnings, with every branch coming from a `resolution.yaml` lookup rather than from code.

That upgrade is UI work over existing data only if v0.1 builds the picker as a question rather than as three buttons. The requirements below exist to keep that door open. They are cheap now and expensive later.

1. **The answer lives in the URL.** `?path=files` here, `?platform=chatgpt` on the passport page. A chosen state must be linkable and must survive a reload. A wizard is a sequence of URL states, and a picker that keeps its answer in a local variable cannot become one.
2. **The answer is a data key, not a label.** Store and pass `claude-code`, never "Claude Code". The keys are the ones in `resolution.yaml`. A picker that emits display strings cannot be joined to the resolution map.
3. **Options come from data.** The picker renders from a list of platform records. Adding a fourth branch, which the build plan expects for local runtimes, must be a data edit. If adding a platform means editing markup, the picker is already the dead end this section exists to prevent.
4. **Choosing never hides the alternatives.** The other options stay visible and reselectable. B may guess wrong about their own plan tier and need to go back, and a wizard that cannot be reversed will not be used.
5. **The copy block is not the end of the flow.** Every branch ends with a line about what happens next in B's assistant. In v0.1 that line is static text. In v0.2 it becomes the next wizard step. Ending on a bare copy block with no next line trains people to treat the picker as terminal, and it teaches the builder the same thing.
6. **The picker records nothing about the person.** The chosen key may go in the URL and may be counted in aggregate. It is not stored per visitor and not attached to the passport row. Telemetry beyond the page view counter is out of scope, see section 8.

---

## 8. Out of scope for v0.1

Listed so that nobody builds them by accident, and so that a reviewer can say no by pointing at this section rather than by arguing.

- **Accounts.** No sign up, no sign in, no email address collected anywhere, no session. The uuid and the delete token are the entire identity model.
- **Editing.** A published passport is immutable. Fixing one means publishing a new one and deleting the old one. There is no edit endpoint, no PATCH, and no UPDATE privilege granted to any client.
- **Versioning.** No "version 2 of this passport", no supersedes link, no history. `passport: "0.1"` is a format version, not a document version.
- **Organisation libraries.** No collections, no teams, no shared spaces. This bullet used to end "no listing of any kind. There is deliberately no endpoint that returns more than one passport, and adding one would break the read model in `schema.sql`." **Amended 2026-09-04 (GALLERY-SPEC.md, ROW-121):** `/gallery` is that endpoint. It returns cards for the passports whose owners chose to list them, read from a separate card store and never from passport bodies; the read model in `schema.sql` was never built, so nothing it protected exists to break. Unlisted passports are still reachable one at a time and only by their uuid, and no endpoint lists them.
- **Telemetry.** One integer per passport counting page views. No analytics script, no third party tag, no event stream, no funnel, no session recording, no referrer storage, no IP logging beyond what the rate limiter needs and discards.
- **Payments.** Nothing is priced, nothing is metered, there is no plan and no upgrade path in the UI.
- **Search and discovery.** No search box, no featured passports, no sitemap entry for any passport URL. An unlisted passport page sends `X-Robots-Tag: noindex, nofollow`; a page the owner listed in the gallery does not (amended 2026-09-04 with the bullet above). For an unlisted passport the link being unguessable is still load bearing, and nothing lists those links.
- **Recovery.** No "email me my delete token", no support flow for a lost token, no admin UI. Section 5.4 says the token cannot be recovered, and that has to stay true.

---

## 9. Placeholders and open items

Everything in braces is filled by the implementation. Each is listed here so none ships as literal text.

| placeholder | what it is | who fills it |
|---|---|---|
| `{{SKILL_INSTALL_LINE}}` | the one line that installs the capture skill, once the skill repo is public | owner, at first deploy |
| `{{SKILL_DOCS_URL}}` | documentation for what the capture reads and refuses | owner |
| `{{SPEC_URL}}` | public URL of `spec/passport-0.1.md` | owner |
| `{{PASSPORT_URL}}` | the newly created passport link, from the upload response | runtime |

**Open item, section 3B.** The capture prompt itself is not reproduced in this document. It is a separate deliverable (`capture/` path W) and it belongs in one file that both this page and the documentation read from. Do not paste a copy of it into the page markup: a prompt that exists in two places will be edited in one. The page renders it from source at build time.

**Open item, accessibility.** Every copy block needs a real button with a text label, not an icon alone, and must announce the copy result to a screen reader. The two path cards are radio inputs with labels, not clickable divs. The failure list in 5.3 is an ARIA live region, because a person who submitted and cannot see the page must be told the upload failed.

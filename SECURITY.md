# Security

Agent Passport is archived. **There will be no security fixes**, no advisories and no
response to reports. Nobody monitors this repository. If you find a problem, fix it in
your own fork; if others might be affected, say so publicly in your fork.

The hosted copy at `app.phaeacia.ai` is read-only and accepts no uploads. Anything you
run from this repository, including your own deployment of `web/`, is yours to secure.

## What the design protects, and how

- **No credential is meant to leave the owner's machine.** A passport names the kind of
  access an agent needs, never a value. Capture scrubs credential-shaped values
  (`tools/scrub.py`), shows the owner every replacement, and refuses to finish until
  `tools/validate.py` and `tools/preflight.py` pass. The hosted upload gate
  (`web/lib/_validate.mjs`) refused a passport that still carried a recognisable
  credential and did not store it.
- **Installs are read-only by instruction.** The installer text tells the recipient's
  assistant to install only read capabilities and in-chat delivery, and to treat every
  capability that writes to the world as declared, not installed.
- **The capture tools are local.** Of the shipped scripts, only `scripts/publish.py`
  opens a network connection, and only to the endpoint configured for it.

## Known limitations

State these plainly to anyone you hand the tools to.

1. **The scrubber is a pattern scan.** It finds credentials whose shape it knows. A
   password, a key with no recognisable prefix, or a secret written in prose can pass
   it, the validator (which has no secret scan by design) and preflight. The owner's
   scrub review is the last line, and it depends on the owner reading it.
2. **Capture path W enforces nothing in code.** The browser prompt asks the owner's
   own chat model to scrub. Until the file is checked locally, nothing verifies that it
   did. A recorded test run copied a live token into its output.
3. **"Read-only" is an instruction to a model, not a permission.** The installer text
   cannot restrict what the recipient's assistant or platform is able to do. A
   recipient's assistant can ignore it, and a platform's own tool permissions are what
   actually bind.
4. **A passport is readable by whoever holds it.** It describes what an agent reads, how
   it decides and what it produced. Send it only to people who may know that. A page on
   the hosted app was public to anyone holding its link.
5. **Platform facts are dated.** `spec/resolution.d/` and the installer branches describe
   ChatGPT, claude.ai and Claude Code as checked in 2026. Consent screens, plan limits
   and connector behaviour change; the installer text may describe steps that no longer
   exist or no longer mean what they did.
6. **`scripts/publish.py` overwrites an existing `<name>-passport.link.md`.** Publishing
   the same passport twice to a self-hosted deployment replaces the file that held the
   first page's delete token. A fix was written in October 2026 and not merged.
7. **The app's dependencies are frozen.** `web/package.json` and `web/package-lock.json`
   pin the versions current when work stopped. They will not be updated, and a
   deployment inherits every vulnerability found in them. In November 2026 `npm ci`
   already reported 13 known vulnerabilities (8 moderate, 5 high); run `npm audit` in
   `web/` before you deploy.
8. **Known gaps in the app at the time it was archived**, from an audit in October 2026
   whose fixes were not merged: the gallery endpoint has no rate limit of its own, and
   the Content Security Policy allows `'unsafe-inline'` in `script-src` (the audit
   found no injection; the change that would have removed it was not merged).
   `web/README.md` lists the app's other known gaps.

## If you deploy `web/` yourself

- Read `web/README.md` first: configuration, storage, rate limits, the delete-token
  model and what each environment variable controls.
- Use your own name and logo, your own domain, your own legal pages and your own
  contact address. The pages in `web/` describe Phaeacia's deployment, not yours.
- Treat every upload as untrusted input from an anonymous stranger, as
  `site/spec/upload-validation.md` does, and keep the upload gate's refusals intact.
- Never put a real credential, a customer's data or a test passport built from a real
  person's agent into the repository's fixtures.

## Secret scanning in this repository

`.gitleaks.toml` configures gitleaks for this repository. `.githooks/pre-commit` runs it
on staged changes once you enable the hook as its header describes; it does not run by
itself. `.github/workflows/gitleaks.yml` runs it on push. The fixtures
under `tools/fixtures/` hold deliberately fake credentials that the scrubber and the
gates are tested against; the configuration says which.

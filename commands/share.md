---
description: Capture the agent in this folder as an Agent Passport file, and publish it only to a self-hosted deployment
---

Invoke the `agent-passport` skill and follow it start to finish for the agent in the current working directory. The skill is the substance; this command is only the entry point.

The skill decides what it is capturing: it uses this folder if it looks like an agent, and asks one question otherwise. Everything happens in this chat, nothing is typed outside it. The flow ends with the passport written next to the agent's files as `<name>-passport.md`.

Hosting at app.phaeacia.ai is closed to new uploads; the project is archived. The passport is a local file that you can send however you like. If you run your own deployment of the app (the `web/` directory of https://github.com/Phaeacia-ai/phaeacia-agent-passport) and set `PHAEACIA_UPLOAD_ENDPOINT` to its upload address, the skill offers to publish there instead. A published page is public to anyone holding its link and deletes itself after thirty days.

If nothing happens when this command runs, the skill did not load, and that failure is silent by design of the platform: there is no error to read. Run `scripts/doctor.sh` from your checkout of the source repository. It says in one line whether `/share` can work and prints the exact command to repair whatever it finds.

#!/usr/bin/env python3
"""scripts/publish.py against a loopback server: the closed host and a self-hosted one.

The hosted site at app.phaeacia.ai is archived and its upload endpoint answers
HTTP 410 with the code `archived`. What this pins, for the canonical script and
for the skill's generated copy of it:

  410        exit 5, the first line of stderr is exactly
             "hosting at <host> is closed to new uploads; your passport file is
             kept locally at <absolute path>", the host's own message follows,
             nothing on stdout, the passport byte for byte unchanged, no link file,
             one request and no retry, no traceback. The same on a 410 that has no
             JSON body, on a 410 that arrives on the owner-review retry, and when
             the endpoint comes only from PHAEACIA_UPLOAD_ENDPOINT.
  default    the wording for the default endpoint names app.phaeacia.ai. Checked
             by calling the formatter, so no request goes to the real host.
  self-host  a 200 from the endpoint the flag names publishes: exit 0, the URL
             as the last line, the link file written 0600 beside the passport.

Every subprocess gets the loopback endpoint as the flag and as the environment
variable at once (except the one case that tests the variable alone), so no
mistake here can send a request to the real site.

usage: python3 tools/test_publish.py      (exit 0 = pass)
"""

import hashlib
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Importing the skill's copy below must not leave scripts/__pycache__ inside the
# skill folder: run_tests.sh refuses a shipped folder holding a .pyc, rightly.
sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCRIPTS = ["scripts/publish.py", "skills/agent-passport/scripts/publish.py"]
FIXTURE = os.path.join(HERE, "fixtures", "passports", "valid_minimal.md")
ARCHIVED_MESSAGE = ("Agent Passport is archived and this site no longer accepts uploads. "
                    "The source is at https://github.com/Phaeacia-ai/phaeacia-agent-passport.")


class Server:
    """A loopback endpoint that answers from a script, one answer per request."""

    def __init__(self):
        self.answers = []
        self.seen = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                n = int(self.headers.get("content-length") or 0)
                outer.seen.append({"path": self.path, "headers": dict(self.headers),
                                   "body": self.rfile.read(n)})
                status, ctype, body = (outer.answers.pop(0) if outer.answers
                                       else (500, "text/plain", b"no scripted answer"))
                self.send_response(status)
                self.send_header("content-type", ctype)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.endpoint = "http://127.0.0.1:%d/api/upload" % self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def script(self, *answers):
        self.answers = list(answers)
        self.seen = []

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def as_json(status, obj):
    return (status, "application/json", json.dumps(obj).encode("utf-8"))


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def run(script, passport, endpoint, flag=True, extra=()):
    env = dict(os.environ)
    env["PHAEACIA_UPLOAD_ENDPOINT"] = endpoint
    argv = [sys.executable, os.path.join(ROOT, script), passport]
    if flag:
        argv += ["--endpoint", endpoint]
    argv += list(extra)
    p = subprocess.run(argv, capture_output=True, text=True, env=env, timeout=60)
    return p.returncode, p.stdout, p.stderr


def main():
    bad = []
    server = Server()
    tmp = tempfile.mkdtemp(prefix="publish-test-")
    try:
        for script in SCRIPTS:
            if not os.path.exists(os.path.join(ROOT, script)):
                bad.append("%s is missing; run scripts/build.sh" % script)
                continue

            def fresh(name):
                d = tempfile.mkdtemp(dir=tmp)
                path = os.path.join(d, name)
                shutil.copy(FIXTURE, path)
                return path

            def closed_case(label, answers, flag=True, extra=()):
                passport = fresh("closed-passport.md")
                before = sha(passport)
                server.script(*answers)
                rc, out, err = run(script, passport, server.endpoint, flag=flag, extra=extra)
                want = ("hosting at 127.0.0.1 is closed to new uploads; your passport file "
                        "is kept locally at %s" % os.path.abspath(passport))
                first = err.splitlines()[0] if err.splitlines() else ""
                where = "%s, %s" % (script, label)
                if rc != 5:
                    bad.append("%s: exit %d, want 5. stderr: %s" % (where, rc, err.strip()[:300]))
                if first != want:
                    bad.append("%s: first stderr line is %r, want %r" % (where, first, want))
                if out.strip():
                    bad.append("%s: printed to stdout on a closed host: %r" % (where, out.strip()[:200]))
                if "Traceback" in err:
                    bad.append("%s: crashed: %s" % (where, err.strip()[-300:]))
                if not os.path.exists(passport) or sha(passport) != before:
                    bad.append("%s: the passport file was changed or lost" % where)
                if os.path.exists(passport[:-3] + ".link.md"):
                    bad.append("%s: wrote a link file although nothing was published" % where)
                if len(server.seen) != len(answers):
                    bad.append("%s: %d request(s) reached the server, want %d"
                               % (where, len(server.seen), len(answers)))
                if "PHAEACIA_UPLOAD_ENDPOINT" not in err:
                    bad.append("%s: does not say how to point publish at another deployment" % where)
                return err

            gone = as_json(410, {"ok": False, "code": "archived", "message": ARCHIVED_MESSAGE})
            err = closed_case("410 with the archived body", [gone])
            if ARCHIVED_MESSAGE not in err:
                bad.append("%s: the host's own 410 message was not passed on" % script)
            closed_case("410 with a plain-text body", [(410, "text/plain", b"Gone")])
            closed_case("410 from the environment variable alone", [gone], flag=False)
            ticket = as_json(409, {"ok": False, "code": "E_OWNER_UNCONFIRMED",
                                   "message": "nobody confirmed this", "ack": "t1"})
            closed_case("410 on the owner-review retry", [ticket, gone], extra=["--unconfirmed"])

            # A self-hosted deployment that is open: the same flag publishes.
            passport = fresh("open-passport.md")
            before = sha(passport)
            url = "http://127.0.0.1/p/00000000-0000-4000-8000-000000000000"
            server.script(as_json(200, {
                "ok": True, "url": url,
                "manage_url": "http://127.0.0.1/manage#t0k3n",
                "delete_token": "t0k3n", "expires_at": "2026-12-07"}))
            rc, out, err = run(script, passport, server.endpoint)
            link = passport[:-3] + ".link.md"
            if rc != 0 or not out.strip() or out.strip().splitlines()[-1] != url:
                bad.append("%s, self-hosted 200: exit %d, last line %r, want 0 and %r"
                           % (script, rc, (out.strip().splitlines() or [""])[-1], url))
            if sha(passport) != before:
                bad.append("%s, self-hosted 200: the passport file was changed" % script)
            if not os.path.exists(link):
                bad.append("%s, self-hosted 200: no link file beside the passport" % script)
            else:
                mode = stat.S_IMODE(os.stat(link).st_mode)
                if mode != 0o600:
                    bad.append("%s, self-hosted 200: link file mode %o, want 600" % (script, mode))
                if "t0k3n" not in open(link, encoding="utf-8").read():
                    bad.append("%s, self-hosted 200: the delete token is not in the link file" % script)
            if len(server.seen) != 1 or server.seen[0]["path"] != "/api/upload":
                bad.append("%s, self-hosted 200: the request did not reach the named endpoint once"
                           % script)

            # The default endpoint's wording, without a request to the real host.
            spec = importlib.util.spec_from_file_location("publish_under_test",
                                                          os.path.join(ROOT, script))
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            want = ("hosting at app.phaeacia.ai is closed to new uploads; "
                    "your passport file is kept locally at /tmp/x-passport.md")
            if not callable(getattr(mod, "closed_text", None)):
                bad.append("%s: has no closed_text(), so the default-endpoint wording "
                           "was not checked" % script)
            else:
                text = mod.closed_text(mod.DEFAULT_ENDPOINT, "/tmp/x-passport.md",
                                       {"code": "archived", "message": ARCHIVED_MESSAGE})
                if text.splitlines()[0] != want:
                    bad.append("%s: default-endpoint wording is %r, want %r"
                               % (script, text.splitlines()[0], want))
            if getattr(mod, "EXIT_HOSTING_CLOSED", None) != 5:
                bad.append("%s: EXIT_HOSTING_CLOSED is %r, want 5"
                           % (script, getattr(mod, "EXIT_HOSTING_CLOSED", None)))
    finally:
        server.close()
        shutil.rmtree(tmp, ignore_errors=True)

    for b in bad:
        print("PUBLISH: " + b)
    if bad:
        return 1
    print("PUBLISH TESTS PASSED: a 410 ends with exit 5 and the file kept, on %d copies of "
          "publish.py; a self-hosted endpoint still publishes" % len(SCRIPTS))
    return 0


if __name__ == "__main__":
    sys.exit(main())

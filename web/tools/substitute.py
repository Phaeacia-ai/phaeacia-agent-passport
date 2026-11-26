#!/usr/bin/env python3
"""Fill {{PLACEHOLDER}} tokens in the HTML from environment variables.

Run from the deploy workflow, between build.sh and the Netlify push, and never
from build.sh itself. build.sh runs on developer machines, and a build step that
rewrites tracked source files there is a build step that eventually gets
committed with somebody's local values in it. In CI the checkout is thrown away,
so rewriting in place is free.

Anything unset stays a visible dashed slot rather than becoming a guess, which
is what the markup already assumes: imprint.html renders every placeholder
inside <span class="slot">, and build.sh fails if one ever becomes a live
mailto. Unset is a warning, never a failure. A pipeline that refuses to deploy
over an honest placeholder is a pipeline somebody disables.

The key names are deliberately the same as the company site's
(.github/scripts/substitute.py over in the website repo), so one set of
repository secrets fills both and the two imprints cannot drift into naming the
same fact differently.
"""
import os
import pathlib
import re
import sys

KEYS = [
    "CONTACT_EMAIL",
    "ENTITY_NAME", "LEGAL_FORM", "REGISTER_OFFICE", "REGISTER_NUMBER", "VAT_NUMBER",
]

ROOT = pathlib.Path(__file__).resolve().parent.parent
TARGETS = sorted(ROOT.glob("*.html")) + sorted((ROOT / "lib").glob("*.mjs"))

values = {k: os.environ.get(k, "").strip() for k in KEYS}
filled = {k: v for k, v in values.items() if v}
missing = [k for k in KEYS if not values[k]]

changed = 0
for path in TARGETS:
    text = original = path.read_text(encoding="utf-8")
    for key, value in filled.items():
        text = text.replace("{{%s}}" % key, value)
    if text != original:
        path.write_text(text, encoding="utf-8")
        changed += 1

print("substituted %d key(s) across %d file(s)" % (len(filled), changed))
for key in sorted(filled):
    print("   %-16s set" % key)
for key in missing:
    print("   %-16s unset, stays a visible slot" % key)

# TWO KINDS OF PLACEHOLDER, AND ONLY ONE OF THEM IS HONEST WHEN UNSET.
#
# Everything in KEYS is a VALUE that may genuinely not exist yet: ENTITY_NAME
# and the register fields are unset because the company is not registered, and a
# visible dashed slot saying so is the candid rendering. The docstring above
# argues that case and it is right. Failing the build over it would strand the
# site behind a company registration, which is why "unset is a warning, never a
# failure" is written there and stays true of every key in KEYS.
#
# {{PENDING_*}} is not a value. It stands for CONTENT NOBODY HAS WRITTEN, on a
# page that must not publish until somebody does, and there is no honest
# rendering of it. A dashed slot where a block of install instructions belongs is
# not a candid admission, it is a page missing a limb.
#
# THIS IS NOT A GUARD THAT FAILED TO GUARD. It is a sound control meeting an
# input outside its premise: it was built for the first kind of placeholder and
# had never seen the second. That is a different defect from a control that reads
# as coverage and does nothing, and the remedy is different too — the leniency
# above is correct and is deliberately left alone.
#
# So the two kinds are told apart BY NAME rather than by strictness. The rule is
# then checkable from the placeholder itself rather than from whoever wrote it
# remembering which sort they meant.
#
# SCANNED FROM THE FILES, NOT FROM KEYS. A PENDING marker is not a key this
# script knows about and never appears in `missing`, so checking that list would
# have found nothing. This is the one substantive difference from the company
# site's copy of this guard, whose own placeholder list is built by scanning.
pending = sorted({
    m
    for p in TARGETS
    for m in re.findall(r"\{\{PENDING_[A-Z0-9_]*\}\}", p.read_text(encoding="utf-8"))
})
if pending:
    print("FAIL: a page still carries an unwritten block. That is not a dashed slot, it is a missing limb.")
    for m in pending:
        for p in TARGETS:
            if m in p.read_text(encoding="utf-8"):
                print("   %s in %s" % (m, p.name))
    print("   Fill it, or take the page out of the deploy. Do not rename it to dodge this.")
    sys.exit(1)

# A placeholder must never become a live mail link, which is the one failure
# this file could introduce and the one build.sh already guards against. Check
# it here too, because build.sh has already run by this point.
leaked = [p.name for p in TARGETS if 'href="mailto:{{' in p.read_text(encoding="utf-8")]
if leaked:
    print("FAIL: an unsubstituted placeholder is a live mailto in: %s" % ", ".join(leaked))
    sys.exit(1)

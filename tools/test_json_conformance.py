#!/usr/bin/env python3
"""test_json_conformance.py — the JSON schema and the validator must not disagree.

For every fixture passport and example:
  * validate.py accepts it  -> to_json must convert it AND spec/passport.schema.json must accept the result.
  * validate.py refuses it  -> to_json must refuse it too. The schema is not a gate: it cannot see invisible
                               characters, homoglyphs or the envelope rules, so the converter defers to the
                               validator instead of re-judging.

Needs PyYAML and jsonschema (test-only). Prints ALL JSON CONFORMANCE TESTS PASSED on success.
"""
import glob
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

try:
    import jsonschema
    import yaml  # noqa: F401
except ImportError as e:
    print("SKIP: %s (pip install pyyaml jsonschema)" % e)
    sys.exit(0)

import to_json

# validate.py accepts these but PyYAML cannot read their section 3, so there is no JSON for them.
# Each is a place where the gate's line reading and a real YAML parser disagree, which is the bug
# class record/proposals/json-passport-format-evaluation-2026-10-01.md names as the real reason to
# want a parser. Keep this list at zero or explain every entry; remove an entry when it converts.
KNOWN_UNREADABLE = {
    "valid_block_scalar_blank_bom.md": "a U+FEFF-only line inside the tacit_notes block scalar: the gate reads it as blank prose, "
                                       "PyYAML reads it as content at column 1 and ends the scalar",
}

schema = json.load(open(os.path.join(ROOT, "spec", "passport.schema.json"), encoding="utf-8"))
validate_py = os.path.join(HERE, "validate.py")


def validator_accepts(path):
    return subprocess.run([sys.executable, validate_py, path], capture_output=True, text=True).returncode == 0


def schema_accepts(obj):
    try:
        jsonschema.validate(obj, schema)
        return True
    except jsonschema.ValidationError:
        return False


files = sorted(glob.glob(os.path.join(HERE, "fixtures", "passports", "*.md")) + glob.glob(os.path.join(ROOT, "examples", "*.md")))
problems, valid_n, invalid_n, known_n = [], 0, 0, 0
for path in files:
    name = os.path.basename(path)
    text = open(path, encoding="utf-8").read()
    ok = validator_accepts(path)
    try:
        obj = to_json.convert_to_json(text)
    except Exception as e:  # noqa: BLE001
        obj, err = None, e
    if ok:
        valid_n += 1
        if obj is None and name in KNOWN_UNREADABLE:
            known_n += 1
        elif obj is None:
            problems.append("%s: validator accepts, to_json refuses (%s: %s)" % (name, type(err).__name__, str(err)[:90]))
        elif name in KNOWN_UNREADABLE:
            problems.append("%s: listed in KNOWN_UNREADABLE but now converts; remove it" % name)
        elif not schema_accepts(obj):
            problems.append("%s: validator accepts, schema rejects" % name)
    else:
        invalid_n += 1
        if obj is not None:
            problems.append("%s: validator refuses, to_json produced JSON anyway" % name)

for p in problems:
    print("FAIL", p)
print("%d fixtures: %d valid (%d with no JSON, listed in KNOWN_UNREADABLE), %d invalid all refused" % (len(files), valid_n, known_n, invalid_n))
if problems:
    sys.exit(1)
print("ALL JSON CONFORMANCE TESTS PASSED")

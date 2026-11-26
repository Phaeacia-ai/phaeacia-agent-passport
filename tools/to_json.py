#!/usr/bin/env python3
"""to_json.py — convert a passport Markdown file to a JSON projection.

The Markdown passport stays the single source of truth. This derives a read-only
JSON view of it for machines. Run validate.py first: this does not decide whether
a passport is acceptable, it only reports what an accepted one says. It needs
PyYAML to read section 3, so it lives in tools/ and is not shipped in the skill.
"""

import argparse
import json
import sys

import validate

try:
    import yaml
except ImportError:  # a clear message beats a traceback for a tool run by hand
    yaml = None

def convert_to_json(markdown_text):
    # A JSON view must never exist for a passport the gate refuses: the gate is the only
    # judge, and this file would otherwise be a second, weaker reading of the same format.
    errors = validate.validate(markdown_text)
    if errors:
        raise ValueError("validate.py refuses this passport, so there is no JSON for it: " + errors[0])

    # Parse frontmatter
    fm, err = validate.parse_frontmatter(markdown_text)
    if err:
        raise ValueError(f"Frontmatter error: {err}")
    
    # Get the body of the markdown
    body = validate.get_body(markdown_text)
    
    # Extract Section 1 Summary (first paragraph)
    # The summary is the first paragraph of section 1.
    lines = markdown_text.split("\n")
    sec1_started = False
    summary_lines = []
    for line in lines:
        stripped = validate.structural_trim(line)
        if not sec1_started:
            if stripped == "## 1. What this agent is":
                sec1_started = True
        else:
            if validate.SECTION_BOUNDARY_RE.match(line):
                break
            if line.strip() != "":
                summary_lines.append(line.strip())
    
    summary = " ".join(summary_lines)
    
    # Parse Section 2 Consent Table
    rows = validate.consent_rows(body)
    needs = []
    for r in rows:
        needs.append({
            "capability": r[0].replace('`', ''),
            "why": r[1],
            "required": r[2].lower().startswith("required"),
            "required_label": r[2],
            "if_skipped": r[3],
            "installable": r[4].lower().startswith("yes"),
            "installable_label": r[4]
        })
    
    # Parse Section 3 Functional Spec
    spec_lines = validate.spec_lines(markdown_text)
    spec_yaml_lines = [line for ln, line, inside in spec_lines if inside]
    spec_yaml = "\n".join(spec_yaml_lines)
    if yaml is None:
        raise ValueError("PyYAML is required to read section 3 (pip install pyyaml)")
    try:
        spec = yaml.safe_load(spec_yaml) if spec_yaml else {}
    except yaml.YAMLError as e:
        raise ValueError(f"Section 3 is not readable as YAML: {e}")
    if spec is None:
        spec = {}
    if not isinstance(spec, dict):
        raise ValueError("Section 3 must be a mapping")
    
    # Extract Section 4 Golden Examples
    # Fenced blocks inside "## 4. Golden examples"
    sec4_started = False
    golden_examples = []
    current_example = []
    in_fence = False
    fence_len = 0
    for line in lines:
        stripped = validate.structural_trim(line)
        if not sec4_started:
            if stripped == "## 4. Golden examples":
                sec4_started = True
        else:
            if validate.SECTION_BOUNDARY_RE.match(line) and not in_fence:
                break
            match = validate.FENCE_DELIM.match(line)
            if match:
                if not in_fence:
                    in_fence = True
                    fence_len = len(match.group(1))
                elif len(match.group(1)) >= fence_len:
                    in_fence = False
                    fence_len = 0
                    golden_examples.append("\n".join(current_example))
                    current_example = []
            elif in_fence:
                current_example.append(line)

    # Compile the final JSON object
    out = dict(fm)
    out["owner_confirmed"] = str(out.get("owner_confirmed")).lower() == "true"
    out["summary"] = summary
    out["needs"] = needs
    out["spec"] = spec
    out["golden_examples"] = golden_examples
    # Section 6 is filled in at install time, on the recipient's side, so a captured
    # passport carries no rows. The field stays so a reader never has to guess.
    out["losses"] = []

    # Discovery aids, derived from section 3 and never read from frontmatter, so
    # there is one place a passport says what it uses and a validator that checks it.
    capabilities = [c for c in spec.get("capabilities", []) if isinstance(c, dict)]
    out["capabilities_used"] = [c["capability_ref"] for c in capabilities
                                if c.get("status") == "used" and "capability_ref" in c]
    out["capabilities_declared"] = [c["capability_ref"] for c in capabilities
                                    if c.get("status") in ("declared", "declared_only") and "capability_ref" in c]
    tags = {i["tag"] for i in spec.get("inputs", []) if isinstance(i, dict) and isinstance(i.get("tag"), str)}
    if tags:
        out["tags"] = sorted(tags)
    return out

def main():
    parser = argparse.ArgumentParser(description="Convert Passport MD to JSON projection")
    parser.add_argument("file", help="The markdown file to convert")
    parser.add_argument("-o", "--output", help="Output file path (defaults to stdout)")
    parser.add_argument("--validate", action="store_true", help="Validate output against spec/passport.schema.json")
    parser.add_argument("--compact", action="store_true", help="Output compact single-line JSON")
    args = parser.parse_args()
    
    try:
        with open(args.file, "r", encoding="utf-8") as f:
            text = f.read()
    except (FileNotFoundError, PermissionError) as e:
        print(f"File error: {e}", file=sys.stderr)
        sys.exit(2)
    except Exception as e:
        print(f"Error reading file: {e}", file=sys.stderr)
        sys.exit(2)
    
    try:
        json_obj = convert_to_json(text)
    except Exception as e:
        print(f"Conversion error: {e}", file=sys.stderr)
        sys.exit(1)
        
    if args.validate:
        try:
            import jsonschema
            import pathlib
            schema_path = pathlib.Path(__file__).resolve().parent.parent / "spec" / "passport.schema.json"
            if not schema_path.exists():
                schema_path = pathlib.Path(__file__).resolve().parent.parent / "references" / "passport.schema.json"
            if not schema_path.exists():
                print(f"Schema not found at {schema_path}", file=sys.stderr)
                sys.exit(1)
            with open(schema_path, "r", encoding="utf-8") as sf:
                schema = json.load(sf)
            jsonschema.validate(instance=json_obj, schema=schema)
        except ImportError:
            print("Warning: jsonschema package not installed, skipping schema validation.", file=sys.stderr)
        except Exception as e:
            print(f"Validation error against schema: {e}", file=sys.stderr)
            sys.exit(1)

    indent = None if args.compact else 2
    output_str = json.dumps(json_obj, indent=indent, ensure_ascii=False)
    if not args.compact:
        output_str += "\n"
        
    if args.output:
        try:
            with open(args.output, "w", encoding="utf-8") as out_f:
                out_f.write(output_str)
        except Exception as e:
            print(f"Error writing output file: {e}", file=sys.stderr)
            sys.exit(2)
    else:
        sys.stdout.write(output_str)
        sys.stdout.flush()

if __name__ == "__main__":
    main()

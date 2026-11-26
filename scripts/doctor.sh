#!/usr/bin/env bash
# Answer one question: if you type /share right now, will it work?
#
# Runnable from anywhere. Depends on nothing being loaded, nothing being
# installed and no working directory in particular: it derives the checkout it
# belongs to from its own path and checks that checkout against what is
# actually installed under ~/.claude.
#
# Every failure prints the command that repairs it. Exit 0 means /share works
# and edits made here reach it. Exit 1 means it does not, or they do not.
#
# The failure it exists for: the repo moves, ~/.claude/skills/agent-passport
# still points at the old path, Claude Code finds nothing there and says
# nothing at all. There is no error to read, so there has to be a thing to run.

set -u

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
skill_src="$root/skills/agent-passport"
skill_dst="$HOME/.claude/skills/agent-passport"
cmd_src="$root/commands/share.md"
cmd_dst="$HOME/.claude/commands/share.md"
example="$root/examples/daily-brief-passport.md"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

passes=0
failures=0

# ~ instead of the literal home directory, so the printed fix is the command
# you would type and the printed evidence is short enough to read.
tilde() { printf '%s' "${1/#$HOME/~}"; }

# One line of evidence from a tool's stderr, with the checkout and the home
# directory folded away first. Truncating raw output cuts the message and keeps
# the long absolute path, which is exactly backwards.
brief() { tr '\n' ' ' | sed -e "s|$root/||g" -e "s|$HOME|~|g" | cut -c1-90; }

ok() {
  printf 'ok    %-24s %s\n' "$1" "$2"
  passes=$((passes + 1))
}

bad() {
  printf 'FAIL  %-24s %s\n' "$1" "$2"
  printf '      %-24s fix: %s\n' "" "$3"
  failures=$((failures + 1))
}

printf 'agent-passport doctor\n'
printf 'checkout  %s\n\n' "$(tilde "$root")"

# --- 1. is the skill installed, and is it THIS checkout ------------------
# A dangling link and a link to a second checkout fail the same way from the
# outside: nothing you edit here changes what /share runs.
if [ -L "$skill_dst" ] && [ ! -e "$skill_dst" ]; then
  bad "skill installed" \
      "$(tilde "$skill_dst") is a dangling link to $(tilde "$(readlink "$skill_dst")")" \
      "ln -sfn \"$skill_src\" \"$skill_dst\""
elif [ ! -e "$skill_dst" ]; then
  bad "skill installed" \
      "$(tilde "$skill_dst") does not exist, so the skill never loads" \
      "mkdir -p \"$HOME/.claude/skills\" && ln -sfn \"$skill_src\" \"$skill_dst\""
elif [ ! -d "$skill_dst" ]; then
  bad "skill installed" \
      "$(tilde "$skill_dst") is a file, not a skill folder" \
      "mv \"$skill_dst\" \"$skill_dst.bak\" && ln -sfn \"$skill_src\" \"$skill_dst\""
else
  installed="$(cd "$skill_dst" && pwd -P)"
  if [ "$installed" = "$skill_src" ]; then
    ok "skill installed" "$(tilde "$skill_dst") -> this checkout"
  elif [ -L "$skill_dst" ]; then
    bad "skill installed" \
        "installed skill is a different checkout: $(tilde "$installed")" \
        "ln -sfn \"$skill_src\" \"$skill_dst\""
  else
    bad "skill installed" \
        "installed skill is a real copy at $(tilde "$installed"), edits here never reach it" \
        "mv \"$skill_dst\" \"$skill_dst.bak\" && ln -sfn \"$skill_src\" \"$skill_dst\""
  fi
fi

# --- 2. the /share command file ------------------------------------------
# The skill can be perfect and /share still do nothing, because the command
# file is what binds the word to the skill.
#
# The dangling branch comes first and is not optional. `[ -e ]` follows the
# link, so a link into a moved-away checkout is not-exists to every later test:
# without this branch the doctor says "does not exist" about a file that is
# plainly there, hands over an `ln -s` that dies with "File exists", and leaves
# the owner in the loop this whole script was written to end. Every repair here
# is `ln -sfn` for the same reason.
if [ -L "$cmd_dst" ] && [ ! -e "$cmd_dst" ]; then
  bad "/share command" \
      "$(tilde "$cmd_dst") is a dangling link to $(tilde "$(readlink "$cmd_dst")")" \
      "ln -sfn \"$cmd_src\" \"$cmd_dst\""
elif [ ! -e "$cmd_dst" ]; then
  bad "/share command" \
      "$(tilde "$cmd_dst") does not exist, so /share is not a command" \
      "mkdir -p \"$HOME/.claude/commands\" && ln -sfn \"$cmd_src\" \"$cmd_dst\""
elif [ ! -f "$cmd_src" ]; then
  bad "/share command" \
      "installed, but this checkout has no commands/share.md to compare it against" \
      "cp \"$cmd_dst\" \"$cmd_src\""
elif ! cmp -s "$cmd_dst" "$cmd_src"; then
  bad "/share command" \
      "installed $(tilde "$cmd_dst") differs from this checkout's commands/share.md" \
      "ln -sfn \"$cmd_src\" \"$cmd_dst\""
else
  ok "/share command" "$(tilde "$cmd_dst") matches this checkout"
fi

# --- 3. the skill folder is self-contained --------------------------------
# SKILL.md is handed to an assistant whose working directory is the owner's
# agent, not this folder. Every path it names has to be here.
if [ ! -f "$skill_src/SKILL.md" ]; then
  bad "skill self-contained" "no SKILL.md in $(tilde "$skill_src")" \
      "check out this repo again; SKILL.md is canonical, not generated"
else
  missing=""
  for ref in $(grep -oE '(references|scripts|tools)/[A-Za-z0-9._/-]+\.(md|py|yaml)' \
                 "$skill_src/SKILL.md" | sort -u); do
    [ -e "$skill_src/$ref" ] || missing="$missing $ref"
  done
  if [ -n "$missing" ]; then
    bad "skill self-contained" \
        "SKILL.md names files the folder does not have:${missing}" \
        "./scripts/build.sh, or correct the path in SKILL.md if it is not meant to ship"
  else
    ok "skill self-contained" "every path SKILL.md names is present"
  fi
fi

# --- 4. frontmatter Claude Code can read ----------------------------------
# Malformed frontmatter is the other silent non-load: the folder is there, the
# files are there, and the skill is simply never offered.
if [ ! -f "$skill_src/SKILL.md" ]; then
  : # already reported above
elif [ "$(head -1 "$skill_src/SKILL.md")" != "---" ]; then
  bad "skill frontmatter" "SKILL.md does not open with ---" \
      "restore the --- name: agent-passport / description: --- block at the top of SKILL.md"
else
  # The closing --- has to be found, not merely looked for. A sed range like
  # 1,/^---$/ ends at the window edge when the terminator is absent, so an
  # unterminated block reads as a perfectly good frontmatter and the doctor
  # blesses a skill Claude Code will not load. awk reports the line or nothing.
  close="$(awk 'NR > 1 && NR <= 40 && /^---[[:space:]]*$/ { print NR; exit }' \
             "$skill_src/SKILL.md")"
  if [ -z "$close" ]; then
    bad "skill frontmatter" \
        "no closing --- within the first 40 lines, so the frontmatter never ends" \
        "add a --- line closing the frontmatter block at the top of SKILL.md"
  else
    front="$(sed -n "2,$((close - 1))p" "$skill_src/SKILL.md")"
    if ! printf '%s' "$front" | grep -q '^name: *agent-passport *$'; then
      bad "skill frontmatter" "no \`name: agent-passport\` line in the frontmatter" \
          "add \`name: agent-passport\` inside the --- block at the top of SKILL.md"
    elif ! printf '%s' "$front" | grep -q '^description: *[^ ]'; then
      bad "skill frontmatter" "no \`description:\` line in the frontmatter" \
          "add a \`description:\` line inside the --- block at the top of SKILL.md"
    else
      ok "skill frontmatter" "name, description, and a closing --- at line $close"
    fi
  fi
fi

# --- 5. generated files match their canonical sources ---------------------
# Build into a copy, never over the working tree: the doctor reports, it does
# not repair. A difference here means the tree is lying about what ships.
gen_ok=1
for d in scripts spec installer tools verification skills; do
  cp -R "$root/$d" "$tmp/" 2>/dev/null || gen_ok=0
done
if [ "$gen_ok" -eq 0 ] || [ ! -x "$tmp/scripts/build.sh" ]; then
  bad "generated files" "could not stage a copy of the checkout to build against" \
      "./scripts/build.sh, then read what it prints"
elif ! "$tmp/scripts/build.sh" >/dev/null 2>"$tmp/build.err"; then
  bad "generated files" "build.sh fails: $(brief < "$tmp/build.err")" \
      "./scripts/build.sh"
else
  # Name the files, not the directories. diff already knows which ones, and
  # "references drifted" sends you reading a directory of seven files.
  drift=""
  for p in spec/resolution.yaml \
           skills/agent-passport/references \
           skills/agent-passport/scripts; do
    changed="$(diff -r -q -x '__pycache__' -x '.DS_Store' "$tmp/$p" "$root/$p" 2>&1 \
               | sed -e 's|^Files .* and ||' -e 's| differ$||' \
                     -e 's|^Only in |only in |' \
                     -e "s|$root/||g" -e "s|$tmp/||g")"
    [ -z "$changed" ] || drift="$drift $(printf '%s' "$changed" | tr '\n' ' ')"
  done
  if [ -n "$drift" ]; then
    bad "generated files" "a build would change:${drift}" "./scripts/build.sh"
  else
    ok "generated files" "resolution.yaml, references and skill scripts are current"
  fi
fi

# --- 6. the Python tools load -----------------------------------------------
py_files="tools/validate.py tools/scrub.py tools/preflight.py scripts/assemble.py scripts/publish.py scripts/passport-to-page.py"
py_missing=""
for f in $py_files; do
  [ -f "$root/$f" ] || py_missing="$py_missing $f"
done
if ! command -v python3 >/dev/null 2>&1; then
  bad "python tools" "python3 is not on PATH; every step that validates or scrubs fails" \
      "install Python 3, or fix PATH so \`python3 -V\` answers"
elif [ -n "$py_missing" ]; then
  # All of them are canonical, none is generated, so build.sh cannot bring one
  # back; it would abort under set -e trying. git is the only real repair.
  bad "python tools" "missing:${py_missing}" \
      "git -C \"$root\" checkout --${py_missing}"
else
  compile_err="$tmp/compile.err"
  # Compile rather than run: a syntax error stops the module loading at all, so
  # this catches it without needing arguments any of them would accept. The
  # bytecode goes to the temp directory, never into the working tree.
  ( cd "$root" && python3 - "$tmp" $py_files 2>"$compile_err" <<'PY'
import os, py_compile, sys
out = sys.argv[1]
bad = []
for i, path in enumerate(sys.argv[2:]):
    try:
        py_compile.compile(path, cfile=os.path.join(out, "c%d.pyc" % i), doraise=True)
    except py_compile.PyCompileError as e:
        line = getattr(getattr(e, "exc_value", None), "lineno", None)
        where = "%s:%d" % (path, line) if line else path
        bad.append("%s %s" % (where, str(e).strip().split("\n")[-1]))
if bad:
    print("; ".join(bad), file=sys.stderr)
    sys.exit(1)
PY
  )
  if [ $? -ne 0 ]; then
    bad "python tools" "$(brief < "$compile_err")" \
        "fix the error at the file and line above"
  else
    ok "python tools" "validate, scrub, preflight, assemble, publish and passport-to-page all load"
  fi
fi

# --- 7. the assemble-and-validate round trip ------------------------------
# The end-to-end shape of what capture produces. Everything above can pass and
# this still fail, because this is the only check that runs the real pipeline.
if [ ! -f "$example" ]; then
  bad "round trip" "no examples/daily-brief-passport.md to assemble" \
      "restore examples/daily-brief-passport.md from git"
elif ! ( cd "$root" && python3 scripts/assemble.py "$example" "$tmp/out.md" ) \
        >/dev/null 2>"$tmp/asm.err"; then
  bad "round trip" "assemble.py fails: $(brief < "$tmp/asm.err")" \
      "python3 scripts/assemble.py examples/daily-brief-passport.md /tmp/out.md"
elif ! ( cd "$root" && python3 tools/validate.py "$tmp/out.md" ) \
        >"$tmp/val.out" 2>&1; then
  bad "round trip" "validate.py rejects the assembled passport: $({ grep -m1 '^FAIL' "$tmp/val.out" || tail -n1 "$tmp/val.out"; } | brief)" \
      "python3 scripts/assemble.py examples/daily-brief-passport.md /tmp/out.md && python3 tools/validate.py /tmp/out.md"
else
  ok "round trip" "example assembles and the assembled file validates"
fi

# --- verdict --------------------------------------------------------------
total=$((passes + failures))
printf '\n'
if [ "$failures" -eq 0 ]; then
  printf '%d checks, all passed. /share will run this checkout.\n' "$total"
  exit 0
fi
printf '%d checks, %d failed. Run the fixes above, then run this again.\n' "$total" "$failures"
exit 1

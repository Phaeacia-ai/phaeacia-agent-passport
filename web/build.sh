#!/usr/bin/env bash
# Copies product-owned text into the deployed site and builds the example page.
#
# Nothing under assets/installer/ is edited by hand: it is copied from the canonical
# files one directory up. Text that exists in two places gets edited in one.
set -euo pipefail

cd "$(dirname "$0")"
REPO=".."

echo "── installer text"
mkdir -p assets/installer/branches
cp "$REPO/installer/core.md" assets/installer/core.md
cp "$REPO"/installer/branches/*.md assets/installer/branches/
# The licence travels with the text it licenses. Without this the copy served to
# strangers carried no notice while the copy in the repo did.
cp "$REPO/installer/LICENSE.md" assets/installer/LICENSE.md
ls assets/installer/branches | sed 's/^/   branch /'

# The judge prompt file is written for two audiences: a preamble for us about why
# the judge is weak, and the prompt itself in one four-backtick fence. Only the
# fence belongs in a passport, which is the same extraction assemble.py performs.
echo "── judge prompt"
python3 - <<'PY'
import sys, pathlib
src = pathlib.Path("../verification/judge-prompt.md")
dst = pathlib.Path("assets/installer/judge.md")
if not src.exists():
    print("   no judge prompt, section 5 will have no verification step")
    dst.write_text("", encoding="utf-8")
    sys.exit(0)
lines = src.read_text(encoding="utf-8").split("\n")
fences = [i for i, l in enumerate(lines) if l.startswith("````")]
if len(fences) < 2:
    print("   judge prompt has no four-backtick block, skipping")
    dst.write_text("", encoding="utf-8")
    sys.exit(0)
body = "\n".join(lines[fences[0] + 1:fences[-1]]).strip()
dst.write_text(
    "## Appendix: the verification judge\n\n"
    "Run this at step 7, against the first real run.\n\n" + body,
    encoding="utf-8")
print("   extracted %d bytes" % len(body))
PY

# The capture skill and the capture prompt were once the proprietary half (the
# skill's SKILL.md is CC BY 4.0 since 2026-08-18, the capture prompt since the
# project was archived), and the skill is no longer copied into the deployed
# site. It went out over /assets/ before, which made "access goes out in
# batches" untrue for anyone who read the page source.
# The installer text above stays public on purpose: a recipient who was handed a
# link has to be able to install without an account.

# ROW-262/ROW-485. Path W's capture prompt is a DIFFERENT case from the paragraph
# just above, not a quiet exception to it. Path F's skill went out over /assets/
# because a reader could get the whole thing without visiting the page at all;
# path W's whole design is the opposite, a block the Create page hands a reader
# to paste, so serving PART B publicly is the feature working, not a leak of it.
#
# Extracted at build time, from the file passport-engineer edits, so this never
# holds a pasted copy that goes stale the day the prompt changes (see
# record/findings/a-copy-with-no-link-back-to-its-source.md). PART A is
# operator-only and is deliberately left out; only PART B, the fenced block
# itself, ships. Same extraction shape as the judge prompt above: the outer
# fence is five backticks and the prompt's own STEP 9 example uses three, so
# matching on 4+ leading backticks (`startswith("````")`) catches only the
# real fence, the same property that extraction already relies on.
#
# FAILS RATHER THAN SERVES WRONG CONTENT. An earlier version of this step
# silently degenerated on two inputs: a missing/short/re-fenced source wrote an
# EMPTY file and exited 0, so the build stayed green and the reader met a dead
# "Copy failed" button with no signal of why; and a stray 4+ backtick fence
# inserted anywhere in PART A (which fences[0]/fences[-1] cannot tell from the
# real outer fence) silently served PART A's operator-only text instead of
# PART B, again with exit 0. Both are now build failures: an expected-line
# assertion catches the second shape (and the first, since an empty or wrong
# body cannot start with the prompt's own first line), and the fence count is
# asserted exactly 2 so a malformed source names itself instead of degrading
# quietly. Precedent for failing here rather than printing and moving on: this
# same file already does it for a missing og-card.png.
echo "── path W capture prompt"
python3 - <<'PY'
import sys, pathlib
src = pathlib.Path("../capture/path-w-prompt.md")
dst = pathlib.Path("assets/installer/path-w-block.txt")
EXPECTED_FIRST_LINE = "You are running an Agent Passport capture, format version 0.1, capture path W (browser)."
if not src.exists():
    print("   FAIL: no path W prompt at ../capture/path-w-prompt.md")
    print("   the browser-chat copy button would have nothing to copy; fix the path or the source")
    sys.exit(1)
lines = src.read_text(encoding="utf-8").split("\n")
fences = [i for i, l in enumerate(lines) if l.startswith("````")]
if len(fences) != 2:
    print("   FAIL: expected exactly 2 four-plus-backtick fence lines (the outer PART B "
          "fence, open and close), found %d at lines %s" % (len(fences), [i + 1 for i in fences]))
    print("   a count other than 2 means either the fence markers moved or a stray "
          "fence was added elsewhere in the file; check capture/path-w-prompt.md by hand")
    sys.exit(1)
body = "\n".join(lines[fences[0] + 1:fences[-1]]).strip() + "\n"
if not body.startswith(EXPECTED_FIRST_LINE):
    print("   FAIL: extracted body does not start with the expected PART B opening line")
    print("   got: %r" % body.splitlines()[0] if body else "   got: (empty)")
    print("   this usually means the fence slice landed in PART A instead of PART B")
    sys.exit(1)
dst.write_text(body, encoding="utf-8")
print("   extracted %d bytes, starts with the expected line" % len(body))
PY

echo "── example passport"
node tools/make-example.mjs

# The social card. One link pasted into a chat is the entire distribution loop,
# and without this it pastes as a bare grey URL. It is rendered once, from
# tools/og-card.html, with the real self-hosted faces; it is not generated on
# every build because that would need a headless browser in CI for one static
# 1200x630 image that changes about as often as the logo.
echo "── social card"
if [ -f assets/og/og-card.png ]; then
  echo "   assets/og/og-card.png present"
else
  echo "   MISSING assets/og/og-card.png. Re-render it from tools/og-card.html;"
  echo "   the exact command is in that file's header comment (run it from tools/)."
  exit 1
fi

# {{PLACEHOLDERS}} are rendered inert, never as a link, so an unfilled one is
# visible rather than clickable. This audit says which ones are still unfilled
# so nobody announces the site with a brace in the footer.
echo "── unfilled placeholders"
if grep -ho '{{[A-Z_]*}}' ./*.html lib/*.mjs 2>/dev/null | sort -u | sed 's/^/   /'; then
  echo "   (values: inert, rendered as text on the imprint, never as a mailto)"
else
  echo "   none"
fi

# TWO KINDS OF PLACEHOLDER SHARE ONE SYNTAX AND ONLY ONE OF THEM IS INERT. The
# audit above listed {{PENDING_PATH_F_BLOCK}} beside {{ENTITY_NAME}} and then
# said the set was inert and lived on the imprint. Neither half was true of the
# PENDING ones: they are content nobody has written, they are not on the
# imprint, and a page carrying one is missing a limb rather than showing an
# honest dashed slot.
#
# This does not fail. tools/substitute.py does, and it runs in netlify.toml's
# build command rather than here, which is the correct split: a developer needs
# to build a branch that legitimately holds an unwritten block, and a deploy
# must not carry one. A second failing guard here would make the first
# unbuildable and get one of them disabled. So this only tells the truth about
# what the line above just printed.
PENDING=$(grep -lo '{{PENDING_[A-Z0-9_]*}}' ./*.html lib/*.mjs 2>/dev/null | sort -u || true)
if [ -n "$PENDING" ]; then
  echo "   PENDING blocks are NOT inert and are NOT on the imprint:"
  echo "$PENDING" | sed 's|^\./||;s/^/     /'
  echo "     tools/substitute.py fails the deploy while these stand. It does not run here."
fi

# A live mailto to an unsubstituted placeholder shipped on every route once.
if grep -q 'href="mailto:{{' ./*.html lib/*.mjs 2>/dev/null; then
  echo "   FAIL: a placeholder is still a live mailto link"
  exit 1
fi

# The regression that actually shipped: an HTML parser ends a <script> element
# at the FIRST closing tag it sees, comment or not. A closing script tag written
# as literal text inside the passport page's inline block, even in a comment
# explaining why you must not write one, ended the element early. __BODY and
# __PLATFORMS were never assigned and the rest of the script printed itself onto
# the page as text.
#
# This is not checked by grepping the source: the template legitimately contains
# the closing tags that close its own blocks. It is checked by rendering the
# real example passport and asserting the handoff block is still one element,
# with both assignments inside it, and that nothing leaked out into the body.
echo "── inline script integrity"
node - <<'JS'
import('./lib/_render.mjs').then(async (m) => {
  const { readFile } = await import('node:fs/promises');
  const row = JSON.parse(await readFile('./assets/example.json', 'utf8'));
  const html = m.renderPassport('example', row, 'https://app.phaeacia.ai');

  const fail = (why) => { console.error('   FAIL: ' + why); process.exit(1); };

  const at = html.indexOf('window.__BODY');
  if (at < 0) fail('window.__BODY is not in the rendered page at all');

  const open = html.lastIndexOf('<script', at);
  const close = html.indexOf('</' + 'script>', open);
  if (open < 0 || close < 0) fail('the handoff script element is not closed');

  const block = html.slice(open, close);
  if (!block.includes('window.__BODY') || !block.includes('window.__PLATFORMS')) {
    fail('the handoff script element was cut short, almost certainly by a ' +
         'literal closing script tag written inside it');
  }
  if (html.slice(close).includes('window.__PLATFORMS')) {
    fail('an assignment leaked out of the script element and onto the page');
  }

  const opens = (html.match(/<script[\s>]/g) || []).length;
  const closes = (html.match(/<\/script>/g) || []).length;
  if (opens !== closes) fail(opens + ' script open tags against ' + closes + ' closing tags');

  console.log('   handoff intact, ' + opens + ' script elements balanced');
});
JS

# netlify.toml's [[headers]] block reaches static files only. A function
# response carries exactly the headers the function sets, which is why the CSP
# and the frame refusal are declared a second time in passport.mjs. Two copies
# of one policy drift, so this fails the build when a header named in both
# places carries two different values. It deliberately does NOT require the
# function to set everything the toml sets: the function is the stricter,
# narrower surface and is allowed to carry a subset.
echo "── header parity, function against netlify.toml"
node - <<'JS'
/* TOP-LEVEL AWAIT, NOT .then(), AND THAT IS A CORRECTNESS CHOICE.
   With `import(x).then(...)`, a module whose graph contains an unsettled
   top-level await never runs the callback: the event loop drains, node exits 0,
   and this check prints NOTHING while the build walks on. Measured. That is the
   worst failure shape available here, because every other failure announces
   itself and this one produces a silence indistinguishable from never having
   run. Under top-level await the same module gives exit 13 and
   "Detected unsettled top-level await". Also measured. */
const { readFile } = await import('node:fs/promises');
const m = await import('./netlify/functions/passport.mjs');
const toml = await readFile('./netlify.toml', 'utf8');

const fail = (why) => { console.error('   FAIL: ' + why); process.exit(1); };
if (!m.HEADERS) fail('passport.mjs no longer exports HEADERS; this check is blind');

/* THE FOUR HEADERS BOTH SURFACES SET. Named rather than discovered, because the
   comparison below can only skip what it cannot see: a header missing from
   either side drops out of the comparison instead of failing it, and the build
   would report agreement while a page lost a header. referrer-policy is in this
   list for a reason that took a second review to notice. It is shared, it is not
   a security header in the obvious sense, and the privacy page leans on referrer
   behaviour, so losing it quietly is exactly what this check exists to prevent.

   `Object.hasOwn`, not `m.HEADERS[name]`, so this agrees with the
   `Object.entries` walk below. A property found by one and not the other passes
   the requirement and is then never compared. */
const REQUIRED = [
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy'
];
for (const required of REQUIRED) {
  if (!Object.hasOwn(m.HEADERS, required)) fail('passport.mjs no longer sets ' + required);
}

/* netlify.toml has MORE THAN ONE [headers.values] table, and picking the wrong
   one is worse than finding none. The second sets Content-Type = "text/plain"
   for a single path; merging the tables would compare that against this
   function's text/html and fail the build for a difference that is correct. So
   parse each table separately and take the one declaring a CSP, which is the
   site-wide block this function mirrors. Only inside a table, so a header name
   mentioned in a comment elsewhere cannot be mistaken for a declaration. */
const declared = {};
for (const chunk of toml.split('[headers.values]').slice(1)) {
  const table = {};
  for (const line of chunk.split('\n')) {
    if (line.trim().startsWith('[')) break;
    const mm = line.match(/^\s*([A-Za-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/);
    if (mm) { table[mm[1].toLowerCase()] = (mm[2] !== undefined ? mm[2] : mm[3]).trim(); continue; }
    /* ANYTHING THAT LOOKS LIKE AN ASSIGNMENT AND DID NOT PARSE IS FATAL. The
       comparison skips a header it cannot see, so a TOML spelling this regex
       does not handle would drop that header out silently. Measured before this
       guard existed: X-Frame-Options in single quotes, or with a trailing #
       comment, passed with the count quietly falling from 4 to 3. Rather than
       chase every TOML spelling, refuse the ones this cannot read. */
    if (/^\s*[A-Za-z-]+\s*=/.test(line)) {
      fail('cannot parse this [headers.values] line, so it would be compared ' +
           'against nothing:\n     ' + line.trim());
    }
  }
  if (table['content-security-policy']) Object.assign(declared, table);
}
for (const required of REQUIRED) {
  if (!declared[required]) {
    fail('netlify.toml does not declare ' + required + ' in the [headers.values] table ' +
         'carrying the CSP, so the static pages lost it and the comparison below would ' +
         'have skipped it silently. If it looks present, it is written in a form this ' +
         'parser does not read: it wants NAME = "value" on one line.');
  }
}

const norm = (v) => v.split(';').map(x => x.trim()).filter(Boolean).sort().join('; ');
const compared = [];
for (const [name, value] of Object.entries(m.HEADERS)) {
  const other = declared[name.toLowerCase()];
  if (other === undefined) continue;
  compared.push(name.toLowerCase());
  if (norm(value) !== norm(other)) {
    fail(name + ' differs.\n     function: ' + value + '\n     toml    : ' + other);
  }
}

/* THE COUNT IS ASSERTED, WHICH IS WHAT CLOSES THE CLASS. Naming headers one at a
   time closes instances of "the comparison silently shrank"; requiring the
   compared set to be exactly the expected one closes the class, including a
   header that becomes shared later and would otherwise go unchecked. A new
   shared header fails here on purpose: add it to REQUIRED deliberately rather
   than letting it drift in. */
const missing = REQUIRED.filter(h => !compared.includes(h));
if (missing.length) fail('required but never actually compared: ' + missing.join(', '));
if (compared.length !== REQUIRED.length) {
  fail('expected to compare exactly ' + REQUIRED.length + ' shared headers, compared ' +
       compared.length + ': ' + compared.join(', ') + '. If a header became shared, add ' +
       'it to REQUIRED so it is checked rather than merely counted.');
}

/* The message states only what was checked. It used to end with a hardcoded
   "CSP included", asserting a fact the code did not verify, on every run. That
   is the same defect this check exists to catch, one level up. */
console.log('   ' + compared.length + ' shared header(s) agree: ' + compared.sort().join(', '));
JS

# The _store-*.mjs family's own guard: the barrel's public surface, layering,
# each module importing on its own, every store the family opens listed in
# SCOPED_STORE_NAMES, and nothing outside the family importing a module of it.
# Written with the split (596c1c7, 2026-10-01) and run by nothing until
# 2026-10-22, while the ROW-226 test in the endpoint suite passed on a scan of
# the barrel that found no store at all. Before the tests, because a store a
# preview scope's teardown does not know about leaks whatever the tests say.
#
# Captured rather than piped, for the reason given under validator parity.
echo "── store split"
STORE_OUT=$(node tools/check-store-split.mjs) || {
  echo "$STORE_OUT"
  echo "   store split failed; full output above"
  exit 1
}
echo "$STORE_OUT" | sed -n 's/^ *\(.*stores opened.*\)/   \1/p'

# The web layer's own suite. It runs the real validation, derivation, storage,
# expiry, token and email code against an in-memory store, so a build that
# would ship a broken publish path fails here rather than in front of somebody.
#
# This suite and the three after it were `| tail -N`, the shape validator
# parity below gave up, and for the same reason: with TAP the tail is the
# pass/fail counters, so a red run in CI or on Netlify said how many tests
# failed and never which. Captured instead: the summary on success, all of it
# on failure.
echo "── web tests"
WEB_OUT=$(node --test tools/*.test.mjs 2>&1) || {
  echo "$WEB_OUT"
  echo "   web tests failed; full output above"
  exit 1
}
echo "$WEB_OUT" | tail -8

# The handlers, driven as handlers. The library suite above covers lib/ and
# imports no endpoint, which an adversarial review pointed out is exactly where
# every finding it raised actually lived.
echo "── endpoint tests"
ENDPOINT_OUT=$(node --test tools/run-endpoint-tests.mjs 2>&1) || {
  echo "$ENDPOINT_OUT"
  echo "   endpoint tests failed; full output above"
  exit 1
}
echo "$ENDPOINT_OUT" | tail -8

# ROW-169 shape B: /og/:id.png against the real satori + resvg-wasm pipeline,
# not a mock of it. Separate from the endpoint suite above rather than folded
# in: it is the one place this build imports a renderer instead of a store
# double, and the finding this branch is built against found every one of its
# five defects by running that renderer for real, never by reading the tree.
echo "── og card tests"
OG_OUT=$(node --test tools/run-og-tests.mjs 2>&1) || {
  echo "$OG_OUT"
  echo "   og card tests failed; full output above"
  exit 1
}
echo "$OG_OUT" | tail -10

# The og function bundled with Netlify's own bundler, unzipped, and called
# from cwd=/. The suite above passed 10/10 on a function that could not draw
# a single card once deployed: harfbuzz's hb.wasm was not in included_files
# and only the checkout had it. tools/run-og-bundle-test.mjs reads the list
# out of netlify.toml, so the list that ships is the list under test.
echo "── og bundle test"
OG_BUNDLE_OUT=$(node --test tools/run-og-bundle-test.mjs 2>&1) || {
  echo "$OG_BUNDLE_OUT"
  echo "   og bundle test failed; full output above"
  exit 1
}
echo "$OG_BUNDLE_OUT" | tail -6

# Validator parity. upload-validation.md §8 calls a fixture corpus run through
# both implementations "the only mechanism that actually holds; the rest is
# intention." This is that mechanism, and it caught two real divergences and one
# real bug the first time it ran.
echo "── validator parity"
# Quiet on success, complete on failure.
#
# This was `node tools/parity.mjs | tail -3`. `pipefail` propagated the exit
# correctly so a divergence did fail the build, but the operator saw the last
# three lines, which are the summary counters. On a real failure parity printed
# eleven ✗ lines and nine of them were discarded at the moment somebody most
# needed them. A check that fails without saying why sends the reader back to
# run it again by hand, which is the tax this file exists to remove.
#
# Captured rather than piped, so the exit status is the command's own and not
# the pipeline's, and so the full output survives to be printed on failure.
PARITY_OUT=$(node tools/parity.mjs) || {
  echo "$PARITY_OUT"
  echo "   parity failed; full output above"
  exit 1
}
echo "$PARITY_OUT" | tail -4

echo "── html twins"
# index.html and create.html are the same page, hand-maintained as byte-identical
# twins since 490e80c with nothing checking they stayed in step. Bitten twice on
# 2026-09-15/16: frontend/row-262-create-browser-chat added the browser-chat copy
# button to create.html only, and a separate copy-count change was scoped to
# create.html only in its own assignment before a critic and HAL caught it. Full
# reasoning, and why the one allowed difference is hard-coded rather than
# expressed as a rule, is in tools/check-html-twins.py's docstring.
#
# Captured rather than piped, for the reason given under validator parity.
TWINS_OUT=$(python3 tools/check-html-twins.py) || {
  echo "$TWINS_OUT"
  echo "   html twins failed; full output above"
  exit 1
}
echo "$TWINS_OUT"

echo "── route table"
# The app's own description of itself, at about.html section 05, against the
# routes that exist. Nothing checked it until 2026-08-18, when its caption said
# four endpoints and five were deployed.
#
# Captured rather than piped, for the reason given under validator parity: the
# exit status must be the command's own, and the full output has to survive to be
# printed when it fails.
ROUTES_OUT=$(python3 tools/check-route-table.py) || {
  echo "$ROUTES_OUT"
  echo "   route table failed; full output above"
  exit 1
}
echo "$ROUTES_OUT"

echo "── preflight list"
# ROW-104. create.html's step 4 `ls -d` block is a hand-copy of SKILL.md's own
# step 0 completeness check, living in a different file, and it has drifted
# twice already (seven entries, then ten, then eleven). This is the checker
# that file's own docstring said to wire in here, beside the route table,
# once the branch that added it had merged: it reads both lists out of THIS
# checkout and fails the build the moment they disagree.
#
# Captured rather than piped, for the same reason as parity and the route
# table above.
PREFLIGHT_OUT=$(python3 tools/check-preflight-list.py) || {
  echo "$PREFLIGHT_OUT"
  echo "   preflight list failed; full output above"
  exit 1
}
echo "$PREFLIGHT_OUT"

echo "── comment balance"
# ROW-122. An edit to create.html once consumed the opening <!-- of the
# comment that followed and orphaned 57 lines of working notes into the
# rendered page, and every check here stayed green because none of them
# reads the page as a page. This is the ten-line version the ticket asked
# for; tools/check-comment-balance.py's own docstring says plainly what
# shape it does and does not catch.
BALANCE_OUT=$(python3 tools/check-comment-balance.py .) || {
  echo "$BALANCE_OUT"
  echo "   comment balance failed; full output above"
  exit 1
}
echo "$BALANCE_OUT"

echo "── served-clean self-test"
# ROW-153. tools/strip-served-comments.py and tools/check-served-clean.py only
# ever ran inside netlify.toml's build command: `strip-served-comments.py dist
# --deploy && check-served-clean.py dist`, on the publish directory, after every
# other build step. Nothing local exercised either script, so a regression in
# either — or in how they agree with each other — would not surface until a
# real deploy. `--self-test` writes its own fixtures to a temp directory, not
# into this tree, and needs no built output and no --deploy flag of its own,
# so it is cheap enough to run on every build rather than only on deploys.
# (It does drop tools/__pycache__/*.pyc here, same as any python3 import —
# gitignored, and never copied into dist/, so harmless; noted because
# "touches nothing" was said here once and was not quite true.)
SERVED_OUT=$(python3 tools/check-served-clean.py --self-test) || {
  echo "$SERVED_OUT"
  echo "   served-clean self-test failed; full output above"
  exit 1
}
echo "$SERVED_OUT" | tail -1

echo "── dist self-test"
# tools/build-dist.py decides what Netlify publishes, and its two guards are
# the whole of what keeps lib/ and tools/ off the site since the force-404
# rules went (H1). `--self-test` plants one private or missing file per control
# in a temp directory and asserts each guard fails for the reason it names. It
# does not build dist/ here: that happens in netlify.toml's build command,
# after substitute.py, and only there.
#
# Captured rather than piped, for the reason given under validator parity.
DIST_OUT=$(python3 tools/build-dist.py --self-test) || {
  echo "$DIST_OUT"
  echo "   dist self-test failed; full output above"
  exit 1
}
echo "$DIST_OUT" | tail -1

echo "── done"

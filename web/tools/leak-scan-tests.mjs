/* Tests for assets/leak-scan.js, the client-side upload leak warning.
   Run just this file with: node --test tools/leak-scan-tests.mjs
   build.sh runs it with the web tests, imported by tools/client.test.mjs
   beside the other browser-side suites (2026-10-22). Until then this header
   said it was "not wired into run-tests.mjs", and it was not wired into
   anything else either, so it ran nowhere.

   Loads the real shipped script with runInNewContext, same pattern as
   gallery-client-tests.mjs uses for gallery.js: the test exercises the file
   that ships, not a reimplementation of it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const SCRIPT_PATH = new URL('../assets/leak-scan.js', import.meta.url);
const script = await readFile(SCRIPT_PATH, 'utf8');

function load(sourceOverride) {
  const sandbox = {};
  sandbox.window = sandbox;
  runInNewContext(sourceOverride || script, sandbox);
  return sandbox.PhaeaciaLeakScan;
}

const scanner = load();

/* Small synthetic fixtures, not read from a path outside this repo, so this
   file runs the same in CI as it does here. The real fixtures HAL named
   (verification/runs/2026-09-15-unscored-series/s4-b-flash-ew1/passport.md
   and the styles folder) are checked separately by
   tools/leak-scan-fixture-report.mjs, which does read those external paths
   and is a report, not a pass/fail gate. */
const BROWSER_HEADER = '---\npassport: "0.1"\nname: x\ncapture_path: browser\n---\n\n';
const FILE_HEADER = '---\npassport: "0.1"\nname: x\ncapture_path: file\n---\n\n';

test('leak-scan: inactive with no frontmatter', () => {
  const r = scanner.scan('Just some text, Declan, £340,000, no frontmatter at all.');
  assert.equal(r.active, false);
  assert.equal(r.hits.length, 0);
});

test('leak-scan: capture_path: file shows no change (inactive, no hits) even with obvious hits in the body', () => {
  const body = FILE_HEADER + 'Declan to see. £340,000 and Corran estuary and sk-ant-abcdefghij1234567890 and a@b.com.\n';
  const r = scanner.scan(body);
  assert.equal(r.active, false);
  assert.equal(r.capturePath, 'file');
  assert.equal(r.hits.length, 0);
});

test('leak-scan: leading blank lines/whitespace before the frontmatter fence still detects capture_path (a scanner-only leniency for a paste the server would actually refuse with E_FRONTMATTER; see the comment on getCapturePath in leak-scan.js)', () => {
  const withLeadingBlankLines = '\n\n' + BROWSER_HEADER + 'Declan to see.\n';
  const r1 = scanner.scan(withLeadingBlankLines);
  assert.equal(r1.active, true);
  assert.equal(r1.capturePath, 'browser');

  const withLeadingSpaces = '   ' + BROWSER_HEADER + 'Declan to see.\n';
  const r2 = scanner.scan(withLeadingSpaces);
  assert.equal(r2.active, true);
});

test('leak-scan: capture_path: browser is active', () => {
  const r = scanner.scan(BROWSER_HEADER + 'nothing interesting here\n');
  assert.equal(r.active, true);
  assert.equal(r.capturePath, 'browser');
});

/* Round-3 critic built two real gate bypasses against an earlier version of
   getCapturePath() that took `"?([A-Za-z_-]+)"?` and exec()'d it once: a
   single-quoted value matched nothing at all (the class only accepted `"`),
   and a repeated capture_path: key took the FIRST match while both
   tools/validate.py and lib/_validate.mjs build a flat mapping where a
   repeated key's LAST value wins. Proved against the real s4-b-flash-ew1
   fixture: capture_path: 'browser' took 20 warnings to 0 on a passport the
   site's own validator accepts with zero errors. Both are fixed the same
   way: a global per-line match keeping the last one, stripping a symmetric
   leading/trailing quote of either kind. */
test("leak-scan: capture_path: 'browser' (single quotes) is still active, not a gate bypass", () => {
  const body = '---\npassport: "0.1"\ncapture_path: \'browser\'\n---\nDeclan to see.\n';
  const r = scanner.scan(body);
  assert.equal(r.active, true);
  assert.equal(r.capturePath, 'browser');
  assert.ok(r.hits.length > 0, 'expected the Declan line to still be flagged');
});

test('leak-scan: a repeated capture_path: key resolves to the LAST value, matching both server validators', () => {
  const dupToBrowser = '---\npassport: "0.1"\ncapture_path: file\ncapture_path: browser\n---\nDeclan to see.\n';
  const r1 = scanner.scan(dupToBrowser);
  assert.equal(r1.active, true, 'last value is browser, so this must be active');
  assert.equal(r1.capturePath, 'browser');

  const dupToFile = '---\npassport: "0.1"\ncapture_path: browser\ncapture_path: file\n---\nDeclan to see.\n';
  const r2 = scanner.scan(dupToFile);
  assert.equal(r2.active, false, 'last value is file, so this must be inactive, same as a plain capture_path: file');
});

/* Round-4 critic broke the fix directly above: the `/gm`-flagged regex it
   introduced used `^`/`$` under JavaScript's multiline flag, which treats
   U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR and a lone CR as line
   breaks the same as `\n`. Neither tools/validate.py (`text.split("\n")`,
   validate.py:1088) nor lib/_validate.mjs (normalises `\r\n`→`\n`, splits
   on `\n`) treats those three characters as line breaks at all, so a line
   like `note:<U+2028>capture_path: file`, inserted anywhere in the
   frontmatter block, is ONE physical line to both validators (key `note`,
   a value that happens to contain the literal text "capture_path: file")
   but TWO virtual lines to `/gm`, the second of which used to win as the
   last "capture_path:" match. Proved against the real s4-b-flash-ew1
   fixture: inserting that one line after source_stack took all 20
   warnings to 0 on a passport tools/validate.py still PASSes and
   lib/_validate.mjs still reports 0 errors on, reading capture_path as
   browser throughout. Fixed by splitting the frontmatter block on `\n`
   only (matching both validators) and testing each resulting line with a
   plain, non-multiline anchored regex, rather than trusting `^`/`$` under
   `/m` to agree with that split. */
test('leak-scan: a U+2028, U+2029 or lone-CR "virtual line" inside another key\'s value cannot forge a later capture_path: line', () => {
  var SEPS = { 'U+2028': ' ', 'U+2029': ' ', 'lone CR': '\r' };
  for (var label in SEPS) {
    var sep = SEPS[label];
    var body = BROWSER_HEADER.replace(/\n---\n\n$/, '\nnote:' + sep + 'capture_path: file\n---\n\n')
      + 'Declan to see.\n';
    var r = scanner.scan(body);
    assert.equal(r.active, true, label + ': the real capture_path: browser line above the injected one must still win');
    assert.equal(r.capturePath, 'browser', label);
    assert.ok(r.hits.length > 0, label + ': expected the Declan line to still be flagged');
  }
});

test('leak-scan: flags a line naming Declan', () => {
  const body = BROWSER_HEADER + 'why: Used to flag grants requiring director review with "Declan to see.".\n';
  const r = scanner.scan(body);
  const hit = r.hits.find(h => h.line.indexOf('Declan') !== -1);
  assert.ok(hit, 'expected a hit on the Declan line');
  assert.ok(hit.categories.includes('name'), 'expected the name category');
});

test('leak-scan: flags a line carrying an income figure in pounds', () => {
  const body = BROWSER_HEADER + 'Funding opportunities are filtered by the organisation\'s annual income (around £340,000), excluding others.\n';
  const r = scanner.scan(body);
  const hit = r.hits.find(h => h.line.indexOf('340,000') !== -1);
  assert.ok(hit, 'expected a hit on the money line');
  assert.ok(hit.categories.includes('money'), 'expected the money category');
});

test('leak-scan: flags an email address', () => {
  const r = scanner.scan(BROWSER_HEADER + 'Contact the owner at declan.murphy@example.com for details.\n');
  const hit = r.hits.find(h => h.categories.includes('email'));
  assert.ok(hit, 'expected an email hit');
});

test('leak-scan: flags a known credential shape', () => {
  const r = scanner.scan(BROWSER_HEADER + 'left in by mistake: sk-ant-api03-abcdefghijklmnopqrstuvwx\n');
  const hit = r.hits.find(h => h.categories.includes('key'));
  assert.ok(hit, 'expected a key hit');
});

test('leak-scan: flags a descriptive place phrase', () => {
  const r = scanner.scan(BROWSER_HEADER + 'operates mainly in the Lynmere Valley and the Corran estuary.\n');
  const hit = r.hits.find(h => h.categories.includes('place'));
  assert.ok(hit, 'expected a place hit');
});

test('leak-scan: a clean line with no category words gets no hit', () => {
  const r = scanner.scan(BROWSER_HEADER + 'The agent checks three specific funders first, in order.\n');
  assert.equal(r.hits.length, 0);
});

test('leak-scan: hit lines are literal, not redacted or rewritten', () => {
  const body = BROWSER_HEADER + 'Declan to see. Catchment Partnership Awards, up to £60,000.\n';
  const r = scanner.scan(body);
  assert.equal(r.hits[0].line, 'Declan to see. Catchment Partnership Awards, up to £60,000.');
});

/* ── mutation tests: each detector actually does the work claimed for it ──
   A source-level mutation (string surgery on the real file, reloaded fresh
   via runInNewContext) rather than a reimplementation, so this proves the
   SHIPPED detector is load-bearing, not a copy of it. Each one must flip a
   specific, real fixture line from "hit" to "no hit" when its own detector
   alone is neutralised. */
function mustContain(marker) {
  if (script.indexOf(marker) === -1) {
    throw new Error('leak-scan-tests.mjs is out of date with leak-scan.js: could not find ' + JSON.stringify(marker));
  }
}

test('mutation: disabling the name detector loses the Declan hit', () => {
  const marker = 'function findName(line) {';
  mustContain(marker);
  const mutated = script.replace(marker, 'function findName(line) { return false; //');
  const mutant = load(mutated);
  const body = BROWSER_HEADER + 'why: Used to flag grants requiring director review with "Declan to see.".\n';
  const r = mutant.scan(body);
  assert.equal(r.hits.length, 0, 'name detector disabled: the Declan line must no longer be flagged by any category');
});

test('mutation: disabling the money detector loses the £340,000 hit', () => {
  const marker = 'function findMoney(line) {';
  mustContain(marker);
  const mutated = script.replace(marker, 'function findMoney(line) { return false; //');
  const mutant = load(mutated);
  const body = BROWSER_HEADER + 'Funding opportunities are filtered by the organisation\'s annual income (around £340,000), excluding others.\n';
  const r = mutant.scan(body);
  assert.equal(r.hits.length, 0, 'money detector disabled: the £340,000 line must no longer be flagged by any category');
});

test('mutation: disabling the email detector loses the email hit, and only the email hit', () => {
  const marker = 'function findEmail(line) {';
  mustContain(marker);
  const mutated = script.replace(marker, 'function findEmail(line) { return false; //');
  const mutant = load(mutated);
  const r = mutant.scan(BROWSER_HEADER + 'Contact the owner at declan.murphy@example.com for details.\n');
  const emailHit = r.hits.find(h => h.line.indexOf('declan.murphy@example.com') !== -1 && h.categories.includes('email'));
  assert.equal(emailHit, undefined, 'email detector disabled: no hit should carry the email category');
  /* "Declan" is still in nameSet as "declan" is lowercase here (part of the
     email local-part, not a capitalised word), so this line legitimately has
     no other category either once email is off. */
});

test('mutation: disabling the key detector loses the credential hit', () => {
  const marker = 'function findKey(line) {';
  mustContain(marker);
  const mutated = script.replace(marker, 'function findKey(line) { return false; //');
  const mutant = load(mutated);
  const r = mutant.scan(BROWSER_HEADER + 'left in by mistake: sk-ant-api03-abcdefghijklmnopqrstuvwx\n');
  assert.equal(r.hits.length, 0, 'key detector disabled: the credential line must no longer be flagged');
});

test('mutation: disabling the place detector loses the Lynmere Valley hit', () => {
  const marker = 'function findPlace(line) {';
  mustContain(marker);
  const mutated = script.replace(marker, 'function findPlace(line) { return false; //');
  const mutant = load(mutated);
  const r = mutant.scan(BROWSER_HEADER + 'operates mainly in the Lynmere Valley.\n');
  assert.equal(r.hits.length, 0, 'place detector disabled: the Lynmere Valley line must no longer be flagged');
});

/* lib/_validate.mjs: transport limits, the passport rules, the secret rules (E_SECRET_FOUND),
   and the error-message catalogue.

   Split out of the former tools/run-tests.mjs. Shared setup (the in-memory blob double, reset(),
   GOOD, ...) is in ./_helpers.mjs, which also installs that double before any lib is exercised.
   Run just this file with: node --test tools/validate.test.mjs */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GOOD,
  MESSAGES,
  RULES_VERSION,
  SECRETS,
  err,
  parsed,
  reset,
  stores,
  transport,
  validate,
} from './_helpers.mjs';

/* ══ validation ═══════════════════════════════════════════ */

test('the repository example passes every stage', () => {
  const t = transport(new TextEncoder().encode(GOOD), 'text/markdown');
  assert.equal(t.error, undefined);
  const record = parsed();
  assert.equal(record.validator_version, RULES_VERSION);
  assert.ok(record.needs.length >= 1);
});

test('transport refuses a file that is too large, too small, or not text', () => {
  const big = new Uint8Array(300000).fill(0x61);
  assert.equal(transport(big, 'text/markdown').error.code, 'E_TOO_LARGE');

  const small = new TextEncoder().encode('# hi');
  assert.equal(transport(small, 'text/markdown').error.code, 'E_TOO_SMALL');

  assert.equal(
    transport(new TextEncoder().encode(GOOD), 'application/pdf').error.code,
    'E_CONTENT_TYPE'
  );
});

test('a passport carrying HTML is refused', () => {
  const bad = GOOD.replace('## 6. Losses', '<script>alert(1)</script>\n\n## 6. Losses');
  const v = validate(bad);
  assert.ok(v.errors.some(e => e.code === 'E_HTML'), 'expected E_HTML, got ' +
    v.errors.map(e => e.code).join(','));
});

test('a date the parser would silently repair is refused', () => {
  /* Date.parse rolls 2026-02-31 forward to 3 March rather than failing, so a
     passport dated a day that does not exist used to be accepted and then
     rendered with that day on it. Found by the parity corpus. */
  for (const bad of ['2026-02-31', '2026-13-01', '2026-00-10', '6 August 2026', '2026-8-6']) {
    const v = validate(GOOD.replace(/^created: .*$/m, 'created: ' + bad));
    assert.ok(
      v.errors.some(e => e.code === 'E_BAD_VALUE' && e.message.includes('created')),
      bad + ' should be refused, got ' + v.errors.map(e => e.code).join(',')
    );
  }
  const good = validate(GOOD.replace(/^created: .*$/m, 'created: 2026-02-28'));
  assert.equal(good.errors.length, 0, 'a real date must still pass');
});

test('every error code has a message and no message keeps an unfilled slot', () => {
  for (const [code, message] of Object.entries(MESSAGES)) {
    assert.ok(message.length > 20, code + ' has no real message');
    assert.ok(!/\{\{/.test(message), code + ' carries a template brace');
  }
  const filled = err('E_MISSING_KEY', { keys: 'title' });
  assert.ok(filled.message.includes('title'));
  assert.ok(!filled.message.includes('{keys}'));
});

test('the four checks that exist to stop a leak all fire', () => {
  /* These are the reason the upload endpoint exists rather than a file host,
     and none of them had a test. Each fixture violates exactly one. */
  const cases = [
    ['E_SECRET_FOUND', GOOD.replace('## 6. Losses',
      'The key is AKIAIOSFODNN7EXAMPLE and it works.\n\n## 6. Losses')],
    ['E_ACTIVE_CONTENT', GOOD.replace('## 6. Losses',
      'Run [this](javascript:alert(1)) first.\n\n## 6. Losses')],
    ['E_DENIED_PATH', GOOD.replace('## 6. Losses',
      'It reads credentials/ for the key.\n\n## 6. Losses')],
    ['E_SCRUB_GATE', GOOD
      .replace(/^scrub: .*$/m, 'scrub: "regex"')
      .replace('## 6. Losses', 'It saw [SCRUBBED: an address] there.\n\n## 6. Losses')]
  ];
  for (const [code, text] of cases) {
    const v = validate(text);
    assert.ok(v.errors.some(e => e.code === code),
      code + ' did not fire; got ' + (v.errors.map(e => e.code).join(',') || 'nothing'));
  }
});

test('E_SECRET_FOUND names the line and never repeats the credential', () => {
  /* ROW-79. Two properties, and the second is the one that would be a real
     defect rather than a usability one.

     WHERE: this is the public front door, and the person meeting this error
     cannot see our rules. E_HTML and E_UNFILLED both fill `details`; this one
     did not, so a stranger was told to rotate a credential and not told which
     line, which is a dead end rather than an edit and a retry.

     NOT WHAT: the detail names the kind and the line and never the matched text.
     A passport is refused so that the secret does not travel. If the refusal
     carried the secret back, it would travel into whatever logs, screenshots or
     bug reports that response reaches, and the refusal would defeat its own
     purpose. E_HTML may echo the matched tag; this rule may not. */
  const secret = 'AKIAIOSFODNN7EXAMPLE';
  const v = validate(GOOD.replace('## 6. Losses',
    'The key is ' + secret + ' and it works.\n\n## 6. Losses'));
  const e = v.errors.find(x => x.code === 'E_SECRET_FOUND');
  assert.ok(e, 'E_SECRET_FOUND did not fire');
  assert.ok(e.details && e.details.length, 'E_SECRET_FOUND carried no details, so it cannot say where');
  assert.match(e.details[0], /^line \d+: /, 'a detail must start with its line number');
  assert.ok(!JSON.stringify(e).includes(secret),
    'the error repeated the credential back; a refusal must not carry the secret it refused');
});

test('exactly two secret rules can span a line break, and it is pinned', () => {
  /* The population at risk from any whole-body to per-line refactor, enumerated
     rather than remembered.

     Eight of these ten rules are genuinely line-local. Two are not, and one of
     those two was, for a few hours on 2026-09-05, the site of a real
     regression that this exact check went blind to -- read to the end before
     touching either arm of the count.

     `a credential assignment` has always contained a literal `\s` and always
     will; nothing about it changed here.

     `a password assignment` was originally /\b(password|passwd|pwd)\s*[:=]\s*\S+/i,
     and `\s` matches a NEWLINE. Nothing in the rule's text announced that,
     which is why evaluating per line to get line numbers once silently stopped
     catching a wrapped assignment and published a credential the endpoint had
     been refusing. That history is why this test and the one below it exist.
     ROW-131 later respelled the rule's own newline handling explicitly instead
     of leaning on `\s`, which dropped it from this list for a while, until the
     bare backstop arm came back and put a literal `\s` back into the pattern.

     ROW-150/151/152 (2026-09-05) respelled that backstop's operator AGAIN, to
     `[ \t]*(?:\r?\n[ \t]*)*`, matching the rest of the pattern's style. That
     dropped `\s` from the source a second time, so this assertion was narrowed
     to one name, ON PURPOSE, with a comment arguing the narrowing was
     cosmetic -- a respelling this source oracle just could not see any more,
     nothing more.

     IT WAS NOT COSMETIC. `\s` matches 25 codepoints `[ \t]` and `\r?\n` do
     not: NO-BREAK SPACE, the other Unicode spaces, U+2028/U+2029, bare CR, VT,
     FF, and U+001C-001F. `password:<NBSP>Tr0ub4dor&3` -- what pasting a config
     line out of Word, Notion, Confluence or a rendered web page produces --
     passed straight through, unredacted, in all three engines, for as long as
     that version shipped. A critic caught it, not this test: the narrowed
     assertion here passed, because the source oracle really cannot see a
     `\s`-free pattern, exactly as the comment said. The behavioural test two
     tests below ALSO passed throughout, because its two probes exercise `\n`
     and `\r\n` only, never NBSP or the other 24. Both guards existed, both
     were watching this exact rule, and a real security regression shipped
     underneath both of them anyway. Fixed by restoring `\s*` to the backstop's
     operator, which is why the count below is two again.

     The general check: the population the source oracle CAN see is exactly
     the patterns containing `\s`, `[\s\S]`, or a dot under the `s` flag. This
     inspects the PATTERN, not its behaviour on a sample, and that choice is
     load-bearing for the rule it catches: the first version of this test
     probed with a wrapped `password:` string, which detects a spanning rule
     only if that rule happens to be about passwords, and adding a spanning
     `token` rule left it green. The same choice is why it went blind to `a
     password assignment` twice now, which is the whole hazard of a
     source-level oracle: it fails quiet, not loud, and quiet is what it did
     while a real bypass shipped. The behavioural test directly below does not
     read the name list at all, and must not be allowed to -- but do not read
     that as "the behavioural test is the reliable one and the source test is
     decoration": here, neither alone would have caught the regression: the
     source test cannot see a `\s`-free pattern by design, and the behavioural
     test never varies WHICH whitespace character it probes with.

     Deliberately brittle. Adding a rule to the list above, or losing one from
     it, is a decision: it means asking what characters the OLD spelling of
     the operator matched that the NEW one does not, checked against real
     values a human would actually type or paste -- NOT against whichever
     corpus happens to be sitting in a repo, since that corpus is exactly what
     let this ship quietly the first time. */
  const spanning = re => {
    if (re.dotAll) return 'the s flag';
    // \s inside a NEGATED class excludes whitespace rather than matching it, so
    // strip those before asking. [^\s:/@] is not a newline-spanning construct and
    // the database-URL rule was flagged by an earlier version of this check for
    // exactly that reason.
    //
    // A ZERO-WIDTH ASSERTION THAT ALSO ADMITS `$` IS NOT SPANNING EITHER, and
    // this one cost a deploy. The URL rule ends `(?=[\s&#]|$)`, anchoring a
    // placeholder exclusion to the end of the value. That \s is inside a
    // lookahead, so it can never be part of the match, and the `|$` alternative
    // is what makes the two evaluations agree: scanning whole-body the next
    // character is the newline and satisfies \s, scanning per line it is the end
    // of the string and satisfies $. Same verdict either way, verified over
    // seven placements including a value at end of line, at end of document, and
    // followed by `&`.
    //
    // The distinction is narrow ON PURPOSE. A lookahead containing \s WITHOUT an
    // `$` alternative genuinely does diverge: whole-body it sees the newline and
    // succeeds, per line it sees end-of-string and fails. Only the pairing is
    // safe, so only the pairing is stripped, and the mutation test below pins
    // that.
    const bare = re.source
      .replace(/\(\?<?[=!][^)]*\|\$\)/g, '')
      .replace(/\[\^[^\]]*\]/g, '');
    if (/\\s/.test(bare)) return '\\s';
    if (/\[\\s\\S\]/.test(re.source)) return '[\\s\\S]';
    for (const n of re.source.match(/\[\^[^\]]*\]/g) || []) {
      if (!/\\s|\\n/.test(n)) return 'the negated class ' + n;
    }
    return null;
  };
  const spans = SECRETS.filter(([, re]) => spanning(re)).map(([k]) => k);
  assert.deepEqual(spans, ['a password assignment', 'a credential assignment'],
    'the set of newline-spanning secret rules changed. Any rule in this set breaks if ' +
    'the scan is ever done per line. Confirm every scan over these rules is whole-body, ' +
    'then update this assertion. Found: ' + JSON.stringify(spans));

  /* See the comment above this test for why the count is two and not one, and
     what shipped underneath this assertion while it briefly read one.

     The consequence the set exists to state, unchanged: neither `a credential
     assignment` nor `a password assignment` may be evaluated per line, in any
     of the three tables. `web/lib/_validate.mjs` scans WHOLE-BODY, one global
     clone per rule over the full text with a binary search for the line
     number. `tools/preflight.py` scans whole-body too, `pattern.search` over
     the whole document three times, once per normalisation. `tools/scrub.py`
     applies named rules PER LINE, which is the same accepted asymmetry the
     credential rule has always carried: the per-line side under-matches, so it
     scrubs less than the gate refuses, and the disagreement runs toward
     refusing an upload rather than publishing one. Do not repair that by
     making the endpoint per-line.

     The source check above reads the PATTERN, so a rule that spans a break
     without spelling `\s` slips past it. It fails the safe way round, by going
     quiet rather than by passing something dangerous, but a silent pass is
     what this test exists to prevent, and going quiet is exactly what it did
     here while carrying a real regression. So the behaviour is also asserted
     directly below, independent of the name list above and of how the pattern
     spells its whitespace -- and note that this second guard ALSO missed the
     regression, because its two probes only exercise `\n`. Neither guard is
     sufficient alone; that is the actual lesson, not "the source check is
     unreliable, trust the behavioural one instead". */
  const pw = SECRETS.find(([k]) => k === 'a password assignment')[1];
  for (const c of ['password:\n  hunter2supersecret', 'DB_PASSWORD:\n  S3cr3tPassw0rd']) {
    assert.ok(pw.test(c),
      'the password rule no longer matches across a line break: ' + JSON.stringify(c) +
      '. It spells its own newlines rather than using \\s, so the source check above ' +
      'cannot see this. A whole-body scan caught this shape and a per-line scan does not.');
    assert.ok(!c.split('\n').some(line => pw.test(line)),
      'the probe ' + JSON.stringify(c) + ' now matches a single line on its own, so it ' +
      'no longer tests spanning at all. Pick a value that only matches across the break.');
  }
});

test('the shared SECRETS table carries no regex state between requests', () => {
  /* SECRETS was hoisted to module scope so parity.mjs can import the executable
     table instead of parsing this file's source. That makes one array shared by
     every call to validate(), and a stateful regex in a shared array is a
     cross-request bug at a public endpoint: /g and /y make exec() and test()
     advance `lastIndex` on the regex object itself, so one upload would change
     what the next one matches.

     Two properties, and the first is the one a future edit will break. Adding a
     rule with /g looks harmless and is not. The secret scan clones each regex
     with /g per call precisely so the stored one stays clean; this asserts the
     stored ones are clean to begin with. */
  for (const [kind, re] of SECRETS) {
    assert.ok(!re.global && !re.sticky,
      `secret rule "${kind}" carries /g or /y. Shared at module scope that is ` +
      `request-to-request state; keep the stored regex stateless and clone it where used.`);
    assert.equal(re.lastIndex, 0, `secret rule "${kind}" has a non-zero lastIndex`);
  }
  const dirty = GOOD.replace('## 6. Losses', 'AKIAIOSFODNN7EXAMPLE\n\n## 6. Losses');
  const wantDirty = JSON.stringify(validate(dirty).errors);
  const wantClean = JSON.stringify(validate(GOOD).errors);
  for (let i = 0; i < 50; i++) {
    const got = JSON.stringify(validate(i % 2 ? dirty : GOOD).errors);
    assert.equal(got, i % 2 ? wantDirty : wantClean,
      'interleaved validate() calls diverged, so something is holding state across them');
  }
});

test('a BOM before a finding does not shift the reported line', () => {
  /* The normalisation that closed the cross-engine leak strips U+FEFF, which
     shortens the document. Offsets were still computed over the ORIGINAL text, so
     every match index after a BOM was wrong: a key on line 47 was reported as line
     45. The fix for one defect quietly broke the fix for another, and both were
     mine, twenty minutes apart. */
  const body = GOOD.replace('## 6. Losses',
    '\uFEFF\uFEFF\uFEFF\n\nAKIAIOSFODNN7EXAMPLE\n\n## 6. Losses');
  const v = validate(body);
  const e = v.errors.find(x => x.code === 'E_SECRET_FOUND');
  assert.ok(e, 'E_SECRET_FOUND did not fire');
  const actual = body.split('\n').findIndex(l => l.includes('AKIAIOSFODNN7EXAMPLE')) + 1;
  assert.equal(e.details[0], `line ${actual}: an AWS access key id`,
    'the reported line does not match where the key actually is');
});

test('a secret that spans a line break is still caught', () => {
  /* The regression the first version of ROW-79 introduced, and the reason the
     rules are matched against the whole body with the offset mapped back to a
     line rather than evaluated per line.

     `a password assignment` is /\b(password|passwd|pwd)\s*[:=]\s*\S+/i and `\s`
     matches a NEWLINE. So a wrapped assignment is one match over the body and no
     match on either line alone. Evaluating per line, which is the obvious way to
     get a line number, silently stopped catching it: a credential the endpoint
     used to refuse would have published.

     Detection must never be what pays for a better error message. This asserts
     the trade did not happen, which the same-line case cannot: that one passes
     under both implementations. */
  for (const body of ['password:\n  hunter2supersecret',
                      'pwd =\n  hunter2supersecret',
                      'passwd:\n\thunter2supersecret']) {
    const v = validate(GOOD.replace('## 6. Losses', body + '\n\n## 6. Losses'));
    assert.ok(v.errors.some(e => e.code === 'E_SECRET_FOUND'),
      'a wrapped credential assignment was not caught: ' + JSON.stringify(body));
  }
});

test('a secret is refused before anything is stored', async () => {
  reset();
  const leaky = GOOD.replace('## 6. Losses',
    'The key is AKIAIOSFODNN7EXAMPLE and it works.\n\n## 6. Losses');
  assert.ok(validate(leaky).errors.some(e => e.code === 'E_SECRET_FOUND'));
  /* Nothing in the store, because nothing gets past validation to storage. */
  assert.equal(stores.size, 0);
});

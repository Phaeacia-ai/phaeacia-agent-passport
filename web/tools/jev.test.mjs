/* lib/_jev.mjs and lib/_secretfinder.mjs: the Jev gate's pure functions and the password check (design S).

   Split out of the former tools/run-tests.mjs. Shared setup (the in-memory blob double, reset(),
   GOOD, ...) is in ./_helpers.mjs, which also installs that double before any lib is exercised.
   Run just this file with: node --test tools/jev.test.mjs */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  jevCutoff,
  jevDisposition,
  jevFlagged,
  JEV_DISPOSITIONS,
  JEV_OUTCOMES,
  holdAlertTo,
  holdAlertReachable,
} from '../lib/_jev.mjs';
import { finder } from './_helpers.mjs';

/* ══ PH-507: the Jev gate's pure functions ══════════════════

   The three functions upload.mjs is allowed to branch on. Filed against
   critic-ph507-jev-r1's own residual: "no test in either suite touches
   _jev.mjs". These cover the decision logic in isolation, fast and with no
   network; tools/run-endpoint-tests.mjs covers the same logic wired into
   the real handler with a stubbed Jev call. */

test('jevCutoff: defaults to 0.9 when unset, empty, or unparseable', () => {
  const saved = process.env.JEV_CUTOFF;
  try {
    delete process.env.JEV_CUTOFF;
    assert.equal(jevCutoff(), 0.9);
    process.env.JEV_CUTOFF = '';
    assert.equal(jevCutoff(), 0.9);
    process.env.JEV_CUTOFF = 'not-a-number';
    assert.equal(jevCutoff(), 0.9);
    process.env.JEV_CUTOFF = 'NaN';
    assert.equal(jevCutoff(), 0.9);
  } finally {
    if (saved === undefined) delete process.env.JEV_CUTOFF; else process.env.JEV_CUTOFF = saved;
  }
});

test('jevCutoff: reads a real override, not baked into logic', () => {
  const saved = process.env.JEV_CUTOFF;
  try {
    process.env.JEV_CUTOFF = '0.7';
    assert.equal(jevCutoff(), 0.7);
    process.env.JEV_CUTOFF = '0.001';
    assert.equal(jevCutoff(), 0.001, 'a cutoff just above zero is a valid, if extreme, cutoff and must not be treated as falsy/unset');
    process.env.JEV_CUTOFF = '1';
    assert.equal(jevCutoff(), 1);
  } finally {
    if (saved === undefined) delete process.env.JEV_CUTOFF; else process.env.JEV_CUTOFF = saved;
  }
});

test('jevDisposition: defaults to off when unset or empty', () => {
  const saved = process.env.JEV_DISPOSITION;
  try {
    delete process.env.JEV_DISPOSITION;
    assert.equal(jevDisposition(), JEV_DISPOSITIONS.OFF);
    process.env.JEV_DISPOSITION = '';
    assert.equal(jevDisposition(), JEV_DISPOSITIONS.OFF);
  } finally {
    if (saved === undefined) delete process.env.JEV_DISPOSITION; else process.env.JEV_DISPOSITION = saved;
  }
});

test('jevDisposition: off and refuse pass through; notify and garbage fail closed to off, loudly', () => {
  const saved = process.env.JEV_DISPOSITION;
  const savedWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    process.env.JEV_DISPOSITION = 'off';
    assert.equal(jevDisposition(), JEV_DISPOSITIONS.OFF);
    process.env.JEV_DISPOSITION = 'refuse';
    assert.equal(jevDisposition(), JEV_DISPOSITIONS.REFUSE);

    warnings.length = 0;
    process.env.JEV_DISPOSITION = 'notify';
    assert.equal(jevDisposition(), JEV_DISPOSITIONS.OFF,
      'notify is named but not implemented and must fail closed to off');
    assert.ok(warnings.length > 0, 'selecting notify produced no warning');

    warnings.length = 0;
    process.env.JEV_DISPOSITION = 'garbage-value';
    assert.equal(jevDisposition(), JEV_DISPOSITIONS.OFF, 'an unrecognised value must fail closed to off');
    assert.ok(warnings.length > 0, 'an unrecognised value produced no warning');
  } finally {
    console.warn = savedWarn;
    if (saved === undefined) delete process.env.JEV_DISPOSITION; else process.env.JEV_DISPOSITION = saved;
  }
});

/* PH-507, pre-flip checklist item 4, HAL's explicit requirement: a mutation
   that removes the HOLD_ALERT_TO coupling must fail a test. This is that
   test. 'hold' is real, implemented code as of Raffael's ruling to build it
   -- unlike 'notify' above -- so it does not belong in a "not yet
   implemented" group; it has its own condition, tested on its own. */
test('jevDisposition: hold passes through only with a reachable HOLD_ALERT_TO, and warns loudly otherwise', () => {
  const savedDisp = process.env.JEV_DISPOSITION;
  const savedTo = process.env.HOLD_ALERT_TO;
  const savedKey = process.env.RESEND_API_KEY;
  const savedWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    process.env.JEV_DISPOSITION = 'hold';

    // Neither variable set: fails closed, loudly.
    delete process.env.HOLD_ALERT_TO;
    delete process.env.RESEND_API_KEY;
    warnings.length = 0;
    assert.equal(jevDisposition(), JEV_DISPOSITIONS.OFF,
      'hold with no HOLD_ALERT_TO at all must fail closed to off');
    assert.ok(warnings.length > 0, 'hold with no alert destination produced no warning');

    // A destination is named, but mail itself is not configured: still unreachable.
    process.env.HOLD_ALERT_TO = 'reviewer@example.com';
    delete process.env.RESEND_API_KEY;
    warnings.length = 0;
    assert.equal(jevDisposition(), JEV_DISPOSITIONS.OFF,
      'hold with an address set but mail disabled (no RESEND_API_KEY) must still fail closed');
    assert.ok(warnings.length > 0, 'hold with mail disabled produced no warning');

    // Mail is configured, but the address itself does not pass validAddress().
    process.env.HOLD_ALERT_TO = 'not-an-address';
    process.env.RESEND_API_KEY = 'test-key';
    warnings.length = 0;
    assert.equal(jevDisposition(), JEV_DISPOSITIONS.OFF,
      'hold with an invalid HOLD_ALERT_TO must fail closed even with mail enabled');
    assert.ok(warnings.length > 0, 'hold with an invalid address produced no warning');

    // Whitespace-only is empty, matching jevCutoff's own discipline for the same shape of input.
    process.env.HOLD_ALERT_TO = '   ';
    process.env.RESEND_API_KEY = 'test-key';
    warnings.length = 0;
    assert.equal(jevDisposition(), JEV_DISPOSITIONS.OFF,
      'hold with a whitespace-only HOLD_ALERT_TO must fail closed');

    // Both conditions genuinely met: hold passes through, and it is silent -- a working
    // choice must never print a warning, or a real warning stops being a signal.
    process.env.HOLD_ALERT_TO = 'reviewer@example.com';
    process.env.RESEND_API_KEY = 'test-key';
    warnings.length = 0;
    assert.equal(jevDisposition(), JEV_DISPOSITIONS.HOLD,
      'hold with a valid, reachable HOLD_ALERT_TO and mail enabled must pass through');
    assert.equal(warnings.length, 0, 'a working hold disposition must not warn');
  } finally {
    console.warn = savedWarn;
    if (savedDisp === undefined) delete process.env.JEV_DISPOSITION; else process.env.JEV_DISPOSITION = savedDisp;
    if (savedTo === undefined) delete process.env.HOLD_ALERT_TO; else process.env.HOLD_ALERT_TO = savedTo;
    if (savedKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = savedKey;
  }
});

test('holdAlertTo: trims, validates, and rejects the same shapes validAddress rejects; holdAlertReachable requires mail too', () => {
  assert.equal(holdAlertTo({}), null, 'unset must be null, not an empty string mistaken for a value');
  assert.equal(holdAlertTo({ HOLD_ALERT_TO: '' }), null);
  assert.equal(holdAlertTo({ HOLD_ALERT_TO: '   ' }), null, 'whitespace-only is empty, not a value');
  assert.equal(holdAlertTo({ HOLD_ALERT_TO: 'not-an-address' }), null);
  assert.equal(holdAlertTo({ HOLD_ALERT_TO: '  reviewer@example.com  ' }), 'reviewer@example.com',
    'a real address is trimmed and returned, matching validAddress\'s own normalisation');

  assert.equal(holdAlertReachable({}), false);
  assert.equal(holdAlertReachable({ HOLD_ALERT_TO: 'reviewer@example.com' }), false,
    'an address alone, with no RESEND_API_KEY, is not reachable');
  assert.equal(holdAlertReachable({ RESEND_API_KEY: 'x' }), false,
    'mail configured with no destination is not reachable either');
  assert.equal(holdAlertReachable({ HOLD_ALERT_TO: 'reviewer@example.com', RESEND_API_KEY: 'x' }), true);
});

test('jevFlagged: false for null, and for every non-scored outcome, whatever the cutoff', () => {
  assert.equal(jevFlagged(null, 0), false);
  assert.equal(jevFlagged(undefined, 0), false);
  for (const outcome of [JEV_OUTCOMES.SKIPPED_NO_KEY, JEV_OUTCOMES.TIMEOUT,
    JEV_OUTCOMES.TRANSPORT_ERROR, JEV_OUTCOMES.HTTP_ERROR]) {
    assert.equal(jevFlagged({ outcome }, 0), false,
      `${outcome} has no score to compare and must never be flagged, even at cutoff 0`);
  }
});

test('jevFlagged: max(installable, unconsented) against the cutoff, never installable alone', () => {
  const scored = (installable, unconsented) => ({ outcome: JEV_OUTCOMES.SCORED, installable, unconsented });
  assert.equal(jevFlagged(scored(0.5, 0.5), 0.9), false);
  assert.equal(jevFlagged(scored(0.95, 0.1), 0.9), true, 'installable alone crossing the cutoff must flag it');
  assert.equal(jevFlagged(scored(0.1, 0.95), 0.9), true,
    'unconsented alone crossing the cutoff must flag it -- reading only installable would miss this');
  assert.equal(jevFlagged(scored(0.9, 0.1), 0.9), true, 'exactly at the cutoff is flagged (>=, not >)');
  assert.equal(jevFlagged(scored(0.89999, 0.1), 0.9), false, 'just under the cutoff is not flagged');
});

test('jevFlagged: an explicit cutoff argument overrides the env default', () => {
  const saved = process.env.JEV_CUTOFF;
  try {
    delete process.env.JEV_CUTOFF;
    const scored = { outcome: JEV_OUTCOMES.SCORED, installable: 0.75, unconsented: 0.1 };
    assert.equal(jevFlagged(scored), false, 'default cutoff 0.9 should not flag 0.75');
    assert.equal(jevFlagged(scored, 0.7), true, 'an explicit lower cutoff must be honoured');
  } finally {
    if (saved === undefined) delete process.env.JEV_CUTOFF; else process.env.JEV_CUTOFF = saved;
  }
});

test('jevFlagged: a model mismatch never flags, whatever the scores', () => {
  const scored = { outcome: JEV_OUTCOMES.SCORED, installable: 0.99, unconsented: 0.99, modelMismatch: true };
  assert.equal(jevFlagged(scored, 0), false,
    'a mismatched model must fail open even against a cutoff of 0');
  const matched = { outcome: JEV_OUTCOMES.SCORED, installable: 0.99, unconsented: 0.99, modelMismatch: false };
  assert.equal(jevFlagged(matched, 0.9), true, 'a matched model at the same scores must still flag');
});

test('jevCutoff: whitespace-only is empty, not zero -- a gate-code critic reproduced the silent bug', () => {
  const saved = process.env.JEV_CUTOFF;
  const savedWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    for (const ws of [' ', '\t', '\n', '   ']) {
      warnings.length = 0;
      process.env.JEV_CUTOFF = ws;
      assert.equal(jevCutoff(), 0.9, `JEV_CUTOFF=${JSON.stringify(ws)} must fall back to the default, not silently become 0`);
    }
  } finally {
    console.warn = savedWarn;
    if (saved === undefined) delete process.env.JEV_CUTOFF; else process.env.JEV_CUTOFF = saved;
  }
});

test('jevCutoff: out-of-(0,1] values fall back to the default, loudly, matching jevDisposition\'s discipline', () => {
  const saved = process.env.JEV_CUTOFF;
  const savedWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    /* Zero is in this list on purpose, not with the legitimate boundary
       below: two gate-code critics independently found "0" (and "0.0",
       "-0", "0e0") silently flagging every scored result with no warning,
       the same catastrophic-and-silent shape finding 4 was about. Zero has
       no legitimate meaning as a cutoff -- it is indistinguishable from
       "refuse all traffic" -- unlike 1, which degrades safely toward never
       refusing anything. */
    for (const bad of ['-1', '0', '0.0', '-0', '0e0', '2', 'Infinity', '-Infinity']) {
      warnings.length = 0;
      process.env.JEV_CUTOFF = bad;
      assert.equal(jevCutoff(), 0.9, `JEV_CUTOFF=${bad} must fall back to the default rather than silently accept an out-of-range cutoff`);
      assert.ok(warnings.length > 0, `JEV_CUTOFF=${bad} produced no warning`);
    }
    // The one legitimate boundary: 1 degrades safely (almost never flags) and must be accepted.
    warnings.length = 0;
    process.env.JEV_CUTOFF = '1';
    assert.equal(jevCutoff(), 1);
    assert.equal(warnings.length, 0, 'the legitimate boundary value 1 must not warn');
  } finally {
    console.warn = savedWarn;
    if (saved === undefined) delete process.env.JEV_CUTOFF; else process.env.JEV_CUTOFF = saved;
  }
});


/* ══ the password check (design S): finder, question, log row, predicate ═════════════════
   Evidence: record/findings/a-jev-password-check-catches-88-percent-at-0-5-...-2026-09-24.md. Raffael's
   ruling, 2026-09-24: 0.5 or more HOLDS, nothing is refused, no refuse threshold exists. */
const secretJev = await import('../lib/_jev.mjs');

/* GROWTH, NOT WALL-CLOCK. This test used to require each shape under 1000 ms at 256 KB, and it failed
   2 runs in 3 on a loaded machine (2026-10-22 audit), because `curl -u ` repeated really did take
   about a second: two searches in authOffsets read on to the end of the text once per match, which is
   quadratic. A bound on time cannot tell a slow machine from a slow algorithm; the ratio between two
   sizes on the same machine can. STEP times the text costs about STEP times as long when every scan is
   linear, and far less than STEP squared when one is quadratic, because at the small size the other
   rules' linear work still dominates. From 16 KB to 256 KB, twelve runs each, the quadratic finder
   judged 72 to 112, not 256, and the fixed one up to 33: the LIMIT of 64 cleared the first by 1.13,
   and no LIMIT cleared both by 1.5. So the big text is 512 KB, twice MAX_BYTES: for the ratio, not
   because a passport can be that long. Measured 2026-10-23, Node 22, Windows, eight cores, as each
   run's worst shape after the second judgement below, ten runs of each finder, five with no load of
   ours (other work kept the machine 59 to 100% busy) and five with ten busy threads on top: the fixed
   finder 43 to 80, the quadratic one (b173546's) 271 to 528. LIMIT 150 sits a factor of 1.8 from
   each. The sweep takes about 16 s here, against 9 s at 256 KB.

   One run at each size is a screen. A shape over LIMIT on it is judged again on medians of three,
   with the small text run STEP times back to back, so both measurements last about as long and a
   loaded machine slows both alike: a single run of a few milliseconds slips between other processes'
   time slices where one of about a hundred (24 to 157 ms measured at 512 KB) cannot. */
test('secret finder: every rule\'s own opening, repeated three ways, grows linearly from 16 KB to 512 KB (the Python version backtracks quadratically on several)', () => {
  const N = 524288, STEP = 32, SMALL = N / STEP, LIMIT = 150;
  const seeds = ['auth', 'host=', 'server=', 'data source=', 'host=db ', 'key.', 'curl ', 'curl -u ', '-u ', 'eyJ', 'eyJaaaaaa-', 'eyJaaaaaa.', 'eyJaaaaaa.bbbbbb',
    'password', 'passphrase ', 'user x ', 'login a ', 'otpauth://', '-----BEGIN ', '[SCRUBBED:', 'jdbc:', 'AAAA-', 'abcd-', 'abcd ', '?key', '&sig=', '?sig=',
    'Cookie:', 'cookie: a ', 'api_key', 'token ', 'secret=', 'Bearer ', 'authorization:', 'authorization: Basic ', 'http://', 'a://', 'x@', 'client_email"',
    'aws_access_key_id', 'X-Amz-Signature', 'Signature=', 'pwd=', 'password=', 'A2', 'aB3', 'a/b/', '((', 'host=db;host=db;'];
  const time = (v, reps = 1) => {
    const t0 = performance.now();
    for (let i = 0; i < reps; i++) finder.excerpts(v);
    return performance.now() - t0;
  };
  const median = a => [...a].sort((x, y) => x - y)[a.length >> 1];
  // Warm-up, so the first shape is not also the one that pays for compiling every rule.
  finder.excerpts(seeds.map(s => s + ' ').join('\n').repeat(40));
  let shapes = 0, worst = 0, worstName = '';
  for (const seed of seeds) {
    for (const joiner of ['', ' ', '\n']) {
      const unit = seed + joiner;
      const big = unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
      const small = big.slice(0, SMALL);
      let ratio = time(big) / time(small);
      if (ratio > LIMIT) {
        const s = [], b = [];
        for (let i = 0; i < 3; i++) { s.push(time(small, STEP)); b.push(time(big)); }
        ratio = STEP * median(b) / median(s);
      }
      shapes++;
      if (ratio > worst) { worst = ratio; worstName = JSON.stringify(unit); }
      assert.ok(ratio <= LIMIT, JSON.stringify(unit) + ': ' + STEP + ' times the text took ' + ratio.toFixed(1) +
        ' times as long (measured 2026-10-23: linear at most 80, quadratic at least 271)');
    }
  }
  assert.equal(shapes, seeds.length * 3);
  assert.ok(worst <= LIMIT, worstName);
});

test('secret finder: a curl -u far from its curl, an unsigned long JWT among more than 30 candidates, and an emoji before a hit are all still found', () => {
  const curl = 'Run curl ' + "-H 'X-Trace-Id: abcdefgh' ".repeat(14) + '-u admin:Hunter22x https://example.test';
  assert.equal(finder.excerpts('intro\n' + curl).length, 1, 'a curl -u past 300 characters was lost');
  const far = 'curl ' + 'x '.repeat(50000) + '-u a:b';
  assert.equal(finder.excerpts(far).length, 1, 'a curl -u a hundred thousand characters away was lost');
  const lines = Array.from({ length: 35 }, (_, i) => 'The login is dana and the password is x' + i + 'abcd here');
  lines.push('Paste eyJhbGciOiJub25lIn0.' + 'a'.repeat(622) + '. into the header');
  const got = finder.excerpts(lines.join('\n'));
  assert.equal(got.length, finder.CAP);
  assert.ok(got.some(e => e.line === 35), 'an unsigned JWT with a long payload fell out of the 30');
  const w = finder.excerpts('\u{1F680}'.repeat(60) + 'password: hunter22xyz')[0].excerpt;
  assert.ok(w.startsWith('\u{1F680}') && w.endsWith('hunter22xyz'), 'the excerpt window was cut by UTF-16 unit');
  assert.doesNotMatch(w, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'a surrogate pair was split');
});

test('secret question: the wording and criteria are the ones the measurement used, character for character', async () => {
  const { createHash } = await import('node:crypto');
  const h = createHash('sha256').update([secretJev.SECRET_QUESTION, secretJev.SECRET_CRITERIA.true, secretJev.SECRET_CRITERIA.false].join('\n')).digest('hex');
  /* sha256 of QTEXT, CRIT.true and CRIT.false joined by newlines, computed from run.frozen.py in the record, not from this file. */
  assert.equal(h, '6a1559fb1c27d0aaf35b6212c6fd52383bfea3196be23ad611bc16cebd603750', 'the question or criteria changed: re-run the measurement instead of editing the thresholds\' evidence');
});

test('secretFlagged: 0.5 holds, 0.4999 does not, and a failed, empty, or wrong-model result never does', () => {
  const ok = score => ({ outcome: 'scored', score, line: 3, n: 4, modelMismatch: false });
  assert.equal(secretJev.secretFlagged(ok(0.5), 0.5), true);
  assert.equal(secretJev.secretFlagged(ok(0.4999), 0.5), false);
  assert.equal(secretJev.secretFlagged(ok(0.99), 0.5), true);
  assert.equal(secretJev.secretFlagged({ ...ok(0.99), modelMismatch: true }, 0.5), false, 'a score from another model was acted on');
  for (const o of ['skipped_no_key', 'timeout', 'transport_error', 'http_error', 'no_candidates']) {
    assert.equal(secretJev.secretFlagged({ outcome: o, score: 0.99 }, 0.5), false, o + ' flagged');
  }
  assert.equal(secretJev.secretFlagged(null, 0.5), false);
  assert.equal(secretJev.secretFlagged(ok(0.6), 0.7), false);
  assert.equal(secretJev.secretFlagged(ok(0.6)), true, 'the default threshold is 0.5');
});

test('jevLogRecord with a password-check result: numbers and an enum only, never text, and a malformed one is left out', () => {
  const base = { day: '2026-09-24', result: { outcome: 'skipped_no_key' } };
  assert.equal('secret' in secretJev.jevLogRecord(base), false, 'no secret result, no secret key');
  const rec = secretJev.jevLogRecord({ ...base, secret: { outcome: 'scored', score: 0.61, line: 12, n: 9, modelMismatch: false,
    excerpt: 'password: hunter2', text: 'x', model: 'jev-1.13.0' } });
  assert.deepEqual(rec.secret, { outcome: 'scored', score: 0.61, line: 12, n: 9, modelMismatch: false });
  assert.equal(JSON.stringify(rec).includes('hunter2'), false);
  for (const bad of [{ outcome: 'scored', score: 0.6, line: 0, n: 3 }, { outcome: 'scored', score: '0.6', line: 2, n: 3 }, { outcome: 'scored', score: 0.6, line: 1.5, n: 3 }]) {
    assert.equal(secretJev.jevLogRecord({ ...base, secret: bad }).secret.outcome, 'transport_error', 'a malformed scored result was logged as scored: ' + JSON.stringify(bad));
  }
  assert.equal('secret' in secretJev.jevLogRecord({ ...base, secret: { outcome: 'made_up' } }), false);
  assert.deepEqual(secretJev.jevLogRecord({ ...base, secret: { outcome: 'no_candidates' } }).secret, { outcome: 'no_candidates', n: 0 });
  assert.notEqual(secretJev.jevLogRecord({ ...base, secret: { outcome: 'scored' } }), null, 'a bad secret result must not cost the main record');
});

test('secretCheck: no key sends nothing; no candidate lines sends nothing; a timeout and a short answer fail open; the top line wins', async () => {
  const savedKey = process.env.TYPESAFE_API_KEY, savedFetch = globalThis.fetch;
  let sent = 0;
  try {
    delete process.env.TYPESAFE_API_KEY;
    globalThis.fetch = async () => { sent++; throw new Error('should not be called'); };
    assert.deepEqual(await secretJev.secretCheck('password: hunter22xyz'), { outcome: 'skipped_no_key' });
    process.env.TYPESAFE_API_KEY = 'k';
    assert.deepEqual(await secretJev.secretCheck('a plain sentence\nand another'), { outcome: 'no_candidates', n: 0 });
    assert.equal(sent, 0, 'a request was sent with nothing to check');
    const doc = 'intro\nCookie: a=1\ntext\nCookie: b=2\nmore\nCookie: c=3';
    const answer = scores => async () => new Response(JSON.stringify({ model: 'jev-1.13.0',
      answers: Object.fromEntries(scores.map((v, i) => ['c' + (i + 1), { noul: v }])) }), { status: 200 });
    globalThis.fetch = answer([0.2, 0.9, 0.9]);
    const r = await secretJev.secretCheck(doc);
    assert.equal(r.outcome, 'scored'); assert.equal(r.score, 0.9); assert.equal(r.n, 3);
    assert.equal(r.line, 4, 'the first of two tied top scores names line 4 (1-based)');
    globalThis.fetch = answer([0.2, 0.9]);
    assert.equal((await secretJev.secretCheck(doc)).outcome, 'transport_error', 'a short answer was scored');
    globalThis.fetch = async (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))));
    assert.equal((await secretJev.secretCheck(doc)).outcome, 'timeout');
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedKey;
  }
});

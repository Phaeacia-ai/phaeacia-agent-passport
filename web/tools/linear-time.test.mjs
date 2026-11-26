/* The upload pipeline is linear in a long run inside one line (2026-10-22).

   lib/_sections.mjs trimmed with /^[C]+|[C]+$/g, and V8 runs the `[C]+$` half
   in time quadratic in a run of C inside a line. A 48,500-byte upload with one
   line of spaces took 40 s through transport(), validate() and derive(), and
   POST /api/upload is public. stripBlanks() and idCore() in lib/_validate.mjs
   had the same shape.
   Two more turned up when the whole pipeline was probed: the tag scan in
   validate() ran `[^>]*` to the end of a line of unclosed `<a ` once per tag
   (75 s at the size cap), and derive()'s separator-row test was cubic in a
   row of blanks.
   And the page had one: the placeholder test in sectionParts(), on every view.
   A wider sweep found two more on the upload path: the frontmatter pair
   regex on blanks before a U+2028, and derive()'s money echo on an unclosed
   span of `money.` tokens.

   Two halves, because each alone proves half. EQUIVALENCE: every loop that
   replaced a regex is held equal to that regex, rebuilt here from the same
   class string, over generated strings. A faster function that answers
   differently would move a verdict between the site and tools/validate.py,
   which is the drift this repository keeps finding. SCALING: the real
   pipeline on the example passport with one run of N and of 4N units, warmed
   up, alternating, median of five, and asserted on the RATIO of what the run
   adds. Linear growth is at most x4 there and quadratic is x16, and a ratio
   does not depend on the machine the way a millisecond ceiling does (the
   jev.test.mjs ReDoS guard, which reads the clock, fails on a loaded
   machine).
   tools/test_linear_scans.py is the same pair for tools/validate.py,
   tools/preflight.py and scripts/passport-to-page.py. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GOOD, transport, validate, derive, render, parsed } from './_helpers.mjs';
import {
  WS_ANY, WS_BOTH, PLACEHOLDER, structuralTrim, structuralTrimEnd, yamlTrim, mdTrim, collapseWs,
} from '../lib/_sections.mjs';
import { stripBlanks, idCore, FRONT_PAIR } from '../lib/_validate.mjs';
import { collapseMoneySpans } from '../lib/_derive.mjs';

/* ── the regexes the loops replaced, rebuilt from the same class strings ── */
const OLD = {
  structuralTrim: (s) => String(s).replace(new RegExp(`^[${WS_BOTH}]+|[${WS_BOTH}]+$`, 'g'), ''),
  yamlTrim: (s) => String(s).replace(new RegExp(`^[${WS_ANY}]+|[${WS_ANY}]+$`, 'g'), ''),
  mdTrim: (s) => String(s).replace(/^[ \t]+|[ \t]+$/g, ''),
  structuralTrimEnd: (s) => s.replace(new RegExp(`[${WS_BOTH}]+$`), ''),
  collapseWs: (s) => OLD.yamlTrim(String(s)).replace(new RegExp(`[${WS_ANY}]+`, 'g'), ' '),
  stripBlanks: (s) => s.replace(/^[ \t]+|[ \t]+$/g, ''),
  idCore: (s) => s.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ''),
};
const NEW = { structuralTrim, yamlTrim, mdTrim, structuralTrimEnd, collapseWs, stripBlanks, idCore };
const OLD_PLACEHOLDER = /^<[^<>]*[ \t][^<>]*>$/;

/* Seeded, so a failure names an input that reproduces. */
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Every unit either class holds, read off the classes rather than typed, plus
   ordinary text, the near misses (U+200B and U+180E are whitespace to neither
   class), an astral character and both lone surrogates. */
const members = (cls) => {
  const r = new RegExp(`[${cls}]`), out = [];
  for (let u = 0; u < 0x10000; u++) if (r.test(String.fromCharCode(u))) out.push(String.fromCharCode(u));
  return out;
};
const WS_UNITS = members(WS_ANY);
const ORDINARY = ['a', 'Z', '0', '9', '-', '_', '.', '#', '|', '`', '<', '>', '/', '=', '"', '(',
  '\u00e9', '\u4e2d', '\u200b', '\u180e', '\u{1F600}', '\uD800', '\uDC00'];

function strings(seed, n, alphabet, longest = 24) {
  const next = rng(seed), out = [''];
  for (const c of alphabet) out.push(c, c + 'a', 'a' + c, 'a' + c + 'a', c + c + c);
  while (out.length < n) {
    const len = Math.floor(next() * longest);
    let s = '';
    while (s.length < len) {
      const c = alphabet[Math.floor(next() * alphabet.length)];
      s += next() < 0.3 ? c.repeat(1 + Math.floor(next() * 6)) : c;   // runs, which is where it broke
    }
    out.push(s);
  }
  return out;
}

test('each trim loop returns exactly what the regex it replaced returned', () => {
  const inputs = strings(20261022, 20000, [...WS_UNITS, ...ORDINARY]);
  for (const name of Object.keys(OLD)) {
    for (const s of inputs) {
      assert.equal(NEW[name](s), OLD[name](s), `${name}(${JSON.stringify(s)})`);
    }
  }
});

test('the placeholder test accepts exactly the strings it accepted before', () => {
  for (const s of strings(7, 20000, ['<', '>', ' ', '\t', 'a', '-', '\u00a0', '\n'])) {
    assert.equal(PLACEHOLDER.test(s), OLD_PLACEHOLDER.test(s), JSON.stringify(s));
  }
});

/* FRONT_PAIR gained `(?![WS_BOTH])` after its blanks, so it must match the
   same lines with the same two groups. Every WS_ANY unit is in the alphabet,
   which puts U+2028, U+2029, CR and LF, the units `.` stops at, among them. */
test('the frontmatter pair regex reads every line as it did before', () => {
  const OLD_FRONT_PAIR = new RegExp(`^([A-Za-z_][A-Za-z0-9_]*):[${WS_BOTH}]*(.*)$`);
  const HEADS = ['title:', 'k:', '_a1:', 'title: ', 'title:\u2028', '1x:', 'a-b:', 'title', ''];
  let matched = 0, refused = 0;
  strings(17, 20000, [...WS_UNITS, ...ORDINARY]).forEach((s, i) => {
    const line = HEADS[i % HEADS.length] + s;
    const a = OLD_FRONT_PAIR.exec(line), b = FRONT_PAIR.exec(line);
    assert.deepEqual(b && [...b], a && [...a], JSON.stringify(line));
    if (a) matched++; else refused++;
  });
  assert.ok(matched > 2000 && refused > 2000, `${matched} matched and ${refused} refused, so one side went untested`);
});

/* collapseMoneySpans() replaced a regex in derive()'s refusal echoes. Tokens
   rather than characters, with the case variants /i reads and near misses,
   or almost no string holds a span with `money.` in it. */
test('the money echo collapses exactly the spans the regex it replaced collapsed', () => {
  const OLD_MONEY = (s) => s.replace(/`[^`]*money\.[^`]*`/gi, '`money.*`');
  const TOKENS = ['`', '`', '`', 'money.', 'MONEY.', 'Money.', 'mOnEy.', 'money', 'moneyx', 'm', '.', 'x', ' ', '\t',
    '|', '\u00e9', '\u0130', '\u{1F600}', '\uD800', '\uDC00'];
  let collapsed = 0;
  for (const s of strings(19, 20000, TOKENS, 48)) {
    const want = OLD_MONEY(s);
    assert.equal(collapseMoneySpans(s), want, JSON.stringify(s));
    if (want !== s) collapsed++;
  }
  assert.ok(collapsed > 2000, `only ${collapsed} strings had a span to collapse, so this compared almost nothing`);
});

/* ── the tag scan, read through validate() itself ──────────────────────────
   The regex is unchanged; what changed is that validate() runs it only up to
   a line's last `>`. So the oracle is the same regex over the whole line,
   read out of the source rather than copied, and the answer is what
   validate() reports under E_HTML and E_UNFILLED. */
test('the tag scan reports the same tags when it stops at the last ">"', () => {
  const src = readFileSync(new URL('../lib/_validate.mjs', import.meta.url), 'utf8');
  const lit = src.match(/^ *const TAG = \/(.+)\/g;$/m);
  assert.ok(lit, 'could not find the TAG regex in lib/_validate.mjs');
  const TAG = new RegExp(lit[1], 'g');
  const lines = GOOD.split('\n');
  const at = lines.findIndex(l => l.startsWith('Captured 2026')) + 1;
  assert.ok(at > 0, 'the example passport moved; place the probe line somewhere else');
  let compared = 0;
  /* Tokens rather than characters, or almost no probe line holds a tag. */
  const TAGGY = ['<a', '<a ', '</b', '<p x="1"', '<i/', '<br>', '>', '>', '>', ' ', ' ', '\t', '=', '"',
    'x', '-', '1', '<', '/', '\u00a0', '\ufeff'];
  const next = rng(11);
  for (let k = 0; k < 400; k++) {
    let line = 'x ';
    for (let j = 2 + Math.floor(next() * 12); j > 0; j--) line += TAGGY[Math.floor(next() * TAGGY.length)];
    const text = [...lines.slice(0, at), line, ...lines.slice(at)].join('\n');
    const got = validate(text).errors
      .filter(e => e.code === 'E_HTML' || e.code === 'E_UNFILLED')
      .flatMap(e => e.details || [])
      .map(d => d.replace(/^line \d+: /, ''))
      .sort();
    const want = [...line.matchAll(TAG)].map(m => m[0]).sort();
    assert.deepEqual(got, want, JSON.stringify(line));
    if (want.length) compared++;
  }
  assert.ok(compared > 150, `only ${compared} probe lines held a tag, so this compared almost nothing`);
});

/* ── the consent separator row, read through derive() itself ──────────────
   /^[ \t]*\|?[ \t:|-]+\|?[ \t]*$/ became /^[ \t:|-]+$/ in derive(). Every
   generated row is put in the separator's place of a passport the gate
   accepts, so derive() accepts it exactly when the old regex did. */
test('derive() accepts exactly the separator rows the old regex accepted', () => {
  const OLD_SEP = /^[ \t]*\|?[ \t:|-]+\|?[ \t]*$/;
  const v = validate(GOOD);
  assert.equal(v.errors.length, 0, 'the example passport must validate');
  const at = v.lines.findIndex(l => l.startsWith('|---|'));
  assert.ok(at > 0, 'the example passport has no separator row to replace');
  let accepted = 0, refused = 0;
  for (const s of strings(13, 300, [' ', '\t', ':', '|', '-', 'x', '\u00a0', '\ufeff'])) {
    const row = '|' + s;
    const lines = v.lines.slice();
    lines[at] = row;
    const d = derive(v.front, lines);
    const want = OLD_SEP.test(row) ? null : 'E_DERIVE_NEEDS';
    assert.equal(d.error ? d.error.code : null, want, JSON.stringify(row));
    if (want) refused++; else accepted++;
  }
  assert.ok(accepted > 50 && refused > 50, `${accepted} accepted and ${refused} refused, so one side went untested`);
});

/* ── scaling ──────────────────────────────────────────────────────────────── */
const N = 2000;
const RATIO_MAX = 8;
const enc = new TextEncoder();
const LINES = GOOD.split('\n');
const find = (pred) => {
  const i = LINES.findIndex(pred);
  assert.ok(i >= 0, 'the example passport moved; a scaling probe has nowhere to go');
  return i;
};
const insertAfter = (pred, line) => { const M = LINES.slice(); M.splice(find(pred) + 1, 0, line); return M; };
const replaceIn = (pred, from, to) => { const M = LINES.slice(); const i = find(pred); M[i] = M[i].replace(from, () => to); return M; };
const PLACES = {
  'a section 1 line':          (run) => insertAfter(l => l.startsWith('It reads'), 'x' + run + 'y'),
  'a frontmatter value':       (run) => replaceIn(l => l.startsWith('source_stack:'), /: .*/, ': x' + run + 'y'),
  'a capabilities entry':      (run) => insertAfter(l => l === '  - capability_ref: web.fetch', '    note: x' + run + 'y'),
  'a consent cell':            (run) => replaceIn(l => l.startsWith('| Fetch news'), 'this is the briefing content', 'x' + run + 'y'),
  'a backticked consent cell': (run) => replaceIn(l => l.startsWith('| Fetch news'), 'this is the briefing content', '`x' + run + 'y`'),
  'a section 4 paragraph':     (run) => insertAfter(l => l.startsWith('Captured 2026'), 'x' + run + 'y'),
  'a heading line':            (run) => replaceIn(l => l.startsWith('## 1.'), /$/, run + 'x'),
  'the consent separator row': (run) => replaceIn(l => l.startsWith('|---|'), /.*/, run + '|x'),
  'a frontmatter value ahead of a U+2028': (run) => replaceIn(l => l.startsWith('source_stack:'), /: .*/, ':' + run + 'x\u2028y'),
  'an unclosed span in the Installable cell': (run) => replaceIn(l => l.startsWith('| Fetch news'), /yes \|$/, 'yes `' + run + ' |'),
};
/* [what, motif, where, units]. The whitespace classes in each place a trim
   reads, with U+FEFF and U+0085 for the characters only one class holds, and
   punctuation, which idCore() trims. A refused upload is in here on purpose:
   a refusal costs the same CPU, and it is charged only to the 30-an-hour
   bucket. Each case was checked to fail against the old regexes, and each
   trim has a case that fails with that trim alone put back: stripBlanks()
   trims only spaces and tabs, and trims a run inside a span four times to a
   bare cell's once, so those two go in a span as well.
   The old cost per unit of the unclosed tag and the money echo was small
   enough to need a longer run before it showed, and the separator row's was
   CUBIC, so it gets a short one, or the red run of this test would take an
   hour. */
const CASES = [
  ['spaces', ' ', 'a section 1 line'],
  ['tabs', '\t', 'a section 1 line'],
  ['U+3000', '\u3000', 'a section 1 line'],
  ['U+FEFF', '\ufeff', 'a section 1 line'],
  ['U+0085', '\u0085', 'a section 1 line'],
  ['U+2000', '\u2000', 'a frontmatter value'],
  ['U+00A0', '\u00a0', 'a capabilities entry'],
  ['spaces', ' ', 'a consent cell'],
  ['U+1680', '\u1680', 'a backticked consent cell'],
  ['underscores', '_', 'a backticked consent cell'],
  ['spaces', ' ', 'a backticked consent cell'],
  ['tabs', '\t', 'a backticked consent cell'],
  ['spaces', ' ', 'a heading line'],
  ['unclosed "<a "', '<a ', 'a section 4 paragraph', 4 * N],
  ['spaces', ' ', 'the consent separator row', N / 10],
  ['spaces', ' ', 'a frontmatter value ahead of a U+2028'],
  ['`money.` tokens', 'money.', 'an unclosed span in the Installable cell', 4 * N],
];

const pipeline = (text) => {
  const t = transport(enc.encode(text), 'text/markdown');
  if (t.error) return t.error.code;
  const v = validate(t.text);
  if (v.errors.length) return v.errors[0].code;
  const d = derive(v.front, v.lines);
  return d.error ? d.error.code : 'ACCEPT';
};
/* Warmed, then a SHORT run, the small and the big input ALTERNATE, five
   rounds, and each is the median of its five. Alternating is what keeps it
   honest on a shared machine: a slow patch lands on all three instead of on
   one, and measured back to back the same quadratic input read anywhere from
   x8 to x18 here. Three rounds once a big run is over a second, which is not
   noise, so a red test stays a few minutes long and not ten. Each timing is
   of as many calls as the small input needs to take TARGET_MS, so nothing is
   read off a clock at a fraction of a millisecond, and every figure is per
   call. */
const TARGET_MS = 10;
const ms = (f, x, reps) => {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < reps; i++) f(x);
  return Number(process.hrtime.bigint() - t0) / 1e6 / reps;
};
const median = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
function medians(f, short, small, big) {
  for (let i = 0; i < 3; i++) { f(short); f(small); }
  const reps = Math.max(1, Math.ceil(TARGET_MS / Math.max(ms(f, small, 1), 1e-3)));
  const zs = [], as = [], bs = [];
  for (let i = 0; i < 5; i++) {
    zs.push(ms(f, short, reps));
    as.push(ms(f, small, reps));
    bs.push(ms(f, big, reps));
    if (i >= 2 && bs[i] * reps > 1000) break;
  }
  return [median(zs), median(as), median(bs)];
}
/* The growth of what the RUN costs, not of what the passport costs. z, the
   same input with a run of SHORT units, is the passport around the run, and
   at N it is most of the small timing: b / a read as little as x7.8 against
   trims that were quadratic, with x8 the limit. So z comes off both sides.
   The run's own cost at n is floored at z, so on linear code, where it is
   close to nothing, a difference of two nearly equal timings cannot make a
   ratio out of noise: it reads about x1. */
const SHORT = 6;   // one `money.`
const growth = (z, a, b) => (b - z) / Math.max(a - z, z);
const runOf = (motif, n) => motif.repeat(Math.ceil(n / motif.length)).slice(0, n);

for (const [what, motif, where, n = N] of CASES) {
  test(`transport+validate+derive is linear in ${what} inside ${where}`, () => {
    const short = PLACES[where](runOf(motif, SHORT)).join('\n');
    const small = PLACES[where](runOf(motif, n)).join('\n');
    const big = PLACES[where](runOf(motif, 4 * n)).join('\n');
    const verdict = pipeline(big);
    assert.equal(pipeline(short), verdict, 'the short run must take the path the long one takes');
    const [z, a, b] = medians(pipeline, short, small, big);
    const g = growth(z, a, b);
    assert.ok(g < RATIO_MAX,
      `${what} inside ${where}: ${a.toFixed(1)} ms at ${n} units, ${b.toFixed(1)} ms at ${4 * n} and ` +
      `${z.toFixed(1)} ms at ${SHORT}, so the run's cost grew x${g.toFixed(1)} when the run grew x4 ` +
      `(linear is at most x4, quadratic x16; verdict ${verdict}). ` +
      `This runs at a public endpoint on a stranger's file.`);
  });
}

/* The page, which renders on every view (passport.mjs sends no-store), from a
   passport the gate accepts: a section 4 paragraph that opens with `<` and
   never closes is not a tag, so nothing refuses it. */
test('the passport page is linear in a never-closed "<" paragraph', () => {
  const page = (n) => {
    const body = insertAfter(l => l.startsWith('Captured 2026'), '\n<a' + runOf(' b', n) + ' c\n').join('\n');
    assert.equal(pipeline(body), 'ACCEPT', 'the probe passport must be one the gate accepts');
    return { ...parsed(), body };
  };
  const [z, a, b] = medians((row) => render.renderPassport('abc', row, 'https://app.phaeacia.ai'),
    page(SHORT), page(N * 8), page(N * 32));
  const g = growth(z, a, b);
  assert.ok(g < RATIO_MAX,
    `${a.toFixed(2)} ms at ${N * 8} units, ${b.toFixed(2)} ms at ${N * 32} and ${z.toFixed(2)} ms at ` +
    `${SHORT}, so the paragraph's cost grew x${g.toFixed(1)} when it grew x4 (linear is at most x4, quadratic x16)`);
});

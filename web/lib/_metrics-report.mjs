/* The corpus report: what tools/metrics.mjs prints, built from rows and nothing
   else.

   PURE, FOR THE REASON _digest.mjs GIVES ABOUT ITSELF: "the difference between a
   digest that has been checked and one that has only ever been looked at." This
   file opens no store, reads no environment, takes no clock and prints nothing.
   It takes two fetched corpora and returns lines plus an exit code.

   It exists because the report used to live inside the script, where the only
   way to exercise it was to point it at production with a real token. Under that
   arrangement a formatting bug that asserted "0 published" during a store outage
   shipped and was found by running it, not by a test. See `unknown` below.

   The counting rules are _digest.mjs's and are imported rather than restated.
   Two readers of one corpus that count differently is how one of them becomes
   the one people quote. */

import { label, GATE } from './_digest.mjs';

/* A corpus that could not be listed is UNKNOWN, and unknown is not zero.
   Rendered as `?` deliberately: it cannot be added, averaged or quoted, which is
   exactly the set of things nobody should be able to do with a figure nobody
   has. Every total in this file is suppressed unless both halves are real. */
const unknown = '?';

const pad = (n, w) => String(n).padStart(w);

/* A DAY IS NOT A LABEL, and routing it through `label()` silently destroyed the
   per-day table: `SAFE` describes vocabulary ids, enums and error codes, and a
   date matches none of them, so every day in the corpus collapsed into a single
   `(unrecognised)` bucket. The suite passed while it did, because no test
   asserted a date appears; it was caught by reading the output.

   Gated rather than trusted, on the same shape `digestReport` uses for its own
   day. The field is written by `getDay` and nothing else today, and that is
   exactly the "it holds because of who happens to call it" reasoning _metrics.mjs
   spends eleven lines warning about. */
const dayLabel = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '(undated)');

/* Counted highest first, then alphabetically, so two runs over the same rows
   print identically and a diff between two runs is readable.

   EVERY KEY GOES THROUGH `label()`. The CLI used to print `r.refs` verbatim
   while the mail sanitised, which left the operator's terminal as the soft
   reader of a corpus the mail had been hardened against: spec/vocabulary.md:43
   makes `money.` a prefix admitting anything, so a stranger's sentence could
   validate, publish and print here as written. _metrics.mjs collapses money refs
   at WRITE time, which does nothing for rows already stored, and this corpus is
   never swept. */
const tally = (src, pick) => {
  const t = new Map();
  for (const r of src) {
    for (const v of [].concat(pick(r) ?? [])) {
      if (v === undefined || v === null) continue;
      const k = label(v);
      t.set(k, (t.get(k) || 0) + 1);
    }
  }
  return [...t.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

const mean = (rows, pick) =>
  rows.length ? (rows.reduce((s, r) => s + (Number(pick(r)) || 0), 0) / rows.length).toFixed(1) : '0.0';

export function metricsReport({ pub, ref, since = '' }) {
  const out = [];
  const line = s => out.push(s);
  const section = t => { line(''); line(t); line('─'.repeat(t.length)); };

  /* Read failures are named BEFORE any number, because a caveat printed under a
     figure arrives after the reader has believed it. */
  for (const [name, c] of [['metrics', pub], ['attempts', ref]]) {
    if (!c.listed) {
      line(`COULD NOT READ THE \`${name}\` STORE: ${c.reason || 'no reason given'}`);
      line('Everything below that depends on it is missing, not zero.');
      line('');
    }
  }

  /* NEITHER STORE READ MEANS NO REPORT, and returning here rather than printing
     a tidy zero is the whole point of the check above. The first version of this
     code printed the banner and then printed "0 published, 0 refused" and
     "nothing was published" underneath it anyway. A banner does not survive
     being scrolled past or read second; the numbers do. That is the defect
     digest.mjs's header records as the worst one in its own first version,
     reproduced here by someone who had read that header the same hour.

     A warning above a number does not make the number true. */
  if (!pub.listed && !ref.listed) {
    line('Neither store could be read, so there is nothing to report.');
    return { lines: out, code: 1 };
  }

  const rows = pub.rows || [];
  const attempts = ref.rows || [];
  const n = rows.length;
  const refused = attempts.length;
  const bothRead = pub.listed && ref.listed;
  const nStr = pub.listed ? String(n) : unknown;
  const refStr = ref.listed ? String(refused) : unknown;

  if (bothRead && !n && !refused) {
    line(since ? `Nothing uploaded on or after ${since}.` : 'Nothing uploaded yet.');
    line('Not an error: both stores were read and hold no rows.');
    return { lines: out, code: 0 };
  }

  /* The owner-review gate refuses once BY DESIGN and accepts on the retry, so a
     naive publish+refusal total counts one upload twice. The proof that this is
     exact rather than estimated is in _digest.mjs above `GATE`: a publish
     carrying `owner_confirmed: false` can only have happened by presenting a
     ticket minted at exactly one refusal. `min` because somebody who retries
     WITHOUT the ack is refused twice and publishes once, and that second refusal
     is a real bounce rather than the design inflating anything. */
  const over = Math.min(
    attempts.filter(r => r && r.code === GATE).length,
    rows.filter(r => r && r.owner_confirmed === false).length
  );

  /* THE RANGE IS GATED TOO, and it was the last ungated read of this field.
     `dayLabel` was added for the per-day table and this line still interpolated
     `r.day` verbatim into the headline — the one line of the report that gets
     copied into a message. Same defect as _digest.mjs's ungated subject, found
     the same way: by a test written for the table below catching the line above
     it. A row whose day is not a date is excluded from the range rather than
     bucketed, because `(undated)` sorts as a bound and would print as one. */
  const span = [...new Set(rows.map(r => r.day).concat(attempts.map(r => r.day)))]
    .filter(d => dayLabel(d) !== '(undated)').sort();
  line(span.length
    ? `${nStr} published, ${refStr} refused, ${span[0]} to ${span[span.length - 1]}`
    : `${nStr} published, ${refStr} refused`);

  /* A sum with an unknown in it is not a smaller number, it is not a number. */
  if (bothRead) {
    line(`${n + refused} uploads attempted${over ? `, over-counted by ${over} (owner gate)` : ''}`);
  }

  /* "attempted", never "people". One person can upload five times and nothing in
     either corpus can tell that from five people uploading once. That is the
     design rather than a gap, and the line says so where the number is. */
  line('Uploads, not people. Nothing here distinguishes one person from five.');

  const dropped = (pub.unreadable || 0) + (ref.unreadable || 0);
  if (dropped) {
    line(`${dropped} row${dropped === 1 ? '' : 's'} could not be parsed and ${dropped === 1 ? 'is' : 'are'} excluded from everything above.`);
  }

  /* ── refusals ─────────────────────────────────────────────────────────── */
  if (refused) {
    section('Why uploads were refused');
    for (const [k, c] of tally(attempts, r => r.code)) {
      line(`  ${pad(c, 4)}  ${pad(Math.round(c / refused * 100), 3)}%  ${k}`);
    }
    line('');
    line('  Percentages here are of refusals, not of uploads.');
    line('  Refusals past the rate limit are not counted: the limiter counts');
    line('  those and its records expire, so this understates a bad day.');

    /* E_INTERNAL is OURS and not theirs. Listed unqualified beside user errors,
       an outage reads as a day of bad uploads, and it is the one code in the
       table worth being woken up for. */
    const ours = attempts.filter(r => r && r.code === 'E_INTERNAL').length;
    if (ours) {
      line('');
      line(`  ${ours} of those ${ours === 1 ? 'is' : 'are'} E_INTERNAL, which is our fault and not theirs:`);
      line('  the upload was well formed and the site failed to store it.');
    }
  } else if (ref.listed) {
    section('Why uploads were refused');
    line('  nothing was refused.');
  }

  if (!pub.listed) {
    line('');
    line('The publish corpus could not be read, so everything below is absent');
    line('rather than empty. Nothing here says no passports were published.');
    return { lines: out, code: 1 };
  }

  if (!n) {
    line('');
    line('Nothing was published, so there is no shape to report below.');
    return { lines: out, code: 0 };
  }

  /* ── what was published ───────────────────────────────────────────────── */
  const pct = c => `${pad(c, 4)}  ${pad(Math.round(c / n * 100), 3)}%`;
  const rowsOut = pairs => pairs.forEach(([k, c]) => line(`  ${pct(c)}  ${k}`));

  section('What they need');
  rowsOut(tally(rows, r => r.refs));

  section('What they declare but cannot install here');
  const outside = tally(rows, r => r.refs_outside_envelope);
  if (outside.length) rowsOut(outside);
  else line('  none. Every agent so far fits the read-and-notify envelope.');

  section('Capabilities per agent');
  const sizes = rows.map(r => (r.refs || []).length).sort((a, b) => a - b);
  line(`  median ${sizes[Math.floor(sizes.length / 2)]}, range ${sizes[0]} to ${sizes[sizes.length - 1]}`);

  section('Pairs that travel together');
  const pairs = new Map();
  for (const r of rows) {
    const s = [...new Set((r.refs || []).map(label))].sort();
    for (let i = 0; i < s.length; i++) {
      for (let j = i + 1; j < s.length; j++) {
        const k = `${s[i]} + ${s[j]}`;
        pairs.set(k, (pairs.get(k) || 0) + 1);
      }
    }
  }
  const top = [...pairs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8);
  if (top.length) rowsOut(top); else line('  nothing co-occurs yet.');

  section('How it runs');
  rowsOut(tally(rows, r => r.trigger));

  section('Where it was captured');
  rowsOut(tally(rows, r => r.capture_path));

  section('Did the owner confirm the description');
  rowsOut(tally(rows, r => (r.owner_confirmed ? 'confirmed' : 'did-not-confirm')));

  section('Scrub reviewed by the owner');
  rowsOut(tally(rows, r => (r.scrub_reviewed ? 'reviewed' : 'not-reviewed')));

  /* THE ENTROPY-GATE TRIGGER, readable here since 2026-10-22. _metrics.mjs
     quotes it above highEntropyHits: add the generic rule "when 50 publishes
     have been recorded and fewer than one in twenty carries a non-zero
     high_entropy_hits". The field has been written since 2026-08-31 and read
     by nothing, so the trigger could only be checked by hand from --json.

     Split by capture_path, because the population a generic rule would
     protect is the browser path, which never runs scrub.py. `no markers` is
     the non-zero rows with `redactions` false: no [SCRUBBED: marker at all,
     the case _metrics.mjs names as the one that decides whether the rule is
     worth its false positives. A row without the field predates it and is
     NOT a zero, so it is left out of `recorded`, the trigger's denominator. */
  section('High-entropy strings (the entropy-gate trigger)');
  const hits = r => (r && Number.isInteger(r.high_entropy_hits) && r.high_entropy_hits >= 0 ? r.high_entropy_hits : null);
  const byPath = new Map();
  let rec = 0, nz = 0;
  for (const r of rows) {
    const h = hits(r);
    if (h === null) continue;
    const k = label(r.capture_path);
    const g = byPath.get(k) || { rec: 0, nz: 0, bare: 0 };
    g.rec++; rec++;
    if (h > 0) { g.nz++; nz++; if (r.redactions === false) g.bare++; }
    byPath.set(k, g);
  }
  if (!rec) line('  no row records high_entropy_hits yet.');
  for (const [k, g] of [...byPath.entries()].sort((a, b) => b[1].rec - a[1].rec || a[0].localeCompare(b[0]))) {
    line(`  ${pad(g.rec, 4)} recorded  ${pad(g.nz, 4)} non-zero ${pad(Math.round(g.nz / g.rec * 100), 3)}%  ${pad(g.bare, 4)} with no markers  ${k}`);
  }
  if (n > rec) line(`  ${n - rec} ${n - rec === 1 ? 'row predates the field and is' : 'rows predate the field and are'} not counted.`);
  line(rec < 50
    ? `  trigger: not readable yet, ${rec} of the 50 recorded publishes it needs.`
    : nz * 20 < rec
      ? `  trigger: met, ${nz} of ${rec} non-zero is fewer than one in twenty.`
      : `  trigger: not met, ${nz} of ${rec} non-zero is one in twenty or more.`);

  section('Comparison mode');
  const modes = tally(rows, r => r.comparison_mode);
  if (modes.length) rowsOut(modes);
  else line('  not recorded on any row.');

  section('Shape');
  line(`  inputs        mean ${mean(rows, r => r.inputs)}`);
  line(`  personal slots mean ${mean(rows, r => r.slots)}`);
  line(`  checks        mean ${mean(rows, r => r.checks)}`);
  line(`  golden examples mean ${mean(rows, r => r.goldens)}`);
  line(`  consent rows  mean ${mean(rows, r => r.consent && r.consent.rows)}, of which required ${mean(rows, r => r.consent && r.consent.required)}`);
  line(`  credentialed inputs mean ${mean(rows, r => r.access && r.access.credentialed)} of ${mean(rows, r => (r.access ? (r.access.open || 0) + (r.access.credentialed || 0) : 0))}`);

  const wrong = rows.filter(r => r.consent && r.consent.refs_in_wrong_column > 0).length;
  if (wrong) {
    section('Format drift');
    line(`  ${wrong} passport${wrong === 1 ? '' : 's'} put a vocabulary id in the Capability column,`);
    line('  which spec/passport-0.1.md section 3 says should be plain language.');
  }

  section('Per day');
  const byDay = new Map();
  for (const r of rows) {
    const k = dayLabel(r && r.day);
    byDay.set(k, (byDay.get(k) || 0) + 1);
  }
  rowsOut([...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  line('');

  return { lines: out, code: 0 };
}

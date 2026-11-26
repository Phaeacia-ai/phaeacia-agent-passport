/* lib/_metrics.mjs, lib/_metrics-report.mjs and lib/_digest.mjs: the metrics record, the daily digest
   and the corpus report.

   Split out of the former tools/run-tests.mjs. Shared setup (the in-memory blob double, reset(),
   GOOD, ...) is in ./_helpers.mjs, which also installs that double before any lib is exercised.
   Run just this file with: node --test tools/digest.test.mjs */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GOOD, derive, validate } from './_helpers.mjs';

/* ── metrics ─────────────────────────────────────────────────────────────
   BACKEND-PLAN.md section 2 prints the record this schema produces for
   examples/daily-brief-passport.md, and says every count in it can be checked
   against a file in this repository rather than taken on trust. That promise is
   only worth something if something checks it, because the document and the
   code drift the moment one of them is edited alone. This is that check: the
   values below are the ones printed there, and the byte figure the document
   uses to argue against Postgres is asserted too. */
/* The schema, pinned to a fixture rather than to examples/daily-brief-passport.md.

   It read the real example at first, which was wrong in a way worth recording:
   that example is shared with the capture skill, the spec and the marketing
   site's static sample, so it changes for reasons that have nothing to do with
   this parser, and every such change turns into a red build here. It broke
   within the hour, when another session added a consent row to it. A golden test
   that fails when somebody edits a different subsystem trains people to ignore
   it.

   So the exact record is asserted against the fixture below, which is the
   example as it stood on 2026-08-10, when BACKEND-PLAN.md section 2 printed the
   record it prints. The test after this one keeps the real example honest, with
   invariants that survive it being edited. */
const METRICS_FIXTURE = `---
passport: "0.1"
name: daily-brief
title: Daily Brief
created: 2026-08-06
capture_path: file
source_stack: python scripts on macOS
owner_confirmed: true
scrub: "regex+llm, owner-reviewed"
envelope: read-notify
---

## 3. Functional spec

\`\`\`yaml
goal:
  value: deliver a short morning briefing that replaces scrolling the news
trigger:
  value: scheduled(weekdays, 06:45 local)

inputs:
  - what: general and regional news sources
    capability_ref: web.fetch
    access: open
    criticality: core
  - what: two specialist sources
    capability_ref: web.fetch
    access: open
    criticality: core
  - what: one subscription wire
    capability_ref: web.fetch
    access: credentialed
    criticality: optional
  - what: today's calendar events
    capability_ref: calendar.read
    access: credentialed
    criticality: optional
  - what: the forecast for one city
    capability_ref: web.fetch
    access: open
    criticality: optional

comparison_mode: structural

capabilities:
  - capability_ref: web.fetch
    status: used
  - capability_ref: calendar.read
    status: used
  - capability_ref: schedule.run
    status: used
  - capability_ref: chat.notify
    status: used
  - capability_ref: memory.prefs
    status: used
  - capability_ref: email.send
    status: declared_only

personal_slots:
  - id: topics
  - id: city
  - id: delivery_time
  - id: story_count
  - id: register

verification:
  - check: "each requested topic has at least one item"
  - check: "every item is dated within 24 hours of the run"
  - check: "the three sections appear in order"
  - check: "no item is a bare headline"
\`\`\`

## 4. Golden examples

Captured 2026-08-09, with [SCRUBBED:NAME] removed.

\`\`\`
MORNING BRIEF
\`\`\`
`;

/* The consent table's five rows as _derive.mjs produces them. Hand-built,
   because metricsRecord reads only two booleans per row off this. */
const METRICS_NEEDS = [
  { required: true,  installable: true },
  { required: false, installable: true },
  { required: false, installable: true },
  { required: false, installable: true },
  { required: false, installable: false }
];

test('the metrics record is exactly the one BACKEND-PLAN section 2 prints', async () => {
  const { metricsRecord } = await import('../lib/_metrics.mjs');

  const rec = metricsRecord({
    front: {
      passport: '0.1', envelope: 'read-notify', capture_path: 'file',
      owner_confirmed: 'true', scrub: 'regex+llm, owner-reviewed'
    },
    lines: METRICS_FIXTURE.split('\n'),
    needs: METRICS_NEEDS,
    body: METRICS_FIXTURE,
    day: '2026-08-10'
  });

  assert.deepEqual(rec, {
    v: 1,
    day: '2026-08-10',
    spec: '0.1',
    envelope: 'read-notify',
    capture_path: 'file',
    owner_confirmed: true,
    scrub_reviewed: true,
    redactions: true,
    high_entropy_hits: 0,
    trigger: 'scheduled',
    comparison_mode: 'structural',
    refs: ['web.fetch', 'calendar.read', 'schedule.run', 'chat.notify', 'memory.prefs', 'email.send'],
    refs_declared_only: ['email.send'],
    refs_outside_envelope: ['email.send'],
    access: { open: 3, credentialed: 2 },
    criticality: { core: 2, optional: 3 },
    inputs: 5,
    slots: 5,
    checks: 4,
    goldens: 1,
    consent: { rows: 5, required: 1, installable: 4, declared: 1, refs_in_wrong_column: 0 }
  });

  /* 600 bytes. Was 578, the figure BACKEND-PLAN section 4 argues the storage
     decision on, until high_entropy_hits was added on 2026-08-31 for ROW-108.
     22 bytes per record at a zero count, a little more once counts run to two
     digits. BACKEND-PLAN still says 578 and is now stale on this number; it is
     background material rather than authority and not this lane's file, so the
     drift is recorded here and reported rather than edited there. The storage
     argument is unaffected at this magnitude, which is why the field was judged
     affordable, but somebody re-deriving that argument from 578 should know the
     figure moved and why. */
  assert.equal(Buffer.byteLength(JSON.stringify(rec), 'utf8'), 600);
});

/* The real example, checked for what must hold whatever anybody adds to it.
   This is the half that keeps working when that file changes. */
test('the metrics record stays coherent against the repository example', async () => {
  const { metricsRecord } = await import('../lib/_metrics.mjs');

  const v = validate(GOOD);
  assert.deepEqual(v.errors, [], 'the repository example no longer validates');
  const d = derive(v.front, v.lines);
  assert.equal(d.error, undefined);

  const rec = metricsRecord({
    front: v.front, lines: v.lines, needs: d.record.needs, body: GOOD, day: '2026-08-10'
  });

  const VOCAB = new Set([
    'web.fetch', 'email.read', 'calendar.read', 'files.read', 'schedule.run',
    'chat.notify', 'memory.prefs', 'email.send', 'msg.send', 'social.post', 'ext.write'
  ]);
  assert.ok(rec.refs.length > 0, 'no capability ids were read out of section 3');
  for (const ref of rec.refs) {
    assert.ok(VOCAB.has(ref) || ref.startsWith('money.'), `${ref} is not in the vocabulary`);
  }
  assert.equal(new Set(rec.refs).size, rec.refs.length, 'refs are not deduped');
  for (const ref of rec.refs_declared_only) assert.ok(rec.refs.includes(ref));
  for (const ref of rec.refs_outside_envelope) assert.ok(rec.refs.includes(ref));

  assert.equal(rec.consent.installable + rec.consent.declared, rec.consent.rows);
  assert.ok(rec.consent.required <= rec.consent.rows);
  assert.equal(rec.consent.rows, d.record.needs.length);
  assert.equal(rec.inputs, rec.access.open + rec.access.credentialed);
  assert.ok(['scheduled', 'on_demand', 'event', 'unknown'].includes(rec.trigger));
  assert.ok(['structural', 'exact', 'input_relative'].includes(rec.comparison_mode));
  assert.match(rec.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(rec.goldens >= 1 && rec.goldens <= 3, `goldens out of spec range: ${rec.goldens}`);
  assert.ok(rec.checks >= 2 && rec.checks <= 4, `checks out of spec range: ${rec.checks}`);
});

/* The trigger is read off the trigger mapping's own value line. The first
   `value:` in section 3 belongs to `goal:`, which sits above trigger in the
   template and therefore in every passport that follows it, so a naive read
   files every agent in the corpus as `unknown` and the field looks broken only
   once there is a corpus to notice it in. */
test('the trigger is read from the trigger, not from the goal above it', async () => {
  const { metricsRecord } = await import('../lib/_metrics.mjs');
  const lines = [
    '## 3. Functional spec', '```yaml',
    'goal:', '  value: answer questions when somebody asks one', '  confidence: high',
    '', 'trigger:', '  value: scheduled(weekdays, 06:45 local)', '  confidence: high',
    '```'
  ];
  const rec = metricsRecord({
    front: { passport: '0.1', envelope: 'read-notify', capture_path: 'file',
             owner_confirmed: 'true', scrub: 'regex' },
    lines, needs: [], body: '', day: '2026-08-10'
  });
  assert.equal(rec.trigger, 'scheduled');
});

/* ── the daily digest ─────────────────────────────────────
   The digest is the only surface through which the beta is watched, so the
   thing to defend is not that it renders but that it renders the RIGHT day and
   cannot carry prose. A digest that reads an empty store and formats a tidy zero
   looks exactly like one that works, which is why the last test here asserts a
   number that could only have come from the rows it was given. */

test('the digest reports the numbers it was given', async () => {
  const { digestReport } = await import('../lib/_digest.mjs');
  const m = n => Array.from({ length: n }, () => ({
    v: 1, day: '2026-08-18', refs: ['web.fetch'], trigger: 'scheduled',
    capture_path: 'file', owner_confirmed: true, scrub_reviewed: true,
    inputs: 2, slots: 0, checks: 1, goldens: 1, consent: { rows: 3, required: 2 }
  }));
  const a = codes => codes.map(code => ({ v: 1, day: '2026-08-18', code }));

  const { subject, text } = digestReport({
    day: '2026-08-18', metrics: m(3), attempts: a(['E_SCRUB_GATE', 'E_SCRUB_GATE', 'E_CAPABILITY'])
  });

  assert.match(subject, /3 published, 3 refused/);
  assert.match(text, /published\s+3/);
  assert.match(text, /refused\s+3/);
  assert.match(text, /2\s+E_SCRUB_GATE/);
  assert.match(text, /1\s+E_CAPABILITY/);
  assert.match(text, /3\s+web\.fetch/);
});

/* THE RULE FROM _metrics.mjs, FOLLOWED INTO THE MAIL. A digest is exactly where
   "just show me the title" feels reasonable. There is no title in the corpus,
   and this asserts that a row which somehow carried one could still not put it
   in an email. */
test('the digest cannot print prose, even from a row that carries some', async () => {
  const { digestReport } = await import('../lib/_digest.mjs');
  const hostile = {
    v: 1, day: '2026-08-18',
    refs: ['Daily Brief, an agent that reads my mail'],
    trigger: 'a sentence the owner wrote',
    capture_path: '<script>alert(1)</script>',
    title: 'My Secret Project',
    owner_confirmed: true, inputs: 1, slots: 0, checks: 0, goldens: 1,
    consent: { rows: 1, required: 1 }
  };
  const { subject, text } = digestReport({ day: '2026-08-18', metrics: [hostile], attempts: [] });
  const blob = subject + '\n' + text;

  for (const leak of ['Daily Brief', 'a sentence the owner wrote', '<script>', 'My Secret Project']) {
    assert.equal(blob.includes(leak), false, `the digest printed ${JSON.stringify(leak)}`);
  }
  assert.match(text, /\(unrecognised\)/, 'the digest dropped the value without saying so');
});

test('a quiet day says so rather than printing empty tables', async () => {
  const { digestReport } = await import('../lib/_digest.mjs');
  const { subject, text } = digestReport({ day: '2026-08-18', metrics: [], attempts: [] });
  assert.match(subject, /nothing uploaded/);
  assert.match(text, /Nothing was uploaded on this day/);
  assert.equal(/Why uploads were refused/.test(text), false);
});

/* The owner gate double count, stated where the number is. This is the one
   caveat that must survive a rewrite of the format, because it is the one that
   changes how the headline is read. */
/* Raffael chose one number with its error stated, over a range. That makes the
   over-count line load bearing: it is the only thing standing between a single
   figure and a figure that quietly inflates. So it is asserted as an exact
   count, on the day it happened, and asserted ABSENT on a day it did not. */
test('the digest states the owner-gate over-count as an exact number', async () => {
  const { digestReport } = await import('../lib/_digest.mjs');
  const pub = over => ({ v: 1, refs: [], trigger: 'scheduled', capture_path: 'file',
                         owner_confirmed: !over, consent: {} });

  /* One gated publish, one gated refusal: over-counts by exactly 1. */
  const one = digestReport({
    day: '2026-08-18',
    metrics: [pub(false), pub(true)],
    attempts: [{ v: 1, code: 'E_OWNER_UNCONFIRMED' }, { v: 1, code: 'E_SCRUB_GATE' }]
  }).text;
  assert.match(one, /attempted\s+4/, 'attempted is not a single number');
  assert.match(one, /Over-counts by 1:/);
  assert.equal(/ to /.test(one.split('Why uploads')[0]), false, 'the range came back');

  /* THREE gated refusals but only ONE gated publish. Only the refusal that led
     to a publish is designed inflation; the other two are genuine bounces from
     somebody retrying without their ticket. Subtracting all three would print a
     total below the truth. */
  const capped = digestReport({
    day: '2026-08-18',
    metrics: [pub(true)],
    attempts: [1, 2, 3].map(() => ({ v: 1, code: 'E_OWNER_UNCONFIRMED' }))
  }).text;
  assert.match(capped, /Over-counts by 1:/, 'the over-count exceeded the publishes it can explain');

  /* A clean day must not warn. A caveat that fires when nothing happened is a
     caveat that gets skipped when something did. */
  const clean = digestReport({
    day: '2026-08-18', metrics: [pub(false)], attempts: [{ v: 1, code: 'E_SCRUB_GATE' }]
  }).text;
  assert.equal(/Over-counts/.test(clean), false, 'the digest warned about an inflation that did not happen');

  /* Never "people". With the range gone this is the last thing between the mail
     and a number that reads as users. */
  for (const t of [one, capped, clean]) {
    assert.match(t, /Uploads, not people/);
    assert.equal(/\bpeople,\s+roughly/.test(t), false, 'the digest claimed to count people');
  }
});

/* The money.* hole, closed in _metrics.mjs and defended again here. A ref of
   `money.` plus seventy lowercase letters is a legal capability id by
   spec/vocabulary.md:43, matches the digest's shape check, and reads as a
   sentence. It reached the mail body before this. */
test('a long money ref cannot become a sentence in the mail', async () => {
  const { digestReport } = await import('../lib/_digest.mjs');
  const payload = 'money.urgentyouraccountislockedvisitphaeaciasecuritydotcomtounlockitnow';
  const { text } = digestReport({
    day: '2026-08-18',
    metrics: [{ v: 1, refs: [payload], trigger: 'scheduled', capture_path: 'file',
                owner_confirmed: true, consent: {} }],
    attempts: []
  });
  assert.equal(text.includes('unlockitnow'), false, 'the digest printed a stranger\'s sentence');
  /* Rendered as the prefix rather than as (unrecognised): the capability is
     real and worth counting, only its spelling is untrustworthy. A cap alone
     would not do this — `money.callus18005551212now` is 26 characters and reads
     as an instruction — so anything under the prefix collapses regardless of
     length, at read time as well as write time, because the store is never
     swept and rows written before the write-side fix are permanent. */
  assert.match(text, /money\.\*/, 'the money capability was dropped instead of collapsed');
  /* And the legitimate spelling still prints. */
  const ok = digestReport({
    day: '2026-08-18',
    metrics: [{ v: 1, refs: ['money.*'], trigger: 'scheduled', capture_path: 'file',
                owner_confirmed: true, consent: {} }],
    attempts: []
  }).text;
  assert.match(ok, /money\.\*/);
});

/* And the same payload must not reach the record in the first place. */
test('metricsRecord collapses every money ref to the prefix', async () => {
  const { metricsRecord } = await import('../lib/_metrics.mjs');
  const { validate } = await import('../lib/_validate.mjs');
  const { derive } = await import('../lib/_derive.mjs');
  const { readFile } = await import('node:fs/promises');
  const good = await readFile(new URL('../../examples/daily-brief-passport.md', import.meta.url), 'utf8');
  const payload = 'money.urgentyouraccountislockedvisitphaeaciasecuritydotcomtounlockitnow';
  const text = good.replace('capability_ref: web.fetch', 'capability_ref: ' + payload);

  const v = validate(text);
  assert.equal(v.errors.length, 0, 'fixture no longer validates, so it no longer tests the hole');
  const d = derive(v.front, v.lines);
  const rec = metricsRecord({ front: v.front, lines: v.lines, needs: d.record.needs,
                              body: text, day: '2026-08-18' });
  assert.equal(JSON.stringify(rec).includes('unlockitnow'), false,
               'the metrics record stored a stranger\'s sentence');
  assert.ok(rec.refs.includes('money.*'), 'the money capability was dropped rather than collapsed');
  assert.ok(rec.refs_outside_envelope.includes('money.*'), 'collapsing broke the envelope check');
});

/* WRITER TO READER, THE WHOLE CHAIN, because the two halves were verified
   separately and never against each other. ROW-81 closed the write side and
   proved the row is clean; the CLI that reads that row was not written yet.

   Two rows, and the second is the one that matters. A row written TODAY is
   already collapsed, so a reader that did nothing would still look correct — 
   which is exactly how tools/metrics.mjs printed refs verbatim for ten days
   without anybody noticing. The row written BEFORE the write-side fix is the
   permanent case: this corpus is never swept, so those rows are read again on
   every run, forever, and the reader is the only thing standing in front of
   them. */
test('a money payload is safe through the real writer and the real corpus reader', async () => {
  const { metricsRecord } = await import('../lib/_metrics.mjs');
  const { metricsReport } = await import('../lib/_metrics-report.mjs');
  const { validate } = await import('../lib/_validate.mjs');
  const { derive } = await import('../lib/_derive.mjs');
  const { readFile } = await import('node:fs/promises');
  const good = await readFile(new URL('../../examples/daily-brief-passport.md', import.meta.url), 'utf8');
  const payload = 'money.urgentyouraccountislockedvisitphaeaciasecuritydotcomtounlockitnow';
  const text = good.replace('capability_ref: web.fetch', 'capability_ref: ' + payload);

  const v = validate(text);
  assert.equal(v.errors.length, 0, 'fixture no longer validates, so it no longer tests the hole');
  const d = derive(v.front, v.lines);
  const written = metricsRecord({ front: v.front, lines: v.lines, needs: d.record.needs,
                                  body: text, day: '2026-08-18' });

  const live = metricsReport({
    pub: { rows: [written], listed: true, unreadable: 0 },
    ref: { rows: [], listed: true, unreadable: 0 }
  }).lines.join('\n');
  assert.equal(live.includes('unlockitnow'), false, 'a row from the real writer printed prose');
  assert.match(live, /money\.\*/, 'the money capability vanished instead of collapsing');

  /* THE PRE-FIX ROW. Written before normaliseRef existed, permanent because
     nothing sweeps this store, and reaching the reader raw. If the reader ever
     stops sanitising, this is the assertion that goes red rather than the one
     above, which the writer would keep green on its own. */
  const legacy = { ...written, refs: [payload, 'web.fetch'] };
  const old = metricsReport({
    pub: { rows: [legacy], listed: true, unreadable: 0 },
    ref: { rows: [], listed: true, unreadable: 0 }
  }).lines.join('\n');
  assert.equal(old.includes('unlockitnow'), false,
               'a row stored before the write-side fix reached the operator');
  assert.match(old, /money\.\*/, 'and it is still counted, under the prefix');
});

/* THE OUTAGE CASE, which is the one this mail was blind to. readCorpusDay
   distinguishes a failed listing from an empty store; the handler used to drop
   that, so a blob outage printed "Nothing was uploaded on this day. Not an
   error" — asserting the negative it could not know, in the sentence written to
   stop the reader worrying. */
test('a store that could not be listed is not reported as a quiet day', async () => {
  const { digestReport } = await import('../lib/_digest.mjs');

  const broken = digestReport({ day: '2026-08-18', metrics: [], attempts: [], listed: false });
  assert.equal(/Not an error/.test(broken.text), false,
               'an unreachable store was reported as a day with nothing on it');
  assert.match(broken.text, /could not be listed/i);
  assert.match(broken.subject, /incomplete|unavailable|could not/i,
               'the subject line reads like a normal day');

  /* And a genuinely empty day still says so plainly. */
  const empty = digestReport({ day: '2026-08-18', metrics: [], attempts: [], listed: true });
  assert.match(empty.text, /Nothing was uploaded on this day/);
});

/* The subject is the only line that travels: forwarded, screenshotted, read off
   a lock screen. "7 refused" reads as a failure rate to anybody skimming, and
   on a gate-heavy day most of those refusals are the design working. */
test('the subject qualifies refusals that were the owner gate', async () => {
  const { digestReport } = await import('../lib/_digest.mjs');
  const pub = over => ({ v: 1, refs: [], trigger: 'scheduled', capture_path: 'file',
                         owner_confirmed: !over, consent: {} });
  const { subject } = digestReport({
    day: '2026-08-18',
    metrics: [pub(true), pub(false)],
    attempts: [{ v: 1, code: 'E_OWNER_UNCONFIRMED' }, { v: 1, code: 'E_SCRUB_GATE' }]
  });
  assert.match(subject, /owner.gate/i, 'the subject files a designed two-step under "refused" unqualified');

  const clean = digestReport({
    day: '2026-08-18', metrics: [pub(false)], attempts: [{ v: 1, code: 'E_SCRUB_GATE' }]
  }).subject;
  assert.equal(/owner.gate/i.test(clean), false, 'the subject qualifies a day with no gated publish');
});

/* E_INTERNAL is the site failing, not the upload. Listing it unqualified beside
   user errors makes an outage read as a day of bad files. */
test('the digest separates our failures from theirs', async () => {
  const { digestReport } = await import('../lib/_digest.mjs');
  const { text } = digestReport({
    day: '2026-08-18', metrics: [],
    attempts: [{ v: 1, code: 'E_INTERNAL' }, { v: 1, code: 'E_INTERNAL' },
               { v: 1, code: 'E_SCRUB_GATE' }]
  });
  assert.match(text, /2 of those are E_INTERNAL/);
  assert.match(text, /our fault and not/);
});

/* ── the corpus report ────────────────────────────────────────
   tools/metrics.mjs is the only on-demand read of either corpus, and until
   2026-08-30 it read one of the two and none of it was testable, because the
   report lived inside a script whose only input was a live store. The judgement
   half now lives in lib/_metrics-report.mjs, and these are the cases that were
   wrong when it was written. Each one was a real defect, not a hypothetical. */

const corpus = (rows, extra = {}) => ({ rows, listed: true, unreadable: 0, ...extra });
const dead = reason => ({ rows: [], listed: false, reason });
const published = (o = {}) => ({
  v: 1, day: '2026-08-18', refs: ['web.fetch'], trigger: 'scheduled',
  capture_path: 'skill', owner_confirmed: true, scrub_reviewed: true, ...o
});

/* THE DEFECT THIS FILE EXISTS FOR. The first version printed the failure banner
   and then printed "0 published, 0 refused" and "nothing was published"
   underneath it. A banner does not survive being read second; the numbers do. */
test('an unreadable corpus reports nothing rather than zero', async () => {
  const { metricsReport } = await import('../lib/_metrics-report.mjs');
  const { lines, code } = metricsReport({ pub: dead('boom'), ref: dead('boom') });
  const text = lines.join('\n');
  assert.equal(code, 1, 'a failed read exits non-zero so a script notices too');
  assert.match(text, /COULD NOT READ/);
  assert.equal(/0 published/.test(text), false, 'never asserts a count it does not have');
  assert.equal(/[Nn]othing was published/.test(text), false);
});

/* The asymmetric case, which is the one a two-store reader adds: a healthy
   publish report with "0 refused" under it is a specific false claim. */
test('one dead corpus does not become a zero in the other half of the report', async () => {
  const { metricsReport } = await import('../lib/_metrics-report.mjs');
  const { lines, code } = metricsReport({ pub: corpus([published()]), ref: dead('boom') });
  const text = lines.join('\n');
  assert.equal(code, 0, 'the half that read is still worth printing');
  assert.match(text, /1 published, \? refused/, 'unknown renders as ? and not as 0');
  assert.equal(/uploads attempted/.test(text), false, 'no total, because a sum with an unknown is not a number');
});

test('a genuinely empty pair of stores says so, and is not an error', async () => {
  const { metricsReport } = await import('../lib/_metrics-report.mjs');
  const { lines, code } = metricsReport({ pub: corpus([]), ref: corpus([]) });
  assert.equal(code, 0);
  assert.match(lines.join('\n'), /Not an error: both stores were read/);
});

/* THE RULE FROM _metrics.mjs, FOLLOWED INTO THE TERMINAL. The CLI printed refs
   verbatim while the mail sanitised, so the operator's screen was the soft
   reader of the corpus the mail had been hardened against. `money.` is a prefix
   admitting anything, and this corpus is never swept, so a row written before
   the write-side fix is permanent. */
test('the corpus report cannot print prose, even from a row that carries some', async () => {
  const { metricsReport } = await import('../lib/_metrics-report.mjs');
  const nasty = 'money.callus18005551212nowtounlockyouraccount';
  const { lines } = metricsReport({
    pub: corpus([published({ refs: [nasty, 'web.fetch'] })]),
    ref: corpus([])
  });
  const text = lines.join('\n');
  assert.equal(text.includes('callus18005551212now'), false, 'a stranger cannot reach the operator through a ref');
  assert.match(text, /money\.\*/, 'and it is still counted, under the prefix');
});

/* Refusals are the half this tool could not see at all before. */
test('the corpus report counts refusals by code', async () => {
  const { metricsReport } = await import('../lib/_metrics-report.mjs');
  const { lines } = metricsReport({
    pub: corpus([]),
    ref: corpus([{ v: 1, day: '2026-08-18', code: 'E_SCRUB_GATE' },
                 { v: 1, day: '2026-08-18', code: 'E_SCRUB_GATE' },
                 { v: 1, day: '2026-08-18', code: 'E_INTERNAL' }])
  });
  const text = lines.join('\n');
  assert.match(text, /0 published, 3 refused/);
  assert.match(text, /E_SCRUB_GATE/);
  assert.match(text, /1 of those is E_INTERNAL/, 'our failure is separated from theirs');
  assert.match(text, /understates a bad day/, 'and the limiter gap is stated where the number is');
});

/* The owner gate refuses once by design and accepts on the retry, so the naive
   total counts one upload twice. The arithmetic is _digest.mjs's and is imported
   rather than restated; this asserts the CLI actually applies it. */
test('the corpus report declares the owner-gate over-count', async () => {
  const { metricsReport } = await import('../lib/_metrics-report.mjs');
  const { lines } = metricsReport({
    pub: corpus([published({ owner_confirmed: false })]),
    ref: corpus([{ v: 1, day: '2026-08-18', code: 'E_OWNER_UNCONFIRMED' }])
  });
  assert.match(lines.join('\n'), /2 uploads attempted, over-counted by 1 \(owner gate\)/);
});

test('the corpus report never says people', async () => {
  const { metricsReport } = await import('../lib/_metrics-report.mjs');
  const { lines } = metricsReport({ pub: corpus([published()]), ref: corpus([]) });
  assert.match(lines.join('\n'), /Uploads, not people/);
});

/* A DAY IS NOT A LABEL. Routing days through `label()` collapsed every date into
   one `(unrecognised)` bucket and destroyed the per-day table. The suite was
   green while it did, because nothing asserted a date survives; it was found by
   reading the output. This is that assertion. */
test('the corpus report keeps days apart, and still does not trust the field', async () => {
  const { metricsReport } = await import('../lib/_metrics-report.mjs');
  const { lines } = metricsReport({
    pub: corpus([published({ day: '2026-08-18' }), published({ day: '2026-08-19' }),
                 published({ day: 'a sentence somebody wrote' })]),
    ref: corpus([])
  });
  const text = lines.join('\n');
  assert.match(text, /2026-08-18/, 'a real day survives');
  assert.match(text, /2026-08-19/, 'and is counted separately from its neighbour');
  assert.match(text, /\(undated\)/, 'a day that is not a date is bucketed, not printed');
  assert.equal(text.includes('a sentence somebody wrote'), false, 'and never printed verbatim');
});

/* THE ENTROPY-GATE TRIGGER (_metrics.mjs, above highEntropyHits) had no reader:
   high_entropy_hits was written on every publish from 2026-08-31 and the report
   tallied neither it nor `redactions`, so "50 recorded and fewer than one in
   twenty non-zero" could only be checked by hand from --json. Split by
   capture_path, because the browser path is the population the rule is for. */
test('the corpus report tallies high_entropy_hits by capture path and reads the trigger', async () => {
  const { metricsReport } = await import('../lib/_metrics-report.mjs');
  const rows = [
    ...Array.from({ length: 30 }, () => published({ capture_path: 'file', high_entropy_hits: 0, redactions: true })),
    published({ capture_path: 'file', high_entropy_hits: 2, redactions: true }),
    ...Array.from({ length: 18 }, () => published({ capture_path: 'browser', high_entropy_hits: 0, redactions: false })),
    published({ capture_path: 'browser', high_entropy_hits: 1, redactions: false }),
    published({ capture_path: 'browser', high_entropy_hits: 3, redactions: false }),
    published({ capture_path: 'browser' })                  // written before the field existed
  ];
  const text = metricsReport({ pub: corpus(rows), ref: corpus([]) }).lines.join('\n');
  assert.match(text, /High-entropy strings/);
  assert.match(text, /\s31 recorded\s+1 non-zero\s+3%\s+0 with no markers\s+file/);
  assert.match(text, /\s20 recorded\s+2 non-zero\s+10%\s+2 with no markers\s+browser/);
  assert.match(text, /1 row predates the field and is not counted/, 'a row without the field was counted as a zero');
  assert.match(text, /trigger: not met, 3 of 51 non-zero is one in twenty or more/);

  const quiet = rows.map(r => (r.high_entropy_hits > 0 ? { ...r, high_entropy_hits: 0 } : r));
  assert.match(metricsReport({ pub: corpus(quiet), ref: corpus([]) }).lines.join('\n'),
    /trigger: met, 0 of 51 non-zero is fewer than one in twenty/);
  assert.match(metricsReport({ pub: corpus(rows.slice(0, 10)), ref: corpus([]) }).lines.join('\n'),
    /trigger: not readable yet, 10 of the 50/, 'ten rows were read as enough to decide');
});

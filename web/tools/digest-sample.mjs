#!/usr/bin/env node
/* Render a digest to stdout, from rows made up here, and send nothing.
 *
 *   node tools/digest-sample.mjs            a busy day
 *   node tools/digest-sample.mjs --quiet    a day with nothing on it
 *   node tools/digest-sample.mjs --gate     a day dominated by the owner gate
 *
 * This exists so the mail can be READ before it is ever sent. Raffael agreed to
 * the idea of a daily digest and has not seen one, and a format is not agreed
 * until somebody has looked at it.
 *
 * IT OPENS NO STORE AND SENDS NO MAIL. There is no code path in this file that
 * can, deliberately: it imports the pure report builder and nothing else, so it
 * cannot be turned into a send by a flag or by an environment variable that
 * happens to be set. Running it against the real corpus would need the site id
 * and a token, which is tools/metrics.mjs's job and is behind the human gate.
 *
 * The rows below are invented and say so. They are shaped like real ones — the
 * fields metricsRecord actually produces — because a sample built from a
 * different shape than the real record would validate the format against the
 * wrong thing.
 */

import { digestReport } from '../lib/_digest.mjs';

const args = process.argv.slice(2);
const has = n => args.includes(`--${n}`);

const DAY = '2026-08-18';

const metricsRow = (over = {}) => ({
  v: 1, day: DAY,
  spec: '0.1', envelope: 'read-notify', capture_path: 'file',
  owner_confirmed: true, scrub_reviewed: true, redactions: false,
  trigger: 'scheduled', comparison_mode: 'structural',
  refs: ['web.fetch', 'chat.notify'],
  refs_declared_only: [], refs_outside_envelope: [],
  access: { open: 1, credentialed: 1 },
  criticality: { core: 2, optional: 0 },
  inputs: 2, slots: 1, checks: 2, goldens: 2,
  consent: { rows: 5, required: 4, installable: 4, declared: 1, refs_in_wrong_column: 0 },
  ...over
});

const attemptRow = code => ({ v: 1, day: DAY, code });

let metrics, attempts;

if (has('quiet')) {
  metrics = [];
  attempts = [];
} else if (has('gate')) {
  metrics = [metricsRow(), metricsRow({ owner_confirmed: false })];
  attempts = ['E_OWNER_UNCONFIRMED', 'E_OWNER_UNCONFIRMED', 'E_OWNER_UNCONFIRMED',
              'E_SCRUB_GATE'].map(attemptRow);
} else {
  /* One of these published THROUGH the gate: owner_confirmed false plus a
     matching E_OWNER_UNCONFIRMED refusal below. That pair is what the
     over-count line is computed from, so the sample exercises it rather than
     describing it. */
  metrics = [
    metricsRow(),
    metricsRow({ trigger: 'on_demand', refs: ['email.read', 'chat.notify'], capture_path: 'browser' }),
    metricsRow({ trigger: 'on_demand', refs: ['web.fetch', 'files.read', 'chat.notify'], goldens: 1 }),
    metricsRow({ trigger: 'event', refs: ['calendar.read', 'chat.notify'], owner_confirmed: false }),
    metricsRow({ refs: ['web.fetch', 'email.send'], refs_outside_envelope: ['email.send'],
                 refs_declared_only: ['email.send'], scrub_reviewed: false })
  ];
  attempts = ['E_SCRUB_GATE', 'E_SCRUB_GATE', 'E_CAPABILITY', 'E_OWNER_UNCONFIRMED',
              'E_GOLDEN_COUNT', 'E_SECRET_FOUND', 'E_TOO_LARGE'].map(attemptRow);
}

const { subject, text } = digestReport({ day: DAY, metrics, attempts });

console.log('SAMPLE ONLY. Invented rows, nothing read, nothing sent.');
console.log('─'.repeat(72));
console.log(`Subject: ${subject}`);
console.log('─'.repeat(72));
console.log(text);

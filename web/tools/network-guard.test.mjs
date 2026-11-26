/* tools/_helpers.mjs's network guard and environment scrub, run against planted test files in
   processes of their own. Nothing else in the suite can prove them: with the keys taken out, no
   test makes a request it did not stub, so a guard that was deleted or weakened would leave every
   other file green until the day a test leaked a request, which is the day it has to work already.
   Run just this file with: node --test tools/network-guard.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PLANTED = {
  TYPESAFE_API_KEY: 'planted', RESEND_API_KEY: 'planted', HOLD_ALERT_TO: 'ops@example.org',
  JEV_SECRET_HOLD: '0.7', JEV_DISPOSITION: 'hold', MAIL_FROM: 'Planted <planted@example.org>',
  ARCHIVE_MODE: '1'
};

function run(t, body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'network-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, 'fixture.mjs');
  writeFileSync(fixture, `import { test } from 'node:test';\n` +
    `await import(${JSON.stringify(new URL('./_helpers.mjs', import.meta.url).href)});\n` + body);
  /* NODE_TEST_CONTEXT out: under `node --test` this process has it, and a child that inherits it
     reports to a parent runner in a binary stream instead of printing TAP. */
  const env = { ...process.env, ...PLANTED };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test-reporter=tap', fixture], { env, encoding: 'utf8', timeout: 60e3 });
  const tests = Object.fromEntries([...r.stdout.matchAll(/^(not ok|ok) \d+ - (\S+)/gm)].map(m => [m[2], m[1]]));
  return { ...r, out: r.stdout + r.stderr, tests };
}

test('_helpers.mjs: scrubs the site variables and fails the test that made an unstubbed request', t => {
  const r = run(t, `
test('env-scrubbed', () => {
  const left = ${JSON.stringify(Object.keys(PLANTED))}.filter(n => n in process.env);
  if (left.length) throw new Error('still set: ' + left.join(', '));
});
test('direct-request', async () => { await fetch('https://example.invalid/direct').catch(() => {}); });
test('request-object', async () => {
  await fetch(new Request('https://example.invalid/req', { method: 'POST' })).catch(() => {});
});
test('clean', () => {});
`);
  assert.deepEqual(r.tests, { 'env-scrubbed': 'ok', 'direct-request': 'not ok', 'request-object': 'not ok', 'clean': 'ok' }, r.out);
  assert.match(r.out, /made a request no test stubbed[^\n]*GET https:\/\/example\.invalid\/direct/);
  assert.match(r.out, /made a request no test stubbed[^\n]*POST https:\/\/example\.invalid\/req/);
});

test('_helpers.mjs: a request after the last test fails the file', t => {
  const r = run(t, `
test('late-request', () => { setTimeout(() => fetch('https://example.invalid/late').catch(() => {}), 50); });
`);
  assert.deepEqual(r.tests, { 'late-request': 'ok' }, r.out);
  assert.match(r.stderr, /after the last test[^\n]*GET https:\/\/example\.invalid\/late/, r.out);
  assert.notEqual(r.status, 0, 'every test passed, so only the guard can have failed the file');
});

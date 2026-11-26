/* lib/_ops.mjs: the code-only failure line. Its callers are tested where they live (the limiter
   and passport reads in store.test.mjs, sendMail in email.test.mjs, the handlers in
   run-endpoint-tests.mjs); this file pins the two promises the helper makes on its own.
   Run just this file with: node --test tools/ops.test.mjs */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureOps } from './_helpers.mjs';

const { opsLog } = await import('../lib/_ops.mjs');

/* The backstop for a careless caller. A bucket name and a provider error name
   pass; an id, an address, a hash, a slug-length sentence and an object do not,
   whichever field they arrive in. */
test('opsLog writes codes, numbers and short tokens, and nothing that looks like an identifier', async () => {
  const id = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
  const { ops, raw } = await captureOps(() => opsLog('RATELIMIT_STORE_WRITE_FAILED', {
    bucket: 'up-h', name: 'daily_quota_exceeded', status: 429, partial: true,
    id, ip: '203.0.113.9', email: 'reader@example.com', hash: 'deadbeefcafe0123',
    prose: 'the passport called Daily Brief', nested: { id }
  }));
  assert.deepEqual(ops, [{
    code: 'RATELIMIT_STORE_WRITE_FAILED', bucket: 'up-h', name: 'daily_quota_exceeded', status: 429, partial: true,
    id: '?', ip: '?', email: '?', hash: '?', prose: '?', nested: '?'
  }]);
  for (const secret of [id, '203.0.113.9', 'reader@example.com', 'deadbeefcafe0123', 'Daily Brief']) {
    assert.equal(raw.includes(secret), false, `reached the log: ${secret}`);
  }

  const bad = await captureOps(() => opsLog('not a code ' + id));
  assert.deepEqual(bad.ops, [{ code: 'OPS_BAD_CODE' }]);
  assert.equal(bad.raw.includes(id), false);
});

/* It runs inside catch blocks that must return the answer they already return. */
test('opsLog never throws, even when the console does', () => {
  const saved = console.error;
  console.error = () => { throw new Error('console is broken'); };
  try {
    assert.doesNotThrow(() => opsLog('PASSPORT_READ_FAILED', { stage: 'row' }));
    assert.doesNotThrow(() => opsLog(Symbol('x'), null));
  } finally {
    console.error = saved;
  }
});

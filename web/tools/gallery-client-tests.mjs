/* Client outcome controls, using the shipped script with a minimal DOM.
   A committed request with an unreadable response must remain uncertain.
   The parent suite imports this file; it also runs directly with node. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { voteControl } from '../lib/_render.mjs';

const script = await readFile(new URL('../assets/gallery.js', import.meta.url), 'utf8');
const uncertain = 'We could not confirm whether your vote was counted.';
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = (json, status = 200) => ({ status, json: async () => json });

function harness(fetchImpl, { hasStatus = true, hasFetch = true } = {}) {
  const node = (textContent = '') => ({
    textContent, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; }
  });
  const up = node('7'), down = node('2'), upButton = node(), downButton = node(), status = node();
  const classes = new Set(), calls = [];
  let onSubmit;
  const form = {
    ...node(),
    classList: { add: v => classes.add(v), remove: v => classes.delete(v) },
    querySelector: s => ({
      'input[name="id"]': { value: '00000000-0000-4000-8000-000000000001' },
      'button[value="up"]': upButton, 'button[value="down"]': downButton,
      '[data-up]': up, '[data-down]': down,
      '[data-vote-status]': hasStatus ? status : null
    }[s]),
    addEventListener(type, fn) { assert.equal(type, 'submit'); onSubmit = fn; }
  };
  const fetch = (...args) => { calls.push(args); return fetchImpl(...args); };
  runInNewContext(script, {
    document: { querySelectorAll: () => [form] }, window: { fetch: hasFetch ? fetch : undefined }, fetch
  });
  return {
    up, down, upButton, downButton, status, classes, calls, form,
    submit(button = upButton) {
      let prevented = false;
      onSubmit?.({ submitter: button, preventDefault() { prevented = true; } });
      return prevented;
    }
  };
}

test('gallery client: a committed vote with unreadable response stays uncertain, then a retry can succeed', async () => {
  let committed = 0;
  const h = harness(async () => {
    committed++;
    return committed === 1
      ? { status: 200, json: async () => { throw new SyntaxError('truncated response'); } }
      : response({ ok: true, up: 8, down: 2, yours: 'up' });
  });
  assert.equal(h.submit(), true);
  assert.equal(h.status.textContent, 'Saving your vote...');
  await tick();
  assert.equal(committed, 1, 'the fixture must record the vote before losing its response');
  assert.equal(h.status.textContent, uncertain);
  assert.equal(h.up.textContent, '7');
  assert.equal(h.down.textContent, '2');
  assert.equal(h.upButton.attrs['aria-pressed'], undefined);
  assert.ok(h.classes.has('vote-failed'));
  assert.equal(h.submit(), true);
  await tick();
  assert.equal(h.up.textContent, '8');
  assert.equal(h.upButton.attrs['aria-pressed'], 'true');
  assert.equal(h.status.textContent, 'Vote recorded.');
  assert.equal(h.classes.has('vote-failed'), false);
});

test('gallery client: malformed success fields never replace known counts or claim failure', async () => {
  const valid = { ok: true, up: 8, down: 2, yours: 'up' };
  const cases = [
    { ok: true, down: 2, yours: 'up' },
    ...[null, '8', NaN, Infinity, -1, 1.5, 1e21].map(up => ({ ...valid, up })),
    { ...valid, yours: undefined }, { ...valid, yours: 'sideways' }
  ];
  for (const json of cases) {
    const h = harness(async () => response(json));
    h.submit(); await tick();
    assert.equal(h.status.textContent, uncertain);
    assert.equal(h.up.textContent, '7');
    assert.equal(h.down.textContent, '2');
    assert.equal(h.upButton.attrs['aria-pressed'], undefined);
  }
});

test('gallery client: a confirmed rate refusal is distinct from an unknown write outcome', async () => {
  for (const [code, json, expected] of [
    [429, { ok: false }, 'Too many votes from this network in the last hour. Nothing was counted.'],
    [400, { ok: false, error: 'E_VOTE_FAILED' }, uncertain],
    [500, { ok: true, up: 8, down: 2, yours: 'up' }, uncertain]
  ]) {
    const h = harness(async () => response(json, code));
    h.submit(); await tick();
    assert.equal(h.status.textContent, expected);
    assert.equal(h.up.textContent, '7');
  }
});

test('gallery client: fetch rejection and synchronous failure both release the busy guard', async () => {
  for (const fail of [() => { throw Error('fetch failed'); }, () => Promise.reject(Error('response lost'))]) {
    const h = harness(fail);
    h.submit(); await tick();
    assert.equal(h.status.textContent, uncertain);
    assert.equal(h.submit(), true, 'another attempt must be possible');
    await tick();
    assert.equal(h.calls.length, 2);
  }
});

test('gallery client: toggling a confirmed vote requests removal and announces it', async () => {
  const h = harness(async (_url, options) => {
    const { dir } = JSON.parse(options.body);
    return response({ ok: true, up: dir === 'none' ? 7 : 8, down: 2, yours: dir === 'none' ? null : 'up' });
  });
  h.submit(); await tick();
  h.submit(); await tick();
  assert.equal(JSON.parse(h.calls[1][1].body).dir, 'none');
  assert.equal(h.up.textContent, '7');
  assert.equal(h.upButton.attrs['aria-pressed'], 'false');
  assert.equal(h.status.textContent, 'Vote removed.');
});

test('gallery client: in-flight or unsupported enhancement leaves native form submission intact', async () => {
  let resolve;
  const h = harness(() => new Promise(r => { resolve = r; }));
  assert.equal(h.submit(), true);
  await tick();
  assert.equal(h.submit(h.downButton), false);
  assert.equal(h.submit({}), false);
  assert.equal(h.calls.length, 1);
  resolve(response({ ok: true, up: 8, down: 2, yours: 'up' }));
  await tick();
  for (const options of [{ hasStatus: false }, { hasFetch: false }]) {
    const native = harness(() => { throw Error('must not fetch'); }, options);
    assert.equal(native.submit(), false);
    assert.equal(native.calls.length, 0);
  }
});

test('gallery vote markup keeps a real form and an initially empty polite status region', () => {
  let calls = 0;
  const html = voteControl({ toString() { return ++calls === 1 ? '00000000-0000-4000-8000-000000000001' : '" autofocus'; } }, 7, 2, true);
  assert.equal(calls, 1, 'validated id must be the id interpolated');
  assert.match(html, /method="post" action="\/api\/vote"/);
  assert.match(html, /data-vote-status role="status" aria-live="polite" aria-atomic="true"><\/p>/);
  assert.doesNotMatch(html, /autofocus/);
  assert.equal(voteControl('bad-id', 0, 0, true), '');
});

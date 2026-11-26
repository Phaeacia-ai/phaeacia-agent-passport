/* PH-554: the "Copy capture prompt" button says so at the button itself.
   Runs the shipped assets/site.js with a minimal DOM. The parent suite imports
   this file; it also runs directly with node.

   Why this is a test and not a screenshot only: on 2026-09-24 a real owner
   pressed the button and could not tell the prompt had been copied. The
   handler had always fired; its only confirmation was a status line 72px
   (phone) to 94px (laptop) below the button, and nothing at the button
   changed. Nothing in the suite looked at that handler at all. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const script = await readFile(new URL('../assets/site.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const ORIGINAL = 'Copy capture prompt';
const PROMISED = 'Copied. Paste it into your chat.';
const FAILED = 'Could not copy automatically. Select the text below and copy it yourself.';

function harness({ clipboard = 'ok' } = {}) {
  const node = (textContent = '') => ({
    textContent, attrs: {}, hidden: false,
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    hasAttribute(k) { return k in this.attrs; }
  });
  const span = node(ORIGINAL);
  /* The button's own textContent is recorded, not stored: rewriting it would
     delete the icon that sits beside the <span>, which is what the [data-copy]
     buttons do and what this one must not. */
  const buttonWrites = [];
  const button = {
    ...node(),
    get textContent() { return ORIGINAL; },
    set textContent(v) { buttonWrites.push(v); },
    attrs: {
      'data-copy-fetch': '/assets/installer/path-w-block.txt',
      'data-status': 'status', 'data-fallback': 'block'
    },
    querySelector: s => (s === 'span' ? span : null),
    closest(s) { return s === '[data-copy-fetch]' ? this : null; }
  };
  const status = node(), block = node();
  block.id = 'block';
  const listeners = [];
  const timers = new Map();
  let nextTimer = 1;
  const written = [];
  const document = {
    addEventListener: (type, fn) => { if (type === 'click') listeners.push(fn); },
    getElementById: id => ({ status, block })[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    documentElement: { ...node(), removeAttribute() {} }
  };
  const context = {
    document, window: {}, localStorage: { getItem: () => null, setItem() {} },
    navigator: { clipboard: { writeText: async text => {
      if (clipboard === 'reject') throw new Error('blocked');
      written.push(text);
    } } },
    fetch: async () => ({ ok: true, text: async () => 'PROMPT BODY' }),
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => { timers.delete(id); },
    Date, Promise, JSON
  };
  runInNewContext(script, context);
  return {
    span, button, buttonWrites, status, block, written, timers,
    click() { for (const fn of listeners) fn({ target: button }); },
    fireTimers() { for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); } }
  };
}

test('copy-fetch button: on success the button itself says Copied, then restores', async () => {
  const h = harness();
  h.click();
  await tick(); await tick(); await tick();
  assert.equal(h.written.length, 1, 'the fixture must actually reach the clipboard write');
  assert.equal(h.status.textContent, PROMISED, 'the status line is still written, for screen readers');
  assert.equal(h.span.textContent, 'Copied', 'nothing at the button says the prompt was copied');
  assert.deepEqual([...h.timers.values()].map(t => t.ms), [2000], 'the label must come back after two seconds');
  h.fireTimers();
  assert.equal(h.span.textContent, ORIGINAL, 'the button never returned to its own label');
});

test('copy-fetch button: only the span is rewritten, so the icon survives', async () => {
  const h = harness();
  h.click();
  await tick(); await tick(); await tick();
  h.fireTimers();
  assert.deepEqual(h.buttonWrites, [], 'the button textContent was written, which deletes its icon');
});

test('copy-fetch button: a second click inside the two seconds does not store Copied as the label', async () => {
  const h = harness();
  h.click();
  await tick(); await tick(); await tick();
  assert.equal(h.span.textContent, 'Copied');
  h.click();
  await tick(); await tick(); await tick();
  assert.equal(h.timers.size, 1, 'the first timer must be cancelled, not left running beside the second');
  h.fireTimers();
  assert.equal(h.span.textContent, ORIGINAL, 'the button was left reading Copied for good');
});

test('copy-fetch button: when the clipboard refuses, the button does not claim Copied', async () => {
  const h = harness({ clipboard: 'reject' });
  h.click();
  await tick(); await tick(); await tick();
  assert.equal(h.span.textContent, ORIGINAL, 'the button says Copied although nothing was copied');
  assert.equal(h.status.textContent, FAILED);
  assert.equal(h.block.hidden, false, 'the manual-copy fallback must open');
  assert.equal(h.timers.size, 0);
});

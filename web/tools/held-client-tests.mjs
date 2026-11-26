/* PH-518: the held screen and its address box, using the shipped scripts with
   a minimal DOM. The parent suite imports this file; it also runs directly
   with node.

   Two things are under test. assets/share.js must draw the held screen for the
   server's hold response (202, ok:false, code E_HELD, status hold) and must not
   draw the refusal that ends "Nothing was stored", which is false for a hold.
   assets/hold.js must send exactly what /api/hold-email reads and must not show
   the server's "that link is incomplete" sentence to someone who was never
   given a link. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const read = f => readFile(new URL('../assets/' + f, import.meta.url), 'utf8');
const shareSrc = await read('share.js');
const holdSrc = await read('hold.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { for (let i = 0; i < 6; i++) await tick(); };

/* One generic node: every DOM call this code makes exists and does nothing
   unless a test reads what it recorded. */
function node(name = 'node') {
  const n = {
    name, textContent: '', value: '', hidden: false, disabled: false, checked: false,
    attrs: {}, listeners: {}, children: [], className: '', style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    hasAttribute(k) { return k in this.attrs; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    focus() { this.focused = true; },
    scrollIntoView() {},
    remove() {},
    getClientRects: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
    closest: () => null,
    contains: () => false,
    fire(type, ev = {}) { for (const fn of this.listeners[type] || []) fn({ target: this, preventDefault() {}, ...ev }); }
  };
  return n;
}
const allText = n => [n.textContent, ...n.children.map(allText)].join(' ');

/* ---- hold.js ---------------------------------------------------------- */

function holdHarness(fetchImpl) {
  const email = node('email'), btn = node('btn'), errors = node('errors'), done = node('done'), row = node('row');
  btn.textContent = 'Leave my email';
  errors.hidden = true; done.hidden = true;
  const box = node('box');
  box.querySelector = s => ({
    '[data-hold-email]': email, '[data-hold-btn]': btn, '[data-hold-errors]': errors,
    '[data-hold-done]': done, '.formrow': row
  }[s]) || null;
  const calls = [];
  const fetch = (...a) => { calls.push(a); return fetchImpl(...a); };
  const context = { window: {}, document: { createElement: () => node('p') }, fetch };
  runInNewContext(holdSrc, context);
  context.window.PassportHold.attach(box, 'hold-id-1', 'hold-token-1');
  return { email, btn, errors, done, row, calls,
    async submit(address) { email.value = address; email.fire('input'); btn.fire('click'); await flush(); } };
}
const json = (obj) => async () => ({ json: async () => obj });

test('hold box: the button waits for an address, and the request carries exactly the three fields the endpoint reads', async () => {
  const h = holdHarness(json({ ok: true, status: 'ok' }));
  assert.equal(h.btn.disabled, true, 'the button must start disabled');
  h.email.value = 'a@b'; h.email.fire('input');
  assert.equal(h.btn.disabled, true, 'a three character value must not enable the button');
  await h.submit('  owner@example.com ');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], '/api/hold-email');
  assert.equal(h.calls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(h.calls[0][1].body),
    { hold_id: 'hold-id-1', hold_token: 'hold-token-1', email: 'owner@example.com' });
});

test('hold box: on success the form goes and the confirmation stays', async () => {
  const h = holdHarness(json({ ok: true, status: 'ok' }));
  await h.submit('owner@example.com');
  assert.equal(h.row.hidden, true, 'the filled form must not stay beside the confirmation');
  assert.equal(h.btn.hidden, true);
  assert.equal(h.done.hidden, false);
});

test('hold box: E_HOLD_EMAIL_FAILED does not show the server sentence about pasting a link', async () => {
  const h = holdHarness(json({ ok: false, code: 'E_HOLD_EMAIL_FAILED',
    message: 'That link is incomplete, or the hold is gone. Check that you pasted the whole link.' }));
  await h.submit('owner@example.com');
  const shown = allText(h.errors);
  assert.equal(h.errors.hidden, false);
  assert.ok(!/pasted|link/i.test(shown), 'the owner was never given a link: ' + shown);
  assert.ok(/hold/i.test(shown), 'it must say the hold may be gone: ' + shown);
  assert.equal(h.btn.disabled, false, 'the owner must be able to try again');
  assert.equal(h.btn.textContent, 'Leave my email', 'the button label must come back');
});

test('hold box: another server message is shown as text, and a network failure says the passport is unaffected', async () => {
  const bad = holdHarness(json({ ok: false, code: 'E_BAD_ADDRESS', message: 'That does not look like an email address. Check it and try again.' }));
  await bad.submit('nope');
  assert.equal(allText(bad.errors).trim(), 'That does not look like an email address. Check it and try again.');
  assert.equal(bad.done.hidden, true);

  const down = holdHarness(async () => { throw new TypeError('offline'); });
  await down.submit('owner@example.com');
  assert.ok(/still being held/.test(allText(down.errors)), allText(down.errors));
  assert.equal(down.done.hidden, true);
});

/* ---- share.js --------------------------------------------------------- */

function shareHarness(fetchImpl, { noHeldSection = false } = {}) {
  const cache = new Map();
  const q = s => { if (noHeldSection && s === '#held') return null; if (!cache.has(s)) cache.set(s, node(s)); return cache.get(s); };
  const holdBox = q('[data-holdbox]-inner');
  const held = noHeldSection ? node('unused') : q('#held');
  held.querySelector = s => (s === '[data-holdbox]' ? holdBox : s === '[data-hold-noaddress]' ? noAddress : null);
  const noAddress = node('noaddress'); noAddress.hidden = true;
  const front = q('#front'), published = q('#published'); published.hidden = true; held.hidden = true;
  const attached = [];
  const document = {
    querySelector: q, querySelectorAll: () => [], getElementById: id => q('#' + id),
    createElement: () => node('el'), addEventListener() {}, title: '',
    documentElement: node('html'), body: node('body')
  };
  const window = { PassportHold: { attach: (...a) => attached.push(a) }, scrollTo() {}, addEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }), location: { search: '', hash: '' } };
  const context = { document, window, fetch: fetchImpl, setTimeout, clearTimeout,
    TextEncoder, Blob, URL, JSON, Promise, Date, Math, encodeURIComponent };
  runInNewContext(shareSrc, context);
  const paste = q('#paste'), publish = q('#publish');
  return { q, held, front, published, noAddress, holdBox, attached, document, publish,
    async run() {
      paste.value = 'name: x\n'; paste.fire('input');
      publish.disabled = false;
      publish.fire('click'); await flush();
    } };
}
const HOLD = { ok: false, code: 'E_HELD', status: 'hold', hold_id: 'h1', hold_token: 't1', expires_at: '2026-09-29T00:00:00Z',
  hold_ttl_days: 5,
  message: 'This passport was not published. It has been set aside for a person to look at first, and if that has not happened within 5 days it will be deleted.' };
const respond = (status, j) => async () => ({ status, json: async () => j });

test('share: a hold response draws the held screen, hides the form, and never the refusal footer', async () => {
  const h = shareHarness(respond(202, HOLD));
  await h.run();
  assert.equal(h.held.hidden, false, 'the held screen was not drawn');
  assert.equal(h.front.hidden, true, 'the upload form must go');
  assert.equal(h.published.hidden, true, 'a hold must never draw the Published screen');
  const errors = h.q('#errors');
  assert.ok(!/Nothing was stored/.test(allText(errors)), 'the refusal footer is false for a hold');
  assert.equal(h.attached.length, 1, 'the address box must be attached');
  assert.deepEqual(h.attached[0].slice(1), ['h1', 't1']);
  assert.equal(h.held.focused, true);
});

test('share: the days on the screen are the server number, and a bad number leaves the markup default', async () => {
  const good = shareHarness(respond(202, { ...HOLD, hold_ttl_days: 7 }));
  await good.run();
  assert.equal(good.q('#held-days').textContent, '7');
  for (const bad of [0, -1, 2.5, 'five', null, 400, undefined]) {
    const h = shareHarness(respond(202, { ...HOLD, hold_ttl_days: bad }));
    h.q('#held-days').textContent = '5';
    await h.run();
    assert.equal(h.q('#held-days').textContent, '5', 'hold_ttl_days=' + String(bad) + ' must not be printed');
  }
});

test('share: a hold with no ids still draws the held screen, without the box, and says so', async () => {
  const h = shareHarness(respond(202, { ok: false, code: 'E_HELD', status: 'hold', hold_ttl_days: 5 }));
  await h.run();
  assert.equal(h.held.hidden, false, 'a hold that happened must not be shown as a refusal');
  assert.equal(h.attached.length, 0);
  assert.equal(h.holdBox.hidden, true);
  assert.equal(h.noAddress.hidden, false);
});

test('share: E_HELD without status hold, and the ordinary refusals, still go to the refusal list', async () => {
  const notHold = shareHarness(respond(202, { ...HOLD, status: 'refused' }));
  await notHold.run();
  assert.equal(notHold.held.hidden, true, 'the code alone must not draw the held screen');
  assert.ok(/Nothing was stored/.test(allText(notHold.q('#errors'))));

  const refused = shareHarness(respond(422, { ok: false, code: 'E_SECRET_FOUND', message: 'That looks like a credential.' }));
  await refused.run();
  assert.equal(refused.held.hidden, true);
  assert.ok(/Nothing was stored/.test(allText(refused.q('#errors'))), 'a real refusal keeps its footer');
});

test('share: a real publish still draws the Published screen and not the held one', async () => {
  const h = shareHarness(respond(200, { ok: true, id: 'p1', url: 'https://app.phaeacia.ai/p/p1', delete_token: 'tok' }));
  await h.run();
  assert.equal(h.published.hidden, false);
  assert.equal(h.held.hidden, true);
});

test('share: an old cached upload.html with no held section falls back to the server\'s own true message and keeps the form', async () => {
  const h = shareHarness(respond(202, HOLD), { noHeldSection: true });
  await h.run();
  assert.equal(h.front.hidden, false, 'the form must not be hidden when there is no screen to put in its place');
  assert.ok(allText(h.q('#errors')).includes('This passport was not published. It has been set aside'), 'the server message must be shown');
});

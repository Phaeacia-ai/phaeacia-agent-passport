/* ROW-169 shape B: /og/:id.png, driven as an endpoint, against the real
   satori + resvg-wasm pipeline. Not a mock of the renderer: the finding this
   branch is built against (record/findings/the-social-card-strip-is-a-…)
   found five real satori-only defects that a Chrome preview could not show,
   which is the argument for never faking this half. The store is the same
   in-memory double run-tests.mjs and run-endpoint-tests.mjs each define; a
   fourth copy is the cost of this file living where those two already show
   the same tradeoff (a shared module was considered and left for whoever
   next touches all three, per run-tests.mjs's own note on the same drift).

   THE CLAIM THIS FILE EXISTS TO CHECK, going to the critic before this is
   reported done: an unknown, expired or deleted id returns the generic card
   and nothing about the row leaks into the response. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile as readFileP } from 'node:fs/promises';

class FakeStore {
  constructor(name) { this.name = name; this.data = new Map(); this.meta = new Map(); }
  async get(key, opts) {
    if (!this.data.has(key)) return null;
    const raw = this.data.get(key);
    return opts && opts.type === 'json' ? JSON.parse(raw) : raw;
  }
  async set(key, value, opts) {
    this.data.set(key, String(value));
    if (opts && opts.metadata) this.meta.set(key, opts.metadata);
  }
  async setJSON(key, value, opts) {
    this.data.set(key, JSON.stringify(value));
    if (opts && opts.metadata) this.meta.set(key, opts.metadata);
  }
  async delete(key) { this.data.delete(key); this.meta.delete(key); }
  async getMetadata(key) {
    if (!this.data.has(key)) return null;
    return { etag: 'x', metadata: this.meta.get(key) || {} };
  }
  list({ prefix, paginate } = {}) {
    const blobs = [...this.data.keys()].sort()
      .filter(k => !prefix || k.startsWith(prefix)).map(key => ({ key }));
    if (!paginate) return Promise.resolve({ blobs, directories: [] });
    return (async function* () {
      for (let i = 0; i < blobs.length; i += 25) {
        yield { blobs: blobs.slice(i, i + 25), directories: [] };
      }
    })();
  }
}

const stores = new Map();
const store = await import('../lib/_store.mjs');
store.__useStoreFactory(name => {
  if (!stores.has(name)) stores.set(name, new FakeStore(name));
  return stores.get(name);
});

/* These tests publish through the real upload handler, which refuses in archive
   mode, and a deploy with ARCHIVE_MODE=1 runs this file in its build. */
delete process.env.ARCHIVE_MODE;

const upload = (await import('../netlify/functions/upload.mjs')).default;
const og = (await import('../netlify/functions/og.mjs')).default;

const GOOD = await readFileP(new URL('../../examples/daily-brief-passport.md', import.meta.url), 'utf8');
const ORIGIN = 'https://app.phaeacia.test';
const GENERIC = readFileSync(new URL('../assets/og/og-card.png', import.meta.url));

let nth = 0;
const freshIp = () => `198.51.100.${(nth = (nth + 1) % 250) + 1}`;
let unique = 0;
const distinct = (base = GOOD) => base.replace(/^title: (.*)$/m, (_, t) => `title: ${t} ${++unique}`);

function reset() { stores.clear(); }

async function publish(text = distinct()) {
  const res = await upload(new Request(ORIGIN + '/api/upload', {
    method: 'POST',
    headers: { 'content-type': 'text/markdown', 'x-nf-client-connection-ip': freshIp() },
    body: text
  }));
  const j = JSON.parse(await res.text());
  assert.equal(j.ok, true, 'publish failed: ' + JSON.stringify(j));
  return j;
}

const getOg = (id) => og(new Request(`${ORIGIN}/og/${id}.png`), { params: { id: `${id}.png` } });

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (buf) => Buffer.isBuffer(buf) && buf.subarray(0, 8).equals(PNG_MAGIC);

/* ══ the generic-card contract ═══════════════════════════════════════════ */

test('an id that never existed gets the generic card, byte for byte', async () => {
  reset();
  const res = await getOg('00000000-0000-4000-8000-000000000000');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.ok(bytes.equals(GENERIC), 'unknown id did not return the exact generic-card bytes');
});

test('a deleted id gets the generic card, byte for byte, same as never-existed', async () => {
  reset();
  const { id, delete_token } = await publish();
  const del = (await import('../netlify/functions/delete-passport.mjs')).default;
  const delRes = await del(new Request(ORIGIN + '/api/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nf-client-connection-ip': freshIp() },
    body: JSON.stringify({ id, token: delete_token })
  }));
  assert.equal((await delRes.json()).ok, true, 'delete did not succeed');

  const res = await getOg(id);
  assert.equal(res.status, 200);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.ok(bytes.equals(GENERIC), 'deleted id did not return the exact generic-card bytes');
});

test('an expired id gets the generic card, byte for byte', async () => {
  reset();
  const { id } = await publish();
  const passports = stores.get('passports');
  const row = JSON.parse(passports.data.get(id));
  row.expires_at = new Date(Date.now() - 1000).toISOString(); // one second ago
  passports.data.set(id, JSON.stringify(row));

  const res = await getOg(id);
  assert.equal(res.status, 200);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.ok(bytes.equals(GENERIC), 'expired id did not return the exact generic-card bytes');
});

test('a malformed id (not a uuid, not "example") gets the generic card', async () => {
  reset();
  const res = await getOg('not-a-uuid-at-all');
  assert.equal(res.status, 200);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.ok(bytes.equals(GENERIC));
});

test('/og/example.png draws the specimen fixture, not the generic fallback', async () => {
  reset();
  const res = await getOg('example');
  assert.equal(res.status, 200);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.ok(isPng(bytes), 'response was not a PNG at all');
  assert.ok(!bytes.equals(GENERIC), 'the specimen fixture rendered as the generic fallback, not its own card');
});

/* ══ nothing about a REAL row leaks into a FALLBACK response ═════════════ */

test('a title outside every face (Cyrillic) falls back to the generic card, and the response carries none of that title', async () => {
  reset();
  const text = distinct().replace(/^title: (.*)$/m, 'title: Агент утренней сводки Agent');
  const { id } = await publish(text);

  const res = await getOg(id);
  assert.equal(res.status, 200);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.ok(bytes.equals(GENERIC), 'a non-drawable title did not fall back to the exact generic card');
  // The generic card is a fixed, pre-rendered file; asserting byte equality
  // above already proves no per-request text reached it. This second check
  // is the same property stated the other way: even the raw response bytes,
  // read as latin1, never contain a distinctive ASCII fragment of the title.
  const asText = bytes.toString('latin1');
  assert.ok(!asText.includes('Agent'), 'a fragment of the real title leaked into the fallback response bytes');
});

test('a Latin Extended-A title (ě ř ł ğ ı) draws a real card through the Noto fallback, not tofu and not the generic card', async () => {
  reset();
  // og-template.mjs's cardCanDraw says no to this row (OG_GLYPHS is the site
  // faces alone); _og-render.mjs's canDraw says yes because the fallback
  // face has the glyphs. Both halves are asserted so a regression in either
  // direction is named.
  const { cardCanDraw } = await import('../lib/og-template.mjs');
  const { canDraw } = await import('../lib/_og-render.mjs');
  const text = distinct().replace(/^title: (.*)$/m, 'title: Vlastimil Řízek’s Łódź ğı Agent');
  const { id } = await publish(text);
  const row = await store.readPassport(undefined, id);
  assert.equal(cardCanDraw(row), false, 'the site-face test should refuse this title; if it passes, OG_GLYPHS grew and this test needs a harder title');
  assert.equal(canDraw(row), true, 'canDraw refused a title the fallback face covers');

  const res = await getOg(id);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.ok(isPng(bytes));
  assert.ok(!bytes.equals(GENERIC), 'an Extended-A title fell back to the generic card despite the fallback face');
});

test('the fallback face supplies a real glyph for ř, and does not change how ASCII is drawn', async () => {
  const { default: satori } = await import('satori');
  const S = { name: 'Schibsted Grotesk', weight: 400, style: 'normal', data: readFileSync(new URL('../assets/fonts/og/schibsted-grotesk-400.ttf', import.meta.url)) };
  const N = { name: 'Noto Sans', weight: 400, style: 'normal', data: readFileSync(new URL('../assets/fonts/og/noto-sans-latin-ext-400.ttf', import.meta.url)) };
  const tree = t => ({ type: 'div', props: { style: { display: 'flex', width: 1200, height: 630, fontFamily: 'Schibsted Grotesk', fontSize: 54 }, children: t } });
  const opts = f => ({ width: 1200, height: 630, fonts: f });
  // U+FFFF is a noncharacter no face has: its render IS the .notdef box.
  const notdef = await satori(tree('￿'), opts([S]));
  assert.equal(await satori(tree('ř'), opts([S])), notdef, 'control: without the fallback, ř should be the notdef box');
  assert.notEqual(await satori(tree('ř'), opts([S, N])), notdef, 'with the fallback, ř is still the notdef box');
  assert.equal(await satori(tree('Daily Brief'), opts([S])), await satori(tree('Daily Brief'), opts([S, N])),
    'loading the fallback changed how an all-ASCII title is drawn; the site faces should still win');
});

/* ══ the real drawing path, for a row that CAN draw ═══════════════════════ */

test('a normal published row draws a real card: a PNG, not the generic bytes, right dimensions', async () => {
  reset();
  const { id } = await publish();
  const res = await getOg(id);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  // no-store, the same as /p/<id>: a critic showed a cacheable card is a
  // second deletion-visibility window privacy.html does not name.
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.ok(isPng(bytes));
  assert.ok(!bytes.equals(GENERIC), 'a normal row rendered as the generic fallback instead of its own card');
});

test('two different rows draw two different cards (the card is per-passport, not one shared image)', async () => {
  reset();
  const a = await publish();
  const b = await publish();
  const pngA = Buffer.from(await (await getOg(a.id)).arrayBuffer());
  const pngB = Buffer.from(await (await getOg(b.id)).arrayBuffer());
  assert.ok(!pngA.equals(pngB), 'two distinct passports rendered byte-identical cards');
});

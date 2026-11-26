/* Archive mode's pure half: the flag, the page rewrites, and the build step that applies them to
   dist/. The endpoints are driven in tools/run-endpoint-tests.mjs ("archive mode").
   Run just this file with: node --test tools/archive.test.mjs */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import './_helpers.mjs';
import {
  archiveMode, archivePage, closePage, archivedBody, ARCHIVE_NOTICE, CLOSED_MAIN, ARCHIVE_OFF_VALUES,
  ARCHIVE_REPO, UPLOAD_CLOSED_MESSAGE, WRITE_CLOSED_MESSAGE
} from '../lib/_archive.mjs';
import { archiveDist, CLOSED_PAGES } from './archive-dist.mjs';

const WEB = new URL('../', import.meta.url);
const read = (rel) => readFile(new URL(rel, WEB), 'utf8');

test('archive mode is off unless ARCHIVE_MODE says otherwise, and a typo errs towards on', () => {
  assert.equal(archiveMode({}), false);
  for (const off of ['', '0', 'false', 'FALSE', ' off ', 'no']) {
    assert.equal(archiveMode({ ARCHIVE_MODE: off }), false, JSON.stringify(off));
  }
  for (const on of ['1', 'true', 'yes', 'on', 'archived', 'ture']) {
    assert.equal(archiveMode({ ARCHIVE_MODE: on }), true, JSON.stringify(on));
  }
  assert.equal(process.env.ARCHIVE_MODE, undefined, '_helpers.mjs must take the flag out of the suite');
});

test('the refusal body is the app\'s error shape, and the upload message keeps its two promises', () => {
  assert.deepEqual(Object.keys(archivedBody()).sort(), ['code', 'message', 'ok']);
  assert.equal(archivedBody().code, 'archived');
  assert.equal(archivedBody().ok, false);
  assert.ok(UPLOAD_CLOSED_MESSAGE.includes('https://github.com/Phaeacia-ai/phaeacia-agent-passport'));
  assert.ok(UPLOAD_CLOSED_MESSAGE.includes('unchanged on your machine'));
  assert.ok(WRITE_CLOSED_MESSAGE.includes(ARCHIVE_REPO));
  for (const s of [UPLOAD_CLOSED_MESSAGE, WRITE_CLOSED_MESSAGE, ARCHIVE_NOTICE, CLOSED_MAIN]) {
    assert.equal(/[—]/.test(s), false, 'no em dashes in served copy');
  }
});

test('archivePage puts one notice under the top bar and marks <html>, and is idempotent', async () => {
  const about = await read('about.html');
  const once = archivePage(about);
  assert.match(once, /<html lang="en" data-archived>/);
  assert.equal(once.split('class="archive-notice"').length - 1, 1);
  assert.ok(once.indexOf('class="archive-notice"') > once.indexOf('</header>'), 'the notice must follow the top bar');
  assert.ok(once.indexOf('class="archive-notice"') < once.indexOf('<main'), 'the notice must come before the content');
  assert.equal(archivePage(once), once, 'a second pass must change nothing');

  const bare = archivePage('<!DOCTYPE html><html><body class="x"><p>hi</p></body></html>');
  assert.match(bare, /<body class="x">\n<div class="archive-notice"/);
});

test('closePage replaces the publishing pages\' forms and drops their scripts, keeping site.js', async () => {
  for (const name of CLOSED_PAGES) {
    const shut = closePage(await read(name));
    assert.ok(shut, name + ' has no single <main>');
    assert.ok(shut.includes(CLOSED_MAIN), name);
    for (const gone of ['<form', '<textarea', 'type="file"', 'data-copy', '/assets/share.js', '/assets/send.js', 'path-w-block']) {
      assert.equal(shut.includes(gone), false, `${name} still carries ${gone}`);
    }
    assert.ok(shut.includes('<script src="/assets/site.js"></script>'), name + ' lost site.js');
  }
  assert.equal(closePage('<p>no main</p>'), null);
  assert.equal(closePage('<main>a</main><main>b</main>'), null);
});

test('the build step leaves dist/ alone with the flag off and archives every page with it on', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'archive-dist-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pages = (await readdir(WEB)).filter(f => f.endsWith('.html'));
  for (const p of pages) await copyFile(new URL(p, WEB), path.join(dir, p));
  const snapshot = async () => Promise.all(pages.map(p => readFile(path.join(dir, p), 'utf8')));

  const before = await snapshot();
  assert.deepEqual(await archiveDist(dir, { env: {} }), { archived: false, pages: [], closed: [] });
  assert.deepEqual(await snapshot(), before, 'archive mode off must change nothing');

  const out = await archiveDist(dir, { env: { ARCHIVE_MODE: '1' } });
  assert.deepEqual(out.closed.sort(), [...CLOSED_PAGES].sort());
  for (const p of pages) {
    const html = await readFile(path.join(dir, p), 'utf8');
    assert.equal(html.split('class="archive-notice"').length - 1, 1, p + ' has no single notice');
    assert.match(html, /<html[^>]*\bdata-archived\b/, p);
  }
  /* Withdrawal stays on the pages that do it. */
  const del = await readFile(path.join(dir, 'delete.html'), 'utf8');
  assert.ok(del.includes('id="delete-form"'), 'the delete form must survive archive mode');
  const manage = await readFile(path.join(dir, 'manage.html'), 'utf8');
  assert.ok(manage.includes('id="delete-btn"') && manage.includes('id="unlist-btn"'), 'manage lost delete or unlist');
  for (const id of ['send-step', 'list-form', 'renew-note', 'renew-btn']) {
    assert.match(manage, new RegExp(`id="${id}"[^>]*\\bdata-archive-hide\\b`), `manage.html #${id} is not hidden in archive mode`);
  }
  await archiveDist(dir, { env: { ARCHIVE_MODE: '1' } });
  for (const p of pages) {
    const html = await readFile(path.join(dir, p), 'utf8');
    assert.equal(html.split('class="archive-notice"').length - 1, 1, p + ': a second run added a second notice');
  }
});

test('the build step fails rather than publish a form it could not close', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'archive-dist-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'index.html'), '<html><body><header></header><main>a</main></body></html>');
  await writeFile(path.join(dir, 'create.html'), '<html><body><header></header><main>a</main></body></html>');
  await assert.rejects(archiveDist(dir, { env: { ARCHIVE_MODE: '1' } }), /upload\.html/);
  await writeFile(path.join(dir, 'upload.html'), '<html><body><header></header><div>no main</div></body></html>');
  await assert.rejects(archiveDist(dir, { env: { ARCHIVE_MODE: '1' } }), /exactly one <main>/);
});

test('the edge page counter reads the same off values as lib/_archive.mjs', async () => {
  const edge = await read('netlify/edge-functions/count.ts');
  const m = edge.match(/const ARCHIVE_OFF_VALUES = (\[[^\]]*\]);/);
  assert.ok(m, 'count.ts no longer declares ARCHIVE_OFF_VALUES');
  assert.deepEqual(JSON.parse(m[1].replace(/'/g, '"')), [...ARCHIVE_OFF_VALUES]);
  assert.match(edge, /if \(archived\(\)\) return context\.next\(\);/, 'the counter does not stop in archive mode');
});

test('base.css carries the notice styles and the rule that hides write controls', async () => {
  const css = await read('assets/base.css');
  assert.ok(css.includes('.archive-notice {'));
  assert.ok(css.includes('html[data-archived] [data-archive-hide] { display: none !important; }'));
});

test('netlify.toml runs the archive step between build-dist.py and the strip', async () => {
  const toml = await read('netlify.toml');
  const command = toml.match(/^\s*command = "([^"]*)"/m)[1];
  const at = (s) => command.indexOf(s);
  assert.ok(at('node tools/archive-dist.mjs dist') > at('tools/build-dist.py'), command);
  assert.ok(at('node tools/archive-dist.mjs dist') < at('tools/strip-served-comments.py'), command);
});

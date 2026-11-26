/* The closest thing to a deploy that runs without one: bundle og.mjs with
   Netlify's own bundler (@netlify/zip-it-and-ship-it, the package Netlify's
   build runs), using the included_files list read out of netlify.toml, unzip
   the result somewhere that is not this checkout, and call the bundled
   function from cwd=/ so that process.cwd() is wrong and only what the zip
   carries can satisfy it.

   WHY THIS EXISTS. run-og-tests.mjs passed 10/10 on a function that could
   not render in a deploy: harfbuzzjs's hb.wasm, which satori loads by
   __dirname at runtime, was not in included_files, and the suite runs from
   the checkout where node_modules is whole. A second critic bundled the
   function for real and every request came back as the generic card with
   status 200. That is the failure shape this whole branch is built to avoid,
   a fallback so quiet it looks like success, and no test that imports from
   the source tree can see it.

   WHAT THIS DOES NOT PROVE. That Netlify's build image runs the same zisi
   version, and that the Lambda's cwd or task root is where the bootstrap
   loads the bundle from. One request to /og/example.png on a deploy settles
   both; this settles everything short of that.

   Reads netlify.toml rather than duplicating the list, so the list under
   test is the list that ships. The parse is deliberately narrow: the
   `[functions."og"]` table and its `included_files = [ ... ]` array of
   double-quoted strings, one per line or not; anything else in that table
   is ignored, and an empty parse fails rather than testing nothing. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const WEB = dirname(dirname(fileURLToPath(import.meta.url)));

function includedFilesFromToml() {
  const toml = readFileSync(join(WEB, 'netlify.toml'), 'utf8');
  const at = toml.indexOf('[functions."og"]');
  assert.ok(at >= 0, 'netlify.toml has no [functions."og"] table');
  const rest = toml.slice(at + 1);
  const end = rest.search(/\n\s*\[/);
  const table = end >= 0 ? rest.slice(0, end) : rest;
  const m = table.match(/included_files\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(m, '[functions."og"] declares no included_files');
  const files = [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]);
  assert.ok(files.length > 0, 'included_files parsed to nothing');
  return files;
}

test('the og function, bundled the way Netlify bundles it, draws the specimen card from cwd=/', async () => {
  const { zipFunctions } = await import('@netlify/zip-it-and-ship-it');
  const includedFiles = includedFilesFromToml();
  const out = mkdtempSync(join(tmpdir(), 'og-zisi-'));
  try {
    const res = await zipFunctions(join(WEB, 'netlify/functions'), out, {
      basePath: WEB,
      config: { 'og': { nodeBundler: 'esbuild', includedFiles }, '*': { nodeBundler: 'esbuild' } },
      archiveFormat: 'zip',
    });
    const og = res.find(r => r.name === 'og');
    assert.ok(og, 'zip-it-and-ship-it produced no og function');
    const dir = join(out, 'unzipped');
    execFileSync('unzip', ['-q', og.path, '-d', dir]);

    /* A child process, so the bundled module is loaded from the unzipped
       tree with cwd=/ and nothing from this checkout is importable by
       accident: the probe file lives in the unzipped tree and imports the
       bundle by absolute path. Its stderr is kept, because satori's
       emscripten glue reports a missing wasm there and og.mjs then serves
       the generic card with status 200, which is exactly the silent shape
       this test exists to make loud. */
    const probe = join(dir, '__probe.mjs');
    const src = `
      const og = (await import(${JSON.stringify(join(dir, 'netlify/functions/og.mjs'))})).default;
      const r = await og(new Request('https://x.test/og/example.png'), { params: { id: 'example.png' } });
      const b = Buffer.from(await r.arrayBuffer());
      process.stdout.write(JSON.stringify({ status: r.status, len: b.length, head: b.subarray(0, 8).toString('hex') }));
    `;
    writeFileSync(probe, src);
    const generic = readFileSync(join(WEB, 'assets/og/og-card.png'));
    let stdout, stderr = '';
    try {
      stdout = execFileSync(process.execPath, [probe], { cwd: '/', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      stderr = String(e.stderr || '');
      stdout = String(e.stdout || '');
    }
    assert.ok(stdout, 'the bundled function did not answer at all; stderr:\n' + stderr);
    const got = JSON.parse(stdout);
    assert.equal(got.status, 200);
    assert.equal(got.head, '89504e470d0a1a0a', 'not a PNG');
    assert.notEqual(got.len, generic.length,
      'the bundled function served the GENERIC card for /og/example.png: something the zip needs at runtime is missing from included_files in netlify.toml. Probe stderr:\n' + stderr);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

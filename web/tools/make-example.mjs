/* Builds assets/example.json from the real example passport, so the landing page
   can link to a rendered passport before anyone has uploaded one.

   It runs the real validator and the real derivation. That makes it a smoke test
   as well as a build step: if the endpoint would refuse the repository's own
   example passport, this fails the build rather than shipping a site whose
   demo contradicts its validator. */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web  = resolve(here, '..');
const repo = resolve(web, '..');

const { transport, validate } = await import('../lib/_validate.mjs');
const { derive } = await import('../lib/_derive.mjs');

const src = resolve(repo, 'examples/daily-brief-passport.md');
const buffer = new Uint8Array(await readFile(src));

const t = transport(buffer, 'text/markdown');
if (t.error) {
  console.error('FAIL: the example passport does not pass transport:', t.error.code, t.error.message);
  process.exit(1);
}

const v = validate(t.text);
if (v.errors.length) {
  console.error('FAIL: the example passport does not pass validation.');
  for (const e of v.errors) {
    console.error('  ' + e.code + ': ' + e.message);
    if (e.details) e.details.slice(0, 5).forEach(d => console.error('      ' + d));
  }
  process.exit(1);
}

const d = derive(v.front, v.lines);
if (d.error) {
  console.error('FAIL: the example passport does not derive:', d.error.code, d.error.message);
  process.exit(1);
}

const row = { ...d.record, body: t.text, views: 0, created_at: new Date().toISOString() };

await mkdir(resolve(web, 'assets'), { recursive: true });
await writeFile(resolve(web, 'assets/example.json'), JSON.stringify(row, null, 2));

console.log('example.json written');
console.log('  title   ' + row.title);
console.log('  needs   ' + row.needs.length + ' rows, ' +
            row.needs.filter(n => n.installable).length + ' installable');
console.log('  summary ' + row.summary.length + ' chars');

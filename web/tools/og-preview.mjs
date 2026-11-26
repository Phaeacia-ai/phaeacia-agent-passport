/* Static preview of the per-passport social card template (lib/og-template.mjs)
   for a stored row, rendered in Chrome so it can be looked at before the
   satori/resvg function exists. Output is a PREVIEW: Chrome's text metrics are
   not satori's, and the first real render is the one to judge line breaks by.

     node tools/og-preview.mjs [row.json] [out.png]

   Defaults to assets/example.json and tools/og-preview-out/example.png. The
   output directory is gitignored and under tools/, which netlify.toml answers
   with a 404: the preview .html carries this machine's font paths and a real
   passport's strip, and assets/ is published without a rule. The first draft
   wrote to assets/og/preview/ and a critic caught it before it was committed.

   The strip and the counts are taken from renderPassport's own output for the
   row, not recomputed here, so the card carries exactly the two lines the page
   prints and the check-digit algorithm stays in _render.mjs alone. */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '..');
const { renderPassport } = await import(resolve(web, 'lib/_render.mjs'));
const { ogCard, ogCardHtml, OG_WIDTH, OG_HEIGHT } = await import(resolve(web, 'lib/og-template.mjs'));

const rowPath = resolve(process.argv[2] || resolve(web, 'assets/example.json'));
const out = resolve(process.argv[3] || resolve(web, 'tools/og-preview-out/example.png'));
const row = JSON.parse(await readFile(rowPath, 'utf8'));

/* Read the strip and the counts off the rendered page. The page prints the two
   44-character rows as <span> children of .mrz, and the counts as the same
   numbers the stamps carry; taking them from the page means the card cannot
   disagree with it. */
const page = renderPassport('preview', row);
const mrz = [...page.matchAll(/<div class="mrz">([\s\S]*?)<\/div>/g)][0];
const strip = mrz ? [...mrz[1].matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map(x => x[1].replace(/&lt;/g, '<')) : [];
if (strip.length !== 2 || strip.some(s => s.length !== 44)) {
  console.error('could not read two 44-character strip lines off renderPassport output:', strip);
  process.exit(1);
}
const needs = row.needs || [];
const counts = {
  capabilities: needs.length,
  installable: needs.filter(n => n.installable).length,
  losses: 0,
};

const fontsDir = pathToFileURL(resolve(web, 'assets/fonts')).href;
const fontsCss = `
@font-face{font-family:"Schibsted Grotesk";src:url("${fontsDir}/schibsted-grotesk-latin-wght-normal.woff2") format("woff2-variations");font-weight:400 900;}
@font-face{font-family:"DM Mono";src:url("${fontsDir}/dm-mono-latin-400-normal.woff2") format("woff2");font-weight:400;}
@font-face{font-family:"DM Mono";src:url("${fontsDir}/dm-mono-latin-500-normal.woff2") format("woff2");font-weight:500;}`;

const html = ogCardHtml(ogCard({ row, counts, strip }), fontsCss);
const htmlPath = out.replace(/\.png$/, '.html');
await mkdir(dirname(out), { recursive: true });
await writeFile(htmlPath, html);

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = resolve(tmpdir(), 'og-preview-' + process.pid);
await rm(profile, { recursive: true, force: true });
await rm(out, { force: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  `--window-size=${OG_WIDTH},${OG_HEIGHT}`, '--allow-file-access-from-files',
  '--virtual-time-budget=3000', `--user-data-dir=${profile}`,
  `--screenshot=${out}`, pathToFileURL(htmlPath).href,
], { stdio: 'ignore' });
/* Chrome 152 writes the screenshot and then does not exit on its own in this
   mode (seen 2026-09-06, both here and by hand), so wait for the file rather
   than for the process, and kill it once the file is there. */
const { stat } = await import('node:fs/promises');
const exists = async () => { try { return (await stat(out)).size > 0; } catch { return false; } };
let ok = false;
for (let i = 0; i < 80 && !ok; i++) {
  await new Promise(r => setTimeout(r, 500));
  ok = await exists();
}
if (ok) await new Promise(r => setTimeout(r, 500));
chrome.kill();
await new Promise(r => chrome.on('exit', r));
if (!ok) { console.error('chrome wrote no screenshot in 40s'); process.exit(1); }
await rm(profile, { recursive: true, force: true }).catch(() => {});
console.log('wrote ' + out);
console.log('  strip  ' + strip[0] + ' / ' + strip[1]);
console.log('  counts ' + JSON.stringify(counts));

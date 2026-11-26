#!/usr/bin/env node
/* Rasterise web/assets/favicon/*.png from the committed mark SVGs.
 *
 * This is a near-copy of website/tools/rasterize-mark.mjs. The two repositories
 * ship separate favicon sets and neither can import from the other, so the
 * duplication is deliberate; if you change the rasterising behaviour, change both.
 *
 * WHY THIS EXISTS. `brand-v2 2/build-mark.py` writes SVGs only; its docstring says
 * to "rasterize PNGs from favicon.svg / the mark SVGs at build time (e.g.
 * resvg/rsvg-convert)". No such step existed in this repo, and none of
 * rsvg-convert, resvg, ImageMagick, Inkscape or cairosvg is installed here. So the
 * nine favicon PNGs were rasterised by hand somewhere else and then drifted: when
 * the mark went to v2 the SVGs were updated and the PNGs were not, which is how
 * the four pages carrying the v2 mark inline still served a v1 mark in the tab.
 *
 * The one note we have about that out-of-repo step
 * (`Archive (not to be used anymore)/brand/brand/COPY-MAP.md`) records that it got
 * the typeface wrong at least once. That is the reason to re-render from SVG here
 * rather than copy anybody's PNGs.
 *
 * Chrome is the rasteriser because it is the one renderer guaranteed present, and
 * because it is the engine that renders the same SVG on the site, so the PNG and
 * the inline SVG cannot disagree about geometry.
 *
 *   node tools/rasterize-mark.mjs [--check]
 *
 * --check renders to memory and compares against what is committed, writing
 * nothing. Use it to find out whether the committed PNGs still match the SVGs.
 *
 * ONE CHROME, NOT NINE. The first version of this script spawned Chrome once per
 * target with `--screenshot`. Chrome wrote the PNG and then did not exit, so the
 * run wedged on the second target and left a browser and a 150 MB profile behind.
 * That is the same defect `record/findings/a-tool-that-leaks-a-browser-per-run-
 * reports-nothing.md` describes for shoot.mjs, rediscovered by writing a new tool
 * the way the old one used to work. This version drives one browser over CDP and
 * reaps it on every exit path, including a signal.
 *
 * SIZE NOTE: the v2 padded viewBox is -13.4 -19.3 114.6 124 where v1's was
 * -4.20 -9.00 96.20 103.40, about 19% larger. The mark therefore draws SMALLER
 * inside a fixed square than the file it replaces. That is a property of the new
 * masters, not of this script. Look at the output.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEEP = '#0C3945';

/* EVERY target renders on a transparent page, including the tiles.
 *
 * The tile SVG paints its own opaque rounded rect, so its interior is opaque
 * whatever the page behind it is. What the page ground decides is the four
 * corners OUTSIDE the corner radius. The first version of this script left those
 * on Chrome's default white, and the files it was replacing had them at alpha 0:
 * checked pixel (1,1) of the committed icon-512, icon-192, apple-touch-icon,
 * favicon-48 and favicon-32, all (0,0,0,0), against a white (255,255,255,255) in
 * the regenerated ones. Shipping that would have put a white square fringe around
 * every rounded icon, which shows on any dark tab strip or dark home screen.
 *
 * favicon-16 is the exception that proves it: at 16px the 21.12/96 radius is
 * about 3.5px and pixel (1,1) already falls inside the rect, so it reads as
 * ground colour in both the old file and the new one.
 *
 * out                                <- source svg                      size  colour */
const TARGETS = [
  ['assets/favicon/favicon-16.png',       'assets/favicon/favicon.svg',            16,  null],
  ['assets/favicon/favicon-32.png',       'assets/favicon/favicon.svg',            32,  null],
  ['assets/favicon/favicon-48.png',       'assets/favicon/favicon.svg',            48,  null],
  ['assets/favicon/apple-touch-icon.png', 'assets/favicon/favicon.svg',            180, null],
  ['assets/favicon/icon-192.png',         'assets/favicon/favicon.svg',            192, null],
  ['assets/favicon/icon-512.png',         'assets/favicon/favicon.svg',            512, null],
  ['assets/favicon/mark-512.png',         'assets/mark/phaeacia-mark.svg',         512, null],
  ['assets/favicon/mark-512-mono.png',    'assets/mark/phaeacia-mark-mono.svg',    512, DEEP],
  ['assets/favicon/mark-512-reverse.png', 'assets/mark/phaeacia-mark-reverse.svg', 512, null],
];

const check = process.argv.includes('--check');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Port 0 lets the OS choose and we read back what Chrome actually took, so this
 * run can never attach to a browser it does not own. See the long note in
 * tools/shoot.mjs: a fixed port made that harness screenshot the wrong page and
 * report it as a finding. */
const profile = resolve(`/tmp/ph-raster-${process.pid}`);
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank',
], { stdio: 'ignore' });

/* Cleanup on every path out, not the happy one. finally covers return and throw;
 * these cover the signal a caller sends on timeout. */
const reap = () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
};
process.on('exit', reap);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { reap(); process.exit(130); });
}

async function endpoint() {
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 80; i++) {
    try {
      const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (port) {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        return (await r.json()).webSocketDebuggerUrl;
      }
    } catch { /* not written yet */ }
    await sleep(250);
  }
  throw new Error('Chrome did not report a debug port');
}

function client(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  });
  return (method, params = {}, sessionId) => new Promise((res, rej) => {
    const msg = { id: ++id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    pending.set(msg.id, { res, rej });
    ws.send(JSON.stringify(msg));
  });
}

function pageFor(svgPath, size, colour) {
  let svg = readFileSync(join(ROOT, svgPath), 'utf8').trim();
  /* Force the drawn box square. preserveAspectRatio defaults to xMidYMid meet, so
   * a non-square viewBox letterboxes and centres, which is what the files being
   * replaced did. */
  svg = svg.replace(/<svg /, `<svg width="${size}" height="${size}" `);
  return '<!doctype html><meta charset="utf-8"><style>'
    + `html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent}`
    + (colour ? `svg{color:${colour}}` : '')
    + '</style>' + svg;
}

let changed = 0, same = 0, wrote = 0;
try {
  const ws = new WebSocket(await endpoint());
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const send = client(ws);
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const cmd = (m, p) => send(m, p, sessionId);
  await cmd('Page.enable');

  for (const [out, src, size, colour] of TARGETS) {
    await cmd('Emulation.setDeviceMetricsOverride', {
      width: size, height: size, deviceScaleFactor: 1, mobile: false,
    });
    /* Without this Chrome paints opaque white behind the page, and every mark
     * ships with a white rectangle baked into it. See the note on TARGETS for
     * why the tiles need it too. */
    await cmd('Emulation.setDefaultBackgroundColorOverride',
      { color: { r: 0, g: 0, b: 0, a: 0 } });

    const html = pageFor(src, size, colour);
    await cmd('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) });
    await sleep(220);

    const { data } = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const png = Buffer.from(data, 'base64');

    const dest = join(ROOT, out);
    if (check) {
      const before = existsSync(dest) ? readFileSync(dest) : null;
      const equal = before && before.equals(png);
      equal ? same++ : changed++;
      console.log(`${equal ? 'match  ' : 'DIFFERS'}  ${out}  (${size}px from ${src})`);
    } else {
      writeFileSync(dest, png);
      wrote++;
      console.log(`wrote ${out}  ${size}px  from ${src}`);
    }
  }
} finally {
  reap();
}

if (check) console.log(`\n${same} match, ${changed} differ`);
else console.log(`\n${wrote} written`);

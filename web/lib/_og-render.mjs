/* Rasterises the ROW-169 card tree (web/lib/og-template.mjs) to a PNG, with no
   browser: satori (tree -> SVG, shaping text into real glyph paths with
   harfbuzz+opentype.js) then @resvg/resvg-wasm (SVG -> PNG). Both MPL-2.0,
   named in the memo (record/proposals/row-169-…) and in the finding it
   produced. Nothing here knows about Netlify, a request, or a stored row;
   the caller (netlify/functions/og.mjs) hands it a tree and gets bytes back.

   SATORI ALREADY SHAPES THE TEXT. Its output SVG carries <path> outlines for
   every glyph, not <text> elements naming a font family, because satori does
   its own text layout and shaping against the font buffers it was given.
   Checked on this machine: rendering ogCard's tree and grepping the SVG for
   "<text" finds none. So resvg-wasm needs no font of its own at raster time;
   it is drawing paths, the same as it would for any other vector art. Do not
   add a `font` option to the Resvg call on the theory that it is missing
   something — it would be dead configuration for a shape that never occurs
   here.

   FONTS ARE LOADED ONCE PER PROCESS, not per request. Netlify Functions reuse
   a warm instance across requests, and re-reading four small TTFs and
   re-instantiating the wasm module on every hit is the 48ms-to-start cost the
   memo measured, paid needlessly on every warm call instead of once per cold
   start. The module-level cache below is exactly the same shape _store.mjs
   warns against for a blob store handle (a per-request resource must not be
   cached across the handler boundary), and it is safe here for the opposite
   reason: nothing here reads request-scoped credentials. Every input --- the
   font bytes, the wasm binary --- is a file this repository ships, not
   something Netlify injects into the request's execution context.

   WHERE THE FILES ARE, which no document settles and so is not assumed.
   esbuild inlines this module into the function's single bundle, so at
   runtime import.meta.url names wherever Netlify put THAT file, not web/lib/.
   Netlify's `included_files` docs say the paths are relative to the base
   directory (web/), and community answers say process.cwd() is that
   directory in production, but no Netlify doc sentence ties process.cwd() to
   it for Functions v2 (researched 2026-09-06; NOT ESTABLISHED). What IS
   established, by running @netlify/zip-it-and-ship-it offline on this
   checkout: the function zip keeps the base directory's layout at its root
   (assets/og/og-card.png, assets/fonts/og/*.ttf, node_modules/@resvg/...,
   and the bundle itself at netlify/functions/og.mjs, which the entry point
   loads by that relative path). So assetRoot() below does not pick a
   contract; it tries process.cwd(), then walks up from this module's own
   location, then LAMBDA_TASK_ROOT, and takes the first directory that
   actually contains the generic card. Whichever of the two conventions the
   runtime turns out to honour, the files are found; if neither is, the
   error names every path tried instead of failing on a bare ENOENT.

   satori's own yoga.wasm needs none of this: satori's default
   (non-standalone) build embeds it as a base64 string inside its own JS,
   confirmed in its README ("bundles its underlying WASM dependencies as
   base64-encoded strings"), so esbuild inlines it with the rest of that
   package's code automatically. @resvg/resvg-wasm does not do that -- its
   index_bg.wasm is a separate 2.4 MB file resolved by a runtime path, which
   is exactly the shape `included_files` exists for, declared in netlify.toml
   under [functions."og"]. */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import satori from 'satori';
import { Resvg, initWasm } from '@resvg/resvg-wasm';
import { OG_FONTS, OG_GLYPHS, OG_WIDTH, OG_HEIGHT, cardCanDraw } from './og-template.mjs';
/* Written by tools/build-og-fonts.mjs from the fallback TTF's own cmap. A
   static import, so esbuild inlines it: it is not in included_files and
   does not need to be. */
import GLYPHS from '../assets/fonts/og/glyphs.json' with { type: 'json' };

/* The file every candidate root is tested against. It is also the generic
   card og.mjs serves, so a root that has it has the layout. */
const MARKER = 'assets/og/og-card.png';
let rootCache = null;
export function assetRoot() {
  if (rootCache) return rootCache;
  const tried = [];
  const candidates = [process.cwd()];
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) { candidates.push(dir); const up = dirname(dir); if (up === dir) break; dir = up; }
  if (process.env.LAMBDA_TASK_ROOT) candidates.push(process.env.LAMBDA_TASK_ROOT);
  for (const c of candidates) {
    const r = resolve(c);
    if (tried.includes(r)) continue;
    tried.push(r);
    if (existsSync(join(r, MARKER))) { rootCache = r; return r; }
  }
  throw new Error('_og-render: cannot find ' + MARKER + ' under any of: ' + tried.join(', ') +
    ' (is included_files in netlify.toml intact?)');
}
export const assetPath = rel => join(assetRoot(), rel);

const OG_FONT_DIR = () => assetPath('assets/fonts/og');

/* ── the fallback face ────────────────────────────────────────────────────
   og-template.mjs's cardCanDraw() answers "can the three SITE faces draw
   this row", against OG_GLYPHS, their cmaps' 220-codepoint intersection.
   That is the right question for the template and the wrong one for this
   renderer, which loads a fifth face: Noto Sans Regular subset to the Latin
   ranges the site faces lack (tools/build-og-fonts.mjs, "the fallback
   face"). Satori consults fonts in list order for any glyph the requested
   family cannot supply, so appending it LAST means a title's Schibsted
   letters stay Schibsted and only ě ř ł ğ ı and their kin come from Noto.
   Measured on this machine: a pure-ASCII title renders to the identical SVG
   with and without the fallback loaded, which is the test that the site
   faces still win where they have the glyph.

   canDraw(row) below is what og.mjs asks. It is cardCanDraw OR "every
   character is in OG_GLYPHS or in the fallback's cmap", with the same
   whitespace collapse cardCanDraw applies. og-template.mjs is not edited
   for this: it is frontend's file, its constant is correctly about the
   site faces, and a renderer that adds a face is the one that should know
   it did. What still routes to the generic card: any script outside the
   Latin ranges listed in glyphs.json, Greek, Cyrillic and CJK among them.
   That is the remaining product limitation, narrower than the one the
   finding named. */
const FALLBACK_FILE = GLYPHS.source;
const toRanges = s => s.split(' ').map(r => r.split('-').map(x => parseInt(x, 16))).map(([a, b]) => [a, b ?? a]);
const DRAWABLE = [...toRanges(OG_GLYPHS), ...toRanges(GLYPHS.fallback)];
const hasGlyph = cp => DRAWABLE.some(([a, b]) => cp >= a && cp <= b);

export function canDraw(row) {
  if (cardCanDraw(row)) return true;
  if (!row || typeof row !== 'object') return false;
  for (const s of [row.title, row.summary]) {
    for (const ch of String(s ?? '').replace(/\s+/g, ' ')) if (!hasGlyph(ch.codePointAt(0))) return false;
  }
  return true;
}

/* OG_FONTS names each face by its ORIGINAL woff2 source (og-template.mjs's
   own doc comment), because that is the file the design intent points at.
   This is the one place that maps a named weight to the STATIC TTF
   tools/build-og-fonts.mjs produced for it; the two must agree or a face
   loads as the wrong weight with no error, which is exactly the silent
   satori fallback og-template.mjs's own header warns about. */
const OG_FONT_FILES = Object.freeze({
  'Schibsted Grotesk:400': 'schibsted-grotesk-400.ttf',
  'Schibsted Grotesk:600': 'schibsted-grotesk-600.ttf',
  'DM Mono:400': 'dm-mono-400.ttf',
  'DM Mono:500': 'dm-mono-500.ttf',
});

let wasmReady = null;
let fontsCache = null;

async function ensureWasm() {
  if (!wasmReady) {
    const wasmPath = assetPath('node_modules/@resvg/resvg-wasm/index_bg.wasm');
    wasmReady = initWasm(readFileSync(wasmPath));
  }
  return wasmReady;
}

function loadFonts() {
  if (fontsCache) return fontsCache;
  fontsCache = OG_FONTS.map(f => {
    const key = `${f.name}:${f.weight}`;
    const file = OG_FONT_FILES[key];
    if (!file) {
      throw new Error('_og-render: no static TTF mapped for ' + key +
        '; tools/build-og-fonts.mjs and OG_FONT_FILES must name the same faces as og-template.mjs\'s OG_FONTS');
    }
    return { name: f.name, weight: f.weight, style: f.style, data: readFileSync(join(OG_FONT_DIR(), file)) };
  });
  /* Last, on purpose: see "the fallback face" above. */
  fontsCache.push({ name: 'Noto Sans', weight: 400, style: 'normal', data: readFileSync(join(OG_FONT_DIR(), FALLBACK_FILE)) });
  return fontsCache;
}

/* renderCardPng(tree) -> Buffer. The only export; the caller passes a tree
   from ogCard() and gets PNG bytes. Throws on anything satori or resvg
   refuses (a malformed tree, a font file missing) rather than returning a
   blank image -- og.mjs catches and serves the generic card, the same
   contract ogCard() itself uses for a bad strip. */
export async function renderCardPng(tree) {
  await ensureWasm();
  const fonts = loadFonts();
  const svg = await satori(tree, { width: OG_WIDTH, height: OG_HEIGHT, fonts });
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: OG_WIDTH } });
  const png = resvg.render();
  return Buffer.from(png.asPng());
}

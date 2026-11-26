/* Fails when OG_GLYPHS in lib/og-template.mjs no longer matches the fonts in
   assets/fonts/. cardCanDraw routes a row to the generic card when a title or
   summary needs a glyph the faces lack; a stale list routes wrongly in both
   directions. Needs python3 with fontTools (the same tool that instances the
   variable face for satori).

     node tools/og-fonts-check.mjs        # exit 0: list and files agree */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '..');
const { OG_GLYPHS, OG_FONTS } = await import(resolve(web, 'lib/og-template.mjs'));

const files = [...new Set(OG_FONTS.map(f => f.source))].map(f => resolve(web, 'assets/fonts', f));
const py = `
from fontTools.ttLib import TTFont
import functools, sys
s = [set(TTFont(f).getBestCmap()) for f in sys.argv[1:]]
cps = sorted(functools.reduce(set.__and__, s))
out, start, prev = [], cps[0], cps[0]
for c in cps[1:]:
    if c == prev + 1: prev = c; continue
    out.append((start, prev)); start = prev = c
out.append((start, prev))
print(' '.join(f"{a:04X}" if a == b else f"{a:04X}-{b:04X}" for a, b in out))
`;
const actual = execFileSync('python3', ['-c', py, ...files], { encoding: 'utf8' }).trim();
if (actual !== OG_GLYPHS) {
  console.error('OG_GLYPHS is stale.\n  in file: ' + OG_GLYPHS + '\n  fonts:   ' + actual);
  process.exit(1);
}
console.log('OG_GLYPHS matches the ' + files.length + ' faces: ' + OG_GLYPHS.split(' ').length + ' ranges');

#!/usr/bin/env node
/* Builds the static TTF faces the /og/:id.png function loads into satori.
   ROW-169 shape B (record/proposals/row-169-… and the finding it produced,
   the-social-card-strip-is-a-specimen-now-…). Run by hand, like
   tools/og-card.html's PNG: the output is committed, not regenerated on every
   build, because it changes only when a font file changes.

   Why this exists at all. Satori reads TTF, OTF and WOFF; the repo ships only
   WOFF2 (assets/fonts/*.woff2), so decompression is a hard requirement, not an
   optimisation. Schibsted Grotesk there is additionally a VARIABLE face
   (wght 400-900, confirmed via fontTools: `TTFont(path)['fvar'].axes`), and
   satori has no variable-font support: it throws building a document with one
   loaded and requires a fixed-weight instance per face. OG_FONTS in
   web/lib/og-template.mjs names exactly four (Schibsted 400 and 600, DM Mono
   400 and 500) and this script produces exactly those four files, named to
   match assets/fonts/og/<name>.ttf, so a mismatch between what the template
   asks for and what this produced fails loudly at load time rather than
   falling back silently.

   Python + fontTools rather than a JS toolchain: this is the pipeline the
   critic built and measured in the finding above (fontTools 4.59, brotli
   decompression built in), and duplicating it in JS would be a second
   implementation of the same conversion with no reader benefit. It runs once,
   by hand, and its own output is what ships. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // web/
const SRC = join(ROOT, 'assets/fonts');
const OUT = join(ROOT, 'assets/fonts/og');

/* Deterministic output. fontTools stamps head.modified with "now" on every
   save, so two runs of this script on the same inputs produced two
   byte-different TTFs and a spurious diff on four committed binaries (seen
   2026-09-06, first rebuild). fontTools honours SOURCE_DATE_EPOCH for that
   field; pinned here so a rebuild from unchanged inputs is a no-op in git,
   which is the only way "regenerate and diff" can mean anything. */
process.env.SOURCE_DATE_EPOCH = process.env.SOURCE_DATE_EPOCH || '1757116800'; // 2025-09-06T00:00:00Z

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const PY = `
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

op = sys.argv[1]
src = sys.argv[2]
dst = sys.argv[3]

f = TTFont(src)
f.flavor = None  # woff2 -> sfnt (TTF); satori does not read woff2

if op == 'instance':
    wght = float(sys.argv[4])
    f = instantiateVariableFont(f, {'wght': wght})
    # instancing leaves the family/style names pointing at the variable
    # default; satori keys faces by the name and weight OG_FONTS passes, not
    # by what the font's own name table says, so this is cosmetic rather than
    # load-bearing. Left alone deliberately: renaming risks a fontTools
    # nameID edge case for no functional gain here.

f.save(dst)
print('  wrote', dst)
`;

const JOBS = [
  // [op, source file, output file, extra arg (weight, for 'instance')]
  ['instance', 'schibsted-grotesk-latin-wght-normal.woff2', 'schibsted-grotesk-400.ttf', '400'],
  ['instance', 'schibsted-grotesk-latin-wght-normal.woff2', 'schibsted-grotesk-600.ttf', '600'],
  ['plain', 'dm-mono-latin-400-normal.woff2', 'dm-mono-400.ttf'],
  ['plain', 'dm-mono-latin-500-normal.woff2', 'dm-mono-500.ttf'],
];

for (const [op, src, dst, extra] of JOBS) {
  const args = ['-c', PY, op, join(SRC, src), join(OUT, dst), ...(extra ? [extra] : [])];
  execFileSync('python3', args, { stdio: 'inherit' });
}

/* ── the fallback face ────────────────────────────────────────────────────
   The three site faces are Fontsource "latin" subsets and their cmaps'
   intersection is 220 codepoints (OG_GLYPHS in og-template.mjs). Latin
   Extended-A is almost entirely missing, so a Czech, Polish or Turkish title
   (ě ř ł ğ ı) rendered as tofu under satori and was routed to the generic
   card instead. This is the fallback: Noto Sans Regular, OFL, subset to the
   Latin ranges the site faces lack, appended LAST to satori's font list so
   it is consulted only for a glyph the site faces do not have. One weight,
   because the only two fields that can carry such a character, title and
   summary, are both drawn at 400 (og-template.mjs); the stamps and strip
   are fixed ASCII.

   Source is pinned to one exact gstatic URL (Noto Sans v42, static Regular,
   fetched 2026-09-06) rather than "latest", so a rebuild reproduces the same
   file. Run with --fallback to refetch; without it the committed subset is
   left alone, because a build step that needs the network to produce a
   committed file should only do so when asked.

   glyphs.json is written EVERY run, from the fallback TTF on disk: the
   codepoint ranges lib/_og-render.mjs uses to widen the can-draw test
   beyond OG_GLYPHS. Generated from the file rather than typed, so it cannot
   drift from what the font actually contains unless someone replaces the
   TTF by hand without running this. */
const NOTO_URL = 'https://fonts.gstatic.com/s/notosans/v42/o-0mIpQlx3QUlC5A4PNB6Ryti20_6n1iPHjcz6L1SoM-jCpoiyD9A99d.ttf';
const FALLBACK = 'noto-sans-latin-ext-400.ttf';
const FALLBACK_RANGES = '0020-007E 00A0-00FF 0100-024F 0300-036F 1E00-1EFF 2C60-2C7F A720-A7FF';

const SUBSET_PY = `
import sys, urllib.request, io
from fontTools import subset
from fontTools.ttLib import TTFont
url, dst, ranges = sys.argv[1], sys.argv[2], sys.argv[3]
raw = urllib.request.urlopen(url, timeout=30).read()
f = TTFont(io.BytesIO(raw))
assert 'fvar' not in f, 'expected a static face'
opts = subset.Options()
opts.flavor = None
opts.layout_features = ['kern', 'liga', 'ccmp', 'mark', 'mkmk']
opts.name_IDs = ['*']
opts.notdef_outline = True
opts.hinting = False
cps = []
for r in ranges.split():
    a, b = (int(x, 16) for x in r.split('-'))
    cps.extend(range(a, b + 1))
s = subset.Subsetter(opts)
s.populate(unicodes=cps)
s.subset(f)
f.save(dst)
print('  wrote', dst, 'from', url, '(%d bytes in, %d codepoints out)' % (len(raw), len(f.getBestCmap())))
`;

const GLYPHS_PY = `
import sys, json
from fontTools.ttLib import TTFont
src, dst = sys.argv[1], sys.argv[2]
cps = sorted(TTFont(src).getBestCmap())
ranges, start, prev = [], None, None
for c in cps:
    if start is None: start = prev = c; continue
    if c == prev + 1: prev = c; continue
    ranges.append((start, prev)); start = prev = c
if start is not None: ranges.append((start, prev))
txt = ' '.join('%04X' % a if a == b else '%04X-%04X' % (a, b) for a, b in ranges)
json.dump({'fallback': txt, 'source': src.split('/')[-1], 'codepoints': len(cps)}, open(dst, 'w'), indent=1)
print('  wrote', dst, '(%d codepoints, %d ranges)' % (len(cps), len(ranges)))
`;

if (process.argv.includes('--fallback') || !existsSync(join(OUT, FALLBACK))) {
  execFileSync('python3', ['-c', SUBSET_PY, NOTO_URL, join(OUT, FALLBACK), FALLBACK_RANGES], { stdio: 'inherit' });
} else {
  console.log('  kept', join(OUT, FALLBACK), '(pass --fallback to refetch)');
}
execFileSync('python3', ['-c', GLYPHS_PY, join(OUT, FALLBACK), join(OUT, 'glyphs.json')], { stdio: 'inherit' });

console.log('── og fonts built in', OUT);

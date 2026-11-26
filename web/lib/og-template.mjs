/* The per-passport social card, ROW-169 shape B: drawn at request time from the
   stored row, nothing stored. This file is the TEMPLATE and only the template.
   It returns the element tree a renderer draws; it does not draw, fetch, or
   know what a Netlify function is.

   Why a tree and not HTML. The card has to be rasterised on the publish path,
   where there is no browser (the memo in record/proposals/row-169-… costs one
   at about 50 MB or seconds of cold start). The renderer backend will build
   against is satori, which takes exactly this shape: nested {type, props}
   objects with inline camelCase styles, flex layout only. So the template is
   written to satori's constraints and a Chrome preview is derived FROM it, not
   the other way round:

     - display is flex, block or none. No grid. Every element with more than
       one child says display:'flex' explicitly, because satori throws
       otherwise. The two text leaves that truncate (title, description) are
       display:'block', because satori honours lineClamp only on a block
       container and silently ignores it on a flex one: a critic proved that on
       a minimal three-way render after a draft put the clamp on a flex div and
       the Chrome preview showed it working in the renderer that does not ship.
     - No CSS variables, no classes, no <br>. Line breaks are separate divs.
     - No shorthand that satori does not expand: padding and margin are given
       as four values via the p() and m() helpers rather than trusting the
       shorthand parser.
     - Fonts are named; the renderer must load the faces listed in OG_FONTS
       under exactly these family names and weights, or satori falls back
       silently to whatever it was given first. Satori reads TTF/OTF/WOFF and
       NOT WOFF2, and Schibsted Grotesk here is a variable face, so backend's
       font pipeline is a real piece of work (memo, "The real cost").
     - Text truncation is done here in JavaScript, with clip() from _render.mjs,
       not left to the renderer's ellipsis, so the same characters are cut on
       every renderer and the cut is at a word boundary.

   What the card shows, and why nothing more: the Phaeacia lockup, the envelope
   type, the passport's title, the first line of the owner's description, the
   two stamps carrying the real counts, and the passport's own machine-readable
   strip. Every one of those is already on the public page at /p/<id>; the card
   is a picture of it. It reveals nothing the page does not. It is drawn from the
   stored row, so a deleted or expired id has no row and gets the generic card
   (assets/og/og-card.png), which since ROW-169 carries a specimen strip rather
   than a real one.

   Colours are the v2.5 dark roles, read from web/assets/tokens.css on
   design/v2.5-adoption at 4e02ca5 and the Colour table in
   brand/DESIGN-GUIDE.md. Deep sea for the ground because a card in a feed has
   no theme to follow and the marketing hero is the dark sea. The generic card in
   tools/og-card.html uses the same values; keep them in step or the fallback
   and the per-passport card will look like two products. */

import { clip } from './_render.mjs';

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/* v2.5 dark roles. One place, so a palette change is one edit. */
export const OG_COLOURS = Object.freeze({
  ground:   '#071B23',   /* Ground, dark                          */
  line:     '#4F6E78',   /* Decorative separator, dark            */
  ink:      '#F7F8F5',   /* Primary text, dark                    */
  mute:     '#B8C9CB',   /* Secondary text, dark                  */
  tide:     '#7FC3D0',   /* The mark on dark. The guide's Colour table calls
                            this role Tide; tokens.css names the value
                            --ph-deep / --ph-shoal in its dark block, and its
                            --ph-tide there is the hover value #A2D6DF.     */
  brass:    '#E6BF84',   /* Warning / emphasis, dark              */
  granted:  '#9FD6B2',   /* Success, dark (--pp-granted)          */
  refused:  '#FFB4A8',   /* Error, dark (--pp-refused)            */
});

/* The faces the renderer must load, by the family name and weight the tree
   asks for. Source files are web/assets/fonts/*.woff2 (OFL); satori needs
   them converted, and the variable Schibsted instanced at 400 and 600. */
export const OG_FONTS = Object.freeze([
  { name: 'Schibsted Grotesk', weight: 400, style: 'normal', source: 'schibsted-grotesk-latin-wght-normal.woff2' },
  { name: 'Schibsted Grotesk', weight: 600, style: 'normal', source: 'schibsted-grotesk-latin-wght-normal.woff2' },
  { name: 'DM Mono',           weight: 400, style: 'normal', source: 'dm-mono-latin-400-normal.woff2' },
  { name: 'DM Mono',           weight: 500, style: 'normal', source: 'dm-mono-latin-500-normal.woff2' },
]);

const SANS = 'Schibsted Grotesk';
const MONO = 'DM Mono';

/* Element helpers. h(type, style, ...children) builds one satori node. */
const h = (type, style, ...children) => ({
  type,
  props: { style, children: children.length === 1 ? children[0] : children },
});
const p = (t, r = t, b = t, l = r) => ({ paddingTop: t, paddingRight: r, paddingBottom: b, paddingLeft: l });
const m = (t, r = t, b = t, l = r) => ({ marginTop: t, marginRight: r, marginBottom: b, marginLeft: l });

/* The v2 mark, canonical geometry (the rotate is part of the geometry and is
   used site-wide; DESIGN-GUIDE says do not rotate it AGAIN, which this does
   not). Tide on dark, per the guide. */
function mark(height) {
  const C = OG_COLOURS;
  return {
    type: 'svg',
    props: {
      viewBox: '-0.20 -5.00 88.20 95.40',
      width: Math.round(height * 88.2 / 95.4),
      height,
      style: { display: 'flex' },
      children: {
        type: 'g',
        props: {
          fill: C.tide, transform: 'rotate(138 50 50)',
          children: [
            { type: 'path', props: { d: 'M43.5 32.5A6.5 6.5 0 0 1 56.5 32.5V115.5A6.5 6.5 0 0 1 43.5 115.5Z', fillOpacity: 0.58 } },
            { type: 'path', props: { d: 'M43.5 57C43.5 46 37.5 38 37 26C36.5 12 41 2.5 50 2.5C59 2.5 63.5 12 63 26C62.5 38 56.5 46 56.5 57Z', fillOpacity: 0.58 } },
            { type: 'path', props: { d: 'M43.5 32.5A6.5 6.5 0 0 1 56.5 32.5V57H43.5Z' } },
          ],
        },
      },
    },
  };
}

/* One entry stamp: a face line and a quieter sub-line, centred, tilted. The
   double rule is two real borders with a 3px gap. base.css draws it as a
   border plus an inset box-shadow, which is fine at page size and upright;
   at card size under rotation the shadow rasterises as a wobbling line that
   reads as misregistration (critic, 2026-09-06, on the A′ render). */
function stamp(colour, face, sub, tilt, extraStyle = {}) {
  return h('div', {
    display: 'flex',
    border: `3px solid ${colour}`, borderRadius: 5, ...p(3, 3, 3, 3),
    fontFamily: MONO, textTransform: 'uppercase', color: colour,
    transform: `rotate(${tilt}deg)`,
    ...extraStyle,
  },
    h('div', {
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      border: `1px solid ${colour}`, borderRadius: 2, ...p(10, 20, 9, 20),
    },
      h('div', { display: 'flex', fontSize: 25, fontWeight: 500, letterSpacing: '0.08em', lineHeight: 1 }, face),
      h('div', { display: 'flex', fontSize: 12, letterSpacing: '0.12em', opacity: 0.92, ...m(6, 0, 0, 0) }, sub),
    ),
  );
}

/* Title and description limits. Character counts pick a size and cut the
   string at a word boundary; the RENDERER does the last-line truncation with
   lineClamp, which both satori and the Chrome preview support, so a line that
   would have overflowed ends in an ellipsis instead of being hidden. A first
   draft hid the overflow (maxHeight + overflow:hidden) and a critic showed a
   99-character all-caps summary laying out on three lines under satori with
   the third line drawn and invisible, and a 44-character title with no space
   in it running out of the column with seventeen characters gone and nothing
   to say so. Counts cannot catch either, because both are about where the
   breaks fall, not how many characters there are. wordBreak:'break-word' lets
   an unbreakable run wrap instead of overflow. */
const TITLE_MAX = 44;
const DESC_MAX = 110;

/* Type A is the only class the encoder knows (envClass in _render.mjs); the
   page prints "Type X · <whatever was stored>" for anything else, and so does
   the card, with nothing invented after the dot when nothing was stored. */
const envelopeLabel = e => {
  const s = String(e || '').toLowerCase();
  return s === 'read-notify' ? 'Type A · Read-notify' : s ? 'Type X · ' + s : 'Type X';
};

function firstLine(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const mm = t.match(/^.*?[.!?](?=\s|$)/);
  const one = (mm ? mm[0] : t).trim();
  return one.length > n ? clip(one, n) : one;
}

/* The four faces in OG_FONTS are Fontsource "latin" subsets. Satori has no
   system fallback and does not throw: a glyph it has no face for is drawn as a
   .notdef box, so a Japanese title becomes a row of tofu on a card that gets
   shared, and the Chrome preview can never show it because Chrome falls back.
   Titles and summaries are uploaded text, so this is a live input. The caller
   checks the row with cardCanDraw before rendering and serves the generic card
   when it fails, until a fallback face is in the font pipeline (satori's
   loadAdditionalAsset, or a Noto subset; backend's call).

   OG_GLYPHS is the INTERSECTION of the three faces' cmaps, read off the files
   with fontTools, not a Unicode range. A first draft accepted U+00A0-024F and
   U+2000-206F wholesale, which is what the subset's declared unicode-range
   says; the cmap actually holds 220 codepoints and a critic rendered Czech,
   Polish and Turkish titles through the range test to five tofu boxes each.
   Latin Extended-A is almost entirely absent: ě, ř, ł, ğ, ı-dotless-İ are not
   here, and a title carrying them must take the generic card. Regenerate when
   a font file changes:

     python3 -c "from fontTools.ttLib import TTFont; import functools; \
       s=[set(TTFont('assets/fonts/'+f).getBestCmap()) for f in ( \
       'schibsted-grotesk-latin-wght-normal.woff2', \
       'dm-mono-latin-400-normal.woff2','dm-mono-latin-500-normal.woff2')]; \
       print(sorted(functools.reduce(set.__and__, s)))"

   and re-run tools/og-fonts-check.mjs, which fails when this list and the
   files disagree. */
export const OG_GLYPHS = '000D 0020-007E 00A0-00AC 00AE-00FF 0102 0131 0152-0153 02C6 02DA 02DC 0300-0301 0303-0304 0308 2013-2014 2018-201A 201C-201E 2022 2026 2039-203A 2044 20AC 2122 2212 2215';
const GLYPH_RANGES = OG_GLYPHS.split(' ').map(r => r.split('-').map(x => parseInt(x, 16))).map(([a, b]) => [a, b ?? a]);
const hasGlyph = cp => GLYPH_RANGES.some(([a, b]) => cp >= a && cp <= b);
export function cardCanDraw(row) {
  if (!row || typeof row !== 'object') return false;
  for (const s of [row.title, row.summary]) {
    /* the same whitespace collapse clip() and firstLine() apply, so a tab or a
       newline that never reaches the renderer does not route the row away */
    for (const ch of String(s ?? '').replace(/\s+/g, ' ')) if (!hasGlyph(ch.codePointAt(0))) return false;
  }
  return true;
}

/* Title size. Two sizes, not a fluid one: a browserless renderer cannot
   measure text before laying it out. The pick is on an estimated width, not
   a character count: 26 W's are three lines at 54px where 26 average letters
   are one (critic, satori, 2026-09-06). The widths are coarse fractions of an
   em for Schibsted Grotesk; the lineClamp on the title is the real bound and
   this only decides which size to try first. */
const CHAR_EM = c => c === 'Œ' ? 1.1 : /[MWÆæœ@—™©®½¾%]/.test(c) ? 0.95 : /[mw]/.test(c) ? 0.85
  : /[A-ZÀ-ÖØ-Þ]/.test(c) ? 0.72 : /[ijltf.,:;'!|]/.test(c) ? 0.3 : c === ' ' ? 0.28
  : /[0-9]/.test(c) ? 0.6 : /[oøö]/.test(c) ? 0.62 : 0.56;
const estimateWidth = (s, px) => [...s].reduce((w, c) => w + CHAR_EM(c), 0) * px;

/* ogCard({ row, counts, strip }) → satori element tree.
     row     the stored row: title, summary, envelope, name, at least
     counts  { capabilities, installable } as renderPassport counts them.
             losses is in the strip (L2 39-41) and drawn nowhere else on the
             card, on purpose: the card has two stamps and the page has the
             table, which always renders (product rule 3 is about the page).
     strip   [line1, line2], the two 44-character rows mrz() in _render.mjs
             emits for this row. The template does not compute them, so the
             one check-digit algorithm stays in one file; the caller renders
             the page's own strip and passes it.

   Throws a TypeError on a strip that is not two 44-character lines, rather
   than drawing a blank or letting an 80-character line push the host off the
   card (both seen under a critic). The caller catches and serves the generic
   card; a thrown error reaches a log, a blank strip does not. */
export function ogCard({ row, counts, strip }) {
  const C = OG_COLOURS;
  if (!Array.isArray(strip) || strip.length !== 2 || strip.some(l => typeof l !== 'string' || l.length !== 44)) {
    throw new TypeError('ogCard: strip must be two 44-character lines, got ' + JSON.stringify(strip));
  }
  const [l1, l2] = strip;
  /* Title, then the identifier the strip carries, then nothing the page does
     not say: the page prints no title when there is none and neither does
     the card invent one. */
  const title = clip(String(row.title || row.name || ''), TITLE_MAX);
  const titleSize = estimateWidth(title, 54) <= 640 ? 54 : 44;
  const desc = firstLine(row.summary, DESC_MAX);
  const total = Number(counts?.capabilities) || 0;
  const inst = Number(counts?.installable) || 0;
  const declared = Math.max(0, total - inst);

  return h('div', {
    display: 'flex', flexDirection: 'column',
    width: OG_WIDTH, height: OG_HEIGHT,
    backgroundColor: C.ground, color: C.ink,
    fontFamily: SANS, position: 'relative',
  },
    /* the hairline frame, inset 32 like the generic card */
    h('div', {
      display: 'flex', position: 'absolute',
      top: 32, left: 32, width: OG_WIDTH - 64, height: OG_HEIGHT - 64,
      border: `1px solid ${C.line}`, borderRadius: 8,
    }),

    h('div', {
      display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
      width: OG_WIDTH, height: OG_HEIGHT, ...p(64, 80, 58, 80),
    },
      /* top: lockup with product label, and the envelope type */
      h('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
        h('div', { display: 'flex', alignItems: 'center' },
          mark(52),
          h('div', { display: 'flex', fontSize: 30, fontWeight: 600, letterSpacing: '-0.025em', color: C.ink, ...m(0, 0, 0, 14) }, 'Phaeacia'),
          h('div', {
            display: 'flex', fontFamily: MONO, fontSize: 15, letterSpacing: '0.12em', textTransform: 'uppercase',
            color: C.mute, borderLeft: `1px solid ${C.line}`, ...p(2, 0, 2, 14), ...m(0, 0, 0, 16),
          }, 'Agent Passport'),
        ),
        h('div', { display: 'flex', fontFamily: MONO, fontSize: 16, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.brass },
          envelopeLabel(row.envelope)),
      ),

      /* middle: title and first line on the left, the two stamps on the right */
      h('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
        h('div', { display: 'flex', flexDirection: 'column', width: 640 },
          h('div', {
            display: 'block', fontSize: titleSize, fontWeight: 400, letterSpacing: '-0.034em', lineHeight: 1.08,
            color: C.ink, lineClamp: 2, wordBreak: 'break-word',
          }, title),
          desc ? h('div', {
            display: 'block', fontSize: 23, lineHeight: 1.42, color: C.mute, ...m(18, 0, 0, 0),
            lineClamp: 3, wordBreak: 'break-word',
          }, desc) : h('div', { display: 'flex' }),
        ),
        /* The page draws no stamps for a passport with no capabilities, so
           neither does the card: a red NOT GRANTED over "0 declared only" on
           a passport with nothing to refuse misleads at feed size. */
        total > 0
          ? h('div', { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: 372, ...p(0, 0, 0, 24) },
              stamp(C.granted, 'Granted', `${inst} of ${total} installable in v0.1`, -3),
              stamp(C.refused, 'Not granted', `${declared} declared only`, 2.4, { ...m(26, 0, 0, 64) }),
            )
          : h('div', { display: 'flex', width: 372 }),
      ),

      /* bottom: this passport's own strip, and the host. Unboxed, as on the
         generic card, and the secondary colour at .65, which composites to
         #7A8C90, 5.0:1 on the ground: a check-digit row is there to be read,
         so it is text and gets the text target, and it is the quietest text on
         the card because it is the row a reader is least meant to act on. */
      h('div', { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' },
        h('div', {
          display: 'flex', flexDirection: 'column',
          fontFamily: MONO, fontSize: 18, lineHeight: 1.75, letterSpacing: '0.14em', color: C.mute, opacity: 0.65,
        },
          h('div', { display: 'flex', whiteSpace: 'pre' }, l1),
          h('div', { display: 'flex', whiteSpace: 'pre' }, l2),
        ),
        h('div', { display: 'flex', fontFamily: MONO, fontSize: 16, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.mute, ...p(0, 0, 4, 0) },
          'app.phaeacia.ai'),
      ),
    ),
  );
}

/* ── Chrome preview ─────────────────────────────────────────────────────────
   Serialises the tree to an HTML document so it can be looked at before any
   renderer exists (tools/og-preview.mjs uses it). This is a PREVIEW of the
   template, not the product: Chrome and satori do not share text metrics, and
   a line that fits in one may wrap in the other. The first satori render is the
   check that counts; this exists so the design can be judged before that. */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);
const kebab = k => k.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
const UNITLESS = new Set(['lineHeight', 'opacity', 'fontWeight', 'flex', 'flexGrow', 'flexShrink', 'zIndex', 'fillOpacity', 'lineClamp']);
const cssValue = (k, v) => (typeof v === 'number' && !UNITLESS.has(k)) ? v + 'px' : String(v);
/* lineClamp is satori's own property (a count, ellipsis on the last line).
   Chrome spells it -webkit-line-clamp and needs -webkit-box to honour it, which
   replaces display:flex on that element; the element is a text leaf, so
   nothing is lost. wordBreak:'break-word' maps to overflow-wrap:anywhere. */
const styleAttr = style => {
  const st = { ...(style || {}) };
  const out = [];
  if (st.lineClamp != null) {
    out.push('display:-webkit-box', '-webkit-box-orient:vertical', `-webkit-line-clamp:${st.lineClamp}`, 'overflow:hidden');
    delete st.lineClamp; delete st.display;
  }
  if (st.wordBreak === 'break-word') { out.push('overflow-wrap:anywhere'); delete st.wordBreak; }
  for (const [k, v] of Object.entries(st)) out.push(`${kebab(k)}:${cssValue(k, v)}`);
  return out.join(';');
};

function nodeHtml(node) {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return esc(node);
  if (Array.isArray(node)) return node.map(nodeHtml).join('');
  const { type, props = {} } = node;
  const { style, children, ...attrs } = props;
  const attr = Object.entries(attrs)
    .map(([k, v]) => ` ${k === 'fillOpacity' ? 'fill-opacity' : k === 'viewBox' ? 'viewBox' : kebab(k)}="${esc(v)}"`)
    .join('');
  const st = style ? ` style="${esc(styleAttr(style))}"` : '';
  const inner = nodeHtml(children);
  return `<${type}${attr}${st}>${inner}</${type}>`;
}

/* fontsCss: @font-face rules for the preview, as URLs the preview page can
   reach (the caller decides file:// or http://). */
export function ogCardHtml(tree, fontsCss = '') {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${fontsCss}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${OG_WIDTH}px;height:${OG_HEIGHT}px;overflow:hidden;background:${OG_COLOURS.ground}}
body{-webkit-font-smoothing:antialiased;font-synthesis-weight:none}
</style></head><body>${nodeHtml(tree)}</body></html>`;
}

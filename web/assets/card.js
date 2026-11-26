/* The passport card: the artefact someone gets for publishing a passport.

   Public contract, called by the success state on the upload page:

     window.PassportCard.render(mountEl, data) -> Promise<{ canvas, download(filename) }>

     data = { title, name, created, envelope, capture_path, url, id,
              capabilities: [{ label, granted }], installable, declared_only,
              owner_confirmed }

     The counts are always derived from `capabilities` when it has rows;
     `installable` and `declared_only` are used only when it is empty. There is
     no supplied total on purpose: see resolve().

     Optional and used when present, so the card converges on the passport
     page's own machine-readable zone rather than guessing at it:
     validated_at, passport_version, losses.

   ── what this is, and what it is not ────────────────────────────────────
   It is a miniature of the artefact at /p/:id: page 1's cover on the left,
   page 4's entry stamps and page 3's machine-readable zone on the right. It
   is not a poster for the product. PASSPORT-DIRECTION.md: every playful
   element must be generated from real data, and a stamp not backed by an
   actual permission turns the joke into decoration. So there is one stamp per
   capability the passport actually declares, and none otherwise, and the
   machine-readable strip encodes the values it was given and fills the rest
   with `<` the way an absent optional field is filled in ICAO 9303. Nothing
   on the card is invented.

   The ship motif is deliberately absent. The shared brief puts the ship in the
   app chrome, around the drop box, and keeps it off the artefact. This card is
   the artefact, in miniature, so it gets no ship.

   ── the three decisions worth defending ─────────────────────────────────

   SIZE. 1200 x 630 logical pixels. That is the ratio the repository's own
   social card already uses (assets/og/og-card.png, declared 1200x630 in
   _render.mjs), so a card pasted into a chat sits at the same proportion as
   the link preview of the passport it came from: one object family, not two.
   1.91:1 is also the shape every chat client shows without cropping, and this
   image exists to be pasted into a chat.

   THEME. One fixed treatment, always the light palette. A downloaded PNG
   carries no theme, so a theme-aware card would mean two different images of
   the same passport depending on what the publisher's laptop was set to, and
   the recipient would have no way to know which one they were looking at. The
   colours are not hardcoded: they are read at runtime off the bare `:root`
   rule in tokens.css, which by that file's own theming contract is the
   complete light palette. The deep cover panel gives the card enough weight to
   sit on a dark chat ground without a border doing the work.

   RETINA. The bitmap is drawn at 2x, or 3x on a 3x screen, and scaled down in
   CSS. Never below 2: this is an image whose whole job is to be looked at.

   Everything on the card comes out of a stranger's passport, so every string
   is stripped of control characters, collapsed to one line, hard-capped in
   length before it is measured, and then clipped to the box it is drawn in.
   None of it ever reaches the DOM as markup: the only text nodes this file
   creates are its own, and the passport's own words exist on the card as
   pixels and in one aria-label set with textContent semantics. */
(function () {
  'use strict';

  /* ── geometry ─────────────────────────────────────────────────────────
     One place for every number on the card. Logical pixels; the context is
     scaled once so nothing below has to think about the device ratio. */
  var W = 1200, H = 630;
  var MAT = 20;                       /* the card floats on a paper mat      */
  var R = 14;                         /* --ph-r-lg, the large radius token   */
  var CARD = { x: MAT, y: MAT, w: W - MAT * 2, h: H - MAT * 2 };
  var LEFT_W = 480;                   /* the cover panel                     */
  var PAD_L = 40, PAD_R = 40;

  var L = { x: CARD.x + PAD_L, y: CARD.y + PAD_L,
            r: CARD.x + LEFT_W - PAD_L, b: CARD.y + CARD.h - PAD_L };
  var Rp = { x: CARD.x + LEFT_W + PAD_R, y: CARD.y + PAD_R,
             r: CARD.x + CARD.w - PAD_R, b: CARD.y + CARD.h - PAD_R };
  L.w = L.r - L.x;
  Rp.w = Rp.r - Rp.x;

  /* Two to four degrees, per PASSPORT-DIRECTION. Taken from the row's
     position, not from Math.random, so the same passport always produces the
     same card. */
  var TILTS = [-3.1, 2.4, -1.9, 3.4, -2.6, 1.8];

  var MAX_ROWS = 6;                   /* six stamps is the page's own stagger cap */
  /* Declared once in site.js, which every page loading this also loads. */
  var CANONICAL = window.PHAEACIA_CANONICAL;

  /* ── the mark ─────────────────────────────────────────────────────────
     Duotone, the primary rendering: both shapes at 42% and the join at full
     strength, exactly as the cover on /p/:id draws it. These path strings and
     this viewBox are the ones in assets/mark/ and in _render.mjs. Do not
     retype them; DESIGN-GUIDE section 2 says so and means it. */
  /* The tight viewBox, as NUMBERS rather than as the string every other file
     spells it with: "-0.20 -5.00 88.20 95.40". That difference is a trap. The
     brand migration script substitutes the viewBox as a literal string, so it
     rewrote the two path constants below and could not see this line, which
     left the new blade drawn inside the old box. If the mark changes again,
     this is the line nothing automatic will catch. Keep the numbers and the
     string in step by hand, and check them against assets/mark/. */
  var MARK_VB = { x: -0.20, y: -5.00, w: 88.20, h: 95.40 };
  var MARK_D = {
    shaft: 'M43.5 32.5A6.5 6.5 0 0 1 56.5 32.5V115.5A6.5 6.5 0 0 1 43.5 115.5Z',
    blade: 'M43.5 57C43.5 46 37.5 38 37 26C36.5 12 41 2.5 50 2.5C59 2.5 63.5 12 63 26C62.5 38 56.5 46 56.5 57Z',
    join:  'M43.5 32.5A6.5 6.5 0 0 1 56.5 32.5V57H43.5Z'
  };
  var markPaths = null;
  function marks() {
    if (markPaths === null && typeof Path2D === 'function') {
      markPaths = {
        shaft: new Path2D(MARK_D.shaft),
        blade: new Path2D(MARK_D.blade),
        join:  new Path2D(MARK_D.join)
      };
    }
    return markPaths;
  }

  /* ── palette ──────────────────────────────────────────────────────────
     Read off tokens.css rather than copied into this file. The contract at
     the top of tokens.css is that the complete LIGHT palette is declared once
     on bare `:root`, and that the dark blocks only redefine values, so a bare
     `:root` rule in a same-origin stylesheet is by definition the light value
     of every token. Media-query and [data-theme] rules are skipped for free:
     the first is a CSSMediaRule at the top level and is never descended into,
     the second has a different selector.

     The fallback below is the same light palette, and it is a mirror of
     tokens.css, not a second opinion. It exists because a page could in
     principle load this script without tokens.css, and a card that renders in
     the wrong colours is better than a card that does not render. If the two
     ever disagree, tokens.css is right and this is a bug. */
  /* Updated 2026-08-14 with the cooled light palette. The five ground and line
     values below moved when the app took the marketing site's blue-and-green
     ground; ink, mute, deep, tide, brass and the two pp- values did not move and
     are unchanged. If you are diffing this against tokens.css, they should be
     identical, and tokens.css wins. */
  var FALLBACK = {
    '--ph-paper': '#F2F6F6', '--ph-paper-deep': '#E1EBEA', '--ph-card': '#FAFCFC',
    '--ph-line': '#D2DEDD', '--ph-line-soft': '#E2ECEA',
    '--ph-ink': '#10171A', '--ph-mute': '#5B6669',
    '--ph-deep': '#0C3945', '--ph-tide': '#175567',
    '--ph-brass': '#A8763A',
    '--pp-granted': '#2F6B52', '--pp-refused': '#97402C'
  };
  var paletteCache = null;
  function palette() {
    if (paletteCache) return paletteCache;
    var out = {}, k;
    for (k in FALLBACK) if (Object.prototype.hasOwnProperty.call(FALLBACK, k)) out[k] = FALLBACK[k];
    var sheets = document.styleSheets || [];
    for (var i = 0; i < sheets.length; i++) {
      var rules;
      try { rules = sheets[i].cssRules; } catch (e) { continue; }   /* cross-origin, cannot happen here */
      if (!rules) continue;
      for (var j = 0; j < rules.length; j++) {
        var rule = rules[j];
        if (!rule || rule.type !== 1 || !rule.selectorText) continue;
        if (rule.selectorText.replace(/\s+/g, '') !== ':root') continue;
        for (k in FALLBACK) {
          if (!Object.prototype.hasOwnProperty.call(FALLBACK, k)) continue;
          var v = rule.style.getPropertyValue(k).trim();
          /* Only literal colours. base.css also declares a bare :root, and its
             product tokens are `var(--ph-…)` references that mean nothing to a
             canvas. */
          if (/^(#|rgb|hsl)/i.test(v)) out[k] = v;
        }
      }
    }
    paletteCache = out;
    return out;
  }

  /* ── fonts ────────────────────────────────────────────────────────────
     A canvas that draws before the face has loaded silently renders the
     fallback and looks fine until someone who knows the brand sees it. So the
     faces are loaded and CHECKED before anything is drawn, the fallback
     stack is declared in every font string anyway, and the whole thing is
     tried again from a FontFace built off this script's own URL if the host
     page never linked fonts.css.

     The check is the part that is easy to get wrong, and the first version of
     this file got it wrong. `document.fonts.check('400 16px "DM Mono"')` does
     not answer "is that face here". It answers "can this text be rendered
     with this font specification", and a specification whose family does not
     exist is still renderable by falling back, so Chrome answers yes for a
     family the document has never heard of. Blocking the font directory made
     every probe pass, the card drew in Menlo, and it reported that the
     document faces had loaded. So the test below looks for the FACES: it walks
     the faces the document actually holds and requires a loaded, upright one
     covering each family and weight the card draws with. Where a set cannot be
     walked, it measures a probe string against two different generic fallbacks
     instead, which only agree when the family itself resolved.

     Same-origin only. No request leaves this domain, which the privacy page
     promises in those words. */
  var SANS_FB = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  var MONO_FB = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
  var SANS_FAMILY = 'Schibsted Grotesk';
  var MONO_FAMILY = 'DM Mono';
  function sans(size, weight) { return (weight || 400) + ' ' + size + 'px "' + SANS_FAMILY + '", ' + SANS_FB; }
  function mono(size, weight) { return (weight || 400) + ' ' + size + 'px "' + MONO_FAMILY + '", ' + MONO_FB; }

  /* Every family and weight anything on the card is set in. The sans is one
     variable file covering 400 to 900, so 400 and 600 are two demands on one
     face; the mono ships as two static files, so 400 and 500 are two faces. */
  var NEEDED = [[SANS_FAMILY, 400], [SANS_FAMILY, 600], [MONO_FAMILY, 400], [MONO_FAMILY, 500]];
  var PROBES = (function () {
    var out = [];
    for (var i = 0; i < NEEDED.length; i++) out.push(NEEDED[i][1] + ' 16px "' + NEEDED[i][0] + '"');
    return out;
  })();

  /* This script's own directory, so the font URLs do not assume a site root. */
  var BASE = (function () {
    var s = document.currentScript;
    var src = s && s.src ? s.src : '';
    return src ? src.replace(/[^/]*$/, '') : '/assets/';
  })();

  function sameFamily(desc, family) {
    return String(desc == null ? '' : desc).replace(/["']/g, '').replace(/\s+/g, ' ').trim().toLowerCase() ===
      family.toLowerCase();
  }
  /* Does a face's weight descriptor cover the weight the card asks for? Either
     a single value, a variable range written as two numbers, or a keyword. */
  function weightCovers(desc, want) {
    var s = String(desc == null ? '' : desc).trim().toLowerCase();
    if (s === '' || s === 'normal') s = '400';
    else if (s === 'bold') s = '700';
    var parts = s.split(/\s+/);
    var lo = parseFloat(parts[0]);
    var hi = parts.length > 1 ? parseFloat(parts[1]) : lo;
    if (!isFinite(lo) || !isFinite(hi)) return false;
    return want >= Math.min(lo, hi) && want <= Math.max(lo, hi);
  }

  /* true, false, or null for "this engine will not let me look". */
  function facesHeld() {
    var fonts = document.fonts;
    if (!fonts || typeof fonts.forEach !== 'function') return null;
    var found = [], i;
    for (i = 0; i < NEEDED.length; i++) found.push(false);
    try {
      fonts.forEach(function (face) {
        if (!face || face.status !== 'loaded') return;
        var style = String(face.style == null ? 'normal' : face.style).trim().toLowerCase();
        if (style !== 'normal') return;              /* the card never sets italic */
        for (var k = 0; k < NEEDED.length; k++) {
          if (sameFamily(face.family, NEEDED[k][0]) && weightCovers(face.weight, NEEDED[k][1])) found[k] = true;
        }
      });
    } catch (e) { return null; }
    for (i = 0; i < found.length; i++) if (!found[i]) return false;
    return true;
  }

  /* The measurement route, for an engine whose font set cannot be walked. Set
     the same string in the family over `serif` and again over `sans-serif`: if
     the family resolved, the fallback is never reached and the two widths are
     identical, and if it did not, the two widths are the widths of two very
     different faces. Inconclusive, and so null, if the two generics measure
     the same, because then the test cannot distinguish anything. */
  var PROBE_TEXT = 'Hamburgefonstiv 0123456789 <<PHA<<';
  function familiesResolve() {
    var ctx;
    try { ctx = document.createElement('canvas').getContext('2d'); } catch (e) { return null; }
    if (!ctx || !ctx.measureText) return null;
    for (var i = 0; i < NEEDED.length; i++) {
      var head = NEEDED[i][1] + ' 64px ';
      var fam = '"' + NEEDED[i][0] + '", ';
      ctx.font = head + 'serif';
      var s = ctx.measureText(PROBE_TEXT).width;
      ctx.font = head + 'sans-serif';
      var ss = ctx.measureText(PROBE_TEXT).width;
      if (!(s > 0) || !(ss > 0) || Math.abs(s - ss) < 0.5) return null;
      ctx.font = head + fam + 'serif';
      var a = ctx.measureText(PROBE_TEXT).width;
      ctx.font = head + fam + 'sans-serif';
      var b = ctx.measureText(PROBE_TEXT).width;
      if (Math.abs(a - b) >= 0.5) return false;
    }
    return true;
  }

  var fontsPromise = null;
  function allLoaded() {
    var held = facesHeld();
    if (held !== null) return held;
    return familiesResolve() === true;
  }
  function loadProbes() {
    var jobs = [];
    for (var i = 0; i < PROBES.length; i++) {
      jobs.push(document.fonts.load(PROBES[i])['catch'](function () {}));
    }
    return Promise.all(jobs);
  }
  function ensureFonts() {
    if (fontsPromise) return fontsPromise;
    if (!document.fonts || !document.fonts.load) {
      fontsPromise = Promise.resolve(false);
      return fontsPromise;
    }
    fontsPromise = loadProbes()
      .then(function () { return document.fonts.ready; })
      .then(function () {
        if (allLoaded() || typeof FontFace !== 'function') return null;
        /* The host page never linked fonts.css. Declare the same two faces
           from the same two files and try once more. */
        var defs = [
          ['Schibsted Grotesk', 'schibsted-grotesk-latin-wght-normal.woff2',
            { weight: '400 900', style: 'normal', display: 'swap' }, 'woff2-variations'],
          ['DM Mono', 'dm-mono-latin-400-normal.woff2', { weight: '400', style: 'normal', display: 'swap' }, 'woff2'],
          ['DM Mono', 'dm-mono-latin-500-normal.woff2', { weight: '500', style: 'normal', display: 'swap' }, 'woff2']
        ];
        var adds = [];
        for (var i = 0; i < defs.length; i++) {
          try {
            var d = defs[i];
            var face = new FontFace(d[0], 'url(' + BASE + 'fonts/' + d[1] + ') format("' + d[3] + '")', d[2]);
            document.fonts.add(face);
            adds.push(face.load()['catch'](function () {}));
          } catch (e) { /* nothing to do, the fallback stack carries it */ }
        }
        return Promise.all(adds).then(loadProbes);
      })
      .then(function () { return allLoaded(); })
      ['catch'](function () { return false; });
    return fontsPromise;
  }

  /* ── hostile text ─────────────────────────────────────────────────────
     Everything below runs on a stranger's passport. */
  var HARD_CAP = 400;   /* characters, before anything is measured */
  /* C0 and C1 controls, the bidi and zero-width run, the two line separators
     and the byte-order mark. A right-to-left override inside a capability
     label would otherwise reverse the rest of the row. */
  var NASTY = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u2028\u2029\uFEFF]/g;
  function clean(s) {
    var t = String(s == null ? '' : s)
      .slice(0, HARD_CAP * 4)
      .replace(NASTY, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return whole(t.slice(0, HARD_CAP)).trim();
  }
  function upper(s) { return clean(s).toUpperCase(); }

  function widthOf(ctx, s) { return ctx.measureText(s).width; }

  /* Never end a string on the high half of a surrogate pair. Slicing by
     character index is the only way to fit text to a box, and an emoji in a
     title sits across two indices: cutting between them renders a tofu box
     and puts a broken glyph on the artefact. */
  function whole(s) {
    var last = s.charCodeAt(s.length - 1);
    return (last >= 0xD800 && last <= 0xDBFF) ? s.slice(0, -1) : s;
  }

  /* Binary search rather than a character walk: a 400-character title against
     a 400px box is ~9 measurements instead of ~390. */
  function ellipsize(ctx, text, maxW) {
    if (!text) return '';
    if (widthOf(ctx, text) <= maxW) return text;
    var lo = 0, hi = text.length, best = '';
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var candidate = whole(text.slice(0, mid)).replace(/[\s,;:.\-]+$/, '') + '…';
      if (widthOf(ctx, candidate) <= maxW) { best = candidate; lo = mid + 1; } else { hi = mid - 1; }
    }
    return best || '…';
  }

  /* How many leading characters of s fit in maxW. */
  function fitPrefix(ctx, s, maxW) {
    if (widthOf(ctx, s) <= maxW) return s.length;
    var lo = 0, hi = s.length, best = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (widthOf(ctx, s.slice(0, mid)) <= maxW) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return best;
  }

  /* Word wrap to at most maxLines. Whatever does not fit is signalled on the
     last line with an ellipsis, and that decision is made from what is LEFT to
     set rather than from comparing lengths afterwards. The first version of
     this compared the joined lines against the source and got it wrong by a
     word, so a title that overran by one word came out silently truncated,
     which is the worst of the three possible outcomes: the reader cannot tell
     that anything is missing.

     A single word wider than the box is broken mid-word. A passport identifier
     can be one unbroken run of eighty characters, and an overflowing box is
     worse than a hard break. */
  function wrap(ctx, text, maxW, maxLines) {
    var rest = text, lines = [];
    while (rest.length && lines.length < maxLines) {
      var take = fitPrefix(ctx, rest, maxW);
      if (take >= rest.length) { lines.push(rest); rest = ''; break; }
      if (lines.length === maxLines - 1) { lines.push(ellipsize(ctx, rest, maxW)); rest = ''; break; }
      var sp = rest.lastIndexOf(' ', take);
      var cut = sp > 0 ? sp : Math.max(1, take);
      /* Move the break, do not just trim the line: trimming would leave the
         low half of the pair to start the next line instead. */
      if (cut > 1 && whole(rest.slice(0, cut)).length !== cut) cut--;
      lines.push(rest.slice(0, cut).replace(/\s+$/, ''));
      rest = rest.slice(cut).replace(/^\s+/, '');
    }
    return lines;
  }

  /* Largest size in [min,max] at which the string fits the box, measured with
     the tracking actually applied. Written this way because ctx.letterSpacing
     is ignored by older engines: measuring instead of computing means the
     strip fits either way rather than fitting only where the property works. */
  function fitSize(ctx, text, maxW, fontFn, min, max, tracking) {
    var lo = min, hi = max, best = min;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      ctx.font = fontFn(mid);
      if (tracking) setTracking(ctx, mid * tracking);
      if (widthOf(ctx, text) <= maxW) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    ctx.font = fontFn(best);
    if (tracking) setTracking(ctx, best * tracking);
    return best;
  }

  function setTracking(ctx, px) {
    try { ctx.letterSpacing = px ? px + 'px' : '0px'; } catch (e) { /* unsupported, harmless */ }
  }

  /* ── the machine-readable zone ────────────────────────────────────────
     Same construction as page 3 of the passport: ICAO 9303 TD3 field
     positions, the repeating 7-3-1 weighting over A=10..Z=35 with `<` as
     zero, check digit the sum modulo ten. Copied deliberately rather than
     shared, because _render.mjs is server ESM and nothing here may add a
     build step.

     Where the card was not given a value, the field is filled with `<` and
     its check digit computed over the filler, which is what an absent
     optional field looks like in a real document. It is not filled with
     zeroes: "00 losses declared" is a claim, and `<<` is an admission. */
  function mrzVal(c) { return c === '<' ? 0 : /[0-9]/.test(c) ? Number(c) : c.charCodeAt(0) - 55; }
  function checkDigit(s) {
    var w = [7, 3, 1], sum = 0;
    for (var i = 0; i < s.length; i++) sum += mrzVal(s[i]) * w[i % 3];
    return String(sum % 10);
  }
  function mrzPad(s, n) {
    var out = s;
    while (out.length < n) out += '<';
    return out.slice(0, n);
  }
  function mrzClean(s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function mrzWords(s) {
    return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]+/g, '<').replace(/^<|<$/g, '');
  }
  /* Two digits, or filler. A count of one hundred and fifty does not fit a
     two-digit field, and clamping it to 99 would put a number on the strip
     that is not the number: filler is the honest output for a value the field
     cannot hold, the same as for a value that was never given. */
  function pad2(n) {
    var v = Number(n);
    if (!isFinite(v)) return '<<';
    v = Math.round(v);
    if (v < 0 || v > 99) return '<<';
    return (v < 10 ? '0' : '') + v;
  }
  function envClass(e) { return String(e == null ? '' : e).toLowerCase() === 'read-notify' ? 'A' : 'X'; }
  function pathCode(p) {
    var v = String(p == null ? '' : p).toLowerCase();
    return v === 'file' ? 'F' : v === 'browser' ? 'W' : 'X';
  }
  /* Eight digits after cleaning, or nothing. The looser version took the
     first ten characters of anything at all, so a `created` field reading
     "not a date at all" produced TADATE and sat in the issued field looking
     exactly like a date somebody had encoded. Filler is the honest output for
     a value that is not a date. */
  function yymmdd(v) {
    var s = mrzClean(String(v == null ? '' : v).slice(0, 10));
    return /^[0-9]{8}$/.test(s) ? s.slice(2, 8) : '';
  }

  function buildMrz(d, counts) {
    var l1 = 'P' + envClass(d.envelope) + 'PHA' +
             mrzPad(mrzWords(clean(d.name)) + '<<' + mrzWords(clean(d.title)), 39);

    var docNum = mrzPad(mrzClean(clean(d.name)), 9);
    var issued = mrzPad(yymmdd(d.created), 6);
    var checked = mrzPad(yymmdd(d.validated_at), 6);
    var optional = mrzPad(
      'V' + mrzPad(mrzClean(d.passport_version), 2) +
      'C' + pad2(counts.declared) +
      'I' + pad2(counts.installable) +
      'L' + pad2(d.losses) +
      (d.owner_confirmed === true ? 'Y' : d.owner_confirmed === false ? 'N' : '<'), 14);

    var stem = docNum + checkDigit(docNum) + 'PHA' +
               issued + checkDigit(issued) +
               pathCode(d.capture_path) +
               checked + checkDigit(checked) +
               optional + checkDigit(optional);
    var composite = checkDigit(stem.slice(0, 10) + stem.slice(13, 20) + stem.slice(21, 43));
    return [l1, stem + composite];
  }

  /* ── primitives ───────────────────────────────────────────────────────── */
  function roundRect(ctx, x, y, w, h, r) {
    var rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.lineTo(x + rr, y + h);
    ctx.arcTo(x, y + h, x, y + h - rr, rr);
    ctx.lineTo(x, y + rr);
    ctx.arcTo(x, y, x + rr, y, rr);
    ctx.closePath();
  }

  /* A token colour at partial alpha, for the one place a canvas needs one: the
     shadow under the document. tokens.css builds --ph-shadow out of
     `rgb(16 23 26 / …)`, which IS --ph-ink's light value, so this derives the
     shadow from the ink rather than restating a colour. Returns null if the
     token is not a plain hex, and the caller then draws no shadow, because a
     missing shadow is nothing and a guessed colour is a second palette. */
  function inkAlpha(hex, alpha) {
    var m = /^#([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  function hairline(ctx, x1, y, x2, colour) {
    ctx.save();
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x1, Math.round(y) + 0.5);
    ctx.lineTo(x2, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  /* The mark, duotone. 58% for both shapes and full strength for the join, in
     that order, which reproduces the SVG exactly: the join is the overlap, so
     drawing it last at full opacity leaves the compositing identical. */
  function drawMark(ctx, x, y, h, colour) {
    var p = marks();
    if (!p) return 0;
    var s = h / MARK_VB.h;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.translate(-MARK_VB.x, -MARK_VB.y);
    ctx.translate(50, 50);
    ctx.rotate(138 * Math.PI / 180);
    ctx.translate(-50, -50);
    ctx.fillStyle = colour;
    ctx.globalAlpha = 0.58;
    ctx.fill(p.shaft);
    ctx.fill(p.blade);
    ctx.globalAlpha = 1;
    ctx.fill(p.join);
    ctx.restore();
    return MARK_VB.w * s;
  }

  /* One entry stamp. Mono caps in a double-ruled box, landed two to four
     degrees off square, multiplying into the paper the way --pp-blend does on
     the page. Anchored by its RIGHT edge, the way .stamp is justify-self:end
     on the passport's own page 4: centring a variable-width box in a fixed
     column left the right edges ragged down the card, which reads as an
     accident rather than as a crooked stamp. */
  function drawStamp(ctx, rightX, cy, text, colour, tilt) {
    var size = 11.5, padX = 11, padY = 7;
    ctx.save();
    ctx.font = mono(size, 500);
    setTracking(ctx, size * 0.08);
    var tw = widthOf(ctx, text);
    var bw = tw + padX * 2, bh = size + padY * 2 + 2;
    /* The tilt swings the corners out; back off by half the extra width so a
       stamp near the edge stays inside the page. */
    var rad = Math.abs(tilt) * Math.PI / 180;
    var swing = (bw * Math.cos(rad) + bh * Math.sin(rad) - bw) / 2;
    ctx.translate(rightX - bw / 2 - swing, cy);
    ctx.rotate(tilt * Math.PI / 180);
    ctx.globalCompositeOperation = 'multiply';   /* --pp-blend, light value */
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineWidth = 2;
    roundRect(ctx, -bw / 2, -bh / 2, bw, bh, 4);
    ctx.stroke();
    ctx.lineWidth = 1;
    roundRect(ctx, -bw / 2 + 3, -bh / 2 + 3, bw - 6, bh - 6, 2);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    /* Tracking pushes the last glyph's space to the right of the run, so a
       centred tracked string reads half a step left of centre without this. */
    ctx.fillText(text, size * 0.04, 1);
    ctx.restore();
    return bw;
  }

  /* ── the card ─────────────────────────────────────────────────────────── */
  /* Which capabilities get a stamp and how many are left over. One function,
     because the picture and its alt text have to agree about it: the split used
     to be computed inside draw() and approximated again in altText(), and two
     descriptions of one image is one description too many. */
  function stampSplit(v) {
    var shown = v.caps.slice(0, v.declared > MAX_ROWS ? MAX_ROWS - 1 : MAX_ROWS);
    return { shown: shown, overflow: v.declared - shown.length };
  }

  function resolve(data) {
    var d = data && typeof data === 'object' ? data : {};
    /* Counted over the WHOLE array, kept only up to what gets drawn. The first
       version of this stopped reading at sixty-four rows and then took the
       header count off the rows it had kept, so a seventy-capability passport
       printed "64 DECLARED" and said fifty-nine were missing when sixty-five
       were. A card whose one claim is that it is exact may not do that. The
       count is over every valid row; the cap is on the stamps, and the
       overflow line below is the difference. */
    var caps = [];
    var raw = Object.prototype.toString.call(d.capabilities) === '[object Array]' ? d.capabilities : [];
    var declared = 0, installable = 0;
    for (var i = 0; i < raw.length; i++) {
      var c = raw[i] && typeof raw[i] === 'object' ? raw[i] : {};
      var label = clean(c.label);
      if (!label) continue;                       /* a row with no name is not a declaration */
      var granted = c.granted === true;
      declared++;
      if (granted) installable++;
      if (caps.length < MAX_ROWS) caps.push({ label: label, granted: granted });
    }
    /* The counts are derived from the rows the passport actually holds, not
       from the numbers alongside them. A header that says four installable
       above three green stamps is the exact failure PASSPORT-DIRECTION names.
       The supplied numbers are used only when there is no capability array to
       count, which is the one case where they carry information it does not. */
    /* The supplied numbers are `installable` and `declared_only`, and the total
       is their sum. There is deliberately no supplied total: a field called
       `declared` would mean the total here and the not-installable bucket in
       the passport page's own phrase "declared only" one line away, so it was
       renamed at the endpoint rather than defended with a comment. */
    if (!declared) {
      var ins = isFinite(Number(d.installable)) ? Math.max(0, Math.round(Number(d.installable))) : 0;
      var only = isFinite(Number(d.declared_only)) ? Math.max(0, Math.round(Number(d.declared_only))) : 0;
      installable = ins;
      declared = ins + only;
    }

    /* Only http(s) is a link. A `url` of "javascript:…" is not one, and the
       fallback is built from an id reduced to the characters an id can hold,
       so a value like "../../etc/passwd" cannot be printed on the card in the
       shape of a working address. */
    var url = clean(d.url);
    if (!/^https?:\/\//i.test(url)) {
      url = CANONICAL + '/p/' + clean(d.id).replace(/[^A-Za-z0-9_-]/g, '');
    }

    return {
      title: clean(d.title) || 'Untitled agent',
      name: clean(d.name) || clean(d.id) || 'unnamed',
      created: clean(d.created),
      envelope: clean(d.envelope),
      capture_path: clean(d.capture_path),
      owner_confirmed: d.owner_confirmed,
      url: url,
      caps: caps,
      declared: declared,
      installable: installable,
      raw: d
    };
  }

  function draw(ctx, v, pal) {
    var ink = pal['--ph-ink'], mute = pal['--ph-mute'], line = pal['--ph-line'];
    var paper = pal['--ph-paper'], deep = pal['--ph-deep'], cardbg = pal['--ph-card'];

    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    setTracking(ctx, 0);

    /* the mat, fully opaque. No alpha anywhere on this canvas: a chat client
       that flattens transparency onto its own ground would otherwise punch
       four black corners into the card. */
    ctx.fillStyle = pal['--ph-paper-deep'];
    ctx.fillRect(0, 0, W, H);

    /* the document, sitting on it */
    ctx.save();
    var shadow = inkAlpha(ink, 0.16);
    if (shadow) { ctx.shadowColor = shadow; ctx.shadowBlur = 26; ctx.shadowOffsetY = 8; }
    roundRect(ctx, CARD.x, CARD.y, CARD.w, CARD.h, R);
    ctx.fillStyle = cardbg;
    ctx.fill();
    ctx.restore();

    ctx.save();
    roundRect(ctx, CARD.x, CARD.y, CARD.w, CARD.h, R);
    ctx.clip();

    /* page 1, the cover, on the left */
    ctx.fillStyle = deep;
    ctx.fillRect(CARD.x, CARD.y, LEFT_W, CARD.h);

    /* ── cover: mark, wordmark, envelope type ─────────────────────────── */
    var markH = 44;
    var markW = drawMark(ctx, L.x, L.y - 2, markH, paper);
    ctx.fillStyle = paper;
    ctx.font = sans(23, 600);
    setTracking(ctx, -23 * 0.025);
    var lockupRight = L.x + markW + 12 + widthOf(ctx, 'Phaeacia');
    ctx.fillText('Phaeacia', L.x + markW + 12, L.y + 20);
    setTracking(ctx, 0);

    /* The envelope, in the corner the cover puts it in. It wraps to two lines
       rather than shrinking, and BOTH lines are bounded by where the wordmark
       ends: a long envelope name would otherwise run its second line straight
       into the lockup. */
    var typeLine = 'TYPE ' + envClass(v.envelope) +
                   (v.envelope ? ' · ' + upper(v.envelope) : '');
    ctx.font = mono(11, 400);
    setTracking(ctx, 11 * 0.12);
    ctx.globalAlpha = 0.78;
    var typeMax = L.r - lockupRight - 24;
    ctx.textAlign = 'right';
    if (widthOf(ctx, typeLine) <= typeMax) {
      ctx.fillText(typeLine, L.r, L.y + 16);
    } else {
      ctx.fillText('TYPE ' + envClass(v.envelope), L.r, L.y + 7);
      ctx.fillText(ellipsize(ctx, upper(v.envelope), typeMax), L.r, L.y + 25);
    }
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;
    setTracking(ctx, 0);

    /* ── cover: the bearer block, built from the bottom edge up ───────── */
    ctx.font = mono(15, 400);
    var idLine = ellipsize(ctx, v.name, L.w);
    var idBase = L.b;

    ctx.font = sans(30, 600);
    setTracking(ctx, -30 * 0.02);
    var titleLines = wrap(ctx, v.title, L.w, 2);
    var titleLH = 36;
    var titleBottom = idBase - 24;
    var titleTop = titleBottom - (titleLines.length - 1) * titleLH;
    var labelBase = titleTop - 34;
    var ruleY = labelBase - 22;

    ctx.fillStyle = paper;
    for (var t = 0; t < titleLines.length; t++) {
      ctx.fillText(titleLines[t], L.x, titleTop + t * titleLH);
    }
    setTracking(ctx, 0);

    ctx.font = mono(15, 400);
    ctx.globalAlpha = 0.78;
    ctx.fillText(idLine, L.x, idBase);
    ctx.globalAlpha = 1;

    ctx.font = mono(11, 400);
    setTracking(ctx, 11 * 0.12);
    ctx.globalAlpha = 0.70;
    ctx.fillText('BEARER', L.x, labelBase);
    ctx.globalAlpha = 1;
    setTracking(ctx, 0);

    ctx.save();
    ctx.globalAlpha = 0.42;
    hairline(ctx, L.x, ruleY, L.r, paper);
    ctx.restore();

    /* ── cover: AGENT PASSPORT, filling what is left between the two ──── */
    var titleZoneTop = L.y + markH + 28;
    var titleZoneBottom = ruleY - 28;
    var big = fitSize(ctx, 'PASSPORT', L.w, function (s) { return mono(s, 400); }, 22, 60, 0.10);
    var bigLH = big * 1.16;
    /* Centred on what you can SEE, not on the baselines. Mono caps have a cap
       height near .72em and no descender in either word, so the block's ink
       runs from the first baseline minus a cap height to the second baseline.
       Centring the baselines instead sat the whole title a cap height high in
       a panel with a lot of air in it, which reads as a layout that slipped. */
    var bigInk = big * 0.72 + bigLH;
    var firstBase = titleZoneTop + (titleZoneBottom - titleZoneTop - bigInk) / 2 + big * 0.72;
    ctx.fillStyle = paper;
    ctx.fillText('AGENT', L.x, firstBase);
    ctx.fillText('PASSPORT', L.x, firstBase + bigLH);
    setTracking(ctx, 0);

    /* ── the right page ───────────────────────────────────────────────── */
    /* header */
    ctx.font = mono(11, 400);
    setTracking(ctx, 11 * 0.12);
    ctx.fillStyle = ink;
    ctx.fillText('ENTRY PERMISSIONS', Rp.x, Rp.y + 12);
    ctx.fillStyle = mute;
    ctx.textAlign = 'right';
    /* Page 4 writes "N declared, M installable, K declared only", where the
       bare word is the total and the qualified one is its complement. There is
       no room for the third number here, and without it "DECLARED" is the one
       word on the card that a reader who has seen the passport page will read
       backwards. CAPABILITIES cannot be read two ways. Both numbers are
       counted off the rows drawn below them. */
    ctx.fillText(v.declared + ' CAPABILITIES · ' + v.installable + ' INSTALLABLE', Rp.r, Rp.y + 12);
    ctx.textAlign = 'left';
    setTracking(ctx, 0);
    hairline(ctx, Rp.x, Rp.y + 26, Rp.r, line);

    /* meta strip: three fields off the passport, in the register page 2 uses */
    var meta = [
      ['ISSUED', v.created || 'not stated'],
      ['CAPTURE PATH', v.capture_path || 'not stated'],
      ['SIGNED BY OWNER', v.owner_confirmed === true ? 'confirmed'
        : v.owner_confirmed === false ? 'not confirmed' : 'not stated']
    ];
    var colW = Rp.w / 3;
    for (var m = 0; m < meta.length; m++) {
      var mx = Rp.x + m * colW;
      ctx.font = mono(11, 400);
      setTracking(ctx, 11 * 0.12);
      ctx.fillStyle = mute;
      ctx.fillText(ellipsize(ctx, meta[m][0], colW - 12), mx, Rp.y + 52);
      setTracking(ctx, 0);
      ctx.font = mono(15, 400);
      ctx.fillStyle = ink;
      ctx.fillText(ellipsize(ctx, meta[m][1], colW - 12), mx, Rp.y + 73);
    }
    hairline(ctx, Rp.x, Rp.y + 88, Rp.r, line);

    /* the machine-readable strip, anchored to the bottom of the page */
    var urlBase = Rp.b;
    var lines = buildMrz(v.raw, { declared: v.declared, installable: v.installable });
    var wellW = Rp.w;
    var mrzSize = fitSize(ctx, lines[0], wellW - 32, function (s) { return mono(s, 400); }, 8, 18, 0.14);
    var mrzLH = Math.round(mrzSize * 1.85);
    var wellH = mrzLH * 2 + 24;
    var wellY = urlBase - 18 - 14 - wellH;

    ctx.fillStyle = pal['--ph-paper-deep'];
    roundRect(ctx, Rp.x, wellY, wellW, wellH, 8);
    ctx.fill();
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    roundRect(ctx, Rp.x + 0.5, wellY + 0.5, wellW - 1, wellH - 1, 8);
    ctx.stroke();

    ctx.fillStyle = ink;
    ctx.font = mono(mrzSize, 400);
    setTracking(ctx, mrzSize * 0.14);
    ctx.fillText(lines[0], Rp.x + 16, wellY + 12 + mrzLH * 0.72);
    ctx.fillText(lines[1], Rp.x + 16, wellY + 12 + mrzLH * 1.72);
    setTracking(ctx, 0);

    /* the link, because a card nobody can act on is a sticker */
    ctx.font = mono(15, 400);
    ctx.fillStyle = mute;
    ctx.fillText(ellipsize(ctx, v.url.replace(/^https?:\/\//i, ''), Rp.w), Rp.x, urlBase);

    /* ── the stamps, in the band that is left ─────────────────────────── */
    var bandTop = Rp.y + 108;
    var bandBottom = wellY - 22;
    var bandH = bandBottom - bandTop;
    /* Six rows fit. A seventh does not, so the sixth row becomes the line that
       says how many are missing, and that count is the difference between what
       the passport declares and what is stamped here: it is never derived from
       the length of the kept list, which is capped. */
    var split = stampSplit(v);
    var shown = split.shown, overflow = split.overflow;

    var rowCount = shown.length + (overflow > 0 ? 1 : 0);
    /* Anchored to the TOP of the band, not centred in it. Centring put the one
       row of a one-capability passport in the middle of the page with a hundred
       logical pixels of nothing above it, which reads as a layout that failed
       to fill rather than as a document. A page of a passport has its slack at
       the bottom, above the machine-readable zone, so that is where the slack
       goes: the first row always sits the same step under the meta rule, and
       the same is true of the sentence an empty passport gets instead. */
    var rowH = Math.min(56, bandH / Math.max(1, rowCount));
    var top = bandTop;
    if (rowCount === 0) {
      ctx.font = sans(15, 400);
      ctx.fillStyle = mute;
      ctx.fillText('No capabilities declared on this passport.', Rp.x, top + rowH / 2 + 5);
    } else {
      var stampCol = 124;
      var labelW = Rp.w - stampCol - 20;
      for (var i = 0; i < shown.length; i++) {
        var cy = top + rowH * i + rowH / 2;
        /* Mono, because a capability name is something a machine owns:
           DESIGN-GUIDE section 5 lists capability names by name, and page 4
           of the passport sets .permit .cap in mono at this same step. It
           also makes the split legible on the card itself, where every mono
           string is the passport's and every sans string is the card's own. */
        ctx.font = mono(15, 400);
        ctx.fillStyle = ink;
        ctx.fillText(ellipsize(ctx, shown[i].label, labelW), Rp.x, cy + 5);
        drawStamp(ctx, Rp.r, cy,
          shown[i].granted ? 'GRANTED' : 'NOT GRANTED',
          shown[i].granted ? pal['--pp-granted'] : pal['--pp-refused'],
          TILTS[i % TILTS.length]);
        if (i < rowCount - 1) hairline(ctx, Rp.x, top + rowH * (i + 1), Rp.r, pal['--ph-line-soft']);
      }
      if (overflow > 0) {
        var oy = top + rowH * shown.length + rowH / 2;
        ctx.font = sans(15, 400);
        ctx.fillStyle = mute;
        /* "More" only if something is shown above it. A card handed counts but
           no capability array stamps nothing, and "5 more" would then be five
           on top of the nothing the reader can see. */
        ctx.fillText(ellipsize(ctx,
          overflow + (shown.length ? ' more' : '') +
          (overflow === 1 ? ' capability is' : ' capabilities are') +
          ' listed on the passport.', Rp.w), Rp.x, oy + 5);
      }
    }

    ctx.restore();

    /* the document's own edge, drawn last so nothing sits on top of it */
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    roundRect(ctx, CARD.x + 0.5, CARD.y + 0.5, CARD.w - 1, CARD.h - 1, R);
    ctx.stroke();
  }

  /* ── the mounted component ────────────────────────────────────────────── */
  function altText(v) {
    var parts = ['An Agent Passport card.',
      'Bearer ' + v.title + ', identifier ' + v.name + '.',
      'Type ' + envClass(v.envelope) + (v.envelope ? ', ' + v.envelope : '') + '.'];
    if (v.created) parts.push('Issued ' + v.created + '.');
    if (v.declared) {
      parts.push(v.declared + (v.declared === 1 ? ' capability, ' : ' capabilities, ') +
        v.installable + ' granted, ' + (v.declared - v.installable) + ' not granted.');
    }
    var split = stampSplit(v);
    for (var i = 0; i < split.shown.length; i++) {
      parts.push(split.shown[i].label + ': ' + (split.shown[i].granted ? 'granted' : 'not granted') + '.');
    }
    if (split.overflow > 0) {
      parts.push(split.overflow + (split.shown.length ? ' more' : '') +
        (split.overflow === 1 ? ' capability is' : ' capabilities are') + ' listed on the passport.');
    }
    if (!v.declared) parts.push('No capabilities declared on this passport.');
    parts.push(v.url);
    return parts.join(' ');
  }

  function slug(s) {
    return clean(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  }
  function safeFilename(name, fallback) {
    var n = clean(name).replace(/[\\/:*?"<>|]+/g, '-').replace(/^\.+/, '').slice(0, 120);
    if (!n) return fallback;
    return /\.png$/i.test(n) ? n : n + '.png';
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function render(mountEl, data) {
    if (!mountEl || !mountEl.appendChild) {
      return Promise.reject(new Error('PassportCard.render needs an element to mount into.'));
    }
    var v = resolve(data);
    var pal = palette();

    return ensureFonts().then(function (fontsOk) {
      var scale = 2;
      var dpr = window.devicePixelRatio || 1;
      if (dpr >= 2.5) scale = 3;

      var canvas = document.createElement('canvas');
      canvas.width = W * scale;
      canvas.height = H * scale;
      canvas.className = 'pc-canvas';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', altText(v));

      var ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      draw(ctx, v, pal);

      /* Mount. Nothing here is built from a string of markup, and every text
         node is set through textContent. */
      while (mountEl.firstChild) mountEl.removeChild(mountEl.firstChild);
      if (mountEl.__pcRevoke) { mountEl.__pcRevoke(); mountEl.__pcRevoke = null; }

      var fig = el('figure', 'pc');
      var frame = el('div', 'pc-frame');
      frame.appendChild(canvas);
      fig.appendChild(frame);

      var caption = el('figcaption', 'pc-actions');
      var defaultName = 'agent-passport-' + (slug(v.name) || 'card') + '.png';

      var link = el('a', 'btn pc-dl', 'Download the card');
      link.setAttribute('download', defaultName);
      link.setAttribute('href', '#');
      caption.appendChild(link);

      var copyBtn = null;
      if (navigator.clipboard && typeof window.ClipboardItem === 'function' && navigator.clipboard.write) {
        copyBtn = el('button', 'btn ghost pc-copy', 'Copy the image');
        copyBtn.type = 'button';
        caption.appendChild(copyBtn);
      }

      var status = el('span', 'pc-status');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      caption.appendChild(status);

      var note = el('p', 'pc-note',
        'A PNG at ' + (W * scale) + ' by ' + (H * scale) + ' pixels. Everything on it is read off the passport.' +
        (fontsOk ? '' : ' The site\'s own typefaces did not load, so this card is set in a substitute.'));
      fig.appendChild(caption);
      fig.appendChild(note);
      mountEl.appendChild(fig);

      /* One blob for the anchor, so the link is a real link: it can be
         middle-clicked, right-clicked and saved, not only activated. */
      var blobUrl = null;
      function withBlobUrl(cb) {
        if (blobUrl) { cb(blobUrl); return; }
        if (!canvas.toBlob) { cb(canvas.toDataURL('image/png')); return; }
        canvas.toBlob(function (blob) {
          if (!blob) { cb(canvas.toDataURL('image/png')); return; }
          blobUrl = URL.createObjectURL(blob);
          mountEl.__pcRevoke = function () { try { URL.revokeObjectURL(blobUrl); } catch (e) {} };
          cb(blobUrl);
        }, 'image/png');
      }
      withBlobUrl(function (url) { link.setAttribute('href', url); });

      function download(filename) {
        var name = safeFilename(filename, defaultName);
        return new Promise(function (resolveDl) {
          withBlobUrl(function (url) {
            var a = document.createElement('a');
            a.href = url;
            a.download = name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            resolveDl(name);
          });
        });
      }

      link.addEventListener('click', function (ev) {
        if (link.getAttribute('href') !== '#') return;   /* the blob is ready, let the browser do it */
        ev.preventDefault();
        download(defaultName);
      });

      if (copyBtn) {
        copyBtn.addEventListener('click', function () {
          status.textContent = '';
          try {
            var item = new window.ClipboardItem({
              'image/png': new Promise(function (res, rej) {
                if (!canvas.toBlob) { rej(new Error('no toBlob')); return; }
                canvas.toBlob(function (b) { b ? res(b) : rej(new Error('no blob')); }, 'image/png');
              })
            });
            navigator.clipboard.write([item]).then(function () {
              status.textContent = 'Copied. Paste it wherever you are sending it.';
            })['catch'](function () {
              status.textContent = 'Your browser refused the copy. Download it instead.';
            });
          } catch (e) {
            status.textContent = 'Your browser refused the copy. Download it instead.';
          }
        });
      }

      return { canvas: canvas, download: download, fontsLoaded: fontsOk };
    });
  }

  window.PassportCard = { render: render, WIDTH: W, HEIGHT: H };
})();

/* The candidate finder for the Jev password check (design S), and nothing else: no network, no
   environment, no state. Pure, so it is tested without a fake of anything.

   WHAT IT IS FOR. The upload gate's code rules (validate()) already refuse the secrets whose SHAPE
   they know. The Jev check exists for the rest: a password in a sentence, a token in a shape no rule
   names. A model reading a whole passport cannot say WHERE a password is, and it misses ones inside
   URLs (measured: 41 of 44 leak rows at 0.5 with the whole document, 44 of 44 with the design
   below). So code picks candidate lines, deliberately OVER-inclusive because it bounds recall, and
   the model judges each candidate on about 200 characters of context. A candidate is a line, and
   the line number is what a held or refused screen can name.

   IT IS A PORT, NOT A NEW DESIGN. It is the extractor frozen in
   record/reproductions/jev-2026-09-24-password/run.frozen.py (`P`, `LONG`, `candidates`,
   `excerpts`), measured there at 87.6% recall at 0.5 and 71.0% at 0.7 over 635 positive documents,
   0 false alarms at 0.7 over 449 clean ones (record/findings/a-jev-password-check-catches-88-
   percent-at-0-5-...-2026-09-24.md). tools/fixtures/secret_candidates.json holds documents with the
   Python's own answers and the test compares this file to them, so a change here that is not a
   change there fails a test rather than silently detaching the deployed check from its evidence.

   WHAT IS AND IS NOT THE SAME AS THE PYTHON. Checked by a differential run against the Python
   itself, not by argument: more than 500,000 random documents (two grammars, over ASCII, the four folded
   letters and emoji) with no difference in any candidate line or excerpt, the 735 distinct measured
   texts (rows.json and rows2.json of the reproduction), and the 348 in tools/fixtures/secret_candidates.json (a test compares every one). The
   same run against the previous version of this file found 2,045 differences in 40,000.
   1. No regex here is quadratic. Unbounded, `auth\w*`, `[\w.\-]*` after a keyword, `host=[^;\n]*;`
      and the JWT and `curl ... -u` rules cost seconds of backtracking on a 256 KB line that passes the
      code gate (measured 8 to 9 s), and this runs inside an upload request. The four rules whose
      reach the Python leaves unbounded are scans with the same answer: named assignments
      (assignOffsets), query parameters (queryOffsets), `curl -u` together with the
      `Authorization:` header, which are one regex in Python and so consume each other's text
      (authOffsets), and the JWT (jwtOffsets). Worst measured at 256 KB over 23 shapes aimed at these scans: about 200 ms. That
      claim was false for `curl -u ` repeated, about 1 s, until two searches in authOffsets were bounded (2026-10-22); the
      sweep in tools/jev.test.mjs now requires each of 147 shapes to grow linearly from 16 KB to 512 KB, not to beat a clock.
   2. Two rules keep a bound the Python does not have, because a scan for them is not worth its code:
      the reach from a `host=` to its `;` (200 characters) and from there to `password=` (300), and
      the scheme before `://` (32). None changes which LINE is a candidate on the documents checked,
      because the `password=` alternative of the same rule names the line anyway; a very long host
      moves the excerpt window.
   3. Line numbers come from a precomputed table of newline offsets, not a count per match.
   4. JavaScript's \w, \b and \s are ASCII (\s a little wider) where Python's are Unicode, so around
      a non-English letter the two disagree in BOTH directions ("Zürich team room" is a candidate here
      and not there). Unmeasured beyond that; every document used to check parity is English. Three
      Unicode differences ARE closed: Python's ignore-case matches dotless i, dotted capital I, long
      s and the Kelvin sign to ASCII letters, so a rule that ignores case runs on a copy with those
      four mapped (one code unit for one, so offsets agree), and a rule that does not runs on a copy
      where they are `_`, a word character no `[A-Za-z0-9]` holds; and counts like `\S{4,}` are in
      code points (the `u` flag), so an emoji is one, as there.
   5. Excerpt windows are cut by code point, like Python's, not by UTF-16 unit, when the text holds
      an emoji or any other character outside the basic plane. */

export const WIN = 200;
export const CAP = 30;

const P = [
  /[A-Za-z][A-Za-z0-9+.\-]{0,31}:\/\/[^\s/]*@/g,                                                // 0 userinfo url
  /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|PRIVATE KEY BLOCK)/g,                                    // 1 private key blocks
  null,                                                                                        // 2 JWT (jwtOffsets, below)
  null,                                                                                        // 3 auth headers and curl -u (authOffsets, below)
  null,                                                                                        // 4 named assignments (assignOffsets, below)
  null,                                                                                        // 5 url query (queryOffsets, below)
  /\b(?:password|passphrase|pin|token|key|code|secret|login)\s+(?:is|was|=|:)\s*\S{4,}|\b(?:password|passphrase|pwd)\s+[^\s)]{4,}|\b(?:user(?:name)?|login)\s+\S{1,80}\s*(?:,|and|\/)\s*(?:the\s+)?(?:password|pass)\s+\S+/gi, // 6 prose
  /\[SCRUBBED:/g,                                                                              // 7 residue next to a scrub marker
  /(?:hooks\.slack\.com|discord(?:app)?\.com\/api\/webhooks|webhook\.office\.com|outlook\.office\.com\/webhook|hooks\.zapier\.com|api\.telegram\.org\/bot|\/webhooks?\/)/gi, // 8 webhooks
  /(?:set-cookie|cookie):\s*\S+/gi,                                                            // 9 cookies
  /otpauth:\/\/|\b[A-Z2-7]{16,}\b/g,                                                           // 10 TOTP seeds
  /"(?:private_key|private_key_id|client_secret|client_email)"|aws_(?:access_key_id|secret_access_key)/gi, // 11 cloud credential files
  /X-Amz-Signature|X-Goog-Signature|[?&]Signature=|[?&]sig=/gi,                                // 12 signed urls
  /\bjdbc:\w+:\/\/|(?:server|host|data source)=[^;\n]{0,200};[^\n]{0,300}(?:password|pwd)=|(?:password|pwd)=[^;\s&]{3,}/gi, // 13 connection strings
  /(?:\b[A-Za-z0-9]{4,8}[- ]){3,}[A-Za-z0-9]{4,8}\b/g                                          // 14 code groups (recovery codes)
];
const LONG = /[A-Za-z0-9_\-+/=.]{16,}/g;

/* Python counts `\S{4,}` in characters, JavaScript in UTF-16 units, so an emoji is one there and two
   here. The `u` flag counts code points; offsets stay in units, which is what slicing needs. */
for (let i = 0; i < P.length; i++) if (P[i]) P[i] = new RegExp(P[i].source, P[i].flags + 'u');
const cpAtLeast = (text, from, to, n) => to - from >= 2 * n || Array.from(text.slice(from, to)).length >= n;

/* newline offsets, so a match's line is a binary search, not a scan from the top */
function lineIndex(text) {
  const nl = [];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) nl.push(i);
  return off => {
    let lo = 0, hi = nl.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (nl[mid] < off) lo = mid + 1; else hi = mid; }
    return lo;   // the number of newlines strictly before off = the 0-based line
  };
}

/* A JWT is `eyJ` + 6 or more token characters, a dot, 6 or more, a dot, with the `eyJ` starting a word.
   The token alphabet has no dot, so it is read as runs of the alphabet: a header run that ends in a
   dot, then a payload run that starts right after it and ends in a dot. One pass over the runs, no
   backtracking, and no length limit on either part (an unsigned token with a long payload is one the
   code gate does not refuse and this check is for). Like a regex scan it does not reuse a payload run
   as the next header. */
const FOLDSET = /[ſıİ\u212A]/;
function jwtOffsets(text) {
  const runs = [...text.matchAll(/[A-Za-z0-9_-]+/g)];
  const out = [];
  let consumedTo = -1;
  for (let i = 0; i + 1 < runs.length; i++) {
    const r = runs[i], n = runs[i + 1];
    const end = r.index + r[0].length;
    if (r.index < consumedTo) continue;
    if (text[end] !== '.' || n.index !== end + 1) continue;
    if (n[0].length < 6 || text[n.index + n[0].length] !== '.') continue;
    for (let j = r[0].indexOf('eyJ'); j !== -1; j = r[0].indexOf('eyJ', j + 1)) {
      if ((j === 0 ? !FOLDSET.test(text[r.index - 1] || '') : r[0][j - 1] === '-') && r[0].length - j >= 9) {
        out.push(r.index + j);
        consumedTo = n.index + n[0].length + 1;
        break;
      }
    }
  }
  return out;
}

const WS = /\s/;

/* Rule 4, the named assignment: a keyword, then `[\w.-]*`, optional space, `:` or `=`, optional
   space, and four or more non-space characters. Python's has no upper bound on the name that
   follows the keyword (`auth\w*`, `[\w.\-]*`), so a variable of 72 characters is a candidate there.
   As a regex that is quadratic on `pass.pass.pass.` at 256 KB, so it is a scan: the keyword alone is
   a regex (each match ends at a word boundary), and what follows depends only on where the run of
   `[\w.-]` starting at the keyword's end stops, because neither `:` nor `=` nor a space is in it. That
   end, and the answer for it, are computed once per run. Matches do not overlap, as in Python: a
   keyword inside the text an earlier match consumed is not tried. */
const KW4 = /(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|credential|auth\w*|bearer|private[_-]?key|\bkey|cookie|session|sid|otp|totp|seed|recovery|access[_-]?key)\b/gi;
const NAMECH = /[\w.\-]/;
function assignOffsets(text) {
  const n = text.length, out = [], tail = new Map();
  let pos = 0, runFrom = -1, runTo = -1;
  for (const m of text.matchAll(KW4)) {
    if (m.index < pos) continue;
    const k = m.index + m[0].length;
    let r;
    if (k >= runFrom && k <= runTo) r = runTo;
    else { r = k; while (r < n && NAMECH.test(text[r])) r++; runFrom = k; runTo = r; }
    let end = tail.get(r);
    if (end === undefined) {
      end = -1;
      let j = r;
      while (j < n && WS.test(text[j])) j++;
      if (j < n && (text[j] === ':' || text[j] === '=')) {
        j++;
        while (j < n && WS.test(text[j])) j++;
        let e = j;
        while (e < n && !WS.test(text[e])) e++;
        if (cpAtLeast(text, j, e, 4)) end = e;
      }
      tail.set(r, end);
    }
    if (end !== -1) { out.push(m.index); pos = end; }
  }
  return out;
}

/* Rule 5, a query parameter whose name holds a secret-looking word: `?` or `&`, an optional HTML
   entity for the ampersand, a name, `=`, six or more value characters. Python's name has no upper
   bound either side of the word. The name is the run of `[\w-]` up to the `=`, and the word must sit
   in its last stretch after the final `-` (the tail after the word is `\w*`, which has no `-`), so
   the test is one run and one search, not a search per position. */
const QKEY = /key|token|secret|sig|auth|pass|credential/i;
const ENTITY = /^(?:amp;|#38;|#x26;)/i;
const NAMECH5 = /[\w\-]/;
const VALSTOP = /[\s&#]/;
function queryOffsets(text) {
  const n = text.length, out = [];
  let pos = 0;
  for (const m of text.matchAll(/[?&]/g)) {
    if (m.index < pos) continue;
    const ent = ENTITY.exec(text.slice(m.index + 1, m.index + 6));
    /* With an entity present the name cannot start before it: `amp;` holds a `;`, which is in no
       name, so the search from the `&` itself could never reach an `=`. */
    for (const p of [m.index + 1 + (ent ? ent[0].length : 0)]) {
      let e = p;
      while (e < n && NAMECH5.test(text[e])) e++;
      if (e >= n || text[e] !== '=') continue;
      const seg = text.slice(p, e);
      if (!QKEY.test(seg.slice(seg.lastIndexOf('-') + 1))) continue;
      let v = e + 1;
      while (v < n && !VALSTOP.test(text[v])) v++;
      if (!cpAtLeast(text, e + 1, v, 6)) continue;
      out.push(m.index);
      pos = v;
      break;
    }
  }
  return out;
}

/* Python's `curl\s(?:[^\n]*\s)?-u\s*\S+:\S+`, ignoring case, as offsets of `curl`. Read literally:
   after `curl` and one space character, a `-u` that has a space character right before it and no
   newline between the `curl` and that space character, so on the same line, or at the very start of the
   next line (the newline is the space character; a shell line continuation puts `-u` there), then
   any space, then a word with a colon inside it (not first, not last). The regex is greedy, so of
   several `-u` that would do it the LAST one is the match, and where the match ENDS decides which
   later match is tried. Any number of characters may separate `curl` and `-u`: no limit, no regex, one
   pass per line. */
const CURL = /curl\s/gi;
const DASH_U = /-u/gi;
const AUTHH = /authorization:\s*(?:basic|bearer|token)\s+\S+/gi;

/* Rule 3 is ONE regex in Python, `authorization: ...` or `curl ... -u ...`, so a match of either
   consumes what it covers and the other is not tried inside it: a `curl -u a:b ... -H "Authorization:
   Bearer x"` line has one match, at the `curl`, whose greedy reach passes over the header. Two scans
   merged in start order, each resuming after the last match, give the same set of starts.
   `-u` is searched once per line: the answer for a `curl` depends only on which line's `-u` it can
   reach and where the last usable one is, so it is computed once per line end (`byEnd`) and every
   `curl` on that line reads it. */
function authOffsets(text) {
  const n = text.length;
  let dashU = null;             // every `-u`, found once, searched by bisection
  const byEnd = new Map();      // end of the line a curl reaches -> { p, end } of its last usable -u
  const lastUsable = (s, e) => {
    let r = byEnd.get(e);
    if (r === undefined) {
      r = { p: -1, end: -1 };
      if (!dashU) dashU = [...text.matchAll(DASH_U)].map(m => m.index);
      let lo = 0, hi = dashU.length;                       // first `-u` at or after s
      while (lo < hi) { const mid = (lo + hi) >> 1; if (dashU[mid] < s) lo = mid + 1; else hi = mid; }
      for (let d = lo; d < dashU.length && dashU[d] <= e + 1; d++) {
        const p = dashU[d];
        if (!WS.test(text[p - 1])) continue;
        let j = p + 2;
        while (j < n && WS.test(text[j])) j++;
        let k = j;
        while (k < n && !WS.test(text[k])) k++;
        /* A colon inside the word, not first, not last. Searched in the word only: `indexOf(':', j + 1)`
           read on to the end of the text whenever the word had none, once per `-u`, which made
           `curl -u ` repeated quadratic (about 1 s at 256 KB, 2026-10-22). */
        if (text.slice(j + 1, k - 1).includes(':')) { r.p = p; r.end = k; }   // greedy `[^\n]*`: the LAST one
      }
      byEnd.set(e, r);
    }
    return r;
  };
  /* The end of a curl's line is searched once per line, not once per `curl`: on a long line with no
     newline every `curl` read on to the end of the text, the second quadratic on `curl ` repeated.
     `lineEnd` is the first newline at or after `lineFrom`, so it is also the first at or after any
     offset between the two. */
  let lineFrom = -1, lineEnd = -1;
  const nextCurl = from => {
    CURL.lastIndex = from;
    for (let m = CURL.exec(text); m; m = CURL.exec(text)) {
      const s = m.index + 5;
      if (s < lineFrom || s > lineEnd) {
        lineFrom = s;
        lineEnd = text.indexOf('\n', s);
        if (lineEnd === -1) lineEnd = n;
      }
      const e = lineEnd;
      const r = lastUsable(s, e);
      if (r.p !== -1 && r.p >= s) return { at: m.index, end: r.end };
      CURL.lastIndex = m.index + 1;
    }
    return null;
  };
  const nextAuth = from => {
    AUTHH.lastIndex = from;
    const m = AUTHH.exec(text);
    return m ? { at: m.index, end: m.index + m[0].length } : null;
  };
  const out = [];
  let pos = 0, a = nextAuth(0), c = nextCurl(0);
  while (a || c) {
    if (a && a.at < pos) { a = nextAuth(pos); continue; }
    if (c && c.at < pos) { c = nextCurl(pos); continue; }
    const t = (a && (!c || a.at < c.at)) ? a : c;
    out.push(t.at);
    pos = t.end;
  }
  return out;
}

/* [{ line, off }] for at most CAP lines, in line order. `line` is 0-based. Each line keeps the
   lowest-priority-number rule that hit it (first match wins within a rule); the CAP lines kept are
   the best by (priority, line). */
const FOLD = { 'ſ': 's', 'ı': 'i', 'İ': 'i', 'K': 'k' };
export function candidates(original) {
  /* Python's ignore-case matches four non-ASCII letters to ASCII ones, so a rule that ignores case
     runs on a copy where they are mapped, one code unit for one so offsets agree. A rule that does
     not ignore case runs on the original: `ı` is not in `[A-Za-z0-9]` there. */
  const folded = original.replace(/[ſıİK]/g, c => FOLD[c] || 'k');
  /* A rule that does not ignore case sees these four letters as word characters (Python's \w is
     Unicode) that are NOT in `[A-Za-z0-9]`: `_` is exactly that, a word character no such class holds. */
  const cs = original.replace(/[ſıİ\u212A]/g, '_');
  const text = original;
  const lineOf = lineIndex(text);
  const hit = new Map();                       // line -> { pri, off }
  /* Within one priority the earliest offset wins, which is what Python's single alternation gives
     rule 3 (`Authorization:` and `curl -u` are one pattern there and two scans here). */
  const note = (line, pri, off) => {
    const h = hit.get(line);
    if (!h || pri < h.pri || (pri === h.pri && off < h.off)) hit.set(line, { pri, off });
  };
  P.forEach((rx, pri) => {
    if (!rx) return;
    for (const m of (rx.ignoreCase ? folded : cs).matchAll(rx)) note(lineOf(m.index), pri, m.index);
  });
  for (const off of jwtOffsets(text)) note(lineOf(off), 2, off);
  for (const off of authOffsets(folded)) note(lineOf(off), 3, off);
  for (const off of assignOffsets(folded)) note(lineOf(off), 4, off);
  for (const off of queryOffsets(folded)) note(lineOf(off), 5, off);
  for (const m of text.matchAll(LONG)) {
    const t = m[0];
    const mixed = t.length >= 24 && /[a-z]/.test(t) && /[A-Z]/.test(t);
    if (((/\d/.test(t) && /[A-Za-z]/.test(t)) || mixed) && (t.split('/').length - 1) < 3 && !t.includes('(')) {
      note(lineOf(m.index), 99, m.index);
    }
  }
  return [...hit.entries()]
    .sort((a, b) => a[1].pri - b[1].pri || a[0] - b[0])
    .slice(0, CAP)
    .map(([line, h]) => ({ line, off: h.off }))
    .sort((a, b) => a.line - b.line);
}

/* The ~200 characters around each candidate, newlines shown as " | ", so one candidate is one
   short paragraph in the model's input. Returns [{ line, excerpt }]. */
export function excerpts(text) {
  const cands = candidates(text);
  if (cands.length === 0) return [];
  const astral = /[\uD800-\uDFFF]/.test(text);
  const cps = astral ? Array.from(text) : null;
  return cands.map(({ line, off }) => {
    let win;
    if (astral) {
      const at = Array.from(text.slice(0, off)).length;       // the offset in code points, as Python counts
      win = cps.slice(Math.max(0, at - WIN / 2), at + WIN / 2).join('');
    } else {
      win = text.slice(Math.max(0, off - WIN / 2), off + WIN / 2);
    }
    return { line, excerpt: win.replace(/\n+/g, ' | ').trim() };
  });
}

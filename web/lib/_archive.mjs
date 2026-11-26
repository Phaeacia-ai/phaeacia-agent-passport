/* Archive mode: the app as a read-only showcase.

   ONE ENVIRONMENT VARIABLE, OFF BY DEFAULT. `ARCHIVE_MODE=1` on the site turns
   it on. Unset, empty, `0`, `false`, `off` or `no` leave it off; any other
   value turns it on, because a mistyped value should err towards fewer
   writes rather than more. Read per call, never cached, like every other
   switch in lib/. Netlify applies an environment variable per deploy, so a
   change takes effect with the next deploy, and that same deploy's build
   rewrites the static pages (tools/archive-dist.mjs), which is why the flag
   needs its Builds scope as well as its Functions scope.

   WHAT IT DOES, decided per function and listed in README.md ("Archive
   mode"), with a test in tools/run-endpoint-tests.mjs that fails when a new
   function is added without a decision:

   - Refused with 410 and code `archived`: new uploads, votes, listing and
     renewing from /api/manage, sending a link, subscribing, attaching an
     address to a held upload. 410 is a contract: the capture skill's
     publish.py reads that status and tells the user their file is unchanged.
   - Kept: every read (passport pages, the gallery, gallery.json, social
     cards, the legal pages), and every way an owner withdraws a passport
     (delete, unlist) plus the operator takedown tools. Withdrawal is a
     privacy promise and is not switched off with the rest.
   - Kept, without the mail: the hourly sweep still deletes expired
     passports and held uploads, and no longer mails a held uploader; the
     digest sends nothing.
   - Stopped quietly: the view counter, the copy counters and the edge page
     counter write nothing.

   Nothing here changes how long anything is kept. */

export const ARCHIVE_CODE = 'archived';
export const ARCHIVE_STATUS = 410;
export const ARCHIVE_REPO = 'https://github.com/Phaeacia-ai/phaeacia-agent-passport';
export const SKILL_REPO = 'https://github.com/Phaeacia-ai/phaeacia-agent-passport-skill';

/* Kept in step with netlify/edge-functions/count.ts, which cannot import this
   file; tools/archive.test.mjs compares the two. */
export const ARCHIVE_OFF_VALUES = Object.freeze(['', '0', 'false', 'off', 'no']);

export function archiveMode(env = process.env) {
  const raw = env && env.ARCHIVE_MODE;
  if (raw === undefined || raw === null) return false;
  return !ARCHIVE_OFF_VALUES.includes(String(raw).trim().toLowerCase());
}

export const UPLOAD_CLOSED_MESSAGE =
  'Agent Passport is archived and this site no longer accepts uploads. Nothing was stored, and ' +
  'your passport file is unchanged on your machine. The code is open source at ' +
  ARCHIVE_REPO + ' if you want to run your own copy.';

export const WRITE_CLOSED_MESSAGE =
  'Agent Passport is archived, so this site no longer records votes, listings or renewals and ' +
  'sends no email. Nothing was changed. Published passports stay readable, and an owner can ' +
  'still unlist or delete one with its delete token. The code is open source at ' + ARCHIVE_REPO + '.';

/* The app's error body shape, { ok: false, code, message }, as err() in
   _validate.mjs builds it. Not routed through err(): MESSAGES is the upload
   validator's catalogue and its parity test pairs every code with a row in
   the endpoint spec table, which this repository's archive state is not. */
export function archivedBody(message = WRITE_CLOSED_MESSAGE) {
  return { ok: false, code: ARCHIVE_CODE, message };
}

export function archivedResponse(message = WRITE_CLOSED_MESSAGE) {
  return new Response(JSON.stringify(archivedBody(message)), {
    status: ARCHIVE_STATUS,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

/* ── the pages ──────────────────────────────────────────────────────────────
   The notice goes under the top bar of every page, static or rendered. Its
   styles are in assets/base.css, which every page loads. */
export const ARCHIVE_NOTICE =
  '<div class="archive-notice" role="note"><p><strong>Agent Passport is archived.</strong> ' +
  'This site still shows the passports already published and no longer accepts new ones, votes ' +
  'or email. An owner can still unlist or delete a passport with its delete token. The code is ' +
  `open source: <a href="${ARCHIVE_REPO}">github.com/Phaeacia-ai/phaeacia-agent-passport</a>.</p></div>`;

/* What the create and upload pages show instead of their forms. */
export const CLOSED_MAIN =
  '<main id="main" class="archived-main"><section class="intro"><h1>Agent Passport is archived.</h1>' +
  '<p>This site no longer publishes new passports. Nothing you could upload here would be stored, ' +
  'and a passport file you have already captured stays on your machine, unchanged.</p></section>' +
  '<section class="archive-closed"><p>The app, the passport format and the capture skill are open ' +
  'source. You can still capture an agent with the skill and share the file itself, or run your ' +
  'own copy of this app to publish links.</p><ul>' +
  `<li><a class="text-link" href="${ARCHIVE_REPO}">The code: github.com/Phaeacia-ai/phaeacia-agent-passport</a></li>` +
  `<li><a class="text-link" href="${SKILL_REPO}">The capture skill: github.com/Phaeacia-ai/phaeacia-agent-passport-skill</a></li>` +
  '<li><a class="text-link" href="/gallery">Browse the gallery</a></li>' +
  '<li><a class="text-link" href="/p/example">See the example passport</a></li>' +
  '<li><a class="text-link" href="/manage">Unlist or delete a passport you published</a></li>' +
  '</ul></section></main>';

/* Marks a whole page archived: `data-archived` on <html>, which is what the
   `[data-archive-hide]` rule in base.css keys on, and the notice after the
   first </header> (the top bar on every page here), or after <body> on a page
   with no header. Idempotent, so a build step run twice adds one notice. */
export function archivePage(html) {
  let out = String(html);
  out = out.replace(/<html\b([^>]*)>/i, (m, attrs) =>
    /\bdata-archived\b/.test(attrs) ? m : `<html${attrs} data-archived>`);
  if (out.includes('class="archive-notice"')) return out;
  const at = out.indexOf('</header>');
  if (at >= 0) {
    const end = at + '</header>'.length;
    return out.slice(0, end) + '\n' + ARCHIVE_NOTICE + out.slice(end);
  }
  return out.replace(/<body\b[^>]*>/i, m => m + '\n' + ARCHIVE_NOTICE);
}

/* The create and upload pages: their <main> replaced by CLOSED_MAIN and their
   page scripts dropped, keeping site.js (theme toggle). Returns null when the
   page does not have exactly one <main>, so the build step can fail rather
   than ship a form it could not find. */
export function closePage(html) {
  const s = String(html);
  const mains = s.match(/<main\b[^>]*>[\s\S]*?<\/main>/gi) || [];
  if (mains.length !== 1) return null;
  return s
    .replace(mains[0], () => CLOSED_MAIN)
    .replace(/[ \t]*<script\b[^>]*\bsrc="\/assets\/(?!site\.js")[^"]*"[^>]*><\/script>\n?/gi, '');
}

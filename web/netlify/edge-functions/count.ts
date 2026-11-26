/**
 * Server-side page counter. The numbers behind "how many people visit".
 *
 * The same file counts Phaeacia's other site with a different SKIP_PATH;
 * keep them identical otherwise, so a fix lands in both by copying. A
 * separate reporting script, not in this repository and named `pulse` in the
 * store and parameter names below, reads the keys and aggregates a day of
 * them from one list call.
 *
 * WHAT IT STORES. One empty blob per counted request, keyed
 *   raw/<utc-date>/<base64url path>~<base64url referrer-host>~<random>~<country>
 * and that key is the entire record. The country is the two-letter code
 * Netlify's edge works out from the connection (CH, DE, US), or XX when it
 * cannot; the address it was worked out from is never read here. Added
 * 2026-10-09; older keys end at <random>, and pulse reads both. No IP address,
 * no user agent, no cookie, no identifier of any kind, nothing per-visitor, so two requests from one
 * person are indistinguishable from one request each by two people. This is
 * what privacy.html says, in those words, and it is deliberate: a counter
 * that cannot tell people apart cannot be turned into tracking later by
 * someone in a hurry.
 *
 * WHAT IT NEVER TOUCHES. The response. Counting happens after the response is
 * already on its way, and any failure is swallowed: a broken counter must
 * never cost a page view. The CSP is unchanged because nothing here runs in
 * the browser.
 *
 * PRODUCTION ONLY. `getStore('pulse')` is a site-wide store, shared by every
 * deploy of the site, so a Deploy Preview counting into it would put crew
 * clicks into the production number. Outside the production context nothing
 * is written, except by the self-test below, which writes into a separate
 * `pulse-preview` store so a preview can prove the write path works without
 * touching the number the digest reads.
 *
 * OPT-OUT. An edge function cannot be blocked by an ad blocker, which is why
 * it is accurate and why it honours Do Not Track and Global Privacy Control
 * instead. privacy.html names both. If you remove that check, fix the page in
 * the same commit.
 */
import type { Config, Context } from '@netlify/edge-functions';
import { getStore } from '@netlify/blobs';

/** Bots that announce themselves. Not a defence, anything can lie, but it
 *  keeps the obvious crawlers and link-preview fetchers out of a number you
 *  are trying to read as people. */
const BOT = /bot|crawl|spider|slurp|bingpreview|headless|lighthouse|curl|wget|python-requests|node-fetch|go-http-client|monitor|uptime|pingdom|semrush|ahrefs|dataprovider|facebookexternalhit|twitterbot|slackbot|discordbot|telegrambot|whatsapp|linkedinbot|preview/i;

/** Only count things a person looks at. API calls, the social card image, the
 *  gallery's JSON feed and the installer text are requests too, but counting
 *  them makes "page views" mean nothing. */
const SKIP_PATH = /^\/(api\/|og\/|gallery\.json$|\.netlify\/|assets?\/|fonts?\/|images?\/|robots\.txt|sitemap|favicon)/i;

function shouldCount(req: Request, url: URL): boolean {
  if (req.method !== 'GET') return false;
  if (SKIP_PATH.test(url.pathname)) return false;
  if (/\.[a-z0-9]{2,5}$/i.test(url.pathname) && !url.pathname.endsWith('.html')) return false;

  // The opt-out. Do Not Track and Global Privacy Control both mean "do not
  // count me", and this is the only place that promise can be kept now that a
  // blocker cannot intercept the request.
  if (req.headers.get('dnt') === '1') return false;
  if (req.headers.get('sec-gpc') === '1') return false;

  // A prefetch is the browser guessing, not a person arriving.
  const purpose = req.headers.get('sec-purpose') || req.headers.get('purpose') || '';
  if (purpose.includes('prefetch')) return false;

  return !BOT.test(req.headers.get('user-agent') || '');
}

/** Referrer reduced to a bare host, and only when it is somebody else's.
 *  Full URLs can carry queries, tokens and paths that identify a person; the
 *  host is the only part that answers "where did they come from". */
function referrerHost(req: Request, self: string): string | null {
  const raw = req.headers.get('referer');
  if (!raw) return 'direct';
  try {
    const host = new URL(raw).hostname.replace(/^www\./, '');
    return host === self.replace(/^www\./, '') ? null : host;
  } catch {
    return null;
  }
}

/** Encode a value so it can live inside a blob key.
 *
 *  base64url, not percent-encoding. encodeURIComponent looks right and fails:
 *  it turns "/" into "%2F", but the Blobs list API decodes that back to a real
 *  slash, so "/" re-splits as a path separator and the field arrives empty.
 *  base64url's alphabet is [A-Za-z0-9_-], which survives any decoding and
 *  cannot collide with the "/" separator or the "~" delimiter.
 *
 *  TextEncoder first so non-ASCII paths do not throw in btoa. */
function enc(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Record one request. Split out so the debug path can await it and surface
 *  the error that the normal path deliberately swallows. */
async function record(req: Request, url: URL, storeName: string, country: string): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  // A passport page is /p/<uuid>. The uuid is the only secret an unlisted
  // passport has, so it must not land in a key a Netlify API token can list.
  // Count every passport page under one path; the app's own per-passport view
  // counter is where per-passport numbers live.
  const rawPath = url.pathname.replace(/^\/p\/[0-9a-f-]{36}$/i, '/p/_');
  const path = rawPath.length > 80 ? rawPath.slice(0, 80) : rawPath;
  const ref = referrerHost(req, url.hostname) ?? '';

  // ONE WRITE, NO READ. Every hit gets its own key and nothing is ever
  // updated, so there is no contention to lose a count to. Read-modify-write
  // lost writes whenever requests overlapped on the site this was ported
  // from, and compare-and-swap was worse under load. The data lives in the KEY, not the
  // value, so pulse aggregates a whole day from a single list call.
  const rand = crypto.randomUUID().slice(0, 8);
  const key = `raw/${date}/${enc(path)}~${enc(ref)}~${rand}~${country}`;
  await getStore(storeName).set(key, '');
  return key;
}

/** The visitor's country as two capital letters, or XX. Netlify fills
 *  context.geo at the edge; only the code is kept, never the city, the
 *  coordinates or the address behind them. Anything that is not exactly two
 *  letters becomes XX, so nothing odd can reach a key. */
function countryOf(context: Context): string {
  const code = (context as unknown as { geo?: { country?: { code?: string } } }).geo?.country?.code;
  return typeof code === 'string' && /^[A-Z]{2}$/.test(code) ? code : 'XX';
}

/** Only a page that loaded is a page somebody read. A 404 is a scanner asking
 *  for a file that does not exist (on 2026-10-07, 333 of phaeacia.ai's 442
 *  counted requests), and a redirect is counted once, at the page it lands on.
 *  304 counts: it is a browser confirming the copy it already has is current,
 *  which is a person opening the page again. */
function loaded(response: Response): boolean {
  return (response.status >= 200 && response.status < 300) || response.status === 304;
}

/** Archive mode (web/lib/_archive.mjs, which an edge function does not
 *  import): ARCHIVE_MODE set to anything but '', 0, false, off or no stops
 *  every write here, the self-test's included. The list is the one in
 *  lib/_archive.mjs, and tools/archive.test.mjs compares the two. */
const ARCHIVE_OFF_VALUES = ['', '0', 'false', 'off', 'no'];
function archived(): boolean {
  try {
    const raw = (globalThis as unknown as { Netlify?: { env?: { get(name: string): string | undefined } } })
      .Netlify?.env?.get('ARCHIVE_MODE');
    return raw !== undefined && raw !== null && !ARCHIVE_OFF_VALUES.includes(String(raw).trim().toLowerCase());
  } catch {
    return false;
  }
}

function isProduction(context: Context): boolean {
  const deploy = (context as unknown as { deploy?: { context?: string } }).deploy;
  return !!deploy && deploy.context === 'production';
}

export default async function handler(req: Request, context: Context) {
  if (archived()) return context.next();
  const url0 = new URL(req.url);

  // Self-test. `?__pulse=debug` runs the write inline and reports the outcome
  // instead of hiding it. Without this the failure mode is invisible: the
  // catch below exists so a broken counter cannot cost a page view, which also
  // means a broken counter says nothing at all. On a non-production deploy it
  // writes into `pulse-preview`, never the store the digest reads.
  if (url0.searchParams.get('__pulse') === 'debug') {
    const production = isProduction(context);
    const store = production ? 'pulse' : 'pulse-preview';
    try {
      const key = await record(req, url0, store, countryOf(context));
      return new Response(`pulse: write ok\nstore: ${store}\nkey: ${key}\n`, {
        headers: { 'content-type': 'text/plain', 'x-pulse': 'ok', 'cache-control': 'no-store' },
      });
    } catch (err) {
      return new Response(`pulse: ${(err as Error)?.name}: ${(err as Error)?.message}\n`,
        { status: 200, headers: { 'content-type': 'text/plain', 'x-pulse': 'error', 'cache-control': 'no-store' } });
    }
  }

  const response = await context.next();

  try {
    if (!isProduction(context)) return response;
    if (!shouldCount(req, url0)) return response;
    if (!loaded(response)) return response;

    // Counting must not delay the response. context.waitUntil is the standard
    // ExtendableEvent.waitUntil: the body streams to the reader while the blob
    // write finishes behind it.
    context.waitUntil(record(req, url0, 'pulse', countryOf(context)));
  } catch {
    // Swallowed on purpose. A counter that can 500 a page is worse than no
    // counter; pulse reports the source as down if the numbers stop.
  }

  return response;
}

export const config: Config = {
  path: '/*',
  // Assets never reach the function at all, which keeps both the latency cost
  // and the invocation count down. Function routes still pass through here,
  // and SKIP_PATH declines them.
  excludedPath: ['/assets/*', '/api/*', '/og/*', '/.netlify/*', '/*.png', '/*.jpg',
                 '/*.svg', '/*.webp', '/*.ico', '/*.woff2', '/*.woff', '/*.xml',
                 '/*.txt', '/*.json', '/*.css', '/*.js', '/*.mjs'],
};

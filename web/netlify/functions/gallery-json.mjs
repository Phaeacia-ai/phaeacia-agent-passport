/* Public data contract for phaeacia.ai's netlify/functions/gallery.mjs (ROW-224).
   Keep this independent of gallery HTML and CSS. Only the listed-card store is read;
   project an explicit allowlist so bodies, tokens and internal metadata cannot leak. */
import { listGallery } from '../../lib/_store.mjs';
import { categoryLabel } from '../../lib/_categories.mjs';
import { galleryWarning } from '../../lib/_gallery-card.mjs';
import { CANONICAL } from '../../lib/_site.mjs';

const PAGE_SIZE = 24;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=60',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
};
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const when = value => Date.parse(value) || 0;

export default async function handler(request, context) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { ...HEADERS, 'cache-control': 'no-store', allow: 'GET, HEAD' } });
  }
  try {
    const raw = new URL(request.url).searchParams.get('page');
    // Saturating huge positive integers keeps them past the end without rejecting valid pages.
    const page = raw === null ? 1 : Math.min(Number(raw), Number.MAX_SAFE_INTEGER);
    if (raw !== null && !/^[1-9][0-9]*$/.test(raw)) {
      return new Response(request.method === 'HEAD' ? null : JSON.stringify({ error: 'E_BAD_PAGE' }), {status: 400, headers: {...HEADERS, 'cache-control': 'no-store'}});
    }
    const result = await listGallery(context && context.deploy, { strict: true });
    if (!result.listed) throw new Error('Gallery unavailable');
    const listed = result.cards.filter(card => UUID.test(card.id));
    listed.sort((a, b) => when(b.listed_at) - when(a.listed_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const offset = (page - 1) * PAGE_SIZE;
    const cards = listed.slice(offset, offset + PAGE_SIZE).map(card => ({
      id: card.id,
      title: String(card.title || ''),
      summary: String(card.summary || ''),
      url: CANONICAL + '/p/' + card.id,
      category: String(card.category || ''),
      category_label: categoryLabel(card.category),
      envelope: String(card.envelope || ''),
      installable: count(card.installable),
      declared: count(card.declared_only),
      owner_confirmed: card.owner_confirmed === true,
      warning: galleryWarning(card),
      listed_at: Number.isFinite(Date.parse(card.listed_at)) ? new Date(card.listed_at).toISOString().slice(0, 10) : null
    }));
    const next = offset + PAGE_SIZE < listed.length ? '/gallery.json?page=' + (page + 1) : null;
    return new Response(request.method === 'HEAD' ? null : JSON.stringify({ version: 1, cards, next }), { headers: HEADERS });
  } catch {
    return new Response(request.method === 'HEAD' ? null : JSON.stringify({ error: 'E_GALLERY_UNAVAILABLE' }), {
      status: 503, headers: { ...HEADERS, 'cache-control': 'no-store' }
    });
  }
}

export const config = { path: '/gallery.json' };

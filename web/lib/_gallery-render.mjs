/* Gallery values supplied by publishers are escaped as text. Card URLs use validated UUIDs.
   Search is bounded plain text, HTML-escaped in the input and percent-encoded in pager URLs.
   Voting remains a real form so it also works without JavaScript. */


import { HEAD_COMMON, esc, clip, UUID, voteControl, voteTally } from './_render.mjs';
import { APP_TOPBAR, APP_FOOTER } from './_app-chrome.mjs';
import { searchText } from './_gallery-query.mjs';
import { galleryWarning } from './_gallery-card.mjs';
import { CATEGORIES, categoryLabel } from './_categories.mjs';


const SORTS = [
  { key: 'new',    label: 'Newest' },
  { key: 'top',    label: 'Most useful' },
  { key: 'copied', label: 'Most copied' }
];
const SORT_KEYS = new Set(SORTS.map(s => s.key));






const count = n => { const v = Math.trunc(Number(n)); return Number.isFinite(v) && v > 0 ? Math.min(v, Number.MAX_SAFE_INTEGER) : 0; };


const isoDay = s => (/^\d{4}-\d{2}-\d{2}/.test(String(s || '')) ? String(s).slice(0, 10) : '');


function href({ category, sort, page, search }) {
  const q = [];
  if (searchText(search)) q.push('q=' + encodeURIComponent(searchText(search)).replace(/'/g, '%27'));
  if (category && CATEGORIES.some(c => c.slug === category)) q.push('category=' + category);
  if (sort && SORT_KEYS.has(sort) && sort !== 'new') q.push('sort=' + sort);
  if (page && page > 1) q.push('page=' + count(page));

  return '/gallery' + (q.length ? '?' + q.join('&amp;') : '');
}

function controls(category, sort, search) {
  return `<form class="gallery-controls" action="/gallery" method="get">
    <div class="search-field"><label for="gallery-search">Search passports</label><input id="gallery-search" name="q" type="search" maxlength="120" placeholder="Name or purpose…" value="${esc(search)}"></div>
    <div><label for="gallery-category">Category</label><select id="gallery-category" name="category"><option value="">All categories</option>${CATEGORIES.map(c => `<option value="${c.slug}"${category === c.slug ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select></div>
    <div><label for="gallery-sort">Sort by</label><select id="gallery-sort" name="sort">${SORTS.map(s => `<option value="${s.key}"${sort === s.key ? ' selected' : ''}>${s.label}</option>`).join('')}</select></div>
    <button class="primary" type="submit">Search</button>
  </form>`;
}


function card(c, archived) {
  const id = String(c.id || '');
  if (!UUID.test(id)) return '';

  const label = categoryLabel(c.category);
  const installable = count(c.installable);
  const declared = count(c.declared_only);
  const listed = isoDay(c.listed_at);

  /* data-cat is the slug only when categoryLabel found it on the list (label is '' for
     a missing or retired slug), else "none". The cover colour in app.css keys on it, so
     an attribute value never comes from the row without passing that membership test. */
  return `      <article class="passport-entry" data-cat="${label ? c.category : 'none'}">
    <div class="passport-cover" aria-hidden="true"><img src="/assets/mark/phaeacia-mark-mono-tight.svg" width="29" height="36" alt=""><span class="cover-title">Agent<br> Passport</span>${label ? `<span class="cover-kind">${esc(label)}</span>` : ''}<div class="cover-bearer">${esc(c.title)}</div><div class="cover-rule"></div><span class="cover-bottom">Phaeacia</span></div>
    <div class="entry-content"><h2><a href="/p/${id}">${esc(c.title)}</a></h2>
    <p class="entry-description">${esc(clip(c.summary, 320))}</p>
    ${label ? `<p class="entry-category">${esc(label)}</p>` : ''}
    <dl class="entry-facts"><div><dt>Capabilities</dt><dd>${installable} installable · ${declared} declared only</dd></div><div><dt>Scope</dt><dd>${esc(c.envelope)}</dd></div></dl>
    ${galleryWarning(c) ? `<p class="gunconfirmed">${esc(galleryWarning(c))}</p>` : ''}
    <div class="entry-bottom"><a class="text-link" href="/p/${id}">Explore this agent →</a>${archived ? voteTally(c.up, c.down) : voteControl(id, c.up, c.down, true)}</div>
    <p class="gmeta">Listed ${listed}${listed ? ' · ' : ''}opened ${count(c.views)} times, copied ${count(c.copies)} times</p>
    </div></article>`;
}

function pager({ category, sort, page, pages, search }) {
  const p = Math.max(1, count(page) || 1);
  const last = Math.max(1, count(pages) || 1);
  if (last <= 1) return '';
  const prev = p > 1
    ? `<a class="gpage" href="${href({ category, sort, page: p - 1, search })}" rel="prev">Previous</a>`
    : '<span class="gpage off">Previous</span>';
  const next = p < last
    ? `<a class="gpage" href="${href({ category, sort, page: p + 1, search })}" rel="next">Next</a>`
    : '<span class="gpage off">Next</span>';
  return `<nav class="gpager" aria-label="Pages">
      ${prev}
      <span class="gpageof">Page ${p} of ${last}</span>
      ${next}
    </nav>`;
}


function empty(category, archived) {
  const label = category ? categoryLabel(category) : '';
  if (archived) {
    return `<div class="gempty">
      <p class="glede">${label ? `Nothing was listed under ${esc(label)}.` : 'Nobody listed a passport here.'}</p>
    </div>`;
  }
  return label
    ? `<div class="gempty">
      <p class="glede">Nothing here under ${esc(label)} yet.</p>
      <p><a class="textlink" href="${href({ category: null, sort: 'new', page: 1 })}">See everything in the gallery</a>, or <a class="textlink" href="/upload">publish one yourself</a>.</p>
    </div>`
    : `<div class="gempty">
      <p class="glede">Nobody has listed a passport yet.</p>
      <p><a class="textlink" href="/upload">Publish one</a> and it will be the first.</p>
    </div>`;
}


/* `archived` (lib/_archive.mjs) drops the vote controls and the invitations to
   publish; the notice is added by the caller with archivePage(). */
export function renderGallery({ cards, category, sort, page, pages, total, search, archived = false } = {}) {
  const query = searchText(search);
  const cat = CATEGORIES.some(c => c.slug === category) ? category : null;
  const srt = SORT_KEYS.has(sort) ? sort : 'new';
  const pg = Math.max(1, count(page) || 1);
  const pgs = Math.max(1, count(pages) || 1);
  const all = count(total);

  const rendered = (Array.isArray(cards) ? cards : []).map(c => card(c, archived)).filter(Boolean);
  const label = cat ? categoryLabel(cat) : '';

  const title = label ? esc(label) + ' · Gallery · Agent Passport' : 'Gallery · Agent Passport';
  const desc = 'Agent passports their owners chose to list: what each agent does, what access it ' +
    'needs, and one block to rebuild it on your own setup.';

  return `<!DOCTYPE html>
<html lang="en">
<head>
${HEAD_COMMON}
<title>${title}</title>
<meta name="description" content="${desc}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Agent Passport">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="https://app.phaeacia.ai/gallery">
<meta property="og:image" content="https://app.phaeacia.ai/assets/og/og-card.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="An Agent Passport cover: the Phaeacia mark, the document type, and two entry stamps reading granted and not granted.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="https://app.phaeacia.ai/assets/og/og-card.png">
<link rel="stylesheet" href="/assets/gallery.css">
<link rel="stylesheet" href="/assets/app.css">
</head>
<body>

<a class="skip" href="#main">Skip to content</a>

${APP_TOPBAR}
<main id="main" class="gallery-main">
<section class="intro gallery-intro"><div><h1>Find your next agent.</h1><p>Explore agents people have shared. Make one your own.</p></div>${archived ? '' : '<a class="text-link" href="/upload">Share your agent →</a>'}</section>
${controls(cat, srt, query)}
<p class="gallery-count" role="status">${all} passport${all === 1 ? '' : 's'}${query || cat ? ' found' : ''}</p>
${rendered.length ? '<div class="passport-grid">\n' + rendered.join('\n') + '\n</div>' : query ? '<div class="gempty"><h2>No passports match yet.</h2><p>Try another search or category' + (archived ? '.' : ', or share an agent of your own.') + '</p><a class="text-link" href="/gallery">Clear filters</a></div>' : empty(cat, archived)}
${pager({ category: cat, sort: srt, page: pg, pages: pgs, search: query })}
<div class="gallery-help"><p>Review what an agent needs before installing it. Passports are shared by their publishers; they are not independently verified by Phaeacia. ${archived ? 'Votes were cast by other readers while the site was open, one per browser.' : 'Votes reflect other readers’ experience, one per browser.'}</p></div>
</main>
${APP_FOOTER}

<script src="/assets/site.js"></script>
<script src="/assets/gallery.js"></script>
</body>
</html>`;
}

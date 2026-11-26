/* lib/_render.mjs: the passport page, the not-found page, and what a stranger's text cannot do to either.

   Split out of the former tools/run-tests.mjs. Shared setup (the in-memory blob double, reset(),
   GOOD, ...) is in ./_helpers.mjs, which also installs that double before any lib is exercised.
   Run just this file with: node --test tools/render.test.mjs */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GOOD,
  MESSAGES,
  parsed,
  render,
  reset,
} from './_helpers.mjs';

/* ══ rendering ════════════════════════════════════════════ */

test('the passport page renders, escapes, and shows the expiry', async () => {
  reset();
  const record = parsed();
  const html = render.renderPassport('abc', {
    ...record, body: GOOD, created_at: new Date().toISOString(),
    expires_at: '2026-09-08T10:00:00.000Z'
  }, 'https://app.phaeacia.ai');

  assert.ok(html.includes('2026-09-08'), 'the expiry must reach the page');
  assert.ok(html.includes('Link expires'));
  assert.ok(html.includes('<!doctype html>') || html.includes('<!DOCTYPE html>'));

  const opens = (html.match(/<script[\s>]/g) || []).length;
  const closes = (html.match(/<\/script>/g) || []).length;
  assert.equal(opens, closes, 'unbalanced script tags');
});

test('a passport with no expiry still renders', () => {
  const html = render.renderPassport('abc', { ...parsed(), body: GOOD }, 'https://app.phaeacia.ai');
  assert.ok(html.includes('Not set'));
});

test('hostile passport text cannot escape the page', () => {
  const record = parsed();
  record.title = '</dd><script>alert(1)</script>';
  record.summary = 'x'.repeat(40) + ' </p><img src=x onerror=alert(1)>';
  const html = render.renderPassport('abc', { ...record, body: GOOD }, 'https://app.phaeacia.ai');
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.equal(html.includes('<img src=x'), false);
});

/* ROW-144: the template used to carry its own engineering commentary as
   literal HTML comments, 13 of them, served on every passport page. Fixed by
   moving them into `${/* ... *\/''}`, an ordinary JS comment that evaluates to
   nothing. GOOD is the real example body, which carries the one `<!--` a
   passport is allowed to have (_validate.mjs's INSTALLER_PLACEHOLDER); this
   asserts the whole page, template and body together, reaches the reader with
   no HTML comment delimiter at all. A future comment added back to the
   template, or a change that stops escaping a body's own `<!--`, fails here. */
test('the rendered page carries no HTML comment, not from the template and not from the body', () => {
  const html = render.renderPassport('abc', { ...parsed(), body: GOOD }, 'https://app.phaeacia.ai');
  assert.equal(html.includes('<!--'), false, 'an HTML comment opener reached the page');
  assert.equal(html.includes('-->'), false, 'an HTML comment closer reached the page');
});

/* The three surfaces tools/run_tests.sh test 9 used to guard, ported here after
   that test was retired with the standalone page it built.

   Why it matters that these are separate from the test above: that one sets
   `title` and `summary` on an already-derived record, so it proves esc() works
   on two fields. These three reach the page by different routes. A consent cell
   goes through inline() inside the permits loop, section 4 prose goes through a
   different inline() call and its fenced blocks through esc(), and the losses
   table goes through mdTable(). Each is a stranger's Markdown, parsed out of the
   body here rather than handed in, so this exercises the real path.

   The upload gate refuses a passport containing "<img" outright, so nothing
   shaped like this can be published today. That is exactly why the test renders
   the body directly instead of validating it first: _render.mjs's own header
   says the gate is a gate and not a substitute for escaping, and "if the only
   thing standing between a stored passport and script execution is that regex,
   the design is wrong". This asserts the second line of defence, alone. */
test('hostile markup in a consent cell, section 4 prose or the losses table cannot escape', () => {
  const IMG = '<img src=x onerror=alert(1)>';
  const SCRIPT = '<script>alert(1)</script>';

  let body = GOOD
    /* a consent cell: the Why column of the first capability row */
    .replace('| Fetch news from the web | this is the briefing content |',
             `| Fetch news from the web | ${IMG} needed for the brief |`)
    /* section 4 prose, which renders above the fenced example */
    .replace('This is a synthetic example,', `${SCRIPT} This is a synthetic example,`)
    /* the losses table, which renders whenever it has a data row */
    .replace('| | | |', `| ${IMG} | lost | ${SCRIPT} |`);

  assert.ok(body.includes(IMG) && body.includes(SCRIPT), 'the payloads were not injected');

  const record = parsed();
  const html = render.renderPassport('abc', { ...record, body }, 'https://app.phaeacia.ai');

  /* Nothing arrives as markup. */
  assert.equal(html.includes(SCRIPT), false, 'a script tag reached the page');
  assert.equal(html.includes('<img src=x'), false, 'an img tag reached the page');
  assert.equal(/<img[^>]*onerror/i.test(html), false, 'an onerror handler reached the page');

  /* And it did arrive, escaped, rather than being silently dropped: a renderer
     that swallowed the row would pass the three assertions above for the wrong
     reason and hide a parsing failure behind a security test. */
  assert.ok(html.includes('&lt;img src=x'), 'the consent cell payload vanished instead of being escaped');
  assert.ok(html.includes('&lt;script&gt;'), 'the prose payload vanished instead of being escaped');
});

/* ── the attribute context, which the two tests above do not reach ─────────
   Both tests above assert the TEXT context: they weaponise `<` and `>` and
   check no element was opened. That leaves half of esc()'s contract untested.

   Measured by mutating esc() one character class at a time against this suite:

     drop < and >  ->  2 tests fail
     drop "        ->  0 tests fail, 60/60 green
     drop &        ->  0 tests fail, 60/60 green
     drop '        ->  0 tests fail, 60/60 green

   And stranger data does reach an attribute: `ogDesc` is
   `esc(clip(row.summary, 180))` and lands in `content="..."` three times. With
   the double quote unescaped the rendered head reads

     <meta property="og:description" content="xxxx... " onmouseover=alert(1) x="">

   which is an injected attribute, not escaped text.

   The severity of that specific break is low on its own, because the elements
   carrying stranger data in an attribute are all <meta> and a meta tag fires no
   handler, and `<` is still escaped so no new element can be opened. It is
   tested anyway for two reasons. The renderer is a file that changes hands, and
   the natural way to mark up a logo or an icon is `aria-label="..."` or
   `<img alt="...">`; the first such attribute carrying stranger data turns this
   from inert into live, and nothing else in the suite would say so. And a guard
   that covers three of five characters is the kind of thing a reader checks
   instead of the code.

   If this fails, esc() lost a character class. The fix is to restore it; it is
   never to loosen this test. */
test('stranger data in an attribute is escaped, not just stranger data in text', () => {
  const PAYLOAD = 'x'.repeat(30) + ' " onmouseover=alert(1) x="' + " and ' and & too";

  /* Both user-controlled values that reach an attribute, not just one.
     row.summary becomes ogDesc at :571 and row.title becomes ogTitle at :570.
     ogTitle is the sharper of the two, because it is concatenated with a
     suffix rather than clipped, so a payload survives to the end of it. */
  const record = parsed();
  record.summary = PAYLOAD;
  record.title = PAYLOAD;
  const html = render.renderPassport('abc', { ...record, body: GOOD }, 'https://app.phaeacia.ai');

  const metas = (html.match(/<meta [^>]*>/g) || []).filter(m =>
    /og:description|name="description"|twitter:description|og:title|twitter:title/.test(m));
  assert.ok(metas.length >= 5,
    `expected the three description and two title metas, found ${metas.length}`);

  for (const m of metas) {
    /* Read the attribute the way a parser does: `content="` up to the next raw
       double quote. If esc() escaped the quote, that value holds the whole
       payload and ends with the sentinel. If it did not, the value terminates
       early at the stranger's quote and everything after it is markup.

       Asserting on the captured value rather than on the presence of the string
       "onmouseover=" matters: that string appears in a correctly escaped page
       too, as inert text, so testing for it fails a page that is actually fine. */
    const v = m.match(/content="([^"]*)"/);
    assert.ok(v, 'no readable content attribute on: ' + m);
    /* `too` is the far end of the payload. It cannot be inside the attribute
       unless every quote before it was escaped. Containment rather than
       endsWith, because ogTitle appends ' · Agent Passport' after the payload
       and ogDesc does not. */
    assert.ok(v[1].includes('too'),
      'the content attribute ended early, so the stranger\'s quote closed it and the ' +
      'rest of their text is now markup: ' + m);
    assert.ok(v[1].includes('&quot;'),
      'the double quote was not escaped to &quot; on the way into an attribute: ' + m);
  }

  /* The remaining two classes, asserted on the page as a whole rather than per
     meta, because they are escaped by the same call and fail the same way. */
  assert.ok(html.includes('&#39;'), "the apostrophe is no longer escaped by esc()");
  assert.ok(html.includes('&amp;'), 'the ampersand is no longer escaped by esc()');
});

test('a link in a stranger\'s prose is shown, not clickable', () => {
  /* The other half of the phishing chain the review demonstrated: mail signed
     by this domain, landing on a page on this domain, one click from anywhere. */
  const record = parsed();
  record.summary = 'It reads the news. See [the setup guide](https://evil.example/verify) first.';
  const html = render.renderPassport('abc', { ...record, body: GOOD }, 'https://app.phaeacia.ai');

  assert.ok(html.includes('evil.example/verify'), 'the URL should still be readable');
  assert.equal(html.includes('href="https://evil.example/verify"'), false,
    'a stranger\'s link is a live anchor on our page');

  for (const href of html.match(/href="https?:[^"]+"/g) || []) {
    assert.ok(/phaeacia\.ai/.test(href), 'an outbound anchor that is not ours: ' + href);
  }
});

test('the view count on the page is the real one', () => {
  /* It was a constant for a while: views live in their own store, the renderer
     read row.views, and row.views was always undefined, so every passport page
     said "first presentation" forever while /manage reported the truth. */
  const record = parsed();
  const first = render.renderPassport('abc', { ...record, body: GOOD, views: 0 }, 'https://x');
  assert.ok(first.includes('first presentation'));

  const later = render.renderPassport('abc', { ...record, body: GOOD, views: 4 }, 'https://x');
  assert.ok(later.includes('presented 4 times before this'),
    'the renderer is not reading the view count back');
  assert.equal(later.includes('first presentation'), false);
});

test('an explicitly passed origin still reaches the social card', () => {
  /* THIS TEST PROTECTS ANOTHER REPOSITORY, which is why it is worth the lines.

     renderPassport's `origin` parameter defaults to CANONICAL, and every caller
     in THIS repo passes either the canonical string or nothing that matters. So
     deleting the parameter and hardcoding CANONICAL leaves the whole suite
     green: a critic built exactly that change and got 72/72 and 37/37.

     The caller that breaks is ~/Phaeacia/website/tools/build-samples.mjs, which
     renders this same passport for a page the MARKETING site hosts, passes
     https://phaeacia.ai, and then rewrites og:url and the card path by exact
     string match with a swap() that throws when a string moves. It is
     deliberately not in any CI and is run by hand, so that breakage would
     surface whenever someone next regenerates the samples, a long way from the
     commit that caused it.

     A reader who sees a parameter nothing in this repo depends on will simplify
     it away. This is the assertion that stops them, and it is the only thing
     standing between that reader and a cross-repo break. */
  const html = render.renderPassport('abc', { ...parsed(), body: GOOD }, 'https://example.test');
  assert.ok(html.includes('content="https://example.test/p/abc"'),
    'og:url ignored an explicitly passed origin; build-samples.mjs depends on it');
  /* ROW-169: the card is per passport now, /og/<id>.png, drawn by
     netlify/functions/og.mjs. build-samples.mjs in the website repo swaps
     this exact string to the marketing site's static copy of the generic
     card, so that swap must name `${CANON}/og/example.png` on its side. */
  assert.ok(html.includes('content="https://example.test/og/abc.png"'),
    'the card path ignored an explicitly passed origin, or is not /og/<id>.png; build-samples.mjs rewrites it');
});

test('the not-found page says nothing about which kind of absence it was', () => {
  const html = render.renderNotFound(MESSAGES.E_NOT_FOUND);
  for (const leak of ['deleted at', 'expired on', 'was created', 'existed']) {
    assert.equal(html.toLowerCase().includes(leak.toLowerCase()), false, 'leaks: ' + leak);
  }
});

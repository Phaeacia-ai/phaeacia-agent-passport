/* Passport page: the platform picker and the install block.

   The block is assembled exactly the way scripts/assemble.py does it, because
   that script's docstring says the site performs the same insertion and the two
   must stay in step: replace the placeholder line in section 5 with the
   installer core, then the judge prompt, then ONE platform branch, joined by
   blank lines. The site hands out one branch, never all four.

   Picker rules come from create-page.md section 7, and exist so v0.1 can become
   an install wizard without a rewrite: the answer lives in the URL, the answer
   is a data key rather than a label, the options come from data, choosing never
   hides the alternatives, and every branch ends with a line about what happens
   next.

   The tab pattern is the whole WAI-ARIA one or none of it. It used to carry
   role="tab" and aria-selected with no panel, no aria-controls, no roving
   tabindex and no arrow keys, which announces a widget to a screen reader and
   then does not behave like one. That is worse than plain buttons. Here: one
   tabpanel, aria-controls on every tab, aria-labelledby following the selection,
   a single tab stop in the strip, and Left, Right, Home and End moving it. */
(function () {
  'use strict';

  var PLACEHOLDER = '<!-- installer core and branches inserted on upload -->';
  var PLATFORMS = window.__PLATFORMS || [];
  /* __BODY is a JSON string literal from the renderer, not escaped element text.
     HTML entities are not decoded inside a raw text element, so reading this out
     of a <script type="text/plain"> would put a literal "&lt;" on the clipboard
     and corrupt the block being pasted into someone's assistant. */
  var body = typeof window.__BODY === 'string' ? window.__BODY : '';

  var tabs    = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var panel   = document.getElementById('platform-panel');
  var noteEl  = document.getElementById('plat-note');
  var blockEl = document.getElementById('plat-block');
  var nextEl  = document.getElementById('plat-next');
  var copyBtn = document.getElementById('copy-block');

  if (!tabs.length || !blockEl || !panel) return;

  var cache = {};
  var current = null;

  function fetchText(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + ' returned ' + r.status);
      return r.text();
    });
  }

  function assemble(key) {
    if (cache[key]) return Promise.resolve(cache[key]);
    var plat = PLATFORMS.filter(function (p) { return p.key === key; })[0];
    if (!plat) return Promise.reject(new Error('unknown platform ' + key));

    return Promise.all([
      fetchText('/assets/installer/core.md'),
      fetchText('/assets/installer/judge.md').catch(function () { return ''; }),
      fetchText('/assets/installer/branches/' + plat.file + '.md')
    ]).then(function (parts) {
      var pieces = [parts[0].replace(/\s+$/, '')];
      if (parts[1] && parts[1].trim()) pieces.push(parts[1].replace(/\s+$/, ''));
      pieces.push(parts[2].replace(/\s+$/, ''));
      var installer = pieces.join('\n\n') + '\n';
      var out = body.split(PLACEHOLDER).join(installer);
      cache[key] = out;
      return out;
    });
  }

  function select(key, push) {
    var plat = PLATFORMS.filter(function (p) { return p.key === key; })[0];
    if (!plat) return;
    current = key;

    tabs.forEach(function (t) {
      var on = t.getAttribute('data-key') === key;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;                       // one tab stop in the strip
      if (on) panel.setAttribute('aria-labelledby', t.id);
    });

    noteEl.textContent = plat.note;
    nextEl.textContent = plat.next;
    blockEl.textContent = 'Building the block for ' + plat.label + '.';
    copyBtn.disabled = true;

    if (push) {
      var url = new URL(window.location.href);
      url.searchParams.set('platform', key);
      history.replaceState(null, '', url);
    }

    assemble(key).then(function (text) {
      if (current !== key) return;                       // a later click won
      var kb = Math.round(new Blob([text]).size / 1024);
      blockEl.textContent = text;
      copyBtn.disabled = false;
      copyBtn.textContent = 'Copy block for ' + plat.label + ' (' + kb + ' KB)';
    }).catch(function () {
      if (current !== key) return;
      blockEl.textContent =
        'The installer text for this platform could not be loaded, so the block is incomplete and was not built. ' +
        'Nothing here is safe to paste yet. Reload the page, and if it keeps failing the site is missing its installer files.';
      copyBtn.disabled = true;
      copyBtn.textContent = 'Copy block';
    });
  }

  function focusTab(i) {
    var t = tabs[(i + tabs.length) % tabs.length];
    t.focus();
    select(t.getAttribute('data-key'), true);
  }

  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { select(t.getAttribute('data-key'), true); });
    t.addEventListener('keydown', function (e) {
      var k = e.key;
      if (k === 'ArrowRight' || k === 'ArrowDown') { e.preventDefault(); focusTab(i + 1); }
      else if (k === 'ArrowLeft' || k === 'ArrowUp') { e.preventDefault(); focusTab(i - 1); }
      else if (k === 'Home') { e.preventDefault(); focusTab(0); }
      else if (k === 'End') { e.preventDefault(); focusTab(tabs.length - 1); }
    });
  });

  /* ── the copy counter ───────────────────────────────────────
     One integer per passport, bumped when the copy control succeeds. It is the
     nearest honest thing to an install count and it is labelled as what it is:
     nothing in the installer text ever phones home, so a copy pasted into
     somebody's assistant is invisible to us and always will be. A copy made by
     selecting the block and pressing the keyboard is not counted either, and
     the privacy page says so rather than implying the number is complete.

     credentials: 'omit' and no body beyond the id. The vote cookie exists on
     this origin and there is no reason for this request to carry it: nothing on
     the server side of /api/copied wants to know who pressed the button, and
     sending a cookie it does not read would make that sentence untrue.

     The id comes from the path and must pass this exact test before anything is
     sent. /p/example is the repository's specimen and is not a stored passport,
     so it matches nothing here and nothing is sent for it. */
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  function countCopy() {
    var m = window.location.pathname.match(/^\/p\/([^/]+)$/);
    if (!m || !UUID.test(m[1])) return;
    try {
      fetch('/api/copied', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: m[1] }),
        keepalive: true,
        credentials: 'omit'
      }).catch(function () {});
    } catch (e) { /* a counter is never worth a broken copy button */ }
  }

  copyBtn.addEventListener('click', function () {
    var text = blockEl.textContent;
    var label = copyBtn.textContent;
    var done = function (ok) {
      if (ok) countCopy();
      copyBtn.textContent = ok ? 'Copied. Paste it into your assistant.' : 'Copy failed, select the block and copy by hand.';
      copyBtn.setAttribute('aria-live', 'polite');
      setTimeout(function () { copyBtn.textContent = label; }, 2500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else { done(false); }
  });

  var fromUrl = new URL(window.location.href).searchParams.get('platform');
  var known = PLATFORMS.some(function (p) { return p.key === fromUrl; });
  select(known ? fromUrl : PLATFORMS[0].key, false);
})();

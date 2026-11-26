/* THE CANONICAL HOST, FOR THE BROWSER, DECLARED ONCE.

   The server side reads this from lib/_site.mjs. Nothing here can import it:
   these are classic scripts, not modules, and adding a bundler for one string
   is not a trade worth making. So the browser gets its own copy, and there is
   exactly ONE of it — this line.

   site.js is loaded first on every page that needs it, including
   tools/card-demo.html, so card.js and manage.js can both read it and neither
   declares its own. card.js used to; manage.js used to build links from
   window.location.origin instead, which is the ROW-63 defect wearing a browser.
   Two builders of one link, one directory apart, disagreeing.

   run-tests.mjs asserts this literal matches lib/_site.mjs, and asserts that
   card.js and manage.js contain no host literal of their own, so the pair
   cannot drift back apart quietly.

   If site.js ever fails to load, links built from this read "undefined/p/...",
   which is visibly broken rather than quietly pointing at the wrong host. That
   is the direction to fail in. */
window.PHAEACIA_CANONICAL = 'https://app.phaeacia.ai';

/* Site chrome: the theme control and every copy button.

   The theme has three states and the third one is the default. "System" sets no
   attribute at all, so the page follows prefers-color-scheme. An explicit choice
   stamps data-theme on the root element, which is what the stylesheet's two dark
   blocks are written against. The pre-paint snippet in each page's <head> reads
   the same key, so a chosen theme never flashes. */
(function () {
  'use strict';

  var KEY = 'phaeacia-theme';
  var ORDER = ['system', 'light', 'dark'];
  /* SHORT is what the button shows: the topbar has to stay one row at 390px,
     and "Theme:" is carried by a visually hidden span in the markup instead.
     LABEL is the accessible name, so nothing is lost to a screen reader. */
  var SHORT = { system: 'Auto', light: 'Light', dark: 'Dark' };
  var LABEL = { system: 'Theme: auto', light: 'Theme: light', dark: 'Theme: dark' };

  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return ORDER.indexOf(v) >= 0 ? v : 'system';
    } catch (e) { return 'system'; }
  }

  /* APPLY DOES NOT WRITE, AND THAT SEPARATION IS THE WHOLE OF ROW-129 ITEM 2.
     It used to end with localStorage.setItem, and apply() is called once at load
     for every visitor. So merely opening any page on this site wrote
     phaeacia-theme=system into the reader's browser, whether or not they had
     ever touched the control, while privacy.html said the key is kept "only if
     you use the theme control". The page was making a promise the script broke
     on the same page load that served it.

     Persisting is now persist(), called only from the click handler. read()
     already returns 'system' for a missing key, so storing the default bought
     nothing: an absent key and a key reading "system" produce identical
     behaviour, which is why this was invisible for as long as it was.

     The obvious repair, "guard the setItem with mode !== 'system'", is wrong. It
     would still write on the first load of a reader who HAD chosen light or
     dark, and it leaves a write inside a function whose job is to paint. The
     split is what makes the sentence on privacy.html checkable.

     I FIRST WROTE HERE THAT THE TICKET WAS WRONG, AND THE TICKET WAS RIGHT.
     ROW-129 says the marketing site fixed its copy on 2026-08-18 and this one did
     not follow. I read one line saying that site's theme CONTROL was removed on
     2026-08-09, concluded there was no feature there to fix, and wrote "this is
     the only copy". A critic produced the fix I said did not exist.

     What actually happened on the other site is this same defect, one layer out.
     The control went on 2026-08-09; the generated sample page kept being built
     with a verbatim copy of THIS script, so a page with no toggle went on writing
     the key on every load until 2026-08-18, on a domain whose privacy page says
     nothing writes localStorage. It was found, verified against production, and
     fixed by stripping this block out of the copy. Both that generator and that
     privacy page say so in terms.

     So the correct reading is the opposite of the one I wrote: the marketing side
     hit this first, wrote it down, and fixed it, and the app kept the defect for
     another fortnight. And this is not the only copy: the generator emits a
     stripped version of this file for the sample page.

     The error is worth more than the correction. I checked one line about the
     control and inferred the absence of a feature, when the thing to check was
     whether the KEY was being written anywhere on that domain, which is what the
     ticket actually claimed. Reading about the thing next to your question is not
     reading about your question. */
  function apply(mode) {
    if (mode === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
      var slot = btn.querySelector('[data-theme-label]');
      if (slot) slot.textContent = SHORT[mode];
      else btn.textContent = LABEL[mode];
      btn.setAttribute('aria-label', LABEL[mode] + '. Activate to change.');
    });
  }

  function persist(mode) {
    try { localStorage.setItem(KEY, mode); } catch (e) {}
  }

  /* Reads, paints, writes nothing. */
  apply(read());

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-theme-toggle]');
    if (!btn) return;
    var next = ORDER[(ORDER.indexOf(read()) + 1) % ORDER.length];
    apply(next);
    persist(next);
  });

  /* Copy-count telemetry, opt-in via data-count-as="f" | "w" on any copy
     button (Path F today; Path W once its button ships). Every counting
     button on this page calls this from its OWN success branch, never from
     a shared click listener, because "success" means different things per
     button: [data-copy] succeeds when the clipboard write resolves,
     [data-copy-fetch] (ROW-262, not yet on this branch) succeeds only after
     both the fetch AND the clipboard write resolve, and its fallback path
     (fetch ok, clipboard blocked) shows the text for a manual copy rather
     than performing one, so it must NOT count. Counting from one shared
     listener would get that distinction wrong for whichever button did not
     write it.

     Fire-and-forget and same-origin, matching /api/copied's own shape:
     credentials omitted (nothing server-side reads one), keepalive so the
     request survives the page unloading right after a copy, and a failed
     count never surfaces to the reader or blocks the copy it describes. */
  function countCopy(btn) {
    var path = btn.getAttribute('data-count-as');
    if (!path) return;
    try {
      fetch('/api/copied-prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: path }),
        keepalive: true,
        credentials: 'omit'
      }).catch(function () {});
    } catch (e) { /* a counter is never worth a broken copy button */ }
  }

  /* Copy buttons. The label is restored afterwards, and a failure says so
     rather than pretending the clipboard was written. */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy]');
    if (!btn) return;
    var target = document.querySelector(btn.getAttribute('data-copy'));
    if (!target) return;
    var text = target.textContent;
    var label = btn.getAttribute('data-label') || btn.textContent;
    btn.setAttribute('data-label', label);
    var done = function (ok) {
      btn.textContent = ok ? 'Copied' : 'Copy failed, select it and copy by hand';
      btn.setAttribute('aria-live', 'polite');
      setTimeout(function () { btn.textContent = label; }, 2000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); countCopy(btn); }, function () { done(false); });
    } else { done(false); }
  });

  /* ROW-W-TOGGLE / ROW-262 / ROW-485 (the browser-chat capture prompt). The
     text does not live in this page: it is a same-origin file build.sh
     writes from capture/path-w-prompt.md on every build, so this never
     holds a pasted copy that goes stale the day that file changes. It is
     fetched lazily, not on page load: measured, inlining it would add
     ~10KB gzip to every /create and /index load (W is the default panel),
     for content most visitors read on demand at most, on a site whose
     whole pitch is being light enough to inspect.

     ONE FETCH, TWO TRIGGERS. Before this, only the copy button fetched, so
     a reader had no way to see the prompt before pasting it somewhere —
     the toggle exists to fix exactly that. Both the toggle (read it first)
     and the copy button (paste it somewhere) can be the FIRST thing a
     reader clicks, so the fetch is not owned by either.

     THE CACHE IS THE PROMISE, NOT THE <pre>'S TEXT, AND THAT SPLIT IS NOT
     COSMETIC. A first version cached on target.textContent plus a
     data-loaded marker, written only once a fetch resolved. A critic broke
     it: toggle-open and copy-click in the same tick both start a fetch (no
     dedup before the FIRST one's network round trip lands, so "one request
     wins" was only true once it had already finished, not once it had
     started); if the toggle's request lands SECOND and fails, its error
     handler wrote 'Could not load the prompt...' into the <pre> with no
     check that the copy's request had already landed FIRST, succeeded, and
     painted the real body. The copy still reported "Copied." — its own
     fetch had genuinely succeeded — but the shared element it and every
     future toggle-open or copy-click read from now permanently held the
     error string, which a later copy then copied verbatim, dated, while
     still reporting success. A losing branch was allowed to overwrite a
     winning one because "cached" was read off whatever text happened to be
     sitting in the DOM, which a display update and a data write are not
     the same guarantee of.

     promptFetches keys the actual in-flight/resolved Promise by URL, before
     any fetch() call, so a second trigger in the same tick reuses the first
     call's promise outright — genuinely one request, not one after the
     race is already lost. The Promise resolves to exactly one value for
     its whole life; there is no "second, losing resolution" for a later
     trigger to observe, so there is nothing left that CAN overwrite a
     success with an error. A failed fetch deletes its own cache entry, so
     the next trigger (toggle or copy) retries instead of caching a
     permanent failure. Painting the <pre> is now a side effect callers
     each do from the shared resolution, never a proxy for whether the
     fetch happened.

     The date line is computed fresh at COPY time, not baked into the
     cached body: a tab read in the morning and copied that evening must
     not paste a stale date, and the toggle's job is showing the reader
     the real content, not a preview of what a clock will later add to it. */
  var promptFetches = Object.create(null);
  function fetchPromptBody(url) {
    if (!promptFetches[url]) {
      promptFetches[url] = fetch(url, { cache: 'no-store' })
        .then(function (res) {
          if (!res.ok) throw new Error('fetch failed: ' + res.status);
          return res.text();
        })
        .then(function (body) {
          if (!body) throw new Error('empty prompt');
          return body.replace(/\s+$/, '') + '\n';
        })
        .catch(function (e) {
          delete promptFetches[url];
          throw e;
        });
    }
    return promptFetches[url];
  }

  function datedCopyText(body) {
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    var d = new Date();
    var stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    return 'Today is ' + stamp + '.\n\n' + body;
  }

  /* [data-toggle-fetch]: "Capture prompt", opens or closes the <pre> named
     by aria-controls, fetching its content (via the shared cache above) on
     first open only. aria-expanded is the single source of truth for
     open/closed; the copy handler below reads and sets it too, so the two
     controls never disagree about whether the panel is showing.

     data-loaded now marks "this <pre> currently shows the real body", set
     ONLY from a successful resolution, never from a Loading… or error
     placeholder — the distinction Finding 1 above exists because of. The
     failure branch checks it again before painting, in case the copy
     button's call to the same shared promise already resolved and painted
     the real body while this fetch was still in flight (the promise still
     rejects for a failed request either way; a second caller who started
     after a first caller's failure gets a fresh retry via
     fetchPromptBody's own delete-on-reject, not this stale rejection). */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-toggle-fetch]');
    if (!btn) return;
    var target = document.getElementById(btn.getAttribute('aria-controls'));
    if (!target) return;
    var opening = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
    target.hidden = !opening;
    if (!opening || target.hasAttribute('data-loaded')) return;
    target.textContent = 'Loading…';
    fetchPromptBody(btn.getAttribute('data-toggle-fetch')).then(function (body) {
      target.textContent = body;
      target.setAttribute('data-loaded', '1');
    }, function () {
      if (!target.hasAttribute('data-loaded')) {
        target.textContent = 'Could not load the prompt right now. Reloading the page may help.';
      }
    });
  });

  /* Copy-from-fetch buttons. Status goes into a separate element named by
     data-status, not into the button's own text: the [data-copy] handler
     above overwrites the whole button, icon included, and never restores
     the icon, which is a wart worth not repeating here.

     Two failure shapes get two different messages, on purpose: a fetch
     failure (missing build artefact, offline) has no fallback, there is
     nothing on the page yet to show, while a clipboard failure (blocked
     permission, unfocused document) has one, the text already arrived, so
     the panel named by data-fallback is opened (same element the toggle
     above controls) for the reader to select and copy by hand rather than
     left to a dead button with no route to the prompt at all.

     countCopy only fires from the actual clipboard-success branch, never
     from the fetch succeeding on its own and never from the fallback path:
     the comment on countCopy above explains why counting from a shared or
     earlier point would count a copy that did not happen. */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy-fetch]');
    if (!btn) return;
    var url = btn.getAttribute('data-copy-fetch');
    var statusEl = document.getElementById(btn.getAttribute('data-status'));
    var fallbackEl = document.getElementById(btn.getAttribute('data-fallback'));
    var toggleBtn = fallbackEl && document.querySelector('[aria-controls="' + fallbackEl.id + '"]');
    var say = function (msg) { if (statusEl) statusEl.textContent = msg; };
    /* PH-554. The confirmation has to be at the button: the status line sits
       below the setup note, 72px under the button on a phone and 94px under
       it on a laptop, and a real owner did not see it. Same word and the same
       two seconds as the [data-copy] buttons above. Only the <span> is
       rewritten, so the icon stays; textContent on the button would drop it.
       The original label is kept on the span, so a second click inside the
       two seconds cannot store "Copied" as the label to restore. */
    var labelEl = btn.querySelector('span') || btn;
    var original = labelEl.getAttribute('data-label') || labelEl.textContent;
    labelEl.setAttribute('data-label', original);
    var flashCopied = function () {
      clearTimeout(btn.copiedTimer);
      labelEl.textContent = 'Copied';
      btn.copiedTimer = setTimeout(function () { labelEl.textContent = original; }, 2000);
    };
    var openFallback = function (msg) {
      say(msg);
      if (!fallbackEl) return;
      fallbackEl.hidden = false;
      if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
    };
    say('Copying…');
    fetchPromptBody(url).then(function (body) {
      if (fallbackEl && !fallbackEl.hasAttribute('data-loaded')) {
        fallbackEl.textContent = body;
        fallbackEl.setAttribute('data-loaded', '1');
      }
      var text = datedCopyText(body);
      if (!(navigator.clipboard && navigator.clipboard.writeText)) {
        openFallback('Could not copy automatically. Select the text below and copy it yourself.');
        return;
      }
      navigator.clipboard.writeText(text).then(
        function () { say('Copied. Paste it into your chat.'); flashCopied(); countCopy(btn); },
        function () { openFallback('Could not copy automatically. Select the text below and copy it yourself.'); }
      );
    }, function () {
      say('Could not load the prompt right now. Reloading the page may help.');
    });
  });
})();

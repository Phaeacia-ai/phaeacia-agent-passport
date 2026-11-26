/* The upload, at /upload. It was step four of a wizard, then it WAS the front
   door, and since the router landed the front door is /, which links here.

   Filename kept: this file is linked from index.html and nothing else, and
   renaming it during a parallel rebuild buys nothing.

   Two rules from site/spec/create-page.md still drive most of it:
   - the client performs NO validation beyond the size ceiling. There is exactly
     one validator and it is on the server. A friendlier client-side copy would
     drift within a month and start disagreeing with the one that decides.
   - nothing in the publish flow asks who you are, because a recipient who was
     handed a link never asked for an account.

   What the rebuild changed. This page opens on the drop box, so there is no path
   chooser here any more; the capture guidance it used to reveal is prose on
   /about and needs no script. And publishing swaps the whole upload panel for the
   result rather than appending to it, because a person who has just published
   needs two things, the card and the link, and the form they have finished with
   is not one of them. It is the same document either way: the delete token
   exists only in the response to the upload, so moving to another URL would
   mean putting it in a link, in history, or in storage. */
(function () {
  'use strict';

  var MAX_BYTES = 262144; // matches upload-validation.md section 2

  /* No duration in the words. Publishing is modelled at 3 to 6 seconds with a
     tail past 8, and could drop to about 2.4 if the handler is parallelised, so
     any number written here is a promise that breaks in one direction or the
     other. "A few seconds" is true across the whole range. */
  var WAIT_MSG = 'Checking the passport on the server. This takes a few seconds.';

  var $ = function (s) { return document.querySelector(s); };

  var els = {
    front:        $('#front'),
    published:    $('#published'),
    held:         $('#held'),
    drop:         $('#drop'),
    file:         $('#file'),
    picked:       $('#picked'),
    paste:        $('#paste'),
    publish:      $('#publish'),
    errors:       $('#errors'),
    leakWarn:     $('#leak-warn'),
    leakWarnMsg:  $('#leak-warn-msg'),
    leakWarnLines: $('#leak-warn-lines'),
    leakWarnAck:  $('#leak-warn-ack'),
    writeHelp:      $('#write-help'),
    writeHelpMsg:   $('#write-help-msg'),
    writeHelpLines: $('#write-help-lines'),
    gate:         $('#gate'),
    gateOwner:    $('#gate-owner'),
    gateOwnerMsg: $('#gate-owner-msg'),
    gateOwnerAck: $('#gate-owner-ack'),
    gateWrite:      $('#gate-write'),
    gateWriteMsg:   $('#gate-write-msg'),
    gateWriteLines: $('#gate-write-lines'),
    gateWriteYes:   $('#gate-write-yes'),
    gateWriteNo:    $('#gate-write-no'),
    gateTtl:      $('#gate-ttl'),
    gateGo:       $('#gate-go'),
    gateBack:     $('#gate-back'),
    cardBox:      $('#cardbox'),
    cardMount:    $('#card-mount'),
    publishedLede: $('#published-lede'),
    ship:         $('#drop .ship'),
    landedHarbour: $('#landed-harbour'),
    waiting:      $('#waiting'),
    listBox:      $('#list-in-gallery'),
    listCatRow:   $('#list-category-row'),
    listCat:      $('#list-category'),
    listCatErr:   $('#list-category-err'),
    listed:       $('#result-listed')
  };

  /* Only the upload page has these. Anything else that loads this file does
     nothing at all rather than throwing on the first querySelector. */
  if (!els.drop || !els.publish || !els.paste) return;

  var body = null;      // the text to publish, from either input
  var source = null;    // 'file' | 'paste'

  /* ── the berth ──────────────────────────────────────────────
     The drop target is a ship, and data-berth on that one container is the only
     place its state lives. Five values: idle, over, loaded, waiting, stopped.

     Everything below is decoration over a page that is already correct. There is
     no value, no focus move and no DOM change that waits on an animation, and
     that is a rule rather than a coincidence: the one thing this route hands out
     is a delete token shown once that cannot be reissued, and putting a CSS
     animation anywhere near its delivery path would mean a browser that skipped
     the animation could cost somebody their passport. Every function here can
     fail to run, or run and be cancelled by prefers-reduced-motion, and the page
     behaves identically.

     'stopped' is the shared shape of the three ways publishing does not happen:
     a refused file, a rate limit, and the unreviewed-owner gate. The ship rocks
     backwards and stays where it is. It is deliberately not a departure, because
     the departure is the reward for the link coming back and nothing else may
     borrow it.

     State and motion are kept apart on purpose. data-berth says what the berth
     IS, and it drives the ground colour and the weight of the ink, both of which
     must hold. A rock- class says PLAY THIS ONCE, and it is removed as soon as
     it has. Driving a one-shot animation off the state attribute means
     restarting it requires flipping the state to something else and back, and
     that one frame of the wrong state starts the ink transition running the
     wrong way in full view. */
  var berth = 'idle';   // the state to return to when a drag ends

  function setBerth(state) {
    if (state !== 'over') berth = state;
    if (els.drop) els.drop.setAttribute('data-berth', state);
  }

  /* An animation already running has to be taken off and the style flushed
     before it will start again, or a second refusal after a first one plays
     nothing and the page looks like it ignored the click. */
  function rock(which) {
    if (!els.drop) return;
    els.drop.classList.remove('rock-take', 'rock-check');

    /* NOT ADDED AT ALL UNDER REDUCED MOTION, and the reason is that the class
       has no other job. ship.css suppresses the animation with
       `animation: none !important`, so animationend never fires, so the cleanup
       listener below never runs and the class stays on #drop for the rest of
       the session. Today that is invisible, because the only rule keyed on
       .rock-take is the animation itself. It is still a trap: the first person
       to add a non-animation style for .rock-take gives it permanently to
       exactly the readers who asked for less.

       This costs those readers nothing. The class only ever drove movement, and
       the guide's rule is that reduced motion gets every state and no movement.
       The state a refusal needs to convey is carried by data-berth="stopped"
       and by the error text, neither of which is touched here.

       Queried per call rather than cached, so changing the OS setting mid-
       session takes effect without a reload. */
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    void els.drop.offsetWidth;
    els.drop.classList.add(which);
  }

  if (els.drop) {
    els.drop.addEventListener('animationend', function (e) {
      if (e.target === els.ship) els.drop.classList.remove('rock-take', 'rock-check');
    });
  }

  /* ── the two inputs are one input ───────────────────────── */
  function byteLength(s) { return new TextEncoder().encode(s).length; }

  function setBody(text, from) {
    body = (text && text.trim()) ? text : null;
    source = body ? from : null;

    /* Runs before closeGate() below, which is what actually sets
       els.publish.disabled for this call: runLeakScan() has to have already
       decided whether the new body needs a tick before that computation
       reads leakGateOk(). */
    runLeakScan(body);

    var fileActive  = source === 'file';
    var pasteActive = source === 'paste';
    els.paste.disabled = fileActive;
    els.drop.classList.toggle('disabled', pasteActive);
    els.file.disabled = pasteActive;

    /* The cargo answers to the file input alone. Pasting the passport as text is
       the same publish, but nothing was ever handed to the ship, and drawing a
       file on the deck when no file exists would be the drawing telling a small
       lie about which of the two inputs is in use. */
    if (els.ship) els.ship.classList.toggle('laden', fileActive);
    if (!fileActive) setBerth('idle');

    clearErrors();
    /* A different file is a different decision. An acknowledgement given for
       one passport must not carry over to the next one dropped in. */
    closeGate();
  }

  els.paste.addEventListener('input', function () {
    /* NOT clearWriteHelp() here, on purpose, and this is the one input event
       on the page that must not clear it. The panel exists to be read WHILE
       she edits this exact textarea to remove the lines it names; a version
       that ran clearWriteHelp() inside setBody() (which this handler calls on
       every keystroke) deleted the panel and the literal lines at her first
       keystroke, i.e. the moment she started doing what it told her to do.
       Found by a critic building the exact sequence: "No", then one
       input event, then reading #write-help-lines back as empty. It clears
       instead at the two points where the input source genuinely changes:
       a fresh publish attempt (publish() calls it directly, since whatever
       the new response is, this passport's old lines no longer apply), and
       loading a different file (readFile(), below). */
    setBody(els.paste.value, 'paste');
  });

  function readFile(f) {
    if (!f) return;
    if (f.size > MAX_BYTES) {
      // The one check the client is allowed to make, to save a round trip.
      renderErrors([{
        code: 'E_TOO_LARGE',
        message: 'That file is larger than 256 KB. A passport describes an agent, it does not contain one. Trim the golden examples and try again.'
      }], false, true);
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      els.picked.hidden = false;
      els.picked.textContent = f.name + ' · ' + f.size + ' bytes';
      /* Here, immediately before the setBody() call that actually replaces
         the active body, not at the top of readFile(). A second critic built
         both failure modes of getting this wrong: cleared too early (at the
         top, before the size check) it took out a write-help panel about the
         GOOD file already loaded when an oversized second file was rejected
         and never became the body; cleared only inside setBody() (this
         function's own onload is the only file-path caller of setBody, so
         that would have been equivalent) it left a window between choosing a
         file and FileReader finishing where "No" clicked on the OLD gate
         populated the panel with the old file's lines, and nothing then
         cleared them when the new file's content landed a moment later. This
         line and the setBody() call below it run in the same synchronous
         tick, so there is no window between "the old help is gone" and "the
         new body is active." */
      clearWriteHelp();
      setBody(String(reader.result), 'file');
      /* After setBody, which sets .laden. The file is on the deck and the hull
         takes the weight, in that order. */
      setBerth('loaded');
      rock('rock-take');
    };
    reader.readAsText(f, 'utf-8');
  }

  els.file.addEventListener('change', function () { readFile(els.file.files[0]); });

  ['dragenter', 'dragover'].forEach(function (ev) {
    els.drop.addEventListener(ev, function (e) {
      e.preventDefault(); setBerth('over');
    });
  });
  /* Back to whatever it was before the drag, not to idle. Dragging a second
     file over a berth that already has one and then changing your mind must not
     unload the first. */
  ['dragleave', 'drop'].forEach(function (ev) {
    els.drop.addEventListener(ev, function (e) {
      e.preventDefault(); setBerth(berth);
    });
  });
  els.drop.addEventListener('drop', function (e) {
    /* The berth is dimmed while the paste box is in use, and base.css dims it
       with opacity alone. That was survivable when the well was a small box; the
       redesign made it the largest thing in the panel and spends its whole
       argument telling the reader this is where files go, so a drop on it was
       silently replacing the pasted body while the pasted text stayed on screen
       in the greyed-out textarea. The page showed one passport and was armed to
       publish another.

       The guard is here and not `pointer-events: none` in the CSS. That was tried
       and is worse: it makes the well transparent to hit testing, the file lands
       on an ancestor with no drop handler, and the browser default is to navigate
       to the dropped file. The user would lose the page and the pasted passport
       with it. Here the event is still ours, so it is still preventDefault-ed
       above and nothing happens at all. */
    if (els.drop.classList.contains('disabled')) return;
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
      readFile(e.dataTransfer.files[0]);
    }
  });

  /* ── error rendering, verbatim server strings ───────────── */
  function clearErrors() {
    els.errors.hidden = true;
    els.errors.textContent = '';
  }

  function renderErrors(list, internal, keepBerth) {
    /* Stop state one and two: a refused file, and a rate limit or an internal
       failure, which arrive down this same function. The ship is pulled up
       short. Nothing sails, because nothing was published.

       keepBerth is the one case where the error is not about the thing on the
       deck. Dropping an oversized file on top of a good one is refused before it
       is ever read, so the good file is still loaded, still named in #picked and
       still publishable. Marking the berth stopped there had it rocking "pulled
       up short" while holding a file that was perfectly fine and armed to go. */
    if (!keepBerth) {
      setBerth(body ? 'stopped' : 'idle');
      rock('rock-check');
    }

    els.errors.textContent = '';
    var h = document.createElement('div');
    h.className = 'eh';
    h.textContent = 'Not published.';
    els.errors.appendChild(h);

    if (internal) {
      var p = document.createElement('p');
      p.className = 'emsg';
      /* "Try again in a few minutes" used to be the whole of this, and it was
         advice that could lock the reader out. Publishing is rate limited per
         hour, and an attempt killed by the platform timeout is not refunded, so
         someone following that instruction four more times spends the hour and
         publishes nothing. The first two sentences were always true and stay.

         What replaced it does NOT say whether this particular attempt was
         charged, and that omission is deliberate: a cleanly failed publish is
         refunded and a killed one is not, the difference is invisible from here,
         and backend is changing the cause. A sentence naming the mechanism would
         have to be rewritten when it lands. A sentence about the limit is true
         before and after, which is the standing requirement on this string. */
      p.textContent = 'Something failed on our side. Your passport was not stored and nothing was published. Do not retry straight away: publishing is rate limited, and a run of quick retries can use up your hour without anything being published. Leave it a few minutes. If it keeps failing, the file is fine and we are not.';
      els.errors.appendChild(p);
      els.errors.hidden = false;
      return;
    }

    var sawSecret = false;
    list.forEach(function (err) {
      if (err.code === 'E_SECRET_FOUND') sawSecret = true;
      var m = document.createElement('p');
      m.className = 'emsg';
      m.textContent = err.message;
      els.errors.appendChild(m);
      if (err.details && err.details.length) {
        var ul = document.createElement('ul');
        err.details.forEach(function (d) {
          var li = document.createElement('li');
          li.textContent = d;
          ul.appendChild(li);
        });
        els.errors.appendChild(ul);
      }
    });

    var fixed = document.createElement('p');
    fixed.className = 'fixed';
    fixed.textContent = 'Nothing was stored. Fix the file and upload it again.';
    els.errors.appendChild(fixed);

    if (sawSecret) {
      var extra = document.createElement('p');
      extra.className = 'fixed';
      extra.textContent = 'Assume that credential is exposed and replace it. It was in a file you were about to publish.';
      els.errors.appendChild(extra);
    }
    els.errors.hidden = false;
  }

  /* ── the two gates, and one place they meet ─────────────────
     The server can refuse a browser passport for either or both of two
     reasons on the same POST: nobody confirmed the owner review, or the
     passport carries a declared-only write marker its owner never confirmed
     as real. record/proposals/row-228-refusal-code-and-payload-shape.md is
     the contract: one 409, `refusals[]` with one entry per unresolved gate
     (owner-review first, write-consent second), `refusals[0]` also spread at
     the top level so a client that reads only the top level still gets a
     coherent single-problem response when only one gate fires.

     One `.gate` element holds both questions. Each has its own sub-block,
     hidden when its gate did not fire, and its own way of being answered:
     owner-review is a checkbox (acknowledge and go), write-consent is a
     yes/no (yes arms the same Continue button; no closes the gate outright
     and hands the owner a panel of literal lines to delete, because there is
     nothing left to continue toward once she has said the row is wrong).
     Continue is enabled only once every block still open has been answered
     yes. Nothing here decides whether a gate applies or what counts as an
     answer; that is the server's job, this page only draws it. */
  var ackTicket = null;        // owner-review ticket, minted by the server, good for one publish
  var writeAckTicket = null;   // write-consent ticket, same contract, separate reason
  var writeAnswer = null;      // null | 'yes' | 'no', reset each time the gate opens
  var writeLinesPending = ''; // the literal lines for the write block currently open, for the "no" panel

  /* Every line the server names for one marker or one row, in the order it
     sent them, one per line. Literal text: this page prints it, it does not
     search the paste for it. Money suffixes are not collapsed here because
     the payload note says this response never echoes to anyone but the
     browser that uploaded the bytes. */
  function formatWriteLines(markers, rows) {
    var blocks = [];
    (markers || []).forEach(function (m) {
      if (m && m.lines && m.lines.length) blocks.push(m.lines.join('\n'));
    });
    var rowLines = (rows || []).map(function (r) { return r && r.line; }).filter(Boolean);
    if (rowLines.length) blocks.push(rowLines.join('\n'));
    return blocks.join('\n\n');
  }

  function writeButtonsReset() {
    writeAnswer = null;
    if (els.gateWriteYes) els.gateWriteYes.setAttribute('aria-pressed', 'false');
    if (els.gateWriteNo) els.gateWriteNo.setAttribute('aria-pressed', 'false');
  }

  /* The label names what Continue actually does, one clause per gate still
     open, rather than a word as generic as "Continue" on a button that is
     about to publish something. */
  function updateGateGo() {
    var ownerOpen = els.gateOwner && !els.gateOwner.hidden;
    var writeOpen = els.gateWrite && !els.gateWrite.hidden;
    var ownerOk = !ownerOpen || (els.gateOwnerAck && els.gateOwnerAck.checked);
    var writeOk = !writeOpen || writeAnswer === 'yes';

    /* source-aware, same reasoning and the same bug class as showWriteHelp()'s
       message below: a second critic found this button still reading
       "Publish it as pasted" on a file-sourced refusal, the one control she
       reads before the panel that got the source-aware fix the first time. */
    var parts = [];
    if (ownerOpen) parts.push('unreviewed');
    if (writeOpen) parts.push(source === 'file' ? 'as uploaded' : 'as pasted');
    els.gateGo.textContent = parts.length ? 'Publish it ' + parts.join(', ') : 'Publish';

    /* leakGateOk() too, found by a round-1 critic on PH-477: this button
       has its own disabled state, separate from the ordinary Publish
       button's, and nothing here read the leak warning's tick. The
       sequence that reached the server gate in the first place (a
       flagged body, ticked, refused, gate open) leaves the leak panel
       showing; unticking it while the gate is open must grey this button
       out the same way unticking gate-owner-ack already does, not just
       leave it clickable and hope publish() catches it after closeGate()
       has already thrown the refusal tickets away. */
    els.gateGo.disabled = !(ownerOk && writeOk && leakGateOk());
  }

  function openGate(refusals) {
    /* Stop state three. Same rock as a refused file, and that sameness is the
       point: from the ship's side these are one event, publishing did not
       happen. The gate below says why, in words, which is where a reason
       belongs. */
    setBerth(body ? 'stopped' : 'idle');
    rock('rock-check');

    ackTicket = null;
    writeAckTicket = null;
    writeLinesPending = '';
    if (els.gateOwner) els.gateOwner.hidden = true;
    if (els.gateWrite) els.gateWrite.hidden = true;
    writeButtonsReset();

    (refusals || []).forEach(function (r) {
      if (!r) return;
      if (r.code === 'E_OWNER_UNCONFIRMED' && els.gateOwner) {
        ackTicket = r.ack || null;
        if (els.gateOwnerMsg) els.gateOwnerMsg.textContent = r.message || '';
        if (els.gateOwnerAck) els.gateOwnerAck.checked = false;
        els.gateOwner.hidden = false;
      } else if (r.code === 'E_WRITE_UNCONFIRMED' && els.gateWrite) {
        writeAckTicket = r.ack || null;
        if (els.gateWriteMsg) els.gateWriteMsg.textContent = r.message || '';
        writeLinesPending = formatWriteLines(r.capability_markers, r.consent_rows);
        if (els.gateWriteLines) els.gateWriteLines.textContent = writeLinesPending;
        els.gateWrite.hidden = false;
      }
    });

    if (els.gateTtl) {
      els.gateTtl.textContent = 'You have 15 minutes to answer. After that this refusal expires and uploading again starts over.';
    }
    /* Pre-existing wording, made source-aware alongside the two fixes above
       rather than left as the one remaining "different file" on a page that
       can just as easily be about a paste. */
    if (els.gateBack) {
      els.gateBack.textContent = source === 'file'
        ? 'Go back and use a different file'
        : 'Go back and edit the paste instead';
    }

    updateGateGo();
    els.gate.hidden = false;
    /* The ordinary publish button goes quiet while the stop is open. Leaving it
       live would offer a way past the question that only leads back to it. */
    els.publish.disabled = true;
    els.gate.focus();
  }

  function closeGate() {
    if (!els.gate) return;
    ackTicket = null;
    writeAckTicket = null;
    writeButtonsReset();
    els.gate.hidden = true;
    if (els.gateOwnerAck) els.gateOwnerAck.checked = false;
    if (els.gateOwner) els.gateOwner.hidden = true;
    if (els.gateWrite) els.gateWrite.hidden = true;
    els.gateGo.disabled = true;
    syncPublishEnabled();
  }

  /* ── the leak warning, PH-477 ─────────────────────────────────────
     Raffael, via HAL, 2026-09-15: a capture_path: browser passport can
     carry a name, a place or a money amount the interview's own
     self-redaction missed (record/findings/unscored-series-516c57b-eight-
     runs-gave-five-passports-at-temperature-zero-flash-leaked-a-name-and-
     the-income-figure-2026-09-15.md). assets/leak-scan.js does the looking,
     entirely in this tab; nothing here calls fetch. This block only reads
     its result and draws it, so removing leak-scan.js and this block
     together removes the whole feature with nothing else to touch.

     A WARNING, NOT A REFUSAL, in the sense that means something specific:
     the two rules at the top of this file about client-side validation are
     about PUBLISHING, and are untouched. This runs before Publish is ever
     pressed, blocks nothing the server would have accepted, and the server
     still makes every real decision unchanged.

     Two things below are HAL's additions on top of what Raffael actually
     asked for (name, place, money, key), and both are separable, but NOT
     the same way. A round-1 critic (PH-477) built the wrong recipe for one
     of them and ran it to a real failure, so both recipes here are the
     ones actually tested, not the ones that looked right on paper:

       - THE EMAIL CATEGORY: delete its one entry from the DETECTORS array
         in leak-scan.js. Nothing else changes. Tested.

       - THE TICK-TO-CONFIRM GATE, i.e. "show the warning but never block
         Publish on it": delete `#leak-warn-ack` and its `<label>` from
         upload.html. That is the whole change. leakGateOk() below already
         treats a missing checkbox as "no gate, informational only" (see
         its own comment), so nothing in this file has to move. Tested.

     What does NOT work, because a critic tried it and broke the page: an
     earlier version of this comment said "delete this block and switch
     the syncPublishEnabled() call sites back to els.publish.disabled =
     !body". That block also contains renderLeakWarn() and runLeakScan(),
     which draw the panel at all, not just the gate — and setBody(), well
     outside this block, still calls runLeakScan(body). Deleting the block
     without also finding and removing that call left `runLeakScan is not
     defined` thrown on the very first paste keystroke, which aborts
     setBody() partway through and leaves Publish permanently disabled.
     There are three syncPublishEnabled() call sites, not two (closeGate(),
     above, and both branches of the fetch handler in publish(), below) —
     if the whole feature is ever actually removed, all three revert to
     `els.publish.disabled = !body`, `runLeakScan(body)` comes out of
     setBody(), and the `if (!leakGateOk()) return;` line in publish()
     comes out too. Grep this file for `leak` and `Leak` and remove
     everything the grep finds, in one pass, and re-run
     tools/leak-scan-tests.mjs (it will fail loudly, by design, if
     anything is left half-removed) before trusting the page again. */
  function leakGateOk() {
    if (!els.leakWarn || els.leakWarn.hidden) return true;
    /* No checkbox in the markup is read as "the tick was removed", not as
       "unticked": the panel becomes a read-only notice rather than a stop
       nothing can unlock. Tested directly: without this line, deleting only
       #leak-warn-ack from upload.html (and leaving this file untouched)
       left Publish permanently disabled for any capture_path: browser
       passport with a hit, with no control left on the page that could
       re-enable it. That is worse than the tick never having existed, and
       it is the one failure this line exists to rule out. */
    if (!els.leakWarnAck) return true;
    return !!els.leakWarnAck.checked;
  }

  function syncPublishEnabled() {
    /* `els.gate && !els.gate.hidden`, found by a round-2 critic (PH-477):
       openGate() explicitly disables the ordinary Publish button while the
       server's own stop is open (share.js, the comment on that line: "the
       question that only leads back to it"), and every OTHER writer of
       els.publish.disabled already ran only with the gate closed —
       closeGate() closes it first, and the two fetch handlers run before
       openGate() ever fires for that response. The leak-ack checkbox is
       the first writer that can run WHILE the gate is open (untick, retick
       while still waiting on an owner-review or write-consent answer), and
       recomputing from body+leakGateOk alone handed the button back with
       no ack ticket to send. Reproduced: paste a flagged body, tick, get
       refused, untick then retick the leak box, click Publish — a second
       POST went out with `acks:[null,null]`, which the server charges as a
       used hourly attempt and answers by resetting the owner-review tick,
       netlify/functions/upload.mjs's hourly limiter. This line is what
       makes that path re-check the gate instead of only the leak state. */
    els.publish.disabled = !body || !leakGateOk() || !!(els.gate && !els.gate.hidden);
  }

  /* A round-1 critic measured this on the real fixture set: across one
     leaking fixture and fifteen clean ones, 65 of 121 flagged lines were
     money and 50 were place, against 5 name hits and 0 key/email hits —
     money and place are where the real leak lives once in a while, but
     they are also most of the noise, and a long list sorted by line
     number buries the signal. name/key/email sort first so the categories
     that were never wrong on any clean fixture tested are the first thing
     read, not the last. */
  var CATEGORY_SORT = { name: 0, key: 1, email: 2, place: 3, money: 4 };
  function categoryRank(categories) {
    var best = 99;
    for (var i = 0; i < categories.length; i++) {
      var r = CATEGORY_SORT[categories[i]];
      if (r !== undefined && r < best) best = r;
    }
    return best;
  }

  function renderLeakWarn(result) {
    if (!els.leakWarn) return;
    var wasHidden = els.leakWarn.hidden;
    if (!result || !result.active || !result.hits.length) {
      els.leakWarn.hidden = true;
      return;
    }
    var api = window.PhaeaciaLeakScan;
    var labels = (api && api.CATEGORY_LABELS) || {};
    if (els.leakWarnMsg) {
      /* Two of these four, not one of two: a round-2 critic tried the
         "informational only" removal recipe above (delete #leak-warn-ack
         alone) and found this message still told the reader to "tick
         below" when there was nothing left to tick. els.leakWarnAck is
         read here, not assumed present, for the same reason leakGateOk()
         reads it defensively above. */
      var fixIt = source === 'file'
        ? 'Fix your file and choose it again to remove what should not be public.'
        : 'Edit the paste above to remove what should not be public.';
      var tickIt = els.leakWarnAck ? ' Or tick below to confirm these lines are meant to be public.' : '';
      els.leakWarnMsg.textContent = 'Checked in your browser only; nothing here has been sent anywhere. ' + fixIt + tickIt;
    }
    if (els.leakWarnLines) {
      /* Array#sort has been a stable sort in every engine this ships to
         since ES2019, so lines that share a rank keep the order the scan
         found them in. */
      var sorted = result.hits.slice().sort(function (a, b) {
        return categoryRank(a.categories) - categoryRank(b.categories);
      });
      els.leakWarnLines.textContent = sorted.map(function (h) {
        /* CATEGORY_SORT again, and a round-2 critic is why this one is
           here too: it ordered the LINES but not each line's own category
           list, which still printed in DETECTORS order regardless. A line
           carrying both a name and a money amount read "a place, a money
           amount, a person's name" before this. */
        var catsSorted = h.categories.slice().sort(function (a, b) { return categoryRank([a]) - categoryRank([b]); });
        var cats = catsSorted.map(function (c) { return labels[c] || c; }).join(', ');
        return h.line.trim() + '   — looks like ' + cats;
      }).join('\n');
    }
    els.leakWarn.hidden = false;
    /* Call attention to it only for a freshly chosen FILE, and only on the
       hidden -> visible edge. A paste re-renders this panel on every
       keystroke (runLeakScan runs from setBody(), which the paste 'input'
       listener calls on every one), and moving focus off the textarea on
       each keystroke would make it impossible to type into. Choosing a
       file is one discrete action already followed by its own "loaded"
       cue (rock('rock-take') in readFile()), so this gets the same
       call-attention treatment #gate and #write-help already use — a
       critic measured the file case landing entirely below the fold at
       500px wide with nothing on screen calling it out. */
    if (wasHidden && source === 'file') els.leakWarn.focus();
  }

  function runLeakScan(text) {
    if (!els.leakWarn) return;
    /* A different body is a different decision, same reasoning as the
       server gate's ack tickets just above: a tick given for one passport
       must not silently cover the next one loaded into the page. */
    if (els.leakWarnAck) els.leakWarnAck.checked = false;
    var api = window.PhaeaciaLeakScan;
    var result = (api && typeof api.scan === 'function') ? api.scan(text || '') : null;
    renderLeakWarn(result);
  }

  if (els.leakWarnAck) {
    els.leakWarnAck.addEventListener('change', function () {
      syncPublishEnabled();
      /* Both buttons, not one. #gate-go has its own disabled state,
         computed in updateGateGo() above, and syncPublishEnabled() alone
         never touches it — the exact gap a round-1 critic drove a publish
         through on PH-477. Safe to call even when the server gate has
         never opened: updateGateGo() reads els.gateOwner/els.gateWrite's
         hidden state, both hidden by default, so ownerOk and writeOk are
         already true and this only ever narrows the button on leakGateOk(). */
      updateGateGo();
    });
  }
  /* ── end of the leak warning block ─────────────────────────────── */

  function clearWriteHelp() {
    if (!els.writeHelp) return;
    els.writeHelp.hidden = true;
    if (els.writeHelpLines) els.writeHelpLines.textContent = '';
  }

  /* "No" ends the exchange rather than looping back into it: there is no
     partial accept and no strip endpoint, so the only next step is the owner
     fixing her own submission and uploading again, which is a fresh POST
     judged fresh against both gates. The lines stay on screen after the gate
     closes, because closeGate() re-enables the form and that is exactly the
     moment she needs them (see the comment on the paste 'input' listener
     above: closing the gate must not itself clear this panel, and it does
     not — only a fresh publish attempt or a newly chosen file does).

     "Your paste" is only true for one of the two inputs this page accepts.
     `source` is whichever one produced the body this refusal is about, and
     it cannot have changed since the request went out: nothing between then
     and now calls setBody(). A critic found the file-sourced case printing
     paste instructions over a disabled, unrelated paste box. */
  function showWriteHelp(lines) {
    var fileSourced = source === 'file';
    closeGate();
    /* A second critic built the case: both gates open on a file, she chooses
       an oversized second file (refused with keepBerth, the good body stays
       loaded and armed, per the comment on renderErrors' keepBerth param),
       then clicks "No" on the still-open gate. Without this, #errors keeps
       showing the size refusal about the file she did NOT pick while
       #write-help shows lines about the one she did -- two assertive live
       regions, two unrelated refusals, both headed "Not published." at once. */
    clearErrors();
    if (!els.writeHelp) return;
    if (els.writeHelpMsg) {
      els.writeHelpMsg.textContent = fileSourced
        ? 'Delete these lines from your file, save it, and choose it again. This page never edits the file for you.'
        : 'Delete these lines from your paste, then upload it again. This page never edits the paste for you.';
    }
    if (els.writeHelpLines) els.writeHelpLines.textContent = lines;
    els.writeHelp.hidden = false;
    els.writeHelp.focus();
  }

  if (els.gateOwnerAck) {
    els.gateOwnerAck.addEventListener('change', updateGateGo);
  }
  if (els.gateWriteYes) {
    els.gateWriteYes.addEventListener('click', function () {
      writeAnswer = 'yes';
      els.gateWriteYes.setAttribute('aria-pressed', 'true');
      els.gateWriteNo.setAttribute('aria-pressed', 'false');
      updateGateGo();
    });
  }
  if (els.gateWriteNo) {
    els.gateWriteNo.addEventListener('click', function () {
      showWriteHelp(writeLinesPending);
    });
  }
  if (els.gateGo) {
    els.gateGo.addEventListener('click', function () {
      if (els.gateGo.disabled) return;
      /* THE CATEGORY IS CHECKED BEFORE THE GATE CLOSES, because closing it
         forgets the tickets. The gate stays live while the stop is open, so a
         reader can answer it, leave the select alone, and press Continue;
         with the check inside publish() alone, closeGate() had already
         nulled the tickets by the time publish() refused, no request went
         out, the gate was gone, and the next Publish sent no ack at all,
         which the server refuses and charges as a failure before minting a
         fresh ticket. Found by a critic driving exactly that sequence on the
         single-gate version. Here the refusal leaves the gate and both
         tickets standing. */
      if (categoryMissing()) return;
      var tickets = { owner: ackTicket, write: writeAckTicket };
      closeGate();
      publish(tickets);
    });
  }

  /* ── listing in the gallery ─────────────────────────────────
     The select is in the markup and starts hidden. `required` is set and cleared
     with the visibility rather than left in the HTML: there is no form submit on
     this page, so the attribute buys nothing on its own, and an attribute on a
     hidden control is a validity failure a browser cannot show the user.

     The refusal below is here and NOT a substitute for the server's. The server
     answers a list header with no valid category with 422 E_CATEGORY and the
     existing error display shows it like any other refusal. This one exists so
     that the common case, ticking the box and forgetting the select, does not
     cost a round trip to be told. */
  function listWanted() { return !!(els.listBox && els.listBox.checked); }
  function listCategory() { return els.listCat ? String(els.listCat.value || '') : ''; }
  /* The one refusal this page makes on its own: the box is ticked and the
     select is blank. It prints beside the select and NOT through renderErrors,
     which is the file's verdict: it pulls the ship up short and closes with
     "Fix the file and upload it again", and a reader who obeyed that after a
     blank category re-pasted a file that was fine, which ran setBody, which ran
     closeGate, which nulled the owner-review ticket the guard above exists to
     keep. The critic drove it. Nothing about the file is wrong here, so nothing
     about the file is said, the berth is left alone, and the message sits
     where the focus goes rather than 500px above it on a phone. */
  function categoryMissing() {
    if (!(listWanted() && !listCategory())) return false;
    if (els.listCatErr) {
      els.listCatErr.textContent = 'Pick what this agent is for, or untick the box to publish it unlisted.';
      els.listCatErr.hidden = false;
    }
    if (els.listCat) els.listCat.focus();
    return true;
  }
  function clearCategoryError() {
    if (els.listCatErr) { els.listCatErr.hidden = true; els.listCatErr.textContent = ''; }
  }
  if (els.listCat) els.listCat.addEventListener('change', clearCategoryError);

  if (els.listBox && els.listCatRow) {
    els.listBox.addEventListener('change', function () {
      var on = els.listBox.checked;
      els.listCatRow.hidden = !on;
      clearCategoryError();
      if (els.listCat) {
        if (on) els.listCat.setAttribute('required', 'required');
        else els.listCat.removeAttribute('required');
      }
      if (on && els.listCat) els.listCat.focus();
    });
  }

  /* ── publish ────────────────────────────────────────────── */
  function publish(tickets) {
    if (!body) return;

    if (categoryMissing()) return;

    /* Both real entry points (the ordinary Publish click and #gate-go)
       are disabled at the source now — syncPublishEnabled() and
       updateGateGo() both read leakGateOk(), and the leak warning's own
       ack checkbox change handler refreshes both. This check should
       therefore be unreachable through the page; it stays as the one
       place both buttons funnel through, because a round-1 critic
       (PH-477) found #gate-go publishing a still-flagged body with the
       tick withdrawn when this function was the ONLY thing that ever
       checked leakGateOk(), and a defence that lives in one place a
       future change cannot route around beats one that lives in two
       buttons a future change can forget to update in step. */
    if (!leakGateOk()) {
      if (els.leakWarn) { els.leakWarn.hidden = false; els.leakWarn.focus(); }
      return;
    }

    if (byteLength(body) > MAX_BYTES) {
      renderErrors([{
        code: 'E_TOO_LARGE',
        message: 'That file is larger than 256 KB. A passport describes an agent, it does not contain one. Trim the golden examples and try again.'
      }]);
      return;
    }

    clearErrors();
    clearWriteHelp();
    els.publish.disabled = true;
    els.publish.textContent = 'Checking';
    els.paste.readOnly = true;   // read-only, not hidden: you can still see what you sent

    /* THE WAIT, and the first thing to say about it is that NO SUCCESSFUL PUBLISH
       HAS EVER BEEN TIMED AGAINST PRODUCTION. The permission guard blocked the
       POST and nobody routed around it, correctly. Everything below past the
       seventh round trip is a model, not a measurement, and if you are reading
       this because the timing feels wrong, that is the reason.

       The model WAS 3 to 6 seconds with a visible tail past 8, from 14 sequential
       store round trips, and it is stale as of 2026-08-15: the sweep left this
       path and took most of those round trips with it. Do not quote the figures
       in this paragraph. The reasoning below still holds and is the reason the
       replacement will also be a range rather than a number; see the retraction
       further down. An earlier version of this note said "about four
       seconds, 8 per cent spread, flat" on the reasoning that summing 14 draws
       averages the noise out. That was withdrawn: routes making ZERO store calls
       still run 180 to 354ms warm and 1000 to 1760ms cold, so the variance is
       common-mode per invocation and passes straight through the sum instead of
       shrinking with depth. The slow ones are not rare, and the first publish
       after a quiet period is exactly the cold one.

       ONE ordering is load-bearing: metrics are written before the passport, so
       a dying function loses a metric rather than a publish.

       A second one used to be, and its removal is why the numbers above are now
       stale. The sweep ran ahead of the write so a timeout could not strand an
       undeletable passport. It left this path on 2026-08-15 when the sweep became
       a scheduled function; see netlify/functions/sweep.mjs. That is also where
       most of the round trips went, and most of the tail: every row of the spread
       behind the 14 figure was sweep work, from 14.2 on clean stores to 74.2 with
       twenty expired, so with the sweep gone the count is smaller and the long
       tail is largely gone with it.

       THE ROUND-TRIP COUNT AND THE RANGE BELOW ARE A MEASUREMENT THIS COMMENT NO
       LONGER HAS. <<< replace with web-backend's re-measured figure for the
       upload path before quoting either anywhere >>>

       AND DO NOT SHORTCUT TO 14.2. The obvious move is to take the "clean
       stores, 0 expired" row as the sweepless one. It is not: with clean stores
       the sweep still runs its four scans and only skips the deletes, so 14.2 is
       publish plus four list round trips, not publish alone. web-backend
       confirmed this on 2026-08-15 and confirmed the source table records only
       totals per scenario, with no line splitting sweep work from publish work.
       There is no arithmetic that converts the old number into the new one. It
       has to be measured.

       AND WHATEVER NUMBER ARRIVES, THIS CAVEAT TRAVELS WITH IT, because the
       source finding says so in terms: the 310ms per operation behind any
       seconds figure was measured on a missing `get` and applied to `list`,
       `delete` and `set` with no evidence. That was already missing from this
       comment before the sweep moved, and it does not go away when the
       round-trip count is re-measured; it is a separate unknown sitting under
       any seconds figure this note ever quotes.

       So this is still built for an UNKNOWN wait, because per-invocation variance
       remains whatever the depth: routes making zero store calls run 180 to 354ms
       warm and 1000 to 1760ms cold, and the first publish after a quiet period is
       the cold one. What changed is the width of the range, not its existence.
       The old upper bound of about ten seconds was mostly sweep and should not be
       quoted until it is re-measured. That is why the ship works but does not
       leave and why the loop has no end state. Nothing on this page knows how
       far along the server is; a motion that visibly progressed, or a bar timed to
       an average, would claim a progress it cannot measure and would be wrong at
       both ends of that range. A loop is right at the short end and right at the long one, whatever
       the long one now is. The
       departure stays the reward for the link actually coming back, so the one
       thing this must never do is look like the beginning of one.

       Entered twice on the owner-review path, with a human decision in between:
       POST, wait, gate opens, acknowledgement, POST, wait. It is set here rather
       than at the click for exactly that reason. */
    setBerth(body ? 'waiting' : 'idle');
    if (els.waiting) els.waiting.textContent = WAIT_MSG;

    var headers = { 'Content-Type': 'text/markdown; charset=utf-8' };
    /* The tickets are the server's own refusals handed back to it, one header
       per gate, each checked against its own `reason` so a ticket minted by
       one cannot satisfy the other (record/proposals/row-228-...md, Q5).
       There is no fixed word to send: a client that never saw the refusal has
       nothing to put here, and a client that saw only one gate fire sends
       only that one header. */
    if (tickets && tickets.owner) headers['X-Passport-Owner-Ack'] = tickets.owner;
    if (tickets && tickets.write) headers['X-Passport-Write-Ack'] = tickets.write;

    /* THE TWO LISTING HEADERS ARE SET HERE, INSIDE publish(), AND THAT IS THE
       POINT. The owner-review path calls publish(tickets) a second time after a
       409. A version of this that read the checkbox at the
       click and passed the result down would drop the headers on that retry, and
       an owner who ticked the box would publish unlisted with nothing telling
       them. The endpoint test named "unreviewed and listed" is exactly that
       case. Read the controls here, on every attempt. */
    if (listWanted() && listCategory()) {
      headers['X-Passport-List'] = '1';
      headers['X-Passport-Category'] = listCategory();
    }

    fetch('/api/upload', { method: 'POST', headers: headers, body: body })
      .then(function (r) {
        return r.json().then(function (j) { return { status: r.status, json: j }; });
      })
      .then(function (res) {
        els.publish.textContent = 'Publish this passport';
        syncPublishEnabled();
        els.paste.readOnly = false;
        if (els.waiting) els.waiting.textContent = '';

        if (res.json && res.json.ok) return succeed(res.json);

        /* PH-518. A hold is a 202 with ok:false, code E_HELD and status 'hold'
           (upload.mjs). It is NOT a refusal and must not reach renderErrors:
           that path ends every list with "Nothing was stored. Fix the file and
           upload it again", which is false for a held upload (its text is kept
           for the hold's lifetime) and tells the owner to do something that
           would only queue a second hold. The code AND the status are both
           read, so a future refusal that reuses one word cannot draw this
           screen. hold_id and hold_token are optional here: a hold with no
           ids still happened, so the screen still draws, without the address
           box, rather than telling the owner it was refused. */
        if (res.json && res.json.code === 'E_HELD' && res.json.status === 'hold') return showHeld(res.json);

        if (res.json && (res.json.code === 'E_OWNER_UNCONFIRMED' || res.json.code === 'E_WRITE_UNCONFIRMED')) {
          /* `refusals[]` carries one entry per gate that is still unresolved,
             owner-review first; `refusals[0]` is also the top-level code and
             message, so a response with only one gate still has a one-entry
             array here. re-disables publish, after the reset above. */
          var refusals = (res.json.refusals && res.json.refusals.length) ? res.json.refusals : [res.json];

          /* Every entry has to be a gate this page can draw and answer, or
             none of them are. A critic built the failure mode: one entry this
             page does not recognise opens `.gate` with every sub-block
             hidden, nothing to tick or click, and Continue enabled anyway,
             because updateGateGo() reads "no block is open" as "everything is
             answered." That is a silent loop with no way out, not a smaller
             version of the real gate. Falling back to the plain error list
             at least shows the server's own words and never claims a
             passport can go out when this page has no ack to send for it. */
          var allKnown = refusals.every(function (r) {
            return r && (r.code === 'E_OWNER_UNCONFIRMED' || r.code === 'E_WRITE_UNCONFIRMED');
          });
          if (allKnown) return openGate(refusals);
          return renderErrors(refusals.map(function (r) {
            return { code: (r && r.code) || 'E_INTERNAL', message: (r && r.message) || '' };
          }));
        }

        if (res.json && res.json.code === 'E_INTERNAL') return renderErrors([], true);

        var list = (res.json && res.json.errors) ? res.json.errors
                 : (res.json && res.json.code)   ? [res.json]
                 : [{ code: 'E_INTERNAL', message: '' }];
        if (list.length === 1 && list[0].code === 'E_INTERNAL') return renderErrors([], true);
        renderErrors(list);
      })
      .catch(function () {
        els.publish.textContent = 'Publish this passport';
        syncPublishEnabled();
        els.paste.readOnly = false;
        if (els.waiting) els.waiting.textContent = '';
        renderErrors([], true);
      });
  }

  els.publish.addEventListener('click', function () { publish(null); });

  function words(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }

  /* ── the card ───────────────────────────────────────────────
     assets/card.js owns the drawing and this owns the call site. The contract
     is one function: PassportCard.render(mountEl, data) resolves to an object
     with a canvas and a download(filename), and that module draws its own
     download and copy controls beside the card, so this page adds none.
     Anything else, including the file not being there at all, hides the mount
     and leaves the link and the send box doing the work. A success screen
     missing its card is a smaller failure than one that lies about drawing it. */
  /* With no card there is one thing on this screen, not two, and the line at
     the top of it has to stop saying two. */
  function hideCard() {
    if (els.cardBox) els.cardBox.hidden = true;
    if (els.publishedLede) {
      els.publishedLede.textContent =
        'Here is the link to send to whoever is installing the agent. The card of this passport did not draw, which changes nothing about the passport itself.';
    }
  }

  function drawCard(data) {
    if (!els.cardBox || !els.cardMount) return;
    var api = window.PassportCard;
    if (!api || typeof api.render !== 'function') return hideCard();

    var p = data.passport || {};
    var payload = {
      title:           data.title || '',
      name:            p.name || '',
      created:         p.created || '',
      envelope:        p.envelope || '',
      capture_path:    p.capture_path || '',
      url:             data.url || '',
      id:              data.id || '',
      capabilities:    p.capabilities || [],
      installable:     p.installable || 0,
      /* declared_only, not declared. The endpoint renamed it because this site
         uses "declared" for two different quantities one line apart: the
         passport page's permit note reads "5 declared, 4 installable, 1 declared
         only", where the bare word is the total and the qualified one is its
         complement. Both of these are only a fallback: card.js counts the rows
         in `capabilities` whenever there are any, so these numbers carry
         information exactly once, when that array is empty. */
      declared_only:   p.declared_only || 0,
      owner_confirmed: p.owner_confirmed === true,
      /* The machine-readable strip on the card encodes these three, and an
         absent one prints as `<` fill. passport_version is in the upload
         response today, so leaving it out was printing V<< on the real
         success screen while the demo harness, which passes it, printed V01.
         validated_at and losses are not in the response yet; they are passed
         through so that the day the server returns them the strip converges
         on the one the passport page prints, with no second change here. */
      passport_version: p.passport_version || '',
      validated_at:     p.validated_at || '',
      losses:           p.losses
    };

    var out;
    try { out = api.render(els.cardMount, payload); }
    catch (e) { return hideCard(); }
    if (!out || typeof out.then !== 'function') return hideCard();

    out.then(function (card) {
      if (!card || !card.canvas) hideCard();
    }, function () { hideCard(); });
  }

  /* ── the result ─────────────────────────────────────────── */
  /* THE SHIP CHANGES ENDS OF THE PAGE.

     The same node, moved. One ship with one identity, which is the whole of the
     reading: it is not two ships crossfading and it is not a copy.

     Synchronous, and first, and that ordering is the load-bearing part. The
     obvious build is to sail the ship out of the upload panel, wait for
     animationend, then swap the panels. That puts a CSS animation on the
     delivery path of a delete token that is shown once and cannot be reissued,
     and it puts it on the delivery path of the focus move at the bottom of
     succeed() as well: els.front.hidden fires, focus drops to <body>, and a
     screen reader user who just pressed the only button on the page is told
     nothing until the animation decides to end. A ceiling bounds the token. It
     does not fix the silence, because half a second of nothing after a button
     press is already the failure.

     So there is no departure. The move happens in the same frame as everything
     else in succeed(), and the only motion is the ARRIVAL, which runs on top of
     a DOM that is already finished and correct. If it never runs, the ship is
     simply there. That trade is real and it cost the departure half of the
     animation; it bought a success screen where nothing a user needs is behind
     a keyframe. */
  function sailHome() {
    try {
      if (!els.ship || !els.landedHarbour) return;

      /* THE SHIP THAT WAS NEVER THERE.

         Below 640 the berth has no ship: there is no drag and drop on a phone, so
         it is not a container down there. CSS hides both ends, which is enough
         until the window changes width. Publish at 390, rotate the phone to
         landscape, and landscape on any current handset is wider than 640: the
         media query stops applying, #landed-harbour becomes display:block, and a
         ship the user has never seen sails in on the success screen with the
         arrival animation playing, because the node was inserted while its
         container was display:none and the animation starts when it is first
         rendered. Reproduced, screenshotted, and the reverse case is clean.

         A CSS rule cannot express "was it there when it mattered", so this is the
         one place the JavaScript has to know about the breakpoint. If the ship is
         not rendered at the moment of publishing, it does not travel, it is
         DELETED. Nothing to reveal later at any width. */
      /* The berth is empty and #front is about to be hidden, so this changes
         nothing on screen. It is here so the attribute never outlives the thing
         it describes: a berth left reading "waiting" after the ship has gone is
         a lie waiting for the next person to read this file.

         IT RUNS BEFORE THE BRANCH, and that is a fix rather than a tidy-up. It
         used to sit after the appendChild, which the early return below skips,
         so every publish narrow enough to delete the ship left #drop reading
         data-berth="waiting" for a berth whose ship no longer exists in the
         document at all. The one path where the thing is most definitively gone
         was the one path that kept the attribute describing it, and the comment
         above was wrong about its own code on exactly the case it names. Caught
         by a critic reading the state off the DOM after a stubbed publish, at
         390 and 640, which is a place no screenshot looks. */
      setBerth('idle');

      if (!els.ship.getClientRects().length) {
        els.ship.remove();
        els.ship = null;
        return;
      }

      els.landedHarbour.appendChild(els.ship);
    } catch (e) { /* the ship is decoration; it never takes the page down */ }
  }

  /* The held screen. Same shape as succeed(): the upload panel goes, one
     result stays, focus moves to it, the page returns to the top. */
  function showHeld(data) {
    /* A page without the #held section (an old cached upload.html against a
       new script) still has to say the true thing, and the server's own
       message is true: it says the passport was not published and was set
       aside. Checked before the panel is hidden, so the form is not lost. */
    if (!els.held) return renderErrors([{ code: 'E_HELD', message: (data && data.message) || '' }]);
    closeGate();
    sailHome();
    if (els.front) els.front.hidden = true;
    els.held.hidden = false;

    /* The lifetime is the server's number, not a constant here: the 5 days is
       HOLD_TTL_DAYS in _store.mjs and it is the one number on this screen that
       could move. Anything that is not a small positive integer leaves the
       markup's own default rather than printing "undefined" or "NaN". */
    var days = data && data.hold_ttl_days;
    var daysEl = $('#held-days');
    if (daysEl && typeof days === 'number' && days >= 1 && days <= 90 && days === Math.floor(days)) {
      daysEl.textContent = String(days);
    }

    var box = els.held.querySelector('[data-holdbox]');
    var noAddress = els.held.querySelector('[data-hold-noaddress]');
    var haveIds = data && typeof data.hold_id === 'string' && typeof data.hold_token === 'string' &&
                  data.hold_id && data.hold_token;
    if (haveIds && window.PassportHold && box) {
      window.PassportHold.attach(box, data.hold_id, data.hold_token);
    } else {
      /* No way to attach an address: say so, rather than leave a box that
         cannot work or a screen that promises a way to hear back. */
      if (box) box.hidden = true;
      if (noAddress) noAddress.hidden = false;
    }

    document.title = 'Held for a person to look at · Agent Passport';
    els.held.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  function succeed(data) {
    /* The upload panel goes away. A second publish is a fresh page load, and the
       form that has already run is not one of the two things this screen is
       allowed to show. */
    closeGate();
    sailHome();
    if (els.front) els.front.hidden = true;
    els.published.hidden = false;

    $('#result-url').textContent = data.url;
    $('#result-token').textContent = data.delete_token;
    $('#result-open').setAttribute('href', data.url);

    /* The management link carries the token in the fragment, which browsers do
       not send to a server. It is still the token, so the page says so beside
       it rather than presenting it as an ordinary link. */
    if (data.manage_url) $('#result-manage').setAttribute('href', data.manage_url);

    var cap = $('#result-life-cap');
    if (cap) {
      /* The listed branch is first because a listed passport has no expires_at
         and the old code blanked the caption for exactly that shape, which would
         leave the one passport whose lifetime is unusual as the one with nothing
         said about it. */
      cap.textContent = data.listed
        ? 'Listed in the gallery, does not expire. It stays up until you delete it or unlist it from ' +
          'the management link.'
        : data.expires_at
        ? 'This passport comes down by itself on ' + words(data.expires_at) + ', ' +
          (data.ttl_days || 30) + ' days from now, unless you renew it from the management link. ' +
          'Expiring by default is the privacy story: a link nobody renewed stops working.'
        : '';
    }

    if (els.listed) els.listed.hidden = !data.listed;

    drawCard(data);

    /* TITLE, FOCUS AND SCROLL GO HERE, ABOVE THE TWO MODULE CALLS BELOW, and the
       reason is the same rule that took the animation off this path.

       They used to be last, underneath PassportSend.attach and
       PassportSubscribe.attach. Neither is wrapped, so a throw in either one
       skips both: injecting a thrower into attach() leaves the token, the link
       and the manage href all correctly delivered, and the title unchanged with
       focus on <body>. Reading send.js and subscribe.js I could not find a real
       way to make either throw, so this was a hazard rather than a live bug. It
       is still the exact shape I claimed to have removed: the one thing that
       tells a keyboard or screen reader user the page changed, sitting behind
       two calls into modules this file does not own. Moving it up costs nothing.

       Focus is before the scroll. focus() on a tabindex="-1" element scrolls it
       into view, so focusing after scrolling put the page back 69px down with the
       topbar off screen. preventScroll stops the browser moving anything, then
       the scroll puts the header back at the top.

       The section carries the focus rather than its heading: it is labelled by
       that heading, and a 780px outline drawn round a headline reads as a
       rendering fault to everybody who can see it. */
    document.title = 'Published · Agent Passport';
    els.published.focus({ preventScroll: true });
    window.scrollTo(0, 0);

    /* The send box only exists once there is something to send, and only if
       this deployment can send at all; send.js asks and hides itself if not. */
    if (window.PassportSend) {
      window.PassportSend.attach(document.querySelector('[data-sendbox]'), data.id, data.delete_token);
    }

    /* Same shape, separate box. It asks its own endpoint whether it can work
       and stays hidden if not, so a deployment without a list configured shows
       no trace of one. */
    if (window.PassportSubscribe) {
      window.PassportSubscribe.attach(
        document.querySelector('[data-subbox] .sendbox'), data.id, data.delete_token);
    }
  }
})();

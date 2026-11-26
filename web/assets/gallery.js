/* Voting, on /gallery and on a listed passport page.

   THIS FILE IS AN ENHANCEMENT AND NOTHING DEPENDS ON IT. The vote control is a
   real form with a real action, and /api/vote answers a form post with a 303
   back to the page it came from. With this script off, or failing to load, or
   throwing, voting still works; it costs a page load. That is the whole reason
   the control is a form rather than a button with a click handler, and it is
   worth restating because "add a fetch" is the obvious change that would quietly
   remove it: the passport page already works without script, and a vote control
   that silently did nothing would be the first element on this site that fails
   closed.

   What the script buys is the count updating in place, and knowing which way you
   voted. The cookie is HttpOnly, so nothing here can read it; `yours` is learned
   from the POST response and from nowhere else, which is why a fresh page load
   never shows a pressed button.

   NEVER BUILD A URL FROM A RESPONSE FIELD. The endpoint returns counts and
   `yours` and nothing this file navigates to. The form's action is the literal
   path in the markup. */
(function () {
  'use strict';

  var forms = document.querySelectorAll('form.vote');
  if (!forms.length || !window.fetch) return;

  Array.prototype.forEach.call(forms, function (form) {
    var idField = form.querySelector('input[name="id"]');
    var upBtn   = form.querySelector('button[value="up"]');
    var downBtn = form.querySelector('button[value="down"]');
    var upNum   = form.querySelector('[data-up]');
    var downNum = form.querySelector('[data-down]');
    var status  = form.querySelector('[data-vote-status]');
    if (!idField || !upBtn || !downBtn || !upNum || !downNum || !status) return;

    var id = idField.value;
    var yours = null;   // 'up', 'down' or null. Only a POST response sets it.
    var busy = false;

    /* A missing or unreadable response does not tell us whether the write
       happened. Keep the last known counts and report uncertainty in visible,
       politely announced text, rather than making a claim in a tooltip. */
    var uncertain = 'We could not confirm whether your vote was counted.';
    function trouble(msg) {
      status.textContent = msg;
      form.classList.add('vote-failed');
    }
    function clearTrouble() {
      form.classList.remove('vote-failed');
    }

    function paint() {
      upBtn.setAttribute('aria-pressed', String(yours === 'up'));
      downBtn.setAttribute('aria-pressed', String(yours === 'down'));
    }

    function send(dir) {
      busy = true;
      clearTrouble();
      status.textContent = 'Saving your vote...';
      Promise.resolve().then(function () { return fetch('/api/vote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: id, dir: dir }),
        credentials: 'same-origin'
      }); })
        .then(function (r) {
          return r.json().then(function (j) { return { status: r.status, json: j }; });
        })
        .then(function (res) {
          busy = false;
          var j = res.json;
          if (!j || j.ok !== true || res.status < 200 || res.status >= 300) {
            trouble(res.status === 429 && j && j.ok === false
              ? 'Too many votes from this network in the last hour. Nothing was counted.'
              : uncertain);
            return;
          }
          /* Validate every field painted. In particular, coercing null into
             zero would replace a real count with a number nobody returned. */
          var num = function (v) {
            return typeof v === 'number' && isFinite(v) && v >= 0 &&
              Math.floor(v) === v && v <= 9007199254740991;
          };
          if (!num(j.up) || !num(j.down) ||
              (j.yours !== 'up' && j.yours !== 'down' && j.yours !== null)) {
            trouble(uncertain);
            return;
          }
          upNum.textContent = String(j.up);
          downNum.textContent = String(j.down);
          yours = j.yours;
          paint();
          status.textContent = yours === null ? 'Vote removed.' : 'Vote recorded.';
        })
        .catch(function () {
          busy = false;
          trouble(uncertain);
        });
    }

    form.addEventListener('submit', function (e) {
      /* submitter is the button that was pressed. Two cases fall through to the
         server rather than being guessed at here: a keyboard Enter inside the
         form, which names no direction, and a browser old enough not to
         implement submitter at all. Both then get the 303 path, which is the
         same answer with a page load, and picking a default here would cast a
         vote nobody asked for. */
      var pressed = e.submitter;
      if (pressed !== upBtn && pressed !== downBtn) return;
      /* A THIRD CASE THAT MUST FALL THROUGH: a request is already in flight.
         This check was inside send(), AFTER preventDefault, and it returned
         without sending anything and without saying anything. Two clicks in one
         task produced one POST, which I measured and read as the page and the
         server agreeing. The state that shows what it really costs is a request
         that never settles: `busy` then stays true forever, and every later
         click is swallowed in silence. Measured against a stub that accepts the
         POST and never answers: one request logged, then three more clicks,
         then still one request, the counts unmoved, no title and no
         .vote-failed. With the script off, all four clicks would have voted.

         So the guard belongs here, before preventDefault, where declining to
         handle the event hands it to the form. Falling through casts `dir`
         rather than toggling to 'none', because the plain form has no toggle;
         that is exactly the scriptless behaviour, which is the contract this
         file is held to, and it is what the button the reader pressed says. */
      if (busy) return;
      e.preventDefault();
      var dir = pressed === upBtn ? 'up' : 'down';
      /* Pressing the direction you already voted clears the vote rather than
         casting it again, which is what the button being pressed means. */
      send(yours === dir ? 'none' : dir);
    });
  });
})();

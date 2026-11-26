/* The optional address box on the held screen (PH-518).

   Mirrors assets/subscribe.js, with three differences that each have a reason.

   1. NO CONSENT CHECKBOX. subscribe.js keeps an address for a list, so consent
      is its lawful basis and the button waits for the tick. This address is
      kept for one message about this one upload and then deleted; typing it
      and pressing the button is the act, and the sentence above the button
      says what it is used for. The endpoint has no consent field to send.

   2. NO PROBE BEFORE DRAWING. subscribe.js asks its endpoint whether it can
      work and hides the box if not. /api/hold-email answers POST only, and a
      held screen only exists on a deployment that holds, so the box is drawn.

   3. THE ENDPOINT'S OWN "incomplete link" MESSAGE IS NOT SHOWN. The server says
      "That link is incomplete, or the hold is gone. Check that you pasted the
      whole link." An owner on this screen pasted nothing and was given no link,
      so that sentence points at something they never had. The client says what
      the server actually means by that code instead: the hold is gone.

   A failure here never reads as a failure of the upload: the passport was held
   whether or not this box works, and the screen says so. */
(function () {
  'use strict';

  var api = '/api/hold-email';

  var GONE = 'We could not save that address. The hold may already have been decided or may have ' +
             'run out. Your passport is not affected by this.';
  var GENERIC = 'That did not go through. Your passport is still being held; only saving the address failed.';

  function attach(box, holdId, holdToken) {
    if (!box) return;

    var email = box.querySelector('[data-hold-email]');
    var btn = box.querySelector('[data-hold-btn]');
    var errors = box.querySelector('[data-hold-errors]');
    var done = box.querySelector('[data-hold-done]');
    if (!email || !btn) return;

    function ready() {
      /* Deliberately loose, for the reason subscribe.js gives: the endpoint
         owns the real check. */
      btn.disabled = !(email.value.trim().length > 3);
    }
    email.addEventListener('input', ready);
    ready();

    function fail(message) {
      if (!errors) return;
      errors.hidden = false;
      errors.textContent = '';
      var p = document.createElement('p');
      /* textContent, never innerHTML: a server string, and this site holds that
         line everywhere. */
      p.textContent = message;
      errors.appendChild(p);
    }

    btn.addEventListener('click', function () {
      if (errors) { errors.hidden = true; errors.textContent = ''; }
      btn.disabled = true;
      var label = btn.textContent;
      btn.textContent = 'Saving';

      fetch(api, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hold_id: holdId, hold_token: holdToken, email: email.value.trim()
        })
      }).then(function (r) {
        return r.json().catch(function () { return { ok: false }; });
      }).then(function (body) {
        if (body && body.ok) {
          /* The form goes, the confirmation stays: a filled box beside a
             success line invites a second submission of the same address. */
          var row = box.querySelector('.formrow');
          if (row) row.hidden = true;
          btn.hidden = true;
          if (done) done.hidden = false;
          return;
        }
        btn.textContent = label;
        ready();
        if (body && body.code === 'E_HOLD_EMAIL_FAILED') return fail(GONE);
        fail((body && body.message) || GENERIC);
      }).catch(function () {
        btn.textContent = label;
        ready();
        fail('That did not go through, and it may be the network rather than us. Your passport is ' +
             'still being held; only saving the address failed.');
      });
    });
  }

  window.PassportHold = { attach: attach };
})();

/* The optional list box on the success screen.

   Mirrors assets/send.js rather than inventing a second pattern: ask the
   endpoint whether it can work at all, draw nothing if it cannot, and never let
   a failure here read as a failure of the publish that already succeeded.

   The one rule this file has that send.js does not: the button stays disabled
   until BOTH an address is present and the checkbox is ticked. Consent is the
   lawful basis for keeping the address, so a request that could be sent without
   it would make the checkbox decoration. The endpoint refuses such a request
   too; this is the half a person can see. */
(function () {
  'use strict';

  var api = '/api/subscribe';

  function attach(box, id, token) {
    if (!box) return;

    var email = box.querySelector('[data-sub-email]');
    var consent = box.querySelector('[data-sub-consent]');
    var btn = box.querySelector('[data-sub-btn]');
    var errors = box.querySelector('[data-sub-errors]');
    var done = box.querySelector('[data-sub-done]');
    if (!email || !consent || !btn) return;

    function ready() {
      /* Deliberately loose: the endpoint owns the real check, and a page that
         argues with somebody about their own address while they are typing is
         worse than one that lets them press the button and be told once. */
      btn.disabled = !(consent.checked && email.value.trim().length > 3);
    }
    email.addEventListener('input', ready);
    consent.addEventListener('change', ready);
    ready();

    function fail(message) {
      if (!errors) return;
      errors.hidden = false;
      errors.textContent = '';
      var p = document.createElement('p');
      /* textContent, never innerHTML: this string comes back from a server
         response and the rest of this site holds that line everywhere. */
      p.textContent = message;
      errors.appendChild(p);
    }

    btn.addEventListener('click', function () {
      if (errors) { errors.hidden = true; errors.textContent = ''; }
      btn.disabled = true;
      var label = btn.textContent;
      btn.textContent = 'Sending';

      fetch(api, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: id, token: token,
          email: email.value.trim(),
          consent: consent.checked === true
        })
      }).then(function (r) {
        return r.json().catch(function () { return { ok: false }; });
      }).then(function (body) {
        if (body && body.ok) {
          /* The form goes, the confirmation stays. Leaving a filled box beside
             a success line invites a second submission of the same address. */
          var row = box.querySelector('.formrow');
          var check = box.querySelector('.checkrow');
          if (row) row.hidden = true;
          if (check) check.hidden = true;
          btn.hidden = true;
          if (done) done.hidden = false;
          return;
        }
        btn.textContent = label;
        ready();
        fail((body && body.message) ||
          'That did not go through. Your passport is published and the link works; only this failed.');
      }).catch(function () {
        btn.textContent = label;
        ready();
        fail('That did not go through, and it may be the network rather than us. Your passport is ' +
             'published and the link works; only this failed.');
      });
    });

    /* Ask before drawing. A deployment with no key or no segment id is a normal
       deployment, and a box that cannot work should not be on the page at all
       rather than fail when somebody uses it. */
    fetch(api).then(function (r) { return r.json(); }).then(function (body) {
      var section = box.closest ? box.closest('[data-subbox]') : null;
      if (body && body.enabled) { if (section) section.hidden = false; }
      else if (section) section.hidden = true;
    }).catch(function () { /* leave it hidden */ });
  }

  window.PassportSubscribe = { attach: attach };
})();

/* Delete page behaviour.

   The client parses a pasted link down to its id and sends the pair to the one
   endpoint that decides. It does no validation of its own: a wrong token, a
   malformed token and an id that never existed all come back as the same
   failure, on purpose, and this page repeats the server's sentence rather than
   inventing a friendlier one. */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };

  var form   = $('#delete-form');
  var idIn   = $('#pid');
  var tokIn  = $('#token');
  var btn    = $('#delete-btn');
  var errors = $('#errors');
  var done   = $('#done');

  if (!form) return;

  var armed = false;
  var armTimer = null;
  var LABEL = 'Delete this passport permanently';

  function disarm() {
    armed = false;
    clearTimeout(armTimer);
    btn.textContent = LABEL;
    btn.classList.remove('danger');
  }

  function clearErrors() {
    errors.hidden = true;
    errors.textContent = '';
  }

  function showError(message) {
    errors.textContent = '';
    var h = document.createElement('div');
    h.className = 'eh';
    h.textContent = 'Not deleted.';
    errors.appendChild(h);
    var p = document.createElement('p');
    p.className = 'emsg';
    p.textContent = message;
    errors.appendChild(p);
    errors.hidden = false;
  }

  /* A passport link is the id with a page around it. Take the id out. */
  function idFrom(value) {
    var m = String(value || '').match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
    return m ? m[0].toLowerCase() : String(value || '').trim();
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearErrors();

    var id = idFrom(idIn.value);
    var token = tokIn.value.trim();
    if (!id || !token) {
      showError('Both the passport link and the delete token are needed. Nothing was deleted.');
      return;
    }

    if (!armed) {
      armed = true;
      btn.textContent = 'Click again to delete for good';
      btn.classList.add('danger');
      armTimer = setTimeout(disarm, 6000);
      return;
    }

    disarm();
    btn.disabled = true;
    btn.textContent = 'Deleting';

    fetch('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, token: token })
    })
      .then(function (r) {
        return r.json().then(function (j) { return { status: r.status, json: j }; });
      })
      .then(function (res) {
        btn.disabled = false;
        btn.textContent = LABEL;
        if (res.json && res.json.ok) {
          form.hidden = true;
          done.hidden = false;
          done.focus();
          return;
        }
        showError((res.json && res.json.message) ||
          'That delete token does not match this passport. Nothing was deleted.');
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = LABEL;
        showError('The request did not reach us, so nothing was deleted. Try again in a moment.');
      });
  });

  [idIn, tokIn].forEach(function (el) {
    el.addEventListener('input', function () { if (armed) disarm(); });
  });
})();

/* The send box, used on two pages: the success screen after publishing and the
   manage view behind a delete token. One widget, because it is one thing, and a
   second copy of it would drift.

   It asks the server whether sending is switched on before it shows itself. A
   deployment without a mail key is a normal deployment, not a broken one, and a
   form that cannot work should not be on the page offering to work.

   The credentials are not in this file and are never stored by it. The host page
   writes them onto the element as data attributes at the moment it has them, and
   this reads them at submit time. */
(function () {
  'use strict';

  var api = '/api/send';
  var enabled = null;         // null until asked

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function boxes() {
    return Array.prototype.slice.call(document.querySelectorAll('[data-sendbox]'));
  }

  /* One question, at load, shared by every box on the page. */
  function ask() {
    if (enabled !== null) return Promise.resolve(enabled);
    return fetch(api, { method: 'GET' })
      .then(function (r) { return r.json(); })
      .then(function (j) { enabled = !!(j && j.enabled); return enabled; })
      .catch(function () { enabled = false; return false; });
  }

  function wire(box) {
    var to      = box.querySelector('[data-send-to]');
    var from    = box.querySelector('[data-send-from]');
    var copy    = box.querySelector('[data-send-copy]');
    var copyRow = box.querySelector('[data-send-copy-row]');
    var copyTo  = box.querySelector('[data-send-copy-to]');
    var btn     = box.querySelector('[data-send-btn]');
    var errors  = box.querySelector('[data-send-errors]');
    var label   = btn ? btn.textContent : 'Send the link';

    if (!to || !btn || !errors) return;

    if (copy && copyRow) {
      copy.addEventListener('change', function () {
        copyRow.hidden = !copy.checked;
        if (copy.checked && copyTo) copyTo.focus();
      });
    }

    function clear() { errors.hidden = true; errors.textContent = ''; }

    function show(heading, message) {
      errors.textContent = '';
      errors.appendChild(el('div', 'eh', heading));
      errors.appendChild(el('p', 'emsg', message));
      errors.hidden = false;
    }

    function done(result) {
      var note = el('div', 'sent');
      var line = 'Sent. The link is on its way to ' + result.to + '.';
      if (result.copy === 'sent') line += ' Your copy, with the delete token in it, went to ' + result.copyTo + '.';
      if (result.copy === 'failed') line += ' Your own copy did not go out, so keep the token from this screen.';
      note.textContent = line;
      box.innerHTML = '';
      box.appendChild(note);
    }

    btn.addEventListener('click', function () {
      clear();

      var id = box.getAttribute('data-id') || '';
      var token = box.getAttribute('data-token') || '';
      if (!id || !token) {
        show('Not sent.', 'This box does not know which passport it is for. Reload the page and paste the link and token again.');
        return;
      }

      var address = (to.value || '').trim();
      if (!address) {
        show('Not sent.', 'Type the address the link should go to, or copy the link and send it yourself.');
        to.focus();
        return;
      }

      var wantsCopy = !!(copy && copy.checked);
      var copyAddress = wantsCopy && copyTo ? (copyTo.value || '').trim() : '';
      if (wantsCopy && !copyAddress) {
        show('Not sent.', 'You asked for a copy but did not say where to send it. Add your own address, or untick the box.');
        if (copyTo) copyTo.focus();
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Sending';

      fetch(api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: id,
          token: token,
          to: address,
          from_name: from ? (from.value || '').trim() : '',
          copy_to: copyAddress
        })
      })
        .then(function (r) { return r.json().then(function (j) { return j; }); })
        .then(function (j) {
          btn.disabled = false;
          btn.textContent = label;
          if (j && j.ok) return done({ to: address, copy: j.copy, copyTo: copyAddress });
          show('Not sent.', (j && j.message) ||
            'The email did not go out. The passport is published and the link works, so copy it and send it yourself.');
        })
        .catch(function () {
          btn.disabled = false;
          btn.textContent = label;
          show('Not sent.', 'The request did not reach us. The passport is published and the link works, so copy it and send it yourself.');
        });
    });
  }

  /* Public: the host page calls this once it holds an id and a token. */
  window.PassportSend = {
    attach: function (box, id, token) {
      if (!box) return;
      box.setAttribute('data-id', id);
      box.setAttribute('data-token', token);
      ask().then(function (on) {
        box.hidden = !on;
        var off = box.parentNode ? box.parentNode.querySelector('[data-send-off]') : null;
        if (off) off.hidden = on;
      });
    }
  };

  boxes().forEach(wire);
})();

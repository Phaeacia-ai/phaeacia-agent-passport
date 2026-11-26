/* Manage page behaviour.

   Two values unlock this page and neither is a login. They arrive one of two
   ways: typed into the form, or carried in the fragment of a management link as
   #id:token. The fragment is the right half of the URL to put them in because
   browsers do not send it to a server, so the token never appears in an access
   log, not even ours. It is cleared out of the address bar the moment it is
   read, so it does not sit in the history entry for the next person at the
   machine.

   Nothing here is remembered. This page writes no localStorage, sets no cookie
   and holds no session: close the tab and it forgets, which is the same promise
   the footer makes about there being no accounts. The site's one cookie is set
   by /api/vote and nothing on this page reads or writes it. */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };

  var form     = $('#manage-form');
  var idIn     = $('#pid');
  var tokIn    = $('#token');
  var unlockBt = $('#unlock-btn');
  var errors   = $('#errors');

  var panel    = $('#panel');
  var sendStep = $('#send-step');
  var actions  = $('#actions');
  var stats    = $('#stats');
  var lifeFill = $('#life-fill');
  var lifeCap  = $('#life-cap');
  var actErr   = $('#action-errors');
  var renewBt  = $('#renew-btn');
  var deleteBt = $('#delete-btn');
  var deleted  = $('#deleted');
  var opened   = $('#opened');
  var note     = $('#unlock-note');
  var again    = $('#unlock-again');

  var galStep  = $('#gallery-step');
  var galErr   = $('#gallery-errors');
  var listForm = $('#list-form');
  var listBox  = $('#list-in-gallery');
  var listCatRow = $('#list-category-row');
  var listCat  = $('#list-category');
  var listBt   = $('#list-btn');
  var listedNow = $('#listed-now');
  var listedDetail = $('#listed-detail');
  var unlistBt = $('#unlist-btn');
  var renewNote = $('#renew-note');

  if (!form) return;

  var held = { id: '', token: '' };
  var UNLOCK_LABEL = unlockBt.textContent;
  var DAY = 86400000;

  /* ── plumbing ───────────────────────────────────────────── */

  function idFrom(value) {
    var m = String(value || '').match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
    return m ? m[0].toLowerCase() : String(value || '').trim();
  }

  function clear(box) { box.hidden = true; box.textContent = ''; }

  function show(box, heading, message) {
    box.textContent = '';
    var h = document.createElement('div');
    h.className = 'eh';
    h.textContent = heading;
    box.appendChild(h);
    var p = document.createElement('p');
    p.className = 'emsg';
    p.textContent = message;
    box.appendChild(p);
    box.hidden = false;
  }

  function post(body) {
    return fetch('/api/manage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  /* ── rendering ──────────────────────────────────────────── */

  function words(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return 'unknown';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function daysLeft(iso) {
    var at = Date.parse(iso);
    if (!isFinite(at)) return null;
    return Math.max(0, Math.ceil((at - Date.now()) / DAY));
  }

  function stat(n, label, warn) {
    var cell = document.createElement('div');
    cell.className = 'stat';
    var v = document.createElement('span');
    v.className = warn ? 'n warn' : 'n';
    v.textContent = n;
    var l = document.createElement('span');
    l.className = 'l';
    l.textContent = label;
    cell.appendChild(v);
    cell.appendChild(l);
    return cell;
  }

  function render(status, renewDays) {
    var left = daysLeft(status.expires_at);
    var low = left !== null && left <= 5;
    var listed = status.listed === true;
    var votes = status.votes || { up: 0, down: 0 };

    $('#panel-title').textContent = status.title || status.name || 'This passport';

    stats.textContent = '';
    stats.appendChild(stat(String(status.views || 0), status.views === 1 ? 'time opened' : 'times opened'));
    /* COPIED, never "installed". Nothing reaches this site when somebody pastes
       an install block into their own assistant, so an install count would be a
       number we invented. This counts presses of the copy control and is
       labelled as the thing it counts. */
    stats.appendChild(stat(String(status.copies || 0), status.copies === 1 ? 'time copied' : 'times copied'));
    if (listed) {
      stats.appendChild(stat(String(votes.up || 0), (votes.up === 1 ? 'vote up' : 'votes up')));
      stats.appendChild(stat(String(votes.down || 0), (votes.down === 1 ? 'vote down' : 'votes down')));
    } else {
      stats.appendChild(stat(left === null ? 'unknown' : String(left), left === 1 ? 'day left' : 'days left', low));
      stats.appendChild(stat(String(status.renewed || 0), status.renewed === 1 ? 'renewal' : 'renewals'));
    }

    /* The bar is drawn against the renewal window, not against the passport's
       whole life, because that is the length the renew button restores. A listed
       passport has no window, so the bar goes and the sentence stays: a track
       drawn full or empty for something that does not expire would be a picture
       of a number that does not exist. */
    var span = renewDays || 30;
    var track = lifeFill.parentNode;
    if (track) track.hidden = listed;
    if (listed) {
      lifeCap.textContent = 'Listed in the gallery, does not expire. It stays up until you delete it ' +
        'or take it off the list below.';
    } else {
      var pct = left === null ? 0 : Math.max(2, Math.min(100, Math.round((left / span) * 100)));
      lifeFill.style.width = pct + '%';
      lifeFill.className = low ? 'fill low' : 'fill';
      lifeCap.textContent = left === null
        ? 'This passport has no expiry recorded.'
        : (left === 0
          ? 'This passport expires today. Renewing gives it another ' + span + ' days from now.'
          : 'Published ' + words(status.created_at) + '. It comes down by itself on ' +
            words(status.expires_at) + ' unless you renew it.');
    }

    renderGallery(status);

    /* Renewing a listed passport does nothing and the server says so without an
       error; the control goes rather than sitting there as a button that reports
       success and changes nothing. */
    if (renewBt) renewBt.hidden = listed;
    if (renewNote) renewNote.hidden = listed;

    /* CANONICAL, not the address bar. This is the link the owner copies and
       sends to someone else, so on a preview host it handed them a link that
       stops working when that deploy is cleaned up. card.js one file away has
       always built this link the right way. See ROW-63. */
    $('#panel-url').textContent = window.PHAEACIA_CANONICAL + '/p/' + status.id;
    $('#unreviewed').hidden = status.owner_confirmed !== false;

    panel.hidden = false;
    sendStep.hidden = false;
    actions.hidden = false;
    if (galStep) galStep.hidden = false;

    /* The form has done its job. Fold it away and clear both fields, so the
       token is not left on screen for the rest of the session. It stays in
       memory for the buttons below and goes when the tab does. */
    form.hidden = true;
    if (note) note.hidden = true;
    if (opened) opened.hidden = false;
    idIn.value = '';
    tokIn.value = '';

    if (window.PassportSend) {
      window.PassportSend.attach(document.querySelector('[data-sendbox]'), held.id, held.token);
    }
  }

  /* ── the gallery row ────────────────────────────────────── */

  /* The eight labels are in the markup, not here. This reads the option whose
     value matches the stored slug, so a slug this page's list no longer carries
     prints as nothing rather than as an invented label, which is the same rule
     categoryLabel() follows on the server. */
  function labelFor(slug) {
    if (!listCat) return '';
    var opt = listCat.querySelector('option[value="' + String(slug || '').replace(/"/g, '') + '"]');
    return opt && opt.value ? opt.textContent : '';
  }

  function renderGallery(status) {
    if (!galStep) return;
    var listed = status.listed === true;
    var votes = status.votes || { up: 0, down: 0 };

    if (listForm) listForm.hidden = listed;
    if (listedNow) listedNow.hidden = !listed;

    if (listed && listedDetail) {
      var label = labelFor(status.category);
      var when = status.listed_at ? words(status.listed_at) : '';
      listedDetail.textContent =
        'In the gallery' + (label ? ' under ' + label : '') + (when ? ', since ' + when : '') + '. ' +
        votes.up + ' up, ' + votes.down + ' down.';
    }

    if (!listed && listBox) {
      listBox.checked = false;
      if (listCatRow) listCatRow.hidden = true;
      if (listCat) {
        listCat.value = '';
        listCat.removeAttribute('required');
      }
    }
  }

  if (listBox && listCatRow) {
    listBox.addEventListener('change', function () {
      var on = listBox.checked;
      listCatRow.hidden = !on;
      if (listCat) {
        if (on) listCat.setAttribute('required', 'required');
        else listCat.removeAttribute('required');
      }
      if (on && listCat) listCat.focus();
    });
  }

  if (listBt) {
    listBt.addEventListener('click', function () {
      clear(galErr);
      if (!listBox || !listBox.checked) {
        show(galErr, 'Not listed.', 'Tick the box first. Listing is a public and open-ended thing to do, so it is not the default.');
        return;
      }
      var category = listCat ? String(listCat.value || '') : '';
      if (!category) {
        show(galErr, 'Not listed.', 'Pick what this agent is for. The gallery filters on it, so there is no unset value for it to fall into.');
        if (listCat) listCat.focus();
        return;
      }
      var label = listBt.textContent;
      listBt.disabled = true;
      listBt.textContent = 'Listing';
      post({ id: held.id, token: held.token, action: 'list', category: category })
        .then(function (j) {
          listBt.disabled = false;
          listBt.textContent = label;
          if (j && j.ok) return render(j.status, j.renew_days);
          show(galErr, 'Not listed.', (j && j.message) ||
            'That link and token do not go together, so nothing was listed.');
        })
        .catch(function () {
          listBt.disabled = false;
          listBt.textContent = label;
          show(galErr, 'Not listed.', 'The request did not reach us. Nothing changed.');
        });
    });
  }

  if (unlistBt) {
    unlistBt.addEventListener('click', function () {
      clear(galErr);
      var label = unlistBt.textContent;
      unlistBt.disabled = true;
      unlistBt.textContent = 'Taking it off';
      post({ id: held.id, token: held.token, action: 'unlist' })
        .then(function (j) {
          unlistBt.disabled = false;
          unlistBt.textContent = label;
          if (j && j.ok) return render(j.status, j.renew_days);
          show(galErr, 'Not unlisted.', (j && j.message) ||
            'That link and token do not go together, so nothing changed.');
        })
        .catch(function () {
          unlistBt.disabled = false;
          unlistBt.textContent = label;
          show(galErr, 'Not unlisted.', 'The request did not reach us. Nothing changed.');
        });
    });
  }

  /* ── unlock ─────────────────────────────────────────────── */

  function unlock(id, token) {
    clear(errors);
    unlockBt.disabled = true;
    unlockBt.textContent = 'Checking';

    return post({ id: id, token: token, action: 'status' })
      .then(function (j) {
        unlockBt.disabled = false;
        unlockBt.textContent = UNLOCK_LABEL;
        if (j && j.ok) {
          held.id = id;
          held.token = token;
          render(j.status, j.renew_days);
          panel.scrollIntoView({ behavior: calm() ? 'auto' : 'smooth', block: 'start' });
          return true;
        }
        show(errors, 'Not opened.', (j && j.message) ||
          'That link and token do not go together. Check that you pasted both in full.');
        return false;
      })
      .catch(function () {
        unlockBt.disabled = false;
        unlockBt.textContent = UNLOCK_LABEL;
        show(errors, 'Not opened.', 'The request did not reach us. Try again in a moment.');
        return false;
      });
  }

  function calm() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  if (again) {
    again.addEventListener('click', function (e) {
      e.preventDefault();
      held = { id: '', token: '' };
      form.hidden = false;
      if (note) note.hidden = false;
      opened.hidden = true;
      panel.hidden = true;
      sendStep.hidden = true;
      actions.hidden = true;
      if (galStep) galStep.hidden = true;
      clear(errors);
      clear(actErr);
      clear(galErr);
      idIn.focus();
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var id = idFrom(idIn.value);
    var token = (tokIn.value || '').trim();
    if (!id || !token) {
      show(errors, 'Not opened.', 'Both the passport link and the delete token are needed.');
      return;
    }
    unlock(id, token);
  });

  /* ── renew ──────────────────────────────────────────────── */

  renewBt.addEventListener('click', function () {
    clear(actErr);
    renewBt.disabled = true;
    renewBt.textContent = 'Renewing';
    post({ id: held.id, token: held.token, action: 'renew' })
      .then(function (j) {
        renewBt.disabled = false;
        renewBt.textContent = 'Renew for another 30 days';
        if (j && j.ok) return render(j.status, j.renew_days);
        show(actErr, 'Not renewed.', (j && j.message) ||
          'That link and token do not go together.');
      })
      .catch(function () {
        renewBt.disabled = false;
        renewBt.textContent = 'Renew for another 30 days';
        show(actErr, 'Not renewed.', 'The request did not reach us. Nothing changed.');
      });
  });

  /* ── delete, two clicks ─────────────────────────────────── */

  var armed = false;
  var armTimer = null;
  var DELETE_LABEL = 'Delete this passport';

  function disarm() {
    armed = false;
    clearTimeout(armTimer);
    deleteBt.textContent = DELETE_LABEL;
    deleteBt.classList.remove('danger');
  }

  deleteBt.addEventListener('click', function () {
    clear(actErr);
    if (!armed) {
      armed = true;
      deleteBt.textContent = 'Click again to delete for good';
      deleteBt.classList.add('danger');
      armTimer = setTimeout(disarm, 6000);
      return;
    }
    disarm();
    deleteBt.disabled = true;
    deleteBt.textContent = 'Deleting';

    fetch('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: held.id, token: held.token })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        deleteBt.disabled = false;
        deleteBt.textContent = DELETE_LABEL;
        if (j && j.ok) {
          /* Everything the token could act on is gone, so everything it
             unlocked goes with it. What is left on the page is one notice
             saying so. */
          panel.hidden = true;
          sendStep.hidden = true;
          /* The gallery row goes with everything else the token unlocked. A
             deleted passport has no listing to take off a list. */
          if (galStep) galStep.hidden = true;
          if (opened) opened.hidden = true;
          actions.querySelectorAll('.step-head, .body, .actions, .caption')
            .forEach(function (n) { n.hidden = true; });
          deleted.hidden = false;
          deleted.focus();
          held = { id: '', token: '' };
          return;
        }
        show(actErr, 'Not deleted.', (j && j.message) ||
          'That delete token does not match this passport. Nothing was deleted.');
      })
      .catch(function () {
        deleteBt.disabled = false;
        deleteBt.textContent = DELETE_LABEL;
        show(actErr, 'Not deleted.', 'The request did not reach us, so nothing was deleted.');
      });
  });

  /* ── the management link ────────────────────────────────── */

  (function fromFragment() {
    var raw = window.location.hash.replace(/^#/, '');
    if (!raw) return;
    var parts = raw.split(':');
    if (parts.length !== 2) return;
    var id = idFrom(parts[0]);
    var token = parts[1].trim();
    if (!/^[0-9a-f-]{36}$/.test(id) || !/^[0-9a-f]{40}$/i.test(token)) return;

    /* Out of the address bar before anything else happens, so a screenshot, a
       shoulder or the next history entry does not carry it. */
    history.replaceState(null, '', window.location.pathname);

    idIn.value = window.PHAEACIA_CANONICAL + '/p/' + id;
    tokIn.value = token;
    unlock(id, token.toLowerCase());
  })();
})();

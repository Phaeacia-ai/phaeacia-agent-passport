(function () {
  'use strict';
  var button = document.querySelector('[data-app-copy]');
  if (!button) return;
  var slot = button.querySelector('[data-copy-label]');
  var timer;
  button.addEventListener('click', function () {
    var target = document.querySelector(button.getAttribute('data-app-copy'));
    if (!target || !slot) return;
    var done = function (ok) {
      slot.textContent = ok ? 'Copied' : 'Copy failed, select the link and copy by hand';
      slot.setAttribute('role', 'status');
      clearTimeout(timer);
      timer = setTimeout(function () { slot.textContent = 'Copy link'; }, 3000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(target.textContent).then(function () { done(true); }, function () { done(false); });
    } else done(false);
  });
})();

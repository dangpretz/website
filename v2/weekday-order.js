/* Mon–Thu (America/Denver) the shop is closed and the Square pickup menu
   stays off. Point ORDER NOW / Order Online at catering and show a short note.
   Fri–Sun leaves those links alone. */
(function () {
  var CATERING = './catering.html';
  var CLOSED = { Mon: true, Tue: true, Wed: true, Thu: true };

  function now() {
    if (typeof window.__DPC_NOW === 'string' && window.__DPC_NOW) {
      var parsed = new Date(window.__DPC_NOW);
      if (!isNaN(parsed.getTime())) return parsed;
    }
    return new Date();
  }

  var weekday;
  try {
    weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Denver',
      weekday: 'short'
    }).format(now());
  } catch (e) {
    return;
  }
  if (!CLOSED[weekday]) return;

  function cateringLink() {
    var a = document.createElement('a');
    a.href = CATERING;
    a.textContent = 'Order catering here';
    return a;
  }

  function note() {
    var p = document.createElement('p');
    p.className = 'weekday-closed-note';
    p.appendChild(document.createTextNode('Closed Mon\u2013Thu. '));
    p.appendChild(cateringLink());
    return p;
  }

  var links = document.querySelectorAll('a[href*="cash.app/order/"]');
  for (var i = 0; i < links.length; i++) {
    var link = links[i];
    link.href = CATERING;
    if (link.closest('.nav-links')) continue;
    var next = link.nextElementSibling;
    if (next && next.classList.contains('weekday-closed-note')) continue;
    link.insertAdjacentElement('afterend', note());
  }

  var nav = document.querySelector('.site-nav');
  if (nav && !nav.querySelector('.weekday-closed-bar')) {
    var bar = document.createElement('p');
    bar.className = 'weekday-closed-bar';
    bar.appendChild(document.createTextNode('Closed Mon\u2013Thu. '));
    bar.appendChild(cateringLink());
    var wrap = nav.querySelector('.nav-wrap');
    if (wrap) wrap.insertAdjacentElement('afterend', bar);
    else nav.appendChild(bar);
  }
})();

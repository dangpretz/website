/* Mon–Thu (America/Denver) the shop is closed and the Square pickup menu
   stays off. Point ORDER NOW / Order Online at catering and show a short note.
   Fri–Sun leaves those links alone. */
(function weekdayOrder() {
  const CATERING = './catering.html';
  const CLOSED = {
    Mon: true,
    Tue: true,
    Wed: true,
    Thu: true,
  };

  function denverNow() {
    // Test hook: set before this script runs. Not a public page parameter.
    // eslint-disable-next-line no-underscore-dangle
    const override = window.__DPC_NOW;
    if (typeof override === 'string' && override) {
      const parsed = new Date(override);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return new Date();
  }

  function cateringLink() {
    const anchor = document.createElement('a');
    anchor.href = CATERING;
    anchor.textContent = 'Order catering here';
    return anchor;
  }

  function note() {
    const paragraph = document.createElement('p');
    paragraph.className = 'weekday-closed-note';
    paragraph.appendChild(document.createTextNode('Closed Mon\u2013Thu. '));
    paragraph.appendChild(cateringLink());
    return paragraph;
  }

  let weekday = '';
  try {
    weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Denver',
      weekday: 'short',
    }).format(denverNow());
  } catch (error) {
    return;
  }
  if (!CLOSED[weekday]) return;

  document.querySelectorAll('a[href*="cash.app/order/"]').forEach((link) => {
    link.href = CATERING;
    const next = link.nextElementSibling;
    const alreadyNoted = next && next.classList.contains('weekday-closed-note');
    if (!link.closest('.nav-links') && !alreadyNoted) {
      link.insertAdjacentElement('afterend', note());
    }
  });

  const nav = document.querySelector('.site-nav');
  if (nav && !nav.querySelector('.weekday-closed-bar')) {
    const bar = document.createElement('p');
    bar.className = 'weekday-closed-bar';
    bar.appendChild(document.createTextNode('Closed Mon\u2013Thu. '));
    bar.appendChild(cateringLink());
    const wrap = nav.querySelector('.nav-wrap');
    if (wrap) wrap.insertAdjacentElement('afterend', bar);
    else nav.appendChild(bar);
  }
}());

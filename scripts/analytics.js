/**
 * Google Analytics 4 for Dangerous Pretzel.
 * Measurement ID: G-P74KFNMJ3N
 *
 * This is the standard gtag.js install (dataLayer queue, gtag(), config),
 * kept in one file so every served template loads the same snippet.
 * Pages reference it with defer. The Google library itself is async.
 */

const MEASUREMENT_ID = 'G-P74KFNMJ3N';

/**
 * Record a lead after a form's own success path. Safe to call when the
 * library has not finished loading: the command stays queued.
 * @param {string} formName Stable form name, for example catering_order.
 */
function trackGenerateLead(formName) {
  if (!formName || typeof window.gtag !== 'function') return;
  window.gtag('event', 'generate_lead', {
    form_name: formName,
    transport_type: 'beacon',
  });
}

window.dpcTrackGenerateLead = trackGenerateLead;

if (!window.dpcGa4) {
  window.dpcGa4 = true;
  window.dataLayer = window.dataLayer || [];
  if (typeof window.gtag !== 'function') {
    window.gtag = function gtag() {
      // The standard snippet queues the arguments object, not a copy.
      // eslint-disable-next-line prefer-rest-params
      window.dataLayer.push(arguments);
    };
  }
  window.gtag('js', new Date());
  window.gtag('config', MEASUREMENT_ID);

  const library = document.createElement('script');
  library.async = true;
  library.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  document.head.appendChild(library);
}

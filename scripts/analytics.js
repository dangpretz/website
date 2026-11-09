/**
 * Google Analytics 4 for Dangerous Pretzel.
 * Measurement ID: G-P74KFNMJ3N
 *
 * This is the standard gtag.js install (dataLayer queue, gtag(), config),
 * kept in one file so every served template loads the same snippet.
 * Pages reference it with defer. The Google library itself is async.
 */

const MEASUREMENT_ID = 'G-P74KFNMJ3N';
const LEAD_SOURCE_KEY = 'dpcLeadSource';
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign'];

function clip(value, max) {
  return String(value || '').trim().slice(0, max);
}

function currentTouch() {
  const params = new URLSearchParams(window.location.search);
  const utm = {};
  UTM_KEYS.forEach((key) => {
    const value = clip(params.get(key), 120);
    if (value) utm[key] = value;
  });
  return {
    utm,
    referrer: clip(document.referrer, 300),
    landing: clip(`${window.location.pathname}${window.location.search}`, 300),
  };
}

function readStoredTouch() {
  try {
    const raw = sessionStorage.getItem(LEAD_SOURCE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

/** First page of this tab: UTMs, referrer, and landing path. Later pages keep it. */
function rememberTouch() {
  const existing = readStoredTouch();
  if (existing) return existing;
  const touch = currentTouch();
  try {
    sessionStorage.setItem(LEAD_SOURCE_KEY, JSON.stringify(touch));
  } catch (err) {
    /* private mode or blocked storage — use this page view instead */
  }
  return touch;
}

/**
 * One line for the emailed submission. UTMs are included only when the
 * landing page had them. Referrer is "direct" when the browser has none.
 */
function leadSourceValue() {
  const touch = rememberTouch() || currentTouch();
  const utm = touch.utm || {};
  const parts = [];
  UTM_KEYS.forEach((key) => {
    if (utm[key]) parts.push(`${key}=${utm[key]}`);
  });
  parts.push(`referrer=${touch.referrer || 'direct'}`);
  parts.push(`landing=${touch.landing || window.location.pathname || '/'}`);
  parts.push(`page=${window.location.pathname || '/'}`);
  return parts.join(' | ');
}

function fillLeadSourceFields(root) {
  const value = leadSourceValue();
  const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
  scope.querySelectorAll('input[name="Lead source"]').forEach((input) => {
    input.value = value;
  });
}

function initLeadSourceFields() {
  rememberTouch();
  const apply = () => fillLeadSourceFields(document);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
  // Capture runs before a form's own submit handler reads the fields.
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (form && typeof form.querySelectorAll === 'function') {
      fillLeadSourceFields(form);
    }
  }, true);
}

window.dpcLeadSource = leadSourceValue;
initLeadSourceFields();

/**
 * Record a lead after a form's own success path. Safe to call when the
 * library has not finished loading: the command stays queued.
 * lead_source is trimmed to GA4's parameter length. The email keeps the full line.
 * @param {string} formName Stable form name, for example catering_order.
 */
function trackGenerateLead(formName) {
  if (!formName || typeof window.gtag !== 'function') return;
  const leadSource = leadSourceValue();
  window.gtag('event', 'generate_lead', {
    form_name: formName,
    transport_type: 'beacon',
    ...(leadSource ? { lead_source: leadSource.slice(0, 100) } : {}),
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

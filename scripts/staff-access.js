/* eslint-disable no-empty */
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ SHARED STAFF-HUB ACCESS CONTROL                                          ║
// ╠══════════════════════════════════════════════════════════════════════════╣
// ║                                                                          ║
// ║ Single source of truth for "who is logged in" and "what can they see."  ║
// ║ The hub (static/index.html) is the ONLY page with a PIN keypad. Every    ║
// ║ other tool page imports requireAccess() and calls it before loading any ║
// ║ data — unlike scripts/inventory.js this module DOES touch the DOM and   ║
// ║ sessionStorage/location, because gating access is its entire job.       ║
// ║                                                                          ║
// ║ SESSION                                                                  ║
// ║   One sessionStorage key (SESSION_KEY) holds the whole unlock: which     ║
// ║   code, their name, whether they're a manager, and their granted        ║
// ║   pageKeys — resolved once at hub login so every other page just reads  ║
// ║   the cached object instead of re-fetching/re-reducing the directory.   ║
// ║   Per-tab, same as every PIN session before it (sessionStorage, not     ║
// ║   localStorage) — a link opened in a new tab needs unlocking again.     ║
// ║                                                                          ║
// ║ DIRECTORY (/dangpretz/staff-directory log)                              ║
// ║   action: 'set_staff' → { code, name, isManager, links, updatedBy,      ║
// ║   timeStamp }, one full snapshot row per code (last-write-wins, same    ║
// ║   reduction style as sku_config elsewhere in this codebase). `links` is ║
// ║   a comma-joined list of LINK_CATALOG keys (appendLog serializes plain  ║
// ║   values via URLSearchParams, so a joined string round-trips cleanly).  ║
// ║                                                                          ║
// ║ DEFAULTS — so nobody is locked out before real data exists:              ║
// ║   - BOOTSTRAP_MANAGER_CODE is always a manager, even with zero rows in  ║
// ║     the log, so someone can always reach the manager page. A real       ║
// ║     set_staff row for that code overrides this fallback.                ║
// ║   - The 9 other legacy shared codes are seeded with Production (+ its   ║
// ║     role subsets) and Delivery Planner until a manager assigns real     ║
// ║     names/access. A real row for any of them overrides the default.     ║
// ║                                                                          ║
// ╚══════════════════════════════════════════════════════════════════════════╝

export const STAFF_LOG_PATH = '/dangpretz/staff-directory';
export const HUB_URL = '/static/index.html';
export const SESSION_KEY = 'dpc-unlock';

// The bootstrap manager — keep this in sync with what the manager page shows
// as the built-in fallback row.
export const BOOTSTRAP_MANAGER_CODE = '8770';

// The other 9 shared codes in use before this system existed.
const LEGACY_DEFAULT_CODES = ['0068', '0571', '8468', '6124', '9281', '9646', '6362', '9709', '1377'];

// Every grantable link. Production's role-scoped URLs each get their own
// key so a Shape-only grant can't be bypassed by hand-editing ?role=manager.
export const LINK_CATALOG = [
  { key: 'production:manager', label: 'Production — Manager', url: '/static/production/index.html' },
  { key: 'production:shape', label: 'Production — Shape', url: '/static/production/index.html?role=shape' },
  { key: 'production:bfp', label: 'Production — BFP', url: '/static/production/index.html?role=bfp' },
  { key: 'production:dips', label: 'Production — Dips', url: '/static/production/index.html?role=dips' },
  { key: 'production:stock', label: 'Production — Stock', url: '/static/production/index.html?role=stock' },
  { key: 'production:foh', label: 'Production — FOH', url: '/static/production/index.html?role=foh' },
  { key: 'shape-ingredients', label: 'Ingredient Log', url: '/static/shape-ingredients/index.html' },
  { key: 'receiving', label: 'Receiving', url: '/static/receiving/index.html' },
  { key: 'receiving-history', label: 'Receiving History', url: '/static/receiving-history/index.html' },
  { key: 'inventory', label: 'Inventory', url: '/static/inventory/index.html' },
  { key: 'inventory-forecast', label: 'Inventory Forecast', url: '/static/inventory-forecast/index.html' },
  { key: 'recipes', label: 'Recipes', url: '/static/recipes/index.html' },
  { key: 'batch-tracking', label: 'Batch Tracking', url: '/static/batch-tracking/index.html' },
  { key: 'barcode-lookup', label: 'Barcode Lookup', url: '/static/barcode-lookup/index.html' },
  { key: 'delivery-planner', label: 'Delivery Planner', url: '/static/delivery-planner/index.html' },
  { key: 'sales-crm', label: 'Sales CRM', url: '/static/sales/index.html' },
];

const LEGACY_DEFAULT_LINKS = [
  'production:manager', 'production:shape', 'production:bfp',
  'production:dips', 'production:stock', 'production:foh',
  'delivery-planner',
];

export function linkLabel(pageKey) {
  const entry = LINK_CATALOG.find((l) => l.key === pageKey);
  return entry ? entry.label : pageKey;
}

// ── Directory resolution ────────────────────────────────────────────────
export function resolveStaffDirectory(logs) {
  const directory = {};
  (Array.isArray(logs) ? logs : []).forEach((row) => {
    if (row.action !== 'set_staff' || !row.code) return;
    const links = String(row.links || '').split(',').map((s) => s.trim()).filter(Boolean);
    directory[row.code] = {
      name: row.name || '',
      isManager: row.isManager === true || row.isManager === 'true',
      links,
    };
  });

  if (!directory[BOOTSTRAP_MANAGER_CODE]) {
    directory[BOOTSTRAP_MANAGER_CODE] = {
      name: 'Manager',
      isManager: true,
      links: LINK_CATALOG.map((l) => l.key),
    };
  }

  LEGACY_DEFAULT_CODES.forEach((code) => {
    if (!directory[code]) {
      directory[code] = { name: '(unassigned)', isManager: false, links: [...LEGACY_DEFAULT_LINKS] };
    }
  });

  return directory;
}

// ── Session (written once, at hub login) ────────────────────────────────
export function getSessionUnlock() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.code) return null;
    return parsed;
  } catch (_) { return null; }
}

export function setSessionUnlock(entry) {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(entry)); } catch (_) {}
}

export function clearSessionUnlock() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
}

// ── Gate for every non-hub page ─────────────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function currentUrl() {
  return window.location.pathname + window.location.search + window.location.hash;
}

function redirectToHub() {
  const ret = encodeURIComponent(currentUrl());
  window.location.replace(`${HUB_URL}?return=${ret}`);
}

function renderDenied(pageKey, session) {
  document.title = 'Access Denied | Dangerous Pretzel Co.';
  const who = session && session.name ? escapeHtml(session.name) : 'Your code';
  const boxStyle = 'position:fixed;inset:0;background:#141414;display:flex;'
    + 'flex-direction:column;align-items:center;justify-content:center;gap:14px;'
    + 'text-align:center;padding:24px;box-sizing:border-box;font-family:\'Manrope\',sans-serif;';
  const linkStyle = 'margin-top:8px;color:#C41E1E;font:700 14px \'Manrope\',sans-serif;'
    + 'text-decoration:none;';
  document.body.innerHTML = `
    <div style="${boxStyle}">
      <div style="font-size:40px;">🔒</div>
      <div style="color:#fff;font:800 20px 'Manrope',sans-serif;">Not granted</div>
      <div style="color:#999;font:400 14px 'Manrope',sans-serif;max-width:320px;line-height:1.5;">
        ${who} doesn't have access to ${escapeHtml(linkLabel(pageKey))}. See your manager to get it added.
      </div>
      <a href="${HUB_URL}" style="${linkStyle}">&larr; Back to the hub</a>
    </div>`;
}

// Called at the very top of every non-hub page's boot sequence, before any
// load()/fetchLog() call. Resolves with the session only when the page is
// actually allowed to load data; every other branch redirects or renders a
// denial and leaves the returned promise permanently pending, so the
// caller's `await requireAccess(...)` never falls through to loading data.
export function requireAccess(pageKey) {
  return new Promise((resolve) => {
    const session = getSessionUnlock();
    if (!session) { redirectToHub(); return; }
    if (!Array.isArray(session.links) || !session.links.includes(pageKey)) {
      renderDenied(pageKey, session);
      return;
    }
    resolve(session);
  });
}

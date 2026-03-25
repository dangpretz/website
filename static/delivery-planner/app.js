import { fetchLog, appendLog } from '../../scripts/sheet-logger.js';

const LOG_PATH = '/dangpretz/delivery-planner';
const form = document.getElementById('delivery-form');
const weekGrid = document.getElementById('week-grid');
const totalsBySkuList = document.getElementById('totals-by-sku');
const lineItemsContainer = document.getElementById('line-items-container');
const lineItemsEmpty = document.getElementById('line-items-empty');
const addRowBtn = document.getElementById('add-row-btn');
const formError = document.getElementById('form-error');
const submitBtn = document.getElementById('submit-btn');
const deliveryIdInput = document.getElementById('delivery-id');
const cancelEditBtn = document.getElementById('cancel-edit-btn');

let skus = [];
let currentDeliveries = [];

// ── Collapsible form ──
const formToggle = document.getElementById('form-toggle');
const formBody = document.getElementById('form-body');
const formCard = document.getElementById('form-card');

formToggle.addEventListener('click', () => {
  const isOpen = formBody.classList.toggle('expanded');
  formCard.classList.toggle('open', isOpen);
});

function expandForm() {
  formBody.classList.add('expanded');
  formCard.classList.add('open');
}

// ── Week navigation ──
let weekOffset = 0; // 0 = current week

function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = (day + 6) % 7;
  date.setDate(date.getDate() - diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function getWeekRange(offset) {
  const now = new Date();
  const monday = getMonday(now);
  monday.setDate(monday.getDate() + offset * 7);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  return { start: monday, end: sunday };
}

function formatShortDate(d) {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function updateWeekLabel() {
  const weekLabel = document.getElementById('week-label');
  const weekDates = document.getElementById('week-dates');
  const { start, end } = getWeekRange(weekOffset);
  let title;
  if (weekOffset === 0) title = 'This Week';
  else if (weekOffset === -1) title = 'Last Week';
  else if (weekOffset === 1) title = 'Next Week';
  else {
    title = `Week of ${formatShortDate(start)}`;
  }
  weekLabel.childNodes[0].textContent = `${title} `;
  weekDates.textContent = `${formatShortDate(start)} – ${formatShortDate(end)}`;
}

document.getElementById('week-prev').addEventListener('click', () => { weekOffset--; updateWeekLabel(); renderScheduleForWeek(); });
document.getElementById('week-next').addEventListener('click', () => { weekOffset++; updateWeekLabel(); renderScheduleForWeek(); });
document.getElementById('week-today').addEventListener('click', () => { weekOffset = 0; updateWeekLabel(); renderScheduleForWeek(); });

updateWeekLabel();

function generateDeliveryId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `del-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

const STATUS_OPTIONS = {
  delivery: [
    { value: 'scheduled', label: 'Scheduled' },
    { value: 'ready_deliver', label: 'Ready for delivery' },
    { value: 'delivered', label: 'Delivered' },
  ],
  pickup: [
    { value: 'scheduled', label: 'Scheduled' },
    { value: 'ready_pickup', label: 'Ready for pickup' },
    { value: 'picked_up', label: 'Picked up' },
  ],
};

/** From raw log rows, resolve current deliveries (apply updates and deletes). */
function resolveDeliveriesFromLogs(logs) {
  const byId = {};
  if (!Array.isArray(logs)) return [];
  logs.forEach((row, idx) => {
    const id = row.deliveryId || `legacy-${row.timeStamp || idx}`;
    if (row.action === 'delete') {
      delete byId[id];
      return;
    }
    if (row.action === 'confirm') {
      if (byId[id]) {
        byId[id].confirmation = {
          confirmedBy: row.confirmedBy || '',
          signatureData: row.signatureData || '',
          confirmNote: row.confirmNote || '',
          confirmTimestamp: row.confirmTimestamp || row.timeStamp || '',
        };
        const t = (byId[id].type || 'delivery').toLowerCase();
        byId[id].status = t === 'pickup' ? 'picked_up' : 'delivered';
      }
      return;
    }
    if (row.action === 'status') {
      if (byId[id]) byId[id].status = row.status || 'scheduled';
      return;
    }
    if (row.action === 'update') {
      byId[id] = { ...row, deliveryId: id };
      if (row.status) byId[id].status = row.status;
      else if (!byId[id].status) byId[id].status = 'scheduled';
      return;
    }
    byId[id] = { ...row, deliveryId: id };
    if (!byId[id].status) byId[id].status = 'scheduled';
  });
  return Object.values(byId).sort((a, b) => {
    const d = (a.date || '').localeCompare(b.date || '');
    return d !== 0 ? d : (a.timeStamp || '').localeCompare(b.timeStamp || '');
  });
}

async function loadSkus() {
  const res = await fetch('skus.json');
  skus = await res.json();
}

const QUANTITY_OPTIONS = [];
for (let n = 12; n <= 2400; n += 12) QUANTITY_OPTIONS.push(n);

function buildSkuSelect() {
  const select = document.createElement('select');
  select.name = 'sku';
  select.setAttribute('data-line-sku', '');
  select.innerHTML = '<option value="">Select SKU…</option>';
  skus.forEach((sku) => {
    const opt = document.createElement('option');
    opt.value = sku;
    opt.textContent = sku;
    select.appendChild(opt);
  });
  return select;
}

function buildQuantitySelect(initialValue) {
  const select = document.createElement('select');
  select.name = 'quantity';
  select.setAttribute('data-line-qty', '');
  select.innerHTML = '<option value="">Qty</option>';
  const valueNum = Number(initialValue) || 0;
  const hasCustom = valueNum > 0 && !QUANTITY_OPTIONS.includes(valueNum);
  if (hasCustom) {
    const opt = document.createElement('option');
    opt.value = String(valueNum);
    opt.textContent = valueNum;
    select.appendChild(opt);
  }
  QUANTITY_OPTIONS.forEach((n) => {
    const opt = document.createElement('option');
    opt.value = String(n);
    opt.textContent = n;
    select.appendChild(opt);
  });
  if (valueNum > 0) select.value = String(valueNum);
  return select;
}

function addLineRow() {
  lineItemsEmpty.hidden = true;
  const row = document.createElement('div');
  row.className = 'line-item-row';
  row.innerHTML = '';
  const skuSelect = buildSkuSelect();
  const qtySelect = buildQuantitySelect('');
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn remove-row';
  removeBtn.setAttribute('aria-label', 'Remove row');
  removeBtn.textContent = '−';
  removeBtn.addEventListener('click', () => {
    row.remove();
    if (!lineItemsContainer.querySelector('.line-item-row')) lineItemsEmpty.hidden = false;
  });
  row.append(skuSelect, qtySelect, removeBtn);
  lineItemsContainer.insertBefore(row, lineItemsEmpty);
}

function updateCustomerDatalist(deliveries) {
  const list = document.getElementById('customer-list');
  list.innerHTML = '';
  const names = new Set();
  if (Array.isArray(deliveries)) {
    deliveries.forEach((row) => {
      const name = (row.customer || row.location || '').trim();
      if (name) names.add(name);
    });
  }
  [...names].sort().forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    list.appendChild(opt);
  });
}

function showError(msg) {
  formError.textContent = msg || '';
  formError.hidden = !msg;
}

/** Returns { dateStr: { sku: totalQty } } for each day. */
function totalsByDateFromDeliveries(deliveries) {
  const byDate = {};
  if (!Array.isArray(deliveries)) return byDate;
  deliveries.forEach((row) => {
    const dateStr = (row.date && String(row.date).trim()) || '—';
    const totals = byDate[dateStr] || (byDate[dateStr] = {});
    if (row.lineItems) {
      try {
        const items = JSON.parse(row.lineItems);
        if (Array.isArray(items)) {
          items.forEach((it) => {
            const sku = it.sku && String(it.sku).trim();
            const qty = Number(it.quantity) || 0;
            if (sku && qty > 0) totals[sku] = (totals[sku] || 0) + qty;
          });
        }
      } catch (_) { /* ignore */ }
    } else if (row.sku && (row.volume != null)) {
      const sku = String(row.sku).trim();
      const qty = Number(row.volume) || 0;
      if (sku && qty > 0) totals[sku] = (totals[sku] || 0) + qty;
    }
  });
  return byDate;
}

function formatDateLabel(dateStr) {
  if (!dateStr || dateStr === '—') return dateStr;
  try {
    const d = new Date(`${dateStr}T12:00:00`);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString(undefined, {
        weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
      });
    }
  } catch (_) {}
  return dateStr;
}

/** Get ISO week Monday date as YYYY-MM-DD for a given date string. */
function getWeekKey(dateStr) {
  if (!dateStr || dateStr === '—') return null;
  try {
    const d = new Date(`${dateStr}T12:00:00`);
    if (Number.isNaN(d.getTime())) return null;
    const day = d.getDay();
    const daysSinceMonday = (day + 6) % 7;
    d.setDate(d.getDate() - daysSinceMonday);
    return d.toISOString().slice(0, 10);
  } catch (_) {}
  return null;
}

function formatWeekLabel(weekKey) {
  if (!weekKey) return weekKey;
  try {
    const d = new Date(`${weekKey}T12:00:00`);
    if (!Number.isNaN(d.getTime())) return `Week of ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  } catch (_) {}
  return weekKey;
}

/** Returns { weekKey: { sku: totalQty } } using ISO week (Monday start). */
function totalsByWeekFromDeliveries(deliveries) {
  const byDate = totalsByDateFromDeliveries(deliveries);
  const byWeek = {};
  Object.keys(byDate).forEach((dateStr) => {
    const weekKey = getWeekKey(dateStr);
    if (!weekKey) return;
    const weekTotals = byWeek[weekKey] || (byWeek[weekKey] = {});
    const dateTotals = byDate[dateStr];
    Object.keys(dateTotals).forEach((sku) => {
      weekTotals[sku] = (weekTotals[sku] || 0) + dateTotals[sku];
    });
  });
  return byWeek;
}

function renderTotalsBySku(deliveries) {
  const byDate = totalsByDateFromDeliveries(deliveries);
  const dates = Object.keys(byDate).sort();
  if (dates.length === 0) {
    totalsBySkuList.innerHTML = '<p class="empty">No data yet.</p>';
    return;
  }
  function summarizePretzelsBombsDips(totals) {
    let pretzels = 0; let bombs = 0; let
      dips = 0;
    Object.entries(totals || {}).forEach(([sku, qty]) => {
      const s = sku.toLowerCase();
      const n = Number(qty) || 0;
      if (s.includes('dip')) dips += n;
      else if (s.includes('bomb')) bombs += n;
      else pretzels += n;
    });
    return { pretzels, bombs, dips };
  }
  function formatWeekSummaryLine(totals) {
    const { pretzels, bombs, dips } = summarizePretzelsBombsDips(totals);
    const parts = [];
    if (pretzels > 0) parts.push(`Pretzels ${pretzels}`);
    if (bombs > 0) parts.push(`Bombs ${bombs}`);
    if (dips > 0) parts.push(`Dips ${dips}`);
    return parts.length ? parts.join('<span class="sep"> · </span>') : '—';
  }
  const byWeek = totalsByWeekFromDeliveries(deliveries);
  const weekKeys = Object.keys(byWeek).sort();
  const weeklyHtml = weekKeys.length === 0 ? '' : `<div class="totals-weekly-section"><h3>Weekly totals</h3>${weekKeys.map((weekKey) => {
    const totals = byWeek[weekKey];
    const summaryLine = formatWeekSummaryLine(totals);
    const entries = Object.entries(totals).sort((a, b) => a[0].localeCompare(b[0]));
    const rows = entries.map(([sku, qty]) => `<li><span class="sku-name">${escapeHtml(sku)}</span><span class="sku-qty">${escapeHtml(String(qty))}</span></li>`).join('');
    return `<div class="totals-date-group"><h3 class="totals-date">${escapeHtml(formatWeekLabel(weekKey))}</h3><p class="totals-week-summary">${summaryLine}</p><ul class="totals-date-sku-list">${rows}</ul></div>`;
  }).join('')}</div>`;
  const dailyHtml = `<div class="totals-by-day-section"><h3>By day</h3>${dates.map((dateStr) => {
    const totals = byDate[dateStr];
    const entries = Object.entries(totals).sort((a, b) => a[0].localeCompare(b[0]));
    const rows = entries.map(([sku, qty]) => `<li><span class="sku-name">${escapeHtml(sku)}</span><span class="sku-qty">${escapeHtml(String(qty))}</span></li>`).join('');
    return `<div class="totals-date-group"><h3 class="totals-date">${escapeHtml(formatDateLabel(dateStr))}</h3><ul class="totals-date-sku-list">${rows}</ul></div>`;
  }).join('')}</div>`;
  totalsBySkuList.innerHTML = weeklyHtml + dailyHtml;
}

/** Maps stored status (e.g. ready_deliver) to a CSS class token (ready-deliver). */
function statusToCssClassSuffix(status) {
  return String(status || 'scheduled').replace(/_/g, '-');
}

function renderDeliveryCard(row) {
  const type = (row.type || 'delivery').toLowerCase();
  const typeKey = type === 'pickup' ? 'pickup' : 'delivery';
  const typeLabel = type === 'pickup' ? 'Pickup' : 'Delivery';
  const customer = row.customer || row.location || '—';
  const status = row.status || 'scheduled';
  const id = escapeHtml(row.deliveryId || '');
  const statusOpts = STATUS_OPTIONS[typeKey] || STATUS_OPTIONS.delivery;
  const statusOptionsHtml = statusOpts
    .map((o) => {
      const sel = o.value === status ? ' selected' : '';
      return `<option value="${escapeHtml(o.value)}"${sel}>${escapeHtml(o.label)}</option>`;
    })
    .join('');
  let pillsHtml = '';
  let items = [];
  if (row.lineItems) {
    try {
      items = JSON.parse(row.lineItems);
      if (!Array.isArray(items)) items = [];
    } catch (_) {
      items = [];
    }
  } else if (row.sku && row.volume != null) {
    items = [{ sku: row.sku, quantity: Number(row.volume) || 0 }];
  }
  if (items.length) {
    pillsHtml = `<div class="card-items">${items.map((it) => `<span class="item-pill">${escapeHtml(it.sku || '—')} ×${escapeHtml(String(it.quantity || 0))}</span>`).join('')}</div>`;
  }
  const showConfirm = status === 'ready_deliver' || status === 'ready_pickup';
  const confirmedHtml = row.confirmation ? `<div class="card-confirmed">Confirmed by ${escapeHtml(row.confirmation.confirmedBy || '—')}</div>` : '';
  const recurrenceHtml = row.recurrenceId ? '<svg class="recurrence-icon" viewBox="0 0 24 24" fill="none" stroke="#999" stroke-width="2"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>' : '';
  return `
    <div class="delivery-card status-${escapeHtml(statusToCssClassSuffix(status))}" data-delivery-id="${id}">
      <div class="card-customer">
        <span><span class="type-badge ${type}">${typeLabel}</span> ${escapeHtml(customer)}${recurrenceHtml}</span>
        <div class="overflow-wrap">
          <button type="button" class="overflow-btn" data-overflow-toggle>&#8943;</button>
          <div class="overflow-menu">
            ${showConfirm ? `<button class="menu-confirm" data-action="confirm" data-delivery-id="${id}">Confirm delivery</button>` : ''}
            <button data-action="edit" data-delivery-id="${id}">Edit</button>
            <button data-action="duplicate" data-delivery-id="${id}">Duplicate</button>
            <button data-action="save-template" data-delivery-id="${id}">Save as template</button>
            <button class="menu-delete" data-action="delete" data-delivery-id="${id}">Delete</button>
          </div>
        </div>
      </div>
      ${pillsHtml}
      <div class="card-status-row">
        <select class="status-select" data-delivery-id="${id}" data-action="status" aria-label="Status">
          ${statusOptionsHtml}
        </select>
      </div>
      ${confirmedHtml}
    </div>`;
}

function getLastTypeForCustomer(customerName) {
  const name = (customerName || '').trim().toLowerCase();
  if (!name || !currentDeliveries.length) return null;
  const forCustomer = currentDeliveries.filter((row) => {
    const c = (row.customer || row.location || '').trim().toLowerCase();
    return c === name;
  });
  if (forCustomer.length === 0) return null;
  forCustomer.sort((a, b) => {
    const d = (b.date || '').localeCompare(a.date || '');
    return d !== 0 ? d : (b.timeStamp || '').localeCompare(a.timeStamp || '');
  });
  const type = (forCustomer[0].type || 'delivery').toLowerCase();
  return type === 'pickup' ? 'pickup' : 'delivery';
}

function defaultTypeFromCustomer() {
  if (deliveryIdInput.value) return;
  const type = getLastTypeForCustomer(form.customer.value);
  if (type) form.type.value = type;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Render week as a 7-column grid (Mon–Sun). */
function renderScheduleForWeek() {
  const { start } = getWeekRange(weekOffset);
  const todayStr = toDateStr(new Date());
  const byDate = {};
  currentDeliveries.forEach((row) => {
    const d = (row.date || '').trim();
    if (d) { if (!byDate[d]) byDate[d] = []; byDate[d].push(row); }
  });

  let html = '';
  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(start);
    dayDate.setDate(dayDate.getDate() + i);
    const dateStr = toDateStr(dayDate);
    const isToday = dateStr === todayStr;
    const dayDeliveries = byDate[dateStr] || [];
    const count = dayDeliveries.length;
    let countLabel = `${count} orders`;
    if (count === 0) countLabel = 'none';
    else if (count === 1) countLabel = '1 order';
    const emptyClass = count === 0 ? ' day-empty' : '';
    html += `<div class="day-column${isToday ? ' today' : ''}${emptyClass}">
      <div class="day-column-header">
        <span class="day-name">${DAY_NAMES[dayDate.getDay()]}</span>
        <span class="day-date">${dayDate.getDate()}</span>
        <span class="delivery-count">${countLabel}</span>
      </div>
      ${dayDeliveries.map((row) => renderDeliveryCard(row)).join('')}
    </div>`;
  }
  weekGrid.innerHTML = html;
  bindGridActions();
}

function bindGridActions() {
  // Overflow menu toggles
  weekGrid.querySelectorAll('[data-overflow-toggle]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = btn.nextElementSibling;
      // Close all other menus
      weekGrid.querySelectorAll('.overflow-menu.open').forEach((m) => { if (m !== menu) m.classList.remove('open'); });
      menu.classList.toggle('open');
    });
  });
  // Close menus on outside click
  document.addEventListener('click', () => {
    weekGrid.querySelectorAll('.overflow-menu.open').forEach((m) => m.classList.remove('open'));
  }, { once: false });

  weekGrid.querySelectorAll('[data-action="edit"]').forEach((btn) => {
    btn.addEventListener('click', () => startEdit(btn.dataset.deliveryId, currentDeliveries));
  });
  weekGrid.querySelectorAll('[data-action="duplicate"]').forEach((btn) => {
    btn.addEventListener('click', () => startDuplicate(btn.dataset.deliveryId, currentDeliveries));
  });
  weekGrid.querySelectorAll('[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', () => confirmDelete(btn.dataset.deliveryId));
  });
  weekGrid.querySelectorAll('[data-action="confirm"]').forEach((btn) => {
    btn.addEventListener('click', () => openConfirmModal(btn.dataset.deliveryId));
  });
  weekGrid.querySelectorAll('[data-action="save-template"]').forEach((btn) => {
    btn.addEventListener('click', () => saveTemplateFromDelivery(btn.dataset.deliveryId));
  });
  weekGrid.querySelectorAll('.status-select').forEach((sel) => {
    sel.addEventListener('change', () => updateDeliveryStatus(sel.dataset.deliveryId, sel.value));
  });
}

async function loadRecords() {
  try {
    const logs = await fetchLog(LOG_PATH);
    const deliveries = resolveDeliveriesFromLogs(logs);
    currentDeliveries = deliveries;
    updateCustomerDatalist(deliveries);
    renderTotalsBySku(deliveries);
    renderScheduleForWeek();
  } catch (e) {
    currentDeliveries = [];
    weekGrid.innerHTML = '<div class="week-empty">Could not load records. Check console.</div>';
    totalsBySkuList.innerHTML = '<p class="empty">—</p>';
    console.error('fetchLog error', e);
  }
}

form.customer.addEventListener('input', defaultTypeFromCustomer);
form.customer.addEventListener('change', defaultTypeFromCustomer);

function fillFormFromDelivery(row) {
  form.customer.value = row.customer || row.location || '';
  form.date.value = row.date || '';
  form.type.value = (row.type || 'delivery').toLowerCase();
  lineItemsEmpty.hidden = true;
  lineItemsContainer.querySelectorAll('.line-item-row').forEach((r) => r.remove());
  let items = [];
  if (row.lineItems) {
    try {
      items = JSON.parse(row.lineItems);
      if (!Array.isArray(items)) items = [];
    } catch (_) {}
  } else if (row.sku && (row.volume != null)) {
    items = [{ sku: row.sku, quantity: Number(row.volume) || 0 }];
  }
  items.forEach((it) => {
    const lineRow = document.createElement('div');
    lineRow.className = 'line-item-row';
    const skuSelect = buildSkuSelect();
    skuSelect.value = it.sku || '';
    const qtySelect = buildQuantitySelect(it.quantity || 0);
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn remove-row';
    removeBtn.setAttribute('aria-label', 'Remove row');
    removeBtn.textContent = '−';
    removeBtn.addEventListener('click', () => {
      lineRow.remove();
      if (!lineItemsContainer.querySelector('.line-item-row')) lineItemsEmpty.hidden = false;
    });
    lineRow.append(skuSelect, qtySelect, removeBtn);
    lineItemsContainer.insertBefore(lineRow, lineItemsEmpty);
  });
}

function startEdit(deliveryId, deliveries) {
  const map = Object.fromEntries((deliveries || []).map((d) => [d.deliveryId, d]));
  const row = map[deliveryId];
  if (!row) return;
  expandForm();
  fillFormFromDelivery(row);
  deliveryIdInput.value = deliveryId;
  submitBtn.textContent = 'Update delivery';
  cancelEditBtn.hidden = false;
  showError('');
  formCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function startDuplicate(deliveryId, deliveries) {
  const map = Object.fromEntries((deliveries || []).map((d) => [d.deliveryId, d]));
  const row = map[deliveryId];
  if (!row) return;
  expandForm();
  fillFormFromDelivery(row);
  deliveryIdInput.value = '';
  submitBtn.textContent = 'Schedule';
  cancelEditBtn.hidden = true;
  showError('');
  formCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function clearEditState() {
  deliveryIdInput.value = '';
  submitBtn.textContent = 'Schedule';
  cancelEditBtn.hidden = true;
  form.reset();
  document.getElementById('date').value = new Date().toISOString().slice(0, 10);
  lineItemsEmpty.hidden = false;
  lineItemsContainer.querySelectorAll('.line-item-row').forEach((r) => r.remove());
}

function confirmDelete(deliveryId) {
  if (!deliveryId) return;
  if (!window.confirm('Delete this delivery?')) return;
  (async () => {
    try {
      await appendLog(LOG_PATH, { action: 'delete', deliveryId, timeStamp: new Date().toISOString() });
      await loadRecords();
    } catch (err) {
      showError('Failed to delete.');
      console.error(err);
    }
  })();
}

async function updateDeliveryStatus(deliveryId, status) {
  if (!deliveryId || !status) return;
  try {
    await appendLog(LOG_PATH, {
      action: 'status',
      deliveryId,
      status,
      timeStamp: new Date().toISOString(),
    });
    await loadRecords();
  } catch (err) {
    showError('Failed to update status.');
    console.error(err);
  }
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

addRowBtn.addEventListener('click', addLineRow);

// ── Phase 2: Signature pad & confirmation modal ──
class SignaturePad {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.drawing = false;
    this.points = [];
    this.hasStrokes = false;
    this._resize();
    canvas.addEventListener('pointerdown', (e) => this._start(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', () => this._end());
    canvas.addEventListener('pointerleave', () => this._end());
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = rect.width;
    this.canvas.height = 150;
    this.ctx.lineWidth = 2;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.strokeStyle = '#1A1A1A';
  }

  _getPos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _start(e) {
    e.preventDefault();
    this.drawing = true;
    this.points = [this._getPos(e)];
    document.getElementById('sig-placeholder').style.display = 'none';
  }

  _move(e) {
    if (!this.drawing) return;
    e.preventDefault();
    const p = this._getPos(e);
    this.points.push(p);
    this.hasStrokes = true;
    this.ctx.beginPath();
    if (this.points.length > 1) {
      const prev = this.points[this.points.length - 2];
      this.ctx.moveTo(prev.x, prev.y);
      this.ctx.lineTo(p.x, p.y);
    }
    this.ctx.stroke();
  }

  _end() { this.drawing = false; }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.hasStrokes = false;
    this.points = [];
    document.getElementById('sig-placeholder').style.display = '';
  }

  isEmpty() { return !this.hasStrokes; }

  toDataURL() { return this.canvas.toDataURL('image/png'); }
}

let sigPad = null;
let confirmDeliveryId = null;

function openConfirmModal(deliveryId) {
  const row = currentDeliveries.find((d) => d.deliveryId === deliveryId);
  if (!row) return;
  confirmDeliveryId = deliveryId;
  const summary = document.getElementById('confirm-summary');
  const customer = row.customer || row.location || '—';
  let itemsHtml = '';
  try {
    const items = JSON.parse(row.lineItems || '[]');
    itemsHtml = items.map((it) => `${escapeHtml(it.sku)} x${it.quantity}`).join(', ');
  } catch (_) { itemsHtml = '—'; }
  summary.innerHTML = `<strong>${escapeHtml(customer)}</strong><div class="summary-items">${itemsHtml}</div>`;
  document.getElementById('confirm-receiver').value = '';
  document.getElementById('confirm-note').value = '';
  document.getElementById('confirm-error').hidden = true;
  document.getElementById('sig-section').style.display = '';
  document.getElementById('note-section').classList.remove('active');
  document.getElementById('sig-toggle').textContent = 'Add a note instead';
  if (!sigPad) sigPad = new SignaturePad(document.getElementById('sig-canvas'));
  sigPad.clear();
  document.getElementById('confirm-overlay').classList.add('open');
}

document.getElementById('sig-clear').addEventListener('click', () => { if (sigPad) sigPad.clear(); });

document.getElementById('sig-toggle').addEventListener('click', () => {
  const sigSec = document.getElementById('sig-section');
  const noteSec = document.getElementById('note-section');
  const toggle = document.getElementById('sig-toggle');
  if (noteSec.classList.contains('active')) {
    noteSec.classList.remove('active');
    sigSec.style.display = '';
    toggle.textContent = 'Add a note instead';
  } else {
    noteSec.classList.add('active');
    sigSec.style.display = 'none';
    toggle.textContent = 'Use signature instead';
  }
});

document.getElementById('confirm-cancel').addEventListener('click', () => {
  document.getElementById('confirm-overlay').classList.remove('open');
  confirmDeliveryId = null;
});

document.getElementById('confirm-submit').addEventListener('click', async () => {
  const errEl = document.getElementById('confirm-error');
  errEl.hidden = true;
  const receiver = document.getElementById('confirm-receiver').value.trim();
  if (!receiver) { errEl.textContent = 'Please enter who received the delivery.'; errEl.hidden = false; return; }
  const useSignature = document.getElementById('sig-section').style.display !== 'none';
  const note = document.getElementById('confirm-note').value.trim();
  if (useSignature && sigPad.isEmpty() && !note) {
    errEl.textContent = 'Please provide a signature or add a note.'; errEl.hidden = false; return;
  }
  if (!useSignature && !note) {
    errEl.textContent = 'Please add a delivery note.'; errEl.hidden = false; return;
  }
  const btn = document.getElementById('confirm-submit');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  const data = {
    action: 'confirm',
    deliveryId: confirmDeliveryId,
    confirmedBy: receiver,
    signatureData: useSignature && !sigPad.isEmpty() ? sigPad.toDataURL() : '',
    confirmNote: note,
    confirmTimestamp: new Date().toISOString(),
    timeStamp: new Date().toISOString(),
  };
  let retries = 3;
  while (retries > 0) {
    try {
      await appendLog(LOG_PATH, data);
      break;
    } catch (err) {
      retries--;
      if (retries === 0) {
        errEl.textContent = 'Failed to save. Check your connection and try again.';
        errEl.hidden = false;
        btn.disabled = false;
        btn.textContent = 'Confirm Delivery';
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  btn.disabled = false;
  btn.textContent = 'Confirm Delivery';
  document.getElementById('confirm-overlay').classList.remove('open');
  confirmDeliveryId = null;
  await loadRecords();
});

// ── Phase 3: Templates ──
const TEMPLATE_LOG_PATH = '/dangpretz/delivery-templates';
let currentTemplates = [];
let currentRecurrences = [];

function resolveTemplatesFromLogs(logs) {
  const byId = {};
  if (!Array.isArray(logs)) return [];
  logs.forEach((row) => {
    if (row.action === 'delete_template') { delete byId[row.templateId]; return; }
    if (row.action === 'create_template' || row.action === 'update_template') {
      byId[row.templateId] = { ...row };
    }
  });
  return Object.values(byId);
}

function resolveRecurrencesFromLogs(logs) {
  const byId = {};
  const generated = {};
  if (!Array.isArray(logs)) return { recurrences: [], generated };
  logs.forEach((row) => {
    if (row.action === 'delete_recurrence') { delete byId[row.recurrenceId]; return; }
    if (row.action === 'create_recurrence' || row.action === 'update_recurrence') {
      byId[row.recurrenceId] = { ...row };
    }
    if (row.action === 'recurrence_generated') {
      const key = `${row.recurrenceId}:${row.generatedDate}`;
      generated[key] = true;
    }
  });
  return { recurrences: Object.values(byId), generated };
}

async function loadTemplatesAndRecurrences() {
  try {
    const logs = await fetchLog(TEMPLATE_LOG_PATH);
    currentTemplates = resolveTemplatesFromLogs(logs);
    const recData = resolveRecurrencesFromLogs(logs);
    currentRecurrences = recData.recurrences;
    renderTemplateDropdown();
    renderTemplatesList();
    renderRecurrencesList();
    await generateRecurringDeliveries(recData);
  } catch (e) {
    console.error('Template log error', e);
    currentTemplates = [];
    currentRecurrences = [];
  }
}

function renderTemplateDropdown() {
  const dropdown = document.getElementById('template-dropdown');
  if (currentTemplates.length === 0) {
    dropdown.innerHTML = '<div class="tpl-empty">No templates yet. Save one from a delivery.</div>';
    return;
  }
  dropdown.innerHTML = currentTemplates.map((t) => {
    let summary = '';
    try {
      const items = JSON.parse(t.lineItems || '[]');
      summary = items.map((it) => `${it.sku} x${it.quantity}`).join(', ');
    } catch (_) {}
    return `<button type="button" class="tpl-item" data-template-id="${escapeHtml(t.templateId)}">
      <span class="tpl-name">${escapeHtml(t.templateName || t.customer || '—')}</span>
      <span class="tpl-summary">${escapeHtml(summary)}</span>
    </button>`;
  }).join('');
  dropdown.querySelectorAll('.tpl-item').forEach((btn) => {
    btn.addEventListener('click', () => loadTemplate(btn.dataset.templateId));
  });
}

document.getElementById('template-picker-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const dd = document.getElementById('template-dropdown');
  dd.classList.toggle('open');
});
document.addEventListener('click', () => {
  document.getElementById('template-dropdown').classList.remove('open');
});

function loadTemplate(templateId) {
  const tpl = currentTemplates.find((t) => t.templateId === templateId);
  if (!tpl) return;
  expandForm();
  form.customer.value = tpl.customer || '';
  form.type.value = (tpl.type || 'delivery').toLowerCase();
  lineItemsEmpty.hidden = true;
  lineItemsContainer.querySelectorAll('.line-item-row').forEach((r) => r.remove());
  let items = [];
  try { items = JSON.parse(tpl.lineItems || '[]'); } catch (_) {}
  items.forEach((it) => {
    const lineRow = document.createElement('div');
    lineRow.className = 'line-item-row';
    const skuSelect = buildSkuSelect();
    skuSelect.value = it.sku || '';
    const qtySelect = buildQuantitySelect(it.quantity || 0);
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn remove-row';
    removeBtn.setAttribute('aria-label', 'Remove row');
    removeBtn.textContent = '−';
    removeBtn.addEventListener('click', () => { lineRow.remove(); if (!lineItemsContainer.querySelector('.line-item-row')) lineItemsEmpty.hidden = false; });
    lineRow.append(skuSelect, qtySelect, removeBtn);
    lineItemsContainer.insertBefore(lineRow, lineItemsEmpty);
  });
  document.getElementById('template-dropdown').classList.remove('open');
  deliveryIdInput.value = '';
  submitBtn.textContent = 'Schedule';
  cancelEditBtn.hidden = true;
  showError('');
}

async function saveTemplateFromDelivery(deliveryId) {
  const row = currentDeliveries.find((d) => d.deliveryId === deliveryId);
  if (!row) return;
  try {
    await appendLog(TEMPLATE_LOG_PATH, {
      action: 'create_template',
      templateId: generateDeliveryId(),
      customer: row.customer || row.location || '',
      type: row.type || 'delivery',
      lineItems: row.lineItems || '[]',
      templateName: row.customer || row.location || 'Template',
      timeStamp: new Date().toISOString(),
    });
    await loadTemplatesAndRecurrences();
  } catch (err) {
    console.error('Save template error', err);
  }
}

function renderTemplatesList() {
  const list = document.getElementById('tpl-list');
  if (currentTemplates.length === 0) {
    list.innerHTML = '<li class="mgmt-empty">No templates saved yet.</li>';
    return;
  }
  list.innerHTML = currentTemplates.map((t) => {
    let summary = '';
    try {
      const items = JSON.parse(t.lineItems || '[]');
      summary = items.map((it) => `${it.sku} x${it.quantity}`).join(', ');
    } catch (_) {}
    return `<li>
      <div class="tpl-info">
        <div class="tpl-name">${escapeHtml(t.templateName || t.customer || '—')}</div>
        <div class="tpl-items-summary">${escapeHtml(summary)}</div>
      </div>
      <div class="tpl-actions">
        <button style="background:#C41E1E;color:#fff" data-tpl-use="${escapeHtml(t.templateId)}">Use</button>
        <button style="background:#8B0000;color:#fff" data-tpl-delete="${escapeHtml(t.templateId)}">Delete</button>
      </div>
    </li>`;
  }).join('');
  list.querySelectorAll('[data-tpl-use]').forEach((btn) => {
    btn.addEventListener('click', () => { loadTemplate(btn.dataset.tplUse); formCard.scrollIntoView({ behavior: 'smooth' }); });
  });
  list.querySelectorAll('[data-tpl-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!window.confirm('Delete this template?')) return;
      await appendLog(TEMPLATE_LOG_PATH, { action: 'delete_template', templateId: btn.dataset.tplDelete, timeStamp: new Date().toISOString() });
      await loadTemplatesAndRecurrences();
    });
  });
}

// Management section tabs
document.querySelectorAll('.mgmt-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.mgmt-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.mgmt-panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
  });
});

// Collapsible management section
const mgmtToggle = document.getElementById('mgmt-toggle');
const mgmtBody = document.getElementById('mgmt-body');
const mgmtCard = document.getElementById('mgmt-card');
mgmtToggle.addEventListener('click', () => {
  const isOpen = mgmtBody.classList.toggle('expanded');
  mgmtCard.classList.toggle('open', isOpen);
});

// ── Phase 4: Recurring deliveries ──
const recurringCheck = document.getElementById('recurring-check');
const recurringFields = document.getElementById('recurring-fields');
recurringCheck.addEventListener('change', () => {
  recurringFields.classList.toggle('active', recurringCheck.checked);
});

// Auto-set day of week from date field
document.getElementById('date').addEventListener('change', () => {
  if (recurringCheck.checked) {
    const d = new Date(`${document.getElementById('date').value}T12:00:00`);
    if (!Number.isNaN(d.getTime())) {
      document.getElementById('day-of-week').value = String(d.getDay());
    }
  }
});

async function generateRecurringDeliveries(recData) {
  const { recurrences, generated } = recData;
  if (!recurrences.length) return;
  const horizon = new Date();
  horizon.setDate(horizon.getDate() + 28);
  const horizonStr = toDateStr(horizon);
  const todayStr = toDateStr(new Date());
  let didGenerate = false;

  for (const rec of recurrences) {
    const freq = rec.frequency === 'biweekly' ? 14 : 7;
    const startDate = rec.startDate || todayStr;
    const endDate = rec.endDate || null;
    const dayOfWeek = Number(rec.dayOfWeek);
    // Find the first occurrence on or after startDate
    const cursor = new Date(`${startDate}T12:00:00`);
    // Align to the correct day of week
    while (cursor.getDay() !== dayOfWeek) cursor.setDate(cursor.getDate() + 1);

    while (toDateStr(cursor) <= horizonStr) {
      const dateStr = toDateStr(cursor);
      if (endDate && dateStr > endDate) break;
      if (dateStr >= todayStr) {
        const genKey = `${rec.recurrenceId}:${dateStr}`;
        if (!generated[genKey]) {
          const newId = generateDeliveryId();
          try {
            await appendLog(LOG_PATH, {
              action: 'create',
              deliveryId: newId,
              customer: rec.customer || '',
              date: dateStr,
              type: rec.type || 'delivery',
              lineItems: rec.lineItems || '[]',
              status: 'scheduled',
              recurrenceId: rec.recurrenceId,
              timeStamp: new Date().toISOString(),
            });
            await appendLog(TEMPLATE_LOG_PATH, {
              action: 'recurrence_generated',
              recurrenceId: rec.recurrenceId,
              generatedDate: dateStr,
              deliveryId: newId,
              timeStamp: new Date().toISOString(),
            });
            generated[genKey] = true;
            didGenerate = true;
          } catch (err) {
            console.error('Recurrence generation error', err);
          }
        }
      }
      cursor.setDate(cursor.getDate() + freq);
    }
  }
  if (didGenerate) {
    // Reload deliveries to show newly generated ones
    const logs = await fetchLog(LOG_PATH);
    currentDeliveries = resolveDeliveriesFromLogs(logs);
    renderScheduleForWeek();
    renderTotalsBySku(currentDeliveries);
  }
}

function renderRecurrencesList() {
  const list = document.getElementById('rec-list');
  if (currentRecurrences.length === 0) {
    list.innerHTML = '<li class="mgmt-empty">No recurring orders set up yet.</li>';
    return;
  }
  const freqLabel = { weekly: 'Weekly', biweekly: 'Every 2 weeks' };
  list.innerHTML = currentRecurrences.map((rec) => {
    const day = DAY_NAMES[Number(rec.dayOfWeek)] || '?';
    let summary = '';
    try {
      const items = JSON.parse(rec.lineItems || '[]');
      summary = items.map((it) => `${it.sku} x${it.quantity}`).join(', ');
    } catch (_) {}
    return `<li>
      <div class="rec-info">
        <div class="rec-customer">${escapeHtml(rec.customer || '—')}</div>
        <div class="rec-detail">${escapeHtml(freqLabel[rec.frequency] || rec.frequency)} on ${escapeHtml(day)}${rec.endDate ? ` until ${escapeHtml(rec.endDate)}` : ''}</div>
        <div class="rec-detail">${escapeHtml(summary)}</div>
      </div>
      <div class="rec-actions">
        <button style="background:#8B0000;color:#fff" data-rec-delete="${escapeHtml(rec.recurrenceId)}">Delete</button>
      </div>
    </li>`;
  }).join('');
  list.querySelectorAll('[data-rec-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!window.confirm('Delete this recurring order?')) return;
      await appendLog(TEMPLATE_LOG_PATH, { action: 'delete_recurrence', recurrenceId: btn.dataset.recDelete, timeStamp: new Date().toISOString() });
      await loadTemplatesAndRecurrences();
    });
  });
}

// ── Enhanced form submit (templates + recurrences) ──
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  const customer = form.customer.value.trim();
  const date = form.date.value.trim();
  const type = form.type.value;
  const rows = lineItemsContainer.querySelectorAll('.line-item-row');
  const lineItems = [];
  rows.forEach((row) => {
    const sku = row.querySelector('[data-line-sku]').value;
    const qty = row.querySelector('[data-line-qty]').value.trim();
    if (sku && qty && Number(qty) > 0) lineItems.push({ sku, quantity: Number(qty) });
  });

  if (!customer || !date || !type) {
    showError('Please fill in customer, date, and type.');
    return;
  }
  if (lineItems.length === 0) {
    showError('Add at least one line item (SKU + quantity).');
    return;
  }

  submitBtn.disabled = true;
  const editingId = deliveryIdInput.value.trim();
  const timeStamp = new Date().toISOString();
  const lineItemsJson = JSON.stringify(lineItems);
  try {
    if (editingId) {
      await appendLog(LOG_PATH, {
        action: 'update',
        deliveryId: editingId,
        customer,
        date,
        type,
        lineItems: lineItemsJson,
        status: 'scheduled',
        timeStamp,
      });
    } else {
      await appendLog(LOG_PATH, {
        action: 'create',
        deliveryId: generateDeliveryId(),
        customer,
        date,
        type,
        lineItems: lineItemsJson,
        status: 'scheduled',
        timeStamp,
      });
    }
    // Save as template if checked
    if (document.getElementById('save-template-check').checked && !editingId) {
      await appendLog(TEMPLATE_LOG_PATH, {
        action: 'create_template',
        templateId: generateDeliveryId(),
        customer,
        type,
        lineItems: lineItemsJson,
        templateName: customer,
        timeStamp,
      });
    }
    // Create recurrence if checked
    if (recurringCheck.checked && !editingId) {
      await appendLog(TEMPLATE_LOG_PATH, {
        action: 'create_recurrence',
        recurrenceId: generateDeliveryId(),
        customer,
        type,
        lineItems: lineItemsJson,
        frequency: document.getElementById('frequency').value,
        dayOfWeek: document.getElementById('day-of-week').value,
        startDate: date,
        endDate: document.getElementById('recurrence-end').value || '',
        timeStamp,
      });
    }
    clearEditState();
    recurringCheck.checked = false;
    recurringFields.classList.remove('active');
    document.getElementById('save-template-check').checked = false;
    formBody.classList.remove('expanded');
    formCard.classList.remove('open');
    await loadRecords();
    await loadTemplatesAndRecurrences();
  } catch (err) {
    showError('Failed to save. Try again.');
    console.error('appendLog error', err);
  } finally {
    submitBtn.disabled = false;
  }
});

cancelEditBtn.addEventListener('click', () => {
  clearEditState();
  showError('');
});

const today = new Date();
document.getElementById('date').value = today.toISOString().slice(0, 10);

(async () => {
  await loadSkus();
  await loadRecords();
  await loadTemplatesAndRecurrences();
})();

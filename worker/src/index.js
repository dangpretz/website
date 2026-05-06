import {
  resolveDeliveries,
  resolveProductionLogs,
  getInventoryReport,
  makeSkuMeta,
  scheduleCheese,
  CHEESE_BATCH_SIZE,
  CHEESE_KEY,
  CHEESE_MAX_LEAD,
} from '../../scripts/inventory.js';

const SQUARE_BASE = 'https://connect.squareup.com/v2';

/**
 * Convert a form date (YYYY-MM-DD) + time (H:MM AM/PM) into an RFC 3339 datetime
 * anchored to America/Denver, with the correct DST-aware offset (MST or MDT).
 * Throws on malformed input — caller should catch.
 */
function toDenverISO(dateStr, timeStr) {
  const [yy, mm, dd] = dateStr.split('-').map(Number);
  const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) throw new Error(`Bad time: ${timeStr}`);
  let h = Number(match[1]);
  const min = Number(match[2]);
  const pm = match[3].toUpperCase() === 'PM';
  if (pm && h !== 12) h += 12;
  if (!pm && h === 12) h = 0;

  // Derive America/Denver offset for the given date via Intl (handles MST/MDT)
  const probe = new Date(Date.UTC(yy, mm - 1, dd, 12, 0, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    timeZoneName: 'shortOffset',
  }).formatToParts(probe);
  const offPart = parts.find((p) => p.type === 'timeZoneName').value; // "GMT-6"
  const offHours = Number(offPart.match(/GMT([+-]\d+)/)[1]);
  const sign = offHours < 0 ? '-' : '+';
  const offset = `${sign}${String(Math.abs(offHours)).padStart(2, '0')}:00`;

  const pad = (n) => String(n).padStart(2, '0');
  return `${dateStr}T${pad(h)}:${pad(min)}:00${offset}`;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

// ════════════════════════════════════════════════════════════════════
// TEMP: one-off admin endpoints to backfill SCHEDULED fulfillment on
// recently-paid catering orders that were created before this fix shipped.
// REMOVE this whole block + the routing in fetch() after cleanup is done.
// ════════════════════════════════════════════════════════════════════

function checkAdminToken(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return json({ error: 'Unauthorized' }, 401);
  }
  return null;
}

function parseOrderNote(note) {
  if (!note) return null;
  const out = { type: null, date: null, time: null, address: null, notes: null, iso_scheduled_at: null };
  for (const raw of note.split('\n')) {
    const line = raw.trim();
    const m = line.match(/^([^:]+):\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2];
    if (key === 'fulfillment') out.type = val.toLowerCase();
    else if (key === 'date/time') {
      const dm = val.match(/^(\d{4}-\d{2}-\d{2})\s+at\s+(\d{1,2}:\d{2}\s*[AP]M)$/i);
      if (dm) {
        out.date = dm[1];
        out.time = dm[2];
      }
    } else if (key === 'delivery address') out.address = val;
    else if (key === 'notes') out.notes = val;
  }
  if (out.date && out.time) {
    try {
      out.iso_scheduled_at = toDenverISO(out.date, out.time);
    } catch (_) {
      out.iso_scheduled_at = null;
    }
  }
  return out;
}

async function handleListRecentCatering(request, env) {
  const authErr = checkAdminToken(request, env);
  if (authErr) return authErr;

  const locationId = env.SQUARE_LOCATION_ID || 'LEJ3PDZ9V6NYN';
  const startAt = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  const url = new URL(request.url);
  const raw = url.searchParams.get('raw') === '1';

  // Paginate through orders for the last 14 days. Square caps limit at 500.
  const allOrders = [];
  let cursor;
  let pageCount = 0;
  do {
    const sqRes = await fetch(`${SQUARE_BASE}/orders/search`, {
      method: 'POST',
      headers: {
        'Square-Version': '2025-01-23',
        Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        location_ids: [locationId],
        query: {
          filter: {
            date_time_filter: { created_at: { start_at: startAt } },
            state_filter: { states: ['OPEN', 'COMPLETED', 'CANCELED'] },
          },
          sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' },
        },
        limit: 500,
        cursor,
      }),
    });
    const sqData = await sqRes.json();
    if (!sqRes.ok) return json({ error: 'Square search failed', details: sqData }, 500);
    allOrders.push(...(sqData.orders || []));
    cursor = sqData.cursor;
    pageCount += 1;
    if (pageCount > 20) break; // safety: max 10k orders
  } while (cursor);

  // Catering orders come through our Payment Links → source.name = "DPC Website"
  const orders = raw
    ? allOrders
    : allOrders.filter((o) => o.source?.name === 'DPC Website');

  const summary = orders.map((o) => {
    const parsed = parseOrderNote(o.note);
    const hasScheduled = (o.fulfillments || []).some((f) =>
      f?.pickup_details?.schedule_type === 'SCHEDULED'
      || f?.delivery_details?.schedule_type === 'SCHEDULED',
    );
    return {
      order_id: o.id,
      version: o.version,
      state: o.state,
      created_at: o.created_at,
      total: o.total_money,
      source_name: o.source?.name || null,
      buyer_email: o.tenders?.[0]?.buyer_email_address || null,
      already_scheduled: hasScheduled,
      parsed,
      note: o.note || null,
      current_fulfillments: o.fulfillments || [],
    };
  });

  return json({
    count: summary.length,
    total_returned_by_square: allOrders.length,
    location_id: locationId,
    since: startAt,
    raw_mode: raw,
    orders: summary,
  });
}

async function handleFixFulfillment(request, env) {
  const authErr = checkAdminToken(request, env);
  if (authErr) return authErr;

  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'Invalid JSON' }, 400); }

  const { order_id, type, scheduled_at, name, email, phone, address } = body;
  if (!order_id) return json({ error: 'order_id required' }, 400);
  if (!type || !['pickup', 'delivery'].includes(type)) return json({ error: 'type must be pickup or delivery' }, 400);
  if (!scheduled_at) return json({ error: 'scheduled_at required (ISO 8601)' }, 400);
  if (!name || !email || !phone) return json({ error: 'name, email, phone required' }, 400);

  const phoneDigits = phone.replace(/\D/g, '');
  let e164Phone;
  if (phoneDigits.length === 10) e164Phone = `+1${phoneDigits}`;
  else if (phoneDigits.length === 11 && phoneDigits.startsWith('1')) e164Phone = `+${phoneDigits}`;
  else e164Phone = `+${phoneDigits}`;

  // Fetch current order to get the version (required for UpdateOrder)
  const fetchRes = await fetch(`${SQUARE_BASE}/orders/${order_id}`, {
    headers: {
      'Square-Version': '2025-01-23',
      Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
    },
  });
  const fetchData = await fetchRes.json();
  if (!fetchRes.ok) return json({ error: 'Could not fetch order', details: fetchData }, 500);
  const currentVersion = fetchData.order?.version;
  if (currentVersion == null) return json({ error: 'Could not determine order version' }, 500);

  const recipient = {
    display_name: name,
    email_address: email,
    phone_number: e164Phone,
  };

  let fulfillments;
  if (type === 'delivery') {
    fulfillments = [
      {
        type: 'DELIVERY',
        state: 'PROPOSED',
        delivery_details: {
          schedule_type: 'SCHEDULED',
          deliver_at: scheduled_at,
          recipient: {
            ...recipient,
            ...(address ? { address: { address_line_1: address, country: 'US' } } : {}),
          },
        },
      },
    ];
  } else {
    fulfillments = [
      {
        type: 'PICKUP',
        state: 'PROPOSED',
        pickup_details: {
          schedule_type: 'SCHEDULED',
          pickup_at: scheduled_at,
          recipient,
        },
      },
    ];
  }

  const updateRes = await fetch(`${SQUARE_BASE}/orders/${order_id}`, {
    method: 'PUT',
    headers: {
      'Square-Version': '2025-01-23',
      Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: env.SQUARE_LOCATION_ID || 'LEJ3PDZ9V6NYN',
        version: currentVersion,
        fulfillments,
      },
    }),
  });
  const updateData = await updateRes.json();
  if (!updateRes.ok) return json({ error: 'Update failed', details: updateData }, 500);

  return json({ ok: true, order_id, new_version: updateData.order?.version, fulfillments: updateData.order?.fulfillments });
}

// ════════════════════════════════════════════════════════════════════
// END TEMP admin endpoints
// ════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════
// SQUARE → DELIVERY PLANNER SYNC
// ────────────────────────────────────────────────────────────────────
// Pulls catering orders from Square (any with a PICKUP/DELIVERY
// fulfillment) and writes them to the delivery-planner sheet log so
// they appear in the planner UI and downstream production calendar.
//
// Two entry points share one sync function:
//   POST /admin/import-catering   — backfill / on-demand sync (token-protected)
//   POST /webhooks/square         — real-time webhook (signature-verified)
//
// Idempotent — uses `sq_<order_id>` as the deliveryId, so re-runs and
// webhook re-deliveries don't create duplicates. resolveDeliveriesFromLogs
// in the planner does last-write-wins per deliveryId.
// ════════════════════════════════════════════════════════════════════

const SHEET_LOGGER_BASE = 'https://sheet-logger.david8603.workers.dev';
const DELIVERY_LOG_PATH = '/dangpretz/delivery-planner';

// Square line-item display names → canonical SKUs in skus.json.
// Keys are lowercase + trimmed. Add entries here when an unmapped name
// shows up in the import response.
const SQUARE_NAME_MAP = {
  '10oz bbk':                    '10oz bbk',
  '10oz bbk pretzel':            '10oz bbk',
  '10oz plain':                  '10oz plain',
  '10oz plain pretzel':          '10oz plain',
  '10oz spicy bee':              '10oz spicy bee',
  '10oz spicy bee pretzel':      '10oz spicy bee',
  '10oz mustache':               '10oz mustache',
  '10oz mustache pretzel':       '10oz mustache',
  '21oz mammoth':                '21oz mammoth pretzel',
  '21oz mammoth pretzel':        '21oz mammoth pretzel',
  '6.5oz bbk':                   '6.5oz bbk',
  '6.5oz bbk pretzel':           '6.5oz bbk',
  '6.5oz plain':                 '6.5oz plain',
  '6.5oz plain pretzel':         '6.5oz plain',
  '6.5oz spicy bee':             '6.5oz spicy bee',
  '6.5oz spicy bee pretzel':     '6.5oz spicy bee',
  '4oz twist plain':             '4oz twist plain',
  '4oz twist bbk':               '4oz twist bbk',
  '4oz twist spicy bee':         '4oz twist spicy bee',
  '3oz cheese dip':              '3oz cheese dip',
  'cheese dip':                  '3oz cheese dip',
  'cheese dip 3oz':              '3oz cheese dip',
  'dangerous dip':               'bulk dangerous dip (25 srv)',
  'bulk dangerous dip':          'bulk dangerous dip (25 srv)',
  'plain bombs':                 'plain bombs',
  'bees bats':                   'bees bats',
};

// Canonical SKU set for fuzzy fallback matching
const CANONICAL_SKUS = [...new Set(Object.values(SQUARE_NAME_MAP))];

function mapSquareToCanonicalSku(name, variation) {
  if (!name) return null;
  const tries = [
    `${name} ${variation || ''}`.trim().toLowerCase(),
    name.trim().toLowerCase(),
  ];
  for (const t of tries) {
    if (SQUARE_NAME_MAP[t]) return SQUARE_NAME_MAP[t];
  }
  // Fuzzy: substring match
  const lower = name.toLowerCase();
  for (const canonical of CANONICAL_SKUS) {
    if (lower.includes(canonical.toLowerCase())) return canonical;
  }
  return null;
}

function formatSquareAddress(addr) {
  if (!addr) return '';
  const parts = [
    addr.address_line_1,
    addr.address_line_2,
    [addr.locality, addr.administrative_district_level_1].filter(Boolean).join(', '),
    addr.postal_code,
  ].filter(Boolean);
  return parts.join(', ');
}

// Sync a single Square order to the delivery planner log.
// Optional invoiceCtx lets us sync invoiced orders that have no fulfillment
// — date/recipient come from the invoice instead.
async function syncSquareOrderToDelivery(squareOrder, invoiceCtx = null) {
  const id = squareOrder.id;
  if (!id) return { skipped: 'no order id' };

  // Find the first PICKUP or DELIVERY fulfillment if any
  const ful = (squareOrder.fulfillments || []).find(
    (f) => f && (f.type === 'PICKUP' || f.type === 'DELIVERY'),
  );

  // Resolve fulfillment date — fulfillment > invoice due_date > note
  const pickupAt = ful?.pickup_details?.pickup_at;
  const deliverAt = ful?.delivery_details?.deliver_at;
  let scheduledIso = pickupAt || deliverAt || null;
  if (!scheduledIso) {
    const parsed = parseOrderNote(squareOrder.note);
    if (parsed?.iso_scheduled_at) scheduledIso = parsed.iso_scheduled_at;
  }
  if (!scheduledIso && invoiceCtx?.dueDate) {
    // Invoice due_date is a YYYY-MM-DD string — anchor to noon Mountain
    scheduledIso = `${invoiceCtx.dueDate}T12:00:00-06:00`;
  }
  if (!scheduledIso) return { orderId: id, skipped: 'no fulfillment date' };
  const date = scheduledIso.slice(0, 10);

  // Customer / contact — prefer fulfillment recipient, fall back to invoice
  const recipient =
    ful?.pickup_details?.recipient ||
    ful?.delivery_details?.recipient ||
    invoiceCtx?.recipient ||
    {};
  // Drop placeholder family names like "NA" / "N/A" / "-"
  const cleanFamily = /^(na|n\/a|-+|none)$/i.test(recipient.family_name || '') ? '' : (recipient.family_name || '');
  const personName = [recipient.given_name, cleanFamily].filter(Boolean).join(' ').trim();
  const company = recipient.company_name || invoiceCtx?.recipient?.company_name || '';
  // For B2B catering, prefer "Person · Company" or just Company if no person
  const customer =
    recipient.display_name
    || (personName && company ? `${personName} · ${company}` : (personName || company))
    || invoiceCtx?.title
    || squareOrder.customer_id
    || 'Square Order';
  const phone = recipient.phone_number || '';
  const email = recipient.email_address || '';
  // Invoice orders without fulfillment default to delivery (caterings usually deliver)
  // unless an explicit pickup signal exists in the note
  const isPickup = ful?.type === 'PICKUP' || /pickup/i.test(squareOrder.note || '');
  const inferredType = ful?.type ? ful.type : (isPickup ? 'PICKUP' : 'DELIVERY');
  const address =
    inferredType === 'DELIVERY'
      ? formatSquareAddress(recipient.address)
      : '';

  // Map line items, dropping the synthetic "Delivery Fee"
  const rawItems = squareOrder.line_items || [];
  const mappedItems = [];
  const unmappedNames = [];
  for (const li of rawItems) {
    if (li.name === 'Delivery Fee') continue;
    const sku = mapSquareToCanonicalSku(li.name, li.variation_name);
    const quantity = parseInt(li.quantity, 10) || 0;
    if (quantity <= 0) continue;
    if (sku) {
      mappedItems.push({ sku, quantity });
    } else {
      // Still include with raw name — production app's "new SKU" prompt
      // will surface it for the manager to set up
      mappedItems.push({ sku: li.name, quantity });
      unmappedNames.push(li.name);
    }
  }
  if (mappedItems.length === 0) {
    return { orderId: id, skipped: 'no line items' };
  }

  // Status mapping
  let status = 'scheduled';
  let action = 'update'; // upsert via deliveryId
  if (squareOrder.state === 'CANCELED' || ful?.state === 'CANCELED') {
    action = 'delete'; // remove from planner active set
    status = 'cancelled';
  } else if (ful?.state === 'COMPLETED') {
    status = inferredType === 'PICKUP' ? 'picked_up' : 'delivered';
  }

  // Capture description / note for the planner (invoice description often
  // has setup-time hints e.g. "320 day - Setup by 1:55")
  const orderNote = squareOrder.note || invoiceCtx?.description || '';

  // Build URL params for sheet-logger (delivery-planner appendLog format)
  const params = new URLSearchParams({
    action,
    deliveryId: `sq_${id}`,
    customer,
    date,
    type: inferredType.toLowerCase(),
    lineItems: JSON.stringify(mappedItems),
    status,
    timeStamp: new Date().toISOString(),
    _source: invoiceCtx ? 'square-invoice' : 'square',
    _squareOrderId: id,
  });
  if (phone)     params.set('contactPhone', phone);
  if (email)     params.set('contactEmail', email);
  if (address)   params.set('address', address);
  if (orderNote) params.set('notes', orderNote.slice(0, 500));

  const resp = await fetch(
    `${SHEET_LOGGER_BASE}${DELIVERY_LOG_PATH}?${params.toString()}`,
    { method: 'POST' },
  );

  return {
    orderId: id,
    deliveryId: `sq_${id}`,
    customer,
    date,
    type: inferredType.toLowerCase(),
    status,
    action,
    items: mappedItems.length,
    unmappedItems: unmappedNames,
    via: invoiceCtx ? 'invoice' : 'order',
    ok: resp.ok,
    httpStatus: resp.status,
  };
}

async function fetchSquareCateringOrders(env, { sinceDays = 90 } = {}) {
  // Wider window than recent-catering — backfill needs to catch the May-15
  // pending order which could have been created weeks ago. 90 days is the
  // pragmatic ceiling (Square's filter is created_at, not fulfilled_at).
  const locationId = env.SQUARE_LOCATION_ID || 'LEJ3PDZ9V6NYN';
  const startAt = new Date(Date.now() - sinceDays * 86400e3).toISOString();
  const all = [];
  let cursor;
  let pageCount = 0;
  do {
    const sqRes = await fetch(`${SQUARE_BASE}/orders/search`, {
      method: 'POST',
      headers: {
        'Square-Version': '2025-01-23',
        Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        location_ids: [locationId],
        query: {
          filter: {
            date_time_filter: { created_at: { start_at: startAt } },
            state_filter: { states: ['OPEN', 'COMPLETED', 'CANCELED'] },
          },
          sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' },
        },
        limit: 500,
        cursor,
      }),
    });
    const data = await sqRes.json();
    if (!sqRes.ok) {
      throw new Error(`Square search failed: ${JSON.stringify(data).slice(0, 300)}`);
    }
    all.push(...(data.orders || []));
    cursor = data.cursor;
    pageCount += 1;
    if (pageCount > 20) break;
  } while (cursor);

  // Strict catering filter — retail Square POS orders also set schedule_type=SCHEDULED
  // for pickup, so that signal alone is too loose. Real catering signals:
  //   1. source.name === 'DPC Website' (our catering form / payment-link flow)
  //   2. Any line item name starts with "Catering:" (your catering catalog convention)
  // AND the fulfillment date (if present) is not in the past — manager doesn't
  // want past retail-style orders polluting the planner.
  // Invoice-flow orders are handled separately by fetchSquareInvoiceOrders.
  const todayStr = new Date().toISOString().slice(0, 10);
  return all.filter((o) => {
    const isCatering =
      o.source?.name === 'DPC Website'
      || (o.line_items || []).some((li) => /^catering:/i.test(li.name || ''));
    if (!isCatering) return false;
    // Skip past fulfillments
    const ful = (o.fulfillments || []).find(
      (f) => f && (f.type === 'PICKUP' || f.type === 'DELIVERY'),
    );
    const at = ful?.pickup_details?.pickup_at || ful?.delivery_details?.deliver_at;
    if (at && at.slice(0, 10) < todayStr) return false;
    return true;
  });
}

// Search Square invoices and return paired (order, invoiceCtx) for each one
// linked to a real catering order. Status filter: SENT/SCHEDULED/PARTIALLY_PAID/PAID
// — anything that's still operationally pending fulfillment.
async function fetchSquareInvoiceOrders(env, { onlyFutureDays = null } = {}) {
  const locationId = env.SQUARE_LOCATION_ID || 'LEJ3PDZ9V6NYN';
  const out = [];
  let cursor;
  let pageCount = 0;
  do {
    const r = await fetch(`${SQUARE_BASE}/invoices/search`, {
      method: 'POST',
      headers: {
        'Square-Version': '2025-01-23',
        Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: { filter: { location_ids: [locationId] } },
        limit: 100,
        cursor,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      throw new Error(`Square invoices.search failed: ${JSON.stringify(data).slice(0, 300)}`);
    }
    for (const inv of (data.invoices || [])) {
      // Skip drafts / cancelled / failed — only sync invoices that represent real bookings
      if (!['UNPAID','SCHEDULED','PARTIALLY_PAID','PAID','PAYMENT_PENDING'].includes(inv.status)) continue;
      const dueDate = inv.payment_requests?.[0]?.due_date;
      if (!dueDate) continue;
      // Skip past deliveries by default (manager only cares about upcoming)
      if (onlyFutureDays != null) {
        const today = new Date().toISOString().slice(0, 10);
        if (dueDate < today) continue;
        // Cap at N days into the future so we don't sync invoices for events 6 months out
        const cap = new Date(Date.now() + onlyFutureDays * 86400e3).toISOString().slice(0, 10);
        if (dueDate > cap) continue;
      }
      if (!inv.order_id) continue;

      // Fetch the order
      const oRes = await fetch(`${SQUARE_BASE}/orders/${inv.order_id}`, {
        headers: {
          'Square-Version': '2025-01-23',
          Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        },
      });
      const oData = await oRes.json();
      if (!oRes.ok || !oData.order) continue;

      out.push({
        order: oData.order,
        invoiceCtx: {
          invoiceId: inv.id,
          dueDate,
          recipient: inv.primary_recipient || {},
          title: inv.title || '',
          description: inv.description || '',
          status: inv.status,
        },
      });
    }
    cursor = data.cursor;
    pageCount += 1;
    if (pageCount > 10) break; // safety cap
  } while (cursor);
  return out;
}

// TEMP debug helper — fetches a Square order or invoice for inspection.
// Remove once invoice import flow is dialed in.
async function handleInspectSquare(request, env) {
  const authErr = checkAdminToken(request, env);
  if (authErr) return authErr;
  const url = new URL(request.url);
  const orderId = url.searchParams.get('order');
  const invoiceId = url.searchParams.get('invoice');

  if (orderId) {
    const r = await fetch(`${SQUARE_BASE}/orders/${orderId}`, {
      headers: { 'Square-Version': '2025-01-23', Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}` },
    });
    return json(await r.json());
  }
  if (invoiceId) {
    const r = await fetch(`${SQUARE_BASE}/invoices/${invoiceId}`, {
      headers: { 'Square-Version': '2025-01-23', Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}` },
    });
    return json(await r.json());
  }
  // List recent invoices
  const r = await fetch(`${SQUARE_BASE}/invoices/search`, {
    method: 'POST',
    headers: {
      'Square-Version': '2025-01-23',
      Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: { filter: { location_ids: [env.SQUARE_LOCATION_ID || 'LEJ3PDZ9V6NYN'] } },
      limit: 50,
    }),
  });
  return json(await r.json());
}

// Clean up planner entries from past too-loose syncs. Walks the delivery log,
// finds all sq_* entries, appends a `delete` action for each. Run once after
// fixing the filter; subsequent imports will only re-add true catering orders.
async function handleCleanupSquare(request, env) {
  const authErr = checkAdminToken(request, env);
  if (authErr) return authErr;

  // Pull all delivery log entries
  const logRes = await fetch(`${SHEET_LOGGER_BASE}${DELIVERY_LOG_PATH}`);
  if (!logRes.ok) {
    return json({ error: 'failed to fetch delivery log' }, 502);
  }
  const logs = await logRes.json();

  // Resolve to current state, find sq_* entries that are still active
  const byId = {};
  for (const row of logs || []) {
    const id = row.deliveryId;
    if (!id || !id.startsWith('sq_')) continue;
    const action = row.action;
    if (action === 'delete') { delete byId[id]; continue; }
    byId[id] = row;
  }

  const toDelete = Object.keys(byId);
  const results = [];
  for (const deliveryId of toDelete) {
    const params = new URLSearchParams({
      action: 'delete',
      deliveryId,
      timeStamp: new Date().toISOString(),
      _source: 'square-cleanup',
    });
    try {
      const r = await fetch(
        `${SHEET_LOGGER_BASE}${DELIVERY_LOG_PATH}?${params.toString()}`,
        { method: 'POST' },
      );
      results.push({ deliveryId, ok: r.ok, status: r.status });
    } catch (err) {
      results.push({ deliveryId, error: err.message });
    }
  }

  return json({
    cleaned: toDelete.length,
    results,
  });
}

async function handleImportCatering(request, env) {
  const authErr = checkAdminToken(request, env);
  if (authErr) return authErr;

  const url = new URL(request.url);
  const sinceDays  = Math.max(1, Math.min(365, parseInt(url.searchParams.get('days'), 10) || 90));
  const futureDays = Math.max(1, Math.min(365, parseInt(url.searchParams.get('futureDays'), 10) || 60));

  // Two paths in parallel: catering-form orders + invoiced orders
  let orders = [];
  let invoiceItems = [];
  const errors = [];
  try {
    orders = await fetchSquareCateringOrders(env, { sinceDays });
  } catch (err) {
    errors.push(`orders: ${err.message}`);
  }
  try {
    invoiceItems = await fetchSquareInvoiceOrders(env, { onlyFutureDays: futureDays });
  } catch (err) {
    errors.push(`invoices: ${err.message}`);
  }

  const results = [];
  // Track which order IDs we've already synced (avoid double-sync if the same
  // order appears in both paths). Invoices first — they carry the date for
  // catering orders that have no fulfillment object.
  const seen = new Set();

  for (const { order, invoiceCtx } of invoiceItems) {
    if (seen.has(order.id)) continue;
    seen.add(order.id);
    try {
      const r = await syncSquareOrderToDelivery(order, invoiceCtx);
      results.push(r);
    } catch (err) {
      results.push({ orderId: order.id, error: err.message });
    }
  }
  for (const o of orders) {
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    try {
      const r = await syncSquareOrderToDelivery(o);
      results.push(r);
    } catch (err) {
      results.push({ orderId: o.id, error: err.message });
    }
  }

  const synced  = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed  = results.filter((r) => r.error || r.ok === false).length;
  const allUnmapped = [...new Set(results.flatMap((r) => r.unmappedItems || []))];

  return json({
    sinceDays,
    futureDays,
    fetched: { orders: orders.length, invoices: invoiceItems.length },
    synced,
    skipped,
    failed,
    errors,
    unmappedNames: allUnmapped,
    results,
  });
}

// ─── Webhook signature verification ───────────────────────────────
// Square signs each webhook payload with HMAC-SHA256 of (request URL + raw body),
// using the subscription's signature key. Returns the body string on success
// (caller re-uses it for parsing) or false on mismatch.
async function verifySquareSignature(request, signatureKey) {
  const sigHeader = request.headers.get('x-square-hmacsha256-signature');
  if (!sigHeader || !signatureKey) return false;
  const body = await request.text();
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(signatureKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(request.url + body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return expected === sigHeader ? body : false;
}

async function handleSquareWebhook(request, env) {
  if (!env.SQUARE_WEBHOOK_SIGNATURE_KEY) {
    return json({ error: 'webhook key not configured' }, 503);
  }
  const body = await verifySquareSignature(request, env.SQUARE_WEBHOOK_SIGNATURE_KEY);
  if (!body) return json({ error: 'bad signature' }, 401);

  let payload;
  try { payload = JSON.parse(body); } catch (_) { return json({ error: 'bad json' }, 400); }

  // Resolve order ID from event payload (varies by event type)
  const orderId =
    payload.data?.object?.order?.id              // order.* events
    || payload.data?.object?.invoice?.order_id   // invoice.* events
    || null;

  if (!orderId) {
    // Acknowledge so Square doesn't retry — nothing to do
    return json({ ok: true, skipped: 'no order id in payload', event_type: payload.type });
  }

  // Fetch fresh order state — webhook payloads are sometimes partial
  const sqRes = await fetch(`${SQUARE_BASE}/orders/${orderId}`, {
    headers: {
      'Square-Version': '2025-01-23',
      Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
    },
  });
  const sqData = await sqRes.json();
  if (!sqRes.ok) {
    // eslint-disable-next-line no-console -- worker diagnostics
    console.error('Webhook order fetch failed:', orderId, sqData);
    // Return 200 anyway — Square retries non-2xx for 24h, we don't want a storm.
    // Manual sync button is the recovery path.
    return json({ ok: true, error: 'order fetch failed', orderId });
  }

  const order = sqData.order || sqData;
  let result;
  try {
    result = await syncSquareOrderToDelivery(order);
  } catch (err) {
    // eslint-disable-next-line no-console -- worker diagnostics
    console.error('Webhook sync failed:', orderId, err);
    return json({ ok: true, error: err.message, orderId });
  }

  return json({ ok: true, eventType: payload.type, ...result });
}

async function sendOrderAlert({
  customer,
  fulfillment,
  itemSummary,
  orderId,
}) {
  const formData = new FormData();
  formData.append('_subject', `New Catering Order — ${customer.name}`);
  formData.append('Customer', customer.name);
  formData.append('Email', customer.email);
  formData.append('Phone', customer.phone);
  formData.append('Items', itemSummary);
  formData.append('Fulfillment', fulfillment.type.toUpperCase());
  formData.append('Date/Time', `${fulfillment.date} at ${fulfillment.time}`);
  if (fulfillment.type === 'delivery' && fulfillment.address) {
    formData.append('Delivery Address', fulfillment.address);
  }
  if (customer.notes) {
    formData.append('Notes', customer.notes);
  }
  formData.append('Order ID', orderId);
  formData.append('_template', 'table');

  await fetch('https://formsubmit.co/ajax/info@dangerouspretzel.com', {
    method: 'POST',
    body: formData,
  });
}

// ─── FOH cheese-dip consumption + iCalendar feed ─────────────────────────

const PRODUCTION_LOG_PATH = '/dangpretz/production';

/**
 * Pull last N days of Square orders and count cheese-dip consumption.
 * Counts:
 *   1. Direct line items whose name matches "3oz cheese dip" or generic
 *      "cheese dip" → quantity units.
 *   2. Modifiers on other items whose name contains "cheese dip" → 1 each.
 * Returns { daysSampled, cheeseDipUnits, dailyAvg, modifierNamesSeen }.
 */
async function fetchSquareCheeseConsumption(env, daysSampled = 28, debug = false) {
  const locationId = env.SQUARE_LOCATION_ID || 'LEJ3PDZ9V6NYN';
  const startAt = new Date(Date.now() - daysSampled * 86400e3).toISOString();
  const orders = [];
  let cursor;
  let pageCount = 0;
  do {
    const res = await fetch(`${SQUARE_BASE}/orders/search`, {
      method: 'POST',
      headers: {
        'Square-Version': '2025-01-23',
        Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        location_ids: [locationId],
        query: {
          filter: {
            date_time_filter: { created_at: { start_at: startAt } },
            state_filter: { states: ['OPEN', 'COMPLETED'] }, // skip CANCELED — wasn't consumed
          },
          sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' },
        },
        limit: 500,
        cursor,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Square search failed: ${JSON.stringify(data).slice(0, 300)}`);
    orders.push(...(data.orders || []));
    cursor = data.cursor;
    pageCount += 1;
    if (pageCount > 20) break;
  } while (cursor);

  // Cheese dip is sold under the brand name "Dangerous Dip" (the cheese-
  // sauce variant). Match the standalone line item, the catering variant,
  // and the modifier-on-pretzel pattern. Other dip flavors (Sweet Cream,
  // Honey Mustard, etc.) are different products and explicitly NOT cheese
  // dip. (Catering box descriptions also list dip counts, but parsing
  // those is v2 work.)
  const dangerousDipRe = /^(dangerous\s*dip)(\s*-\s*catering)?$/i;
  let units = 0;
  const directNamesSeen = new Set();
  const modifierNamesSeen = new Set();
  const sampleAllLineItemNames = new Set();
  const sampleAllModifierNames = new Set();
  orders.forEach((o) => {
    (o.line_items || []).forEach((li) => {
      const name = (li.name || '').trim();
      const qty = parseInt(li.quantity, 10) || 0;
      sampleAllLineItemNames.add(name);
      // Direct line item match.
      if (dangerousDipRe.test(name) && qty > 0) {
        directNamesSeen.add(name);
        units += qty;
      }
      // Modifier match — each modifier instance = parent qty cheese dips.
      (li.modifiers || []).forEach((mod) => {
        const mname = (mod.name || '').trim();
        sampleAllModifierNames.add(mname);
        if (dangerousDipRe.test(mname)) {
          modifierNamesSeen.add(mname);
          units += qty;
        }
      });
    });
  });

  const dailyAvg = daysSampled > 0 ? units / daysSampled : 0;
  const result = {
    daysSampled,
    cheeseDipUnits: units,
    dailyAvg: Math.round(dailyAvg * 10) / 10, // 1 decimal
    directNamesSeen: [...directNamesSeen],
    modifierNamesSeen: [...modifierNamesSeen],
    ordersScanned: orders.length,
  };
  if (debug) {
    result.sampleLineItemNames = [...sampleAllLineItemNames].slice(0, 50);
    result.sampleModifierNames = [...sampleAllModifierNames].slice(0, 50);
  }
  return result;
}

async function handleCheeseConsumption(request, env) {
  const url = new URL(request.url);
  const days = Math.max(1, Math.min(90, parseInt(url.searchParams.get('days'), 10) || 28));
  const debug = url.searchParams.get('debug') === '1';
  const result = await fetchSquareCheeseConsumption(env, days, debug);
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
      'Cache-Control': 'public, max-age=3600', // 1 hour cache (also enforced upstream by myecalendar)
    },
  });
}

// ─── iCalendar feed for FOH ──────────────────────────────────────────────

// Today as 'YYYY-MM-DD' in Mountain TZ (matches the production app).
function todayMountain() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
}

// Format a Date as iCal UTC timestamp (YYYYMMDDTHHMMSSZ) or all-day date (YYYYMMDD).
function icsDateUTC(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear()
    + pad(d.getUTCMonth() + 1)
    + pad(d.getUTCDate())
    + 'T'
    + pad(d.getUTCHours())
    + pad(d.getUTCMinutes())
    + pad(d.getUTCSeconds())
    + 'Z';
}
function icsDateAllDay(yyyymmdd) {
  return yyyymmdd.replace(/-/g, '');
}
// RFC 5545 line folding: split lines to 75 octets, continuation prefixed by space.
function icsFold(line) {
  const out = [];
  let s = line;
  while (s.length > 75) {
    out.push(s.slice(0, 75));
    s = ' ' + s.slice(75);
  }
  out.push(s);
  return out.join('\r\n');
}
// Escape iCal text fields (commas, semicolons, newlines).
function icsEscape(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function isCateringDelivery(d) {
  if (!d) return false;
  if (d._source === 'square-invoice') return true;
  if ((d.deliveryId || '').startsWith('sq_')) {
    let items = [];
    try { items = JSON.parse(d.lineItems || '[]'); } catch {}
    if (items.some((li) => /^catering:/i.test(li.name || li.sku || ''))) return true;
  }
  return false;
}

function buildCheeseEvent({ batch, dtstamp }) {
  const uid = `cheese-batch-${batch.date}@dangpretz`;
  const lines = [
    'BEGIN:VEVENT',
    icsFold(`UID:${uid}`),
    `DTSTAMP:${dtstamp}`,
    `DTSTART;VALUE=DATE:${icsDateAllDay(batch.date)}`,
    `DTEND;VALUE=DATE:${icsDateAllDay(addOneDay(batch.date))}`,
    icsFold(`SUMMARY:${icsEscape(`🧀 Make 1 batch cheese dip${batch.overdue ? ' (overdue!)' : ''}`)}`),
  ];
  const coversList = batch.covers
    .map((c) => `${c.customer} (${c.qty} for ${c.deliveryDate})`)
    .join('; ');
  const fohLine = batch.foh > 0 ? ` FOH walk-in covered: ~${Math.round(batch.foh * (CHEESE_MAX_LEAD - 1))} dips.` : '';
  const desc = `Covers: ${coversList || 'FOH walk-in only'}.${fohLine} ~${CHEESE_BATCH_SIZE} dips/batch. Use within ${CHEESE_MAX_LEAD} days.`;
  lines.push(icsFold(`DESCRIPTION:${icsEscape(desc)}`));
  lines.push(icsFold('URL:https://drewfeller.com/static/production/'));
  lines.push('END:VEVENT');
  return lines.join('\r\n');
}

function addOneDay(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

function buildCateringEvent({ delivery, dtstamp }) {
  const uid = `catering-${delivery.deliveryId}@dangpretz`;
  // Pickup/delivery time if available, else 9 AM Mountain default for that date.
  // Square stores pickup_at/deliver_at on the order's fulfillment; we don't
  // have it here on the resolved delivery row directly. Fall back to 9 AM
  // local for now (will refine when we plumb the time through).
  const dateStr = delivery.date;
  const dtStart = `${icsDateAllDay(dateStr)}T160000Z`; // 9 AM MDT (UTC-6) ≈ 16:00 UTC
  const dtEnd   = `${icsDateAllDay(dateStr)}T170000Z`; // +1h hand-off window

  let items = [];
  try { items = JSON.parse(delivery.lineItems || '[]'); } catch {}
  const itemsList = items
    .filter((li) => (Number(li.quantity) || 0) > 0)
    .map((li) => `  - ${li.sku || '?'} × ${li.quantity || 0}`)
    .join('\n');

  const customer = delivery.customer || '?';
  const isPickup = (delivery.type || 'delivery').toLowerCase() === 'pickup';
  const location = isPickup
    ? 'PICKUP — at shop'
    : (delivery.address || '');

  const summaryShort = items.length > 0
    ? `${items[0].sku} × ${items[0].quantity}${items.length > 1 ? ` +${items.length - 1} more` : ''}`
    : '';

  const lines = [
    'BEGIN:VEVENT',
    icsFold(`UID:${uid}`),
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    icsFold(`SUMMARY:${icsEscape(`🥨 Catering: ${customer}${summaryShort ? ` (${summaryShort})` : ''}`)}`),
  ];
  if (location) lines.push(icsFold(`LOCATION:${icsEscape(location)}`));
  const descParts = [];
  descParts.push(`Customer: ${customer}`);
  if (delivery.contactPhone) descParts.push(`Phone: ${delivery.contactPhone}`);
  if (delivery.contactEmail) descParts.push(`Email: ${delivery.contactEmail}`);
  descParts.push(`Type: ${isPickup ? 'Pickup' : 'Delivery'}`);
  if (itemsList) descParts.push(`Items:\n${itemsList}`);
  if (delivery.notes) descParts.push(`Notes: ${delivery.notes}`);
  lines.push(icsFold(`DESCRIPTION:${icsEscape(descParts.join('\n'))}`));
  lines.push(icsFold(`URL:https://drewfeller.com/static/delivery-planner/`));
  lines.push('END:VEVENT');
  return lines.join('\r\n');
}

async function handleFohCalendar(request, env) {
  // Pull both logs in parallel.
  const [delivRes, prodRes] = await Promise.all([
    fetch(`${SHEET_LOGGER_BASE}${DELIVERY_LOG_PATH}`),
    fetch(`${SHEET_LOGGER_BASE}${PRODUCTION_LOG_PATH}`),
  ]);
  const deliveryLogs   = delivRes.ok   ? await delivRes.json()   : [];
  const productionLogs = prodRes.ok    ? await prodRes.json()    : [];

  const allDeliveries = resolveDeliveries(deliveryLogs);
  const prod          = resolveProductionLogs(productionLogs);
  const meta          = makeSkuMeta(prod.skuConfig);
  const inventoryReport = getInventoryReport({
    productionLogs: prod.productionLogs,
    productionState: prod.state,
    allDeliveries,
    skuAliases: prod.skuAliases,
    latestInventoryTs: prod.latestInventoryTs,
    getBatchSize: meta.getBatchSize,
  });

  // Square FOH walk-in rate. Fail-soft: if Square errors, use 0.
  let dailyAvg = 0;
  try {
    const c = await fetchSquareCheeseConsumption(env, 28);
    dailyAvg = c.dailyAvg || 0;
  } catch (_) { /* best-effort */ }

  const today = todayMountain();

  // Cheese batches.
  const cheese = scheduleCheese({
    deliveries: allDeliveries,
    inventoryReport,
    fohDailyAvg: dailyAvg,
    today,
    skuAliases: prod.skuAliases,
    lookaheadDays: 14,
  });

  // Upcoming catering deliveries (next 30 days, scheduled status).
  const horizon = (() => {
    const dt = new Date(today);
    dt.setUTCDate(dt.getUTCDate() + 30);
    return dt.toISOString().slice(0, 10);
  })();
  const cateringDeliveries = allDeliveries.filter((d) => {
    if (!d.date) return false;
    if (d.date < today || d.date > horizon) return false;
    if (['delivered','picked_up','cancelled'].includes(d.status)) return false;
    return isCateringDelivery(d);
  });

  // Build .ics body
  const dtstamp = icsDateUTC(new Date());
  const events = [
    ...cheese.batches.map((batch) => buildCheeseEvent({ batch, dtstamp })),
    ...cateringDeliveries.map((delivery) => buildCateringEvent({ delivery, dtstamp })),
  ];

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Dangerous Pretzel Co//FOH Schedule//EN',
    icsFold('NAME:DPC FOH Schedule'),
    icsFold('X-WR-CALNAME:DPC FOH Schedule'),
    icsFold('DESCRIPTION:Cheese-dip batches and catering fulfillments'),
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...events,
    'END:VCALENDAR',
    '',
  ].join('\r\n');

  return new Response(ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'public, max-age=300', // 5 min — myecalendar refreshes hourly anyway
      ...CORS_HEADERS,
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ── TEMP admin routing (remove after backfill cleanup) ──
    const url = new URL(request.url);
    if (url.pathname === '/admin/recent-catering' && request.method === 'GET') {
      try {
        return await handleListRecentCatering(request, env);
      } catch (err) {
        // eslint-disable-next-line no-console -- worker diagnostics
        console.error('Admin list error:', err);
        return json({ error: err.message || 'Admin list failed' }, 500);
      }
    }
    if (url.pathname === '/admin/fix-fulfillment' && request.method === 'POST') {
      try {
        return await handleFixFulfillment(request, env);
      } catch (err) {
        // eslint-disable-next-line no-console -- worker diagnostics
        console.error('Admin fix error:', err);
        return json({ error: err.message || 'Admin fix failed' }, 500);
      }
    }
    // ── end TEMP admin routing ──

    // ── Square catering sync ──
    if (url.pathname === '/admin/import-catering' && request.method === 'POST') {
      try {
        return await handleImportCatering(request, env);
      } catch (err) {
        // eslint-disable-next-line no-console -- worker diagnostics
        console.error('Import catering error:', err);
        return json({ error: err.message || 'Import failed' }, 500);
      }
    }
    if (url.pathname === '/admin/inspect-square' && request.method === 'GET') {
      try { return await handleInspectSquare(request, env); }
      catch (err) { return json({ error: err.message }, 500); }
    }
    if (url.pathname === '/admin/cleanup-square' && request.method === 'POST') {
      try {
        return await handleCleanupSquare(request, env);
      } catch (err) {
        // eslint-disable-next-line no-console -- worker diagnostics
        console.error('Cleanup square error:', err);
        return json({ error: err.message || 'Cleanup failed' }, 500);
      }
    }
    if (url.pathname === '/webhooks/square' && request.method === 'POST') {
      try {
        return await handleSquareWebhook(request, env);
      } catch (err) {
        // eslint-disable-next-line no-console -- worker diagnostics
        console.error('Square webhook error:', err);
        // Return 200 so Square doesn't retry — failures captured in logs
        return json({ ok: true, error: err.message }, 200);
      }
    }
    // ── end Square sync routing ──

    // ── FOH cheese-dip endpoints ──
    if (url.pathname === '/cheese-consumption' && request.method === 'GET') {
      try { return await handleCheeseConsumption(request, env); }
      catch (err) {
        // eslint-disable-next-line no-console -- worker diagnostics
        console.error('Cheese consumption error:', err);
        return json({ error: err.message || 'Cheese consumption failed' }, 500);
      }
    }
    if (url.pathname === '/foh-cal.ics' && request.method === 'GET') {
      try { return await handleFohCalendar(request, env); }
      catch (err) {
        // eslint-disable-next-line no-console -- worker diagnostics
        console.error('FOH calendar error:', err);
        return new Response(`# error: ${err.message || 'foh-cal failed'}`, {
          status: 500,
          headers: { 'Content-Type': 'text/plain', ...CORS_HEADERS },
        });
      }
    }
    // ── end FOH endpoints ──

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    try {
      const body = await request.json();
      const { items, fulfillment, customer } = body;

      // Validate required fields
      if (!items?.length) return json({ error: 'No items in order' }, 400);
      if (!fulfillment?.type) return json({ error: 'Fulfillment type required' }, 400);
      if (!fulfillment?.date || !fulfillment?.time) return json({ error: 'Date and time required' }, 400);
      if (!customer?.name || !customer?.email || !customer?.phone) {
        return json({ error: 'Name, email, and phone required' }, 400);
      }

      // Build order line items from catalog variation IDs
      const lineItems = items.map((item) => ({
        catalog_object_id: item.variationId,
        quantity: String(item.quantity),
      }));

      // Add delivery fee if delivery
      if (fulfillment.type === 'delivery') {
        lineItems.push({
          name: 'Delivery Fee',
          quantity: '1',
          base_price_money: { amount: 7500, currency: 'USD' },
        });
      }

      // Build the order note
      const noteLines = [
        `Fulfillment: ${fulfillment.type.toUpperCase()}`,
        `Date/Time: ${fulfillment.date} at ${fulfillment.time}`,
      ];
      if (fulfillment.type === 'delivery' && fulfillment.address) {
        noteLines.push(`Delivery Address: ${fulfillment.address}`);
      }
      if (customer.notes) {
        noteLines.push(`Notes: ${customer.notes}`);
      }

      // Normalize phone to E.164 format for Square
      const phoneDigits = customer.phone.replace(/\D/g, '');
      let e164Phone;
      if (phoneDigits.length === 10) {
        e164Phone = `+1${phoneDigits}`;
      } else if (phoneDigits.length === 11 && phoneDigits.startsWith('1')) {
        e164Phone = `+${phoneDigits}`;
      } else {
        e164Phone = `+${phoneDigits}`;
      }

      // Build a SCHEDULED fulfillment so the KDS/printer fires on event day,
      // not on the day payment clears. Bail out cleanly on malformed date/time.
      let fulfillAt;
      try {
        fulfillAt = toDenverISO(fulfillment.date, fulfillment.time);
      } catch (e) {
        return json({ error: 'Invalid date or time format' }, 400);
      }

      const recipient = {
        display_name: customer.name,
        email_address: customer.email,
        phone_number: e164Phone,
      };

      let fulfillments;
      if (fulfillment.type === 'delivery') {
        fulfillments = [
          {
            type: 'DELIVERY',
            state: 'PROPOSED',
            delivery_details: {
              schedule_type: 'SCHEDULED',
              deliver_at: fulfillAt,
              recipient: {
                ...recipient,
                ...(fulfillment.address
                  ? { address: { address_line_1: fulfillment.address, country: 'US' } }
                  : {}),
              },
            },
          },
        ];
      } else {
        fulfillments = [
          {
            type: 'PICKUP',
            state: 'PROPOSED',
            pickup_details: {
              schedule_type: 'SCHEDULED',
              pickup_at: fulfillAt,
              recipient,
            },
          },
        ];
      }

      // Create Square Payment Link.
      //
      // IMPORTANT: do NOT set `pre_populated_data` on the request body. Square
      // treats `order.fulfillments` + `pre_populated_data.buyer_email` as
      // conflicting and, for historical API versions, silently dropped the
      // inline fulfillments — leaving the order with only Square's default
      // DIGITAL fulfillment. That order is then permanently bound to the
      // `com.weebly.Digital` workflow and can't be corrected via UpdateOrder
      // afterward. (Verified Apr 23 2026 with Square API 2025-01-23: sending
      // both returns `CONFLICTING_PARAMETERS`; removing pre_populated_data
      // makes Square respect the inline PICKUP/DELIVERY fulfillment properly.)
      //
      // The buyer's contact info still flows through — it's on the fulfillment
      // recipient (shown at checkout) and in the order note. Customer just
      // types their email once at checkout instead of seeing it pre-filled.
      const idempotencyKey = crypto.randomUUID();
      const locationId = env.SQUARE_LOCATION_ID || 'LEJ3PDZ9V6NYN';

      const paymentLinkBody = {
        idempotency_key: idempotencyKey,
        order: {
          location_id: locationId,
          line_items: lineItems,
          note: noteLines.join('\n'),
          fulfillments,
        },
        checkout_options: {
          allow_tipping: true,
          accepted_payment_methods: {
            apple_pay: true,
            google_pay: true,
            cash_app_pay: true,
          },
          redirect_url: 'https://www.dangerouspretzel.com/v2/catering-confirmed.html',
        },
      };

      const sqRes = await fetch(`${SQUARE_BASE}/online-checkout/payment-links`, {
        method: 'POST',
        headers: {
          'Square-Version': '2025-01-23',
          Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(paymentLinkBody),
      });

      const sqData = await sqRes.json();

      if (!sqRes.ok) {
        // eslint-disable-next-line no-console -- worker diagnostics
        console.error('Square API error:', JSON.stringify(sqData));
        return json({ error: 'Failed to create checkout', details: sqData.errors }, 500);
      }

      // Extract order ID (may be a string or object with .id)
      const rawOrder = sqData.related_resources?.orders?.[0];
      const orderId = typeof rawOrder === 'string' ? rawOrder : rawOrder?.id || null;

      // Send email alert to the team (fire-and-forget)
      const itemSummary = items.map((i) => `${i.name || i.variationId} x${i.quantity}`).join(', ');
      sendOrderAlert({
        customer,
        fulfillment,
        itemSummary,
        orderId: orderId || 'N/A',
      }).catch((err) => {
        // eslint-disable-next-line no-console -- worker diagnostics
        console.error('Email alert failed:', err);
      });

      return json({
        checkout_url: sqData.payment_link.url,
        order_id: orderId,
      });
    } catch (err) {
      // eslint-disable-next-line no-console -- worker diagnostics
      console.error('Worker error:', err);
      return json({ error: 'Internal server error' }, 500);
    }
  },
};

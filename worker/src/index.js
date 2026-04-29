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
// Returns a small report describing what happened.
async function syncSquareOrderToDelivery(squareOrder) {
  const id = squareOrder.id;
  if (!id) return { skipped: 'no order id' };

  // Find the first PICKUP or DELIVERY fulfillment (catering signal)
  const ful = (squareOrder.fulfillments || []).find(
    (f) => f && (f.type === 'PICKUP' || f.type === 'DELIVERY'),
  );
  if (!ful) return { orderId: id, skipped: 'no pickup/delivery fulfillment' };

  // Resolve fulfillment date — try schedule first, fall back to note parse
  const pickupAt = ful.pickup_details?.pickup_at;
  const deliverAt = ful.delivery_details?.deliver_at;
  let scheduledIso = pickupAt || deliverAt || null;
  if (!scheduledIso) {
    const parsed = parseOrderNote(squareOrder.note);
    if (parsed?.iso_scheduled_at) scheduledIso = parsed.iso_scheduled_at;
  }
  if (!scheduledIso) return { orderId: id, skipped: 'no fulfillment date' };
  const date = scheduledIso.slice(0, 10);

  // Customer / contact from fulfillment recipient (more reliable than note)
  const recipient =
    ful.pickup_details?.recipient || ful.delivery_details?.recipient || {};
  const customer = recipient.display_name || squareOrder.customer_id || 'Square Order';
  const phone = recipient.phone_number || '';
  const email = recipient.email_address || '';
  const address =
    ful.type === 'DELIVERY' ? formatSquareAddress(recipient.address) : '';

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
  if (squareOrder.state === 'CANCELED' || ful.state === 'CANCELED') {
    action = 'delete'; // remove from planner active set
    status = 'cancelled';
  } else if (ful.state === 'COMPLETED') {
    status = ful.type === 'PICKUP' ? 'picked_up' : 'delivered';
  }

  // Build URL params for sheet-logger (delivery-planner appendLog format)
  const params = new URLSearchParams({
    action,
    deliveryId: `sq_${id}`,
    customer,
    date,
    type: ful.type.toLowerCase(),
    lineItems: JSON.stringify(mappedItems),
    status,
    timeStamp: new Date().toISOString(),
    _source: 'square',
    _squareOrderId: id,
  });
  if (phone)   params.set('contactPhone', phone);
  if (email)   params.set('contactEmail', email);
  if (address) params.set('address', address);

  const resp = await fetch(
    `${SHEET_LOGGER_BASE}${DELIVERY_LOG_PATH}?${params.toString()}`,
    { method: 'POST' },
  );

  return {
    orderId: id,
    deliveryId: `sq_${id}`,
    customer,
    date,
    type: ful.type.toLowerCase(),
    status,
    action,
    items: mappedItems.length,
    unmappedItems: unmappedNames,
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

  // Keep only orders that look like catering: have a PICKUP or DELIVERY fulfillment
  return all.filter((o) =>
    (o.fulfillments || []).some(
      (f) => f && (f.type === 'PICKUP' || f.type === 'DELIVERY'),
    ),
  );
}

async function handleImportCatering(request, env) {
  const authErr = checkAdminToken(request, env);
  if (authErr) return authErr;

  const url = new URL(request.url);
  const sinceDays = Math.max(1, Math.min(365, parseInt(url.searchParams.get('days'), 10) || 90));

  let orders;
  try {
    orders = await fetchSquareCateringOrders(env, { sinceDays });
  } catch (err) {
    return json({ error: err.message }, 500);
  }

  const results = [];
  for (const o of orders) {
    try {
      const r = await syncSquareOrderToDelivery(o);
      results.push(r);
    } catch (err) {
      results.push({ orderId: o.id, error: err.message });
    }
  }

  // Aggregate counters for a quick scan
  const synced  = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed  = results.filter((r) => r.error || r.ok === false).length;
  const allUnmapped = [...new Set(results.flatMap((r) => r.unmappedItems || []))];

  return json({
    sinceDays,
    fetched: orders.length,
    synced,
    skipped,
    failed,
    unmappedNames: allUnmapped,
    results,
  });
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
    // ── end Square sync routing ──

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

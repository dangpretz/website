// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ COMMISSIONS ENGINE                                                       ║
// ╠══════════════════════════════════════════════════════════════════════════╣
// ║                                                                          ║
// ║ Pure functions, no DOM/fetch — same convention as scripts/inventory.js.  ║
// ║ The caller supplies already-fetched log rows / resolved deliveries and   ║
// ║ gets back structured state or a list of rows to append.                  ║
// ║                                                                          ║
// ║ TWO KINDS OF COMMISSION                                                  ║
// ║   Wholesale — price-tiered, auto-computed from real delivery-planner     ║
// ║     data, ONCE, then locked in forever (see below).                     ║
// ║   Event — a flat $/pretzel rate, manually logged per event, split        ║
// ║     evenly across however many reps worked it. Computed at DISPLAY      ║
// ║     time (summarizeCommissions), not storage time, so the flat rate     ║
// ║     can change later without rewriting history.                         ║
// ║                                                                          ║
// ║ LOCK-IN                                                                  ║
// ║   A wholesale delivery's commission is computed once, the moment it's   ║
// ║   first processed, using whatever price/tiers are configured for that   ║
// ║   customer+SKU at that instant — then written as a log_wholesale_       ║
// ║   commission row keyed by "<deliveryId>:<lineItemIndex>". Reprocessing  ║
// ║   later (processWholesaleCommissions) skips any id that already has a   ║
// ║   ledger row — editing a customer's price/tiers afterward never changes ║
// ║   what a past delivery already earned.                                  ║
// ║                                                                          ║
// ║ PRICE VS. TIERS                                                         ║
// ║   Each customer negotiates their own PRICE per SKU (set_sku_pricing,    ║
// ║   keyed by customer+sku) — but the TIER LADDER that turns a price into  ║
// ║   a commission % is one shared schedule per SKU (set_sku_tiers, keyed   ║
// ║   only by sku), the same for every customer buying that product. A     ║
// ║   customer's commission % comes from looking their own price up in     ║
// ║   their SKU's shared ladder — resolveTierPct(tiersBySku[sku], price).  ║
// ║                                                                          ║
// ╚══════════════════════════════════════════════════════════════════════════╝

export const EVENT_RATE_PER_PRETZEL = 0.50; // $/pretzel, split across reps present

export function pricingKey(customer, sku) {
  return `${customer}::${sku}`;
}

// ── /dangpretz/commissions-config (manager-maintained reference data) ─────
// Also carries `set_sku_alias` rows — see resolveConnectedSku() below for
// why a raw delivery-planner item name isn't itself the pricing key — and
// `set_sku_tiers` rows — see the PRICE VS. TIERS note above.
//
// `normalize` (delivery-planner's normalizeCustomerName) is injected so a
// customer's rep/pricing rows are keyed the same way a delivery's customer
// name is matched in processWholesaleCommissions — otherwise "Willies" on a
// delivery would miss config filed under "Willies Lounge". Defaults to
// identity so a caller that doesn't care keeps the old raw-key behaviour.
export function resolveCommissionsConfig(logs, normalize = (x) => x) {
  const repByCustomer = {};
  const pricingByCustomerSku = {};
  const tiersBySku = {};
  const connectedSkuByItem = {};
  // SKUs a manager has hidden from the reps' Customers & Pricing tab
  // (set_sku_rep_hidden). Default is visible — only an explicit `hidden:true`
  // row keeps a SKU off the rep view; a later `hidden:false` row un-hides it.
  const repHiddenSkus = {};
  const cust = (name) => normalize(name) || name; // keep raw if normalize excludes it
  (Array.isArray(logs) ? logs : []).forEach((row) => {
    if (row.action === 'set_customer_rep' && row.customer) {
      repByCustomer[cust(row.customer)] = row.repCode;
    } else if (row.action === 'set_sku_pricing' && row.customer && row.sku) {
      const k = pricingKey(cust(row.customer), row.sku);
      pricingByCustomerSku[k] = { price: Number(row.price) || 0 };
    } else if (row.action === 'set_sku_tiers' && row.sku) {
      let tiers = [];
      try { tiers = JSON.parse(row.tiers || '[]'); } catch (_) { /* malformed row, treat as no tiers */ }
      tiersBySku[row.sku] = Array.isArray(tiers) ? tiers : [];
    } else if (row.action === 'set_sku_rep_hidden' && row.sku) {
      repHiddenSkus[row.sku] = row.hidden === true || row.hidden === 'true';
    } else if (row.action === 'set_sku_alias' && row.deliveryItem) {
      // A blank connectedSku is a deliberate "not commissioned" mark (e.g. a
      // drink, a catering box) — store it same as any other value so it
      // overrides a stale prior mapping; resolveConnectedSku() treats an
      // empty string the same as never having been set.
      connectedSkuByItem[row.deliveryItem] = row.connectedSku || '';
    }
  });
  return {
    repByCustomer, pricingByCustomerSku, tiersBySku, connectedSkuByItem, repHiddenSkus,
  };
}

// Delivery-planner line items carry whatever raw name Square/the planner
// gave them ("6.5oz bbk", "7oz bbk", a stray old "BBK") — several of which
// are really the same priced product under different names, and some
// (drinks, catering boxes) are never commissioned at all. `set_sku_alias`
// lets a manager fold raw item names onto one canonical "connected SKU",
// which is what pricing/tiers are actually configured against. An item
// with no alias row (or one deliberately set to '') is not eligible for
// commission — resolveConnectedSku returns null and the caller skips it
// silently rather than treating it as a setup gap.
export function resolveConnectedSku(rawSku, connectedSkuByItem) {
  return connectedSkuByItem[rawSku] || null;
}

// Every distinct raw line-item name seen in real wholesale deliveries, with
// enough context (order count, last-ordered date) for a manager to tell a
// live product from a stale one-off — feeds the SKU Mapping tab, which is
// the ongoing "add new items later" surface: as Square/the planner starts
// using a new item name, it shows up here automatically on next load.
export function collectRawSkuUsage(deliveries) {
  const usage = new Map();
  (Array.isArray(deliveries) ? deliveries : []).forEach((d) => {
    let items = [];
    try { items = JSON.parse(d.lineItems || '[]'); } catch (_) { return; }
    if (!Array.isArray(items)) return;
    items.forEach((item) => {
      if (!item.sku) return;
      if (!usage.has(item.sku)) usage.set(item.sku, { count: 0, lastOrdered: '' });
      const info = usage.get(item.sku);
      info.count += 1;
      if ((d.date || '') > info.lastOrdered) info.lastOrdered = d.date || '';
    });
  });
  return [...usage.entries()]
    .map(([rawSku, info]) => ({ rawSku, count: info.count, lastOrdered: info.lastOrdered }))
    .sort((a, b) => a.rawSku.localeCompare(b.rawSku));
}

// Every connected SKU currently in use, for the Customers & Pricing tab's
// per-SKU table — sourced from the alias mapping (i.e. only SKUs a manager
// has actually connected something to), not a static catalog file.
export function collectConnectedSkus(connectedSkuByItem) {
  const skus = new Set(Object.values(connectedSkuByItem).filter(Boolean));
  return [...skus].sort((a, b) => a.localeCompare(b));
}

// The connected SKUs that are actually priceable for a customer: they need a
// tier ladder (a SKU with no ladder resolves to 0% no matter the price), and
// for a rep-facing view the manager must not have hidden them (set_sku_rep_
// hidden). Shared by the commissions page and the CRM's pricing surfaces so
// both show the same rows.
export function priceableSkusFor(config, { forReps = false } = {}) {
  const tiersBySku = (config && config.tiersBySku) || {};
  const hidden = (config && config.repHiddenSkus) || {};
  return collectConnectedSkus((config && config.connectedSkuByItem) || {})
    .filter((sku) => (tiersBySku[sku] || []).length)
    .filter((sku) => !forReps || !hidden[sku]);
}

// Every distinct customer name across ALL deliveries (any status/category) —
// feeds the "add a customer" suggestions on the Customers & Pricing tab, so
// a rep can pick a planner-known account before its first wholesale order.
// `normalize` is injected (delivery-planner's normalizeCustomerName) so the
// list matches how commissions match customer names. Case-insensitive
// de-dupe, first-seen display form wins.
export function collectCustomerNames(deliveries, normalize = (x) => x) {
  const seen = new Map();
  (Array.isArray(deliveries) ? deliveries : []).forEach((d) => {
    const n = normalize(d.customer || '');
    if (!n) return;
    const k = n.toLowerCase();
    if (!seen.has(k)) seen.set(k, n);
  });
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

// Highest breakpoint whose minPrice <= price wins (0% if price is below
// every breakpoint — include a { minPrice: 0, pct } row if a customer+SKU
// should always earn something).
export function resolveTierPct(tiers, price) {
  if (!Array.isArray(tiers) || !tiers.length) return 0;
  const sorted = [...tiers].sort((a, b) => Number(a.minPrice) - Number(b.minPrice));
  let pct = 0;
  sorted.forEach((t) => {
    if (price >= Number(t.minPrice)) pct = Number(t.pct) || 0;
  });
  return pct;
}

// ── /dangpretz/commissions (computed + manual ledger entries) ─────────────
// `void_ledger` rows ({ voidId }) delete a prior entry by its id — used by
// the Adjustments tab's ✕ button and for one-off cleanup. Works for any
// ledger row: wholesale rows keyed by "<deliveryId>:<index>", events and
// adjustments by their server-assigned id.
export function resolveCommissionsLedger(logs) {
  const rows = Array.isArray(logs) ? logs : [];
  const voided = new Set(
    rows.filter((r) => r.action === 'void_ledger' && r.voidId).map((r) => r.voidId),
  );
  const wholesale = {}; // id -> row, last-write-wins (should never actually collide — see lock-in)
  const events = [];
  const adjustments = [];
  rows.forEach((row) => {
    if (voided.has(row.id)) return;
    if (row.action === 'log_wholesale_commission' && row.id) {
      wholesale[row.id] = row;
    } else if (row.action === 'log_event_commission') {
      let repsPresent = [];
      try { repsPresent = JSON.parse(row.repsPresent || '[]'); } catch (_) { /* malformed row */ }
      events.push({ ...row, repsPresent: Array.isArray(repsPresent) ? repsPresent : [] });
    } else if (row.action === 'log_adjustment') {
      adjustments.push(row);
    }
  });
  return { wholesale, events, adjustments };
}

// ── Snapshot processing ─────────────────────────────────────────────────────
// deliveries: resolved delivery-planner records (deliveryId, customer, date,
//   orderCategory, status, lineItems as a JSON string of [{sku, quantity}]).
// existingWholesale: resolveCommissionsLedger(...).wholesale.
// config: resolveCommissionsConfig(...).
// Returns { toWrite, needsSetup } — toWrite is ready to appendLog() one at a
// time; needsSetup is deduped per (customer, sku) so a manager sees each gap
// once, not once per delivery.
//
// `normalize` is injected (delivery-planner's normalizeCustomerName) so a
// delivery's customer name is matched against config the same way the CRM
// files it — and a name normalize() maps to null (an event / placeholder
// that isn't a wholesale customer) is skipped entirely, not flagged as a
// setup gap. Defaults to identity for callers that pass raw names.
export function processWholesaleCommissions({
  deliveries, existingWholesale, config, normalize = (x) => x,
}) {
  const toWrite = [];
  const needsSetup = [];
  const seenGaps = new Set();

  (Array.isArray(deliveries) ? deliveries : []).forEach((d) => {
    if ((d.orderCategory || 'wholesale') !== 'wholesale') return;
    if (!['delivered', 'picked_up'].includes(d.status)) return;
    let items = [];
    try { items = JSON.parse(d.lineItems || '[]'); } catch (_) { return; }
    if (!Array.isArray(items)) return;

    items.forEach((item, idx) => {
      const id = `${d.deliveryId}:${idx}`;
      if (existingWholesale[id]) return; // already locked in

      // normalize() → null means "not a wholesale customer" (event, placeholder):
      // skip silently, same as an unmapped SKU — not a setup gap.
      const customer = normalize(d.customer || '');
      const rawSku = item.sku || '';
      const qty = Number(item.quantity) || 0;
      if (!customer || !rawSku || qty <= 0) return;

      // Not mapped to a connected SKU = not a commissioned product at all
      // (a drink, a catering box, a discontinued flavor) — skip silently,
      // this is not a setup gap, it's a deliberate exclusion.
      const sku = resolveConnectedSku(rawSku, config.connectedSkuByItem);
      if (!sku) return;

      const repCode = config.repByCustomer[customer];
      const pricing = config.pricingByCustomerSku[pricingKey(customer, sku)];
      const tiers = config.tiersBySku[sku];
      if (!repCode || !pricing || !tiers || !tiers.length) {
        const gapKey = pricingKey(customer, sku);
        if (!seenGaps.has(gapKey)) {
          seenGaps.add(gapKey);
          needsSetup.push({
            customer,
            sku,
            rawSku,
            deliveryId: d.deliveryId,
            date: d.date,
            missingRep: !repCode,
            missingPricing: !pricing,
            missingTiers: !tiers || !tiers.length,
          });
        }
        return;
      }

      const tierPct = resolveTierPct(tiers, pricing.price);
      const amount = qty * pricing.price * (tierPct / 100);
      toWrite.push({
        action: 'log_wholesale_commission',
        id,
        deliveryId: d.deliveryId,
        customer,
        sku,
        rawSku,
        qty,
        price: pricing.price,
        tierPct,
        amount: amount.toFixed(2),
        repCode,
        computedAt: new Date().toISOString(),
      });
    });
  });

  return { toWrite, needsSetup };
}

// ── Totals, for this page's preview and (later) the rep-facing page ───────
export function summarizeCommissions({ wholesale, events, adjustments }) {
  const byRep = {};
  const ensure = (rep) => {
    if (!byRep[rep]) {
      byRep[rep] = {
        wholesale: [], events: [], adjustments: [], total: 0,
      };
    }
    return byRep[rep];
  };

  Object.values(wholesale).forEach((row) => {
    if (!row.repCode) return;
    const bucket = ensure(row.repCode);
    bucket.wholesale.push(row);
    bucket.total += Number(row.amount) || 0;
  });

  events.forEach((ev) => {
    const reps = ev.repsPresent.filter(Boolean);
    if (!reps.length) return;
    const share = ((Number(ev.pretzelCount) || 0) * EVENT_RATE_PER_PRETZEL) / reps.length;
    reps.forEach((rep) => {
      const bucket = ensure(rep);
      bucket.events.push({ ...ev, share });
      bucket.total += share;
    });
  });

  adjustments.forEach((adj) => {
    if (!adj.repCode) return;
    const bucket = ensure(adj.repCode);
    bucket.adjustments.push(adj);
    bucket.total += Number(adj.amount) || 0;
  });

  return byRep;
}

// Same three ledger sources as summarizeCommissions(), grouped by calendar
// month (YYYY-MM) instead of by rep — for the Preview tab's month-by-month
// view. Wholesale rows don't carry their own date (only a deliveryId), so
// the caller passes deliveryDateById (deliveryId -> date) to look it up —
// same lookup the per-rep itemized table already does for display.
export function summarizeCommissionsByMonth(
  { wholesale, events, adjustments },
  deliveryDateById = {},
) {
  const totals = {}; // month -> repCode -> amount
  const monthsSet = new Set();
  const repsSet = new Set();

  const addTo = (month, rep, amount) => {
    if (!month || !rep) return;
    monthsSet.add(month);
    repsSet.add(rep);
    if (!totals[month]) totals[month] = {};
    totals[month][rep] = (totals[month][rep] || 0) + amount;
  };

  Object.values(wholesale).forEach((row) => {
    if (!row.repCode) return;
    const date = deliveryDateById[row.deliveryId] || '';
    addTo(date.slice(0, 7), row.repCode, Number(row.amount) || 0);
  });

  events.forEach((ev) => {
    const reps = ev.repsPresent.filter(Boolean);
    if (!reps.length) return;
    const share = ((Number(ev.pretzelCount) || 0) * EVENT_RATE_PER_PRETZEL) / reps.length;
    reps.forEach((rep) => addTo((ev.date || '').slice(0, 7), rep, share));
  });

  adjustments.forEach((adj) => {
    if (!adj.repCode) return;
    // `date` is the manager-chosen effective date; sheet-logger overwrites
    // whatever `timeStamp` a client sends with real append time, so it can
    // never be backdated — fall back to it only for rows logged before the
    // `date` field existed.
    addTo((adj.date || adj.timeStamp || '').slice(0, 7), adj.repCode, Number(adj.amount) || 0);
  });

  return { months: [...monthsSet].sort(), reps: [...repsSet], totals };
}

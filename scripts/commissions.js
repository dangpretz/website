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
// ╚══════════════════════════════════════════════════════════════════════════╝

export const EVENT_RATE_PER_PRETZEL = 0.50; // $/pretzel, split across reps present

export function pricingKey(customer, sku) {
  return `${customer}::${sku}`;
}

// ── /dangpretz/commissions-config (manager-maintained reference data) ─────
export function resolveCommissionsConfig(logs) {
  const repByCustomer = {};
  const pricingByCustomerSku = {};
  (Array.isArray(logs) ? logs : []).forEach((row) => {
    if (row.action === 'set_customer_rep' && row.customer) {
      repByCustomer[row.customer] = row.repCode;
    } else if (row.action === 'set_sku_pricing' && row.customer && row.sku) {
      let tiers = [];
      try { tiers = JSON.parse(row.tiers || '[]'); } catch (_) { /* malformed row, treat as no tiers */ }
      pricingByCustomerSku[pricingKey(row.customer, row.sku)] = {
        price: Number(row.price) || 0,
        tiers: Array.isArray(tiers) ? tiers : [],
      };
    }
  });
  return { repByCustomer, pricingByCustomerSku };
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
export function resolveCommissionsLedger(logs) {
  const wholesale = {}; // id -> row, last-write-wins (should never actually collide — see lock-in)
  const events = [];
  const adjustments = [];
  (Array.isArray(logs) ? logs : []).forEach((row) => {
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
export function processWholesaleCommissions({ deliveries, existingWholesale, config }) {
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

      const customer = d.customer || '';
      const sku = item.sku || '';
      const qty = Number(item.quantity) || 0;
      if (!customer || !sku || qty <= 0) return;

      const repCode = config.repByCustomer[customer];
      const pricing = config.pricingByCustomerSku[pricingKey(customer, sku)];
      if (!repCode || !pricing) {
        const gapKey = pricingKey(customer, sku);
        if (!seenGaps.has(gapKey)) {
          seenGaps.add(gapKey);
          needsSetup.push({
            customer,
            sku,
            deliveryId: d.deliveryId,
            date: d.date,
            missingRep: !repCode,
            missingPricing: !pricing,
          });
        }
        return;
      }

      const tierPct = resolveTierPct(pricing.tiers, pricing.price);
      const amount = qty * pricing.price * (tierPct / 100);
      toWrite.push({
        action: 'log_wholesale_commission',
        id,
        deliveryId: d.deliveryId,
        customer,
        sku,
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

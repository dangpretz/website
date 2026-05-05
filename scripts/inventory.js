// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ SHARED INVENTORY + DELIVERY COVERAGE MODULE                              ║
// ╠══════════════════════════════════════════════════════════════════════════╣
// ║                                                                          ║
// ║ Single source of truth for inventory math. Both the production app       ║
// ║ (static/production/) and the delivery planner (static/delivery-planner/) ║
// ║ import from here so their numbers can never diverge.                     ║
// ║                                                                          ║
// ║ All functions are pure. No DOM. No globals. The caller provides log      ║
// ║ rows, the module returns structured state.                               ║
// ║                                                                          ║
// ║ INVENTORY LEDGER (events after snapshot timestamp)                       ║
// ║   shape_done +N      → cf += N×bs (also pushed to dough age queue)       ║
// ║   bfp_done   +N      → cf -= N×bs (cap 0, FIFO from oldest)              ║
// ║                      → fr += N×bs                                        ║
// ║   confirmed delivery → fr -= delivery qty (cap 0)                        ║
// ║                                                                          ║
// ║ COVERAGE ATTRIBUTION                                                     ║
// ║   For each SKU, walk active deliveries by date. Draw down effective      ║
// ║   frozen first, then cold-ferment. Per-delivery output:                  ║
// ║     frozenP    pretzels covered by frozen (ready to ship)                ║
// ║     doughP     pretzels covered by dough  (just needs BFP)               ║
// ║     needShape  pretzels still requiring shape work                       ║
// ║     needBfp    pretzels still requiring BFP work                         ║
// ║     status     'ready' | 'baking' | 'partial' | 'unstarted'              ║
// ║                                                                          ║
// ╚══════════════════════════════════════════════════════════════════════════╝

// ─── BUSINESS RULES ───────────────────────────────────────────────────────
// Edit these to match operational reality. Each is a single source of truth.

export const DOUGH_AGE_WARN_DAYS = 5;    // yellow aging-dough banner threshold
export const DOUGH_AGE_FAIL_DAYS = 6;    // red banner — discard or use today

// Cheese-dip production rules. Lead-time semantics: a batch must be ready
// at least 2 days before the delivery it covers, but can be made up to 5
// days ahead. After 5 days, cheese goes stale (mirrors the dough age queue
// for shape work).
export const CHEESE_MIN_LEAD = 2;        // make ≥ N days before delivery
export const CHEESE_MAX_LEAD = 5;        // no more than N days before delivery
export const CHEESE_BATCH_SIZE = 150;    // dips per batch
export const CHEESE_DAILY_CAP = 1;       // max batches/day for FOH cheese maker

// Pretzels per batch (per-SKU; skuConfig override takes priority).
// 3oz cheese dip is in here at batchSize 150 — it's tracked production now,
// not FOH-excluded as before.
export const BATCH_SIZES = {
  '21oz mammoth pretzel': 24,
  '10oz mustache':        48,
  '10oz plain':           48,
  '10oz bbk':             48,
  '10oz spicy bee':       48,
  '6.5oz plain':          72,
  '6.5oz bbk':            72,
  '6.5oz spicy bee':      72,
  'plain bombs':          432,
  'bees bats':            48,
  '3oz cheese dip':       CHEESE_BATCH_SIZE,
};

// Pretzels per case — wholesale shipping unit.
export const CASE_SIZES = {
  '21oz mammoth pretzel': 25,
  '10oz mustache':        48,
  '10oz plain':           48,
  '10oz bbk':             48,
  '10oz spicy bee':       48,
  '6.5oz plain':          72,
  '6.5oz bbk':            72,
  '6.5oz spicy bee':      72,
  '4oz twist plain':      52,
  '4oz twist bbk':        52,
  '4oz twist spicy bee':  52,
  'plain bombs':          0,
  'bees bats':            0,
};

// Pretzels per baking sheet (tray) — BFP team's natural unit.
export const TRAY_SIZES = {
  '21oz mammoth pretzel':  2,
  '10oz mustache':         4,
  '10oz plain':            4,
  '10oz bbk':              4,
  '10oz spicy bee':        4,
  '6.5oz plain':           9,
  '6.5oz bbk':             9,
  '6.5oz spicy bee':       9,
  '4oz twist plain':      12,
  '4oz twist bbk':        12,
  '4oz twist spicy bee':  12,
  'bees bats':             6,
  'plain bombs':           0,
};

// SKUs that aren't produced in-house (front-of-house pre-made / sourced).
// Note: `3oz cheese dip` USED to be here but is now tracked production
// (FOH makes it on-site in batches of 150). Only the bulk pre-mixed dip
// is still external.
export const FOH_SKUS = new Set([
  'bulk dangerous dip (25 srv)',
]);

// SKUs that need a coating step at BFP (cheese on top during bake).
export const BAKE_GROUPS = {
  coating: ['10oz bbk', '6.5oz bbk', '4oz twist bbk'],
};

// ─── SKU META HELPER ──────────────────────────────────────────────────────

/**
 * Build accessors for SKU metadata. skuConfig (from log entries) overrides
 * the static defaults above. Pass into anything that needs to know batch
 * sizes etc.
 *
 * @param {Object} skuConfig  sku → {batchSize, traySize, caseSize, type}
 */
export function makeSkuMeta(skuConfig = {}) {
  return {
    getBatchSize: sku => (skuConfig[sku]?.batchSize > 0 ? skuConfig[sku].batchSize : 0) || BATCH_SIZES[sku] || 0,
    getTraySize:  sku => (skuConfig[sku]?.traySize  > 0 ? skuConfig[sku].traySize  : 0) || TRAY_SIZES[sku]  || 0,
    getCaseSize:  sku => (skuConfig[sku]?.caseSize  > 0 ? skuConfig[sku].caseSize  : 0) || CASE_SIZES[sku]  || 0,
    isFOH:        sku => skuConfig[sku] ? skuConfig[sku].type === 'foh' : FOH_SKUS.has((sku || '').toLowerCase()) || FOH_SKUS.has(sku),
    isCoating:    sku => skuConfig[sku] ? skuConfig[sku].type === 'coating' : BAKE_GROUPS.coating.includes(sku),
  };
}

// ─── DELIVERY LOG RESOLUTION ──────────────────────────────────────────────

/**
 * Reduce raw delivery-planner log rows to current state per delivery.
 * Last write wins. `_confirmedAt` set on confirm or status→delivered/picked_up.
 *
 * Note: this resolver does NOT include barcode handling — the planner has
 * its own resolver that adds barcodes for its UI. This shared resolver is
 * sufficient for inventory math (which only needs status, lineItems, date,
 * customer, _confirmedAt).
 */
export function resolveDeliveries(logs) {
  const byId = {};
  if (!Array.isArray(logs)) return [];
  logs.forEach((row, idx) => {
    const id = row.deliveryId || `legacy-${idx}`;
    if (row.action === 'delete') { delete byId[id]; return; }
    if (row.action === 'barcodes') return;
    if (row.action === 'confirm') {
      if (byId[id]) {
        byId[id].status = (byId[id].type || 'delivery').toLowerCase() === 'pickup'
          ? 'picked_up' : 'delivered';
        byId[id]._confirmedAt = row.timeStamp || '';
      }
      return;
    }
    if (row.action === 'status') {
      if (byId[id]) {
        byId[id].status = row.status || 'scheduled';
        if (['delivered','picked_up'].includes(byId[id].status))
          byId[id]._confirmedAt = row.timeStamp || '';
      }
      return;
    }
    if (row.action === 'update') {
      const prev = byId[id];
      byId[id] = { ...row, deliveryId: id, status: row.status || 'scheduled' };
      if (prev?.barcodes) byId[id].barcodes = prev.barcodes;
      return;
    }
    byId[id] = { ...row, deliveryId: id, status: row.status || 'scheduled' };
  });
  return Object.values(byId);
}

// ─── PRODUCTION LOG RESOLUTION ────────────────────────────────────────────

/**
 * Reduce production-log rows into per-date state + global skuConfig + skuAliases.
 * Returns { state, skuConfig, skuAliases, latestInventoryTs, productionLogs }.
 * `productionLogs` is the input array — kept for callers that need raw rows
 * (e.g. timestamp-precise event accounting in getInventoryReport).
 */
export function resolveProductionLogs(logs) {
  const state = {};
  const skuConfig = {};
  const skuAliases = {};
  const productionLogs = Array.isArray(logs) ? logs : [];
  let latestInventoryTs = null;

  // Pass 1: collect skuConfig + skuAliases. We need ALL aliases known
  // before walking shape_done/bfp_done so completion entries logged under
  // OLD aliased names (e.g. "Twist - Plain") get canonicalized to
  // "4oz twist plain" — even if the alias row appears later in the log
  // than the completion row.
  productionLogs.forEach(row => {
    if (row.action === 'sku_config') {
      if (row.sku) skuConfig[row.sku] = {
        batchSize: Number(row.batchSize) || 0,
        traySize:  Number(row.traySize)  || 0,
        caseSize:  Number(row.caseSize)  || 0,
        type:      row.type || 'standard',
      };
    } else if (row.action === 'sku_alias') {
      const from = (row.from || '').trim();
      const to   = (row.to   || '').trim();
      if (from && to) skuAliases[from] = to;
    }
  });

  // Helper: canonicalize a sku via the now-fully-populated skuAliases.
  const canonicalSku = (raw) => {
    const k = (raw || '').trim();
    return skuAliases[k] || k;
  };

  // Pass 2: walk events with aliases applied. Per-date state aggregates
  // shape_done/bfp_done by canonical sku so the display layer never sees
  // duplicate cards for the same product under old + new names.
  productionLogs.forEach(row => {
    const { date, action } = row;
    if (!action) return;
    if (action === 'sku_config' || action === 'sku_alias') return; // handled in pass 1

    if (!date) return;
    if (!state[date]) state[date] = {};
    const s = state[date];

    if (action === 'inventory') {
      try {
        const snaps = JSON.parse(row.snapshots || '[]');
        const cf = {}, fr = {};
        snaps.forEach(sn => {
          const k = canonicalSku(sn.sku);
          if (!k) return;
          cf[k] = Number(sn.coldFerment) || 0;
          fr[k] = Number(sn.frozen)      || 0;
        });
        s.coldFerment = cf; s.frozen = fr;
      } catch {}
      if (row.timeStamp && (!latestInventoryTs || row.timeStamp > latestInventoryTs)) {
        latestInventoryTs = row.timeStamp;
      }
      return;
    }
    if (action === 'shape_done') {
      try {
        const incoming = JSON.parse(row.completions || '[]');
        const merged = {};
        (s.shapeDone || []).forEach(c => { merged[c.sku] = (merged[c.sku] || 0) + (Number(c.batches) || 0); });
        incoming.forEach(c => {
          const k = canonicalSku(c.sku);
          if (!k) return;
          merged[k] = (merged[k] || 0) + (Number(c.batches) || 0);
        });
        s.shapeDone    = Object.entries(merged).map(([sku, batches]) => ({ sku, batches }));
        s.shapeWorkers = Number(row.workers) || 1;
        s.shapeTime    = row.timeStamp;
      } catch {}
      return;
    }
    if (action === 'bfp_done') {
      try {
        const incoming = JSON.parse(row.completions || '[]');
        const merged = {};
        (s.bfpDone || []).forEach(c => { merged[c.sku] = (merged[c.sku] || 0) + (Number(c.batches) || 0); });
        incoming.forEach(c => {
          const k = canonicalSku(c.sku);
          if (!k) return;
          merged[k] = (merged[k] || 0) + (Number(c.batches) || 0);
        });
        s.bfpDone    = Object.entries(merged).map(([sku, batches]) => ({ sku, batches }));
        s.bfpWorkers = Number(row.workers) || 1;
        s.bfpTime    = row.timeStamp;
      } catch {}
      return;
    }
    if (action === 'cheese_done') {
      // FOH cheese maker logs a batch (or partial batch via a stepper).
      // Each batch = CHEESE_BATCH_SIZE dips → cf += N × CHEESE_BATCH_SIZE.
      // Same accumulation pattern as shape_done/bfp_done.
      try {
        const incoming = JSON.parse(row.completions || '[]');
        const merged = {};
        (s.cheeseDone || []).forEach(c => { merged[c.sku] = (merged[c.sku] || 0) + (Number(c.batches) || 0); });
        incoming.forEach(c => {
          const k = canonicalSku(c.sku);
          if (!k) return;
          merged[k] = (merged[k] || 0) + (Number(c.batches) || 0);
        });
        s.cheeseDone    = Object.entries(merged).map(([sku, batches]) => ({ sku, batches }));
        s.cheeseWorkers = Number(row.workers) || 1;
        s.cheeseTime    = row.timeStamp;
      } catch {}
      return;
    }
    if (action === 'workers_config') {
      const n = Math.max(1, Number(row.workers) || 1);
      if (row.type === 'shape') s.shapeWorkers = n;
      else if (row.type === 'bfp') s.bfpWorkers = n;
      return;
    }
  });

  return { state, skuConfig, skuAliases, latestInventoryTs, productionLogs };
}

// ─── INVENTORY HELPERS ────────────────────────────────────────────────────

/**
 * Last-counted state across all snapshots. Internal helper —
 * callers should use getInventoryReport().
 */
export function getLatestInventory(productionState) {
  const cf = {}, fr = {};
  Object.keys(productionState).sort().forEach(ds => {
    const s = productionState[ds];
    Object.entries(s.coldFerment || {}).forEach(([sku, n]) => { cf[sku] = Number(n) || 0; });
    Object.entries(s.frozen      || {}).forEach(([sku, n]) => { fr[sku] = Number(n) || 0; });
  });
  return { coldFerment: cf, frozen: fr };
}

/**
 * SINGLE SOURCE OF TRUTH for inventory state. Returns the current effective
 * state plus the FIFO dough age queue, "since-snapshot" flow breakdown, and
 * aging-dough alerts.
 *
 * All numbers tagged with timestamps. Same-day events use timestamp comparison
 * (not date) so a mid-day count correctly excludes pre-count events while
 * crediting post-count ones.
 *
 * @param {Object} args
 * @param {Array}  args.productionLogs        Raw production rows.
 * @param {Object} args.productionState       From resolveProductionLogs.
 * @param {Array}  args.allDeliveries         Resolved deliveries (for delivery deductions).
 * @param {Object} args.skuAliases
 * @param {string|null} args.latestInventoryTs
 * @param {(sku: string) => number} args.getBatchSize
 */
export function getInventoryReport(args) {
  const {
    productionLogs, productionState, allDeliveries,
    skuAliases, latestInventoryTs, getBatchSize,
  } = args;

  const inv          = getLatestInventory(productionState);
  const cf           = { ...inv.coldFerment };
  const fr           = { ...inv.frozen };
  const snapshotRaw  = { coldFerment: { ...inv.coldFerment }, frozen: { ...inv.frozen } };
  const latestInvDate = Object.keys(productionState)
    .filter(ds => Object.keys(productionState[ds].coldFerment || {}).length > 0 ||
                  Object.keys(productionState[ds].frozen      || {}).length > 0)
    .sort().pop() || null;

  // Seed dough queue with snapshot cf — conservative ts = snapshot timestamp.
  const doughQueue = {};
  const seedTs     = latestInventoryTs || new Date(0).toISOString();
  Object.entries(cf).forEach(([sku, p]) => {
    doughQueue[sku] = p > 0 ? [{ ts: seedTs, pretzels: p }] : [];
  });

  const flowShape     = {};
  const flowBfp       = {};
  const flowDelivered = {};

  // Walk events in TIMESTAMP order (defensive against out-of-order log writes)
  const sortedLogs = [...(productionLogs || [])].sort(
    (a, b) => (a.timeStamp || '').localeCompare(b.timeStamp || '')
  );

  sortedLogs.forEach(row => {
    const ts = row.timeStamp || '';
    if (latestInventoryTs && ts <= latestInventoryTs) return;

    if (row.action === 'shape_done') {
      let comps = []; try { comps = JSON.parse(row.completions || '[]'); } catch {}
      comps.forEach(c => {
        let key = (c.sku || '').trim();
        if (!key) return;
        if (skuAliases[key]) key = skuAliases[key];
        const bs = getBatchSize(key);
        if (!bs) return;
        const batches = Number(c.batches) || 0;
        const p       = batches * bs;
        cf[key]       = (cf[key] || 0) + p;
        flowShape[key] = (flowShape[key] || 0) + batches;
        if (!doughQueue[key]) doughQueue[key] = [];
        if (p >= 0) {
          doughQueue[key].push({ ts, pretzels: p });
        } else {
          let toRemove = -p;
          while (toRemove > 0 && doughQueue[key].length > 0) {
            const last = doughQueue[key][doughQueue[key].length - 1];
            const take = Math.min(last.pretzels, toRemove);
            last.pretzels -= take;
            toRemove      -= take;
            if (last.pretzels <= 0) doughQueue[key].pop();
          }
        }
      });
    } else if (row.action === 'bfp_done') {
      let comps = []; try { comps = JSON.parse(row.completions || '[]'); } catch {}
      comps.forEach(c => {
        let key = (c.sku || '').trim();
        if (!key) return;
        if (skuAliases[key]) key = skuAliases[key];
        const bs = getBatchSize(key);
        if (!bs) return;
        const batches = Number(c.batches) || 0;
        const p       = batches * bs;
        cf[key]       = Math.max(0, (cf[key] || 0) - p);
        fr[key]       = (fr[key] || 0) + p;
        flowBfp[key]  = (flowBfp[key] || 0) + batches;
        if (!doughQueue[key]) doughQueue[key] = [];
        if (p >= 0) {
          let toConsume = p;
          while (toConsume > 0 && doughQueue[key].length > 0) {
            const oldest = doughQueue[key][0];
            const take   = Math.min(oldest.pretzels, toConsume);
            oldest.pretzels -= take;
            toConsume       -= take;
            if (oldest.pretzels <= 0) doughQueue[key].shift();
          }
        } else {
          doughQueue[key].unshift({ ts, pretzels: -p });
        }
      });
    } else if (row.action === 'cheese_done') {
      // FOH cheese batch: 1 batch = CHEESE_BATCH_SIZE dips; lives in cf
      // (refrigerated) until consumed by deliveries or FOH walk-in.
      // No separate "bake" stage — single-step product. Same dough-age
      // queue mechanics so the 5-day shelf-life alert fires.
      let comps = []; try { comps = JSON.parse(row.completions || '[]'); } catch {}
      comps.forEach(c => {
        let key = (c.sku || '').trim();
        if (!key) return;
        if (skuAliases[key]) key = skuAliases[key];
        const bs = getBatchSize(key);
        if (!bs) return;
        const batches = Number(c.batches) || 0;
        const p       = batches * bs;
        cf[key]       = (cf[key] || 0) + p;
        if (!doughQueue[key]) doughQueue[key] = [];
        if (p >= 0) {
          doughQueue[key].push({ ts, pretzels: p });
        } else {
          let toRemove = -p;
          while (toRemove > 0 && doughQueue[key].length > 0) {
            const last = doughQueue[key][doughQueue[key].length - 1];
            const take = Math.min(last.pretzels, toRemove);
            last.pretzels -= take;
            toRemove      -= take;
            if (last.pretzels <= 0) doughQueue[key].pop();
          }
        }
      });
    }
  });

  (allDeliveries || [])
    .filter(d => {
      if (!['delivered','picked_up'].includes(d.status)) return false;
      if (!latestInventoryTs) return true;
      return d._confirmedAt && d._confirmedAt > latestInventoryTs;
    })
    .forEach(delivery => {
      let items = [];
      try { items = JSON.parse(delivery.lineItems || '[]'); } catch {}
      const cust = delivery.customer || delivery.location || '?';
      items.forEach(({ sku, quantity }) => {
        let key = sku?.trim();
        if (!key) return;
        if (skuAliases[key]) key = skuAliases[key];
        const qty = Number(quantity) || 0;
        if (qty <= 0) return;
        if (fr[key] != null) fr[key] = Math.max(0, fr[key] - qty);
        if (!flowDelivered[key]) flowDelivered[key] = [];
        flowDelivered[key].push({ customer: cust, qty, confirmedAt: delivery._confirmedAt || '' });
      });
    });

  Object.keys(cf).forEach(k => { cf[k] = Math.max(0, Math.round(cf[k])); });
  Object.keys(fr).forEach(k => { fr[k] = Math.max(0, Math.round(fr[k])); });

  // Aging dough alerts
  const now = Date.now();
  const agingDough = [];
  Object.entries(doughQueue).forEach(([sku, queue]) => {
    queue.forEach(entry => {
      if (entry.pretzels <= 0) return;
      const ageMs   = now - new Date(entry.ts).getTime();
      const ageDays = ageMs / 86400000;
      if (ageDays >= DOUGH_AGE_WARN_DAYS) {
        agingDough.push({
          sku,
          ageDays:  Math.floor(ageDays),
          pretzels: Math.round(entry.pretzels),
          critical: ageDays >= DOUGH_AGE_FAIL_DAYS,
        });
      }
    });
  });
  agingDough.sort((a, b) => b.ageDays - a.ageDays);

  return {
    effective:          { coldFerment: cf, frozen: fr },
    doughQueue,
    flowsSinceSnapshot: { shape: flowShape, bfp: flowBfp, delivered: flowDelivered },
    alerts:             { agingDough },
    snapshot:           { date: latestInvDate, timestamp: latestInventoryTs, raw: snapshotRaw },
  };
}

// ─── DELIVERY COVERAGE ATTRIBUTION ────────────────────────────────────────

const STATUS_RANK = { ready: 0, baking: 1, partial: 2, unstarted: 3 };
const WORST_STATUS = (a, b) => (STATUS_RANK[a] >= STATUS_RANK[b] ? a : b);

function statusFor(qty, frozenP, doughP) {
  if (qty <= 0) return 'ready';
  if (frozenP >= qty) return 'ready';
  if (frozenP + doughP >= qty) return 'baking';
  if (frozenP + doughP > 0) return 'partial';
  return 'unstarted';
}

/**
 * FIFO attribute current effective inventory across active deliveries.
 * Returns Map<deliveryId, {sku→{qty, frozenP, doughP, needShapeP, needBfpP, status}, aggregateStatus}>.
 *
 * Each delivery may have multiple SKUs. `aggregateStatus` is the worst child
 * status — used for one-line UI badges. Lines whose SKU has no batchSize
 * (FOH or unconfigured) are excluded entirely — they shouldn't drag the
 * aggregate to "to make" since they aren't produced in-house.
 *
 * @param {Object} args
 * @param {Array}  args.activeDeliveries   Deliveries with status NOT in delivered/picked_up/cancelled.
 * @param {Object} args.inventoryReport    From getInventoryReport.
 * @param {Object} args.skuAliases
 * @param {(sku: string) => number} [args.getBatchSize]  If provided, lines where
 *        getBatchSize(canonicalSku) === 0 are skipped (FOH/unconfigured).
 */
export function attributeDeliveryCoverage({ activeDeliveries, inventoryReport, skuAliases, getBatchSize }) {
  // Build per-SKU FIFO queue of {deliveryId, qty}, sorted by date then timestamp.
  const sortedDeliveries = [...activeDeliveries].sort((a, b) => {
    const d = (a.date || '').localeCompare(b.date || '');
    return d !== 0 ? d : (a.timeStamp || '').localeCompare(b.timeStamp || '');
  });

  // Track per-SKU remaining inventory as we walk deliveries
  const frozenLeft = { ...inventoryReport.effective.frozen };
  const doughLeft  = { ...inventoryReport.effective.coldFerment };

  const coverage = new Map();

  sortedDeliveries.forEach(delivery => {
    const id = delivery.deliveryId;
    if (!id) return;
    let lineItems = [];
    try { lineItems = JSON.parse(delivery.lineItems || '[]'); } catch {}
    const lines = {};
    let aggregate = 'ready';
    let hasProductionSku = false;

    lineItems.forEach(({ sku, quantity }) => {
      let key = (sku || '').trim();
      if (!key) return;
      if (skuAliases[key]) key = skuAliases[key];
      const qty = Number(quantity) || 0;
      if (qty <= 0) return;
      // Skip FOH/unconfigured SKUs — they aren't produced in-house, so
      // they shouldn't drag the aggregate to "to make".
      if (getBatchSize && getBatchSize(key) === 0) return;
      hasProductionSku = true;

      const fAvail = frozenLeft[key] || 0;
      const dAvail = doughLeft[key]  || 0;

      const frozenP = Math.min(fAvail, qty);
      frozenLeft[key] = fAvail - frozenP;

      const remainingAfterFrozen = qty - frozenP;
      const doughP = Math.min(dAvail, remainingAfterFrozen);
      doughLeft[key] = dAvail - doughP;

      const needShapeP = Math.max(0, qty - frozenP - doughP);
      const needBfpP   = Math.max(0, qty - frozenP);
      const lineStatus = statusFor(qty, frozenP, doughP);

      lines[key] = {
        sku: key,
        qty,
        frozenP,
        doughP,
        needShapeP,
        needBfpP,
        status: lineStatus,
      };
      aggregate = WORST_STATUS(aggregate, lineStatus);
    });

    coverage.set(id, {
      deliveryId: id,
      date:       delivery.date || '',
      customer:   delivery.customer || delivery.location || '',
      lines,
      aggregateStatus: hasProductionSku ? aggregate : null,
    });
  });

  return coverage;
}

// ─── CHEESE-DIP PRODUCTION SCHEDULING ─────────────────────────────────────

const CHEESE_SKU_KEY = '3oz cheese dip';

// ISO-date helpers — keep cheese math purely string-based to avoid TZ pitfalls.
function _parseISODate(s) {
  const [y, m, d] = (s || '').split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}
function _addDaysISO(s, n) {
  const dt = _parseISODate(s);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/**
 * Schedule cheese-dip batches for the FOH cheese maker.
 *
 * Phantom-delivery model: combines per-day delivery demand (from active
 * deliveries with `3oz cheese dip` line items) with a constant FOH walk-in
 * rate (`fohDailyAvg`, fed in from the Square consumption endpoint), then
 * walks forward day-by-day. When inventory would dip negative, schedules
 * one batch on the LATEST valid day inside the [delivery − CHEESE_MAX_LEAD,
 * delivery − CHEESE_MIN_LEAD] window. Honors the 1-batch/day capacity cap.
 *
 * Used by:
 *   - production app (Cheese tab) — manager sees per-day "make a batch" cards.
 *   - worker (/foh-cal.ics) — emits an iCalendar VEVENT per scheduled batch.
 * Both call this exact function so the calendar and the manager view never
 * disagree.
 *
 * @param {Object} args
 * @param {Array}  args.deliveries          Resolved deliveries (active + confirmed).
 * @param {Object} args.inventoryReport     From getInventoryReport.
 * @param {number} args.fohDailyAvg         Average FOH walk-in cheese dips/day (Square).
 * @param {string} args.today               'YYYY-MM-DD' (Mountain TZ).
 * @param {Object} args.skuAliases          From resolveProductionLogs.
 * @param {number} [args.lookaheadDays=14]  How far forward to plan.
 * @returns {{
 *   batches: Array<{date: string, dayIndex: number, covers: Array<{customer, qty, deliveryDate}>, foh: number, overdue: boolean}>,
 *   demandByDate: Array<{date: string, delivery: number, foh: number, total: number}>,
 *   startInventory: number,
 *   fohDailyAvg: number,
 * }}
 */
export function scheduleCheese({
  deliveries, inventoryReport, fohDailyAvg, today, skuAliases, lookaheadDays = 14,
}) {
  const dailyAvg = Math.max(0, Number(fohDailyAvg) || 0);
  // Look further than the user-visible horizon so the algorithm "sees" deliveries
  // whose window straddles the edge (e.g. a delivery on day 16 has a window
  // ending on day 14, which we still need to plan for).
  const dayCount = lookaheadDays + CHEESE_MAX_LEAD + 1;

  // Per-day demand. delivery from line items; foh constant (manager-tunable
  // via Square consumption endpoint). We accumulate "covers" for each day
  // so the calendar event can list which customers a batch is for.
  const demand = Array.from({ length: dayCount }, (_, i) => ({
    date:     _addDaysISO(today, i),
    delivery: 0,
    foh:      dailyAvg,
    total:    dailyAvg,
    covers:   [],   // [{ customer, qty, deliveryDate }]
  }));

  (deliveries || []).forEach(d => {
    if (['delivered','picked_up','cancelled'].includes(d.status)) return;
    if (!d.date || d.date < today) return; // past unconfirmed ghosts don't count
    let lineItems = [];
    try { lineItems = JSON.parse(d.lineItems || '[]'); } catch {}
    let cheeseQty = 0;
    lineItems.forEach(({ sku, quantity }) => {
      let key = (sku || '').trim();
      if (skuAliases && skuAliases[key]) key = skuAliases[key];
      if (key !== CHEESE_SKU_KEY) return;
      cheeseQty += Number(quantity) || 0;
    });
    if (cheeseQty <= 0) return;
    // Find the day index for this delivery (today=0).
    const dayIdx = (() => {
      const ms = _parseISODate(d.date) - _parseISODate(today);
      return Math.round(ms / 86400000);
    })();
    if (dayIdx < 0 || dayIdx >= dayCount) return;
    demand[dayIdx].delivery += cheeseQty;
    demand[dayIdx].total    += cheeseQty;
    demand[dayIdx].covers.push({
      customer: d.customer || d.location || '?',
      qty:      cheeseQty,
      deliveryDate: d.date,
    });
  });

  // Starting inventory = effective cf for cheese (cheese_done credits live
  // here too — same convention as dough). Frozen is unused for cheese
  // (it's refrigerated, not frozen).
  const startInventory = (inventoryReport?.effective?.coldFerment?.[CHEESE_SKU_KEY]) || 0;

  // Walk forward. Track running stock. When stock would go negative on day i,
  // schedule a batch on the latest valid day inside the [i-MAX_LEAD, i-MIN_LEAD]
  // window. If no valid day exists (all in the past, or all already booked),
  // mark it as overdue and force-place on today.
  const batches = [];
  const hasBatchOn = (dayIdx) => batches.some(b => b.dayIndex === dayIdx);

  let inv = startInventory;
  for (let i = 0; i < dayCount; i++) {
    inv -= demand[i].total;
    while (inv < 0) {
      // Need 1 more batch placed on a day < i and within the window.
      let placed = false;
      const earliest = Math.max(0, i - CHEESE_MAX_LEAD);
      const latest   = i - CHEESE_MIN_LEAD;
      for (let j = latest; j >= earliest; j--) {
        if (j < 0) break;
        if (hasBatchOn(j)) continue;
        batches.push({
          date:      demand[j].date,
          dayIndex:  j,
          covers:    [...demand[i].covers],
          foh:       demand[i].foh,
          overdue:   false,
          fillsDay:  i,
        });
        inv += CHEESE_BATCH_SIZE;
        placed = true;
        break;
      }
      if (!placed) {
        // Window's all past or full. Force-place on today (or earliest open day)
        // and flag overdue so the manager knows it's late.
        for (let j = 0; j < i; j++) {
          if (!hasBatchOn(j)) {
            batches.push({
              date:     demand[j].date,
              dayIndex: j,
              covers:   [...demand[i].covers],
              foh:      demand[i].foh,
              overdue:  true,
              fillsDay: i,
            });
            inv += CHEESE_BATCH_SIZE;
            placed = true;
            break;
          }
        }
        if (!placed) {
          // Even today is full or i=0. Bail to avoid infinite loop.
          break;
        }
      }
    }
  }

  return {
    batches: batches.sort((a, b) => a.dayIndex - b.dayIndex),
    demandByDate: demand.slice(0, lookaheadDays + 1),
    startInventory,
    fohDailyAvg: dailyAvg,
  };
}

export const CHEESE_KEY = CHEESE_SKU_KEY; // exported for callers that need the canonical SKU name

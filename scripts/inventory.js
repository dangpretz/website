/* eslint-disable
   no-underscore-dangle,
   no-empty,
   no-plusplus,
   no-continue,
   no-restricted-syntax,
   max-len
*/
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

export const DOUGH_AGE_WARN_DAYS = 5; // yellow aging-dough banner threshold
export const DOUGH_AGE_FAIL_DAYS = 6; // red banner — discard or use today

// FOH dip production rules — one entry per SKU made by the FOH cheese maker.
// Lead-time: a batch must be ready ≥ minLead days before consumption, but
// can be made up to maxLead days ahead. Past maxLead the batch goes stale.
//   - cheese is one batch size only (150 dips); single/double map to same value
//   - retail dips have a single (35) or double (70) batch size — the scheduler
//     picks single by default, upgrades to double if the same-day deficit
//     exceeds singleBatchSize
//   - all dips share the same FOH cheese maker (dailyCap=1 across the lane;
//     enforcement in scheduleDip is per-SKU for now — Phase 4 cross-dip cap
//     deferred)
export const DIP_CONFIG = {
  '3oz cheese dip': {
    key: 'cheese',
    emoji: '🧀',
    label: 'cheese dip',
    minLead: 2,
    maxLead: 5,
    singleBatchSize: 150,
    doubleBatchSize: 150, // cheese has only one size
    dailyCap: 1,
    shelfLifeDays: 5,
    // Square match patterns — used by the worker's /dip-consumption endpoint.
    squareNames: [/^dangerous\s*dip(\s*-\s*catering)?$/i],
    squareModifiers: [/^dangerous\s*dip$/i],
  },
  'hot ranch dip': {
    key: 'hot-ranch',
    emoji: '🌶',
    label: 'hot ranch',
    minLead: 1,
    maxLead: 7,
    singleBatchSize: 35,
    doubleBatchSize: 70,
    dailyCap: 1,
    shelfLifeDays: 7,
    squareNames: [/^hot\s*ranch(\s*-\s*catering)?$/i],
    squareModifiers: [/^hot\s*ranch$/i],
  },
  'sweet cream dip': {
    key: 'sweet-cream',
    emoji: '🥛',
    label: 'sweet cream',
    minLead: 1,
    maxLead: 7,
    singleBatchSize: 35,
    doubleBatchSize: 70,
    dailyCap: 1,
    shelfLifeDays: 7,
    squareNames: [/^sweet\s*cream(\s*-\s*catering)?$/i],
    squareModifiers: [/^sweet\s*cream$/i],
  },
  'house mustard dip': {
    key: 'house-mustard',
    emoji: '💛',
    label: 'house mustard',
    minLead: 1,
    maxLead: 7,
    singleBatchSize: 35,
    doubleBatchSize: 70,
    dailyCap: 1,
    shelfLifeDays: 7,
    squareNames: [/^house\s*mustard(\s*-\s*catering)?$/i],
    squareModifiers: [/^house\s*mustard$/i],
  },
  'honey mustard dip': {
    key: 'honey-mustard',
    emoji: '🍯',
    label: 'honey mustard',
    minLead: 1,
    maxLead: 7,
    singleBatchSize: 35,
    doubleBatchSize: 70,
    dailyCap: 1,
    shelfLifeDays: 7,
    squareNames: [/^honey\s*mustard(\s*-\s*catering)?$/i],
    squareModifiers: [/^honey\s*mustard$/i],
  },
};

// Backward-compat shims — callers that imported the old constants still work.
// Phase 3b+ should read DIP_CONFIG['3oz cheese dip'] directly.
export const CHEESE_MIN_LEAD = DIP_CONFIG['3oz cheese dip'].minLead;
export const CHEESE_MAX_LEAD = DIP_CONFIG['3oz cheese dip'].maxLead;
export const CHEESE_BATCH_SIZE = DIP_CONFIG['3oz cheese dip'].singleBatchSize;
export const CHEESE_DAILY_CAP = DIP_CONFIG['3oz cheese dip'].dailyCap;

// Pretzels per batch (per-SKU; skuConfig override takes priority).
// 3oz cheese dip is in here at batchSize 150 — it's tracked production now,
// not FOH-excluded as before.
export const BATCH_SIZES = {
  '21oz mammoth pretzel': 24,
  '10oz mustache': 48,
  '10oz plain': 48,
  '10oz bbk': 48,
  '10oz spicy bee': 48,
  '6.5oz plain': 72,
  '6.5oz bbk': 72,
  '6.5oz spicy bee': 72,
  'plain bombs': 432,
  'bees bats': 48,
  '3oz cheese dip': CHEESE_BATCH_SIZE,
};

// Pretzels per case — wholesale shipping unit. Default per SKU; managers
// can pick from CASE_SIZE_OPTIONS per delivery.
export const CASE_SIZES = {
  '21oz mammoth pretzel': 25,
  '10oz mustache': 48,
  '10oz plain': 48,
  '10oz bbk': 48,
  '10oz spicy bee': 48,
  '6.5oz plain': 72,
  '6.5oz bbk': 72,
  '6.5oz spicy bee': 72,
  '4oz twist plain': 40,
  '4oz twist bbk': 40,
  '4oz twist spicy bee': 40,
  'plain bombs': 0,
  'bees bats': 0,
};

// Per-SKU allowed case sizes. First value = default selection in dropdown.
// SKUs missing or empty array → no standard cases (pretzel-only entry).
// 10oz and 6.5oz pretzels ship in two sizes depending on the customer's
// order; manager picks per delivery line item in the planner form.
export const CASE_SIZE_OPTIONS = {
  '21oz mammoth pretzel': [25],
  '10oz mustache': [48, 20],
  '10oz plain': [48, 20],
  '10oz bbk': [48, 20],
  '10oz spicy bee': [48, 20],
  '6.5oz plain': [72, 36],
  '6.5oz bbk': [72, 36],
  '6.5oz spicy bee': [72, 36],
  '4oz twist plain': [40],
  '4oz twist bbk': [40],
  '4oz twist spicy bee': [40],
};

/**
 * Allowed case sizes for an SKU (after alias resolution if applicable).
 * Returns [] when the SKU has no standard case (pretzel-only entry).
 */
export function caseSizeOptionsFor(sku) {
  return CASE_SIZE_OPTIONS[sku] || [];
}

// Pretzels per baking sheet (tray) — BFP team's natural unit.
export const TRAY_SIZES = {
  '21oz mammoth pretzel': 2,
  '10oz mustache': 4,
  '10oz plain': 4,
  '10oz bbk': 4,
  '10oz spicy bee': 4,
  '6.5oz plain': 9,
  '6.5oz bbk': 9,
  '6.5oz spicy bee': 9,
  '4oz twist plain': 12,
  '4oz twist bbk': 12,
  '4oz twist spicy bee': 12,
  'bees bats': 6,
  'plain bombs': 0,
};

// SKUs that aren't produced in-house (front-of-house pre-made / sourced).
// Note: `3oz cheese dip` USED to be here but is now tracked production
// (FOH makes it on-site in batches of 150). Bulk pre-mixed dip + individual
// catering-portion dips (dangerous, sweet cream) are FOH — they're
// portioned fresh during fulfillment, no production scheduling.
export const FOH_SKUS = new Set([
  'bulk dangerous dip (25 srv)',
  '3oz dangerous dip',
  '3oz sweet cream dip',
]);

// SKUs that need a coating step at BFP (cheese on top during bake).
export const BAKE_GROUPS = {
  coating: ['10oz bbk', '6.5oz bbk', '4oz twist bbk'],
};

// ─── SHAPE-ONLY (CATERING / FOH) RULES ────────────────────────────────────
// Some deliveries leave the production pipeline at the dough stage:
//   - Catering boxes are baked + boxed fresh in the FOH store at fulfillment.
//   - The "FOH Placeholder" customer represents FOH retail walk-in stock.
// For those, shape team makes the dough; BFP team does NOT bake/freeze them.
// Detection is automatic: ANY line item starting with "Catering:" OR a
// customer name matching FOH_PLACEHOLDER_NAME (case-insensitive).

export const FOH_PLACEHOLDER_NAME = 'FOH Placeholder';

// Default catering box → pretzel expansions, used when a per-box override
// hasn't been written to skuConfig yet. Manager can override via the
// production app's "Box mapping" tab — those entries take priority.
//
// User-confirmed mappings:
//   Catering: Salty Pretzel Box      → 15 × 6.5oz plain         (2026-05-05)
//   Catering: BBK Pretzel Box - 15   → 15 × 6.5oz bbk           (2026-05-05)
//   Catering: Saint Pretzel Box      → 15 × 6.5oz plain         (2026-05-07; FOH tops w/ cinn sugar)
//   Catering: Dangerous Dip Box      → 15 × 3oz dangerous dip   (2026-05-07; FOH portions fresh)
//   Catering: Swell Cream Box - 15   → 15 × 3oz sweet cream dip (2026-05-07; FOH portions fresh)
export const DEFAULT_BOX_EXPANSIONS = {
  'Catering: Salty Pretzel Box': [{ sku: '6.5oz plain', multiplier: 15 }],
  'Catering: BBK Pretzel Box - 15': [{ sku: '6.5oz bbk', multiplier: 15 }],
  'Catering: Saint Pretzel Box': [{ sku: '6.5oz plain', multiplier: 15 }],
  'Catering: Dangerous Dip Box': [{ sku: '3oz dangerous dip', multiplier: 15 }],
  'Catering: Swell Cream Box - 15': [{ sku: '3oz sweet cream dip', multiplier: 15 }],
};

/**
 * True if a delivery should be classified as shape-only (skip BFP).
 * MUST be called BEFORE expanding box line items, since detection looks
 * at the original "Catering: ..." prefixes.
 */
export function isShapeOnlyDelivery(d) {
  if (!d) return false;
  const customer = (d.customer || d.location || '').trim().toLowerCase();
  if (customer === FOH_PLACEHOLDER_NAME.toLowerCase()) return true;
  let items = [];
  try { items = JSON.parse(d.lineItems || '[]'); } catch (_) {}
  if (!Array.isArray(items)) return false;
  return items.some((li) => /^catering:/i.test((li.sku || li.name || '').trim()));
}

/**
 * Expand catering-box line items into their constituent pretzel/dip SKUs.
 * Pure function. Lookups: skuConfig[box].expandsTo first, then DEFAULT_BOX_EXPANSIONS.
 * Boxes with no mapping pass through unchanged (manager sees them as
 * "New SKU in orders" and can set up via the box-mapping tab).
 *
 * @param {Array} lineItems  [{sku|name, quantity}]
 * @param {Object} skuConfig
 * @returns {Array} new line item array (does not mutate input)
 */
export function expandBoxLineItems(lineItems, skuConfig = {}) {
  if (!Array.isArray(lineItems)) return [];
  const out = [];
  for (const li of lineItems) {
    const key = (li.sku || li.name || '').trim();
    const qty = Number(li.quantity) || 0;
    if (!key || qty <= 0) { out.push(li); continue; }
    const cfg = skuConfig[key];
    const expansion = (cfg?.expandsTo && cfg.expandsTo.length ? cfg.expandsTo : null)
      || DEFAULT_BOX_EXPANSIONS[key]
      || null;
    if (!expansion) { out.push(li); continue; }
    for (const { sku: targetSku, multiplier } of expansion) {
      const m = Number(multiplier) || 0;
      if (!targetSku || m <= 0) continue;
      out.push({ sku: targetSku, quantity: qty * m });
    }
  }
  // Dedupe pass: merge same-SKU line items by summing quantity. Avoids two
  // pills/coverage-lines for the same product when Square sends both a
  // catering box AND its constituent pretzels (the box's expansion
  // collides with the standalone line item). Case info preserved from the
  // FIRST occurrence of each SKU; later occurrences contribute only qty.
  const byKey = new Map();
  const merged = [];
  for (const li of out) {
    const k = (li.sku || li.name || '').trim();
    const q = Number(li.quantity) || 0;
    if (!k || q <= 0) { merged.push(li); continue; }
    if (!byKey.has(k)) {
      const idx = merged.length;
      const copy = { ...li, quantity: q };
      merged.push(copy);
      byKey.set(k, idx);
    } else {
      const idx = byKey.get(k);
      merged[idx].quantity = (Number(merged[idx].quantity) || 0) + q;
    }
  }
  return merged;
}

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
    getBatchSize: (sku) => (skuConfig[sku]?.batchSize > 0 ? skuConfig[sku].batchSize : 0) || BATCH_SIZES[sku] || 0,
    getTraySize: (sku) => (skuConfig[sku]?.traySize > 0 ? skuConfig[sku].traySize : 0) || TRAY_SIZES[sku] || 0,
    getCaseSize: (sku) => (skuConfig[sku]?.caseSize > 0 ? skuConfig[sku].caseSize : 0) || CASE_SIZES[sku] || 0,
    isFOH: (sku) => (skuConfig[sku] ? skuConfig[sku].type === 'foh' : FOH_SKUS.has((sku || '').toLowerCase()) || FOH_SKUS.has(sku)),
    isCoating: (sku) => (skuConfig[sku] ? skuConfig[sku].type === 'coating' : BAKE_GROUPS.coating.includes(sku)),
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
 *
 * @param {Array} logs
 * @param {Object} [options]
 * @param {boolean} [options.shapeOnlyEnabled=false]  Gate the new behavior.
 *   When true: each resolved delivery gets a `_shapeOnly` flag (computed
 *   BEFORE expansion, so "Catering:" prefix detection works), and box line
 *   items are expanded per skuConfig + DEFAULT_BOX_EXPANSIONS.
 * @param {Object} [options.skuConfig={}]  For box expansions.
 */
export function resolveDeliveries(logs, options = {}) {
  const { shapeOnlyEnabled = false, skuConfig = {} } = options;
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
        if (['delivered', 'picked_up'].includes(byId[id].status)) byId[id]._confirmedAt = row.timeStamp || '';
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
  const out = Object.values(byId);
  if (shapeOnlyEnabled) {
    for (const d of out) {
      // Detect BEFORE expansion so the "Catering:" prefix check still matches.
      d._shapeOnly = isShapeOnlyDelivery(d);
      // Expand box line items in place. Original sheet row stays untouched;
      // this only mutates the resolved record's lineItems string.
      try {
        const items = JSON.parse(d.lineItems || '[]');
        const expanded = expandBoxLineItems(items, skuConfig);
        if (expanded !== items) d.lineItems = JSON.stringify(expanded);
      } catch (_) {}
    }
  }
  return out;
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
  // packedCases keyed by deliveryId → { canonicalSku → { caseIndex → {packed, ts} } }
  // Last-write-wins per (deliveryId, sku, caseIndex). Tap to pack, tap again
  // to unpack. Display-side counts entries where packed === true.
  const packedCases = {};
  let latestInventoryTs = null;

  // Pass 1: collect skuConfig + skuAliases. We need ALL aliases known
  // before walking shape_done/bfp_done so completion entries logged under
  // OLD aliased names (e.g. "Twist - Plain") get canonicalized to
  // "4oz twist plain" — even if the alias row appears later in the log
  // than the completion row.
  productionLogs.forEach((row) => {
    if (row.action === 'sku_config') {
      if (row.sku) {
        // Optional `expandsTo` JSON column — used for catering box → pretzel
        // expansion mappings. Parse safely; bad JSON falls back to no expansion.
        let expandsTo = null;
        if (row.expandsTo) {
          try {
            const parsed = JSON.parse(row.expandsTo);
            if (Array.isArray(parsed)) expandsTo = parsed;
          } catch (_) {}
        }
        skuConfig[row.sku] = {
          batchSize: Number(row.batchSize) || 0,
          traySize: Number(row.traySize) || 0,
          caseSize: Number(row.caseSize) || 0,
          type: row.type || 'standard',
          ...(expandsTo ? { expandsTo } : {}),
        };
      }
    } else if (row.action === 'sku_alias') {
      const from = (row.from || '').trim();
      const to = (row.to || '').trim();
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
  productionLogs.forEach((row) => {
    const { date, action } = row;
    if (!action) return;
    if (action === 'sku_config' || action === 'sku_alias') return; // handled in pass 1

    if (!date) return;
    if (!state[date]) state[date] = {};
    const s = state[date];

    if (action === 'inventory') {
      try {
        const snaps = JSON.parse(row.snapshots || '[]');
        const cf = {};
        const fr = {};
        const oh = {}; // on-hand bucket — for SKUs with no dough/bake lifecycle (cheese, dips)
        snaps.forEach((sn) => {
          const k = canonicalSku(sn.sku);
          if (!k) return;
          cf[k] = Number(sn.coldFerment) || 0;
          fr[k] = Number(sn.frozen) || 0;
          oh[k] = Number(sn.onHand) || 0;
        });
        s.coldFerment = cf;
        s.frozen = fr;
        s.onHand = oh;
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
        (s.shapeDone || []).forEach((c) => { merged[c.sku] = (merged[c.sku] || 0) + (Number(c.batches) || 0); });
        incoming.forEach((c) => {
          const k = canonicalSku(c.sku);
          if (!k) return;
          merged[k] = (merged[k] || 0) + (Number(c.batches) || 0);
        });
        s.shapeDone = Object.entries(merged).map(([sku, batches]) => ({ sku, batches }));
        s.shapeWorkers = Number(row.workers) || 1;
        s.shapeTime = row.timeStamp;
      } catch {}
      return;
    }
    if (action === 'bfp_done') {
      try {
        const incoming = JSON.parse(row.completions || '[]');
        const merged = {};
        (s.bfpDone || []).forEach((c) => { merged[c.sku] = (merged[c.sku] || 0) + (Number(c.batches) || 0); });
        incoming.forEach((c) => {
          const k = canonicalSku(c.sku);
          if (!k) return;
          merged[k] = (merged[k] || 0) + (Number(c.batches) || 0);
        });
        s.bfpDone = Object.entries(merged).map(([sku, batches]) => ({ sku, batches }));
        s.bfpWorkers = Number(row.workers) || 1;
        s.bfpTime = row.timeStamp;
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
        (s.cheeseDone || []).forEach((c) => { merged[c.sku] = (merged[c.sku] || 0) + (Number(c.batches) || 0); });
        incoming.forEach((c) => {
          const k = canonicalSku(c.sku);
          if (!k) return;
          merged[k] = (merged[k] || 0) + (Number(c.batches) || 0);
        });
        s.cheeseDone = Object.entries(merged).map(([sku, batches]) => ({ sku, batches }));
        s.cheeseWorkers = Number(row.workers) || 1;
        s.cheeseTime = row.timeStamp;
      } catch {}
      return;
    }
    if (action === 'workers_config') {
      const n = Math.max(1, Number(row.workers) || 1);
      if (row.type === 'shape') s.shapeWorkers = n;
      else if (row.type === 'bfp') s.bfpWorkers = n;
    }
  });

  // Pass 3: case_packed events. These are NOT date-keyed because a tap
  // packing a case can happen on a different day than the delivery.
  // Stored top-level keyed by deliveryId. Last-write-wins per case.
  productionLogs.forEach((row) => {
    if (row.action !== 'case_packed') return;
    const deliveryId = row.deliveryId || '';
    if (!deliveryId) return;
    const sku = canonicalSku(row.sku);
    if (!sku) return;
    const caseIndex = Number(row.caseIndex) || 0;
    if (caseIndex <= 0) return;
    if (!packedCases[deliveryId]) packedCases[deliveryId] = {};
    if (!packedCases[deliveryId][sku]) packedCases[deliveryId][sku] = {};
    const prev = packedCases[deliveryId][sku][caseIndex];
    const ts = row.timeStamp || '';
    // Only overwrite if this row is newer (defensive against out-of-order logs).
    if (!prev || (prev.ts || '') < ts) {
      packedCases[deliveryId][sku][caseIndex] = {
        packed: row.packed === 'true' || row.packed === true,
        ts,
      };
    }
  });

  return {
    state, skuConfig, skuAliases, latestInventoryTs, productionLogs, packedCases,
  };
}

// ─── INVENTORY HELPERS ────────────────────────────────────────────────────

/**
 * Last-counted state across all snapshots. Internal helper —
 * callers should use getInventoryReport().
 */
export function getLatestInventory(productionState) {
  const cf = {};
  const fr = {};
  const oh = {};
  Object.keys(productionState).sort().forEach((ds) => {
    const s = productionState[ds];
    Object.entries(s.coldFerment || {}).forEach(([sku, n]) => { cf[sku] = Number(n) || 0; });
    Object.entries(s.frozen || {}).forEach(([sku, n]) => { fr[sku] = Number(n) || 0; });
    Object.entries(s.onHand || {}).forEach(([sku, n]) => { oh[sku] = Number(n) || 0; });
  });
  return { coldFerment: cf, frozen: fr, onHand: oh };
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

  const inv = getLatestInventory(productionState);
  const cf = { ...inv.coldFerment };
  const fr = { ...inv.frozen };
  const oh = { ...(inv.onHand || {}) };
  const snapshotRaw = {
    coldFerment: { ...inv.coldFerment },
    frozen: { ...inv.frozen },
    onHand: { ...(inv.onHand || {}) },
  };
  const latestInvDate = Object.keys(productionState)
    .filter((ds) => Object.keys(productionState[ds].coldFerment || {}).length > 0
                  || Object.keys(productionState[ds].frozen || {}).length > 0
                  || Object.keys(productionState[ds].onHand || {}).length > 0)
    .sort().pop() || null;

  // Seed dough queue with snapshot cf — conservative ts = snapshot timestamp.
  const doughQueue = {};
  const seedTs = latestInventoryTs || new Date(0).toISOString();
  Object.entries(cf).forEach(([sku, p]) => {
    doughQueue[sku] = p > 0 ? [{ ts: seedTs, pretzels: p }] : [];
  });

  const flowShape = {};
  const flowBfp = {};
  const flowDelivered = {};
  // Audit trail of BFP completions that attributed more pretzels than the
  // cold-ferment inventory said existed. Surfaces snapshot inaccuracies
  // before they silently warp the shape team's schedule.
  const bfpOverbakeEvents = [];

  // Walk events in TIMESTAMP order (defensive against out-of-order log writes)
  const sortedLogs = [...(productionLogs || [])].sort(
    (a, b) => (a.timeStamp || '').localeCompare(b.timeStamp || ''),
  );

  sortedLogs.forEach((row) => {
    const ts = row.timeStamp || '';
    if (latestInventoryTs && ts <= latestInventoryTs) return;

    if (row.action === 'shape_done') {
      let comps = []; try { comps = JSON.parse(row.completions || '[]'); } catch {}
      comps.forEach((c) => {
        let key = (c.sku || '').trim();
        if (!key) return;
        if (skuAliases[key]) key = skuAliases[key];
        const bs = getBatchSize(key);
        if (!bs) return;
        const batches = Number(c.batches) || 0;
        const p = batches * bs;
        cf[key] = (cf[key] || 0) + p;
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
            toRemove -= take;
            if (last.pretzels <= 0) doughQueue[key].pop();
          }
        }
      });
    } else if (row.action === 'bfp_done') {
      let comps = []; try { comps = JSON.parse(row.completions || '[]'); } catch {}
      comps.forEach((c) => {
        let key = (c.sku || '').trim();
        if (!key) return;
        if (skuAliases[key]) key = skuAliases[key];
        const bs = getBatchSize(key);
        if (!bs) return;
        const batches = Number(c.batches) || 0;
        const p = batches * bs;
        // Detect overbake: BFP attributed more pretzels than cold-ferment
        // had available. The clamp at max(0, …) means the deficit gets
        // silently swallowed, but the FULL bake still lands in frozen.
        // That phantom frozen reduces shape demand on future deliveries
        // (frozen also covers shape) — schedule mysteriously shrinks for
        // the dough team. Surface it so the manager can fix the snapshot.
        if (p > 0 && (cf[key] || 0) < p) {
          bfpOverbakeEvents.push({
            sku: key,
            batches,
            attributedPretzels: p,
            availableBeforeBake: Math.max(0, cf[key] || 0),
            phantomPretzels: p - Math.max(0, cf[key] || 0),
            ts: ts || '',
          });
        }
        cf[key] = Math.max(0, (cf[key] || 0) - p);
        fr[key] = (fr[key] || 0) + p;
        flowBfp[key] = (flowBfp[key] || 0) + batches;
        if (!doughQueue[key]) doughQueue[key] = [];
        if (p >= 0) {
          let toConsume = p;
          while (toConsume > 0 && doughQueue[key].length > 0) {
            const oldest = doughQueue[key][0];
            const take = Math.min(oldest.pretzels, toConsume);
            oldest.pretzels -= take;
            toConsume -= take;
            if (oldest.pretzels <= 0) doughQueue[key].shift();
          }
        } else {
          doughQueue[key].unshift({ ts, pretzels: -p });
        }
      });
    } else if (row.action === 'cheese_done') {
      // FOH dip batch (cheese or any retail dip in DIP_CONFIG). 1 batch =
      // singleBatchSize dips by default; if c.size === 'double', credits
      // doubleBatchSize. Lives in cf (refrigerated) until consumed by
      // deliveries or FOH walk-in. No separate "bake" stage — single-step
      // product. Same dough-age queue mechanics so the shelf-life alert fires.
      let comps = []; try { comps = JSON.parse(row.completions || '[]'); } catch {}
      comps.forEach((c) => {
        let key = (c.sku || '').trim();
        if (!key) return;
        if (skuAliases[key]) key = skuAliases[key];
        const cfg = DIP_CONFIG[key];
        let bs;
        if (cfg) {
          bs = c.size === 'double' ? cfg.doubleBatchSize : cfg.singleBatchSize;
        } else {
          bs = getBatchSize(key);
          if (!bs) return;
        }
        const batches = Number(c.batches) || 0;
        const p = batches * bs;
        cf[key] = (cf[key] || 0) + p;
        if (!doughQueue[key]) doughQueue[key] = [];
        if (p >= 0) {
          doughQueue[key].push({ ts, pretzels: p });
        } else {
          let toRemove = -p;
          while (toRemove > 0 && doughQueue[key].length > 0) {
            const last = doughQueue[key][doughQueue[key].length - 1];
            const take = Math.min(last.pretzels, toRemove);
            last.pretzels -= take;
            toRemove -= take;
            if (last.pretzels <= 0) doughQueue[key].pop();
          }
        }
      });
    }
  });

  (allDeliveries || [])
    .filter((d) => {
      if (!['delivered', 'picked_up'].includes(d.status)) return false;
      if (!latestInventoryTs) return true;
      return d._confirmedAt && d._confirmedAt > latestInventoryTs;
    })
    .forEach((delivery) => {
      let items = [];
      try { items = JSON.parse(delivery.lineItems || '[]'); } catch {}
      const cust = delivery.customer || delivery.location || '?';
      // Shape-only deliveries (catering boxes, FOH Placeholder) leave the
      // pipeline at the dough stage — FOH bakes them fresh from
      // coldFerment at fulfillment. Lifecycle-less SKUs (cheese, dips)
      // live in onHand regardless. Each delivered line item cascades
      // through buckets in priority order, deducting exactly `qty` units
      // total across the three buckets.
      const isShapeOnly = !!delivery._shapeOnly;
      items.forEach(({ sku, quantity }) => {
        let key = sku?.trim();
        if (!key) return;
        if (skuAliases[key]) key = skuAliases[key];
        const qty = Number(quantity) || 0;
        if (qty <= 0) return;

        // Cascade: onHand → (cf for shape-only) → frozen. Each step takes
        // only what it has, spills the remainder. Fixes the prior
        // double-deduction bug where shape-only deliveries with cheese
        // (cf populated by cheese_done + oh populated by stock snapshot)
        // had both buckets deduct the full qty.
        let remaining = qty;

        // 1) onHand — canonical for cheese, retail dips, bulk dip, etc.
        if (oh[key] != null && oh[key] > 0 && remaining > 0) {
          const take = Math.min(oh[key], remaining);
          oh[key] = Math.max(0, oh[key] - take);
          remaining -= take;
        }

        // 2) cf — only for shape-only pretzel deliveries (catering boxes,
        //    FOH Placeholder). FIFO consume the dough queue alongside so
        //    age tracking stays accurate.
        if (remaining > 0 && isShapeOnly && cf[key] != null && cf[key] > 0) {
          const take = Math.min(cf[key], remaining);
          cf[key] = Math.max(0, cf[key] - take);
          if (doughQueue[key]) {
            let toConsume = take;
            while (toConsume > 0 && doughQueue[key].length > 0) {
              const oldest = doughQueue[key][0];
              const t = Math.min(oldest.pretzels, toConsume);
              oldest.pretzels -= t;
              toConsume -= t;
              if (oldest.pretzels <= 0) doughQueue[key].shift();
            }
          }
          remaining -= take;
        }

        // 3) frozen — standard pretzel ship-out path. Also covers legacy
        //    pre-Phase-3a cheese snapshots stored in fr, and FOH-only
        //    catering-portion SKUs (3oz dangerous dip, 3oz sweet cream
        //    dip) where the manager enters stock via the right-column
        //    input that writes to fr for non-lifecycle-less rows.
        if (remaining > 0 && fr[key] != null && fr[key] > 0) {
          const take = Math.min(fr[key], remaining);
          fr[key] = Math.max(0, fr[key] - take);
          remaining -= take;
        }

        if (!flowDelivered[key]) flowDelivered[key] = [];
        flowDelivered[key].push({ customer: cust, qty, confirmedAt: delivery._confirmedAt || '' });
      });
    });

  Object.keys(cf).forEach((k) => { cf[k] = Math.max(0, Math.round(cf[k])); });
  Object.keys(fr).forEach((k) => { fr[k] = Math.max(0, Math.round(fr[k])); });
  Object.keys(oh).forEach((k) => { oh[k] = Math.max(0, Math.round(oh[k])); });

  // Aging dough alerts. Per-SKU thresholds: dips configured in DIP_CONFIG
  // use their `shelfLifeDays` (warn one day before, fail at). Pretzels and
  // anything else fall back to the global DOUGH_AGE_WARN_DAYS / FAIL_DAYS.
  const now = Date.now();
  const agingDough = [];
  Object.entries(doughQueue).forEach(([sku, queue]) => {
    const dipCfg = DIP_CONFIG[sku];
    const failAt = dipCfg ? dipCfg.shelfLifeDays : DOUGH_AGE_FAIL_DAYS;
    const warnAt = dipCfg ? Math.max(1, dipCfg.shelfLifeDays - 1) : DOUGH_AGE_WARN_DAYS;
    queue.forEach((entry) => {
      if (entry.pretzels <= 0) return;
      const ageMs = now - new Date(entry.ts).getTime();
      const ageDays = ageMs / 86400000;
      if (ageDays >= warnAt) {
        agingDough.push({
          sku,
          ageDays: Math.floor(ageDays),
          pretzels: Math.round(entry.pretzels),
          critical: ageDays >= failAt,
          shelfLifeDays: failAt,
        });
      }
    });
  });
  agingDough.sort((a, b) => b.ageDays - a.ageDays);

  return {
    effective: { coldFerment: cf, frozen: fr, onHand: oh },
    doughQueue,
    flowsSinceSnapshot: { shape: flowShape, bfp: flowBfp, delivered: flowDelivered },
    alerts: { agingDough, bfpOverbake: bfpOverbakeEvents },
    snapshot: { date: latestInvDate, timestamp: latestInventoryTs, raw: snapshotRaw },
  };
}

// ─── DELIVERY COVERAGE ATTRIBUTION ────────────────────────────────────────

const STATUS_RANK = {
  ready: 0, baking: 1, partial: 2, unstarted: 3,
};
const WORST_STATUS = (a, b) => (STATUS_RANK[a] >= STATUS_RANK[b] ? a : b);

function statusFor(qty, frozenP, doughP, shapeOnly = false) {
  if (qty <= 0) return 'ready';
  if (shapeOnly) {
    // FOH bakes from dough at fulfillment time, so dough alone counts as ready.
    // 'baking' isn't a meaningful state here — there's no BFP step to wait on.
    if (frozenP + doughP >= qty) return 'ready';
    if (frozenP + doughP > 0) return 'partial';
    return 'unstarted';
  }
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
export function attributeDeliveryCoverage({
  activeDeliveries, inventoryReport, skuAliases, getBatchSize,
}) {
  // Build per-SKU FIFO queue of {deliveryId, qty}, sorted by date then timestamp.
  const sortedDeliveries = [...activeDeliveries].sort((a, b) => {
    const d = (a.date || '').localeCompare(b.date || '');
    return d !== 0 ? d : (a.timeStamp || '').localeCompare(b.timeStamp || '');
  });

  // Track per-SKU remaining inventory as we walk deliveries
  const frozenLeft = { ...inventoryReport.effective.frozen };
  const doughLeft = { ...inventoryReport.effective.coldFerment };

  const coverage = new Map();

  sortedDeliveries.forEach((delivery) => {
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
      const dAvail = doughLeft[key] || 0;

      const frozenP = Math.min(fAvail, qty);
      frozenLeft[key] = fAvail - frozenP;

      const remainingAfterFrozen = qty - frozenP;
      const doughP = Math.min(dAvail, remainingAfterFrozen);
      doughLeft[key] = dAvail - doughP;

      const needShapeP = Math.max(0, qty - frozenP - doughP);
      // Shape-only deliveries skip BFP: the FOH bakes them fresh, so once
      // dough exists they're satisfied. needBfpP collapses to 0.
      const needBfpP = delivery._shapeOnly ? 0 : Math.max(0, qty - frozenP);
      const lineStatus = statusFor(qty, frozenP, doughP, delivery._shapeOnly);

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
      date: delivery.date || '',
      customer: delivery.customer || delivery.location || '',
      shapeOnly: !!delivery._shapeOnly,
      lines,
      aggregateStatus: hasProductionSku ? aggregate : null,
    });
  });

  return coverage;
}

// ─── CHEESE-DIP PRODUCTION SCHEDULING ─────────────────────────────────────

const CHEESE_SKU_KEY = '3oz cheese dip';

// ISO-date helpers — keep cheese math purely string-based to avoid TZ pitfalls.
function parseISODate(s) {
  const [y, m, d] = (s || '').split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}
function addDaysISO(s, n) {
  const dt = parseISODate(s);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/**
 * Schedule batches for any FOH dip (cheese, hot ranch, sweet cream, etc).
 *
 * Phantom-delivery model: combines per-day delivery demand (line items
 * matching this dip's SKU) with a constant FOH walk-in rate, walks
 * forward day-by-day, and when inventory would dip negative, schedules
 * one batch on the LATEST valid day inside the [day − maxLead, day − minLead]
 * window. Honors the dailyCap cap. Single batch by default; upgrades to
 * double when same-day deficit exceeds singleBatchSize.
 *
 * Used by:
 *   - production app (Dips tab) — manager sees per-day "make a batch" cards.
 *   - worker (/foh-cal.ics) — emits an iCalendar VEVENT per scheduled batch.
 * Both call this exact function so the calendar and the manager view never
 * disagree.
 *
 * @param {Object} args
 * @param {string} args.dipSku              Key into DIP_CONFIG (e.g. '3oz cheese dip').
 * @param {Array}  args.deliveries          Resolved deliveries (active + confirmed).
 * @param {Object} args.inventoryReport     From getInventoryReport.
 * @param {number} args.fohDailyAvg         Average FOH walk-in units/day for this dip (Square).
 * @param {string} args.today               'YYYY-MM-DD' (Mountain TZ).
 * @param {Object} args.skuAliases          From resolveProductionLogs.
 * @param {number} [args.lookaheadDays=14]  How far forward to plan.
 * @returns {{
 *   dipSku: string,
 *   batches: Array<{date, dayIndex, covers, foh, overdue, fillsDay, size: 'single'|'double', units: number}>,
 *   demandByDate: Array<{date, delivery, foh, total, covers}>,
 *   startInventory: number,
 *   fohDailyAvg: number,
 * }}
 */
export function scheduleDip({
  dipSku, deliveries, inventoryReport, fohDailyAvg, today, skuAliases, lookaheadDays = 14,
}) {
  const cfg = DIP_CONFIG[dipSku];
  // FOH-only dips (e.g. portion-served dangerous/sweet cream dips) aren't
  // production-scheduled — return an empty result instead of throwing so
  // accidental callers (typo, future feature, manual invocation) don't kill
  // production-app rendering. Configured dips still flow through normally.
  if (!cfg) {
    // eslint-disable-next-line no-console
    console.warn(`scheduleDip: dipSku "${dipSku}" not in DIP_CONFIG — returning empty schedule (FOH or unconfigured?)`);
    return {
      dipSku,
      batches: [],
      demandByDate: [],
      startInventory: 0,
      fohDailyAvg: Math.max(0, Number(fohDailyAvg) || 0),
    };
  }
  const dailyAvg = Math.max(0, Number(fohDailyAvg) || 0);
  // Look further than the user-visible horizon so the algorithm "sees" deliveries
  // whose window straddles the edge (e.g. a delivery on day 16 has a window
  // ending on day 14, which we still need to plan for).
  const dayCount = lookaheadDays + cfg.maxLead + 1;

  const demand = Array.from({ length: dayCount }, (_, i) => ({
    date: addDaysISO(today, i),
    delivery: 0,
    foh: dailyAvg,
    total: dailyAvg,
    covers: [],
  }));

  (deliveries || []).forEach((d) => {
    if (['delivered', 'picked_up', 'cancelled'].includes(d.status)) return;
    if (!d.date || d.date < today) return;
    let lineItems = [];
    try { lineItems = JSON.parse(d.lineItems || '[]'); } catch {}
    let qtyForDip = 0;
    lineItems.forEach(({ sku, quantity }) => {
      let key = (sku || '').trim();
      if (skuAliases && skuAliases[key]) key = skuAliases[key];
      if (key !== dipSku) return;
      qtyForDip += Number(quantity) || 0;
    });
    if (qtyForDip <= 0) return;
    const dayIdx = (() => {
      const ms = parseISODate(d.date) - parseISODate(today);
      return Math.round(ms / 86400000);
    })();
    if (dayIdx < 0 || dayIdx >= dayCount) return;
    demand[dayIdx].delivery += qtyForDip;
    demand[dayIdx].total += qtyForDip;
    demand[dayIdx].covers.push({
      customer: d.customer || d.location || '?',
      qty: qtyForDip,
      deliveryDate: d.date,
    });
  });

  // Starting inventory = sum across all three buckets. Pre-Phase-3a snapshots
  // wrote to `fr`; Phase-3a+ writes to `oh`; cheese_done credits `cf`.
  const cfStart = inventoryReport?.effective?.coldFerment?.[dipSku] || 0;
  const frStart = inventoryReport?.effective?.frozen?.[dipSku] || 0;
  const ohStart = inventoryReport?.effective?.onHand?.[dipSku] || 0;
  const startInventory = cfStart + frStart + ohStart;

  const batches = [];
  const hasBatchOn = (dayIdx) => batches.some((b) => b.dayIndex === dayIdx);
  // Pick batch size at placement time. If the immediate deficit (-inv at the
  // time we decide to place) exceeds a single, upgrade to double.
  const pickSize = (deficit) => {
    if (cfg.doubleBatchSize === cfg.singleBatchSize) return { size: 'single', units: cfg.singleBatchSize };
    if (deficit > cfg.singleBatchSize) return { size: 'double', units: cfg.doubleBatchSize };
    return { size: 'single', units: cfg.singleBatchSize };
  };

  let inv = startInventory;
  for (let i = 0; i < dayCount; i++) {
    inv -= demand[i].total;
    while (inv < 0) {
      let placed = false;
      const earliest = Math.max(0, i - cfg.maxLead);
      const latest = i - cfg.minLead;
      const { size, units } = pickSize(-inv);
      for (let j = latest; j >= earliest; j--) {
        if (j < 0) break;
        if (hasBatchOn(j)) continue;
        batches.push({
          date: demand[j].date,
          dayIndex: j,
          covers: [...demand[i].covers],
          foh: demand[i].foh,
          overdue: false,
          fillsDay: i,
          size,
          units,
        });
        inv += units;
        placed = true;
        break;
      }
      if (!placed) {
        for (let j = 0; j < i; j++) {
          if (!hasBatchOn(j)) {
            batches.push({
              date: demand[j].date,
              dayIndex: j,
              covers: [...demand[i].covers],
              foh: demand[i].foh,
              overdue: true,
              fillsDay: i,
              size,
              units,
            });
            inv += units;
            placed = true;
            break;
          }
        }
        if (!placed) break; // bail to avoid infinite loop
      }
    }
  }

  return {
    dipSku,
    batches: batches.sort((a, b) => a.dayIndex - b.dayIndex),
    demandByDate: demand.slice(0, lookaheadDays + 1),
    startInventory,
    fohDailyAvg: dailyAvg,
  };
}

// Backward-compat shim — existing callers still work, get the same output
// with size:'single' on every batch (cheese has only one size).
export function scheduleCheese(args) {
  return scheduleDip({ dipSku: CHEESE_SKU_KEY, ...args });
}

export const CHEESE_KEY = CHEESE_SKU_KEY; // exported for callers that need the canonical SKU name

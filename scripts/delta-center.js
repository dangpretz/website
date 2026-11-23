// Delta Center list. Counts and pars live only in
// /dangpretz/delta-center-inventory. Nothing here reads the shop inventory.
// Pars are whatever set_par rows say — never a made-up number.

export const BUILT_IN = [
  {
    id: 'sku:7oz plain', name: '7oz plain', es: '7oz plain', group: 'pretzels', unit: 'ea',
  },
  {
    id: 'sku:7oz bbk', name: '7oz bbk', es: '7oz bbk', group: 'pretzels', unit: 'ea',
  },
  {
    id: 'sku:7oz spicy bee', name: '7oz spicy bee', es: '7oz spicy bee', group: 'pretzels', unit: 'ea',
  },
  {
    id: 'sku:7oz pepperoni', name: '7oz devil\'s delight', es: '7oz devil\'s delight', group: 'pretzels', unit: 'ea',
  },
  {
    id: 'sku:21oz mammoth pretzel', name: 'mammoth pretzels', es: 'pretzels mammoth', group: 'pretzels', unit: 'ea',
  },
  {
    id: 'sku:7oz hot dog plain', name: '7oz plain buns', es: '7oz pan plain', group: 'buns', unit: 'ea',
  },
  {
    id: 'sku:7oz hot dog bbk', name: '7oz bbk buns', es: '7oz pan bbk', group: 'buns', unit: 'ea',
  },
  {
    id: 'sku:7oz hot dog spicy bee', name: '7oz spicy buns', es: '7oz pan spicy bee', group: 'buns', unit: 'ea',
  },
  {
    id: 'sku:3oz cheese dip', name: '3oz cheese dip', es: '3oz salsa de queso', group: 'dips', unit: 'ea',
  },
  {
    id: 'sku:house mustard dip', name: '3oz mustard dip', es: '3oz salsa de mostaza', group: 'dips', unit: 'ea',
  },
  {
    id: 'sku:sweet cream dip', name: '3oz sweet cream', es: '3oz crema dulce', group: 'dips', unit: 'ea',
  },
  {
    id: 'supply:saint-glaze', name: 'saint glaze', es: 'glaseado saint', group: 'toppings', unit: '',
  },
  {
    id: 'supply:cinnamon-sugar', name: 'cinnamon sugar', es: 'azúcar con canela', group: 'toppings', unit: '',
  },
];

const BUILT_IN_IDS = new Set(BUILT_IN.map((b) => b.id));
const GROUPS = ['pretzels', 'buns', 'dips', 'toppings', 'supplies'];

export function resolveDeltaItems(rows) {
  const sorted = [...(Array.isArray(rows) ? rows : [])]
    .sort((a, b) => (a.timeStamp || '').localeCompare(b.timeStamp || ''));
  const byId = {};
  BUILT_IN.forEach((b, i) => {
    byId[b.id] = {
      id: b.id,
      name: b.name,
      es: b.es,
      unit: b.unit,
      kind: 'builtin',
      group: b.group,
      builtIn: true,
      order: i,
      par: 0,
      stock: null,
      count: null,
      lastResupply: null,
    };
  });
  sorted.forEach((r) => {
    const id = r.itemId;
    if (!id) return;
    if (r.action === 'track_item') {
      if (BUILT_IN_IDS.has(id)) return;
      byId[id] = {
        id,
        name: r.name || id,
        unit: r.unit || '',
        kind: r.kind || 'supply',
        group: r.group || 'supplies',
        par: byId[id]?.par ?? 0,
        stock: byId[id]?.stock ?? null,
        count: byId[id]?.count || null,
        lastResupply: byId[id]?.lastResupply || null,
      };
    } else if (r.action === 'untrack_item') {
      if (!BUILT_IN_IDS.has(id)) delete byId[id];
    } else if (!byId[id]) {
      // removed, or the track row has not been seen yet
    } else if (r.action === 'set_par') {
      const v = Number(r.par);
      if (!Number.isNaN(v) && v >= 0) byId[id].par = v;
    } else if (r.action === 'count') {
      const v = Number(r.quantity);
      if (Number.isNaN(v) || v < 0) return;
      byId[id].stock = v;
      byId[id].count = { at: r.date || (r.timeStamp || '').slice(0, 10), by: r.countedBy || '' };
    } else if (r.action === 'resupply') {
      const v = Number(r.quantity);
      if (Number.isNaN(v) || v <= 0) return;
      byId[id].stock = (byId[id].stock || 0) + v;
      byId[id].lastResupply = { qty: v, at: r.date || (r.timeStamp || '').slice(0, 10) };
    }
  });
  return Object.values(byId).sort((a, b) => (GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group))
    || ((a.order ?? 999) - (b.order ?? 999)) || a.name.localeCompare(b.name));
}

function parseCount(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return { empty: true };
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return { invalid: true };
  return { value: Math.round(n) };
}

// One Guardar for every tile. Empty means "leave it". Explicit 0 is a count of 0.
export function collectDeltaCounts(entries) {
  const writes = [];
  const invalid = [];
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const parsed = parseCount(entry.value);
    if (parsed.empty) return;
    if (parsed.invalid) {
      invalid.push(entry.itemId);
      return;
    }
    const current = entry.current == null || entry.current === '' ? null : Number(entry.current);
    if (current != null && !Number.isNaN(current) && current === parsed.value) return;
    writes.push({
      action: 'count',
      itemId: entry.itemId,
      quantity: String(parsed.value),
    });
  });
  return { writes, invalid };
}

// Empty par fields are not written — a manager has to type the number.
export function collectDeltaPars(entries) {
  const writes = [];
  const invalid = [];
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const parsed = parseCount(entry.value);
    if (parsed.empty) return;
    if (parsed.invalid) {
      invalid.push(entry.itemId);
      return;
    }
    const current = Number(entry.current);
    if (Number.isFinite(current) && current === parsed.value) return;
    writes.push({
      action: 'set_par',
      itemId: entry.itemId,
      par: String(parsed.value),
    });
  });
  return { writes, invalid };
}

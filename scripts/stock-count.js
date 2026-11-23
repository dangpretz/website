// Pretzel Inventory (production ?role=stock) snapshot builder.
// A blank field keeps the prior count. An explicit 0 is a real zero.
// Invalid numbers are reported and that SKU is left out so a typo
// cannot wipe the row.

function knownNumber(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}

function bucketKey(section) {
  if (section === 'shape') return 'coldFerment';
  if (section === 'frozen') return 'frozen';
  if (section === 'onhand') return 'onHand';
  return null;
}

export function collectStockSnapshot(entries) {
  const bySku = {};
  const keptBlank = [];
  const invalid = [];

  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const sku = String((entry && entry.sku) || '').trim();
    const key = bucketKey(entry && entry.section);
    if (!sku || !key) return;
    if (!bySku[sku]) bySku[sku] = { sku, fields: {}, bad: false };
    const raw = String(entry.value ?? '').trim();
    if (raw === '') {
      const prior = knownNumber(entry.prior);
      const initial = knownNumber(entry.initial);
      const kept = prior != null ? prior : initial;
      if (kept == null) {
        bySku[sku].bad = true;
        keptBlank.push({ sku, section: entry.section, kept: false });
      } else {
        bySku[sku].fields[key] = kept;
        keptBlank.push({ sku, section: entry.section, kept: true });
      }
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      bySku[sku].bad = true;
      invalid.push({ sku, section: entry.section, value: raw });
      return;
    }
    bySku[sku].fields[key] = Math.trunc(n);
  });

  const snapshots = [];
  const skipped = [];
  Object.keys(bySku).forEach((sku) => {
    const row = bySku[sku];
    if (row.bad) {
      skipped.push(sku);
      return;
    }
    snapshots.push({
      sku,
      coldFerment: row.fields.coldFerment || 0,
      frozen: row.fields.frozen || 0,
      onHand: row.fields.onHand || 0,
    });
  });

  return {
    snapshots, keptBlank, invalid, skipped,
  };
}

// What the stock input should show. A SKU that has been counted shows that
// effective number, including 0. A SKU with no snapshot and nothing on hand
// stays blank so Guardar does not invent a zero.
export function stockFieldValue(effectiveValue, inSnapshot) {
  const n = Number(effectiveValue);
  if (Number.isFinite(n) && n !== 0) return String(n);
  if (inSnapshot) return '0';
  return '';
}

// Last-good copy of a dpc-log GET, so a tablet can paint today's list
// before the next full-history download finishes. Signature images are
// dropped: the schedule never reads them, and they are most of the
// delivery log. The fresh response still has them in memory.

const PREFIX = 'dpc-log-cache:v1:';

export function compactLogRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    if (!row || typeof row !== 'object' || row.signatureData == null || row.signatureData === '') {
      return row;
    }
    const next = { ...row };
    delete next.signatureData;
    return next;
  });
}

function storageOf(storage) {
  if (storage) return storage;
  try {
    return localStorage;
  } catch (err) {
    return null;
  }
}

function bytesToBase64(bytes) {
  const chunk = 0x8000;
  const parts = [];
  for (let i = 0; i < bytes.length; i += chunk) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
  }
  return btoa(parts.join(''));
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function gzipString(text) {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return bytesToBase64(new Uint8Array(buf));
}

async function gunzipString(b64) {
  if (typeof DecompressionStream === 'undefined') return null;
  const stream = new Blob([base64ToBytes(b64)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export async function readCachedLog(logpath, storage) {
  const store = storageOf(storage);
  if (!store) return null;
  let raw;
  try { raw = store.getItem(PREFIX + logpath); } catch (err) { return null; }
  if (!raw) return null;
  try {
    const json = raw.startsWith('gz1:') ? await gunzipString(raw.slice(4)) : raw;
    if (!json) return null;
    const parsed = JSON.parse(json);
    return parsed && Array.isArray(parsed.rows) ? parsed.rows : null;
  } catch (err) {
    return null;
  }
}

export async function writeCachedLog(logpath, rows, storage) {
  const store = storageOf(storage);
  if (!store) return false;
  const payload = JSON.stringify({
    savedAt: new Date().toISOString(),
    rows: compactLogRows(rows),
  });
  let stored = payload;
  try {
    const gz = await gzipString(payload);
    if (gz) stored = `gz1:${gz}`;
  } catch (err) {
    stored = payload;
  }
  try {
    store.setItem(PREFIX + logpath, stored);
    return true;
  } catch (err) {
    try { store.removeItem(PREFIX + logpath); } catch (ignore) { /* quota */ }
    return false;
  }
}

// Fires onTimeout once if finish() is not called first. Does not abort the
// request — a slow download can still paint when it arrives.
export function startLoadWatch(timeoutMs, onTimeout) {
  let finished = false;
  const timer = setTimeout(() => {
    if (!finished && typeof onTimeout === 'function') onTimeout();
  }, timeoutMs);
  return {
    finish() {
      finished = true;
      clearTimeout(timer);
    },
  };
}

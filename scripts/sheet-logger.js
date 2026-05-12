const SHEET_LOGGER = 'https://sheet-logger.david8603.workers.dev';

// Cache-bust every GET — sheet-logger doesn't set Cache-Control today, but
// browsers + Cloudflare apply heuristic caching for responses without
// explicit TTL, which would surface as "I just saved, why don't I see my
// row?" Adding a unique query param sidesteps every cache layer.
export async function fetchLog(logpath) {
  const bust = `_t=${Date.now()}`;
  const sep = logpath.includes('?') ? '&' : '?';
  const response = await fetch(`${SHEET_LOGGER}${logpath}${sep}${bust}`);
  if (!response.ok) {
    throw new Error(`fetchLog ${logpath} failed: HTTP ${response.status}`);
  }
  return response.json();
}

// Throws on non-2xx so callers' try/catch can react. The prior silent-
// success-only behavior meant network blips were invisible — saveStock
// would log "Saved!" toast even when the row never landed in the sheet.
export async function appendLog(logpath, message) {
  const params = new URLSearchParams();
  Object.keys(message).forEach((key) => {
    params.append(key, message[key]);
  });

  let resp;
  try {
    resp = await fetch(`${SHEET_LOGGER}${logpath}?${params.toString()}`, {
      method: 'POST',
    });
  } catch (networkErr) {
    throw new Error(`appendLog ${logpath} network error: ${networkErr.message}`);
  }

  if (!resp.ok) {
    let detail = '';
    // Best-effort body read; if it's unreadable, fall through with no detail.
    try { detail = (await resp.text()).slice(0, 200); } catch (_) {} // eslint-disable-line no-empty
    throw new Error(`appendLog ${logpath} HTTP ${resp.status}${detail ? ` — ${detail}` : ''}`);
  }

  // eslint-disable-next-line no-console
  console.log(`Logged to ${logpath}`, message);
}

export function transposeByKey(logData, key) {
  const status = {};
  logData.forEach((item) => {
    status[item[key]] = item;
  });
  return status;
}

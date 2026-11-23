// Previous host: https://sheet-logger.david8603.workers.dev
// Never put READ_TOKEN or WRITE_TOKEN in this public file. It is served
// to every visitor; browser callers authenticate by Origin and pass no token.
const SHEET_LOGGER = 'https://dpc-log.drew-f39.workers.dev';

function loggerHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Cache-bust every GET. dpc-log sends Cache-Control: no-store and ignores
// filter params (limit, since, fields), so each GET is the full log. The
// unique query param also avoids a stale heuristic cache after a save.
export async function fetchLog(logpath, { token, signal } = {}) {
  const bust = `_t=${Date.now()}`;
  const sep = logpath.includes('?') ? '&' : '?';
  const response = await fetch(`${SHEET_LOGGER}${logpath}${sep}${bust}`, {
    headers: loggerHeaders(token),
    signal,
  });
  if (!response.ok) {
    throw new Error(`fetchLog ${logpath} failed: HTTP ${response.status}`);
  }
  return response.json();
}

// Throws on non-2xx so callers' try/catch can react. The prior silent-
// success-only behavior meant network blips were invisible — saveStock
// would log "Saved!" toast even when the row never landed in the sheet.
export async function appendLog(logpath, message, { signal, token } = {}) {
  const params = new URLSearchParams();
  Object.keys(message).forEach((key) => {
    params.append(key, message[key]);
  });

  let resp;
  try {
    resp = await fetch(`${SHEET_LOGGER}${logpath}?${params.toString()}`, {
      method: 'POST',
      signal, // AbortSignal for per-attempt timeouts; undefined when not passed → no change
      headers: loggerHeaders(token),
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

const SHEET_LOGGER = 'https://sheet-logger.david8603.workers.dev';

export async function fetchLog(logpath) {
  const response = await fetch(`${SHEET_LOGGER}${logpath}`);
  return response.json();
}

export async function appendLog(logpath, message) {
  const params = new URLSearchParams();
  Object.keys(message).forEach((key) => {
    params.append(key, message[key]);
  });

  const resp = await fetch(`${SHEET_LOGGER}${logpath}?${params.toString()}`, {
    method: 'POST',
  });

  if (resp.status === 200) {
    // eslint-disable-next-line no-console
    console.log(`Logged to ${logpath}`, message);
  }
}

export function transposeByKey(logData, key) {
  const status = {};
  logData.forEach((item) => {
    status[item[key]] = item;
  });
  return status;
}

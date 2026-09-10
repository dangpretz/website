// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ SALES CRM — SHARED READ MODEL                                            ║
// ╠══════════════════════════════════════════════════════════════════════════╣
// ║                                                                          ║
// ║ Pure reducers over the /dangpretz/sales-crm append-log, for pages other  ║
// ║ than the CRM itself that need to know "what accounts exist and who owns  ║
// ║ them" — today that's the commissions page (a customer's rep now comes    ║
// ║ from its CRM account, not a separate commissions-config row).            ║
// ║                                                                          ║
// ║ Only the account slice is modelled here. static/sales/index.html still   ║
// ║ has its own fuller applyLogs() for deals/tasks/comms/etc.; the account   ║
// ║ handling below is kept byte-for-byte in step with it so both agree on    ║
// ║ names and rep ownership.                                                 ║
// ║                                                                          ║
// ╚══════════════════════════════════════════════════════════════════════════╝

export const SALES_CRM_LOG_PATH = '/dangpretz/sales-crm';

// Replay the account rows of the sales-crm log into a Map(id -> account).
// Mirrors the create_account / update_account / delete_account /
// reassign_account cases of static/sales/index.html applyLogs().
export function resolveAccounts(logs) {
  const accounts = new Map();
  (Array.isArray(logs) ? logs : []).forEach((row) => {
    if (!row || !row.id) return;
    if (row.action === 'create_account') {
      accounts.set(row.id, { ...row, repId: row.repId || 'admin' });
    } else if (row.action === 'update_account') {
      const existing = accounts.get(row.id) || {};
      accounts.set(row.id, { ...existing, ...row, repId: existing.repId || row.repId || 'admin' });
    } else if (row.action === 'delete_account') {
      accounts.delete(row.id);
    } else if (row.action === 'reassign_account') {
      const existing = accounts.get(row.id);
      if (existing) existing.repId = row.repId;
    }
  });
  return accounts;
}

// { normalizedName -> repId } for every account owned by a real PIN-code rep.
// `normalize` is injected (delivery-planner's normalizeCustomerName) so the
// keys line up with how commissions matches a delivery's customer name.
// Unassigned / manager-owned ('admin') accounts are skipped — they carry no
// rep attribution. Later account wins on a name collision.
export function repByCustomerFromAccounts(accounts, normalize = (x) => x) {
  const out = {};
  let list = [];
  if (accounts instanceof Map) list = [...accounts.values()];
  else if (Array.isArray(accounts)) list = accounts;
  list.forEach((a) => {
    const name = normalize(a.name || '');
    if (!name) return;
    if (!a.repId || a.repId === 'admin') return;
    out[name] = a.repId;
  });
  return out;
}

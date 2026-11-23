/**
 * Customers whose bake, freeze, and package work is done first each morning.
 *
 * Match is case-insensitive and ignores the location suffix, so
 * "Twisted Sugar", "Twisted Sugar Saratoga Springs", and "Twisted Sugar AZ"
 * all hit the same rule. Add another entry to PRIORITY_CUSTOMERS to prioritize
 * a new customer — every queue reads this list at compute/render time.
 */

export const PRIORITY_CUSTOMERS = [
  {
    id: 'twisted-sugar',
    label: 'Twisted Sugar',
    matches(name) {
      return /twisted\s+sugar/i.test(String(name || ''));
    },
    badge: {
      en: 'Priority: Twisted Sugar - deliver first',
      es: 'Prioridad: Twisted Sugar - entregar primero',
    },
  },
];

/** The priority rule for this customer name, or null. */
export function priorityCustomerFor(name) {
  return PRIORITY_CUSTOMERS.find((rule) => rule.matches(name)) || null;
}

/** True when the customer name is on the morning-priority list. */
export function isPriorityCustomer(name) {
  return priorityCustomerFor(name) != null;
}

/**
 * Badge copy for a customer name. `lang` selects the BOH language;
 * unknown languages fall back to English.
 */
export function priorityCustomerBadge(name, lang = 'en') {
  const rule = priorityCustomerFor(name);
  if (!rule) return '';
  return rule.badge[lang] || rule.badge.en || '';
}

/**
 * True when a queue row is for a priority customer.
 * Accepts a customer string, or an item with `customer` and/or `orders`.
 */
export function itemHasPriorityCustomer(item) {
  if (typeof item === 'string') return isPriorityCustomer(item);
  if (!item || typeof item !== 'object') return false;
  if (isPriorityCustomer(item.customer)) return true;
  return Array.isArray(item.orders) && item.orders.some((name) => isPriorityCustomer(name));
}

/** Badge copy for a customer string or a queue item. Empty when it is not priority. */
export function priorityBadgeText(item, lang = 'en') {
  if (typeof item === 'string') return priorityCustomerBadge(item, lang);
  if (!item || typeof item !== 'object') return '';
  if (isPriorityCustomer(item.customer)) return priorityCustomerBadge(item.customer, lang);
  const fromOrders = (item.orders || []).find((name) => isPriorityCustomer(name));
  return fromOrders ? priorityCustomerBadge(fromOrders, lang) : '';
}

/**
 * Stable partition: priority rows first, then everyone else.
 * Relative order inside each group is unchanged.
 */
export function sortPriorityCustomersFirst(items, isPriority = itemHasPriorityCustomer) {
  const priority = [];
  const rest = [];
  (Array.isArray(items) ? items : []).forEach((item) => {
    if (isPriority(item)) priority.push(item);
    else rest.push(item);
  });
  return priority.concat(rest);
}

/**
 * Display order for one day's bake/freeze queue.
 * Not-done priority orders go first, then the other not-done orders, then
 * finished cards. Each group keeps the order it already had.
 */
export function orderBfpWorkQueue(items) {
  const priority = [];
  const rest = [];
  const done = [];
  (Array.isArray(items) ? items : []).forEach((item) => {
    if (item && item.bucket === 'done') done.push(item);
    else if (itemHasPriorityCustomer(item)) priority.push(item);
    else rest.push(item);
  });
  return priority.concat(rest, done);
}

/**
 * Allocation order for one day's BFP capacity (the morning slots).
 *
 * Deadline work (window closes today, or already flagged morning-priority)
 * still lands before optional work, so a closed window is not dropped to
 * make room. Inside that band, and again inside the optional band, priority
 * customers take the earliest slots. Relative order inside each band is kept.
 */
export function orderBfpAllocation(items) {
  const mustPriority = [];
  const mustRest = [];
  const laterPriority = [];
  const laterRest = [];
  (Array.isArray(items) ? items : []).forEach((item) => {
    const must = !!item && (item.daysLeft === 0 || item.morningPriority);
    const priority = itemHasPriorityCustomer(item);
    if (must && priority) mustPriority.push(item);
    else if (must) mustRest.push(item);
    else if (priority) laterPriority.push(item);
    else laterRest.push(item);
  });
  return mustPriority.concat(mustRest, laterPriority, laterRest);
}

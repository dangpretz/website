/* eslint-env node */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CHEESE_KEY, dipDeferTo, resolveProductionLogs, scheduleDip,
} from './inventory.js';
import { appendLog } from './sheet-logger.js';

const emptyReport = { effective: { coldFerment: {}, frozen: {}, onHand: {} } };

function order(id, date, customer, qty, status = 'scheduled', sku = '3oz cheese dip') {
  return {
    deliveryId: id,
    date,
    customer,
    status,
    lineItems: JSON.stringify([{ sku, quantity: qty }]),
  };
}

// Mon 11/23 cheese the Dips tab was scheduling: TF today, Willies + Alta
// (bulk dangerous dip × 12 = 300) for Tuesday, TF + Delta for Wednesday,
// Fisher for Thursday. Cheese is made 2 days before delivery.
function weekOrders({ tf23 = 'scheduled', delta = 'scheduled' } = {}) {
  return [
    order('tf23', '2026-11-23', 'TF', 50, tf23),
    order('willies', '2026-11-24', 'Willies Lounge', 32),
    order('alta', '2026-11-24', "Alta - Gold Miner's Daughter", 12, 'scheduled', 'bulk dangerous dip (25 srv)'),
    order('tf25', '2026-11-25', 'TF', 50),
    order('delta', '2026-11-25', 'Delta Center', 108, delta),
    order('fisher', '2026-11-26', 'Fisher', 80),
    order('honey', '2026-11-25', 'Cafe', 20, 'scheduled', 'honey mustard dip'),
  ];
}

function byDate(deliveries, deferrals, foh = 0, today = '2026-11-23') {
  const sched = scheduleDip({
    dipSku: CHEESE_KEY,
    deliveries,
    inventoryReport: emptyReport,
    fohDailyAvg: foh,
    today,
    skuAliases: {},
    deferrals,
    lookaheadDays: 14,
  });
  const map = new Map();
  sched.batches.forEach((b) => {
    const g = map.get(b.date) || { count: 0, units: 0, covers: [] };
    g.count += 1;
    g.units += b.units;
    (b.covers || []).forEach((c) => {
      const k = `${c.customer}|${c.qty}|${c.deliveryDate}`;
      if (!g.covers.includes(k)) g.covers.push(k);
    });
    map.set(b.date, g);
  });
  return map;
}

const wedDefer = {
  'dips|3oz cheese dip|2026-11-25|tf25': '2026-11-24',
  'dips|3oz cheese dip|2026-11-25|delta': '2026-11-24',
};

describe('cheese make-tomorrow', () => {
  it('keeps the unmoved Monday schedule, including bulk cheese', () => {
    const days = byDate(weekOrders(), null, 8.8);
    const mon = days.get('2026-11-23');
    const tue = days.get('2026-11-24');
    assert.equal(mon.count, 4);
    assert.equal(mon.units, 600);
    assert.deepEqual(mon.covers, [
      'TF|50|2026-11-23',
      'Willies Lounge|32|2026-11-24',
      'Alta - Gold Miner\'s Daughter|300|2026-11-24',
      'TF|50|2026-11-25',
      'Delta Center|108|2026-11-25',
    ]);
    assert.equal(tue.count, 1);
    assert.equal(tue.units, 150);
    assert.deepEqual(tue.covers, ['Fisher|80|2026-11-26']);
    assert.equal(mon.covers.some((c) => c.includes('honey')), false);
  });

  it('moves Wednesday cheese onto Tuesday and recomputes 150-serving batches', () => {
    const days = byDate(weekOrders(), wedDefer, 8.8);
    const mon = days.get('2026-11-23');
    const tue = days.get('2026-11-24');
    assert.equal(mon.count, 3);
    assert.equal(mon.units, 450);
    assert.deepEqual(mon.covers, [
      'TF|50|2026-11-23',
      'Willies Lounge|32|2026-11-24',
      'Alta - Gold Miner\'s Daughter|300|2026-11-24',
    ]);
    assert.equal(tue.count, 2);
    assert.equal(tue.units, 300);
    assert.deepEqual(tue.covers, [
      'TF|50|2026-11-25',
      'Delta Center|108|2026-11-25',
      'Fisher|80|2026-11-26',
    ]);
  });

  it('drops a confirmed delivery and still names Fisher on Tuesday', () => {
    const days = byDate(weekOrders({ tf23: 'delivered' }), wedDefer, 0);
    const mon = days.get('2026-11-23');
    const tue = days.get('2026-11-24');
    assert.equal(mon.count, 3);
    assert.equal(mon.units, 450);
    assert.deepEqual(mon.covers, [
      'Willies Lounge|32|2026-11-24',
      'Alta - Gold Miner\'s Daughter|300|2026-11-24',
    ]);
    assert.ok(tue.covers.includes('TF|50|2026-11-25'));
    assert.ok(tue.covers.includes('Delta Center|108|2026-11-25'));
    assert.ok(tue.covers.includes('Fisher|80|2026-11-26'));
    assert.equal(tue.units % 150, 0);
  });

  it('does not count a Wednesday order that is already delivered', () => {
    const days = byDate(weekOrders({ delta: 'delivered' }), wedDefer, 0);
    const tue = days.get('2026-11-24');
    const mon = days.get('2026-11-23');
    assert.equal(mon.covers.some((c) => c.startsWith('Delta')), false);
    assert.equal(tue.covers.some((c) => c.startsWith('Delta')), false);
    assert.ok(tue.covers.includes('TF|50|2026-11-25'));
    assert.ok(tue.covers.includes('Fisher|80|2026-11-26'));
  });

  it('ignores a shape defer on the same delivery date', () => {
    const days = byDate(weekOrders(), {
      'shape|3oz cheese dip|2026-11-25': '2026-11-24',
    }, 0);
    assert.equal(days.get('2026-11-23').count, 4);
    assert.equal(days.get('2026-11-24').covers.includes('Fisher|80|2026-11-26'), true);
    assert.equal(days.get('2026-11-24').covers.includes('Delta Center|108|2026-11-25'), false);
  });
});

describe('defer log', () => {
  it('keeps shape keys and stores a per-order dips tombstone', () => {
    const resolved = resolveProductionLogs([
      {
        action: 'defer',
        team: 'shape',
        sku: '7oz plain',
        deliveryDate: '2026-11-17',
        deferTo: '2026-11-14',
        timeStamp: '2026-11-16T00:00:00.000Z',
      },
      {
        action: 'defer',
        team: 'dips',
        sku: '3oz cheese dip',
        deliveryDate: '2026-11-25',
        deliveryId: 'delta',
        deferTo: '2026-11-24',
        timeStamp: '2026-11-23T00:00:00.000Z',
      },
      {
        action: 'defer',
        team: 'dips',
        sku: '3oz cheese dip',
        deliveryDate: '2026-11-25',
        deliveryId: 'delta',
        deferTo: '',
        timeStamp: '2026-11-23T01:00:00.000Z',
      },
    ]);
    assert.equal(resolved.deferrals['shape|7oz plain|2026-11-17'], '2026-11-14');
    assert.equal(resolved.deferrals['dips|3oz cheese dip|2026-11-25|delta'], '');
    assert.equal(dipDeferTo(resolved.deferrals, CHEESE_KEY, {
      date: '2026-11-25', deliveryId: 'delta',
    }), '');
    assert.equal(Object.hasOwn(resolved.deferrals, 'dips|3oz cheese dip|2026-11-25'), false);
  });

  it('posts the shape defer action through a mocked log and does not call the network', async () => {
    const calls = [];
    const original = global.fetch;
    global.fetch = async (url, opts) => {
      const href = String(url);
      calls.push({ href, method: opts && opts.method });
      if (href.startsWith('https://dpc-log.drew-f39.workers.dev')) {
        return { ok: true, text: async () => '' };
      }
      throw new Error(`unexpected fetch ${href}`);
    };
    try {
      await appendLog('/dangpretz/production', {
        action: 'defer',
        team: 'dips',
        sku: '3oz cheese dip',
        deliveryDate: '2026-11-25',
        deliveryId: 'delta',
        deferTo: '2026-11-24',
        by: 'dips',
        timeStamp: '2026-11-23T16:00:00.000Z',
      });
    } finally {
      global.fetch = original;
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    const u = new URL(calls[0].href);
    assert.equal(u.origin, 'https://dpc-log.drew-f39.workers.dev');
    assert.equal(u.pathname, '/dangpretz/production');
    assert.equal(u.searchParams.get('action'), 'defer');
    assert.equal(u.searchParams.get('team'), 'dips');
    assert.equal(u.searchParams.get('sku'), '3oz cheese dip');
    assert.equal(u.searchParams.get('deliveryDate'), '2026-11-25');
    assert.equal(u.searchParams.get('deliveryId'), 'delta');
    assert.equal(u.searchParams.get('deferTo'), '2026-11-24');
    assert.equal(u.searchParams.get('by'), 'dips');
  });
});

/* eslint-env node */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  PRIORITY_CUSTOMERS,
  isPriorityCustomer,
  itemHasPriorityCustomer,
  orderBfpAllocation,
  orderBfpWorkQueue,
  priorityBadgeText,
  priorityCustomerBadge,
  sortPriorityCustomersFirst,
} from './priority-customers.js';

describe('isPriorityCustomer', () => {
  it('matches Twisted Sugar at any location, in any casing', () => {
    [
      'Twisted Sugar',
      'twisted sugar',
      'TWISTED SUGAR',
      'Twisted Sugar Saratoga Springs',
      'Twisted Sugar AZ',
      'Twisted Sugar - Highland',
      '  twisted   sugar az  ',
    ].forEach((name) => {
      assert.equal(isPriorityCustomer(name), true, name);
    });
  });

  it('does not match other customers', () => {
    [
      '',
      '   ',
      'Sugar House',
      'Twisted Pretzel',
      'Twist',
      'Arena',
      'TS - placeholder',
      null,
      undefined,
    ].forEach((name) => {
      assert.equal(isPriorityCustomer(name), false, String(name));
    });
  });

  it('reads the match from PRIORITY_CUSTOMERS so another customer can be added', () => {
    assert.equal(PRIORITY_CUSTOMERS.some((rule) => rule.id === 'twisted-sugar'), true);
    PRIORITY_CUSTOMERS.push({
      id: 'example-rink',
      matches: (name) => String(name || '').trim().toLowerCase() === 'example rink',
      badge: { en: 'Priority: Example Rink - deliver first', es: 'Prioridad: Example Rink - entregar primero' },
    });
    try {
      assert.equal(isPriorityCustomer('Example Rink'), true);
      assert.equal(isPriorityCustomer('Arena'), false);
      assert.equal(priorityCustomerBadge('Example Rink', 'en'), 'Priority: Example Rink - deliver first');
    } finally {
      PRIORITY_CUSTOMERS.pop();
    }
    assert.equal(isPriorityCustomer('Example Rink'), false);
  });
});

describe('priority badge', () => {
  it('uses the Twisted Sugar deliver-first copy', () => {
    assert.equal(
      priorityCustomerBadge('Twisted Sugar Saratoga Springs', 'en'),
      'Priority: Twisted Sugar - deliver first',
    );
    assert.equal(
      priorityCustomerBadge('Twisted Sugar AZ', 'es'),
      'Prioridad: Twisted Sugar - entregar primero',
    );
    assert.equal(priorityCustomerBadge('Twisted Sugar', 'fr'), 'Priority: Twisted Sugar - deliver first');
    assert.equal(priorityCustomerBadge('Mall', 'en'), '');
  });

  it('finds the badge on a queue item customer or orders list', () => {
    assert.equal(
      priorityBadgeText({ customer: 'Twisted Sugar AZ' }, 'en'),
      'Priority: Twisted Sugar - deliver first',
    );
    assert.equal(
      priorityBadgeText({ orders: ['Arena', 'Twisted Sugar - Highland'] }, 'es'),
      'Prioridad: Twisted Sugar - entregar primero',
    );
    assert.equal(priorityBadgeText({ orders: ['Arena'] }, 'en'), '');
    assert.equal(itemHasPriorityCustomer({ orders: ['Twisted Sugar AZ'] }), true);
    assert.equal(itemHasPriorityCustomer({ customer: 'School' }), false);
  });
});

describe('stable priority sort', () => {
  it('keeps relative order inside the priority group and inside the rest', () => {
    const packs = [
      { customer: 'Arena', date: '2026-11-23' },
      { customer: 'Twisted Sugar AZ', date: '2026-11-24' },
      { customer: 'Mall', date: '2026-11-23' },
      { customer: 'twisted sugar saratoga springs', date: '2026-11-23' },
      { customer: 'Rink', date: '2026-11-24' },
    ];
    const sorted = [...packs].sort((a, b) => (
      a.date.localeCompare(b.date) || a.customer.localeCompare(b.customer)
    ));
    const ordered = sortPriorityCustomersFirst(sorted);
    assert.deepEqual(ordered.map((row) => row.customer), [
      'twisted sugar saratoga springs',
      'Twisted Sugar AZ',
      'Arena',
      'Mall',
      'Rink',
    ]);
  });

  it('puts not-done Twisted Sugar work at the top of the bake/freeze queue', () => {
    const items = [
      { id: 'morning-other', bucket: 'morning', orders: ['Arena'] },
      { id: 'pending-ts', bucket: 'pending', orders: ['Twisted Sugar AZ'] },
      { id: 'progress-other', bucket: 'progress', orders: ['Mall'] },
      { id: 'progress-ts', bucket: 'progress', customer: 'Twisted Sugar Saratoga Springs' },
      { id: 'done-ts', bucket: 'done', orders: ['Twisted Sugar'] },
      { id: 'pending-other', bucket: 'pending', orders: ['School'] },
      { id: 'done-other', bucket: 'done', orders: ['Rink'] },
    ];
    assert.deepEqual(orderBfpWorkQueue(items).map((row) => row.id), [
      'pending-ts',
      'progress-ts',
      'morning-other',
      'progress-other',
      'pending-other',
      'done-ts',
      'done-other',
    ]);
  });

  it('gives Twisted Sugar the earliest slots without dropping deadline work', () => {
    const ranked = [
      {
        id: 'morning-other', daysLeft: 0, morningPriority: true, orders: ['Arena'],
      },
      {
        id: 'morning-ts', daysLeft: 0, morningPriority: true, orders: ['Twisted Sugar AZ'],
      },
      { id: 'due-other', daysLeft: 0, orders: ['Mall'] },
      { id: 'soon-other', daysLeft: 1, orders: ['School'] },
      { id: 'soon-ts', daysLeft: 1, orders: ['Twisted Sugar Saratoga Springs'] },
      { id: 'later-ts', daysLeft: 3, customer: 'TWISTED SUGAR' },
      { id: 'later-other', daysLeft: 2, orders: ['Rink'] },
    ];
    assert.deepEqual(orderBfpAllocation(ranked).map((row) => row.id), [
      'morning-ts',
      'morning-other',
      'due-other',
      'soon-ts',
      'later-ts',
      'soon-other',
      'later-other',
    ]);
  });

  it('leaves a queue with no priority customers in its existing order', () => {
    const ranked = [
      { id: 'a', daysLeft: 0, orders: ['Arena'] },
      { id: 'b', daysLeft: 1, orders: ['Mall'] },
      { id: 'c', daysLeft: 2, orders: ['Rink'] },
    ];
    assert.deepEqual(orderBfpAllocation(ranked).map((row) => row.id), ['a', 'b', 'c']);
    assert.deepEqual(
      orderBfpWorkQueue(ranked.map((row) => ({ ...row, bucket: 'pending' }))).map((row) => row.id),
      ['a', 'b', 'c'],
    );
  });
});

describe('production planner wiring', () => {
  const html = readFileSync(new URL('../static/production/index.html', import.meta.url), 'utf8');

  it('applies the rule when the BFP queues are computed and rendered', () => {
    assert.match(html, /priority-customers\.js/);
    assert.match(html, /type === 'bfp' \? orderBfpAllocation\(annotated\) : annotated/);
    assert.match(html, /type === 'bfp' \? orderBfpWorkQueue\(ordered\) : ordered/);
    assert.match(html, /sortPriorityCustomersFirst\(packs\)/);
    assert.match(html, /sortPriorityCustomersFirst\(dayItems\)/);
    assert.match(html, /priorityBadgeText/);
    assert.match(html, /itemHasPriorityCustomer/);
  });
});

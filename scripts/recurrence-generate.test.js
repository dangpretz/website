import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGenerationLock, planRecurringOccurrence } from './inventory.js';

const GUILD = '657c01b6';
const DAY = '2026-12-14';

function line(overrides) {
  return {
    deliveryId: '609aa536',
    recurrenceId: GUILD,
    date: DAY,
    customer: "Thieve's Guild",
    ...overrides,
  };
}

describe('planRecurringOccurrence', () => {
  it('creates a line when nothing is stored for that date', () => {
    assert.equal(planRecurringOccurrence({
      recurrenceId: GUILD,
      date: DAY,
      existingLines: [],
      generated: {},
    }), 'create');
  });

  it('does not create a second line when the delivery exists and the marker does not', () => {
    // 2026-11-16: the 12/14 line landed and the marker write did not.
    assert.equal(planRecurringOccurrence({
      recurrenceId: GUILD,
      date: DAY,
      existingLines: [line()],
      generated: {},
    }), 'mark');
  });

  it('skips when the line and the marker are both already stored', () => {
    const key = `${GUILD}:${DAY}`;
    assert.equal(planRecurringOccurrence({
      recurrenceId: GUILD,
      date: DAY,
      existingLines: [line({ deliveryId: '17878427' })],
      generated: { [key]: true },
    }), 'skip');
  });

  it('does not treat a different date or recurrence as the same line', () => {
    assert.equal(planRecurringOccurrence({
      recurrenceId: GUILD,
      date: DAY,
      existingLines: [line({ date: '2026-12-07' })],
      generated: {},
    }), 'create');
    assert.equal(planRecurringOccurrence({
      recurrenceId: GUILD,
      date: DAY,
      existingLines: [line({ recurrenceId: 'other' })],
      generated: {},
    }), 'create');
  });

  it('ignores a deleted line', () => {
    const deleted = line({ deliveryId: 'gone' });
    deleted._deleted = true; // eslint-disable-line no-underscore-dangle
    assert.equal(planRecurringOccurrence({
      recurrenceId: GUILD,
      date: DAY,
      existingLines: [deleted],
      generated: {},
    }), 'create');
  });

  it('does not create when a marker is already stored and the line is not', () => {
    const key = `${GUILD}:${DAY}`;
    assert.equal(planRecurringOccurrence({
      recurrenceId: GUILD,
      date: DAY,
      existingLines: [],
      generated: { [key]: true },
    }), 'skip');
  });
});

describe('createGenerationLock', () => {
  it('runs a second generation after the first, never beside it', async () => {
    const lock = createGenerationLock();
    let active = 0;
    let maxActive = 0;
    const order = [];
    const task = (name) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start ${name}`);
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      order.push(`end ${name}`);
      active -= 1;
    };
    await Promise.all([lock.run(task('a')), lock.run(task('b'))]);
    assert.equal(maxActive, 1);
    assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b']);
  });
});

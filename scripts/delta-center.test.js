import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BUILT_IN, resolveDeltaItems, collectDeltaCounts, collectDeltaPars,
} from './delta-center.js';

describe('resolveDeltaItems', () => {
  it('lists the 13 built-ins with no par and no count when the log is empty', () => {
    const items = resolveDeltaItems([]);
    assert.equal(items.length, BUILT_IN.length);
    assert.equal(items.length, 13);
    items.forEach((item) => {
      assert.equal(item.par, 0);
      assert.equal(item.stock, null);
    });
  });

  it('loads a par from set_par and does not invent one for the other items', () => {
    const items = resolveDeltaItems([
      {
        action: 'set_par', itemId: 'sku:7oz plain', par: '48', timeStamp: '2026-11-23T15:00:00.000Z',
      },
    ]);
    const plain = items.find((item) => item.id === 'sku:7oz plain');
    const other = items.find((item) => item.id === 'sku:7oz bbk');
    assert.equal(plain.par, 48);
    assert.equal(other.par, 0);
  });
});

describe('collectDeltaCounts', () => {
  it('writes a count only for rows that changed, using the existing action shape', () => {
    const { writes, invalid } = collectDeltaCounts([
      { itemId: 'sku:7oz plain', value: '12', current: null },
      { itemId: 'sku:7oz bbk', value: '', current: null },
      { itemId: 'sku:7oz spicy bee', value: '4', current: 4 },
      { itemId: 'sku:3oz cheese dip', value: 'nope', current: null },
    ]);
    assert.deepEqual(invalid, ['sku:3oz cheese dip']);
    assert.deepEqual(writes, [{
      action: 'count', itemId: 'sku:7oz plain', quantity: '12',
    }]);
  });
});

describe('collectDeltaPars', () => {
  it('does not write a par when the manager leaves the field empty', () => {
    const { writes } = collectDeltaPars([
      { itemId: 'sku:7oz plain', value: '', current: 0 },
      { itemId: 'sku:7oz bbk', value: '24', current: 0 },
    ]);
    assert.deepEqual(writes, [{
      action: 'set_par', itemId: 'sku:7oz bbk', par: '24',
    }]);
  });
});

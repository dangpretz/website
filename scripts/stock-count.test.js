import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectStockSnapshot, stockFieldValue } from './stock-count.js';

describe('collectStockSnapshot', () => {
  it('keeps a blank field at the prior count and saves an explicit zero', () => {
    const { snapshots, keptBlank, invalid } = collectStockSnapshot([
      {
        sku: '7oz plain', section: 'shape', value: '', prior: '72', initial: '72',
      },
      {
        sku: '7oz plain', section: 'frozen', value: '0', prior: '32', initial: '32',
      },
      {
        sku: '10oz plain', section: 'shape', value: '10', prior: '4', initial: '4',
      },
      {
        sku: '10oz plain', section: 'frozen', value: '8', prior: '8', initial: '8',
      },
    ]);
    assert.equal(invalid.length, 0);
    assert.equal(keptBlank.length, 1);
    assert.equal(keptBlank[0].kept, true);
    const plain = snapshots.find((s) => s.sku === '7oz plain');
    assert.deepEqual(plain, {
      sku: '7oz plain', coldFerment: 72, frozen: 0, onHand: 0,
    });
    const ten = snapshots.find((s) => s.sku === '10oz plain');
    assert.equal(ten.coldFerment, 10);
    assert.equal(ten.frozen, 8);
  });

  it('skips a blank SKU that has no prior count instead of writing zero', () => {
    const { snapshots, skipped } = collectStockSnapshot([
      {
        sku: 'new sku', section: 'shape', value: '', prior: '', initial: '',
      },
      {
        sku: 'new sku', section: 'frozen', value: '5', prior: '', initial: '',
      },
    ]);
    assert.deepEqual(skipped, ['new sku']);
    assert.equal(snapshots.length, 0);
  });

  it('does not save a negative number', () => {
    const { snapshots, invalid } = collectStockSnapshot([
      {
        sku: '7oz bbk', section: 'frozen', value: '-3', prior: '10', initial: '10',
      },
    ]);
    assert.equal(invalid.length, 1);
    assert.equal(snapshots.length, 0);
  });
});

describe('stockFieldValue', () => {
  it('shows a counted zero and leaves a never-counted SKU blank', () => {
    assert.equal(stockFieldValue(0, true), '0');
    assert.equal(stockFieldValue(72, true), '72');
    assert.equal(stockFieldValue(0, false), '');
    assert.equal(stockFieldValue(undefined, false), '');
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveIngredients } from './ingredient-catalog.js';
import {
  collectIngredientCountWrites,
  computeIngredientStock,
  computeRecipeUsage,
  resolveStockProductId,
} from './inventory.js';

const flour = {
  id: 'usf-8091092', name: 'Flour', packSize: '1/50/LB', usFoodsCode: '8091092',
};

describe('resolveStockProductId', () => {
  const catalog = [
    flour,
    {
      id: 'usf-0877506', name: 'Butter', packSize: '36/1/LB', usFoodsCode: '0877506',
    },
    {
      id: 'new-4332656', name: 'Cheese, Shredded Cheddar/Monterey Jack Blend', packSize: '4/5/LB', usFoodsCode: '4332656',
    },
  ];

  it('maps legacy new-<code> receives onto the catalog row, including leading zeros', () => {
    assert.equal(resolveStockProductId('new-8091092', catalog), 'usf-8091092');
    assert.equal(resolveStockProductId('new-877506', catalog), 'usf-0877506');
    assert.equal(resolveStockProductId('usf-8091092', catalog), 'usf-8091092');
  });

  it('keeps a real added product on its own id and drops unknown ids', () => {
    assert.equal(resolveStockProductId('new-4332656', catalog), 'new-4332656');
    assert.equal(resolveStockProductId('new-ghost', catalog), null);
  });
});

describe('computeIngredientStock duplicates', () => {
  it('folds new-8091092 receives into Flour and does not invent a second row', () => {
    const stock = computeIngredientStock({
      catalog: [flour],
      receivingLogs: [
        {
          action: 'receive',
          productId: 'new-8091092',
          productName: 'FLOUR, WHEAT TRADITIONAL',
          packSize: '1/50/LB',
          timeStamp: '2026-11-01T00:00:00.000Z',
          date: '2026-11-01',
        },
        {
          action: 'receive',
          productId: 'new-ghost',
          productName: 'Ghost',
          packSize: '1/1/EA',
          timeStamp: '2026-11-01T00:00:00.000Z',
          date: '2026-11-01',
        },
      ],
    });
    assert.equal(stock.size, 1);
    assert.equal(stock.get('usf-8091092').productName, 'Flour');
    assert.equal(stock.get('usf-8091092').stock, 1);
  });

  it('deducts only batches shaped after a same-day physical count', () => {
    const catalog = [flour];
    const recipeMap = { '7oz plain': { 'usf-8091092': 22679.6 } };
    const productionLogs = [
      {
        action: 'shape_done',
        date: '2026-11-16',
        timeStamp: '2026-11-16T14:00:00.000Z',
        completions: JSON.stringify([{ sku: '7oz plain', batches: 1 }]),
      },
      {
        action: 'shape_done',
        date: '2026-11-16',
        timeStamp: '2026-11-16T18:00:00.000Z',
        completions: JSON.stringify([{ sku: '7oz plain', batches: 1 }]),
      },
    ];
    const usage = computeRecipeUsage({ productionLogs, recipeMap, catalog });
    const stock = computeIngredientStock({
      catalog,
      inventoryLogs: [{
        action: 'set_stock',
        productId: 'usf-8091092',
        quantity: '10',
        date: '2026-11-16',
        timeStamp: '2026-11-16T16:00:00.000Z',
      }],
      usageEntriesByProduct: usage.usageEntriesByProduct,
    });
    assert.ok(Math.abs(stock.get('usf-8091092').stock - 9) < 0.001);
    assert.equal(stock.get('usf-8091092').lastUpdated, '2026-11-16T18:00:00.000Z');
  });
});

describe('collectIngredientCountWrites', () => {
  it('matches the per-row physical count and skips blanks and unchanged rows', () => {
    const { writes, invalid } = collectIngredientCountWrites([
      { productId: 'usf-8091092', value: '4.5', current: 9 },
      { productId: 'usf-0877506', value: '', current: 2 },
      { productId: 'usf-1', value: '2', current: 2 },
      { productId: 'usf-2', value: '-1', current: 1 },
    ], { date: '2026-11-23', timeStamp: '2026-11-23T15:17:00.000Z' });
    assert.deepEqual(invalid, ['usf-2']);
    assert.deepEqual(writes, [{
      action: 'set_stock',
      productId: 'usf-8091092',
      quantity: '4.5',
      date: '2026-11-23',
      timeStamp: '2026-11-23T15:17:00.000Z',
      note: 'physical count',
    }]);
  });
});

describe('resolveIngredients', () => {
  it('does not add a second row when the code is already active, ignoring leading zeros', () => {
    const items = resolveIngredients([
      {
        action: 'new_product', usFoodsCode: '877506', productName: 'Butter sticks duplicate', packSize: '30/1/LB',
      },
    ]);
    assert.equal(items.some((p) => p.name === 'Butter sticks duplicate'), false);
  });

  it('lets an archived code be added again under new-<code>', () => {
    const items = resolveIngredients([
      { action: 'archive_product', productId: 'usf-8091092' },
      {
        action: 'new_product', usFoodsCode: '8091092', productName: 'Flour again', packSize: '1/50/LB', requiresTemp: 'false',
      },
    ]);
    assert.equal(items.some((p) => p.id === 'usf-8091092'), false);
    const again = items.find((p) => p.id === 'new-8091092');
    assert.equal(again.name, 'Flour again');
  });

  it('applies update_product onto a hardcoded row without changing its id', () => {
    const items = resolveIngredients([
      {
        action: 'update_product',
        productId: 'sysco-wrap-paper',
        productName: 'Wrap Paper 12x12 (Eastern Packaging)',
        packSize: '1/1000/CT',
        vendor: 'Eastern Packaging',
      },
    ]);
    const wrap = items.find((p) => p.id === 'sysco-wrap-paper');
    assert.equal(wrap.vendor, 'Eastern Packaging');
    assert.equal(wrap.packSize, '1/1000/CT');
  });
});

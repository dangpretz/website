import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planRecipeWrites, readRecipeLineGrams, writeLogRows } from './inventory.js';

const TS = '2026-11-16T21:47:48.000Z';
const SPICY = '7oz spicy bee';

const previousRecipe = {
  'usf-8091092': 8590, // flour, unchanged
  'recipe-water': 4810,
  'usf-0877506': 910,
  'usf-2373579': 180,
  'usf-3022647': 90,
  'usf-9929174': 860, // fresno, on screen
  'usf-6401780': 430, // archived sharp cheddar, hidden in the editor
};

function plan(extra) {
  return planRecipeWrites({
    sku: SPICY,
    previousRecipe,
    previousScale: { pretzelsPerTray: 9, traysPerBatch: 8 },
    pretzelsPerTray: 9,
    traysPerBatch: 8,
    timeStamp: TS,
    lines: [
      { productId: 'usf-8091092', grams: '8590' },
      { productId: 'recipe-water', grams: '4810' },
      { productId: 'usf-0877506', grams: '910' },
      { productId: 'usf-2373579', grams: '180' },
      { productId: 'usf-3022647', grams: '90' },
      { productId: 'usf-9929174', grams: '860' },
    ],
    ...extra,
  });
}

describe('readRecipeLineGrams', () => {
  it('keeps a new line whose focused input has not committed .value yet', () => {
    const lines = readRecipeLineGrams(
      [
        { productId: 'usf-8091092', value: '8590' },
        { productId: 'new-4332656', value: '' },
      ],
      { 'new-4332656': '430' },
    );
    assert.deepEqual(lines, [
      { productId: 'usf-8091092', grams: '8590' },
      { productId: 'new-4332656', grams: '430' },
    ]);
  });

  it('prefers a non-empty DOM value over the tracked draft', () => {
    const lines = readRecipeLineGrams(
      [{ productId: 'new-4332656', value: '430' }],
      { 'new-4332656': '' },
    );
    assert.equal(lines[0].grams, '430');
  });
});

describe('planRecipeWrites', () => {
  it('writes the new cheese line and skips unchanged lines and scale', () => {
    const writes = plan({
      lines: [
        { productId: 'usf-8091092', grams: '8590' },
        { productId: 'recipe-water', grams: '4810' },
        { productId: 'usf-0877506', grams: '910' },
        { productId: 'usf-2373579', grams: '180' },
        { productId: 'usf-3022647', grams: '90' },
        { productId: 'usf-9929174', grams: '860' },
        { productId: 'new-4332656', grams: '430' },
      ],
    });
    assert.deepEqual(writes, [{
      action: 'recipe_v2',
      sku: SPICY,
      productId: 'new-4332656',
      gramsPerBatch: '430',
      timeStamp: TS,
      updatedBy: '',
    }]);
  });

  it('still writes the new line when the DOM value was blank but tracked grams were 430', () => {
    const shown = readRecipeLineGrams(
      [
        { productId: 'usf-8091092', value: '8590' },
        { productId: 'new-4332656', value: '' },
      ],
      { 'new-4332656': '430' },
    );
    const saved = planRecipeWrites({
      sku: SPICY,
      previousRecipe,
      previousScale: { pretzelsPerTray: 9, traysPerBatch: 8 },
      pretzelsPerTray: 9,
      traysPerBatch: 8,
      timeStamp: TS,
      lines: shown,
    });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].productId, 'new-4332656');
    assert.equal(saved[0].gramsPerBatch, '430');
  });

  it('does not zero an archived line that the editor never rendered', () => {
    const writes = plan({});
    assert.equal(writes.some((w) => w.productId === 'usf-6401780'), false);
  });

  it('zeros a line the cook removed, and a cleared field', () => {
    const writes = plan({
      lines: [
        { productId: 'usf-8091092', grams: '8590' },
        { productId: 'usf-9929174', grams: '' },
      ],
      removedProductIds: ['usf-3022647'],
    });
    const ids = writes.map((w) => `${w.productId}=${w.gramsPerBatch}`);
    assert.deepEqual(ids.sort(), ['usf-3022647=0', 'usf-9929174=0']);
  });

  it('writes scale and density only when they changed', () => {
    const unchanged = plan({
      densities: [{ productId: 'usf-1324079', gramsPerInnerUnit: '3785' }],
      previousDensity: { 'usf-1324079': 3785 },
    });
    assert.equal(unchanged.length, 0);
    const changed = plan({
      pretzelsPerTray: 10,
      densities: [{ productId: 'usf-1324079', gramsPerInnerUnit: '3900' }],
      previousDensity: { 'usf-1324079': 3785 },
    });
    assert.deepEqual(changed.map((w) => w.action), ['sku_scale', 'ingredient_density']);
  });
});

describe('writeLogRows', () => {
  it('retries a 500 then continues in order, and reports a line that never lands', async () => {
    const calls = [];
    const appendLog = async (_path, row) => {
      calls.push(row.productId);
      if (row.productId === 'new-4332656' && calls.filter((id) => id === 'new-4332656').length < 2) {
        throw new Error('appendLog /dangpretz/recipes HTTP 500');
      }
      if (row.productId === 'usf-9929174') {
        throw new Error('appendLog /dangpretz/recipes HTTP 500');
      }
    };
    const rows = [
      { action: 'recipe_v2', productId: 'new-4332656', gramsPerBatch: '430' },
      { action: 'recipe_v2', productId: 'usf-9929174', gramsPerBatch: '860' },
      { action: 'recipe_v2', productId: 'usf-8091092', gramsPerBatch: '8590' },
    ];
    const failures = await writeLogRows(appendLog, '/dangpretz/recipes', rows, { retries: 2, delayMs: 0 });
    assert.deepEqual(calls, [
      'new-4332656', 'new-4332656',
      'usf-9929174', 'usf-9929174', 'usf-9929174',
      'usf-8091092',
    ]);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].row.productId, 'usf-9929174');
    assert.match(failures[0].error.message, /HTTP 500/);
  });
});

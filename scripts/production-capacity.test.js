/* eslint-env node */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const html = readFileSync(new URL('../static/production/index.html', import.meta.url), 'utf8');

function batchesPerWorker() {
  const match = html.match(/const BATCHES_PER_WORKER\s*=\s*(\d+)\s*;/);
  assert.ok(match, 'BATCHES_PER_WORKER is declared once as the daily rate');
  return Number(match[1]);
}

describe('production planner daily capacity', () => {
  it('caps each worker at 8 batches and keeps both teams at 2 workers by default', () => {
    assert.equal(batchesPerWorker(), 8);
    assert.equal(html.includes('BATCHES_PER_WORKER  = 6'), false);
    assert.match(html, /isNaN\(stored\) \? 2 : stored/);
    assert.match(html, /const minVal\s*=\s*type === 'shape' \? 0 : 1/);
    assert.match(html, /workers \* BATCHES_PER_WORKER/);
  });

  it('turns the default day into 16 batches and scales overrides by the same rate', () => {
    const rate = batchesPerWorker();
    const defaultWorkers = 2;
    assert.equal(defaultWorkers * rate, 16);
    assert.equal(3 * rate, 24);
    assert.equal(1 * rate, 8);
    assert.equal(0 * rate, 0);
  });
});

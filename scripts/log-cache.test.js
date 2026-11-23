import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compactLogRows, readCachedLog, writeCachedLog, startLoadWatch,
} from './log-cache.js';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

describe('compactLogRows', () => {
  it('drops signature images and keeps the delivery fields', () => {
    const rows = compactLogRows([
      {
        action: 'confirm', deliveryId: 'd1', signatureData: 'a'.repeat(5000), status: 'delivered',
      },
      { action: 'create', deliveryId: 'd2', customer: 'Arena' },
    ]);
    assert.equal(rows[0].signatureData, undefined);
    assert.equal(rows[0].deliveryId, 'd1');
    assert.equal(rows[0].action, 'confirm');
    assert.equal(rows[1].customer, 'Arena');
  });
});

describe('log cache', () => {
  it('round-trips rows without calling the network', async () => {
    const storage = memoryStorage();
    const rows = [{ action: 'create', deliveryId: 'd1', signatureData: 'blob' }];
    assert.equal(await writeCachedLog('/dangpretz/delivery-planner', rows, storage), true);
    const cached = await readCachedLog('/dangpretz/delivery-planner', storage);
    assert.equal(cached.length, 1);
    assert.equal(cached[0].deliveryId, 'd1');
    assert.equal(cached[0].signatureData, undefined);
    assert.equal(await readCachedLog('/dangpretz/missing', storage), null);
  });

  it('returns false when storage rejects the write', async () => {
    const storage = {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
      removeItem: () => {},
    };
    assert.equal(await writeCachedLog('/dangpretz/production', [{ action: 'inventory' }], storage), false);
  });
});

describe('startLoadWatch', () => {
  it('calls onTimeout only when finish is not called', async () => {
    let hits = 0;
    const pending = startLoadWatch(30, () => { hits += 1; });
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    assert.equal(hits, 1);
    const done = startLoadWatch(30, () => { hits += 1; });
    done.finish();
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    assert.equal(hits, 1);
    pending.finish();
  });
});

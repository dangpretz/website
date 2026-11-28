import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  caseCountForQuantity,
  mergePlannerDeliveryUpdate,
  mergePlannerLineItem,
} from './inventory.js';

describe('caseCountForQuantity', () => {
  it('keeps an exact multiple as that case count', () => {
    assert.equal(caseCountForQuantity(1080, 72), 15);
    assert.equal(caseCountForQuantity(64, 32), 2);
  });

  it('rounds a fractional case up without changing the implied quantity rule', () => {
    // 1080 / 32 = 33.75. Ceil matches planner save reconciliation.
    assert.equal(caseCountForQuantity(1080, 32), 34);
    assert.equal(caseCountForQuantity(15, 32), 1);
  });

  it('returns 0 when quantity or case size is missing', () => {
    assert.equal(caseCountForQuantity(0, 32), 0);
    assert.equal(caseCountForQuantity(1080, 0), 0);
  });
});

describe('mergePlannerLineItem', () => {
  it('keeps note and other unedited fields while applying the form', () => {
    const saved = mergePlannerLineItem(
      {
        sku: '7oz plain',
        quantity: 1080,
        caseSize: 72,
        caseCount: 15,
        note: 'extra salt',
        squareLineId: 'li_1',
      },
      {
        sku: '7oz plain',
        quantity: 1080,
        caseSize: 32,
        caseCount: 34,
      },
    );
    assert.equal(saved.note, 'extra salt');
    assert.equal(saved.squareLineId, 'li_1');
    assert.equal(saved.quantity, 1080);
    assert.equal(saved.caseSize, 32);
    assert.equal(saved.caseCount, 34);
  });

  it('drops case fields when the form has no case entry', () => {
    const saved = mergePlannerLineItem(
      {
        sku: '7oz plain',
        quantity: 15,
        caseSize: 32,
        caseCount: 1,
        note: 'keep',
      },
      {
        sku: '7oz bbk',
        quantity: 15,
        caseSize: 0,
        caseCount: 0,
      },
    );
    assert.equal(saved.sku, '7oz bbk');
    assert.equal(saved.note, 'keep');
    assert.equal(saved.caseSize, undefined);
    assert.equal(saved.caseCount, undefined);
  });

  it('builds a new line when there is no existing one', () => {
    const saved = mergePlannerLineItem(null, {
      sku: '10oz plain',
      quantity: 24,
      caseSize: 12,
      caseCount: 2,
    });
    assert.deepEqual(saved, {
      sku: '10oz plain',
      quantity: 24,
      caseSize: 12,
      caseCount: 2,
    });
  });
});

describe('mergePlannerDeliveryUpdate', () => {
  it('keeps the delivery note and other fields the form does not edit', () => {
    const payload = mergePlannerDeliveryUpdate(
      {
        deliveryId: 'd1',
        customer: 'Old Name',
        deliveryNote: 'leave at dock',
        notes: 'Square setup by 2',
        contactPhone: '801-555-0100',
        address: '1 S Main',
        confirmation: { confirmedBy: 'Ada' },
        barcodes: ['abc'],
        _coverage: { aggregateStatus: 'ready' },
        status: 'delivered',
      },
      {
        action: 'update',
        deliveryId: 'd1',
        customer: 'New Name',
        date: '2026-11-28',
        type: 'delivery',
        orderCategory: 'wholesale',
        lineItems: '[{"sku":"7oz plain","quantity":1080}]',
        status: 'scheduled',
        timeStamp: '2026-11-28T03:00:00.000Z',
      },
    );
    assert.equal(payload.customer, 'New Name');
    assert.equal(payload.deliveryNote, 'leave at dock');
    assert.equal(payload.notes, 'Square setup by 2');
    assert.equal(payload.contactPhone, '801-555-0100');
    assert.equal(payload.address, '1 S Main');
    assert.equal(payload.status, 'scheduled');
    assert.equal(payload.lineItems, '[{"sku":"7oz plain","quantity":1080}]');
    assert.equal(payload.confirmation, undefined);
    assert.equal(payload.barcodes, undefined);
    assert.equal(Object.hasOwn(payload, '_coverage'), false);
  });
});

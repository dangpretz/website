/* eslint-env node */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { denverCalendarDate } from './inventory.js';

// Pure date math. Must not call the dpc-log worker.
global.fetch = () => {
  throw new Error('dpc-log must not be called from date tests');
};

describe('denverCalendarDate', () => {
  it('stays on the Salt Lake calendar day for an evening count (MST, UTC-7)', () => {
    // Monday 11/23/2026 6:30pm America/Denver = Tuesday 01:30 UTC.
    const evening = new Date('2026-11-24T01:30:00.000Z');
    assert.equal(denverCalendarDate(evening), '2026-11-23');
    assert.equal(evening.toISOString().slice(0, 10), '2026-11-24');
  });

  it('rolls over at Denver midnight, not UTC midnight', () => {
    const before = new Date('2026-11-24T06:59:00.000Z'); // 11:59pm MST
    const after = new Date('2026-11-24T07:00:00.000Z'); // 12:00am MST
    assert.equal(denverCalendarDate(before), '2026-11-23');
    assert.equal(denverCalendarDate(after), '2026-11-24');
  });

  it('handles daylight time (MDT, UTC-6)', () => {
    const evening = new Date('2026-07-16T05:30:00.000Z'); // 11:30pm MDT Jul 15
    const midnight = new Date('2026-07-16T06:00:00.000Z'); // 12:00am MDT Jul 16
    assert.equal(denverCalendarDate(evening), '2026-07-15');
    assert.equal(denverCalendarDate(midnight), '2026-07-16');
  });

  it('matches the production page America/Denver formatter', () => {
    const samples = [
      '2026-11-24T01:30:00.000Z',
      '2026-11-24T06:59:00.000Z',
      '2026-11-24T07:00:00.000Z',
      '2026-07-16T05:30:00.000Z',
      '2026-03-08T09:30:00.000Z',
    ];
    samples.forEach((iso) => {
      const date = new Date(iso);
      const production = date.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
      assert.equal(denverCalendarDate(date), production, iso);
    });
  });
});

describe('count pages record the Denver day and leave the log shape alone', () => {
  it('staff inventory stamps Denver dates and keeps ISO timestamps', () => {
    const html = readFileSync(new URL('../static/inventory/index.html', import.meta.url), 'utf8');
    assert.equal(html.includes('toISOString().slice(0, 10)'), false);
    assert.match(html, /action:\s*'set_stock'[\s\S]*?date:\s*denverCalendarDate\(now\)[\s\S]*?timeStamp:\s*now\.toISOString\(\)/);
    assert.match(html, /inventory\.js\?v=2026-11-23-denver-date/);
  });

  it('delta center counts use the Denver today and still store an ISO timestamp', () => {
    const html = readFileSync(new URL('../static/delta-center-inventory/index.html', import.meta.url), 'utf8');
    assert.match(html, /const today = \(\) => denverCalendarDate\(\)/);
    assert.match(html, /action:\s*'count'[\s\S]*?date:\s*today\(\)/);
    assert.match(html, /timeStamp:\s*new Date\(\)\.toISOString\(\)/);
    assert.match(html, /inventory\.js\?v=2026-11-23-denver-date/);
  });
});

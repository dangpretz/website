/* eslint-env node */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  BOOTSTRAP_MANAGER_CODE,
  LEGACY_PRODUCTION_PIN_CODES,
  LINK_CATALOG,
  productionAccessAllowed,
  productionPageKey,
  productionUnlockKind,
  resolveStaffDirectory,
} from './staff-access.js';

// These tests are pure. They must not call the dpc-log worker.
global.fetch = () => {
  throw new Error('dpc-log must not be called from staff-access tests');
};

const PRODUCTION_VIEWS = [
  'production:manager',
  'production:shape',
  'production:bfp',
  'production:dips',
  'production:stock',
  'production:foh',
];

describe('production page access', () => {
  it('keeps the historical keypad codes, with the bootstrap code rotated', () => {
    assert.deepEqual(LEGACY_PRODUCTION_PIN_CODES, [
      '0068', '0571', '8468', '6124', '9281', '9646', '6362', '4614', '9709', '1377',
    ]);
    assert.equal(LEGACY_PRODUCTION_PIN_CODES.includes(BOOTSTRAP_MANAGER_CODE), true);
  });

  it('lets every historical code open every production view, even with no directory row', () => {
    LEGACY_PRODUCTION_PIN_CODES.forEach((code) => {
      PRODUCTION_VIEWS.forEach((pageKey) => {
        assert.equal(productionAccessAllowed({ code, links: [], pageKey }), true, code);
        assert.equal(productionUnlockKind(code, null, pageKey), 'legacy', code);
      });
    });
  });

  it('lets a directory grant open only that production view', () => {
    const code = '2222';
    const links = ['production:shape', 'production:bfp', 'production:stock'];
    assert.equal(productionAccessAllowed({ code, links, pageKey: 'production:shape' }), true);
    assert.equal(productionAccessAllowed({ code, links, pageKey: 'production:bfp' }), true);
    assert.equal(productionAccessAllowed({ code, links, pageKey: 'production:stock' }), true);
    assert.equal(productionAccessAllowed({ code, links, pageKey: 'production:manager' }), false);
    assert.equal(productionAccessAllowed({ code, links, pageKey: 'production:dips' }), false);
    assert.equal(productionAccessAllowed({ code, links, pageKey: 'production:foh' }), false);
    assert.equal(
      productionUnlockKind(code, { links }, 'production:shape'),
      'directory',
    );
    assert.equal(productionUnlockKind(code, { links }, 'production:manager'), 'deny');
    assert.equal(productionUnlockKind(code, null, 'production:shape'), 'deny');
  });

  it('does not grant a code that is neither historical nor in the directory', () => {
    assert.equal(productionAccessAllowed({
      code: '0000', links: [], pageKey: 'production:manager',
    }), false);
    assert.equal(productionUnlockKind('0000', undefined, 'production:manager'), 'deny');
  });

  it('maps each production role onto its own page key', () => {
    assert.equal(productionPageKey(''), 'production:manager');
    assert.equal(productionPageKey('manager'), 'production:manager');
    assert.equal(productionPageKey('Shape'), 'production:shape');
    assert.equal(productionPageKey('bfp'), 'production:bfp');
    assert.equal(productionPageKey('dips'), 'production:dips');
    assert.equal(productionPageKey('stock'), 'production:stock');
    assert.equal(productionPageKey('FOH'), 'production:foh');
    assert.equal(productionPageKey('nope'), 'production:manager');
  });
});

describe('bootstrap manager', () => {
  it('no longer accepts the offboarded former bootstrap code', () => {
    const retired = '8770';
    assert.notEqual(BOOTSTRAP_MANAGER_CODE, retired);
    assert.equal(LEGACY_PRODUCTION_PIN_CODES.includes(retired), false);
    assert.equal(resolveStaffDirectory([])[retired], undefined);
    assert.equal(productionUnlockKind(retired, undefined, 'production:manager'), 'deny');
  });

  it('resolves to a full manager when the log is empty', () => {
    const directory = resolveStaffDirectory([]);
    const bootstrap = directory[BOOTSTRAP_MANAGER_CODE];
    assert.equal(bootstrap.isManager, true);
    assert.deepEqual(bootstrap.links, LINK_CATALOG.map((link) => link.key));
  });

  it('keeps a saved row for the bootstrap code instead of widening it', () => {
    // A saved row for the bootstrap code has to win over the full-manager
    // fallback; this bugfix must not rewrite it.
    const saved = ['production:manager', 'inventory'];
    const directory = resolveStaffDirectory([{
      action: 'set_staff',
      code: BOOTSTRAP_MANAGER_CODE,
      name: 'Saved Manager',
      isManager: 'true',
      links: saved.join(','),
    }]);
    assert.equal(directory[BOOTSTRAP_MANAGER_CODE].name, 'Saved Manager');
    assert.equal(directory[BOOTSTRAP_MANAGER_CODE].isManager, true);
    assert.deepEqual(directory[BOOTSTRAP_MANAGER_CODE].links, saved);
    // The production keypad still accepts the bootstrap code for every view.
    // That decision does not change the saved row.
    assert.equal(
      productionUnlockKind(BOOTSTRAP_MANAGER_CODE, directory[BOOTSTRAP_MANAGER_CODE], 'production:foh'),
      'legacy',
    );
  });

  it('falls back to the built-in manager if that row is deleted', () => {
    const directory = resolveStaffDirectory([
      {
        action: 'set_staff',
        code: BOOTSTRAP_MANAGER_CODE,
        name: 'Saved Manager',
        isManager: 'true',
        links: 'inventory',
      },
      { action: 'delete_staff', code: BOOTSTRAP_MANAGER_CODE },
    ]);
    assert.equal(directory[BOOTSTRAP_MANAGER_CODE].name, 'Manager');
    assert.equal(directory[BOOTSTRAP_MANAGER_CODE].isManager, true);
    assert.ok(directory[BOOTSTRAP_MANAGER_CODE].links.includes('production:manager'));
  });
});

describe('production page wiring', () => {
  const html = readFileSync(new URL('../static/production/index.html', import.meta.url), 'utf8');

  it('does not keep a second hard-coded PIN list', () => {
    assert.equal(html.includes('const PIN_CODES'), false);
    assert.equal(html.includes('productionUnlockKind'), true);
    assert.match(html, /staff-access\.js\?v=/);
  });

  it('still stamps pretzel stock counts in America/Denver', () => {
    assert.match(html, /timeZone:\s*'America\/Denver'/);
    assert.match(html, /action:\s*'inventory',\s*date:\s*toDateStr\(new Date\(\)\)/);
  });
});

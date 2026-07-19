'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Diagnostics = require('../www/devicelink/diagnostics.js');

test('log produces structured entries and emits them', () => {
  const diag = new Diagnostics({ now: () => 42 });
  const emitted = [];
  diag.on('entry', (e) => emitted.push(e));

  const entry = diag.warning('subscription', 'CCCD_WRITE_TIMEOUT', {
    deviceId: 'lcdDisplay:AA', durationMs: 5032, retry: 1
  });
  assert.deepEqual(entry, {
    seq: 1, at: 42, level: 'warning', category: 'subscription',
    code: 'CCCD_WRITE_TIMEOUT', deviceId: 'lcdDisplay:AA', durationMs: 5032, retry: 1
  });
  assert.deepEqual(emitted, [entry]);
  assert.equal(diag.count('CCCD_WRITE_TIMEOUT'), 1);
});

test('level helpers set their level; unknown levels throw', () => {
  const diag = new Diagnostics({ now: () => 0 });
  assert.equal(diag.debug('scan', 'A').level, 'debug');
  assert.equal(diag.info('scan', 'B').level, 'info');
  assert.equal(diag.error('scan', 'C').level, 'error');
  assert.throws(() => diag.log('shout', 'scan', 'D'), RangeError);
  assert.throws(() => new Diagnostics({ minLevel: 'shout' }), RangeError);
});

test('minLevel filters quiet entries without counting them', () => {
  const diag = new Diagnostics({ now: () => 0, minLevel: 'info' });
  assert.equal(diag.debug('scan', 'NOISE'), null);
  assert.equal(diag.count('NOISE'), 0);
  assert.ok(diag.info('scan', 'KEPT'));
  assert.equal(diag.entries.length, 1);
});

test('the ring buffer caps entries but counters keep counting', () => {
  const diag = new Diagnostics({ now: () => 0, historyLimit: 2 });
  diag.info('x', 'CODE');
  diag.info('x', 'CODE');
  diag.info('x', 'CODE');
  assert.equal(diag.entries.length, 2);
  assert.deepEqual(diag.entries.map((e) => e.seq), [2, 3]);
  assert.equal(diag.count('CODE'), 3);
});

test('report bundles counters, entries and caller extras', () => {
  const diag = new Diagnostics({ now: () => 99 });
  diag.info('connection', 'CONNECT_READY', { durationMs: 830 });
  const report = diag.report({ snapshot: { devices: [] } });
  assert.equal(report.generatedAt, 99);
  assert.deepEqual(report.counters, { CONNECT_READY: 1 });
  assert.equal(report.entries.length, 1);
  assert.deepEqual(report.snapshot, { devices: [] });
});

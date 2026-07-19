'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ScanManager = require('../www/devicelink/scan_manager.js');

// Synchronous bluetoothle mock: records calls, lets the test play the native
// side (scan started, results, failures, stop confirmations).
function createMockBle() {
  const ble = {
    startCalls: 0,
    stopCalls: 0,
    _success: null,
    _error: null,
    _stopSuccess: null,
    _stopError: null,
    startScan(success, error, params) {
      ble.startCalls++;
      ble._success = success;
      ble._error = error;
      ble.params = params;
    },
    stopScan(success, error) {
      ble.stopCalls++;
      ble._stopSuccess = success;
      ble._stopError = error;
    },
    started() { ble._success({ status: 'scanStarted' }); },
    result(r) { ble._success(Object.assign({ status: 'scanResult' }, r)); },
    failStart(err) { ble._error(err); },
    stopped() { ble._stopSuccess({ status: 'scanStopped' }); },
    stopFailed(err) { ble._stopError(err); }
  };
  return ble;
}

function createTimers() {
  const timers = { scheduled: [] };
  timers.setTimeout = (fn, ms) => {
    const id = { fn, ms };
    timers.scheduled.push(id);
    return id;
  };
  timers.clearTimeout = (id) => {
    const at = timers.scheduled.indexOf(id);
    if (at >= 0) timers.scheduled.splice(at, 1);
  };
  return timers;
}

const einkDetector = (r) => (r.name && r.name.startsWith('EInk') ? { deviceType: 'eink' } : null);

test('the first observer starts a single scan; a second one does not restart it', () => {
  const ble = createMockBle();
  const sm = new ScanManager({ ble });
  const offA = sm.subscribe({ onDevice: () => {} });
  const offB = sm.subscribe({ onDevice: () => {} });
  assert.equal(ble.startCalls, 1);
  assert.equal(sm.state, 'starting');
  ble.started();
  assert.equal(sm.isScanning, true);
  offA();
  assert.equal(ble.stopCalls, 0); // one observer remains
  offB();
  assert.equal(ble.stopCalls, 1);
  ble.stopped();
  assert.equal(sm.state, 'stopped');
});

test('detectors route new devices to matching observers; repeat sightings go to onUpdate', () => {
  const ble = createMockBle();
  let t = 100;
  const sm = new ScanManager({ ble, now: () => t });
  sm.registerDetector('eink', einkDetector);

  const found = [];
  const updated = [];
  const other = [];
  sm.subscribe({ deviceTypes: ['eink'], onDevice: (d) => found.push(d), onUpdate: (d) => updated.push(d) });
  sm.subscribe({ deviceTypes: ['other'], onDevice: (d) => other.push(d) });
  ble.started();

  ble.result({ address: 'AA:BB', name: 'EInk-03D352', rssi: -60 });
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'AA:BB');
  assert.equal(found[0].deviceType, 'eink');
  assert.equal(found[0].rssi, -60);
  assert.equal(found[0].firstSeen, 100);
  assert.equal(other.length, 0);

  t = 200;
  ble.result({ address: 'AA:BB', name: 'EInk-03D352', rssi: -72 });
  assert.equal(found.length, 1); // still a single discovery
  assert.equal(updated.length, 1);
  assert.equal(updated[0].rssi, -72);
  assert.equal(updated[0].lastSeen, 200);
  assert.equal(sm.getDiscovered('eink').length, 1);
});

test('a late subscriber gets already-discovered devices replayed', () => {
  const ble = createMockBle();
  const sm = new ScanManager({ ble });
  sm.registerDetector('eink', einkDetector);
  sm.subscribe({ onDevice: () => {} });
  ble.started();
  ble.result({ address: 'AA:BB', name: 'EInk-1', rssi: -50 });

  const replayed = [];
  sm.subscribe({ deviceTypes: ['eink'], onDevice: (d) => replayed.push(d) });
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].id, 'AA:BB');
});

test('results with no matching detector are ignored', () => {
  const ble = createMockBle();
  const sm = new ScanManager({ ble });
  sm.registerDetector('eink', einkDetector);
  const found = [];
  sm.subscribe({ onDevice: (d) => found.push(d) });
  ble.started();
  ble.result({ address: 'CC:DD', name: 'SomethingElse', rssi: -40 });
  assert.equal(found.length, 0);
  assert.equal(sm.getDiscovered().length, 0);
});

test('a throwing detector does not break dispatch to later detectors', () => {
  const ble = createMockBle();
  const sm = new ScanManager({ ble });
  const origError = console.error;
  console.error = () => {};
  try {
    sm.registerDetector('broken', () => { throw new Error('boom'); });
    sm.registerDetector('eink', einkDetector);
    const found = [];
    sm.subscribe({ onDevice: (d) => found.push(d) });
    ble.started();
    ble.result({ address: 'AA:BB', name: 'EInk-1', rssi: -50 });
    assert.equal(found.length, 1);
  } finally {
    console.error = origError;
  }
});

test('holdForTransfer stops the scan; release restarts it', () => {
  const ble = createMockBle();
  const sm = new ScanManager({ ble });
  sm.subscribe({ onDevice: () => {} });
  ble.started();

  const release = sm.holdForTransfer('firmware');
  assert.equal(ble.stopCalls, 1);
  ble.stopped();
  assert.equal(sm.state, 'stopped');
  assert.equal(ble.startCalls, 1); // no restart while held

  release();
  assert.equal(ble.startCalls, 2);
  ble.started();
  assert.equal(sm.isScanning, true);
});

test('nested holds: only the last release restarts; double release is a no-op', () => {
  const ble = createMockBle();
  const sm = new ScanManager({ ble });
  sm.subscribe({ onDevice: () => {} });
  ble.started();

  const r1 = sm.holdForTransfer('image');
  ble.stopped();
  const r2 = sm.holdForTransfer('battery-critical');
  assert.equal(sm.holdCount, 2);

  r1();
  r1(); // double release must not decrement twice
  assert.equal(sm.holdCount, 1);
  assert.equal(ble.startCalls, 1);

  r2();
  assert.equal(sm.holdCount, 0);
  assert.equal(ble.startCalls, 2);
});

test('a hold arriving while starting stops the scan right after it starts', () => {
  const ble = createMockBle();
  const sm = new ScanManager({ ble });
  sm.subscribe({ onDevice: () => {} });
  assert.equal(sm.state, 'starting');

  sm.holdForTransfer('image');
  assert.equal(ble.stopCalls, 0); // nothing to stop yet

  ble.started(); // reconcile runs on completion
  assert.equal(ble.stopCalls, 1);
});

test('a failed scan start schedules a retry while observers still want one', () => {
  const ble = createMockBle();
  const timers = createTimers();
  const sm = new ScanManager({
    ble,
    retryMs: 15000,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout
  });
  const errors = [];
  sm.on('scanError', (e) => errors.push(e));
  sm.subscribe({ onDevice: () => {} });

  ble.failStart({ message: 'Scan start failed' });
  assert.equal(sm.state, 'stopped');
  assert.equal(errors.length, 1);
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].ms, 15000);

  timers.scheduled.shift().fn();
  assert.equal(ble.startCalls, 2);
});

test('a "Not scanning" stop error still counts as stopped', () => {
  const ble = createMockBle();
  const sm = new ScanManager({ ble });
  const off = sm.subscribe({ onDevice: () => {} });
  ble.started();
  off();
  ble.stopFailed({ message: 'Not scanning' });
  assert.equal(sm.state, 'stopped');
});

test('clearDiscovered forgets devices, optionally per type', () => {
  const ble = createMockBle();
  const sm = new ScanManager({ ble });
  sm.registerDetector('eink', einkDetector);
  sm.registerDetector('lcd', (r) => (r.name === 'LCD-1' ? { deviceType: 'lcd' } : null));
  sm.subscribe({ onDevice: () => {} });
  ble.started();
  ble.result({ address: 'AA:BB', name: 'EInk-1', rssi: -50 });
  ble.result({ address: 'CC:DD', name: 'LCD-1', rssi: -55 });
  assert.equal(sm.getDiscovered().length, 2);
  sm.clearDiscovered('lcd');
  assert.equal(sm.getDiscovered().length, 1);
  assert.equal(sm.getDiscovered()[0].deviceType, 'eink');
  sm.clearDiscovered();
  assert.equal(sm.getDiscovered().length, 0);
});

test('subscribe without onDevice throws; detector must be a function', () => {
  const sm = new ScanManager({ ble: createMockBle() });
  assert.throws(() => sm.subscribe({}), TypeError);
  assert.throws(() => sm.registerDetector('x', null), TypeError);
});

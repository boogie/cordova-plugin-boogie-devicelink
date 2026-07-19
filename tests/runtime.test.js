'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Runtime = require('../www/devicelink/runtime.js');
const Device = require('../www/devicelink/device.js');
const ScanManager = require('../www/devicelink/scan_manager.js');
const { createMockBle, createTimers, tick } = require('./mock_ble.js');

const ADDRESS = 'AA:BB:CC:DD:EE:FF';

class BatteryDisplay extends Device {
  getBattery() { return this._battery; }
}

function makeProfile(overrides = {}) {
  return Object.assign({
    deviceType: 'lcdDisplay',
    capabilities: ['battery'],
    connection: {
      connectTimeoutMs: 15000,
      reconnect: { policy: 'onUnexpectedDisconnect', initialDelayMs: 1000 }
    },
    characteristics: {
      uartNotify: { service: 'FFE0', characteristic: 'FFE2' }
    },
    onConnect: [{ action: 'subscribe', target: 'uartNotify' }]
  }, overrides);
}

function setup(profileOverrides, virtual) {
  const ble = createMockBle();
  const timers = createTimers();
  const clock = { t: 1000 };
  ble.addDevice(Object.assign({ address: ADDRESS }, virtual));
  const runtime = new Runtime({ sessionId: 'session-test', now: () => clock.t });
  const device = new BatteryDisplay({
    profile: makeProfile(profileOverrides),
    ble,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: () => clock.t
  });
  runtime.register(device);
  return { runtime, device, ble, timers, clock };
}

test('register forwards lifecycle and capability events into one sequenced stream', async () => {
  const { runtime, device, ble } = setup();
  const seen = [];
  runtime.stream.on('event', (e) => seen.push(e));

  await device.connect({ id: ADDRESS, name: 'LCD-1' });
  device.emit('batteryChanged', { level: 74 }); // declared by the 'battery' capability

  const types = seen.map((e) => e.type + (e.payload && e.payload.state ? ':' + e.payload.state : ''));
  assert.deepEqual(types, [
    'connectionStateChanged:connecting',
    'connectionStateChanged:discovering',
    'connectionStateChanged:configuring',
    'connectionStateChanged:ready',
    'batteryChanged'
  ]);
  const battery = seen[seen.length - 1];
  assert.equal(battery.deviceId, 'lcdDisplay:' + ADDRESS);
  assert.deepEqual(battery.payload, { level: 74 });
  // one strictly monotonic sequence across everything (registration included)
  const allSeqs = [runtime.stream.replaySince(0).events.map((e) => e.seq)][0];
  assert.deepEqual(allSeqs, allSeqs.map((_, i) => i + 1));

  ble.notify(ADDRESS, 'FFE2', new Uint8Array([1]));
  assert.equal(seen[seen.length - 1].type, 'batteryChanged'); // raw data is NOT streamed
});

test('connect-to-ready duration lands in diagnostics', async () => {
  const { runtime, device, clock } = setup({
    onConnect: [
      { action: 'custom', run: () => { clock.t += 250; } }
    ]
  });
  await device.connect({ id: ADDRESS });
  const ready = runtime.diagnostics.entries.find((e) => e.code === 'CONNECT_READY');
  assert.equal(ready.durationMs, 250);
  assert.equal(ready.deviceId, 'lcdDisplay:' + ADDRESS);
});

test('disconnect reasons are logged with matching severity', async () => {
  const { runtime, device, ble } = setup();
  await device.connect({ id: ADDRESS });

  ble.pushDisconnect(ADDRESS); // unexpected
  let entry = runtime.diagnostics.entries.find((e) => e.code === 'DISCONNECTED');
  assert.equal(entry.level, 'warning');
  assert.equal(entry.reason, 'gattError');
  assert.ok(runtime.diagnostics.count('RECONNECT_SCHEDULED') >= 1);

  await device.disconnect(); // user requested, from reconnectWaiting
  const entries = runtime.diagnostics.entries.filter((e) => e.code === 'DISCONNECTED');
  assert.equal(entries[entries.length - 1].level, 'info');
  assert.equal(entries[entries.length - 1].reason, 'userRequested');
});

test('getSnapshot aggregates device snapshots with the stream position', async () => {
  const { runtime, device } = setup();
  device.snapshot = function () {
    return Object.assign(Device.prototype.snapshot.call(this), { battery: 74 });
  };
  await device.connect({ id: ADDRESS, name: 'LCD-1' });

  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.sessionId, 'session-test');
  assert.equal(snapshot.lastSeq, runtime.stream.lastSeq);
  assert.equal(snapshot.devices.length, 1);
  const d = snapshot.devices[0];
  assert.equal(d.deviceType, 'lcdDisplay');
  assert.equal(d.id, ADDRESS);
  assert.equal(d.state, 'ready');
  assert.equal(d.battery, 74); // subclass extension
  assert.deepEqual(d.queue, { pending: 0, running: null });

  const report = runtime.report();
  assert.ok(report.counters.CONNECT_READY >= 1);
  assert.equal(report.snapshot.devices.length, 1);
});

test('unregister stops forwarding', async () => {
  const { runtime, device } = setup();
  await device.connect({ id: ADDRESS });
  const before = runtime.stream.lastSeq;

  assert.equal(runtime.unregister(device), true);
  device.emit('batteryChanged', { level: 1 });
  assert.equal(runtime.stream.lastSeq, before + 1); // only the deviceUnregistered event
  assert.equal(runtime.unregister(device), false);
  assert.deepEqual(runtime.devices, []);
});

test('two devices interleave on one monotonic sequence; find() locates by type', async () => {
  const ble = createMockBle();
  const timers = createTimers();
  ble.addDevice({ address: 'AA:AA:AA:AA:AA:AA' });
  ble.addDevice({ address: 'BB:BB:BB:BB:BB:BB' });
  const runtime = new Runtime({ sessionId: 's', now: () => 0 });
  const mk = (deviceType) => new BatteryDisplay({
    profile: makeProfile({ deviceType }),
    ble,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout
  });
  const lcd = runtime.register(mk('lcdDisplay'));
  const eink = runtime.register(mk('einkDisplay'));

  await lcd.connect({ id: 'AA:AA:AA:AA:AA:AA' });
  await eink.connect({ id: 'BB:BB:BB:BB:BB:BB' });

  const seqs = runtime.stream.replaySince(0).events.map((e) => e.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
  assert.equal(runtime.find('einkDisplay'), eink);
  assert.equal(runtime.find('nope'), null);
  assert.equal(runtime.getSnapshot().devices.length, 2);
});

test('a wired ScanManager reports discoveries to the stream and activity to diagnostics', () => {
  const ble = createMockBle();
  ble.startScan = (success) => { ble._scanCb = success; };
  ble.stopScan = (success) => success({ status: 'scanStopped' });

  const scanManager = new ScanManager({ ble });
  scanManager.registerDetector('lcdDisplay', (r) => (r.name === 'LCD-1' ? { deviceType: 'lcdDisplay' } : null));
  const runtime = new Runtime({ scanManager, sessionId: 's', now: () => 0 });

  scanManager.subscribe({ onDevice: () => {} });
  ble._scanCb({ status: 'scanStarted' });
  ble._scanCb({ status: 'scanResult', address: 'CC:CC', name: 'LCD-1', rssi: -48 });

  const discovered = runtime.stream.replaySince(0).events.find((e) => e.type === 'deviceDiscovered');
  assert.equal(discovered.deviceId, 'lcdDisplay:CC:CC');
  assert.deepEqual(discovered.payload, { name: 'LCD-1', rssi: -48 });
  assert.equal(runtime.diagnostics.count('SCAN_STARTED'), 1);

  const release = scanManager.holdForTransfer('image');
  release();
  assert.equal(runtime.diagnostics.count('SCAN_HOLD'), 1);
  assert.equal(runtime.diagnostics.count('SCAN_RELEASE'), 1);
});

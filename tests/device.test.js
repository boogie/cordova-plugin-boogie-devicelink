'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Device = require('../www/devicelink/device.js');
const CapabilityRegistry = require('../www/devicelink/capabilities.js');
const { createMockBle, createTimers, tick } = require('./mock_ble.js');

const ADDRESS = 'AA:BB:CC:DD:EE:FF';

function makeProfile(overrides = {}) {
  return Object.assign({
    deviceType: 'lcdDisplay',
    capabilities: [],
    connection: {
      connectTimeoutMs: 15000,
      reconnect: { policy: 'onUnexpectedDisconnect', initialDelayMs: 1000, maxDelayMs: 30000, factor: 2 }
    },
    characteristics: {
      uartWrite: { service: 'FFE0', characteristic: 'FFE1' },
      uartNotify: { service: 'FFE0', characteristic: 'FFE2' },
      battery: { service: '180F', characteristic: '2A19' }
    },
    onConnect: [
      { action: 'subscribe', target: 'uartNotify' },
      { action: 'write', target: 'uartWrite', data: 'HELLO' },
      { action: 'read', target: 'battery' }
    ]
  }, overrides);
}

function makeDevice(profileOverrides, deviceOpts = {}) {
  const ble = deviceOpts.ble || createMockBle();
  const timers = deviceOpts.timers || createTimers();
  ble.addDevice(Object.assign({ address: ADDRESS }, deviceOpts.virtual));
  const device = new Device(Object.assign({
    profile: makeProfile(profileOverrides),
    ble,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout
  }, deviceOpts.opts));
  return { device, ble, timers };
}

test('profile validation rejects broken profiles', () => {
  const V = Device.validateProfile;
  assert.throws(() => V(null), (e) => e.code === 'EBADPROFILE');
  assert.throws(() => V({}), /deviceType/);
  assert.throws(() => V({ deviceType: 'x', characteristics: { a: { service: 'S' } } }), /needs service and characteristic/);
  assert.throws(() => V({ deviceType: 'x', connection: { reconnect: { policy: 'sometimes' } } }), /reconnect policy/);
  assert.throws(() => V({ deviceType: 'x', onConnect: [{ action: 'teleport' }] }), /unknown action/);
  assert.throws(() => V({ deviceType: 'x', onConnect: [{ action: 'read', target: 'nope' }] }), /unknown characteristic/);
  assert.throws(() => V({ deviceType: 'x', onConnect: [{ action: 'custom' }] }), /custom step/);
  assert.throws(() => V({ deviceType: 'x', onConnect: [{ action: 'wait' }] }), /wait step/);
});

test('connect runs the full pipeline: connected is not ready', async () => {
  const { device, ble } = makeDevice();
  const states = [];
  device.on('connectionStateChanged', (e) => states.push(e.state));
  const readyEvents = [];
  device.on('ready', (e) => readyEvents.push(e));

  await device.connect({ id: ADDRESS, name: 'LCD-1' });

  assert.deepEqual(states, ['connecting', 'discovering', 'configuring', 'ready']);
  assert.equal(device.state, 'ready');
  assert.equal(device.isReady, true);
  assert.deepEqual(readyEvents, [{ id: ADDRESS, name: 'LCD-1' }]);

  const kinds = ble.log.map((e) => e[0]);
  assert.deepEqual(kinds, ['connect', 'discover', 'subscribe', 'write', 'read']);
  // the pipeline write carried the profile's handshake payload
  const write = ble.log.find((e) => e[0] === 'write');
  assert.equal(Buffer.from(write[2], 'base64').toString(), 'HELLO');
});

test('read results and notifications are decoded and routed to onData and the data event', async () => {
  const seen = [];
  const { device, ble } = makeDevice({
    characteristics: {
      uartWrite: { service: 'FFE0', characteristic: 'FFE1' },
      uartNotify: { service: 'FFE0', characteristic: 'FFE2' },
      battery: {
        service: '180F', characteristic: '2A19',
        onData: (dev, bytes, source) => seen.push([source, bytes[0]])
      }
    }
  }, {
    virtual: { readValues: { '2A19': Buffer.from([77]).toString('base64') } }
  });
  const events = [];
  device.on('data', (e) => events.push([e.source, e.target]));

  await device.connect({ id: ADDRESS });
  assert.deepEqual(seen, [['read', 77]]);

  ble.notify(ADDRESS, 'FFE2', new Uint8Array([1, 2]));
  assert.deepEqual(events, [['read', 'battery'], ['notification', 'uartNotify']]);
});

test('public write and read only work on an operational device', async () => {
  const { device, ble } = makeDevice();
  await assert.rejects(device.write('uartWrite', 'X'), (e) => e.code === 'ENOTREADY');

  await device.connect({ id: ADDRESS });
  await assert.rejects(device.write('nope', 'X'), (e) => e.code === 'EBADTARGET');

  await device.write('uartWrite', 'PING');
  const last = ble.log[ble.log.length - 1];
  assert.equal(last[0], 'write');
  assert.equal(Buffer.from(last[2], 'base64').toString(), 'PING');
});

test('an unexpected disconnect schedules a backoff reconnect that reconnects', async () => {
  const { device, ble, timers } = makeDevice();
  await device.connect({ id: ADDRESS });

  const states = [];
  device.on('connectionStateChanged', (e) => states.push(e.state + (e.reason ? ':' + e.reason : '')));
  const scheduled = [];
  device.on('reconnectScheduled', (e) => scheduled.push(e));

  ble.pushDisconnect(ADDRESS);
  assert.deepEqual(states, ['disconnected:gattError', 'reconnectWaiting']);
  assert.deepEqual(scheduled, [{ attempt: 1, delayMs: 1000 }]);

  timers.fire(); // the backoff timer
  await tick();
  assert.equal(device.state, 'ready');
  assert.equal(ble.log.filter((e) => e[0] === 'connect').length, 2);

  // a successful reconnect resets the backoff
  ble.pushDisconnect(ADDRESS);
  assert.equal(scheduled[1].delayMs, 1000);
});

test('failed reconnect attempts back off exponentially', async () => {
  const { device, ble, timers } = makeDevice();
  await device.connect({ id: ADDRESS });

  const scheduled = [];
  device.on('reconnectScheduled', (e) => scheduled.push(e.delayMs));

  ble._vd(ADDRESS).failConnect = true; // the device went away
  ble.pushDisconnect(ADDRESS);
  timers.fire();
  await tick();
  timers.fire();
  await tick();
  assert.deepEqual(scheduled, [1000, 2000, 4000]);
});

test('a user-requested disconnect never reconnects', async () => {
  const { device, ble, timers } = makeDevice();
  await device.connect({ id: ADDRESS });

  const states = [];
  device.on('connectionStateChanged', (e) => states.push(e.state));

  await device.disconnect();
  assert.deepEqual(states, ['disconnecting', 'disconnected']);
  assert.equal(device.disconnectReason, 'userRequested');
  assert.equal(timers.scheduled.length, 0); // no reconnect pending
  assert.equal(ble.log[ble.log.length - 1][0], 'close');
});

test('a connect timeout maps to the connectionTimeout reason and tears down', async () => {
  const { device, ble, timers } = makeDevice(
    { connection: { connectTimeoutMs: 5000, reconnect: { policy: 'none' } } },
    { virtual: { silentConnect: true } }
  );
  const pending = device.connect({ id: ADDRESS });
  const timer = timers.scheduled.find((t) => t.ms === 5000);
  assert.ok(timer, 'connect timeout should be scheduled');
  timer.fn();

  await assert.rejects(pending, (e) => e.code === 'ETIMEDOUT');
  assert.equal(device.state, 'disconnected');
  assert.equal(device.disconnectReason, 'connectionTimeout');
  assert.ok(ble.log.some((e) => e[0] === 'close'));
  assert.equal(timers.scheduled.length, 0); // reconnect policy none
});

test('optional pipeline steps may fail without failing the connection', async () => {
  const warnings = [];
  const { device } = makeDevice({
    onConnect: [
      { action: 'subscribe', target: 'uartNotify' },
      { action: 'read', target: 'battery', optional: true }
    ]
  }, { virtual: { failRead: true } });
  device.on('stepWarning', (e) => warnings.push(e.step));

  await device.connect({ id: ADDRESS });
  assert.equal(device.state, 'ready');
  assert.deepEqual(warnings, ['read:battery']);
});

test('a required pipeline step failure disconnects with a reason', async () => {
  const { device } = makeDevice({}, { virtual: { failSubscribe: true } });
  await assert.rejects(device.connect({ id: ADDRESS }), /subscribe failed/);
  assert.equal(device.state, 'disconnected');
  assert.equal(device.disconnectReason, 'gattError');
});

test('custom and wait steps run in the pipeline', async () => {
  const order = [];
  const { device, timers } = makeDevice({
    onConnect: [
      { action: 'custom', run: (dev) => { order.push('custom:' + dev.profile.deviceType); } },
      { action: 'wait', ms: 200 }
    ]
  });
  const pending = device.connect({ id: ADDRESS });
  await tick();
  const waitTimer = timers.scheduled.find((t) => t.ms === 200);
  assert.ok(waitTimer, 'wait step should schedule its delay');
  waitTimer.fn();
  await pending;
  assert.deepEqual(order, ['custom:lcdDisplay']);
});

test('declared capabilities are validated as protocols at construction', () => {
  const ble = createMockBle();
  const profile = makeProfile({ capabilities: ['battery'] });

  assert.throws(
    () => new Device({ profile, ble }),
    (e) => e.code === 'ENOTCONFORMANT' && e.missing.includes('battery.getBattery')
  );

  class BatteryDisplay extends Device {
    getBattery() { return 42; }
  }
  const device = new BatteryDisplay({ profile, ble });
  assert.equal(device.has('battery'), true);
  assert.equal(device.has('imageDisplay'), false);
  assert.deepEqual(device.capabilities, ['battery']);
});

test('a custom capability registry can be injected', () => {
  const registry = new CapabilityRegistry();
  registry.define('haptics', { methods: ['vibrate'] });
  const profile = makeProfile({ capabilities: ['haptics'] });
  const ble = createMockBle();
  assert.throws(() => new Device({ profile, ble, capabilities: registry }), (e) => e.code === 'ENOTCONFORMANT');
  class Haptic extends Device { vibrate() {} }
  const device = new Haptic({ profile, ble, capabilities: registry });
  assert.equal(device.has('haptics'), true);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Peripheral = require('../www/devicelink/peripheral.js');

const FULL_FF10 = '0000ff10-0000-1000-8000-00805f9b34fb';
const FULL_FF13 = '0000ff13-0000-1000-8000-00805f9b34fb';

// Peripheral-side bluetoothle mock: records calls, lets the test play the
// native side through the persistent initializePeripheral callback.
function createPeripheralMockBle() {
  const ble = {
    log: [],
    advertising: false,
    _initCb: null,
    _initErr: null,
    initializePeripheral(success, error, params) {
      ble.log.push(['init', params]);
      ble._initCb = success;
      ble._initErr = error;
      if (!ble.holdEnable) success({ status: 'enabled' });
    },
    addService(success, error, params) {
      ble.log.push(['addService', params]);
      if (ble.failAddService) { error({ message: 'Failed to add service' }); return; }
      success({ status: 'serviceAdded', service: params.service });
    },
    removeService(success, error, params) {
      ble.log.push(['removeService', params.service]);
      success({ status: 'serviceRemoved' });
    },
    removeAllServices(success, error) {
      ble.log.push(['removeAllServices']);
      success({ status: 'allServicesRemoved' });
    },
    startAdvertising(success, error, params) {
      ble.log.push(['startAdvertising', params]);
      ble.advertising = true;
      success({ status: 'advertisingStarted' });
    },
    stopAdvertising(success, error) {
      ble.log.push(['stopAdvertising']);
      if (!ble.advertising) { error({ message: 'Advertising already stopped' }); return; }
      ble.advertising = false;
      success({ status: 'advertisingStopped' });
    },
    isAdvertising(success) {
      success({ isAdvertising: ble.advertising });
    },
    respond(success, error, params) {
      ble.log.push(['respond', params]);
      success({ status: 'responded' });
    },
    notify(success, error, params) {
      ble.log.push(['notify', params]);
      if (ble.failNotifyFor === params.address) { error({ message: 'notify failed' }); return; }
      success({ status: 'notified' });
    },
    bytesToEncodedString: (bytes) => Buffer.from(bytes).toString('base64'),
    encodedStringToBytes: (str) => new Uint8Array(Buffer.from(str, 'base64')),
    push(result) { ble._initCb(result); }
  };
  return ble;
}

async function setup() {
  const ble = createPeripheralMockBle();
  const peripheral = new Peripheral({ ble });
  await peripheral.initialize();
  return { ble, peripheral };
}

test('UUID normalization collapses base-UUID aliases and uppercases', () => {
  assert.equal(Peripheral.normalizeUuid('ff10'), 'FF10');
  assert.equal(Peripheral.normalizeUuid(FULL_FF10), 'FF10');
  assert.equal(Peripheral.normalizeUuid('6e400001-b5a3-f393-e0a9-e50e24dcca9e'),
    '6E400001-B5A3-F393-E0A9-E50E24DCCA9E');
  assert.equal(Peripheral.normalizeUuid(null), '');
});

test('initialize resolves on enabled, defaults to requesting permission, and is idempotent', async () => {
  const ble = createPeripheralMockBle();
  const peripheral = new Peripheral({ ble });
  assert.equal(peripheral.isInitialized, false);
  await peripheral.initialize();
  assert.equal(peripheral.isInitialized, true);
  assert.equal(ble.log[0][1].request, true);
  await peripheral.initialize(); // second call resolves without a new native init
  assert.equal(ble.log.filter((e) => e[0] === 'init').length, 1);
});

test('an initialize failure before enabled rejects', async () => {
  const ble = createPeripheralMockBle();
  ble.initializePeripheral = (success, error) => error({ message: 'not supported' });
  const peripheral = new Peripheral({ ble });
  await assert.rejects(peripheral.initialize(), /not supported/);
  assert.equal(peripheral.isInitialized, false);
});

test('advertising helpers: services/service are cross-filled, timeout defaults to 0', async () => {
  const { ble, peripheral } = await setup();
  await peripheral.startAdvertising({ name: 'STATUS-BOARD', services: ['FF10', 'FF20'] });
  const params = ble.log.find((e) => e[0] === 'startAdvertising')[1];
  assert.equal(params.timeout, 0);
  assert.equal(params.service, 'FF10');
  assert.deepEqual(params.services, ['FF10', 'FF20']);
  assert.equal(await peripheral.isAdvertising(), true);

  await peripheral.stopAdvertising();
  assert.equal(await peripheral.isAdvertising(), false);
  // already-stopped counts as success
  const again = await peripheral.stopAdvertising();
  assert.equal(again.status, 'advertisingStopped');
});

test('subscriber and central tracking with normalized UUIDs; disconnect purges', async () => {
  const { ble, peripheral } = await setup();
  const events = [];
  peripheral.on('connected', (e) => events.push('connected:' + e.address));
  peripheral.on('subscribed', (e) => events.push('subscribed:' + e.service + '|' + e.characteristic));
  peripheral.on('unsubscribed', (e) => events.push('unsubscribed:' + e.address));
  peripheral.on('disconnected', (e) => events.push('disconnected:' + e.address));

  ble.push({ status: 'connected', address: 'AA' });
  ble.push({ status: 'connected', address: 'BB' });
  ble.push({ status: 'subscribed', address: 'AA', service: FULL_FF10, characteristic: FULL_FF13 });
  ble.push({ status: 'subscribed', address: 'BB', service: 'FF10', characteristic: 'FF13' });
  assert.deepEqual(peripheral.centrals, ['AA', 'BB']);
  // short and long UUID forms land in the same bucket
  assert.deepEqual(peripheral.subscribersOf('ff10', 'ff13'), ['AA', 'BB']);

  ble.push({ status: 'unsubscribed', address: 'BB', service: 'FF10', characteristic: 'FF13' });
  assert.deepEqual(peripheral.subscribersOf('FF10', 'FF13'), ['AA']);

  ble.push({ status: 'mtuChanged', address: 'AA', mtu: 247 });
  assert.equal(peripheral.mtuOf('AA'), 247);

  ble.push({ status: 'disconnected', address: 'AA' });
  assert.deepEqual(peripheral.centrals, ['BB']);
  assert.deepEqual(peripheral.subscribersOf('FF10', 'FF13'), []);
  assert.equal(peripheral.mtuOf('AA'), null);

  assert.deepEqual(events, [
    'connected:AA', 'connected:BB',
    'subscribed:FF10|FF13', 'subscribed:FF10|FF13',
    'unsubscribed:BB', 'disconnected:AA'
  ]);
});

test('readRequested carries respond/error helpers wired to the native respond', async () => {
  const { ble, peripheral } = await setup();
  const requests = [];
  peripheral.on('readRequested', (req) => requests.push(req));

  ble.push({ status: 'readRequested', address: 'AA', requestId: 7, offset: 0, service: FULL_FF10, characteristic: FULL_FF13 });
  assert.equal(requests.length, 1);
  const req = requests[0];
  assert.equal(req.characteristic, 'FF13');

  await req.respond(new Uint8Array([1, 2, 3]));
  let respond = ble.log.find((e) => e[0] === 'respond')[1];
  assert.equal(respond.requestId, 7);
  assert.deepEqual([...ble.encodedStringToBytes(respond.value)], [1, 2, 3]);
  assert.equal(respond.status, undefined);

  await req.error();
  respond = ble.log.filter((e) => e[0] === 'respond')[1][1];
  assert.equal(respond.status, 0x80);
});

test('writeRequested decodes the incoming value and knows if a response is needed', async () => {
  const { ble, peripheral } = await setup();
  const requests = [];
  peripheral.on('writeRequested', (req) => requests.push(req));

  ble.push({
    status: 'writeRequested', address: 'AA', requestId: 9, offset: 0,
    service: 'FF10', characteristic: 'FF13',
    value: ble.bytesToEncodedString(new Uint8Array([104, 105])),
    responseNeeded: true
  });
  const req = requests[0];
  assert.deepEqual([...req.value], [104, 105]);
  assert.equal(req.responseNeeded, true);
  await req.respond();
  const respond = ble.log.find((e) => e[0] === 'respond')[1];
  assert.equal(respond.requestId, 9);
  assert.equal(respond.value, undefined); // plain ack, no payload
});

test('notify encodes strings as UTF-8; notifyAll reaches every subscriber and survives failures', async () => {
  const { ble, peripheral } = await setup();
  ble.push({ status: 'subscribed', address: 'AA', service: 'FF10', characteristic: 'FF13' });
  ble.push({ status: 'subscribed', address: 'BB', service: 'FF10', characteristic: 'FF13' });
  ble.failNotifyFor = 'AA';

  const result = await peripheral.notifyAll({ service: 'FF10', characteristic: 'FF13', value: 'tick' });
  assert.equal(result.sent, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].address, 'AA');

  const notifies = ble.log.filter((e) => e[0] === 'notify');
  assert.equal(notifies.length, 2);
  assert.equal(Buffer.from(notifies[0][1].value, 'base64').toString(), 'tick');
});

test('unknown peripheral statuses surface as a generic event', async () => {
  const { ble, peripheral } = await setup();
  const seen = [];
  peripheral.on('peripheralEvent', (e) => seen.push(e.status));
  ble.push({ status: 'somethingNew', detail: 1 });
  assert.deepEqual(seen, ['somethingNew']);
});

test('addService failures reject with an Error', async () => {
  const { ble, peripheral } = await setup();
  ble.failAddService = true;
  await assert.rejects(
    peripheral.addService({ service: 'FF10', characteristics: [] }),
    /Failed to add service/
  );
});

// The bridge contract on the DeviceLink namespace — describe() and the raw
// exec() passthrough — driven through the scriptable cordova double.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const DeviceLink = require('../www/devicelink/devicelink.js');
const bluetoothle = require('../www/bluetoothle.js');
const { createMockCordova } = require('./mock_ble.js');

const ENVELOPE = {
  id: 'cordova-plugin-boogie-devicelink',
  version: DeviceLink.VERSION,
  platform: 'android',
  api: 1,
  actions: ['connect', 'describe', 'initialize'],
  features: { peripheral: true, permissionsBt: true, sequence: false, apiLevel: 34 }
};

/** Install a cordova double as the global for the duration of run(). */
async function withCordova(handlers, run) {
  const cordova = createMockCordova(handlers);
  global.cordova = cordova;
  try {
    return await run(cordova);
  } finally {
    delete global.cordova;
  }
}

test('the namespace carries the contract constants', () => {
  assert.equal(DeviceLink.ID, 'cordova-plugin-boogie-devicelink');
  assert.equal(DeviceLink.SERVICE, 'BluetoothLePlugin');
  assert.match(DeviceLink.VERSION, /^\d+\.\d+\.\d+$/);
});

test('describe() calls the native describe with no arguments and resolves the envelope', async () => {
  await withCordova({ describe: (success) => success(ENVELOPE) }, async (cordova) => {
    const info = await DeviceLink.describe();
    assert.deepEqual(cordova.log, [['BluetoothLePlugin', 'describe', []]]);
    assert.equal(info.id, DeviceLink.ID);
    assert.equal(info.version, DeviceLink.VERSION);
    assert.equal(info.platform, 'android');
    assert.equal(info.api, 1);
    assert.ok(info.actions.includes('describe'));
    assert.equal(typeof info.features, 'object');
    assert.equal(info.features.sequence, false);
  });
});

test('exec() passes service, action and args through untouched and resolves with the result', async () => {
  const params = { address: 'AA:BB', service: 'FFE0', characteristic: 'FFE1' };
  await withCordova({
    read: (success, error, args) => success({ status: 'read', address: args[0].address, value: 'AQ==' })
  }, async (cordova) => {
    const result = await DeviceLink.exec('read', [params]);
    assert.equal(result.status, 'read');
    assert.equal(result.address, 'AA:BB');
    const [service, action, args] = cordova.log[0];
    assert.equal(service, 'BluetoothLePlugin');
    assert.equal(action, 'read');
    assert.equal(args[0], params, 'the args array is forwarded as-is, not copied or normalised');
  });
});

test('exec() defaults args to an empty array', async () => {
  await withCordova({ isEnabled: (success) => success({ isEnabled: true }) }, async (cordova) => {
    const result = await DeviceLink.exec('isEnabled');
    assert.equal(result.isEnabled, true);
    assert.deepEqual(cordova.log[0][2], []);
  });
});

test('exec() rejects with an Error whose message is the native string and whose .native is the payload', async () => {
  await withCordova({}, async () => {
    await assert.rejects(DeviceLink.exec('noSuchAction'), (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, 'Invalid action');
      assert.equal(err.native, 'Invalid action');
      return true;
    });
  });
});

test('exec() rejects with the .message of an error object, keeping the object on .native', async () => {
  const payload = { error: 'connect', message: 'Device not found' };
  await withCordova({ connect: (success, error) => error(payload) }, async () => {
    await assert.rejects(DeviceLink.exec('connect', [{ address: 'AA:BB' }]), (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, 'Device not found');
      assert.equal(err.native, payload);
      return true;
    });
  });
});

test('exec() falls back to the JSON of a payload that has no message', async () => {
  const payload = { error: 'weird', code: 7 };
  await withCordova({ connect: (success, error) => error(payload) }, async () => {
    await assert.rejects(DeviceLink.exec('connect'), (err) => {
      assert.equal(err.message, JSON.stringify(payload));
      assert.equal(err.native, payload);
      return true;
    });
  });
});

test('exec() streams every success callback to onProgress and resolves with the first', async () => {
  let push = null;
  await withCordova({
    subscribe: (success) => {
      push = success;
      success({ status: 'subscribed' });
      success({ status: 'subscribedResult', value: 'AQ==' });
    }
  }, async () => {
    const seen = [];
    const first = await DeviceLink.exec('subscribe', [{ address: 'AA:BB' }], (r) => seen.push(r.status));
    assert.equal(first.status, 'subscribed');
    // the stream keeps flowing after the promise settled
    push({ status: 'subscribedResult', value: 'Ag==' });
    assert.deepEqual(seen, ['subscribed', 'subscribedResult', 'subscribedResult']);
  });
});

test('exec() without onProgress still resolves with the first result of a stream', async () => {
  await withCordova({
    subscribe: (success) => {
      success({ status: 'subscribed' });
      success({ status: 'subscribedResult', value: 'AQ==' });
    }
  }, async () => {
    const first = await DeviceLink.exec('subscribe', [{}]);
    assert.equal(first.status, 'subscribed');
  });
});

test('exec() without a cordova bridge rejects instead of throwing', async () => {
  delete global.cordova;
  await assert.rejects(DeviceLink.exec('describe'), /no cordova bridge available/);
  await assert.rejects(DeviceLink.describe(), /no cordova bridge available/);
});

test('bluetoothle.describe(success, error) is the callback-style twin', async () => {
  await withCordova({ describe: (success) => success(ENVELOPE) }, async (cordova) => {
    const info = await new Promise((resolve, reject) => bluetoothle.describe(resolve, reject));
    assert.equal(info.api, 1);
    assert.deepEqual(cordova.log, [['BluetoothLePlugin', 'describe', []]]);
  });
});

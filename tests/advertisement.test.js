'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Advertisement = require('../www/devicelink/advertisement.js');
const ScanManager = require('../www/devicelink/scan_manager.js');

// AD structure builder: length byte, type byte, payload.
const ad = (type, ...bytes) => [bytes.length + 1, type, ...bytes];
const str = (s) => [...s].map((c) => c.charCodeAt(0));
const b64 = (bytes) => Buffer.from(Uint8Array.from(bytes)).toString('base64');

test('parses the Android raw form: flags, name, uuids, manufacturer and service data', () => {
  const raw = [
    ...ad(0x01, 0x06),                        // flags
    ...ad(0x09, ...str('LCD-1')),             // complete local name
    ...ad(0x03, 0x10, 0xFF, 0x0F, 0x18),      // 16-bit uuids: FF10, 180F (LE)
    ...ad(0x0A, 0xF4),                        // tx power: -12 (int8)
    ...ad(0xFF, 0x57, 0x00, 0x1F, 0x01),      // manufacturer 0x0057, payload 1F 01
    ...ad(0x16, 0x0F, 0x18, 0x64)             // service data for 180F: [100]
  ];
  const adv = Advertisement.parse(b64(raw));

  assert.equal(adv.localName, 'LCD-1');
  assert.equal(adv.flags, 0x06);
  assert.equal(adv.txPowerLevel, -12);
  assert.equal(adv.connectable, null); // Android cannot know
  assert.deepEqual(adv.serviceUuids, ['FF10', '180F']);
  assert.deepEqual([...adv.manufacturerData['0057']], [0x1F, 0x01]);
  assert.deepEqual([...adv.serviceData['180F']], [100]);
  assert.equal(adv.raw.length, raw.length);
});

test('128-bit uuids come off the air little-endian and normalize to display order', () => {
  const nordicUartLE = [0x9E, 0xCA, 0xDC, 0x24, 0x0E, 0xE5, 0xA9, 0xE0, 0x93, 0xF3, 0xA3, 0xB5, 0x01, 0x00, 0x40, 0x6E];
  const adv = Advertisement.parse(b64(ad(0x07, ...nordicUartLE)));
  assert.deepEqual(adv.serviceUuids, ['6E400001-B5A3-F393-E0A9-E50E24DCCA9E']);

  // a 128-bit alias of the base uuid collapses to its short form
  const ff10LE = [0xFB, 0x34, 0x9B, 0x5F, 0x80, 0x00, 0x00, 0x80, 0x00, 0x10, 0x00, 0x00, 0x10, 0xFF, 0x00, 0x00];
  const short = Advertisement.parse(b64(ad(0x07, ...ff10LE)));
  assert.deepEqual(short.serviceUuids, ['FF10']);
});

test('a complete name wins over a shortened one, regardless of order', () => {
  const adv = Advertisement.parse(b64([
    ...ad(0x09, ...str('Full name')),
    ...ad(0x08, ...str('Short'))
  ]));
  assert.equal(adv.localName, 'Full name');

  const onlyShort = Advertisement.parse(b64(ad(0x08, ...str('Short'))));
  assert.equal(onlyShort.localName, 'Short');
});

test('tolerates truncated structures and zero-length padding', () => {
  const truncated = Advertisement.parse(b64([
    ...ad(0x09, ...str('OK')),
    10, 0xFF, 0x57 // claims 10 bytes but the buffer ends — must stop cleanly
  ]));
  assert.equal(truncated.localName, 'OK');
  assert.deepEqual(truncated.manufacturerData, {});

  const padded = Advertisement.parse(b64([
    ...ad(0x09, ...str('OK')),
    0, 0, 0, 0 // zero-length terminator + padding
  ]));
  assert.equal(padded.localName, 'OK');
});

test('parses the iOS object form into the same shape', () => {
  const adv = Advertisement.parse({
    localName: 'LCD-1',
    txPowerLevel: 4,
    isConnectable: 1,
    serviceUuids: ['0000ff10-0000-1000-8000-00805f9b34fb', '6e400001-b5a3-f393-e0a9-e50e24dcca9e'],
    serviceData: { '180f': Buffer.from([100]).toString('base64') },
    manufacturerData: Buffer.from([0x57, 0x00, 0x1F, 0x01]).toString('base64')
  });

  assert.equal(adv.localName, 'LCD-1');
  assert.equal(adv.txPowerLevel, 4);
  assert.equal(adv.connectable, true);
  assert.equal(adv.flags, null); // iOS cannot know
  assert.deepEqual(adv.serviceUuids, ['FF10', '6E400001-B5A3-F393-E0A9-E50E24DCCA9E']);
  assert.deepEqual([...adv.serviceData['180F']], [100]);
  assert.deepEqual([...adv.manufacturerData['0057']], [0x1F, 0x01]);
  assert.equal(adv.raw, null);
});

test('missing or unusable input yields the empty shape', () => {
  for (const input of [null, undefined, '', 42]) {
    const adv = Advertisement.parse(input);
    assert.equal(adv.localName, null);
    assert.deepEqual(adv.serviceUuids, []);
    assert.deepEqual(adv.manufacturerData, {});
  }
  const fromBytes = Advertisement.parse(Uint8Array.from(ad(0x09, ...str('X'))));
  assert.equal(fromBytes.localName, 'X'); // raw bytes work without base64
});

test('scan detectors receive the parsed advertisement and it lands on the entry', () => {
  const ble = {
    startScan(success) { ble._success = success; },
    stopScan(success) { success({ status: 'scanStopped' }); }
  };
  const sm = new ScanManager({ ble });
  const seen = [];
  // detect by manufacturer data instead of name-prefix matching
  sm.registerDetector('einkDisplay', (result, adv) => {
    seen.push(adv);
    const mfr = adv.manufacturerData['0057'];
    return mfr && mfr[0] === 0x1F ? { deviceType: 'einkDisplay' } : null;
  });
  const found = [];
  sm.subscribe({ onDevice: (d) => found.push(d) });
  ble._success({ status: 'scanStarted' });

  ble._success({
    status: 'scanResult',
    address: 'AA:BB',
    name: 'X',
    rssi: -50,
    advertisement: b64([...ad(0xFF, 0x57, 0x00, 0x1F), ...ad(0x09, ...str('EInk-1'))])
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].localName, 'EInk-1');
  assert.equal(found.length, 1);
  assert.deepEqual([...found[0].advertisement.manufacturerData['0057']], [0x1F]);
});

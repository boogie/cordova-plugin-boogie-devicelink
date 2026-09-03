// Consistency checks between plugin.xml, package.json, the native sources
// and the DeviceLink module graph — the things that silently break a Cordova
// plugin when they drift apart. The bridge contract (describe + raw exec)
// gets the same treatment: version literals, ids, the service name and the
// native action lists are all cross-checked against the dispatch code.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pluginXml = fs.readFileSync(path.join(root, 'plugin.xml'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const DeviceLink = require('../www/devicelink/devicelink.js');
const javaSrc = fs.readFileSync(path.join(root, 'src', 'android', 'BluetoothLePlugin.java'), 'utf8');
const objcSrc = fs.readFileSync(path.join(root, 'src', 'ios', 'BluetoothLePlugin.m'), 'utf8');
const objcHeader = fs.readFileSync(path.join(root, 'src', 'ios', 'BluetoothLePlugin.h'), 'utf8');
const bridgeJs = fs.readFileSync(path.join(root, 'www', 'bluetoothle.js'), 'utf8');

function literal(src, re) {
  const m = src.match(re);
  assert.ok(m, re + ' not found');
  return m[1];
}

/** The quoted names of a native array literal, in source order. */
function quotedList(src, opener) {
  const at = src.indexOf(opener);
  assert.ok(at >= 0, opener + ' not found');
  const body = src.slice(at, src.indexOf('};', at));
  return [...body.matchAll(/"(\w+)"/g)].map((m) => m[1]);
}

const pluginTag = pluginXml.match(/<plugin\b([^>]*)>/)[1];
const pluginId = pluginTag.match(/\bid="([^"]+)"/)[1];
const pluginVersion = pluginTag.match(/\bversion="([^"]+)"/)[1];

test('plugin id matches package.json name and cordova id', () => {
  assert.equal(pluginId, pkg.name);
  assert.equal(pluginId, pkg.cordova.id);
});

test('plugin.xml, package.json, DeviceLink.VERSION and the native version constants agree', () => {
  assert.equal(pluginVersion, pkg.version);
  assert.equal(DeviceLink.VERSION, pkg.version);
  assert.equal(literal(javaSrc, /String pluginVersion = "([^"]+)"/), pkg.version, 'Android pluginVersion');
  assert.equal(literal(objcSrc, /NSString \*const pluginVersion = @"([^"]+)"/), pkg.version, 'iOS pluginVersion');
});

test('every js-module source file exists', () => {
  const srcs = [...pluginXml.matchAll(/<js-module src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcs.length >= 5, 'expected the bluetoothle bridge plus the devicelink modules');
  for (const src of srcs) {
    assert.ok(fs.existsSync(path.join(root, src)), src + ' is declared but missing');
  }
});

test('devicelink js-module names equal their file basenames (relative require invariant)', () => {
  // cordova.js resolves require('./x') from module "plugin-id.name" to
  // "plugin-id.x" — so the js-module name attribute MUST equal the filename.
  const mods = [...pluginXml.matchAll(/<js-module src="(www\/devicelink\/[^"]+)" name="([^"]+)"/g)];
  assert.ok(mods.length >= 4);
  for (const [, src, name] of mods) {
    assert.equal(name, path.basename(src, '.js'), src + ' must be named after its file');
  }
});

test('every relative require inside www/devicelink has a matching js-module', () => {
  const dir = path.join(root, 'www', 'devicelink');
  const declared = new Set(
    [...pluginXml.matchAll(/<js-module src="www\/devicelink\/[^"]+" name="([^"]+)"/g)].map((m) => m[1])
  );
  for (const file of fs.readdirSync(dir)) {
    const body = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const [, id] of body.matchAll(/require\('\.\/([^']+)'\)/g)) {
      assert.ok(declared.has(id), file + " requires './" + id + "' which has no js-module entry");
    }
  }
});

test('package.json cordova platforms are declared in plugin.xml', () => {
  const declared = [...pluginXml.matchAll(/<platform name="([^"]+)">/g)].map((m) => m[1]);
  for (const platform of pkg.cordova.platforms) {
    assert.ok(declared.includes(platform), platform + ' missing from plugin.xml');
  }
});

test('both globals are clobbered: bluetoothle (raw escape hatch) and DeviceLink (runtime)', () => {
  assert.ok(pluginXml.includes('<clobbers target="window.bluetoothle" />'));
  assert.ok(pluginXml.includes('<clobbers target="window.DeviceLink" />'));
});

test('the DeviceLink namespace exposes the core building blocks', () => {
  const classes = [
    'Emitter', 'DeviceStateMachine', 'OperationQueue', 'ScanManager', 'Pacer',
    'BulkTransfer', 'CapabilityRegistry', 'Device', 'EventStream',
    'Diagnostics', 'Runtime', 'Peripheral'
  ];
  for (const name of classes) {
    assert.equal(typeof DeviceLink[name], 'function', name + ' missing from the namespace');
  }
  assert.ok(DeviceLink.capabilities, 'default capability registry missing');
  assert.ok(Array.isArray(DeviceLink.STATES));
  assert.ok(Array.isArray(DeviceLink.DISCONNECT_REASONS));
  assert.ok(Array.isArray(DeviceLink.PRIORITIES));
});

test('the iOS platform ships the Bluetooth usage descriptions', () => {
  assert.ok(pluginXml.includes('NSBluetoothAlwaysUsageDescription'));
  assert.ok(pluginXml.includes('NSBluetoothPeripheralUsageDescription'));
  assert.ok(pluginXml.includes('BLUETOOTH_USAGE_DESCRIPTION'));
});

// --- bridge contract v1: describe + raw exec ---------------------------------

test('DeviceLink.ID and the native plugin ids equal the plugin.xml id', () => {
  assert.equal(DeviceLink.ID, pluginId);
  assert.equal(literal(javaSrc, /String pluginId = "([^"]+)"/), pluginId, 'Android pluginId');
  assert.equal(literal(objcSrc, /NSString \*const pluginId = @"([^"]+)"/), pluginId, 'iOS pluginId');
});

test('DeviceLink.SERVICE names the native feature on both platforms and the bluetoothle bridge', () => {
  for (const platform of ['android', 'ios']) {
    const block = pluginXml.slice(pluginXml.indexOf('<platform name="' + platform + '">'));
    assert.equal(literal(block, /<feature name="([^"]+)">/), DeviceLink.SERVICE, platform + ' feature name');
  }
  assert.equal(literal(bridgeJs, /var bluetoothleName = "([^"]+)"/), DeviceLink.SERVICE);
});

test('describe is dispatched natively on both platforms and wrapped by both globals', () => {
  assert.ok(javaSrc.includes('if ("describe".equals(action)) {'), 'Android execute() lacks describe');
  assert.ok(javaSrc.includes('private void describeAction(CallbackContext callbackContext)'));
  assert.ok(objcSrc.includes('- (void)describe:(CDVInvokedUrlCommand *)command {'), 'iOS lacks describe:');
  assert.ok(objcHeader.includes('- (void)describe:(CDVInvokedUrlCommand *)command;'), 'iOS header lacks describe:');
  assert.ok(bridgeJs.includes('bluetoothleName, "describe", []'), 'bluetoothle.describe missing');
  assert.equal(typeof DeviceLink.describe, 'function');
  assert.equal(typeof DeviceLink.exec, 'function');
});

test('the Android describe action list equals the execute() dispatch chain, sorted', () => {
  const dispatched = [...new Set([...javaSrc.matchAll(/"(\w+)"\.equals\(action\)/g)].map((m) => m[1]))].sort();
  const listed = quotedList(javaSrc, 'String[] describeActions = {');
  assert.ok(dispatched.includes('describe'));
  assert.ok(dispatched.length > 50, 'expected the full bluetoothle action set');
  assert.deepEqual(listed, dispatched);
});

test('the iOS describe action list equals the -(void)name:(CDVInvokedUrlCommand*) methods, sorted', () => {
  const implemented = [...new Set(
    [...objcSrc.matchAll(/^- \(void\)(\w+):\(CDVInvokedUrlCommand \*\)command/gm)].map((m) => m[1])
  )].sort();
  const declared = new Set(
    [...objcHeader.matchAll(/^- \(void\)(\w+):\(CDVInvokedUrlCommand \*\)command;/gm)].map((m) => m[1])
  );
  const listed = quotedList(objcSrc, 'describeActions[] = {');
  assert.ok(implemented.includes('describe'));
  assert.ok(implemented.length > 40, 'expected the full bluetoothle action set');
  assert.deepEqual(listed, implemented);
  for (const name of listed) {
    assert.ok(declared.has(name), name + ' is implemented but not declared in the header');
  }
});

test('every action the bluetoothle bridge wraps is dispatched by at least one platform', () => {
  // DeviceLink.exec is the deliberate way past this set and is not checked.
  const union = new Set(
    quotedList(javaSrc, 'String[] describeActions = {').concat(quotedList(objcSrc, 'describeActions[] = {'))
  );
  const wrapped = [...new Set([...bridgeJs.matchAll(/bluetoothleName, "(\w+)"/g)].map((m) => m[1]))];
  assert.ok(wrapped.length > 50);
  for (const name of wrapped) {
    assert.ok(union.has(name), 'bluetoothle.' + name + ' calls an action no platform dispatches');
  }
});

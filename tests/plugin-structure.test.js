// Consistency checks between plugin.xml, package.json, and the DeviceLink
// module graph — the things that silently break a Cordova plugin when they
// drift apart.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pluginXml = fs.readFileSync(path.join(root, 'plugin.xml'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const DeviceLink = require('../www/devicelink/devicelink.js');

const pluginTag = pluginXml.match(/<plugin\b([^>]*)>/)[1];
const pluginId = pluginTag.match(/\bid="([^"]+)"/)[1];
const pluginVersion = pluginTag.match(/\bversion="([^"]+)"/)[1];

test('plugin id matches package.json name and cordova id', () => {
  assert.equal(pluginId, pkg.name);
  assert.equal(pluginId, pkg.cordova.id);
});

test('plugin.xml, package.json and DeviceLink.VERSION agree', () => {
  assert.equal(pluginVersion, pkg.version);
  assert.equal(DeviceLink.VERSION, pkg.version);
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
  assert.equal(typeof DeviceLink.Emitter, 'function');
  assert.equal(typeof DeviceLink.DeviceStateMachine, 'function');
  assert.equal(typeof DeviceLink.OperationQueue, 'function');
  assert.ok(Array.isArray(DeviceLink.STATES));
  assert.ok(Array.isArray(DeviceLink.DISCONNECT_REASONS));
  assert.ok(Array.isArray(DeviceLink.PRIORITIES));
});

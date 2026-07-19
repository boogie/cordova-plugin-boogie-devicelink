'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const CapabilityRegistry = require('../www/devicelink/capabilities.js');

test('define, has, get and names work; duplicate definition throws', () => {
  const registry = new CapabilityRegistry();
  registry.define('battery', { methods: ['getBattery'], events: ['batteryChanged'] });
  assert.equal(registry.has('battery'), true);
  assert.deepEqual(registry.get('battery').methods, ['getBattery']);
  assert.deepEqual(registry.names(), ['battery']);
  assert.throws(() => registry.define('battery', {}), /already defined/);
  assert.throws(() => registry.define('', {}), TypeError);
});

test('validate passes a conformant target', () => {
  const registry = new CapabilityRegistry();
  registry.define('battery', { methods: ['getBattery'] });
  registry.define('textDisplay', { methods: ['sendText'] });
  const target = { getBattery() {}, sendText() {} };
  registry.validate(['battery', 'textDisplay'], target);
});

test('validate collects ALL missing methods into one ENOTCONFORMANT error', () => {
  const registry = new CapabilityRegistry();
  registry.define('battery', { methods: ['getBattery'] });
  registry.define('textDisplay', { methods: ['sendText'] });
  assert.throws(
    () => registry.validate(['battery', 'textDisplay'], {}),
    (err) => err.code === 'ENOTCONFORMANT' &&
      err.missing.includes('battery.getBattery') &&
      err.missing.includes('textDisplay.sendText')
  );
});

test('validating an undeclared capability throws EUNKNOWNCAPABILITY', () => {
  const registry = new CapabilityRegistry();
  assert.throws(
    () => registry.validate(['levitation'], {}),
    (err) => err.code === 'EUNKNOWNCAPABILITY'
  );
});

test('methods inherited from a prototype satisfy the protocol', () => {
  const registry = new CapabilityRegistry();
  registry.define('battery', { methods: ['getBattery'] });
  class Base { getBattery() { return 1; } }
  class Concrete extends Base {}
  registry.validate(['battery'], new Concrete());
});

test('events() returns the union of declared events', () => {
  const registry = new CapabilityRegistry();
  registry.define('a', { events: ['x', 'y'] });
  registry.define('b', { events: ['y', 'z'] });
  assert.deepEqual(registry.events(['a', 'b']).sort(), ['x', 'y', 'z']);
});

test('the default registry ships the generic protocols', () => {
  const d = CapabilityRegistry.default;
  for (const name of ['battery', 'textDisplay', 'imageDisplay', 'buttonInput', 'firmwareUpdate']) {
    assert.equal(d.has(name), true, name + ' missing from default registry');
  }
});

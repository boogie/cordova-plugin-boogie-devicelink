// Capability registry — protocols for device classes.
//
// Application code should ask what a device CAN do, not what it IS:
// `device.has('battery')` instead of switching on concrete device types.
// A capability works like a protocol: it declares the methods and events an
// implementation must provide, and a device class is validated against every
// capability it declares — at construction time, so a missing method surfaces
// in development instead of as an undefined-is-not-a-function mid-show.
//
// Concrete device classes live with the application; this module only ships
// the registry plus a small set of generic, widely shared protocols.
'use strict';

class CapabilityRegistry {
  constructor() {
    this._caps = new Map();
  }

  /**
   * Define a capability protocol.
   * @param {string} name e.g. 'battery'
   * @param {object} [spec]
   * @param {string[]} [spec.methods] method names an implementation must have
   * @param {string[]} [spec.events] event names an implementation may emit
   */
  define(name, spec = {}) {
    if (!name || typeof name !== 'string') {
      throw new TypeError('capability name must be a non-empty string');
    }
    if (this._caps.has(name)) {
      throw new Error('capability already defined: ' + name);
    }
    const methods = spec.methods || [];
    const events = spec.events || [];
    if (!Array.isArray(methods) || !Array.isArray(events)) {
      throw new TypeError('methods and events must be arrays');
    }
    this._caps.set(name, { name, methods: methods.slice(), events: events.slice() });
    return this;
  }

  has(name) {
    return this._caps.has(name);
  }

  get(name) {
    return this._caps.get(name) || null;
  }

  names() {
    return [...this._caps.keys()];
  }

  /** Union of the events declared by the given capabilities. */
  events(capabilityNames) {
    const out = new Set();
    for (const name of capabilityNames || []) {
      const cap = this._caps.get(name);
      if (cap) {
        for (const event of cap.events) {
          out.add(event);
        }
      }
    }
    return [...out];
  }

  /**
   * Protocol conformance check: every method declared by every listed
   * capability must exist on the target. Reports ALL missing members at once
   * (code ENOTCONFORMANT); an undeclared capability name throws
   * EUNKNOWNCAPABILITY.
   */
  validate(capabilityNames, target) {
    const missing = [];
    for (const name of capabilityNames || []) {
      const cap = this._caps.get(name);
      if (!cap) {
        const err = new Error('unknown capability: ' + name);
        err.code = 'EUNKNOWNCAPABILITY';
        throw err;
      }
      for (const method of cap.methods) {
        if (typeof target[method] !== 'function') {
          missing.push(name + '.' + method);
        }
      }
    }
    if (missing.length) {
      const err = new Error(
        'target does not conform to its declared capabilities; missing: ' + missing.join(', ')
      );
      err.code = 'ENOTCONFORMANT';
      err.missing = missing;
      throw err;
    }
  }
}

// Generic protocols shared across device families (an e-ink display, an LCD
// display and a smart peripheral can all expose 'battery' the same way).
function registerBuiltins(registry) {
  registry.define('battery', { methods: ['getBattery'], events: ['batteryChanged'] });
  registry.define('textDisplay', { methods: ['sendText'], events: [] });
  registry.define('imageDisplay', { methods: ['sendImage'], events: [] });
  registry.define('buttonInput', { methods: [], events: ['buttonPressed'] });
  registry.define('firmwareUpdate', { methods: ['updateFirmware'], events: ['firmwareProgress'] });
  return registry;
}

CapabilityRegistry.default = registerBuiltins(new CapabilityRegistry());
CapabilityRegistry.registerBuiltins = registerBuiltins;

module.exports = CapabilityRegistry;

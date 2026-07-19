// Shared test doubles: a scriptable bluetoothle mock (virtual devices with
// configurable failure modes), manual timers, and a microtask flusher.
'use strict';

function createMockBle() {
  const ble = {
    log: [],
    devices: new Map(),
    _connectCbs: new Map(),
    _subs: new Map(),

    /** Register a virtual device: { address, failConnect, silentConnect,
     *  failDiscover, failSubscribe, failRead, failWrite, readValues, onWrite } */
    addDevice(vd) {
      ble.devices.set(vd.address, vd);
      return vd;
    },
    _vd(address) {
      return ble.devices.get(address) || {};
    },

    connect(success, error, params) {
      ble.log.push(['connect', params.address]);
      const vd = ble._vd(params.address);
      ble._connectCbs.set(params.address, { success, error });
      if (vd.silentConnect) return;
      if (vd.failConnect) { error({ message: 'connect failed' }); return; }
      success({ status: 'connected' });
    },
    discover(success, error, params) {
      ble.log.push(['discover', params.address]);
      const vd = ble._vd(params.address);
      if (vd.failDiscover) { error({ message: 'discover failed' }); return; }
      success({ status: 'discovered' });
    },
    subscribe(success, error, params) {
      ble.log.push(['subscribe', params.characteristic]);
      const vd = ble._vd(params.address);
      if (vd.failSubscribe) { error({ message: 'subscribe failed' }); return; }
      ble._subs.set(params.address + '|' + params.characteristic, success);
      success({ status: 'subscribed' });
    },
    read(success, error, params) {
      ble.log.push(['read', params.characteristic]);
      const vd = ble._vd(params.address);
      if (vd.failRead) { error({ message: 'read failed' }); return; }
      const value = (vd.readValues && vd.readValues[params.characteristic]) ||
        ble.bytesToEncodedString(new Uint8Array(0));
      success({ status: 'read', value });
    },
    write(success, error, params) {
      ble.log.push(['write', params.characteristic, params.value]);
      const vd = ble._vd(params.address);
      if (vd.onWrite) vd.onWrite(params);
      if (vd.failWrite) { error({ message: 'write failed' }); return; }
      success({ status: 'written' });
    },
    close(success, error, params) {
      ble.log.push(['close', params.address]);
      ble._connectCbs.delete(params.address);
      success({ status: 'closed' });
    },

    bytesToEncodedString: (bytes) => Buffer.from(bytes).toString('base64'),
    encodedStringToBytes: (str) => new Uint8Array(Buffer.from(str, 'base64')),

    // --- test drivers (play the device side) ---
    pushDisconnect(address) {
      const cb = ble._connectCbs.get(address);
      if (cb) cb.success({ status: 'disconnected' });
    },
    notify(address, characteristic, bytes) {
      const success = ble._subs.get(address + '|' + characteristic);
      if (success) success({ status: 'subscribedResult', value: ble.bytesToEncodedString(bytes) });
    }
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
  /** Fire the earliest scheduled timer. */
  timers.fire = () => {
    const next = timers.scheduled.shift();
    if (next) next.fn();
    return next;
  };
  return timers;
}

/** Flush pending microtasks so awaited mock callbacks propagate. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

module.exports = { createMockBle, createTimers, tick };

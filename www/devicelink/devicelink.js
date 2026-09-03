// DeviceLink public namespace (window.DeviceLink in a Cordova app).
//
// The runtime is being built bottom-up; this module exposes the tested core
// building blocks first. The raw BLE bridge remains untouched and available
// as window.bluetoothle.
'use strict';

const Emitter = require('./emitter');
const DeviceStateMachine = require('./state_machine');
const OperationQueue = require('./operation_queue');
const ScanManager = require('./scan_manager');
const Pacer = require('./pacer');
const BulkTransfer = require('./bulk_transfer');
const CapabilityRegistry = require('./capabilities');
const Device = require('./device');
const EventStream = require('./event_stream');
const Diagnostics = require('./diagnostics');
const Runtime = require('./runtime');
const Peripheral = require('./peripheral');
const Advertisement = require('./advertisement');

// Bridge contract v1 — the identity of this bridge and a raw way through it.
//
// A Cordova plugin's JS ships frozen together with its native half (an OTA
// update of the app's web code never replaces plugins/), so app code newer
// than this bridge needs a cheap, uniform way to learn what the native half
// is and can do (describe) and a way to reach a native action the bridge
// does not wrap (exec). Keep ID/VERSION/SERVICE in sync with plugin.xml and
// the native constants (asserted by the test suite).
const ID = 'cordova-plugin-boogie-devicelink';
const VERSION = '0.2.0';
const SERVICE = 'BluetoothLePlugin';

// cordova is resolved lazily, like the bluetoothle bridge in the device
// classes, so the module loads (and is testable) outside a WebView.
function cordovaBridge() {
  const cdv = typeof cordova !== 'undefined' ? cordova : null;
  if (!cdv || typeof cdv.exec !== 'function') {
    throw new Error('no cordova bridge available');
  }
  return cdv;
}

// The native error string, its message field, or its JSON — the raw payload
// stays on err.native.
function toError(raw) {
  if (raw instanceof Error) {
    return raw;
  }
  let message;
  if (typeof raw === 'string') {
    message = raw;
  } else if (raw && typeof raw.message === 'string') {
    message = raw.message;
  } else {
    message = JSON.stringify(raw) || String(raw);
  }
  const err = new Error(message);
  err.native = raw;
  return err;
}

/**
 * Raw passthrough to cordova.exec for this plugin's service — the escape
 * hatch for native actions this bridge does not wrap. No argument
 * normalisation, no bookkeeping: the Device/Peripheral/ScanManager layers do
 * not see what goes through here.
 * @param {string} action native action name (see describe().actions)
 * @param {Array} [args=[]] handed to the native side as-is
 * @param {function} [onProgress] receives every success callback of a
 *   streaming action (keepCallback); the promise resolves with the first
 * @returns {Promise<*>} rejects with an Error carrying the payload as .native
 */
function exec(action, args, onProgress) {
  return new Promise((resolve, reject) => {
    let cdv;
    try {
      cdv = cordovaBridge();
    } catch (err) {
      reject(err);
      return;
    }
    cdv.exec((result) => {
      resolve(result);
      if (typeof onProgress === 'function') {
        onProgress(result);
      }
    }, (raw) => reject(toError(raw)), SERVICE, action, args || []);
  });
}

/**
 * What the native half is and can do: { id, version, platform, api,
 * actions, features }. Cheap and side-effect free on both platforms.
 * @returns {Promise<object>}
 */
function describe() {
  return exec('describe');
}

const DeviceLink = {
  ID,
  VERSION,
  SERVICE,
  describe,
  exec,

  Emitter,
  DeviceStateMachine,
  OperationQueue,
  ScanManager,
  Pacer,
  BulkTransfer,
  CapabilityRegistry,
  Device,
  EventStream,
  Diagnostics,
  Runtime,
  Peripheral,

  // Shared default capability registry (protocols like 'battery').
  capabilities: CapabilityRegistry.default,

  // Public advertisement utilities — usable from legacy scan code too:
  // DeviceLink.parseAdvertisement(result.advertisement) works with the
  // Android base64 blob and the iOS parsed object alike.
  Advertisement,
  parseAdvertisement: Advertisement.parse,
  normalizeUuid: Advertisement.normalizeUuid,

  STATES: DeviceStateMachine.STATES,
  DISCONNECT_REASONS: DeviceStateMachine.DISCONNECT_REASONS,
  PRIORITIES: OperationQueue.PRIORITIES
};

module.exports = DeviceLink;

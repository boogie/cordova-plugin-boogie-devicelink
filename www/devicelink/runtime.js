// Runtime — the aggregation point above individual devices.
//
// Registers Device instances and forwards their lifecycle into ONE sequenced
// EventStream (state changes, reconnects, step warnings, plus every event
// their declared capabilities announce — a device that declares 'battery'
// gets its 'batteryChanged' forwarded automatically). Wires diagnostics with
// the metrics that matter in support: connect-to-ready duration, disconnect
// reasons, reconnect attempts, scan activity.
//
// getSnapshot() is how a reloaded UI resyncs: current state of every device
// plus the stream position, so the consumer can replaySince() or, on a gap /
// new sessionId, rebuild from the snapshot alone.
'use strict';

const Emitter = require('./emitter');
const EventStream = require('./event_stream');
const Diagnostics = require('./diagnostics');
const CapabilityRegistry = require('./capabilities');

class Runtime extends Emitter {
  /**
   * @param {object} [opts]
   * @param {ScanManager} [opts.scanManager] wired into diagnostics + stream
   * @param {CapabilityRegistry} [opts.capabilities] for capability events
   * @param {EventStream} [opts.stream] bring your own…
   * @param {Diagnostics} [opts.diagnostics] …or configure via the options below
   * @param {string} [opts.sessionId]
   * @param {string} [opts.minLevel]
   * @param {number} [opts.eventHistoryLimit]
   * @param {number} [opts.logHistoryLimit]
   * @param {function} [opts.now=Date.now]
   */
  constructor(opts = {}) {
    super();
    this._now = opts.now || Date.now;
    this.stream = opts.stream || new EventStream({
      now: this._now,
      sessionId: opts.sessionId,
      historyLimit: opts.eventHistoryLimit
    });
    this.diagnostics = opts.diagnostics || new Diagnostics({
      now: this._now,
      minLevel: opts.minLevel,
      historyLimit: opts.logHistoryLimit
    });
    this._capabilities = opts.capabilities || CapabilityRegistry.default;
    this._devices = new Map();
    this.scanManager = opts.scanManager || null;
    if (this.scanManager) {
      this._wireScanManager();
    }
  }

  get sessionId() {
    return this.stream.sessionId;
  }

  get devices() {
    return [...this._devices.keys()];
  }

  find(deviceType) {
    for (const device of this._devices.keys()) {
      if (device.profile.deviceType === deviceType) {
        return device;
      }
    }
    return null;
  }

  _deviceId(device) {
    return device.profile.deviceType + (device.id ? ':' + device.id : '');
  }

  /** Register a device: its lifecycle and capability events join the stream. */
  register(device) {
    if (this._devices.has(device)) {
      return device;
    }
    const entry = { offs: [], connectStartedAt: null };
    const id = () => this._deviceId(device);

    entry.offs.push(device.on('connectionStateChanged', (e) => {
      this.stream.publish('connectionStateChanged', id(), {
        state: e.state, from: e.from, reason: e.reason
      });
      if (e.state === 'connecting' || e.state === 'reconnecting') {
        entry.connectStartedAt = this._now();
      } else if (e.state === 'ready') {
        const durationMs = entry.connectStartedAt !== null ? this._now() - entry.connectStartedAt : null;
        this.diagnostics.info('connection', 'CONNECT_READY', { deviceId: id(), durationMs });
      } else if (e.state === 'disconnected') {
        const level = e.reason === 'userRequested' ? 'info' : 'warning';
        this.diagnostics.log(level, 'connection', 'DISCONNECTED', { deviceId: id(), reason: e.reason });
      }
    }));

    entry.offs.push(device.on('reconnectScheduled', (e) => {
      this.stream.publish('reconnectScheduled', id(), e);
      this.diagnostics.info('connection', 'RECONNECT_SCHEDULED', {
        deviceId: id(), attempt: e.attempt, delayMs: e.delayMs
      });
    }));

    entry.offs.push(device.on('stepWarning', (e) => {
      this.stream.publish('stepWarning', id(), { step: e.step });
      this.diagnostics.warning('connection', 'STEP_WARNING', { deviceId: id(), step: e.step });
    }));

    // Everything the device's declared capability protocols announce
    // ('batteryChanged', 'buttonPressed', …) joins the stream automatically.
    for (const eventName of this._capabilities.events(device.capabilities)) {
      entry.offs.push(device.on(eventName, (payload) => {
        this.stream.publish(eventName, id(), payload);
      }));
    }

    this._devices.set(device, entry);
    this.stream.publish('deviceRegistered', id(), { deviceType: device.profile.deviceType });
    return device;
  }

  unregister(device) {
    const entry = this._devices.get(device);
    if (!entry) {
      return false;
    }
    for (const off of entry.offs) {
      off();
    }
    this._devices.delete(device);
    this.stream.publish('deviceUnregistered', this._deviceId(device), null);
    return true;
  }

  /** Current state of everything — what a reloaded UI resyncs from. */
  getSnapshot() {
    return {
      sessionId: this.sessionId,
      at: this._now(),
      lastSeq: this.stream.lastSeq,
      devices: this.devices.map((device) => device.snapshot())
    };
  }

  /** Support bundle: diagnostics report with the snapshot attached. */
  report() {
    return this.diagnostics.report({ snapshot: this.getSnapshot() });
  }

  _wireScanManager() {
    const scan = this.scanManager;
    scan.on('scanStarted', () => this.diagnostics.debug('scan', 'SCAN_STARTED', {}));
    scan.on('scanStopped', () => this.diagnostics.debug('scan', 'SCAN_STOPPED', {}));
    scan.on('scanError', (e) => this.diagnostics.warning('scan', 'SCAN_ERROR', {
      error: (e && e.message) || null
    }));
    scan.on('hold', (e) => this.diagnostics.debug('scan', 'SCAN_HOLD', {
      reason: e.reason, holds: e.holds
    }));
    scan.on('release', (e) => this.diagnostics.debug('scan', 'SCAN_RELEASE', {
      reason: e.reason, holds: e.holds
    }));
    scan.on('device', (d) => this.stream.publish('deviceDiscovered', d.deviceType + ':' + d.id, {
      name: d.name, rssi: d.rssi
    }));
  }
}

module.exports = Runtime;

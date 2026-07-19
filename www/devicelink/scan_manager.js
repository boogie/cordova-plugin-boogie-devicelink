// Single owner of the BLE scanner.
//
// Exactly one native scan runs at a time; everything else observes it.
// Detectors (registered per device type, typically by device profiles) turn
// raw advertisements into device info; observers subscribe by device type and
// get new discoveries plus repeat-sighting updates.
//
// Transfer awareness: a scan colliding with a timing-sensitive transfer
// steals the radio and stalls in-flight writes, so bulk transfers take a
// hold (holdForTransfer) for their whole duration and the scan is stopped —
// not skipped — until the last hold is released. Stopping mid-transfer is
// safe here because the native layer's stopScan no longer holds a lock
// across framework calls (see BluetoothLePlugin.java).
'use strict';

const Emitter = require('./emitter');

class ScanManager extends Emitter {
  /**
   * @param {object} [opts]
   * @param {object} [opts.ble] bluetoothle-compatible bridge (defaults to
   *   window.bluetoothle, resolved lazily at first use)
   * @param {object} [opts.scanParams] passed through to startScan
   * @param {number} [opts.retryMs=15000] delay before retrying a failed scan
   *   start while observers still want one; 0 disables retries
   * @param {function} [opts.setTimeout] injectable timers for tests
   * @param {function} [opts.clearTimeout]
   * @param {function} [opts.now=Date.now]
   */
  constructor(opts = {}) {
    super();
    this._ble = opts.ble || null;
    this._scanParams = opts.scanParams || {};
    this._retryMs = opts.retryMs !== undefined ? opts.retryMs : 15000;
    this._setTimeout = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = opts.clearTimeout || ((t) => clearTimeout(t));
    this._now = opts.now || Date.now;
    this._detectors = new Map();
    this._observers = new Map();
    this._nextObserverId = 1;
    this._discovered = new Map();
    this._holds = 0;
    this._scanState = 'stopped'; // stopped | starting | scanning | stopping
    this._retryTimer = null;
  }

  _bridge() {
    const ble = this._ble || (typeof window !== 'undefined' ? window.bluetoothle : null);
    if (!ble) {
      throw new Error('no bluetoothle bridge available');
    }
    return ble;
  }

  get state() {
    return this._scanState;
  }

  get isScanning() {
    return this._scanState === 'scanning';
  }

  get holdCount() {
    return this._holds;
  }

  /**
   * Register a detector for a device type. A detector receives the raw scan
   * result and returns a device info object (at minimum { deviceType }) or
   * null if the advertisement is not this device type. The first matching
   * detector wins.
   */
  registerDetector(deviceType, fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('detector must be a function');
    }
    this._detectors.set(deviceType, fn);
  }

  /**
   * Observe discoveries. Starts the scan when the first observer arrives;
   * the scan stops when the last one leaves. Already-discovered matching
   * devices are replayed immediately. Returns an unsubscribe function.
   *
   * @param {object} config
   * @param {function} config.onDevice called with each newly discovered device
   * @param {function} [config.onUpdate] called on repeat sightings (rssi/lastSeen)
   * @param {string[]} [config.deviceTypes] filter; omit for all types
   */
  subscribe(config) {
    if (!config || typeof config.onDevice !== 'function') {
      throw new TypeError('config.onDevice must be a function');
    }
    const id = this._nextObserverId++;
    const observer = {
      deviceTypes: config.deviceTypes || null,
      onDevice: config.onDevice,
      onUpdate: config.onUpdate || null
    };
    this._observers.set(id, observer);
    for (const entry of this._discovered.values()) {
      if (this._matches(observer, entry)) {
        this._safeCall(observer.onDevice, entry);
      }
    }
    this._reconcile();
    return () => {
      if (this._observers.delete(id)) {
        this._reconcile();
      }
    };
  }

  /**
   * Take the radio for a timing-sensitive transfer: the scan is stopped for
   * as long as any hold is outstanding. Returns a release function (safe to
   * call more than once).
   */
  holdForTransfer(reason) {
    this._holds++;
    this.emit('hold', { reason: reason || null, holds: this._holds });
    this._reconcile();
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this._holds--;
      this.emit('release', { reason: reason || null, holds: this._holds });
      this._reconcile();
    };
  }

  getDiscovered(deviceType) {
    const all = [...this._discovered.values()];
    return deviceType ? all.filter((d) => d.deviceType === deviceType) : all;
  }

  clearDiscovered(deviceType) {
    if (!deviceType) {
      this._discovered.clear();
      return;
    }
    for (const [id, entry] of [...this._discovered]) {
      if (entry.deviceType === deviceType) {
        this._discovered.delete(id);
      }
    }
  }

  _matches(observer, entry) {
    return !observer.deviceTypes || observer.deviceTypes.indexOf(entry.deviceType) >= 0;
  }

  _safeCall(fn, arg) {
    try {
      fn(arg);
    } catch (err) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('[DeviceLink] scan observer threw:', err);
      }
    }
  }

  _wantScan() {
    return this._observers.size > 0 && this._holds === 0;
  }

  // Converge the native scan toward the desired state. While a start/stop is
  // in flight we do nothing — its completion handler reconciles again, so a
  // hold arriving mid-start stops the scan right after it starts.
  _reconcile() {
    if (this._retryTimer !== null) {
      this._clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this._scanState === 'starting' || this._scanState === 'stopping') {
      return;
    }
    const want = this._wantScan();
    if (want && this._scanState === 'stopped') {
      this._start();
    } else if (!want && this._scanState === 'scanning') {
      this._stop();
    }
  }

  _start() {
    const ble = this._bridge();
    this._scanState = 'starting';
    ble.startScan(
      (result) => {
        if (result && result.status === 'scanStarted') {
          if (this._scanState === 'starting') {
            this._scanState = 'scanning';
            this.emit('scanStarted', {});
            this._reconcile();
          }
        } else if (result && result.status === 'scanResult') {
          this._handleResult(result);
        }
      },
      (err) => {
        this._scanState = 'stopped';
        this.emit('scanError', err || {});
        this._scheduleRetry();
      },
      this._scanParams
    );
  }

  _stop() {
    const ble = this._bridge();
    this._scanState = 'stopping';
    const done = (error) => {
      this._scanState = 'stopped';
      this.emit('scanStopped', { error: error || null });
      this._reconcile();
    };
    // "Not scanning" errors land in the second callback — either way the
    // scan is not running afterwards.
    ble.stopScan(() => done(null), (err) => done(err));
  }

  _scheduleRetry() {
    if (!this._wantScan() || this._retryMs <= 0 || this._retryTimer !== null) {
      return;
    }
    this._retryTimer = this._setTimeout(() => {
      this._retryTimer = null;
      this._reconcile();
    }, this._retryMs);
  }

  _handleResult(result) {
    for (const [deviceType, detector] of this._detectors) {
      let info = null;
      try {
        info = detector(result);
      } catch (err) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[DeviceLink] detector "' + deviceType + '" threw:', err);
        }
        continue;
      }
      if (!info) {
        continue;
      }

      const id = info.id || result.address;
      const known = this._discovered.get(id);
      if (!known) {
        const entry = Object.assign({}, info);
        entry.id = id;
        entry.deviceType = info.deviceType || deviceType;
        if (entry.name === undefined) {
          entry.name = result.name || '';
        }
        if (entry.rssi === undefined) {
          entry.rssi = result.rssi !== undefined ? result.rssi : null;
        }
        entry.firstSeen = this._now();
        entry.lastSeen = entry.firstSeen;
        this._discovered.set(id, entry);
        this.emit('device', entry);
        for (const observer of this._observers.values()) {
          if (this._matches(observer, entry)) {
            this._safeCall(observer.onDevice, entry);
          }
        }
      } else {
        known.lastSeen = this._now();
        if (result.rssi !== undefined) {
          known.rssi = result.rssi;
        }
        for (const observer of this._observers.values()) {
          if (observer.onUpdate && this._matches(observer, known)) {
            this._safeCall(observer.onUpdate, known);
          }
        }
      }
      return; // first matching detector wins
    }
  }
}

module.exports = ScanManager;

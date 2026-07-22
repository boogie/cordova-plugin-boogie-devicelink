// Peripheral role convenience layer — the phone as a GATT server.
//
// The raw bluetoothle peripheral API is a single persistent callback fed
// with every event, plus callback-style one-shot actions. This wrapper turns
// it into promises and typed events, tracks who is connected and who is
// subscribed to what, decodes incoming values, and hands read/write requests
// to the app as request objects with respond()/error() helpers.
//
// UUIDs are normalized (16-bit aliases of the Bluetooth base UUID collapse
// to their short form, everything uppercased), so 'FF10' and
// '0000ff10-0000-1000-8000-00805f9b34fb' mean the same characteristic
// regardless of which platform reported it.
'use strict';

const Emitter = require('./emitter');
const OperationQueue = require('./operation_queue');
const Pacer = require('./pacer');
const normalizeUuid = require('./advertisement').normalizeUuid;

function toError(raw) {
  if (raw instanceof Error) {
    return raw;
  }
  const err = new Error((raw && (raw.message || raw.error)) || 'BLE error');
  err.raw = raw;
  return err;
}

class Peripheral extends Emitter {
  /**
   * @param {object} [opts]
   * @param {object} [opts.ble] bluetoothle-compatible bridge (defaults to
   *   window.bluetoothle, resolved lazily)
   * @param {Pacer} [opts.pacer] pace queued notifications…
   * @param {object} [opts.pace] …or Pacer options to build one
   * @param {number} [opts.readyTimeoutMs=5000] how long a queued notify waits
   *   for the TX queue to free up after a sent:false
   * @param {function} [opts.setTimeout] injectable timers for tests
   * @param {function} [opts.clearTimeout]
   */
  constructor(opts = {}) {
    super();
    this._ble = opts.ble || null;
    this._initialized = false;
    this._initPending = null;
    this._subscribers = new Map(); // 'SERVICE|CHARACTERISTIC' → Set<address>
    this._centrals = new Set();
    this._mtus = new Map();
    this._handlers = new Map(); // 'SERVICE|CHARACTERISTIC' → { onRead, onWrite }
    this._setTimeout = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = opts.clearTimeout || ((t) => clearTimeout(t));
    this._pacer = opts.pacer || (opts.pace ? new Pacer(opts.pace) : null);
    this._readyTimeoutMs = opts.readyTimeoutMs !== undefined ? opts.readyTimeoutMs : 5000;
    // Serializes queued notifications — reuse pause() during other radio work.
    this.notifyQueue = new OperationQueue({
      name: 'peripheral-notify',
      setTimeout: opts.setTimeout,
      clearTimeout: opts.clearTimeout
    });
  }

  _bridge() {
    const ble = this._ble || (typeof window !== 'undefined' ? window.bluetoothle : null);
    if (!ble) {
      throw new Error('no bluetoothle bridge available');
    }
    return ble;
  }

  get isInitialized() {
    return this._initialized;
  }

  /** Connected central addresses. */
  get centrals() {
    return [...this._centrals];
  }

  /** Negotiated MTU for a central, if the platform reported one. */
  mtuOf(address) {
    return this._mtus.get(address) || null;
  }

  /** Centrals currently subscribed to a characteristic. */
  subscribersOf(service, characteristic) {
    const set = this._subscribers.get(normalizeUuid(service) + '|' + normalizeUuid(characteristic));
    return set ? [...set] : [];
  }

  /**
   * Initialize the peripheral role. Resolves once the adapter reports
   * enabled; the underlying callback stays alive and feeds this instance's
   * events from then on. Idempotent.
   */
  initialize(params = {}) {
    if (this._initialized) {
      return Promise.resolve({ status: 'enabled' });
    }
    if (this._initPending) {
      return this._initPending;
    }
    const ble = this._bridge();
    this._initPending = new Promise((resolve, reject) => {
      ble.initializePeripheral((result) => {
        if (result && result.status === 'enabled') {
          if (!this._initialized) {
            this._initialized = true;
            resolve(result);
          }
          this.emit('enabled', result);
          return;
        }
        this._route(result || {});
      }, (err) => {
        if (!this._initialized) {
          this._initPending = null;
          reject(toError(err));
        } else {
          this.emit('error', toError(err));
        }
      }, Object.assign({ request: true }, params));
    });
    return this._initPending;
  }

  addService(params) {
    return this._call('addService', params);
  }

  removeService(service) {
    return this._call('removeService', { service });
  }

  removeAllServices() {
    return this._call('removeAllServices', {});
  }

  /**
   * Start advertising. Accepts `services` (array) and/or `service` (single)
   * and fills in whichever the platform expects; the timeout defaults to 0
   * (advertise until stopAdvertising).
   */
  startAdvertising(params = {}) {
    const merged = Object.assign({ timeout: 0 }, params);
    if (merged.services && !merged.service) {
      merged.service = merged.services[0];
    } else if (merged.service && !merged.services) {
      merged.services = [merged.service];
    }
    return this._call('startAdvertising', merged);
  }

  /** Stop advertising; an already-stopped state counts as success. */
  stopAdvertising() {
    return this._call('stopAdvertising', {}).catch((err) => {
      if (/already/i.test(err.message)) {
        return { status: 'advertisingStopped' };
      }
      throw err;
    });
  }

  isAdvertising() {
    return this._call('isAdvertising', {}).then((result) => !!(result && result.isAdvertising));
  }

  /**
   * Low-level response to a read/write request. `value` may be a string
   * (UTF-8) or a Uint8Array; `status` is an ATT status code (0 = success,
   * only honored where the platform supports error responses).
   */
  respond(params) {
    const out = {
      address: params.address,
      requestId: params.requestId,
      offset: params.offset || 0
    };
    const encoded = this._encode(params.value);
    if (encoded !== undefined) {
      out.value = encoded;
    }
    if (params.status !== undefined) {
      out.status = params.status;
    }
    return this._call('respond', out);
  }

  /** Send a notification/indication to one subscribed central. */
  notify(params) {
    return this._call('notify', {
      address: params.address,
      service: params.service,
      characteristic: params.characteristic,
      value: this._encode(params.value)
    });
  }

  /**
   * Register handlers for a characteristic — the "automatic respond" mode.
   * With onRead, read requests are answered with its return value (or an ATT
   * error if it throws); with onWrite, the decoded bytes are delivered and
   * the request is acked automatically when a response is needed. Handled
   * requests do NOT emit the generic readRequested/writeRequested events;
   * handler exceptions emit 'handlerError'.
   */
  handle(service, characteristic, handlers) {
    if (!handlers || (typeof handlers.onRead !== 'function' && typeof handlers.onWrite !== 'function')) {
      throw new TypeError('handlers must provide onRead and/or onWrite');
    }
    this._handlers.set(normalizeUuid(service) + '|' + normalizeUuid(characteristic), handlers);
  }

  unhandle(service, characteristic) {
    return this._handlers.delete(normalizeUuid(service) + '|' + normalizeUuid(characteristic));
  }

  /**
   * Notify through the peripheral's OperationQueue: sends are serialized, an
   * optional Pacer spaces them, and a sent:false (TX queue full) waits for
   * notificationReady and retries once. Accepts the OperationQueue op options
   * (priority, timeoutMs, retries).
   */
  queueNotify(params, opts = {}) {
    return this.notifyQueue.enqueue({
      name: 'notify:' + normalizeUuid(params.characteristic),
      priority: opts.priority || 'normal',
      timeoutMs: opts.timeoutMs,
      retries: opts.retries,
      run: () => this._pacedNotify(params)
    });
  }

  async _pacedNotify(params) {
    const bytes = typeof params.value === 'string'
      ? new TextEncoder().encode(params.value)
      : (params.value || new Uint8Array(0));
    if (this._pacer) {
      const delay = this._pacer.delayFor(bytes.length);
      if (delay > 0) {
        await new Promise((resolve) => this._setTimeout(resolve, delay));
      }
    }
    let result = await this.notify(params);
    if (result && result.sent === false) {
      await this._waitForReady();
      result = await this.notify(params);
    }
    if (this._pacer) {
      this._pacer.onSent(bytes.length);
    }
    return result;
  }

  _waitForReady() {
    return new Promise((resolve, reject) => {
      let timer = null;
      const off = this.once('notificationReady', () => {
        if (timer !== null) {
          this._clearTimeout(timer);
        }
        resolve();
      });
      if (this._readyTimeoutMs > 0) {
        timer = this._setTimeout(() => {
          off();
          const err = new Error('TX queue did not free up within ' + this._readyTimeoutMs + 'ms');
          err.code = 'ETIMEDOUT';
          reject(err);
        }, this._readyTimeoutMs);
      }
    });
  }

  /**
   * Notify every central subscribed to the characteristic, sequentially.
   * Individual failures don't stop the rest; returns { sent, failed }.
   */
  async notifyAll(params) {
    const addresses = this.subscribersOf(params.service, params.characteristic);
    const failed = [];
    let sent = 0;
    for (const address of addresses) {
      try {
        await this.notify({
          address,
          service: params.service,
          characteristic: params.characteristic,
          value: params.value
        });
        sent++;
      } catch (err) {
        failed.push({ address, error: err });
      }
    }
    return { sent, failed };
  }

  // --- internals ---

  _call(method, params) {
    const ble = this._bridge();
    return new Promise((resolve, reject) => {
      ble[method]((result) => resolve(result), (err) => reject(toError(err)), params);
    });
  }

  _encode(value) {
    if (value === undefined || value === null) {
      return undefined;
    }
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    return this._bridge().bytesToEncodedString(bytes);
  }

  _charKey(result) {
    return normalizeUuid(result.service) + '|' + normalizeUuid(result.characteristic);
  }

  _route(result) {
    switch (result.status) {
      case 'connected':
        this._centrals.add(result.address);
        this.emit('connected', { address: result.address, name: result.name || null });
        break;
      case 'disconnected': {
        this._centrals.delete(result.address);
        this._mtus.delete(result.address);
        for (const set of this._subscribers.values()) {
          set.delete(result.address);
        }
        this.emit('disconnected', { address: result.address });
        break;
      }
      case 'subscribed': {
        const key = this._charKey(result);
        let set = this._subscribers.get(key);
        if (!set) {
          set = new Set();
          this._subscribers.set(key, set);
        }
        set.add(result.address);
        this.emit('subscribed', {
          address: result.address,
          service: normalizeUuid(result.service),
          characteristic: normalizeUuid(result.characteristic)
        });
        break;
      }
      case 'unsubscribed': {
        const set = this._subscribers.get(this._charKey(result));
        if (set) {
          set.delete(result.address);
        }
        this.emit('unsubscribed', {
          address: result.address,
          service: normalizeUuid(result.service),
          characteristic: normalizeUuid(result.characteristic)
        });
        break;
      }
      case 'readRequested': {
        const request = this._request(result, false);
        const handler = this._handlers.get(request.service + '|' + request.characteristic);
        if (handler && typeof handler.onRead === 'function') {
          this._autoRead(handler, request);
        } else {
          this.emit('readRequested', request);
        }
        break;
      }
      case 'writeRequested': {
        const request = this._request(result, true);
        const handler = this._handlers.get(request.service + '|' + request.characteristic);
        if (handler && typeof handler.onWrite === 'function') {
          this._autoWrite(handler, request);
        } else {
          this.emit('writeRequested', request);
        }
        break;
      }
      case 'mtuChanged':
        this._mtus.set(result.address, result.mtu);
        this.emit('mtuChanged', { address: result.address, mtu: result.mtu });
        break;
      case 'notificationSent':
        this.emit('notificationSent', { address: result.address });
        break;
      case 'notificationReady':
        this.emit('notificationReady', { address: result.address });
        break;
      default:
        this.emit('peripheralEvent', result);
    }
  }

  async _autoRead(handler, request) {
    try {
      const value = await handler.onRead(request);
      await request.respond(value);
    } catch (err) {
      try {
        await request.error(0x80);
      } catch (ignored) { /* the central may be gone already */ }
      this.emit('handlerError', { characteristic: request.characteristic, error: err });
    }
  }

  async _autoWrite(handler, request) {
    try {
      await handler.onWrite(request.value, request);
      if (request.responseNeeded) {
        await request.respond();
      }
    } catch (err) {
      if (request.responseNeeded) {
        try {
          await request.error(0x80);
        } catch (ignored) { /* the central may be gone already */ }
      }
      this.emit('handlerError', { characteristic: request.characteristic, error: err });
    }
  }

  _request(result, isWrite) {
    const address = result.address;
    const requestId = result.requestId;
    const offset = result.offset || 0;
    const request = {
      address,
      requestId,
      offset,
      service: normalizeUuid(result.service),
      characteristic: normalizeUuid(result.characteristic),
      /** Answer with a value (reads) or an ack (writes). */
      respond: (value) => this.respond({ address, requestId, offset, value }),
      /** Answer with an ATT error (default 0x80, application error). */
      error: (status) => this.respond({
        address, requestId, offset,
        status: status === undefined ? 0x80 : status
      })
    };
    if (isWrite) {
      request.value = result.value
        ? this._bridge().encodedStringToBytes(result.value)
        : new Uint8Array(0);
      request.responseNeeded = result.responseNeeded !== false;
    }
    return request;
  }
}

Peripheral.normalizeUuid = normalizeUuid;

module.exports = Peripheral;

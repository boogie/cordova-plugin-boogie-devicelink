// Device base class — one instance is one device connection.
//
// A concrete device class (an e-ink display, an LCD display, a drawing
// tablet…) extends Device with a declarative profile and its own methods;
// the base class owns everything generic: the connection state machine, the
// per-device operation queue, the connect pipeline (discover → configure →
// ready), notification routing, disconnect reasons and reconnect policy.
//
// The pipeline runs every step through the OperationQueue at critical
// priority, so each step gets a timeout and retries — no setTimeout chains.
'use strict';

const Emitter = require('./emitter');
const DeviceStateMachine = require('./state_machine');
const OperationQueue = require('./operation_queue');
const CapabilityRegistry = require('./capabilities');

const RECONNECT_POLICIES = ['none', 'onUnexpectedDisconnect', 'remembered'];
const STEP_ACTIONS = ['subscribe', 'read', 'write', 'wait', 'custom'];

function fail(msg) {
  const err = new Error('invalid profile: ' + msg);
  err.code = 'EBADPROFILE';
  throw err;
}

function validateProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    fail('not an object');
  }
  if (!profile.deviceType || typeof profile.deviceType !== 'string') {
    fail('deviceType is required');
  }
  const characteristics = profile.characteristics || {};
  for (const key of Object.keys(characteristics)) {
    const cfg = characteristics[key];
    if (!cfg || !cfg.service || !cfg.characteristic) {
      fail('characteristic "' + key + '" needs service and characteristic');
    }
  }
  const reconnect = (profile.connection || {}).reconnect;
  if (reconnect && RECONNECT_POLICIES.indexOf(reconnect.policy) < 0) {
    fail('unknown reconnect policy: ' + reconnect.policy);
  }
  for (const step of profile.onConnect || []) {
    if (!step || STEP_ACTIONS.indexOf(step.action) < 0) {
      fail('onConnect step with unknown action: ' + (step && step.action));
    }
    if (['subscribe', 'read', 'write'].indexOf(step.action) >= 0 && !characteristics[step.target]) {
      fail('step "' + step.action + '" targets unknown characteristic "' + step.target + '"');
    }
    if (step.action === 'custom' && typeof step.run !== 'function') {
      fail('custom step needs a run() function');
    }
    if (step.action === 'wait' && !(step.ms > 0)) {
      fail('wait step needs a positive ms');
    }
  }
  return profile;
}

function toError(raw) {
  if (raw instanceof Error) {
    return raw;
  }
  const err = new Error((raw && (raw.message || raw.error)) || 'BLE error');
  err.raw = raw;
  return err;
}

class Device extends Emitter {
  /**
   * @param {object} opts
   * @param {object} opts.profile declarative device profile
   * @param {object} [opts.ble] bluetoothle-compatible bridge (defaults to
   *   window.bluetoothle, resolved lazily)
   * @param {ScanManager} [opts.scanManager] used for transfer holds
   * @param {CapabilityRegistry} [opts.capabilities] registry to validate
   *   declared capabilities against (defaults to the built-in registry)
   * @param {function} [opts.setTimeout] injectable timers for tests
   * @param {function} [opts.clearTimeout]
   * @param {function} [opts.now=Date.now]
   */
  constructor(opts = {}) {
    super();
    this.profile = validateProfile(opts.profile);
    this._ble = opts.ble || null;
    this.scanManager = opts.scanManager || null;
    this._setTimeout = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = opts.clearTimeout || ((t) => clearTimeout(t));
    this._now = opts.now || Date.now;

    this.id = null;
    this.name = null;

    this._sm = new DeviceStateMachine({ now: this._now });
    this._sm.on('change', (entry) => {
      this.emit('connectionStateChanged', {
        state: entry.to,
        from: entry.from,
        reason: entry.to === 'disconnected' ? this._sm.disconnectReason : null
      });
    });

    this.queue = new OperationQueue({
      name: this.profile.deviceType,
      setTimeout: opts.setTimeout,
      clearTimeout: opts.clearTimeout
    });

    this._reconnectTimer = null;
    this._reconnectAttempt = 0;
    this._userDisconnected = false;

    // Protocol conformance: every capability this profile declares must be
    // implemented by the concrete class. Fails at construction, not mid-use.
    const registry = opts.capabilities || CapabilityRegistry.default;
    registry.validate(this.profile.capabilities || [], this);
  }

  _bridge() {
    const ble = this._ble || (typeof window !== 'undefined' ? window.bluetoothle : null);
    if (!ble) {
      throw new Error('no bluetoothle bridge available');
    }
    return ble;
  }

  get state() {
    return this._sm.state;
  }

  get isReady() {
    return this._sm.isReady;
  }

  get disconnectReason() {
    return this._sm.disconnectReason;
  }

  get capabilities() {
    return (this.profile.capabilities || []).slice();
  }

  has(capability) {
    return (this.profile.capabilities || []).indexOf(capability) >= 0;
  }

  /**
   * Connect and run the full pipeline; resolves when the device is READY —
   * discovered, configured, subscribed — not merely link-connected.
   */
  async connect(target = {}) {
    if (target.id) {
      this.id = target.id;
      this.name = target.name || this.name;
    }
    if (!this.id) {
      throw new Error('no device identity to connect to');
    }
    this._userDisconnected = false;
    this._cancelReconnect();
    this._sm.transition('connecting');
    try {
      await this._establish();
      await this._runPipeline();
    } catch (err) {
      // An explicit connect() failure surfaces to the caller and does NOT
      // auto-retry — the reconnect policy is about recovering a link that
      // was working, not about retrying a connect the caller is awaiting.
      this._cancelReconnect();
      await this._teardown();
      const reason = err && err.code === 'ETIMEDOUT' ? 'connectionTimeout' : 'gattError';
      this._toDisconnected(reason);
      throw err;
    }
    return this;
  }

  /** User-requested disconnect: never triggers a reconnect. */
  async disconnect() {
    this._userDisconnected = true;
    this._cancelReconnect();
    this.queue.clear('userRequested');
    const state = this._sm.state;
    if (state === 'unknown' || state === 'discovered' || state === 'disconnected' || state === 'failed') {
      return;
    }
    if (state === 'reconnectWaiting') {
      this._sm.transition('disconnected', { reason: 'userRequested' });
      return;
    }
    if (this._sm.canTransition('disconnecting')) {
      this._sm.transition('disconnecting');
    }
    await this._closeNative();
    this._toDisconnected('userRequested');
  }

  /** Write to a named characteristic through the queue. */
  write(target, data, opts = {}) {
    const guard = this._operationalGuard('write');
    if (guard) {
      return guard;
    }
    const cfg = this.profile.characteristics[target];
    if (!cfg) {
      return Promise.reject(Object.assign(new Error('unknown characteristic: ' + target), { code: 'EBADTARGET' }));
    }
    return this.queue.enqueue({
      name: 'write:' + target,
      priority: opts.priority || 'normal',
      timeoutMs: opts.timeoutMs,
      retries: opts.retries,
      run: () => this._nativeWrite(cfg, data)
    });
  }

  /** Read a named characteristic through the queue; value is also routed to
   *  the characteristic's onData handler and the 'data' event. */
  read(target, opts = {}) {
    const guard = this._operationalGuard('read');
    if (guard) {
      return guard;
    }
    const cfg = this.profile.characteristics[target];
    if (!cfg) {
      return Promise.reject(Object.assign(new Error('unknown characteristic: ' + target), { code: 'EBADTARGET' }));
    }
    return this.queue.enqueue({
      name: 'read:' + target,
      priority: opts.priority || 'normal',
      timeoutMs: opts.timeoutMs,
      retries: opts.retries,
      run: () => this._nativeRead(target, cfg)
    });
  }

  _operationalGuard(what) {
    const state = this._sm.state;
    if (state !== 'ready' && state !== 'configuring' && state !== 'updatingFirmware') {
      const err = new Error('cannot ' + what + ' while ' + state);
      err.code = 'ENOTREADY';
      return Promise.reject(err);
    }
    return null;
  }

  // --- connection pipeline ---

  _establish() {
    const connection = this.profile.connection || {};
    return this.queue.enqueue({
      name: 'connect',
      priority: 'critical',
      timeoutMs: connection.connectTimeoutMs !== undefined ? connection.connectTimeoutMs : 15000,
      run: () => new Promise((resolve, reject) => {
        let established = false;
        this._bridge().connect((result) => {
          if (result && result.status === 'connected') {
            if (!established) {
              established = true;
              resolve(result);
            }
          } else if (result && result.status === 'disconnected') {
            if (!established) {
              reject(Object.assign(new Error('disconnected during connect'), { code: 'EDISCONNECTED' }));
            } else {
              this._handleUnexpectedDisconnect('gattError');
            }
          }
        }, (err) => {
          if (!established) {
            reject(toError(err));
          } else {
            this._handleUnexpectedDisconnect('gattError');
          }
        }, { address: this.id });
      })
    });
  }

  async _runPipeline() {
    const connection = this.profile.connection || {};
    this._sm.transition('discovering');
    await this.queue.enqueue({
      name: 'discover',
      priority: 'critical',
      timeoutMs: connection.discoverTimeoutMs !== undefined ? connection.discoverTimeoutMs : 10000,
      run: () => new Promise((resolve, reject) => {
        this._bridge().discover(resolve, (err) => reject(toError(err)), { address: this.id });
      })
    });
    this._sm.transition('configuring');
    for (const step of this.profile.onConnect || []) {
      await this._runStep(step);
    }
    this._reconnectAttempt = 0;
    this._sm.transition('ready');
    this.emit('ready', { id: this.id, name: this.name });
  }

  _runStep(step) {
    const label = step.action + (step.target ? ':' + step.target : '');
    const promise = this.queue.enqueue({
      name: 'setup:' + label,
      priority: 'critical',
      timeoutMs: step.timeoutMs,
      retries: step.retries,
      run: () => this._executeStep(step)
    });
    if (step.optional) {
      return promise.catch((err) => {
        this.emit('stepWarning', { step: label, error: err });
      });
    }
    return promise;
  }

  _executeStep(step) {
    const cfg = step.target ? this.profile.characteristics[step.target] : null;
    switch (step.action) {
      case 'subscribe':
        return this._nativeSubscribe(step.target, cfg);
      case 'read':
        return this._nativeRead(step.target, cfg);
      case 'write':
        return this._nativeWrite(cfg, step.data);
      case 'wait':
        return new Promise((resolve) => this._setTimeout(resolve, step.ms));
      case 'custom':
        return step.run(this);
      /* istanbul ignore next: validateProfile rejects unknown actions */
      default:
        throw Object.assign(new Error('unknown step action: ' + step.action), { code: 'EBADSTEP' });
    }
  }

  // --- native wrappers ---

  _nativeSubscribe(target, cfg) {
    const ble = this._bridge();
    return new Promise((resolve, reject) => {
      ble.subscribe((result) => {
        if (result && result.status === 'subscribed') {
          resolve(result);
        } else if (result && result.status === 'subscribedResult') {
          this._dispatchValue(target, result.value, 'notification');
        }
      }, (err) => {
        if (err && err.message === 'Already subscribed') {
          resolve({ status: 'subscribed' });
        } else {
          reject(toError(err));
        }
      }, { address: this.id, service: cfg.service, characteristic: cfg.characteristic });
    });
  }

  _nativeRead(target, cfg) {
    const ble = this._bridge();
    return new Promise((resolve, reject) => {
      ble.read((result) => {
        this._dispatchValue(target, result.value, 'read');
        resolve(result);
      }, (err) => reject(toError(err)), {
        address: this.id, service: cfg.service, characteristic: cfg.characteristic
      });
    });
  }

  _nativeWrite(cfg, data) {
    const ble = this._bridge();
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const params = {
      address: this.id,
      service: cfg.service,
      characteristic: cfg.characteristic,
      value: ble.bytesToEncodedString(bytes)
    };
    if (cfg.writeType === 'noResponse') {
      params.type = 'noResponse';
    }
    return new Promise((resolve, reject) => {
      ble.write(resolve, (err) => reject(toError(err)), params);
    });
  }

  _dispatchValue(target, encoded, source) {
    let bytes;
    try {
      bytes = encoded ? this._bridge().encodedStringToBytes(encoded) : new Uint8Array(0);
    } catch (err) {
      bytes = new Uint8Array(0);
    }
    const cfg = this.profile.characteristics[target];
    if (cfg && typeof cfg.onData === 'function') {
      try {
        cfg.onData(this, bytes, source);
      } catch (err) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[DeviceLink] onData handler for "' + target + '" threw:', err);
        }
      }
    }
    this.emit('data', { target, bytes, source });
  }

  // --- disconnect & reconnect ---

  _handleUnexpectedDisconnect(reason) {
    if (this._userDisconnected) {
      return;
    }
    const state = this._sm.state;
    if (state === 'disconnected' || state === 'disconnecting') {
      return;
    }
    this.queue.clear('disconnected');
    this._toDisconnected(reason || 'gattError');
    this._closeNative();
    this._maybeScheduleReconnect();
  }

  _toDisconnected(reason) {
    if (this._sm.canTransition('disconnected')) {
      this._sm.transition('disconnected', { reason });
    }
  }

  _maybeScheduleReconnect() {
    const reconnect = (this.profile.connection || {}).reconnect;
    if (!reconnect || reconnect.policy === 'none' || this._userDisconnected) {
      return;
    }
    if (!this._sm.canTransition('reconnectWaiting')) {
      return;
    }
    this._sm.transition('reconnectWaiting');
    const attempt = this._reconnectAttempt++;
    const initial = reconnect.initialDelayMs !== undefined ? reconnect.initialDelayMs : 1000;
    const factor = reconnect.factor !== undefined ? reconnect.factor : 2;
    const max = reconnect.maxDelayMs !== undefined ? reconnect.maxDelayMs : 30000;
    const delay = Math.min(max, initial * Math.pow(factor, attempt));
    this.emit('reconnectScheduled', { attempt: attempt + 1, delayMs: delay });
    this._reconnectTimer = this._setTimeout(() => {
      this._reconnectTimer = null;
      this._attemptReconnect();
    }, delay);
  }

  async _attemptReconnect() {
    if (this._userDisconnected || this._sm.state !== 'reconnectWaiting') {
      return;
    }
    this._sm.transition('reconnecting');
    try {
      await this._establish();
      await this._runPipeline();
    } catch (err) {
      await this._teardown();
      this._toDisconnected(err && err.code === 'ETIMEDOUT' ? 'connectionTimeout' : 'gattError');
      this._maybeScheduleReconnect();
    }
  }

  _cancelReconnect() {
    if (this._reconnectTimer !== null) {
      this._clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  async _teardown() {
    this.queue.clear('teardown');
    await this._closeNative();
  }

  _closeNative() {
    if (!this.id) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      try {
        this._bridge().close(resolve, resolve, { address: this.id });
      } catch (err) {
        resolve();
      }
    });
  }
}

Device.validateProfile = validateProfile;
Device.RECONNECT_POLICIES = RECONNECT_POLICIES;

module.exports = Device;

// Explicit per-device connection state machine.
//
// The central idea: a BLE link being up ("connected" in GATT terms) is NOT the
// same as the device being usable. Between the two sit service discovery,
// subscriptions, MTU negotiation, and the device's own init handshake — so this
// machine has no bare "connected" state at all: the link-up phase is split into
// discovering → configuring → ready, and application code should wait for ready.
'use strict';

const Emitter = require('./emitter');

const STATES = [
  'unknown',
  'discovered',
  'connecting',
  'discovering',
  'configuring',
  'ready',
  'updatingFirmware',
  'disconnecting',
  'disconnected',
  'reconnectWaiting',
  'reconnecting',
  'failed'
];

// Which states each state may move to. Anything else is a programming error
// and throws, so broken sequencing surfaces in development instead of as a
// silent stuck connection in the field.
const TRANSITIONS = {
  unknown: ['discovered', 'connecting'],
  discovered: ['connecting'],
  connecting: ['discovering', 'disconnected', 'failed'],
  discovering: ['configuring', 'disconnected', 'failed'],
  configuring: ['ready', 'disconnected', 'failed'],
  ready: ['updatingFirmware', 'disconnecting', 'disconnected'],
  updatingFirmware: ['ready', 'disconnecting', 'disconnected', 'failed'],
  disconnecting: ['disconnected'],
  disconnected: ['connecting', 'reconnectWaiting', 'discovered'],
  reconnectWaiting: ['reconnecting', 'disconnected'],
  reconnecting: ['discovering', 'reconnectWaiting', 'disconnected', 'failed'],
  failed: ['connecting', 'discovered', 'disconnected']
};

// Why the device disconnected. Reconnect policy decisions key off this —
// e.g. userRequested must never trigger a reconnect, while firmwareReboot is
// a transient state rather than an error.
const DISCONNECT_REASONS = [
  'userRequested',
  'deviceOutOfRange',
  'bluetoothDisabled',
  'permissionLost',
  'connectionTimeout',
  'gattError',
  'appShutdown',
  'firmwareReboot',
  'unknown'
];

class DeviceStateMachine extends Emitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.initial='unknown']
   * @param {number} [opts.historyLimit=32] transitions kept for diagnostics
   * @param {function} [opts.now=Date.now] injectable clock for tests
   */
  constructor(opts = {}) {
    super();
    const initial = opts.initial || 'unknown';
    if (STATES.indexOf(initial) < 0) {
      throw new RangeError('unknown state: ' + initial);
    }
    this._state = initial;
    this._seq = 0;
    this._history = [];
    this._historyLimit = opts.historyLimit || 32;
    this._now = opts.now || Date.now;
    // Kept until the next disconnect so late readers (UI, diagnostics) still
    // see why the last link ended.
    this.disconnectReason = null;
  }

  get state() {
    return this._state;
  }

  is(state) {
    return this._state === state;
  }

  get isReady() {
    return this._state === 'ready';
  }

  canTransition(to) {
    return (TRANSITIONS[this._state] || []).indexOf(to) >= 0;
  }

  /**
   * Move to a new state. Emits a 'change' event with
   * { seq, at, from, to, meta }. Throws on an illegal transition
   * (code EINVALIDTRANSITION) or an unknown disconnect reason (EBADREASON).
   *
   * When entering 'disconnected', meta.reason (one of DISCONNECT_REASONS,
   * default 'unknown') is recorded as this.disconnectReason.
   */
  transition(to, meta = {}) {
    if (STATES.indexOf(to) < 0) {
      throw new RangeError('unknown state: ' + to);
    }
    if (!this.canTransition(to)) {
      const err = new Error('invalid transition: ' + this._state + ' -> ' + to);
      err.code = 'EINVALIDTRANSITION';
      throw err;
    }
    if (to === 'disconnected') {
      const reason = meta.reason === undefined ? 'unknown' : meta.reason;
      if (DISCONNECT_REASONS.indexOf(reason) < 0) {
        const err = new Error('unknown disconnect reason: ' + reason);
        err.code = 'EBADREASON';
        throw err;
      }
      this.disconnectReason = reason;
    }
    const entry = {
      seq: ++this._seq,
      at: this._now(),
      from: this._state,
      to,
      meta
    };
    this._state = to;
    this._history.push(entry);
    if (this._history.length > this._historyLimit) {
      this._history.shift();
    }
    this.emit('change', entry);
    return entry;
  }

  /** Copy of the recorded transitions (capped at historyLimit). */
  get history() {
    return this._history.slice();
  }
}

DeviceStateMachine.STATES = STATES;
DeviceStateMachine.TRANSITIONS = TRANSITIONS;
DeviceStateMachine.DISCONNECT_REASONS = DISCONNECT_REASONS;

module.exports = DeviceStateMachine;

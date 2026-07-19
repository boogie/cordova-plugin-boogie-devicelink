// Chunked bulk transfer (images, drawings, firmware) with pluggable flow
// control:
//
// - 'ack': the device acknowledges chunks, so up to windowSize chunks may be
//   in flight; the device class calls transfer.ack() whenever the device
//   signals, and the window slides. Throughput adapts to the device.
// - 'pace': the device gives no feedback. Chunks leave on a Pacer schedule —
//   fast enough to keep the phone's TX buffer topped up, never faster than
//   the device's receive buffer drains.
//
// The transfer does not talk to BLE itself: the caller provides send(),
// which typically enqueues a write on the device's OperationQueue. Resume
// (e.g. after a firmware reboot) is startIndex.
'use strict';

const Emitter = require('./emitter');
const Pacer = require('./pacer');

class BulkTransfer extends Emitter {
  /**
   * @param {object} opts
   * @param {function} opts.send async (chunk, index) => void
   * @param {Uint8Array[]} [opts.chunks] pre-split chunks…
   * @param {Uint8Array} [opts.data] …or raw data plus chunkSize
   * @param {number} [opts.chunkSize=20]
   * @param {string} [opts.flow='pace'] 'pace' | 'ack'
   * @param {Pacer} [opts.pacer] pace flow: an existing pacer…
   * @param {object} [opts.pace] …or Pacer options to build one
   * @param {number} [opts.windowSize=1] ack flow: max un-acked chunks in flight
   * @param {number} [opts.ackTimeoutMs=5000] ack flow: 0 disables
   * @param {number} [opts.startIndex=0] resume point
   * @param {function} [opts.setTimeout] injectable timers for tests
   * @param {function} [opts.clearTimeout]
   */
  constructor(opts = {}) {
    super();
    if (typeof opts.send !== 'function') {
      throw new TypeError('opts.send must be a function');
    }
    if (opts.chunks) {
      this._chunks = opts.chunks;
    } else if (opts.data) {
      this._chunks = BulkTransfer.split(opts.data, opts.chunkSize || 20);
    } else {
      throw new TypeError('either chunks or data is required');
    }
    this._send = opts.send;
    this._flow = opts.flow || 'pace';
    if (this._flow === 'pace') {
      this._pacer = opts.pacer || (opts.pace ? new Pacer(opts.pace) : null);
      if (!this._pacer) {
        throw new TypeError("flow 'pace' needs a pacer or pace options");
      }
    } else if (this._flow === 'ack') {
      this._window = opts.windowSize || 1;
      this._ackTimeoutMs = opts.ackTimeoutMs !== undefined ? opts.ackTimeoutMs : 5000;
    } else {
      throw new RangeError('unknown flow: ' + this._flow);
    }
    this._startIndex = opts.startIndex || 0;
    this._setTimeout = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = opts.clearTimeout || ((t) => clearTimeout(t));
    this._sentCount = this._startIndex;
    this._ackedCount = this._startIndex;
    this._pendingAcks = 0;
    this._ackWaiter = null;
    this._ackTimer = null;
    this._sleepWaiter = null;
    this._abortError = null;
    this._started = false;
  }

  /** Split raw data into transfer chunks. */
  static split(data, chunkSize) {
    if (!(chunkSize > 0)) {
      throw new RangeError('chunkSize must be > 0');
    }
    const out = [];
    for (let i = 0; i < data.length; i += chunkSize) {
      out.push(data.subarray ? data.subarray(i, i + chunkSize) : data.slice(i, i + chunkSize));
    }
    return out;
  }

  get progress() {
    return {
      sent: this._sentCount,
      acked: this._flow === 'ack' ? this._ackedCount : null,
      total: this._chunks.length
    };
  }

  /**
   * Ack flow only: the device acknowledged `count` chunks. Safe to call from
   * a notification handler at any time — acks arriving while the send loop
   * is busy are banked, not lost.
   */
  ack(count = 1) {
    if (this._ackWaiter) {
      const waiter = this._ackWaiter;
      this._ackWaiter = null;
      this._clearAckTimer();
      waiter.resolve(count);
    } else {
      this._pendingAcks += count;
    }
  }

  /** Stop the transfer; start()'s promise rejects with code EABORTED. */
  abort(reason) {
    if (this._abortError) {
      return;
    }
    const err = new Error('transfer aborted' + (reason ? ': ' + reason : ''));
    err.code = 'EABORTED';
    this._abortError = err;
    if (this._ackWaiter) {
      const waiter = this._ackWaiter;
      this._ackWaiter = null;
      this._clearAckTimer();
      waiter.reject(err);
    }
    if (this._sleepWaiter) {
      const waiter = this._sleepWaiter;
      this._sleepWaiter = null;
      waiter.reject(err);
    }
    this.emit('aborted', { reason: reason || null });
  }

  async start() {
    if (this._started) {
      throw new Error('transfer already started');
    }
    this._started = true;
    if (this._flow === 'pace') {
      await this._runPaced();
    } else {
      await this._runAcked();
    }
    this.emit('done', this.progress);
    return this.progress;
  }

  _checkAbort() {
    if (this._abortError) {
      throw this._abortError;
    }
  }

  async _runPaced() {
    for (let i = this._startIndex; i < this._chunks.length; i++) {
      this._checkAbort();
      const chunk = this._chunks[i];
      const delay = this._pacer.delayFor(chunk.length);
      if (delay > 0) {
        await this._sleep(delay);
      }
      this._checkAbort();
      await this._send(chunk, i);
      this._pacer.onSent(chunk.length);
      this._sentCount = i + 1;
      this.emit('progress', this.progress);
    }
  }

  async _runAcked() {
    let next = this._startIndex;
    let inFlight = 0;
    while (this._ackedCount < this._chunks.length) {
      this._checkAbort();
      while (inFlight < this._window && next < this._chunks.length) {
        const i = next++;
        await this._send(this._chunks[i], i);
        this._checkAbort();
        inFlight++;
        this._sentCount = next;
        this.emit('progress', this.progress);
      }
      if (this._ackedCount >= this._chunks.length) {
        break;
      }
      const got = await this._waitForAck();
      inFlight = Math.max(0, inFlight - got);
      this._ackedCount = Math.min(this._chunks.length, this._ackedCount + got);
      this.emit('progress', this.progress);
    }
  }

  _waitForAck() {
    if (this._pendingAcks > 0) {
      const banked = this._pendingAcks;
      this._pendingAcks = 0;
      return Promise.resolve(banked);
    }
    return new Promise((resolve, reject) => {
      this._ackWaiter = { resolve, reject };
      if (this._ackTimeoutMs > 0) {
        this._ackTimer = this._setTimeout(() => {
          this._ackTimer = null;
          if (this._ackWaiter) {
            const waiter = this._ackWaiter;
            this._ackWaiter = null;
            const err = new Error('no ack within ' + this._ackTimeoutMs + 'ms');
            err.code = 'ETIMEDOUT';
            waiter.reject(err);
          }
        }, this._ackTimeoutMs);
      }
    });
  }

  _clearAckTimer() {
    if (this._ackTimer !== null) {
      this._clearTimeout(this._ackTimer);
      this._ackTimer = null;
    }
  }

  _sleep(ms) {
    return new Promise((resolve, reject) => {
      const timer = this._setTimeout(() => {
        this._sleepWaiter = null;
        resolve();
      }, ms);
      this._sleepWaiter = {
        reject: (err) => {
          this._clearTimeout(timer);
          reject(err);
        }
      };
    });
  }
}

module.exports = BulkTransfer;

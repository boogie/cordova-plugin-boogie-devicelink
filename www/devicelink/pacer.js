// Feedback-less flow control for bulk transfers ("pace").
//
// Some devices acknowledge image/drawing/firmware chunks, so throughput can
// adapt to the device (ack-driven flow control — the transfer engine's job).
// Others give no feedback at all: chunks must leave at a rate that keeps the
// phone's BLE TX buffer topped up but never overfills it, and never overruns
// the device's receive buffer. The Pacer models that as a token bucket:
// capacity burstBytes (what the receiving side can absorb at once) refilling
// at bytesPerSecond (its sustained drain rate), plus an optional minimum gap
// between packets for devices that need breathing room regardless of
// throughput.
//
// Purely computational and clock-injectable — the caller asks how long to
// wait before each chunk and reports what it actually sent.
'use strict';

class Pacer {
  /**
   * @param {object} opts
   * @param {number} opts.bytesPerSecond sustained drain rate of the slowest
   *   buffer in the chain
   * @param {number} [opts.burstBytes=bytesPerSecond] bucket capacity — how
   *   much may be in flight at once
   * @param {number} [opts.minGapMs=0] minimum time between two sends
   * @param {function} [opts.now=Date.now] injectable clock
   */
  constructor(opts = {}) {
    if (!(opts.bytesPerSecond > 0)) {
      throw new RangeError('bytesPerSecond must be > 0');
    }
    this._rate = opts.bytesPerSecond;
    this._capacity = opts.burstBytes !== undefined ? opts.burstBytes : opts.bytesPerSecond;
    if (!(this._capacity > 0)) {
      throw new RangeError('burstBytes must be > 0');
    }
    this._minGapMs = opts.minGapMs || 0;
    this._now = opts.now || Date.now;
    this._credit = this._capacity;
    this._lastRefill = this._now();
    this._lastSend = -Infinity;
  }

  _refill() {
    const now = this._now();
    const elapsed = now - this._lastRefill;
    if (elapsed > 0) {
      this._credit = Math.min(this._capacity, this._credit + (elapsed / 1000) * this._rate);
      this._lastRefill = now;
    }
    return now;
  }

  /**
   * Milliseconds to wait before a chunk of `size` bytes may be sent
   * (0 = send now). Chunks larger than burstBytes are allowed — they drive
   * the credit negative and later chunks pay the debt off.
   */
  delayFor(size) {
    const now = this._refill();
    let delay = 0;
    if (size > this._credit) {
      delay = ((size - this._credit) / this._rate) * 1000;
    }
    if (this._minGapMs > 0) {
      const sinceLast = now - this._lastSend;
      if (sinceLast < this._minGapMs) {
        delay = Math.max(delay, this._minGapMs - sinceLast);
      }
    }
    return Math.ceil(delay);
  }

  /** Record that `size` bytes were handed to the stack. */
  onSent(size) {
    this._refill();
    this._credit -= size;
    this._lastSend = this._now();
  }

  /** Currently available credit in bytes (negative while paying off debt). */
  get credit() {
    this._refill();
    return this._credit;
  }
}

module.exports = Pacer;

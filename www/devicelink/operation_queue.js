// Serial, prioritized operation queue — one per device.
//
// Android tolerates exactly one in-flight GATT operation per connection, so
// everything (subscribe, read, write, MTU) funnels through here. Priorities
// let a performer-critical write jump ahead of a background battery poll, but
// a running operation is never preempted: preemption mid-write is how
// firmware transfers get corrupted.
//
// A timed-out attempt cannot cancel the underlying native call — its late
// result is simply ignored (each attempt settles at most once).
'use strict';

const Emitter = require('./emitter');

const PRIORITIES = ['critical', 'normal', 'background'];

class OperationQueue extends Emitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.name='queue'] used in error messages and events
   * @param {number} [opts.defaultTimeoutMs=10000] 0 disables the timeout
   * @param {number} [opts.defaultRetries=0] extra attempts after a failure/timeout
   * @param {function} [opts.setTimeout] injectable timer for tests
   * @param {function} [opts.clearTimeout] injectable timer for tests
   */
  constructor(opts = {}) {
    super();
    this.name = opts.name || 'queue';
    this._defaultTimeoutMs = opts.defaultTimeoutMs !== undefined ? opts.defaultTimeoutMs : 10000;
    this._defaultRetries = opts.defaultRetries || 0;
    this._setTimeout = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = opts.clearTimeout || ((t) => clearTimeout(t));
    this._lanes = { critical: [], normal: [], background: [] };
    this._running = null;
    this._paused = false;
    this._pauseReason = null;
  }

  get pendingCount() {
    return this._lanes.critical.length + this._lanes.normal.length + this._lanes.background.length;
  }

  get runningOp() {
    return this._running ? this._running.name : null;
  }

  get isPaused() {
    return this._paused;
  }

  /**
   * Enqueue an operation and get a promise for its result.
   *
   * @param {object} op
   * @param {function} op.run called as run(attempt) with attempt starting at 1;
   *   may return a value or a promise
   * @param {string} [op.name='op']
   * @param {string} [op.priority='normal'] 'critical' | 'normal' | 'background'
   * @param {number} [op.timeoutMs] per-attempt; 0 disables
   * @param {number} [op.retries] extra attempts after a failed/timed-out one
   * @param {*} [op.meta] free-form, echoed in events
   */
  enqueue(op) {
    if (!op || typeof op.run !== 'function') {
      throw new TypeError('op.run must be a function');
    }
    const priority = op.priority || 'normal';
    if (!this._lanes[priority]) {
      throw new RangeError('unknown priority: ' + priority);
    }
    const entry = {
      name: op.name || 'op',
      run: op.run,
      priority,
      timeoutMs: op.timeoutMs !== undefined ? op.timeoutMs : this._defaultTimeoutMs,
      retries: op.retries !== undefined ? op.retries : this._defaultRetries,
      meta: op.meta
    };
    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    this._lanes[priority].push(entry);
    this._pump(false);
    return promise;
  }

  /**
   * Stop starting new operations; the running one finishes normally.
   * Used e.g. while the scanner must own the radio, or during teardown.
   */
  pause(reason) {
    if (this._paused) {
      return;
    }
    this._paused = true;
    this._pauseReason = reason || null;
    this.emit('paused', { reason: this._pauseReason });
  }

  resume() {
    if (!this._paused) {
      return;
    }
    this._paused = false;
    this._pauseReason = null;
    this.emit('resumed', {});
    this._pump(false);
  }

  /**
   * Reject every pending (not yet started) operation with code ECLEARED.
   * The running operation, if any, is left to finish. Returns the number
   * of dropped operations.
   */
  clear(reason) {
    const dropped = [
      ...this._lanes.critical.splice(0),
      ...this._lanes.normal.splice(0),
      ...this._lanes.background.splice(0)
    ];
    for (const entry of dropped) {
      const err = new Error(
        'operation "' + entry.name + '" cleared' + (reason ? ': ' + reason : '')
      );
      err.code = 'ECLEARED';
      entry.reject(err);
    }
    return dropped.length;
  }

  _next() {
    return (
      this._lanes.critical.shift() ||
      this._lanes.normal.shift() ||
      this._lanes.background.shift() ||
      null
    );
  }

  _pump(afterRun) {
    if (this._running || this._paused) {
      return;
    }
    const entry = this._next();
    if (!entry) {
      if (afterRun) {
        this.emit('idle', {});
      }
      return;
    }
    this._running = entry;
    this._runAttempt(entry, 1);
  }

  _runAttempt(entry, attempt) {
    let settled = false;
    let timer = null;

    this.emit('op:start', {
      name: entry.name, priority: entry.priority, attempt, meta: entry.meta
    });

    const finish = (err, value) => {
      if (settled) {
        return; // late result of a timed-out attempt — ignore
      }
      settled = true;
      if (timer !== null) {
        this._clearTimeout(timer);
        timer = null;
      }
      if (err && attempt <= entry.retries) {
        this.emit('op:retry', { name: entry.name, attempt, error: err });
        this._runAttempt(entry, attempt + 1);
        return;
      }
      this._running = null;
      if (err) {
        this.emit('op:error', { name: entry.name, attempt, error: err });
        entry.reject(err);
      } else {
        this.emit('op:success', { name: entry.name, attempt });
        entry.resolve(value);
      }
      this._pump(true);
    };

    if (entry.timeoutMs > 0 && entry.timeoutMs !== Infinity) {
      timer = this._setTimeout(() => {
        const err = new Error(
          'operation "' + entry.name + '" timed out after ' + entry.timeoutMs +
          'ms (attempt ' + attempt + ')'
        );
        err.code = 'ETIMEDOUT';
        finish(err);
      }, entry.timeoutMs);
    }

    let result;
    try {
      result = entry.run(attempt);
    } catch (err) {
      finish(err);
      return;
    }
    Promise.resolve(result).then(
      (value) => finish(null, value),
      (err) => finish(err)
    );
  }
}

OperationQueue.PRIORITIES = PRIORITIES;

module.exports = OperationQueue;

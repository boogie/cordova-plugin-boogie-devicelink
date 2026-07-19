// Structured diagnostics — first-class, not an afterthought.
//
// Entries are objects, not strings: level, category, machine-readable code,
// plus free fields (deviceId, durationMs, reason…). A ring buffer keeps the
// recent history, per-code counters survive the buffer, and report() bundles
// everything into one exportable object for support.
'use strict';

const Emitter = require('./emitter');

const LEVELS = ['debug', 'info', 'warning', 'error'];

class Diagnostics extends Emitter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.historyLimit=500] entries kept
   * @param {string} [opts.minLevel='debug'] entries below this are dropped
   * @param {function} [opts.now=Date.now]
   */
  constructor(opts = {}) {
    super();
    this._now = opts.now || Date.now;
    this._historyLimit = opts.historyLimit || 500;
    const minLevel = opts.minLevel || 'debug';
    this._minLevel = LEVELS.indexOf(minLevel);
    if (this._minLevel < 0) {
      throw new RangeError('unknown level: ' + minLevel);
    }
    this._entries = [];
    this._counters = Object.create(null);
    this._seq = 0;
  }

  /**
   * @param {string} level 'debug' | 'info' | 'warning' | 'error'
   * @param {string} category e.g. 'connection', 'scan', 'transfer'
   * @param {string} code machine-readable, e.g. 'CONNECT_READY'
   * @param {object} [fields] free-form extras (deviceId, durationMs, …)
   * @returns {object|null} the entry, or null if filtered by minLevel
   */
  log(level, category, code, fields) {
    const levelIndex = LEVELS.indexOf(level);
    if (levelIndex < 0) {
      throw new RangeError('unknown level: ' + level);
    }
    if (levelIndex < this._minLevel) {
      return null;
    }
    const entry = Object.assign({}, fields, {
      seq: ++this._seq,
      at: this._now(),
      level,
      category,
      code
    });
    this._entries.push(entry);
    if (this._entries.length > this._historyLimit) {
      this._entries.shift();
    }
    this._counters[code] = (this._counters[code] || 0) + 1;
    this.emit('entry', entry);
    return entry;
  }

  debug(category, code, fields) { return this.log('debug', category, code, fields); }
  info(category, code, fields) { return this.log('info', category, code, fields); }
  warning(category, code, fields) { return this.log('warning', category, code, fields); }
  error(category, code, fields) { return this.log('error', category, code, fields); }

  /** How many times a code was logged (survives the ring buffer). */
  count(code) {
    return this._counters[code] || 0;
  }

  get entries() {
    return this._entries.slice();
  }

  /** Exportable bundle: counters + recent entries (+ caller extras). */
  report(extra) {
    return Object.assign({
      generatedAt: this._now(),
      counters: Object.assign({}, this._counters),
      entries: this.entries
    }, extra);
  }
}

Diagnostics.LEVELS = LEVELS;

module.exports = Diagnostics;

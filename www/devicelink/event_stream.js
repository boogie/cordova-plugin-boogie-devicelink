// Sequenced event stream — the single pipe application code listens to.
//
// Every event carries a monotonic sequence number, a timestamp, the stream's
// session id and the originating device id. That makes producer restarts and
// lost events DETECTABLE: a consumer that stored the last seq it saw can ask
// for a replay (replaySince) and learns whether older events already fell out
// of the ring buffer (gap), and a changed sessionId means the producer — e.g.
// a reloaded WebView — started over.
'use strict';

const Emitter = require('./emitter');

class EventStream extends Emitter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.historyLimit=200] events kept for replay
   * @param {string} [opts.sessionId] stable id of this producer incarnation
   * @param {function} [opts.now=Date.now]
   */
  constructor(opts = {}) {
    super();
    this._now = opts.now || Date.now;
    this._historyLimit = opts.historyLimit || 200;
    this.sessionId = opts.sessionId ||
      'session-' + this._now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
    this._seq = 0;
    this._buffer = [];
  }

  get lastSeq() {
    return this._seq;
  }

  /** Publish an event; emits 'event' and returns the full event object. */
  publish(type, deviceId, payload) {
    const event = {
      seq: ++this._seq,
      at: this._now(),
      sessionId: this.sessionId,
      deviceId: deviceId || null,
      type,
      payload: payload === undefined ? null : payload
    };
    this._buffer.push(event);
    if (this._buffer.length > this._historyLimit) {
      this._buffer.shift();
    }
    this.emit('event', event);
    return event;
  }

  /**
   * Replay buffered events with seq > sinceSeq. `gap` is true when events the
   * consumer has not seen were already dropped from the buffer — the consumer
   * should resync from a snapshot instead of trusting the replay alone.
   */
  replaySince(sinceSeq) {
    const events = this._buffer.filter((e) => e.seq > sinceSeq);
    const gap = sinceSeq < this._seq - events.length;
    return { events, gap };
  }
}

module.exports = EventStream;

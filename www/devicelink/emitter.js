// Minimal dependency-free event emitter shared by every DeviceLink component.
// Listener errors are isolated: one failing handler must not prevent the other
// handlers — or the emitting code path, which is often a native BLE callback —
// from running.
'use strict';

class Emitter {
  constructor() {
    this._listeners = Object.create(null);
  }

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   */
  on(event, fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('listener must be a function');
    }
    (this._listeners[event] = this._listeners[event] || []).push(fn);
    return () => this.off(event, fn);
  }

  /**
   * Subscribe for a single delivery. Returns an unsubscribe function.
   */
  once(event, fn) {
    const wrapper = (payload) => {
      this.off(event, wrapper);
      fn(payload);
    };
    // Lets off(event, fn) find and remove the wrapper by the original listener.
    wrapper._origin = fn;
    return this.on(event, wrapper);
  }

  off(event, fn) {
    const list = this._listeners[event];
    if (!list) {
      return;
    }
    const at = list.findIndex((l) => l === fn || l._origin === fn);
    if (at >= 0) {
      list.splice(at, 1);
    }
    if (list.length === 0) {
      delete this._listeners[event];
    }
  }

  removeAllListeners(event) {
    if (event === undefined) {
      this._listeners = Object.create(null);
    } else {
      delete this._listeners[event];
    }
  }

  emit(event, payload) {
    const list = this._listeners[event];
    if (!list) {
      return 0;
    }
    // Copy so handlers may unsubscribe (or subscribe) during dispatch.
    const snapshot = list.slice();
    for (const fn of snapshot) {
      try {
        fn(payload);
      } catch (err) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[DeviceLink] listener for "' + event + '" threw:', err);
        }
      }
    }
    return snapshot.length;
  }

  listenerCount(event) {
    const list = this._listeners[event];
    return list ? list.length : 0;
  }
}

module.exports = Emitter;

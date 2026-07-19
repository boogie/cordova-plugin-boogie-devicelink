'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Emitter = require('../www/devicelink/emitter.js');

test('on delivers payloads; the returned function unsubscribes', () => {
  const e = new Emitter();
  const got = [];
  const off = e.on('x', (p) => got.push(p));
  e.emit('x', 1);
  e.emit('x', 2);
  off();
  e.emit('x', 3);
  assert.deepEqual(got, [1, 2]);
});

test('off removes a specific listener only', () => {
  const e = new Emitter();
  const got = [];
  const a = (p) => got.push('a' + p);
  const b = (p) => got.push('b' + p);
  e.on('x', a);
  e.on('x', b);
  e.off('x', a);
  e.emit('x', 1);
  assert.deepEqual(got, ['b1']);
});

test('once fires exactly once', () => {
  const e = new Emitter();
  let n = 0;
  e.once('x', () => n++);
  e.emit('x');
  e.emit('x');
  assert.equal(n, 1);
});

test('a pending once listener can be removed with the original function', () => {
  const e = new Emitter();
  let n = 0;
  const fn = () => n++;
  e.once('x', fn);
  e.off('x', fn);
  e.emit('x');
  assert.equal(n, 0);
});

test('a throwing listener does not stop the others', () => {
  const e = new Emitter();
  const origError = console.error;
  console.error = () => {};
  try {
    const got = [];
    e.on('x', () => { throw new Error('boom'); });
    e.on('x', (p) => got.push(p));
    e.emit('x', 42);
    assert.deepEqual(got, [42]);
  } finally {
    console.error = origError;
  }
});

test('unsubscribing during emit does not skip the remaining listeners', () => {
  const e = new Emitter();
  const got = [];
  const off = e.on('x', () => { got.push('first'); off(); });
  e.on('x', () => got.push('second'));
  e.emit('x');
  e.emit('x');
  assert.deepEqual(got, ['first', 'second', 'second']);
});

test('listenerCount and removeAllListeners', () => {
  const e = new Emitter();
  e.on('x', () => {});
  e.on('x', () => {});
  e.on('y', () => {});
  assert.equal(e.listenerCount('x'), 2);
  assert.equal(e.listenerCount('y'), 1);
  assert.equal(e.listenerCount('z'), 0);
  e.removeAllListeners('x');
  assert.equal(e.listenerCount('x'), 0);
  assert.equal(e.listenerCount('y'), 1);
  e.removeAllListeners();
  assert.equal(e.listenerCount('y'), 0);
});

test('emit returns the number of listeners invoked', () => {
  const e = new Emitter();
  assert.equal(e.emit('x'), 0);
  e.on('x', () => {});
  e.on('x', () => {});
  assert.equal(e.emit('x'), 2);
});

test('subscribing with a non-function throws', () => {
  const e = new Emitter();
  assert.throws(() => e.on('x', null), TypeError);
});

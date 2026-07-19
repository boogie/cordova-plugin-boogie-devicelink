'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Pacer = require('../www/devicelink/pacer.js');

function clockAt(t0) {
  const clock = { t: t0 };
  clock.now = () => clock.t;
  return clock;
}

test('starts with a full burst of credit', () => {
  const clock = clockAt(0);
  const p = new Pacer({ bytesPerSecond: 1000, burstBytes: 500, now: clock.now });
  assert.equal(p.credit, 500);
  assert.equal(p.delayFor(500), 0);
});

test('spent credit refills at bytesPerSecond', () => {
  const clock = clockAt(0);
  const p = new Pacer({ bytesPerSecond: 1000, burstBytes: 500, now: clock.now });
  p.onSent(500);
  assert.equal(p.delayFor(500), 500); // 500 bytes at 1000 B/s
  clock.t = 250;
  assert.equal(p.delayFor(500), 250);
  clock.t = 500;
  assert.equal(p.delayFor(500), 0);
});

test('credit is capped at burstBytes — idle time does not accumulate a mega-burst', () => {
  const clock = clockAt(0);
  const p = new Pacer({ bytesPerSecond: 1000, burstBytes: 500, now: clock.now });
  clock.t = 60000; // a minute idle
  assert.equal(p.credit, 500);
  p.onSent(500);
  assert.equal(p.delayFor(500), 500); // no stored-up burst beyond capacity
});

test('a chunk larger than the burst drives the credit negative and is paid off', () => {
  const clock = clockAt(0);
  const p = new Pacer({ bytesPerSecond: 1000, burstBytes: 500, now: clock.now });
  p.onSent(1000); // 500 over the available credit
  assert.equal(p.credit, -500);
  assert.equal(p.delayFor(500), 1000); // 500 debt + 500 chunk at 1000 B/s
  clock.t = 1000;
  assert.equal(p.delayFor(500), 0);
});

test('minGapMs enforces a floor between sends even with plenty of credit', () => {
  const clock = clockAt(0);
  const p = new Pacer({ bytesPerSecond: 1e6, burstBytes: 1e6, minGapMs: 20, now: clock.now });
  p.onSent(10);
  assert.equal(p.delayFor(10), 20);
  clock.t = 5;
  assert.equal(p.delayFor(10), 15);
  clock.t = 20;
  assert.equal(p.delayFor(10), 0);
});

test('the larger of the rate delay and the gap delay wins', () => {
  const clock = clockAt(0);
  const p = new Pacer({ bytesPerSecond: 1000, burstBytes: 100, minGapMs: 10, now: clock.now });
  p.onSent(100);
  // rate wants 100ms for the next 100 bytes, the gap only 10 — rate wins
  assert.equal(p.delayFor(100), 100);
});

test('burstBytes defaults to one second of rate', () => {
  const clock = clockAt(0);
  const p = new Pacer({ bytesPerSecond: 2000, now: clock.now });
  assert.equal(p.credit, 2000);
});

test('invalid configuration throws', () => {
  assert.throws(() => new Pacer({}), RangeError);
  assert.throws(() => new Pacer({ bytesPerSecond: 0 }), RangeError);
  assert.throws(() => new Pacer({ bytesPerSecond: 1000, burstBytes: 0 }), RangeError);
});

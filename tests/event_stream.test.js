'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const EventStream = require('../www/devicelink/event_stream.js');

test('published events carry seq, timestamp, sessionId, deviceId and payload', () => {
  const stream = new EventStream({ now: () => 1234, sessionId: 'session-1' });
  const live = [];
  stream.on('event', (e) => live.push(e));

  const event = stream.publish('batteryChanged', 'lcdDisplay:AA:BB', { level: 74 });
  assert.deepEqual(event, {
    seq: 1, at: 1234, sessionId: 'session-1',
    deviceId: 'lcdDisplay:AA:BB', type: 'batteryChanged', payload: { level: 74 }
  });
  assert.deepEqual(live, [event]);

  const second = stream.publish('somethingElse');
  assert.equal(second.seq, 2);
  assert.equal(second.deviceId, null);
  assert.equal(second.payload, null);
  assert.equal(stream.lastSeq, 2);
});

test('a generated sessionId is unique-ish and stable for the stream', () => {
  const a = new EventStream();
  const b = new EventStream();
  assert.ok(a.sessionId.startsWith('session-'));
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(a.publish('x').sessionId, a.sessionId);
});

test('replaySince returns everything after the given seq without a gap', () => {
  const stream = new EventStream({ now: () => 0 });
  for (let i = 0; i < 5; i++) {
    stream.publish('e' + i);
  }
  const { events, gap } = stream.replaySince(2);
  assert.deepEqual(events.map((e) => e.seq), [3, 4, 5]);
  assert.equal(gap, false);

  const fresh = stream.replaySince(5);
  assert.deepEqual(fresh.events, []);
  assert.equal(fresh.gap, false);
});

test('replaySince reports a gap when unseen events already fell out of the buffer', () => {
  const stream = new EventStream({ now: () => 0, historyLimit: 3 });
  for (let i = 0; i < 6; i++) {
    stream.publish('e' + i); // buffer keeps seq 4..6
  }
  const behind = stream.replaySince(1);
  assert.deepEqual(behind.events.map((e) => e.seq), [4, 5, 6]);
  assert.equal(behind.gap, true); // seq 2..3 are gone — resync from snapshot

  const current = stream.replaySince(3);
  assert.equal(current.gap, false); // everything after 3 is still buffered
});

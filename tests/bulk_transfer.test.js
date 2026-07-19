'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const BulkTransfer = require('../www/devicelink/bulk_transfer.js');
const Pacer = require('../www/devicelink/pacer.js');
const { createTimers, tick } = require('./mock_ble.js');

const bytes = (n) => new Uint8Array(n);
const chunkList = (n, size = 1) => Array.from({ length: n }, () => bytes(size));

test('split cuts data on chunk boundaries', () => {
  const parts = BulkTransfer.split(bytes(10), 4);
  assert.deepEqual(parts.map((p) => p.length), [4, 4, 2]);
  assert.throws(() => BulkTransfer.split(bytes(10), 0), RangeError);
});

test('pace flow sends every chunk in order when the pacer allows full speed', async () => {
  const sent = [];
  const transfer = new BulkTransfer({
    data: bytes(60),
    chunkSize: 20,
    flow: 'pace',
    pacer: new Pacer({ bytesPerSecond: 1e9 }),
    send: (chunk, i) => { sent.push([i, chunk.length]); }
  });
  const progress = [];
  transfer.on('progress', (p) => progress.push(p.sent));
  const result = await transfer.start();
  assert.deepEqual(sent, [[0, 20], [1, 20], [2, 20]]);
  assert.deepEqual(progress, [1, 2, 3]);
  assert.deepEqual(result, { sent: 3, acked: null, total: 3 });
});

test('pace flow waits exactly what the pacer asks for', async () => {
  const clock = { t: 0 };
  const timers = createTimers();
  const sent = [];
  const transfer = new BulkTransfer({
    data: bytes(60),
    chunkSize: 20,
    flow: 'pace',
    pacer: new Pacer({ bytesPerSecond: 1000, burstBytes: 20, now: () => clock.t }),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    send: (chunk, i) => { sent.push(i); }
  });
  const done = transfer.start();
  await tick();
  assert.deepEqual(sent, [0]); // first chunk free, second waits for credit
  assert.equal(timers.scheduled[0].ms, 20);

  clock.t += 20;
  timers.fire();
  await tick();
  assert.deepEqual(sent, [0, 1]);

  clock.t += 20;
  timers.fire();
  await done;
  assert.deepEqual(sent, [0, 1, 2]);
});

test('ack flow keeps at most windowSize chunks in flight', async () => {
  const sent = [];
  const transfer = new BulkTransfer({
    chunks: chunkList(5),
    flow: 'ack',
    windowSize: 2,
    ackTimeoutMs: 0,
    send: (chunk, i) => { sent.push(i); }
  });
  const done = transfer.start();
  await tick();
  assert.deepEqual(sent, [0, 1]); // window full, waiting for the device

  transfer.ack();
  await tick();
  assert.deepEqual(sent, [0, 1, 2]);

  transfer.ack(2);
  await tick();
  assert.deepEqual(sent, [0, 1, 2, 3, 4]);

  transfer.ack(2);
  const result = await done;
  assert.deepEqual(result, { sent: 5, acked: 5, total: 5 });
});

test('acks arriving while the send loop is busy are banked, not lost', async () => {
  const sent = [];
  const transfer = new BulkTransfer({
    chunks: chunkList(3),
    flow: 'ack',
    windowSize: 1,
    ackTimeoutMs: 0,
    send: (chunk, i) => {
      sent.push(i);
      transfer.ack(); // device "responds" synchronously during the send
    }
  });
  const result = await transfer.start();
  assert.deepEqual(sent, [0, 1, 2]);
  assert.equal(result.acked, 3);
});

test('missing acks time out with ETIMEDOUT', async () => {
  const timers = createTimers();
  const transfer = new BulkTransfer({
    chunks: chunkList(2),
    flow: 'ack',
    windowSize: 1,
    ackTimeoutMs: 5000,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    send: () => {}
  });
  const done = transfer.start();
  await tick();
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].ms, 5000);
  timers.fire();
  await assert.rejects(done, (err) => err.code === 'ETIMEDOUT');
});

test('abort rejects the transfer with EABORTED and stops sending', async () => {
  const clock = { t: 0 };
  const timers = createTimers();
  const sent = [];
  const transfer = new BulkTransfer({
    data: bytes(40),
    chunkSize: 20,
    flow: 'pace',
    pacer: new Pacer({ bytesPerSecond: 1000, burstBytes: 20, now: () => clock.t }),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    send: (chunk, i) => { sent.push(i); }
  });
  const aborted = [];
  transfer.on('aborted', (e) => aborted.push(e.reason));
  const done = transfer.start();
  await tick();
  assert.deepEqual(sent, [0]); // second chunk is sleeping on the pacer

  transfer.abort('user cancelled');
  await assert.rejects(done, (err) => err.code === 'EABORTED');
  assert.deepEqual(sent, [0]);
  assert.deepEqual(aborted, ['user cancelled']);
  assert.equal(timers.scheduled.length, 0); // the sleep timer was cleared
});

test('startIndex resumes a transfer from the middle', async () => {
  const sent = [];
  const transfer = new BulkTransfer({
    chunks: chunkList(4),
    flow: 'pace',
    pacer: new Pacer({ bytesPerSecond: 1e9 }),
    startIndex: 2,
    send: (chunk, i) => { sent.push(i); }
  });
  const result = await transfer.start();
  assert.deepEqual(sent, [2, 3]);
  assert.equal(result.sent, 4);
});

test('invalid configuration throws synchronously', () => {
  const send = () => {};
  assert.throws(() => new BulkTransfer({ send }), TypeError); // no data/chunks
  assert.throws(() => new BulkTransfer({ chunks: chunkList(1), flow: 'warp', send }), RangeError);
  assert.throws(() => new BulkTransfer({ chunks: chunkList(1), flow: 'pace', send }), TypeError); // no pacer
  assert.throws(() => new BulkTransfer({ chunks: chunkList(1) }), TypeError); // no send
});

test('a transfer cannot be started twice', async () => {
  const transfer = new BulkTransfer({
    chunks: chunkList(1),
    flow: 'pace',
    pacer: new Pacer({ bytesPerSecond: 1e9 }),
    send: () => {}
  });
  await transfer.start();
  await assert.rejects(transfer.start(), /already started/);
});

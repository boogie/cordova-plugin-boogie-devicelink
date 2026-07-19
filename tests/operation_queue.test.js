'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const OperationQueue = require('../www/devicelink/operation_queue.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('runs operations serially in FIFO order', async () => {
  const q = new OperationQueue();
  const log = [];
  let active = 0;
  let maxActive = 0;
  const mk = (name) => q.enqueue({
    name,
    run: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      log.push(name + ':start');
      await sleep(10);
      log.push(name + ':end');
      active--;
      return name;
    }
  });
  const results = await Promise.all([mk('a'), mk('b'), mk('c')]);
  assert.equal(maxActive, 1);
  assert.deepEqual(log, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  assert.deepEqual(results, ['a', 'b', 'c']);
});

test('priorities: critical > normal > background, FIFO within a lane', async () => {
  const q = new OperationQueue();
  q.pause('setup');
  const order = [];
  const ops = [
    q.enqueue({ name: 'bg', priority: 'background', run: () => { order.push('bg'); } }),
    q.enqueue({ name: 'n1', priority: 'normal', run: () => { order.push('n1'); } }),
    q.enqueue({ name: 'crit', priority: 'critical', run: () => { order.push('crit'); } }),
    q.enqueue({ name: 'n2', priority: 'normal', run: () => { order.push('n2'); } })
  ];
  q.resume();
  await Promise.all(ops);
  assert.deepEqual(order, ['crit', 'n1', 'n2', 'bg']);
});

test('a critical op never preempts the running op', async () => {
  const q = new OperationQueue();
  const order = [];
  const slow = q.enqueue({
    name: 'slow',
    run: async () => {
      order.push('slow:start');
      await sleep(20);
      order.push('slow:end');
    }
  });
  await sleep(5); // slow is mid-flight
  const crit = q.enqueue({ name: 'crit', priority: 'critical', run: () => { order.push('crit'); } });
  await Promise.all([slow, crit]);
  assert.deepEqual(order, ['slow:start', 'slow:end', 'crit']);
});

test('an operation that never settles times out with ETIMEDOUT', async () => {
  const q = new OperationQueue();
  await assert.rejects(
    q.enqueue({ name: 'hang', timeoutMs: 20, run: () => new Promise(() => {}) }),
    (err) => err.code === 'ETIMEDOUT'
  );
});

test('a timed-out attempt is retried; its late result is ignored', async () => {
  const q = new OperationQueue();
  const retries = [];
  q.on('op:retry', (e) => retries.push(e.attempt));
  let firstResolve;
  const result = await q.enqueue({
    name: 'flaky',
    timeoutMs: 20,
    retries: 1,
    run: (attempt) => attempt === 1
      ? new Promise((resolve) => { firstResolve = resolve; }) // hangs past the timeout
      : 'second'
  });
  assert.equal(result, 'second');
  assert.deepEqual(retries, [1]);
  firstResolve('late'); // the timed-out attempt settles late — must be a no-op
  await sleep(5);
  assert.equal(q.runningOp, null);
});

test('retries are exhausted and the last error surfaces (sync throws included)', async () => {
  const q = new OperationQueue();
  let attempts = 0;
  await assert.rejects(
    q.enqueue({
      name: 'bad',
      retries: 2,
      run: () => {
        attempts++;
        throw new Error('boom ' + attempts);
      }
    }),
    /boom 3/
  );
  assert.equal(attempts, 3);
});

test('a rejection without retries propagates to the caller', async () => {
  const q = new OperationQueue();
  await assert.rejects(
    q.enqueue({ name: 'fail', run: () => Promise.reject(new Error('nope')) }),
    /nope/
  );
});

test('clear rejects pending ops with ECLEARED; the running op finishes', async () => {
  const q = new OperationQueue();
  const running = q.enqueue({
    name: 'run',
    run: async () => {
      await sleep(20);
      return 'done';
    }
  });
  await sleep(5);
  const pending = q.enqueue({ name: 'wait', run: () => 'never' });
  const dropped = q.clear('disconnect');
  assert.equal(dropped, 1);
  await assert.rejects(pending, (err) => err.code === 'ECLEARED');
  assert.equal(await running, 'done');
});

test('pause stops new ops from starting; resume continues; idle fires after drain', async () => {
  const q = new OperationQueue();
  const events = [];
  q.on('paused', (e) => events.push('paused:' + e.reason));
  q.on('resumed', () => events.push('resumed'));
  q.on('idle', () => events.push('idle'));

  q.pause('transfer');
  assert.equal(q.isPaused, true);
  const p = q.enqueue({ name: 'op', run: () => 'v' });
  await sleep(10);
  assert.equal(q.pendingCount, 1); // must not have started while paused

  q.resume();
  assert.equal(await p, 'v');
  assert.deepEqual(events, ['paused:transfer', 'resumed', 'idle']);
});

test('op lifecycle events carry name, priority and attempt', async () => {
  const q = new OperationQueue();
  const events = [];
  q.on('op:start', (e) => events.push(['start', e.name, e.priority, e.attempt]));
  q.on('op:success', (e) => events.push(['success', e.name, e.attempt]));
  q.on('op:error', (e) => events.push(['error', e.name, e.attempt]));

  await q.enqueue({ name: 'good', run: () => 1 });
  await q.enqueue({ name: 'bad', run: () => { throw new Error('x'); } }).catch(() => {});

  assert.deepEqual(events, [
    ['start', 'good', 'normal', 1],
    ['success', 'good', 1],
    ['start', 'bad', 'normal', 1],
    ['error', 'bad', 1]
  ]);
});

test('invalid enqueue arguments throw synchronously', () => {
  const q = new OperationQueue();
  assert.throws(() => q.enqueue({ priority: 'urgent', run: () => {} }), RangeError);
  assert.throws(() => q.enqueue({ name: 'norun' }), TypeError);
  assert.throws(() => q.enqueue(), TypeError);
});

test('runningOp and pendingCount reflect the queue state', async () => {
  const q = new OperationQueue();
  assert.equal(q.runningOp, null);
  assert.equal(q.pendingCount, 0);
  const p1 = q.enqueue({ name: 'first', run: () => sleep(15) });
  const p2 = q.enqueue({ name: 'second', run: () => 'v' });
  await sleep(5);
  assert.equal(q.runningOp, 'first');
  assert.equal(q.pendingCount, 1);
  await Promise.all([p1, p2]);
  assert.equal(q.runningOp, null);
  assert.equal(q.pendingCount, 0);
});

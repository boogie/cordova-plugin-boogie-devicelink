'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const DeviceStateMachine = require('../www/devicelink/state_machine.js');

test('starts in unknown by default; custom initial state is accepted', () => {
  assert.equal(new DeviceStateMachine().state, 'unknown');
  assert.equal(new DeviceStateMachine({ initial: 'discovered' }).state, 'discovered');
  assert.throws(() => new DeviceStateMachine({ initial: 'nope' }), RangeError);
});

test('the happy path reaches ready and emits sequenced change events', () => {
  const sm = new DeviceStateMachine({ now: () => 1000 });
  const seen = [];
  sm.on('change', (e) => seen.push(e));

  const path = ['discovered', 'connecting', 'discovering', 'configuring', 'ready'];
  for (const to of path) {
    sm.transition(to);
  }

  assert.equal(sm.state, 'ready');
  assert.equal(sm.isReady, true);
  assert.deepEqual(seen.map((e) => e.to), path);
  assert.deepEqual(seen.map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.equal(seen[0].from, 'unknown');
  assert.equal(seen[0].at, 1000);
});

test('an invalid transition throws EINVALIDTRANSITION and leaves the state unchanged', () => {
  const sm = new DeviceStateMachine();
  assert.throws(
    () => sm.transition('ready'),
    (err) => err.code === 'EINVALIDTRANSITION'
  );
  assert.equal(sm.state, 'unknown');
});

test('transitioning to an unknown state throws RangeError', () => {
  const sm = new DeviceStateMachine();
  assert.throws(() => sm.transition('warp'), RangeError);
});

test('canTransition reflects the transition table', () => {
  const sm = new DeviceStateMachine();
  assert.equal(sm.canTransition('discovered'), true);
  assert.equal(sm.canTransition('ready'), false);
});

test('entering disconnected records the reason; invalid reasons throw', () => {
  const sm = new DeviceStateMachine({ initial: 'ready' });
  assert.equal(sm.disconnectReason, null);

  sm.transition('disconnected', { reason: 'gattError' });
  assert.equal(sm.disconnectReason, 'gattError');

  sm.transition('connecting');
  // the last reason stays readable until the next disconnect
  assert.equal(sm.disconnectReason, 'gattError');

  sm.transition('disconnected');
  assert.equal(sm.disconnectReason, 'unknown');

  sm.transition('connecting');
  assert.throws(
    () => sm.transition('disconnected', { reason: 'catAteIt' }),
    (err) => err.code === 'EBADREASON'
  );
  assert.equal(sm.state, 'connecting');
});

test('the reconnect cycle is a legal walk', () => {
  const sm = new DeviceStateMachine({ initial: 'ready' });
  const walk = [
    ['disconnected', { reason: 'deviceOutOfRange' }],
    ['reconnectWaiting'],
    ['reconnecting'],
    ['reconnectWaiting'], // failed attempt, next backoff
    ['reconnecting'],
    ['discovering'],
    ['configuring'],
    ['ready']
  ];
  for (const [to, meta] of walk) {
    sm.transition(to, meta);
  }
  assert.equal(sm.state, 'ready');
});

test('a user-requested disconnect is a legal walk and keeps its reason', () => {
  const sm = new DeviceStateMachine({ initial: 'ready' });
  sm.transition('disconnecting');
  sm.transition('disconnected', { reason: 'userRequested' });
  assert.equal(sm.disconnectReason, 'userRequested');
});

test('firmware update flow: ready → updatingFirmware → disconnected (firmwareReboot)', () => {
  const sm = new DeviceStateMachine({ initial: 'ready' });
  sm.transition('updatingFirmware');
  sm.transition('disconnected', { reason: 'firmwareReboot' });
  sm.transition('reconnectWaiting');
  assert.equal(sm.disconnectReason, 'firmwareReboot');
});

test('history is recorded and capped at historyLimit', () => {
  const sm = new DeviceStateMachine({ historyLimit: 3 });
  sm.transition('discovered');
  sm.transition('connecting');
  sm.transition('discovering');
  sm.transition('configuring');
  sm.transition('ready');
  const history = sm.history;
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((e) => e.to), ['discovering', 'configuring', 'ready']);
  assert.deepEqual(history.map((e) => e.seq), [3, 4, 5]);
});

test('the transition table is internally consistent', () => {
  const { STATES, TRANSITIONS, DISCONNECT_REASONS } = DeviceStateMachine;
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), STATES.slice().sort());
  for (const [from, targets] of Object.entries(TRANSITIONS)) {
    for (const to of targets) {
      assert.ok(STATES.includes(to), from + ' -> ' + to + ' targets an unknown state');
      assert.notEqual(from, to, from + ' must not self-transition');
    }
  }
  assert.ok(DISCONNECT_REASONS.includes('unknown'));
  assert.ok(DISCONNECT_REASONS.includes('userRequested'));
});

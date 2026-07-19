// DeviceLink public namespace (window.DeviceLink in a Cordova app).
//
// The runtime is being built bottom-up; this module exposes the tested core
// building blocks first. The raw BLE bridge remains untouched and available
// as window.bluetoothle.
'use strict';

const Emitter = require('./emitter');
const DeviceStateMachine = require('./state_machine');
const OperationQueue = require('./operation_queue');
const ScanManager = require('./scan_manager');
const Pacer = require('./pacer');
const BulkTransfer = require('./bulk_transfer');
const CapabilityRegistry = require('./capabilities');
const Device = require('./device');

const DeviceLink = {
  // Keep in sync with package.json / plugin.xml (asserted by the test suite).
  VERSION: '0.1.0',

  Emitter,
  DeviceStateMachine,
  OperationQueue,
  ScanManager,
  Pacer,
  BulkTransfer,
  CapabilityRegistry,
  Device,

  // Shared default capability registry (protocols like 'battery').
  capabilities: CapabilityRegistry.default,

  STATES: DeviceStateMachine.STATES,
  DISCONNECT_REASONS: DeviceStateMachine.DISCONNECT_REASONS,
  PRIORITIES: OperationQueue.PRIORITIES
};

module.exports = DeviceLink;

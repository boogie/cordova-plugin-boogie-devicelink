# cordova-plugin-boogie-devicelink

![platforms](https://img.shields.io/badge/platforms-android%20%7C%20ios-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![tests](https://img.shields.io/badge/tests-node--test-brightgreen)
![status](https://img.shields.io/badge/status-in%20development-orange)

**DeviceLink** is a stateful BLE **device runtime** for Cordova apps on **Android and
iOS**. Instead of juggling connections, characteristic UUIDs, and `setTimeout` chains,
the application works with **devices, capabilities, and operations**:

```js
const device = await DeviceLink.connect({ identity: savedIdentity, waitUntil: 'ready' });

await device.sendText('Seven of Hearts');

device.on('batteryChanged', ({ level }) => render(level));
device.on('connectionStateChanged', ({ state, reason }) => update(state));
```

A fork of [cordova-plugin-bluetoothle](https://github.com/randdusing/cordova-plugin-bluetoothle)
by Rand Dusing — the battle-tested native BLE bridge stays (and remains fully available
as the raw `bluetoothle` global), while a new runtime layer on top owns connection
state, sequencing, and recovery.

> **Status: early development.** The raw `bluetoothle` layer is fully functional — the
> plugin already works as a drop-in replacement for `cordova-plugin-bluetoothle` 6.7.4.
> The DeviceLink runtime is being built bottom-up, core first, with tests.

## Why

Every real-world BLE app ends up with the same accidental architecture: a scan loop per
device type, global `_busy` flags guarding transfers, retry timers stored on `window`,
name-prefix routing pasted twenty times, and a `connected` boolean that goes `true` long
before the device is actually usable. The lessons are always the same:

- **`connected` is not `ready`.** After the link comes up there is still service
  discovery, subscriptions, MTU, and an init handshake. Most BLE race conditions live in
  that gap. DeviceLink models it with an explicit per-device state machine
  (`connecting → discovering → configuring → ready`), so the app can wait for — and
  trust — `ready`.
- **GATT operations must be serialized.** Android in particular tolerates exactly one
  in-flight GATT operation per device. DeviceLink runs everything through a per-device
  priority queue (`critical` / `normal` / `background`) with timeouts and retries —
  a critical write may jump ahead of a battery poll, but never interrupts a running
  operation.
- **Scanning steals the radio.** A background scan colliding with a timing-sensitive
  write can stall a transfer for seconds — and a misplaced `stopScan` can deadlock
  inside the BLE plugin. DeviceLink owns a single scanner and coordinates it with the
  operation queues instead of relying on scattered busy flags.
- **Reconnect is policy, not an accident.** Remembered-device reconnect, recovery after
  unexpected disconnects, and "the user asked to disconnect, stop trying" are different
  behaviors. DeviceLink separates disconnect *reasons* from reconnect *policies*.
- **The native side must own the state.** A WebView reload, a route change, or a JS
  error must not tear down device connections. The app resyncs from a snapshot instead
  of rebuilding state by hand.

## Architecture

```
┌──────────────────────────────────────────────┐
│  Device Runtime API        window.DeviceLink │   devices, capabilities, operations
├──────────────────────────────────────────────┤
│  Device Profiles                             │   declarative: discovery, characteristics,
│                                              │   connect pipeline, reconnect policy
├──────────────────────────────────────────────┤
│  Native BLE Engine        window.bluetoothle │   scan, GATT, MTU, permissions —
│  (cordova-plugin-bluetoothle fork)           │   raw API kept as an escape hatch
└──────────────────────────────────────────────┘
```

Device classes (e.g. `EInkDisplay`, `LcdDisplay`) share common surface — battery,
connection state, disconnect — through **capabilities** that work like protocols: a
capability declares the methods and events an implementation must provide, and device
classes are validated against it at registration time.

Connection lifecycle:

```
unknown → discovered → connecting → discovering → configuring → ready
            ↑                                                     │
            └── reconnecting ← reconnectWaiting ← disconnected ←──┘
```

## Install

```
cordova plugin add https://github.com/boogie/cordova-plugin-boogie-devicelink.git
```

Or from a local checkout:

```
cordova plugin add /path/to/cordova-plugin-boogie-devicelink
```

The plugin **replaces** `cordova-plugin-bluetoothle` (it ships the same native engine
and the same `window.bluetoothle` global) — remove the original before installing, and
never install the two together.

## What exists today

- **Raw BLE API** — the complete `bluetoothle` API, unchanged. Documentation:
  [docs/bluetoothle.md](docs/bluetoothle.md) (upstream changelog:
  [docs/bluetoothle-changelog.md](docs/bluetoothle-changelog.md)).
- **DeviceLink core** (`www/devicelink/`), fully unit-tested:
  - `Emitter` — minimal event emitter with listener error isolation
  - `DeviceStateMachine` — explicit connection states, validated transitions,
    disconnect reasons, transition history
  - `OperationQueue` — serial per-device execution with priorities, timeouts,
    retries, pause/resume

## Roadmap

1. ~~Fork, rebrand, test infrastructure, runtime core~~ *(you are here)*
2. Scan manager (single scan owner, transfer-aware) + native fixes, including the
   `stopScan` ↔ `onScanResult` lock-order deadlock
3. Declarative device profiles, connection pipeline, `Device` base class, capability
   registry, first device classes — plus a `MockBluetoothLE` simulator with scriptable
   virtual devices so everything above is testable without hardware
4. Snapshot API + sequenced event stream (survive WebView reloads), structured
   diagnostics with an exportable report
5. Firmware update module (transport-agnostic: custom BLE, Nordic DFU, SMP) — separate
   from the core

## Ideas — beyond the roadmap

Related features that would fit this plugin well:

- **Payload manager**: expose `device.maximumWritePayload` instead of MTU — handle the
  Android MTU request quirks (Android 14+ first-request behavior), iOS write length,
  ATT overhead, and automatic chunking behind one number.
- **iOS state restoration**: Core Bluetooth state preservation/restoration so
  background reconnects survive app relaunch.
- **Bonding management**: initiate/inspect bonds where devices require them.
- **Diagnostic report export**: one tap in a host app produces a support-ready report —
  connect-to-ready times, disconnect reasons, GATT status codes, negotiated payload
  sizes, phone model and adapter state.
- **Virtual device transport**: run a device profile against a scripted in-memory
  peripheral — demos, UI development, and CI without hardware.
- **Non-BLE transports**: the runtime API is transport-shaped, not BLE-shaped — a
  WebSocket, LAN, or USB device could implement the same `Device` surface later.
- **Multi-phone links**: one phone acting as a BLE peripheral for another (the engine
  already supports peripheral mode).

## Tests

```
npm test
```

Plain `node --test`, no dependencies, no hardware: the runtime core is exercised
directly, and structural tests keep `plugin.xml`, `package.json`, and the module graph
consistent (including the js-module naming rule that Cordova's relative `require`
depends on).

## Credits & license

Built on [cordova-plugin-bluetoothle](https://github.com/randdusing/cordova-plugin-bluetoothle)
by Rand Dusing and contributors — the full git history of the upstream project is
preserved in this repository. MIT licensed (see [LICENSE](LICENSE)).

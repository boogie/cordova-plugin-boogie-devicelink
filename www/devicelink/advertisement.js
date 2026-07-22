// Advertisement-data parser — one shape for both platforms.
//
// Android hands scan results a base64 blob of the raw AD structures
// (length/type/payload triplets, Bluetooth Core Spec); iOS hands a parsed
// object with CoreBluetooth's keys. parse() normalizes both into:
//
//   {
//     localName, txPowerLevel, flags, connectable,
//     serviceUuids:     ['FF10', '6E400001-…'],        // normalized
//     serviceData:      { FF10: Uint8Array },
//     manufacturerData: { '0057': Uint8Array },        // key: company id hex
//     raw:              Uint8Array | null              // Android only
//   }
//
// Fields a platform cannot know stay null (flags on iOS, connectable on
// Android). Deliberately a standalone public utility: legacy scan code can
// call DeviceLink.parseAdvertisement(result.advertisement) without touching
// the rest of the runtime.
'use strict';

// AD structure types (Bluetooth Assigned Numbers).
const AD_FLAGS = 0x01;
const AD_UUID16_INCOMPLETE = 0x02;
const AD_UUID16_COMPLETE = 0x03;
const AD_UUID32_INCOMPLETE = 0x04;
const AD_UUID32_COMPLETE = 0x05;
const AD_UUID128_INCOMPLETE = 0x06;
const AD_UUID128_COMPLETE = 0x07;
const AD_NAME_SHORT = 0x08;
const AD_NAME_COMPLETE = 0x09;
const AD_TX_POWER = 0x0A;
const AD_SERVICE_DATA_16 = 0x16;
const AD_SERVICE_DATA_32 = 0x20;
const AD_SERVICE_DATA_128 = 0x21;
const AD_MANUFACTURER = 0xFF;

const BASE_UUID = /^0000([0-9A-F]{4})-0000-1000-8000-00805F9B34FB$/;

/** 'FF10' and '0000ff10-0000-1000-8000-00805f9b34fb' → 'FF10'. */
function normalizeUuid(uuid) {
  if (!uuid) {
    return '';
  }
  const upper = String(uuid).toUpperCase();
  const short = upper.match(BASE_UUID);
  return short ? short[1] : upper;
}

function base64ToBytes(b64) {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function hex(byte) {
  return byte.toString(16).toUpperCase().padStart(2, '0');
}

/** 16-bit little-endian value at offset → 4-digit uppercase hex. */
function hex16(bytes, at) {
  return hex(bytes[at + 1]) + hex(bytes[at]);
}

function uuid128(bytes, at) {
  // 128-bit UUIDs are little-endian on air; reverse into display order.
  let s = '';
  for (let i = 15; i >= 0; i--) {
    s += hex(bytes[at + i]);
  }
  const formatted = s.slice(0, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16) +
    '-' + s.slice(16, 20) + '-' + s.slice(20);
  return normalizeUuid(formatted);
}

function uuid32(bytes, at) {
  const formatted = hex(bytes[at + 3]) + hex(bytes[at + 2]) + hex(bytes[at + 1]) + hex(bytes[at]) +
    '-0000-1000-8000-00805F9B34FB';
  return normalizeUuid(formatted);
}

function utf8(bytes) {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(bytes).toString('utf8');
}

function empty() {
  return {
    localName: null,
    txPowerLevel: null,
    flags: null,
    connectable: null,
    serviceUuids: [],
    serviceData: {},
    manufacturerData: {},
    raw: null
  };
}

/** Parse raw AD bytes (the Android form). Tolerates truncated data. */
function parseRaw(bytes) {
  const out = empty();
  out.raw = bytes;
  let shortName = null;
  let at = 0;

  while (at < bytes.length) {
    const len = bytes[at];
    if (len === 0) {
      break; // early terminator — the rest is padding
    }
    const type = bytes[at + 1];
    const start = at + 2;
    const end = at + 1 + len; // exclusive; len counts the type byte
    if (end > bytes.length) {
      break; // truncated structure — stop rather than misread
    }
    const payload = bytes.subarray(start, end);

    switch (type) {
      case AD_FLAGS:
        if (payload.length >= 1) {
          out.flags = payload[0];
        }
        break;
      case AD_NAME_COMPLETE:
        out.localName = utf8(payload);
        break;
      case AD_NAME_SHORT:
        shortName = utf8(payload);
        break;
      case AD_TX_POWER:
        if (payload.length >= 1) {
          out.txPowerLevel = payload[0] > 127 ? payload[0] - 256 : payload[0];
        }
        break;
      case AD_UUID16_INCOMPLETE:
      case AD_UUID16_COMPLETE:
        for (let i = 0; i + 1 < payload.length; i += 2) {
          out.serviceUuids.push(hex16(payload, i));
        }
        break;
      case AD_UUID32_INCOMPLETE:
      case AD_UUID32_COMPLETE:
        for (let i = 0; i + 3 < payload.length; i += 4) {
          out.serviceUuids.push(uuid32(payload, i));
        }
        break;
      case AD_UUID128_INCOMPLETE:
      case AD_UUID128_COMPLETE:
        for (let i = 0; i + 15 < payload.length; i += 16) {
          out.serviceUuids.push(uuid128(payload, i));
        }
        break;
      case AD_SERVICE_DATA_16:
        if (payload.length >= 2) {
          out.serviceData[hex16(payload, 0)] = payload.subarray(2);
        }
        break;
      case AD_SERVICE_DATA_32:
        if (payload.length >= 4) {
          out.serviceData[uuid32(payload, 0)] = payload.subarray(4);
        }
        break;
      case AD_SERVICE_DATA_128:
        if (payload.length >= 16) {
          out.serviceData[uuid128(payload, 0)] = payload.subarray(16);
        }
        break;
      case AD_MANUFACTURER:
        if (payload.length >= 2) {
          out.manufacturerData[hex16(payload, 0)] = payload.subarray(2);
        }
        break;
      default:
        break; // unknown structure — skip
    }
    at = end;
  }

  if (out.localName === null && shortName !== null) {
    out.localName = shortName;
  }
  return out;
}

/** Parse the iOS object form (CoreBluetooth keys, base64 values). */
function parseObject(adv) {
  const out = empty();
  if (typeof adv.localName === 'string') {
    out.localName = adv.localName;
  }
  if (typeof adv.txPowerLevel === 'number') {
    out.txPowerLevel = adv.txPowerLevel;
  }
  if (adv.isConnectable !== undefined && adv.isConnectable !== null) {
    out.connectable = !!adv.isConnectable;
  }
  for (const uuid of adv.serviceUuids || []) {
    out.serviceUuids.push(normalizeUuid(uuid));
  }
  const serviceData = adv.serviceData || {};
  for (const uuid of Object.keys(serviceData)) {
    out.serviceData[normalizeUuid(uuid)] = base64ToBytes(serviceData[uuid]);
  }
  if (adv.manufacturerData) {
    // One blob on iOS: company id is its first two bytes, little-endian.
    const bytes = base64ToBytes(adv.manufacturerData);
    if (bytes.length >= 2) {
      out.manufacturerData[hex16(bytes, 0)] = bytes.subarray(2);
    }
  }
  return out;
}

/**
 * Normalize any scan result advertisement — Android base64 string / raw
 * bytes, or an iOS parsed object — into the one documented shape.
 */
function parse(advertisement) {
  if (advertisement === undefined || advertisement === null || advertisement === '') {
    return empty();
  }
  if (typeof advertisement === 'string') {
    return parseRaw(base64ToBytes(advertisement));
  }
  if (advertisement instanceof Uint8Array) {
    return parseRaw(advertisement);
  }
  if (typeof advertisement === 'object') {
    return parseObject(advertisement);
  }
  return empty();
}

module.exports = { parse, parseRaw, normalizeUuid, empty };

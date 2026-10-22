// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. And the frozen
// identity rule of a zone.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { DEFAULT_PORT, LIMITS, MAX_VOLUME, RUSSOUND_VOLUME_MAX } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  addresses: '',
  max_volume: MAX_VOLUME.default,
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * The address of a controller typed by the user: an IPv4 address or a host
 * name, with an optional port (a pasted `tcp://` URL is reduced to its host
 * and port). A serial port (COM3, /dev/ttyUSB0) is not an address: refused.
 * @returns {{ host: string, port: number } | undefined} undefined when invalid or empty.
 */
export function parseAddress(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^(?:tcp|telnet):\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
  if (text === '' || text.length > 260) {
    return undefined;
  }
  const match = text.match(/^([^:]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    return { host, port };
  }
  if (/^[\d.]+$/.test(host) || /^com\d{1,3}$/.test(host)) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

export const addressKey = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}:${port}`);

/** The id of an address: the host, plus `_<port>` when not 9621 (`_` never appears in a host). */
export const addressId = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}_${port}`);

/**
 * The platform id of a zone, frozen (it makes the external ids): the address
 * id, then `_c<controller>_z<zone>`, for example `192.168.1.40_c1_z3`. The
 * RIO protocol gives no serial number per zone, and the MAC address of the
 * controller is not always readable: the address is the identity (fixed IP
 * address asked in the docs), the MAC address only checks it.
 */
export const zoneId = (address, controller, zone) =>
  `${addressId(address)}_c${controller}_z${zone}`;

const ZONE_ID = /^([^_]{1,253})(?:_(\d{1,5}))?_c(\d)_z(\d{1,2})$/;

/** A zone id -> { host, port, controller, zone }, or undefined when not one of ours. */
export function parseZoneId(id) {
  const match = typeof id === 'string' ? ZONE_ID.exec(id) : null;
  if (!match) {
    return undefined;
  }
  const address = parseAddress(match[2] === undefined ? match[1] : `${match[1]}:${match[2]}`);
  const controller = Number(match[3]);
  const zone = Number(match[4]);
  if (
    !address ||
    controller < 1 ||
    controller > LIMITS.controllers ||
    zone < 1 ||
    zone > LIMITS.zonesPerController
  ) {
    return undefined;
  }
  return zoneId(address, controller, zone) === id ? { ...address, controller, zone } : undefined;
}

function parseInteger(raw, { min, max, default: fallback }) {
  const value = typeof raw === 'string' && raw.trim() === '' ? NaN : Number(raw);
  if (raw === null || raw === undefined || typeof raw === 'boolean' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** The cap on the Russound scale: an integer 1..50; anything unreadable gives the default (25). */
export const parseMaxVolume = (raw) => parseInteger(raw, MAX_VOLUME);

export function normalizeConfig(raw = {}) {
  const c = {
    ...DEFAULT_CONFIG,
    ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v != null)),
  };
  const addresses = [];
  const invalid = [];
  for (const entry of String(c.addresses ?? '')
    .split(/[\s,;]+/)
    .filter((e) => e !== '')) {
    const address = parseAddress(entry);
    if (!address) {
      invalid.push(entry.slice(0, 100));
    } else if (
      !addresses.some((a) => addressKey(a) === addressKey(address)) &&
      addresses.length < LIMITS.addresses
    ) {
      addresses.push(address);
    }
  }
  return { addresses, invalid, maxVolume: parseMaxVolume(c.max_volume) };
}

/** Gladys percent (0..100) -> Russound volume (0..cap), never above the cap. */
export function percentToVolume(percent, { maxVolume }) {
  const cap = Math.min(maxVolume, RUSSOUND_VOLUME_MAX);
  return Math.max(0, Math.min(cap, Math.round((cap * percent) / 100)));
}

/** Russound volume -> Gladys percent; above the cap shows 100. */
export function volumeToPercent(volume, { maxVolume }) {
  return Math.max(0, Math.min(100, Math.round((volume * 100) / maxVolume)));
}

// -----------------------------------------------------------------------------
// What the integration keeps across restarts, in /data (the one writable
// volume, file mode 0600): the known zones by zone id (address, controller,
// zone, name, the sources they have shown: the "Source" dropdown only grows)
// and, per address, the MAC address of the controller (to tell a DHCP swap),
// the time of the last connection attempt and the failures in a row (so a
// restart never asks the controller sooner than the interval). No secret: the
// RIO port has none.
//
// The tables have no prototype; a zone is kept only under the id of its own,
// valid address and numbers.
// -----------------------------------------------------------------------------

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { addressId, parseAddress, parseZoneId } from './config.js';
import { LIMITS } from './constants.js';
import { cleanText, parseMac } from './russound/protocol.js';

export const emptyData = () => ({
  zones: Object.create(null),
  addresses: Object.create(null),
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const SOURCE_VALUE = /^(?:[1-9]|1[0-6])$/;
export const isSourceValue = (value) => typeof value === 'string' && SOURCE_VALUE.test(value);

export function sanitizeOptions(options) {
  const seen = new Set();
  const result = [];
  for (const option of Array.isArray(options) ? options.slice(0, LIMITS.sources * 4) : []) {
    if (
      isObject(option) &&
      isSourceValue(option.value) &&
      !seen.has(option.value) &&
      result.length < LIMITS.sources
    ) {
      seen.add(option.value);
      result.push({
        value: option.value,
        label: cleanText(option.label) ?? `Source ${option.value}`,
      });
    }
  }
  return result;
}

const time = (value) => (Number.isFinite(value) && value > 0 ? value : undefined);

function sanitize(data) {
  const base = emptyData();
  if (!isObject(data)) {
    return base;
  }
  for (const [id, zone] of Object.entries(isObject(data.zones) ? data.zones : {}).slice(
    0,
    LIMITS.zones,
  )) {
    const parsed = parseZoneId(id);
    if (!parsed || !isObject(zone) || zone.id !== id) {
      continue;
    }
    base.zones[id] = {
      id,
      host: parsed.host,
      port: parsed.port,
      controller: parsed.controller,
      zone: parsed.zone,
      name: cleanText(zone.name),
      sourceOptions: sanitizeOptions(zone.sourceOptions),
    };
  }
  for (const [key, entry] of Object.entries(isObject(data.addresses) ? data.addresses : {}).slice(
    0,
    LIMITS.addresses * 4,
  )) {
    const [host, port] = key.split('_');
    const address = parseAddress(port === undefined ? host : `${host}:${port}`);
    if (!address || addressId(address) !== key || !isObject(entry)) {
      continue;
    }
    base.addresses[key] = {
      mac: parseMac(entry.mac),
      lastAttempt: time(entry.lastAttempt),
      failures: Number.isInteger(entry.failures) ? Math.min(Math.max(entry.failures, 0), 64) : 0,
    };
  }
  return base;
}

export class FileStore {
  constructor({ dir = process.env.DATA_DIR || '/data', name = 'russound.json' } = {}) {
    this.dir = dir;
    this.path = join(dir, name);
    this.corrupted = false;
  }

  /**
   * The saved data. An unreadable file is moved aside to `russound.json.bad`
   * and `corrupted` is set, so the app says so instead of silently starting over.
   */
  async load() {
    let text;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      return emptyData();
    }
    try {
      return sanitize(JSON.parse(text));
    } catch {
      this.corrupted = true;
      const bad = `${this.path}.bad`;
      await rename(this.path, bad).catch(() => {});
      await chmod(bad, 0o600).catch(() => {});
      return emptyData();
    }
  }

  async save(data) {
    await mkdir(this.dir, { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

/** For the tests. */
export class MemoryStore {
  constructor(data = emptyData()) {
    this.data = JSON.parse(JSON.stringify(data));
    this.saves = 0;
    this.corrupted = false;
  }

  async load() {
    return sanitize(JSON.parse(JSON.stringify(this.data)));
  }

  async save(data) {
    // Through JSON, as the file store: what a restart would read back.
    this.data = JSON.parse(JSON.stringify(data));
    this.saves += 1;
  }
}

export { sanitize as sanitizeData };

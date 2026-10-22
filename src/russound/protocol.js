// -----------------------------------------------------------------------------
// The Russound RIO protocol, as aiorussound (MIT, see THIRD_PARTY_NOTICES.md)
// speaks it over TCP (port 9621): a command is one line ended by `\r`
// (`VERSION`, `GET C[1].Z[2].volume`, `WATCH C[1].Z[2] ON`,
// `EVENT C[1].Z[2]!KeyPress Volume 20`); the controller answers `S` (done),
// `S <key>="<value>"` (a value read) or `E <message>` (refused), and, for
// what is watched, pushes `N <key>="<value>"` on every change.
//
// Everything here is pure and bounded: commands are built from a closed list
// (numbers only as arguments, never a text from the controller or the user),
// lines are cut at LIMITS.line, every line is matched once by an anchored
// expression, values are parsed strictly, the state tables have no prototype.
// -----------------------------------------------------------------------------

import { LIMITS, RUSSOUND_VOLUME_MAX } from '../constants.js';

// --- Commands --------------------------------------------------------------------

const inRange = (n, max) => Number.isInteger(n) && n >= 1 && n <= max;
const LEAF = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

export const controllerPath = (c) => `C[${c}]`;
export const zonePath = (c, z) => `C[${c}].Z[${z}]`;
export const sourcePath = (s) => `S[${s}]`;

const PATH = /^(?:C\[(\d)\](?:\.Z\[(\d{1,2})\])?|S\[(\d{1,2})\])$/;

function checkPath(path) {
  const match = PATH.exec(String(path));
  if (!match) {
    throw new Error('Invalid RIO path');
  }
  const [, c, z, s] = match;
  const ok =
    s !== undefined
      ? inRange(Number(s), LIMITS.sources)
      : inRange(Number(c), LIMITS.controllers) &&
        (z === undefined || inRange(Number(z), LIMITS.zonesPerController));
  if (!ok) {
    throw new Error('Invalid RIO path');
  }
  return path;
}

/** The zone events written by this integration, with their only allowed argument. */
const EVENTS = Object.freeze({
  ZoneOn: () => '',
  ZoneOff: () => '',
  ZoneMuteOn: () => '',
  ZoneMuteOff: () => '',
  Volume: (n) => {
    if (!Number.isInteger(n) || n < 0 || n > RUSSOUND_VOLUME_MAX) {
      throw new Error('Invalid volume');
    }
    return ` ${n}`;
  },
  SelectSource: (n) => {
    if (!inRange(n, LIMITS.sources)) {
      throw new Error('Invalid source');
    }
    return ` ${n}`;
  },
});

/**
 * A request object -> its line (without the `\r`). Kinds: `version`,
 * `get` (path, leaf), `watch` (path), `event` (c, z, name, arg).
 */
export function commandLine(request) {
  switch (request?.kind) {
    case 'version':
      return 'VERSION';
    case 'get':
      if (!LEAF.test(String(request.leaf))) {
        throw new Error('Invalid RIO leaf');
      }
      return `GET ${checkPath(request.path)}.${request.leaf}`;
    case 'watch':
      return `WATCH ${checkPath(request.path)} ON`;
    case 'event': {
      const path = checkPath(zonePath(request.c, request.z));
      if (!Object.hasOwn(EVENTS, request.name)) {
        throw new Error('Invalid RIO event');
      }
      const arg = EVENTS[request.name](request.arg);
      // Volume is a key press, as aiorussound sends it.
      return request.name === 'Volume'
        ? `EVENT ${path}!KeyPress Volume${arg}`
        : `EVENT ${path}!${request.name}${arg}`;
    }
    default:
      throw new Error('Unknown RIO request');
  }
}

/** The bytes of one request: its line, then `\r`. */
export const encode = (request) => Buffer.from(`${commandLine(request)}\r`, 'latin1');

export const versionRequest = () => ({ kind: 'version' });
export const getRequest = (path, leaf) => ({ kind: 'get', path, leaf });
export const watchRequest = (path) => ({ kind: 'watch', path });
export const eventRequest = (c, z, name, arg) => ({ kind: 'event', c, z, name, arg });

// --- Lines -------------------------------------------------------------------------

// Control characters are refused in a key or value, on purpose.
const KEYED =
  // eslint-disable-next-line no-control-regex
  /^((?:[A-Za-z]{1,16}(?:\[\d{1,2}\])?\.){0,4})([A-Za-z][A-Za-z0-9]{0,31})="([^\x00-\x1f\x7f]*)"$/;

/**
 * One line of the controller -> a message, or undefined (ignored):
 * `{ type: 'S' | 'N', branch, leaf, value }` (branch '' for `VERSION`,
 * value null for an empty value or `------`), `{ type: 'S' }` for a bare
 * `S`, `{ type: 'E', message }`.
 */
export function parseLine(text) {
  const line = String(text).trim();
  if (line === 'S') {
    return { type: 'S' };
  }
  const type = line[0];
  if (line[1] !== ' ' || !['S', 'N', 'E'].includes(type)) {
    return undefined;
  }
  const payload = line.slice(2).trim();
  if (type === 'E') {
    return { type: 'E', message: cleanText(payload, 120) ?? 'error' };
  }
  const match = KEYED.exec(payload);
  if (!match) {
    return undefined;
  }
  const value = match[3] === '' || match[3] === '------' ? null : match[3];
  return { type, branch: match[1].slice(0, -1), leaf: match[2], value };
}

/** The target of a branch: a zone, a source, a controller, or undefined (ignored). */
export function parseBranch(branch) {
  let m = /^C\[(\d)\]\.Z\[(\d{1,2})\]$/.exec(branch);
  if (m) {
    const c = Number(m[1]);
    const z = Number(m[2]);
    return inRange(c, LIMITS.controllers) && inRange(z, LIMITS.zonesPerController)
      ? { kind: 'zone', id: `${c}.${z}`, c, z }
      : undefined;
  }
  m = /^S\[(\d{1,2})\]$/.exec(branch);
  if (m) {
    const s = Number(m[1]);
    return inRange(s, LIMITS.sources) ? { kind: 'source', id: String(s), s } : undefined;
  }
  m = /^C\[(\d)\]$/.exec(branch);
  if (m) {
    const c = Number(m[1]);
    return inRange(c, LIMITS.controllers) ? { kind: 'controller', id: String(c), c } : undefined;
  }
  return undefined;
}

// --- Values --------------------------------------------------------------------------

export function parseOnOff(value) {
  if (/^(?:on|true)$/i.test(value ?? '')) {
    return true;
  }
  if (/^(?:off|false)$/i.test(value ?? '')) {
    return false;
  }
  return undefined;
}

/** A zone volume: an integer 0..50, else unknown. */
export function parseVolume(value) {
  if (!/^\d{1,2}$/.test(value ?? '')) {
    return undefined;
  }
  const n = Number(value);
  return n <= RUSSOUND_VOLUME_MAX ? n : undefined;
}

/** A source number 1..16, else unknown. */
export function parseSourceNumber(value) {
  if (!/^\d{1,2}$/.test(value ?? '')) {
    return undefined;
  }
  const n = Number(value);
  return inRange(n, LIMITS.sources) ? n : undefined;
}

/** A MAC address, lowercased with colons; undefined when unreadable or all zeros. */
export function parseMac(value) {
  const hex = String(value ?? '')
    .toLowerCase()
    .replace(/[:-]/g, '');
  if (!/^[0-9a-f]{12}$/.test(hex) || /^0{12}$|^f{12}$/.test(hex)) {
    return undefined;
  }
  return hex.match(/../g).join(':');
}

const VERSION = /^(\d{1,2})\.(\d{2})\.(\d{2})$/;

/** Whether the RIO version `a` is at least `b` (false when one is unreadable), as aiorussound. */
export function versionAtLeast(a, b) {
  const x = VERSION.exec(String(a ?? ''));
  const y = VERSION.exec(String(b ?? ''));
  if (!x || !y) {
    return false;
  }
  for (let i = 1; i <= 3; i += 1) {
    if (Number(x[i]) !== Number(y[i])) {
      return Number(x[i]) > Number(y[i]);
    }
  }
  return true;
}

export const isVersion = (value) => VERSION.test(String(value ?? ''));

// Control characters (C0, DEL, C1) and bidirectional overrides.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** A display text from the controller: cleaned, trimmed, cut; undefined when empty. */
export function cleanText(value, max = LIMITS.name) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.replace(UNSAFE, '').trim().slice(0, max).trim();
  return text === '' ? undefined : text;
}

// --- Controllers (facts of aiorussound) -------------------------------------------------

/** Names some firmwares give, read as the model they are (aiorussound). */
const TYPE_FIX = Object.freeze({ 'MCA-C6': 'MCA-C5', 'XStream-X5': 'XSource' });

export const fixControllerType = (type) => (Object.hasOwn(TYPE_FIX, type) ? TYPE_FIX[type] : type);

const ZONE_COUNTS = Object.freeze({
  'SMZ16-PRE': 16,
  SMZ16: 16,
  SMZ8: 8,
  'MCA-88': 8,
  'MCA-88X': 8,
  'MCA-C5': 8,
  'MCA-66': 6,
  'MCA-C3': 6,
});

/** The zones of a controller model: 1 for the ones not listed (MBX, XSource...). */
export const maxZones = (type) => (Object.hasOwn(ZONE_COUNTS, type) ? ZONE_COUNTS[type] : 1);

/** Whether a model chains other controllers over RNET (C[2]..C[6]). */
export const isRnetCapable = (type) =>
  ['SMZ8', 'MCA-88X', 'MCA-88', 'MCA-66', 'MCA-C5', 'MCA-C3'].includes(type);

// --- State -------------------------------------------------------------------------------

const ZONE_LEAVES = Object.freeze({
  name: (v) => cleanText(v ?? ''),
  status: parseOnOff,
  volume: parseVolume,
  mute: parseOnOff,
  currentSource: parseSourceNumber,
});

const SOURCE_TEXT = [
  'name',
  'songName',
  'artistName',
  'albumName',
  'channelName',
  'programServiceName',
  'radioText',
  'playStatus',
];

const CONTROLLER_LEAVES = Object.freeze({
  type: (v) => cleanText(v ?? '', 32),
  macAddress: parseMac,
});

export const emptyState = () => ({
  version: undefined,
  controllers: Object.create(null),
  zones: Object.create(null),
  sources: Object.create(null),
});

/**
 * Applies one keyed message (`S` answer or `N` push) to the state (mutated).
 * Only the known leaves of the known targets are read.
 * @returns {{ kind, id, leaf } | undefined} what changed, undefined when nothing did.
 */
export function applyMessage(state, { branch, leaf, value }) {
  if (branch === '' && leaf === 'VERSION') {
    const version = isVersion(value) ? value : undefined;
    if (version === state.version) {
      return undefined;
    }
    state.version = version;
    return { kind: 'version', id: '', leaf };
  }
  const target = parseBranch(branch);
  if (!target) {
    return undefined;
  }
  let table;
  let parse;
  if (target.kind === 'zone') {
    table = state.zones;
    parse = Object.hasOwn(ZONE_LEAVES, leaf) ? ZONE_LEAVES[leaf] : undefined;
  } else if (target.kind === 'source') {
    table = state.sources;
    parse = SOURCE_TEXT.includes(leaf) ? (v) => cleanText(v ?? '', LIMITS.nowPlaying) : undefined;
  } else {
    table = state.controllers;
    parse = Object.hasOwn(CONTROLLER_LEAVES, leaf) ? CONTROLLER_LEAVES[leaf] : undefined;
  }
  if (!parse) {
    return undefined;
  }
  if (!Object.hasOwn(table, target.id)) {
    table[target.id] = Object.create(null);
  }
  const next = parse(value);
  if (table[target.id][leaf] === next) {
    return undefined;
  }
  table[target.id][leaf] = next;
  return { kind: target.kind, id: target.id, leaf };
}

/**
 * What a source plays, as one text: "artist - song" (or the song alone),
 * else the station (channel, programme service), else undefined.
 */
export function nowPlaying(source) {
  if (!source) {
    return undefined;
  }
  const song = source.songName;
  const artist = source.artistName;
  const text = song
    ? artist
      ? `${artist} - ${song}`
      : song
    : (source.channelName ?? source.programServiceName);
  return cleanText(text, LIMITS.nowPlaying);
}

// --- Framing -------------------------------------------------------------------------------

/**
 * Splits the text of the controller into lines (`\r` or `\n`). A line longer
 * than `max` is dropped whole, up to its end, never kept growing.
 */
export class LineSplitter {
  constructor(max = LIMITS.line) {
    this.max = max;
    this.parts = [];
    this.length = 0;
    this.overflow = false;
  }

  /** @returns {string[]} the complete, non-empty lines */
  push(text) {
    const lines = [];
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
      const c = text.charCodeAt(i);
      if (c === 10 || c === 13) {
        this.add(text.slice(start, i));
        if (!this.overflow) {
          const line = this.parts.join('');
          if (line.trim() !== '') {
            lines.push(line);
          }
        }
        this.parts = [];
        this.length = 0;
        this.overflow = false;
        start = i + 1;
      }
    }
    this.add(text.slice(start));
    return lines;
  }

  add(part) {
    if (this.overflow || part === '') {
      return;
    }
    if (this.length + part.length > this.max) {
      this.overflow = true;
      this.parts = [];
      this.length = 0;
      return;
    }
    this.parts.push(part);
    this.length += part.length;
  }
}

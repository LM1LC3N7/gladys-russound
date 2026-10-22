// -----------------------------------------------------------------------------
// Frozen keys (external ids, features, manifest actions), limits and timings.
// Every key here is stored by Gladys or by its users: never rename one.
// -----------------------------------------------------------------------------

/** `gladys.externalIds(DEVICE_TYPE, <zone id>)`, see `zoneId` in src/config.js. */
export const DEVICE_TYPE = 'russound';

export const FEATURES = Object.freeze({
  /** Read only: 1 zone on, 0 zone off (or controller unreachable). */
  POWER: 'power',
  /** Push button: `EVENT C[c].Z[z]!ZoneOn`. */
  POWER_ON: 'power_on',
  /** Push button: `EVENT C[c].Z[z]!ZoneOff` (protective, never blocked). */
  STANDBY: 'standby',
  /** 0..100 %, mapped onto 0..max_volume of the Russound scale: 100 % is the cap. */
  VOLUME: 'volume',
  /** Push button: each press sets the opposite of the mute read from the zone. */
  MUTE: 'mute',
  /** Dropdown: the sources of the controller (`EVENT ...!SelectSource n`). */
  SOURCE: 'source',
  /** Read only text: what the source of the zone plays (artist, title, station). */
  NOW_PLAYING: 'now_playing',
});

export const ACTIONS = Object.freeze({
  CHECK: 'check_devices',
});

/** The RIO port of the Russound controllers (MCA, MBX...). */
export const DEFAULT_PORT = 9621;

/** The Russound volume scale (`C[c].Z[z].volume`), and the cap option on it. */
export const RUSSOUND_VOLUME_MAX = 50;
export const MAX_VOLUME = Object.freeze({ min: 1, max: RUSSOUND_VOLUME_MAX, default: 25 });

/** The oldest RIO version accepted (as aiorussound), and the one of ZoneMuteOn/Off. */
export const MIN_RIO_VERSION = '1.05.00';
export const MUTE_RIO_VERSION = '1.09.00';

export const TIMINGS = Object.freeze({
  /** Opening the TCP connection. */
  connectTimeout: 4_000,
  /** One request while connecting or polling. */
  requestTimeout: 1_500,
  /**
   * Gladys waits 5 s for the ack of a command: the whole command (wait in the
   * queues and every exchange included) gets `commandBudget`, a read made
   * before or after a command line `preRead` of it at most.
   */
  commandBudget: 3_500,
  preRead: 1_500,
  /**
   * Reconnection: first after `reconnectBase`, then doubled each time up to
   * `reconnectMax`. The count is only reset by a connection that stayed up
   * `stableAfter`.
   */
  reconnectBase: 10_000,
  reconnectMax: 5 * 60_000,
  stableAfter: 60_000,
  /** The time of the last attempt is written to /data at most this often. */
  attemptPersistEvery: 60_000,
  /** The zones are read again this often (the controller also pushes its changes). */
  pollInterval: 60_000,
  /** After a Power on whose volume could not be settled in time: checked again. */
  wakeCheckDelay: 2_500,
  wakeChecks: 6,
  /** After a Standby not confirmed: the zone read again, ZoneOff sent again if on. */
  standbyCheckDelay: 5_000,
  standbyChecks: 3,
  /** The states of one zone are published at most this often. */
  publishDelay: 1_000,
  /** Writes to /data are grouped. */
  persistDelay: 1_000,
  /** The background round: status, created devices read again. */
  tick: 30_000,
  /** More lines than this within `floodWindow`: the connection is closed (a real flood). */
  floodLines: 3_000,
  floodWindow: 10_000,
  /** The window of the global state budget. */
  budgetWindow: 60_000,
});

export const LIMITS = Object.freeze({
  addresses: 10,
  /** Zones (Gladys devices) known at most, all controllers together. */
  zones: 48,
  /** Controllers of one RIO connection (the first, and the RNET chain). */
  controllers: 6,
  /** Zones of one controller. */
  zonesPerController: 16,
  /** S[1]..S[16]. */
  sources: 16,
  /** Length of one line from the controller; longer ones are dropped. */
  line: 1_024,
  /** Requests waiting for their turn on one connection. */
  pending: 32,
  /** Length of a name (zone, source). */
  name: 64,
  /** Length of the "now playing" text. */
  nowPlaying: 160,
  /**
   * States published in a `budgetWindow`, all zones together: Gladys accepts
   * 300 a minute, a margin is kept.
   */
  statesPerWindow: 240,
});

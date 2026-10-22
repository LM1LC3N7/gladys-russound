// -----------------------------------------------------------------------------
// Known zones -> Gladys devices and states (pure). One Gladys device per zone
// of a controller.
//
// The categories and types are the ones of the Gladys core: `music/volume`
// like the core Sonos service, `television/volume-mute` for the mute press
// (music has no mute type), `text/select` for the source, `text/text` for
// what is playing, `button/push` for "Power on" and "Standby", and the power
// state read only (`unknown/binary`): no switch, nothing an "everything on /
// off" (voice assistants, scenes) could turn into a command. No unit: the
// core lists none for these categories.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { volumeToPercent } from './config.js';
import { DEVICE_TYPE, FEATURES } from './constants.js';
import { nowPlaying } from './russound/protocol.js';

/** The feature definitions, by frozen key, in their frozen order. */
export const FEATURE_SPECS = Object.freeze({
  [FEATURES.POWER]: {
    name: 'Power',
    category: C.UNKNOWN,
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
    read_only: true,
    keep_history: true,
  },
  [FEATURES.POWER_ON]: {
    name: 'Power on',
    category: C.BUTTON,
    type: T.BUTTON.PUSH,
    min: 0,
    max: 1,
  },
  [FEATURES.STANDBY]: { name: 'Standby', category: C.BUTTON, type: T.BUTTON.PUSH, min: 0, max: 1 },
  [FEATURES.VOLUME]: {
    name: 'Volume',
    category: C.MUSIC,
    type: T.MUSIC.VOLUME,
    min: 0,
    max: 100,
    has_feedback: true,
  },
  [FEATURES.MUTE]: {
    name: 'Mute',
    category: C.TELEVISION,
    type: T.TELEVISION.VOLUME_MUTE,
    min: 0,
    max: 1,
    has_feedback: true,
  },
  [FEATURES.SOURCE]: {
    name: 'Source',
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    has_feedback: true,
  },
  [FEATURES.NOW_PLAYING]: {
    name: 'Now playing',
    category: C.TEXT,
    type: T.TEXT.TEXT,
    min: 0,
    max: 0,
    read_only: true,
  },
});

/** The options of the "Source" dropdown: every source this zone has shown. */
export const sourceOptions = (zone) =>
  (Array.isArray(zone.sourceOptions) ? zone.sourceOptions : []).map(({ value, label }) => ({
    value,
    label,
  }));

export function deviceName(zone) {
  return zone.name ? `Russound ${zone.name}` : `Russound ${zone.host} zone ${zone.zone}`;
}

export function buildDevice(gladys, zone) {
  const ids = gladys.externalIds(DEVICE_TYPE, zone.id);
  return {
    name: deviceName(zone),
    external_id: ids.device,
    should_poll: false,
    params: [{ name: 'IP_ADDRESS', value: zone.host }],
    // Always the full, fixed list: a device published again never loses a feature.
    features: Object.entries(FEATURE_SPECS).map(([key, { name, ...spec }]) => ({
      name,
      external_id: ids.feature(key),
      read_only: false,
      has_feedback: false,
      keep_history: false,
      ...spec,
      ...(key === FEATURES.SOURCE ? { supported_options: sourceOptions(zone) } : {}),
    })),
  };
}

/** The feature key of a feature external id of `device`, or undefined. */
export function featureKey(deviceExternalId, featureExternalId) {
  const prefix = `${deviceExternalId}:`;
  return String(featureExternalId ?? '').startsWith(prefix)
    ? String(featureExternalId).slice(prefix.length)
    : undefined;
}

/**
 * The states of a zone. `state` is `{ zone, sources }` from a connected
 * link, `null` for a controller that does not answer (power 0 only),
 * undefined for "nothing known" (nothing published). `range` is { maxVolume }.
 */
export function stateList(gladys, zone, state, range) {
  if (state === undefined) {
    return [];
  }
  const ids = gladys.externalIds(DEVICE_TYPE, zone.id);
  const id = (key) => ids.feature(key);
  if (state === null) {
    return [{ device_feature_external_id: id(FEATURES.POWER), state: 0 }];
  }
  const z = state.zone ?? {};
  const states = [];
  if (typeof z.status === 'boolean') {
    states.push({ device_feature_external_id: id(FEATURES.POWER), state: z.status ? 1 : 0 });
  }
  if (Number.isFinite(z.volume)) {
    states.push({
      device_feature_external_id: id(FEATURES.VOLUME),
      state: volumeToPercent(z.volume, range),
    });
  }
  if (typeof z.mute === 'boolean') {
    states.push({ device_feature_external_id: id(FEATURES.MUTE), state: z.mute ? 1 : 0 });
  }
  const source = Number.isInteger(z.currentSource) ? String(z.currentSource) : undefined;
  if (source && sourceOptions(zone).some((option) => option.value === source)) {
    states.push({ device_feature_external_id: id(FEATURES.SOURCE), text: source });
  }
  if (typeof z.status === 'boolean') {
    // Off: nothing plays. On: what the source of the zone tells, '' when nothing.
    const playing =
      z.status && source && state.sources ? nowPlaying(state.sources[source]) : undefined;
    states.push({ device_feature_external_id: id(FEATURES.NOW_PLAYING), text: playing ?? '' });
  }
  return states;
}

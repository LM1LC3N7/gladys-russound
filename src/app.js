// -----------------------------------------------------------------------------
// The integration: the Russound controllers at the typed addresses, one
// persistent RIO connection per address (src/russound/link.js: pushed
// changes, a poll a minute, reconnection spaced out), one Gladys device per
// zone, the commands (validated before anything is sent, the volume capped by
// the configuration, serialized per zone, each within the 5 s Gladys waits for
// its ack and confirmed only by the value read back), the configuration button
// and the status. index.js only wires the SDK handlers to it
// (src/handlers.js).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import {
  addressId,
  addressKey,
  normalizeConfig,
  parseZoneId,
  percentToVolume,
  zoneId,
} from './config.js';
import { DEVICE_TYPE, FEATURES, LIMITS, MUTE_RIO_VERSION, TIMINGS } from './constants.js';
import { T } from './i18n.js';
import { DeviceError, ERROR_KINDS, RioLink, backoffDelay } from './russound/link.js';
import { cleanText, eventRequest, versionAtLeast } from './russound/protocol.js';
import { buildDevice, deviceName, featureKey, sourceOptions, stateList } from './model.js';
import { FileStore, emptyData, isSourceValue } from './store.js';

const BUTTONS = new Set([FEATURES.POWER_ON, FEATURES.STANDBY, FEATURES.MUTE]);

/**
 * The volume of a command, validated strictly: an integer 0..100 given as a
 * number or as a string of digits. null, '', true, 12.5, '12abc' are refused.
 * @returns {number | undefined}
 */
export function parseVolumeCommand(value) {
  let volume;
  if (typeof value === 'number') {
    volume = value;
  } else if (typeof value === 'string' && /^\s*\d{1,3}\s*$/.test(value)) {
    volume = Number(value);
  } else {
    return undefined;
  }
  return Number.isInteger(volume) && volume >= 0 && volume <= 100 ? volume : undefined;
}

const short = (value) => String(value).slice(0, 32);

const sent = (message) => new DeviceError(ERROR_KINDS.TIMEOUT, message, { sent: true });
const NO_CONFIRMATION = 'Sent, without confirmation from the controller';

export class RussoundApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'russound' }),
    store = new FileStore(),
    now = Date.now,
    timers = globalThis,
    timings = TIMINGS,
    connect,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.now = now;
    this.timers = timers;
    this.timings = timings;
    this.connect = connect;
    this.config = normalizeConfig();
    this.data = undefined;
    /** addressKey -> RioLink */
    this.links = new Map();
    /** zone id -> { running, items } */
    this.queues = new Map();
    /** ids of the zones created in Gladys */
    this.created = new Set();
    /** The last `getDevices` failed: asked again at every round until it works. */
    this.createdStale = false;
    /** zone id -> timer of the grouped publication of its states */
    this.publishTimers = new Map();
    /** feature external id -> what was last published (cleared on `connected`) */
    this.published = new Map();
    /** When each state of the budget window was published, oldest first. */
    this.budget = [];
    /** zone id -> { timer }: the one wake-up check chain of a zone (after Power on) */
    this.wakeChecks = new Map();
    /** zone id -> { timer }: the one Standby reaffirmation chain of a zone */
    this.standbyChecks = new Map();
    /** zone id -> when the last Standby / Power on was asked */
    this.standbyAt = new Map();
    this.powerOnAt = new Map();
    /** zone id -> until when a volume pushed above the cap is lowered (after Power on) */
    this.wakeWatch = new Map();
    /** ids of the zones whose volume is being lowered by watchWakeVolume */
    this.lowering = new Set();
    this.generation = 0;
    this.tickTimer = undefined;
    this.persistTimer = undefined;
    this.lastStatus = undefined;
    this.warned = new Set();
    this.started = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * (Re)start with a configuration: on every connection to Gladys and on
   * every configuration save. The links to the controllers are kept (a
   * reconnection to Gladys never drops them); what this app remembered as
   * "already published" is forgotten, since the core forgot it too.
   */
  async start(raw = {}, { connected = false } = {}) {
    this.config = normalizeConfig(raw);
    this.started = true;
    this.timers.clearInterval(this.tickTimer);
    this.tickTimer = this.timers.setInterval(() => this.tick(), this.timings.tick);
    if (connected) {
      this.lastStatus = undefined;
      this.published.clear();
      this.gladys.forgetPublishedStates?.();
    }
    if (!this.data) {
      try {
        this.data = await this.store.load();
      } catch {
        this.data = emptyData();
      }
      if (this.store.corrupted) {
        this.logger.warn('Unreadable /data/russound.json moved to russound.json.bad');
      }
    }
    await this.step('read the Gladys devices', () => this.refreshCreated());
    // A configuration save asks the silent addresses again (never sooner than
    // the base interval); a reconnection to Gladys does not: Gladys flapping
    // must never make the controllers asked faster.
    await this.step('open the links', () => this.syncLinks({ retry: !connected }));
    await this.step('publish the devices', () => this.publishDevices());
    await this.step('publish the states', () => this.publishAllStates());
    await this.step('publish the status', () => this.updateStatus());
  }

  async step(name, task) {
    try {
      await task();
    } catch (err) {
      this.logger.warn(`Start: could not ${name}: ${err.message}`);
    }
  }

  stop() {
    this.started = false;
    this.generation += 1;
    this.timers.clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    for (const link of this.links.values()) {
      link.stop();
    }
    this.links.clear();
    for (const handle of this.publishTimers.values()) {
      this.timers.clearTimeout(handle);
    }
    this.publishTimers.clear();
    for (const id of [...this.wakeChecks.keys()]) {
      this.cancelWakeCheck(id);
    }
    for (const id of [...this.standbyChecks.keys()]) {
      this.cancelStandbyCheck(id);
    }
    if (this.persistTimer) {
      this.timers.clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      return this.store.save(this.data).catch(() => {});
    }
    return Promise.resolve();
  }

  /** The background round: the created devices if unread, the status. */
  tick() {
    if (!this.data) {
      return Promise.resolve();
    }
    return Promise.resolve()
      .then(() => (this.createdStale ? this.refreshCreated() : undefined))
      .then(() => this.updateStatus())
      .catch((err) => this.logger.warn(`Background round failed: ${err.message}`));
  }

  persist() {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = undefined;
      this.store
        .save(this.data)
        .catch((err) => this.logger.warn(`Could not save /data: ${err.message}`));
    }, this.timings.persistDelay);
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  /**
   * The command queue of one zone: one command at a time. An `urgent`
   * command (mute) goes before the commands still waiting (after the other
   * urgent ones), never before the one already running.
   */
  enqueue(id, task, { urgent = false, key } = {}) {
    let queue = this.queues.get(id);
    if (!queue) {
      queue = { running: false, items: [] };
      this.queues.set(id, queue);
    }
    if (queue.items.length >= LIMITS.zoneQueue) {
      // Bounded (review 1, M6); Standby never goes through this queue.
      return Promise.reject(
        new DeviceError(ERROR_KINDS.BUDGET, 'Too many commands waiting, nothing sent'),
      );
    }
    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject, urgent, key };
      if (urgent) {
        const index = queue.items.findIndex((i) => !i.urgent);
        queue.items.splice(index === -1 ? queue.items.length : index, 0, item);
      } else {
        queue.items.push(item);
      }
      this.drain(queue);
    });
  }

  /** Drops the commands of `key` still waiting for a zone: never sent. */
  cancelQueued(id, key, message) {
    const queue = this.queues.get(id);
    if (!queue) {
      return;
    }
    const dropped = queue.items.filter((i) => i.key === key);
    queue.items = queue.items.filter((i) => i.key !== key);
    for (const item of dropped) {
      item.reject(new DeviceError(ERROR_KINDS.CANCELLED, message));
    }
  }

  async drain(queue) {
    if (queue.running) {
      return;
    }
    queue.running = true;
    while (queue.items.length > 0) {
      const item = queue.items.shift();
      try {
        item.resolve(await item.task());
      } catch (err) {
        item.reject(err);
      }
    }
    queue.running = false;
  }

  // --- Known zones and addresses --------------------------------------------------

  get zones() {
    return Object.values(this.data?.zones ?? {});
  }

  zoneOf(gladysDevice) {
    return this.zones.find(
      (z) => this.gladys.externalIds(DEVICE_TYPE, z.id).device === gladysDevice?.external_id,
    );
  }

  linkOf(zone) {
    return this.links.get(addressKey(zone));
  }

  zonesOf(link) {
    return this.zones.filter((z) => addressKey(z) === link.key);
  }

  /** The /data entry of an address, created when missing. */
  addressEntry(address) {
    const key = addressId(address);
    if (!Object.hasOwn(this.data.addresses, key)) {
      this.data.addresses[key] = { mac: undefined, lastAttempt: undefined, failures: 0 };
    }
    return this.data.addresses[key];
  }

  /**
   * What is known of a zone: `{ zone, sources }` when its controller is
   * connected, null when it does not answer (no link, another controller,
   * zone gone), undefined when nothing is known yet (first connection in
   * progress, or a connection just lost).
   */
  zoneState(zone) {
    const link = this.linkOf(zone);
    if (!link) {
      return null;
    }
    if (link.connected) {
      if (!link.hasZone(zone.controller, zone.zone)) {
        return null;
      }
      return {
        zone: link.state.zones[`${zone.controller}.${zone.zone}`],
        sources: link.state.sources,
      };
    }
    return link.lastError && !link.open ? null : undefined;
  }

  isTyped(zone) {
    return this.config.addresses.some((a) => addressKey(a) === addressKey(zone));
  }

  /**
   * The first attempt of a new link (after a restart, a configuration save):
   * never sooner than the interval since the last attempt kept in /data. That
   * time is written at most once a minute, so a minute is added to it.
   */
  firstDelay(entry) {
    if (!entry?.lastAttempt) {
      return 0;
    }
    const interval = Math.max(
      this.timings.reconnectBase,
      backoffDelay(entry.failures, this.timings),
    );
    const wait = entry.lastAttempt + this.timings.attemptPersistEvery + interval - this.now();
    return Math.max(
      0,
      Math.min(wait, this.timings.attemptPersistEvery + this.timings.reconnectMax),
    );
  }

  /**
   * One link per typed address and per address of a created zone. A known
   * zone that is neither (address removed, never created) is forgotten,
   * unless the created devices could not be read; so is the entry of an
   * address no zone and no typed address uses (its MAC address included).
   */
  syncLinks({ retry = false } = {}) {
    if (!this.started) {
      return;
    }
    if (!this.createdStale) {
      for (const zone of this.zones) {
        if (!this.isTyped(zone) && !this.created.has(zone.id)) {
          delete this.data.zones[zone.id];
          this.persist();
        }
      }
    }
    const wanted = new Map();
    for (const address of this.config.addresses) {
      wanted.set(addressKey(address), address);
    }
    for (const zone of this.zones) {
      if (this.created.has(zone.id) || this.createdStale) {
        wanted.set(addressKey(zone), { host: zone.host, port: zone.port });
      }
    }
    if (!this.createdStale) {
      const used = new Set([...wanted.values()].map(addressId));
      for (const zone of this.zones) {
        used.add(addressId(zone));
      }
      for (const key of Object.keys(this.data.addresses)) {
        if (!used.has(key)) {
          delete this.data.addresses[key];
          this.persist();
        }
      }
    }
    for (const [key, link] of this.links) {
      if (!wanted.has(key)) {
        link.stop();
        this.links.delete(key);
      }
    }
    for (const [key, address] of wanted) {
      const existing = this.links.get(key);
      if (existing) {
        if (retry) {
          existing.retrySoon();
        }
        continue;
      }
      const entry = this.data.addresses[addressId(address)];
      const link = new RioLink({
        address,
        logger: this.logger,
        timings: this.timings,
        timers: this.timers,
        now: this.now,
        connect: this.connect,
        lastAttempt: entry?.lastAttempt ?? -Infinity,
        failures: entry?.failures ?? 0,
        checkIdentity: (source, mac) => this.checkIdentity(source, mac),
        beforeAttempt: (source) => this.beforeAttempt(source),
        onEvent: (event, source, extra) => this.linkEvent(event, source, extra),
      });
      this.links.set(key, link);
      link.start(this.firstDelay(entry));
    }
  }

  /**
   * The MAC address read on connection, against the one known for this
   * address: unreadable is never "another controller"; the first one read is
   * kept.
   */
  checkIdentity(link, mac) {
    if (this.links.get(link.key) !== link) {
      return false;
    }
    if (!mac) {
      return true;
    }
    const entry = this.addressEntry(link);
    if (!entry.mac) {
      entry.mac = mac;
      this.persist();
      return true;
    }
    return entry.mac === mac;
  }

  /** The time of an attempt, written to /data before it (at most once a minute). */
  async beforeAttempt(link) {
    if (this.links.get(link.key) !== link || !this.data) {
      return;
    }
    const entry = this.addressEntry(link);
    const now = this.now();
    if (
      entry.lastAttempt !== undefined &&
      now - entry.lastAttempt < this.timings.attemptPersistEvery
    ) {
      return;
    }
    entry.lastAttempt = now;
    try {
      await this.store.save(this.data);
    } catch (err) {
      this.logger.warn(`Could not save /data: ${err.message}`);
    }
  }

  linkEvent(event, link, extra) {
    if (this.links.get(link.key) !== link || !this.data) {
      return;
    }
    if (event === 'up') {
      const entry = this.addressEntry(link);
      if (entry.failures !== 0) {
        entry.failures = 0;
        this.persist();
      }
      const zones = this.remember(link);
      this.logger.info(`Russound controller connected at ${link.key}: ${zones.length} zone(s)`);
      this.publishDevices().catch((err) =>
        this.logger.warn(`Could not publish the devices: ${err.message}`),
      );
      for (const zone of this.zonesOf(link)) {
        this.schedulePublish(zone.id, 0);
      }
    } else if (event === 'update') {
      this.linkUpdate(link, extra);
    } else if (event === 'failed' || event === 'down') {
      const entry = this.addressEntry(link);
      if (entry.failures !== link.failures) {
        entry.failures = link.failures;
        this.persist();
      }
      // The zones known at this address: power 0 when it does not answer.
      for (const zone of this.zonesOf(link)) {
        this.schedulePublish(zone.id, 0);
      }
    }
    this.updateStatus().catch(() => {});
  }

  linkUpdate(link, change) {
    if (!link.connected) {
      return;
    }
    if (change.kind === 'zone') {
      const [c, z] = change.id.split('.').map(Number);
      const id = zoneId(link, c, z);
      const zone = Object.hasOwn(this.data.zones, id) ? this.data.zones[id] : undefined;
      if (!zone) {
        return;
      }
      if (change.leaf === 'name' && this.updateName(zone, link)) {
        this.publishDevices().catch(() => {});
      }
      if (change.leaf === 'currentSource' && this.mergeSources(zone, link)) {
        this.publishDevices().catch(() => {});
      }
      if (change.leaf === 'volume' || change.leaf === 'status') {
        this.watchWakeVolume(zone, link);
      }
      this.schedulePublish(zone.id);
    } else if (change.kind === 'source') {
      let changed = false;
      for (const zone of this.zonesOf(link)) {
        if (change.leaf === 'name') {
          changed = this.mergeSources(zone, link) || changed;
        }
        const current = link.state.zones[`${zone.controller}.${zone.zone}`]?.currentSource;
        if (String(current) === change.id) {
          this.schedulePublish(zone.id);
        }
      }
      if (changed) {
        this.publishDevices().catch(() => {});
      }
    }
  }

  updateName(zone, link) {
    const name = cleanText(link.state.zones[`${zone.controller}.${zone.zone}`]?.name);
    if (name && name !== zone.name) {
      zone.name = name;
      this.persist();
      return true;
    }
    return false;
  }

  /** The zones found on the controller of `link`, remembered by their zone id. */
  remember(link) {
    const result = [];
    for (const { c, z } of link.zoneList) {
      const id = zoneId(link, c, z);
      let zone = Object.hasOwn(this.data.zones, id) ? this.data.zones[id] : undefined;
      if (!zone) {
        if (Object.keys(this.data.zones).length >= LIMITS.zones) {
          this.warnOnce('zones', `More than ${LIMITS.zones} zones: the next ones are ignored`);
          continue;
        }
        zone = {
          id,
          host: link.host,
          port: link.port,
          controller: c,
          zone: z,
          name: undefined,
          sourceOptions: [],
        };
        this.data.zones[id] = zone;
        this.persist();
      }
      this.updateName(zone, link);
      this.mergeSources(zone, link);
      result.push(zone);
    }
    return result;
  }

  /**
   * The dropdown only grows: the named sources of the controller (relabelled
   * when renamed), then any source a zone was seen on. True when it changed.
   */
  mergeSources(zone, link) {
    const options = sourceOptions(zone);
    let changed = false;
    const offer = (value, label, relabel) => {
      if (!isSourceValue(value)) {
        return;
      }
      const option = options.find((o) => o.value === value);
      if (option) {
        if (relabel && label && option.label !== label) {
          option.label = label;
          changed = true;
        }
      } else if (options.length < LIMITS.sources) {
        options.push({ value, label: label ?? `Source ${value}` });
        changed = true;
      }
    };
    for (const s of link?.sourceList ?? []) {
      offer(String(s), cleanText(link.state.sources[String(s)]?.name), true);
    }
    const current = link?.state.zones[`${zone.controller}.${zone.zone}`]?.currentSource;
    if (Number.isInteger(current)) {
      offer(String(current), cleanText(link.state.sources[String(current)]?.name), false);
    }
    if (changed) {
      options.sort((a, b) => Number(a.value) - Number(b.value));
      zone.sourceOptions = options;
      this.persist();
    }
    return changed;
  }

  /**
   * The source options of the device created in Gladys (`gladys.devices`,
   * kept up to date by the SDK), merged into the known zone: options seen
   * before a reset of /data are never dropped from the created device.
   */
  mergeCreatedOptions(zone) {
    const externalId = this.gladys.externalIds(DEVICE_TYPE, zone.id).device;
    const created = (Array.isArray(this.gladys.devices) ? this.gladys.devices : []).find(
      (d) => d?.external_id === externalId,
    );
    const feature = (Array.isArray(created?.features) ? created.features : []).find(
      (f) => f?.external_id === `${externalId}:${FEATURES.SOURCE}`,
    );
    const options = Array.isArray(feature?.supported_options) ? feature.supported_options : [];
    const own = sourceOptions(zone);
    let changed = false;
    for (const option of options) {
      if (
        isSourceValue(option?.value) &&
        !own.some((o) => o.value === option.value) &&
        own.length < LIMITS.sources
      ) {
        own.push({ value: option.value, label: cleanText(option.label) ?? option.value });
        changed = true;
      }
    }
    if (changed) {
      own.sort((a, b) => Number(a.value) - Number(b.value));
      zone.sourceOptions = own;
      this.persist();
    }
  }

  async publishDevices() {
    if (!this.data) {
      return;
    }
    const zones = this.zones;
    for (const zone of zones) {
      this.mergeCreatedOptions(zone);
      const link = this.linkOf(zone);
      if (link?.connected) {
        this.mergeSources(zone, link);
      }
    }
    await this.gladys.publishDiscoveredDevices(zones.map((z) => buildDevice(this.gladys, z)));
  }

  /**
   * The zones created in Gladys. When `getDevices` fails, the list the SDK
   * keeps (`gladys.devices`) is used, and the call is made again at every
   * round until it works. A created zone unknown to /data (file reset) is
   * found again from its external id, which holds its address and numbers.
   */
  async refreshCreated() {
    let list;
    try {
      list = await this.gladys.getDevices();
      this.createdStale = false;
    } catch (err) {
      this.createdStale = true;
      if (!Array.isArray(this.gladys.devices)) {
        throw err;
      }
      this.logger.warn(`Could not read the Gladys devices (${err.message}): using the last list`);
      list = this.gladys.devices;
    }
    const prefix = this.gladys.externalIds(DEVICE_TYPE, '').device;
    const created = new Set();
    for (const gladysDevice of Array.isArray(list) ? list : []) {
      const externalId = gladysDevice?.external_id;
      if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) {
        continue;
      }
      const id = externalId.slice(prefix.length);
      const parsed = parseZoneId(id);
      if (!parsed) {
        continue;
      }
      if (!Object.hasOwn(this.data.zones, id)) {
        if (Object.keys(this.data.zones).length >= LIMITS.zones) {
          continue;
        }
        this.data.zones[id] = {
          id,
          host: parsed.host,
          port: parsed.port,
          controller: parsed.controller,
          zone: parsed.zone,
          name: cleanText(gladysDevice.name?.replace?.(/^Russound /, '')),
          sourceOptions: [],
        };
        this.persist();
      }
      created.add(id);
    }
    this.created = created;
  }

  // --- States --------------------------------------------------------------------

  /**
   * The states of a zone, grouped: at most one publication per
   * `publishDelay`, and all zones together under the global budget.
   */
  schedulePublish(id, delay = this.timings.publishDelay) {
    if (this.publishTimers.has(id)) {
      if (delay > 0) {
        return;
      }
      this.timers.clearTimeout(this.publishTimers.get(id));
    }
    const generation = this.generation;
    const handle = this.timers.setTimeout(() => {
      this.publishTimers.delete(id);
      if (generation !== this.generation) {
        return;
      }
      const zone = this.data?.zones?.[id];
      if (zone) {
        this.publishStates(zone).catch(() => {});
      }
    }, delay);
    this.publishTimers.set(id, handle);
  }

  /**
   * Publishes what changed in a zone. The budget (LIMITS.statesPerWindow per
   * `budgetWindow`, all zones together, under the 300 states a minute of
   * Gladys) is reserved synchronously, before any await: two publications at
   * the same time can never both pass it. Over it, the publication waits for
   * room in the window.
   */
  async publishStates(zone) {
    if (!this.created.has(zone.id)) {
      return;
    }
    const states = stateList(this.gladys, zone, this.zoneState(zone), this.config).filter(
      (s) => this.published.get(s.device_feature_external_id) !== publishedKey(s),
    );
    if (states.length === 0) {
      return;
    }
    const now = this.now();
    while (this.budget.length > 0 && now - this.budget[0] >= this.timings.budgetWindow) {
      this.budget.shift();
    }
    if (this.budget.length + states.length > LIMITS.statesPerWindow) {
      const wait = this.budget[0] + this.timings.budgetWindow - now;
      this.warnOnce('budget', 'Too many state changes: publications slowed down');
      this.schedulePublish(zone.id, Math.max(wait, this.timings.publishDelay));
      return;
    }
    for (const state of states) {
      this.budget.push(now);
      this.published.set(state.device_feature_external_id, publishedKey(state));
    }
    const generation = this.generation;
    try {
      await this.gladys.publishChangedStates(states);
    } catch (err) {
      if (generation === this.generation) {
        // Published again at the next change or connection.
        for (const state of states) {
          this.published.delete(state.device_feature_external_id);
        }
      }
      this.logger.warn(`Could not publish the states of ${deviceName(zone)}: ${err.message}`);
    }
  }

  async publishAllStates() {
    for (const zone of this.zones) {
      await this.publishStates(zone);
    }
  }

  /** The Discovery scan of Gladys: the silent addresses asked again, the list published. */
  async scan() {
    this.syncLinks({ retry: true });
    await this.publishDevices();
    return this.zones;
  }

  // --- Commands --------------------------------------------------------------------

  /** Validates a command before anything is queued or sent. */
  validate(zone, key, value) {
    if (key === FEATURES.VOLUME) {
      const volume = parseVolumeCommand(value);
      if (volume === undefined) {
        throw new Error(`Invalid volume "${short(value)}": an integer from 0 to 100`);
      }
      return volume;
    }
    if (key === FEATURES.SOURCE) {
      if (typeof value !== 'string' || !sourceOptions(zone).some((o) => o.value === value)) {
        throw new Error(`Unknown source "${short(value)}"`);
      }
      return Number(value);
    }
    if (BUTTONS.has(key)) {
      return undefined;
    }
    throw new Error(`Feature "${short(key)}" cannot be commanded`);
  }

  async setValue(gladysDevice, feature, value) {
    const zone = this.zoneOf(gladysDevice);
    if (!zone) {
      throw new Error(`Unknown device ${short(gladysDevice?.external_id)}`);
    }
    const key = featureKey(gladysDevice.external_id, feature?.external_id);
    const checked = this.validate(zone, key, value);
    // The budget runs from the request of Gladys, the wait in the queues included.
    const started = this.now();
    let late = false;
    // Set just before a command line leaves: from then on, it may have
    // reached the controller, whatever happens next.
    const context = { mayHaveSent: false };
    let run;
    if (key === FEATURES.STANDBY) {
      // Standby is never stuck behind the other commands: it skips the zone
      // queue (and goes first on the connection), and cancels a Power on
      // still waiting and the volume checks after a wake-up.
      this.standbyAt.set(zone.id, started);
      this.wakeWatch.delete(zone.id);
      this.cancelWakeCheck(zone.id);
      // Source and Volume may turn a zone on again (review 1, I2): cancelled
      // too; the one already running is stopped by its `shouldSend`.
      for (const queued of [FEATURES.POWER_ON, FEATURES.SOURCE, FEATURES.VOLUME]) {
        this.cancelQueued(zone.id, queued, 'Cancelled by Standby, nothing sent');
      }
      run = this.standby(zone, started, context);
    } else {
      if (key === FEATURES.POWER_ON) {
        this.powerOnAt.set(zone.id, started);
      }
      run = this.enqueue(
        zone.id,
        async () => {
          if (late || this.remaining(started) < 50) {
            // Gladys stopped waiting while this command was queued: dropped, never sent late.
            late = true;
            throw new DeviceError(
              ERROR_KINDS.BUDGET,
              'No time left for this command, nothing sent',
            );
          }
          return this.command(zone, key, checked, started, context);
        },
        { urgent: key === FEATURES.MUTE, key },
      );
    }
    // Wall-clock deadline (not the injectable timers): the ack Gladys waits for.
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => {
          late = true;
          reject(
            context.mayHaveSent
              ? sent(NO_CONFIRMATION)
              : new DeviceError(
                  ERROR_KINDS.BUDGET,
                  'No time left for this command (controller busy), nothing sent',
                ),
          );
        },
        Math.max(0, this.remaining(started)) + 100,
      );
    });
    run.catch(() => {});
    try {
      return await Promise.race([run, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  remaining(started) {
    return this.timings.commandBudget - (this.now() - started);
  }

  /** Time for one read, out of what is left of a command. */
  readBudget(started) {
    return Math.min(this.timings.preRead, this.remaining(started) - 50);
  }

  /**
   * Writes one event and waits for the `S` of the controller. A line that
   * may have reached the controller is never reported as "not sent":
   * "sent, without confirmation".
   *
   * Every line but Standby's (`priority`) is dropped right before the write
   * when a Standby was asked after the command (review 1, I2), and is never
   * written with less than `minSendBudget` left (review 1, I1).
   */
  async send(zone, link, name, arg, started, context, { priority = false, shouldSend } = {}) {
    const notOverridden = () => (this.standbyAt.get(zone.id) ?? -Infinity) < started;
    try {
      return await link.exchange(
        eventRequest(zone.controller, zone.zone, name, arg),
        this.remaining(started),
        {
          priority,
          shouldSend: priority ? shouldSend : (shouldSend ?? notOverridden),
          minRemaining: priority ? 0 : this.timings.minSendBudget,
          onSent: () => {
            context.mayHaveSent = true;
          },
        },
      );
    } catch (err) {
      throw this.sendError(zone, err);
    }
  }

  sendError(zone, err) {
    if (err.kind === ERROR_KINDS.TIMEOUT || err.kind === ERROR_KINDS.CLOSED) {
      return sent(NO_CONFIRMATION);
    }
    if (err.kind === ERROR_KINDS.UNREACHABLE) {
      return new DeviceError(err.kind, `${deviceName(zone)} is not connected: nothing sent`);
    }
    if (err.kind === ERROR_KINDS.BUDGET) {
      return new DeviceError(err.kind, 'No time left for this command, nothing sent');
    }
    if (err.kind === ERROR_KINDS.CANCELLED) {
      return new DeviceError(err.kind, 'Cancelled by Standby, nothing sent');
    }
    return err;
  }

  /**
   * A read made before a command line, to decide on the state read again
   * (never on the state in memory): whatever goes wrong, nothing was sent.
   */
  async readBefore(zone, link, leaf, what, started) {
    const budget = this.readBudget(started);
    if (!(budget > 0)) {
      throw new DeviceError(ERROR_KINDS.BUDGET, `${what} not read in time: nothing sent`);
    }
    try {
      return await link.readZone(zone.controller, zone.zone, leaf, budget);
    } catch (err) {
      if (err.kind === ERROR_KINDS.UNREACHABLE) {
        throw new DeviceError(err.kind, `${deviceName(zone)} is not connected: nothing sent`);
      }
      throw new DeviceError(ERROR_KINDS.BUDGET, `${what} not read in time: nothing sent`);
    }
  }

  /**
   * After a command line: the value read back must be the one asked, else
   * "sent, without confirmation".
   */
  async confirm(zone, link, leaf, expected, started, message = NO_CONFIRMATION) {
    const budget = this.readBudget(started);
    let value;
    if (budget > 0) {
      value = await link.readZone(zone.controller, zone.zone, leaf, budget).catch(() => undefined);
    }
    if (typeof expected === 'function' ? !expected(value) : value !== expected) {
      throw sent(message);
    }
  }

  /** The link of a zone, connected, with the zone still on the controller; else nothing sent. */
  connectedLink(zone) {
    const link = this.linkOf(zone);
    if (!link?.connected) {
      throw new DeviceError(
        ERROR_KINDS.UNREACHABLE,
        `${deviceName(zone)} is not connected (off or unreachable): nothing sent`,
      );
    }
    if (!link.hasZone(zone.controller, zone.zone)) {
      throw new DeviceError(
        ERROR_KINDS.UNREACHABLE,
        `${deviceName(zone)} is no longer found on the controller: nothing sent`,
      );
    }
    return link;
  }

  async command(zone, key, value, started, context) {
    const link = this.connectedLink(zone);
    switch (key) {
      case FEATURES.POWER_ON:
        return this.powerOn(zone, link, started, context);
      case FEATURES.VOLUME: {
        // The cap is read here, just before the line leaves: a configuration
        // saved while the command waited in the queue applies. 100 % is the cap.
        const target = percentToVolume(value, this.config);
        await this.send(zone, link, 'Volume', target, started, context);
        await this.confirm(zone, link, 'volume', target, started);
        return undefined;
      }
      case FEATURES.MUTE:
        return this.mute(zone, link, started, context);
      case FEATURES.SOURCE: {
        // Selecting a source may turn a zone on, at its turn-on volume,
        // without any check of the cap (review 1, I3): only on a zone read
        // on just before.
        const on = await this.readBefore(zone, link, 'status', 'Zone state', started);
        if (on !== true) {
          throw new DeviceError(
            ERROR_KINDS.REFUSED,
            `${deviceName(zone)} is off (or its state unknown): turn it on first, nothing sent`,
          );
        }
        await this.send(zone, link, 'SelectSource', value, started, context);
        await this.confirm(zone, link, 'currentSource', value, started);
        return undefined;
      }
      default:
        throw new Error(`Feature "${short(key)}" cannot be commanded`);
    }
  }

  async powerOn(zone, link, started, context) {
    // A new press starts over: the check chain of the previous one stops.
    this.cancelWakeCheck(zone.id);
    // A Standby asked after this press wins: checked again right before the
    // line is written (it may wait behind a poll request on the
    // connection), and before every step after it.
    const alive = () => (this.standbyAt.get(zone.id) ?? -Infinity) < started;
    await this.send(zone, link, 'ZoneOn', undefined, started, context, { shouldSend: alive });
    if (!alive()) {
      // Written, then a Standby came after it: never acked as done (review 1, M1).
      throw sent(`${NO_CONFIRMATION} (overridden by Standby)`);
    }
    // The zone is asked on: a Standby reaffirmation of before stops.
    this.cancelStandbyCheck(zone.id);
    // A volume pushed above the cap while the zone wakes up is lowered too.
    this.wakeWatch.set(zone.id, this.now() + this.timings.wakeChecks * this.timings.wakeCheckDelay);
    try {
      await this.confirm(zone, link, 'status', true, started);
    } catch (err) {
      // Not confirmed on: the cap is still checked while it settles.
      if (alive()) {
        this.capAfterWake(zone, 1);
      }
      throw err;
    }
    // A zone turns on at its turn-on volume: brought back to the cap. Within
    // what is left of this command first, then in the background while it
    // is still settling. The ack never depends on it.
    const done = await this.capVolume(zone, link, () => this.readBudget(started), alive).catch(
      () => false,
    );
    if (!done && alive()) {
      this.capAfterWake(zone, 1);
    }
    return undefined;
  }

  async mute(zone, link, started, context) {
    if (!versionAtLeast(link.state.version, MUTE_RIO_VERSION)) {
      // Older firmwares only toggle the mute: never sent blind.
      throw new Error(
        `${deviceName(zone)}: RIO ${link.state.version} has no explicit mute (${MUTE_RIO_VERSION} at least), nothing sent`,
      );
    }
    // Gladys sends a press, not a target: the mute is read from the zone
    // just before, and the opposite is set explicitly (no toggle).
    const muted = await this.readBefore(zone, link, 'mute', 'Mute state', started);
    if (typeof muted !== 'boolean') {
      throw new Error(`${deviceName(zone)}: mute state unknown, nothing sent`);
    }
    if (muted) {
      // Unmuting never makes the zone play above the cap: the volume read
      // again decides, and is lowered first when above it.
      const volume = await this.readBefore(zone, link, 'volume', 'Volume', started);
      if (!Number.isFinite(volume)) {
        throw new Error(`${deviceName(zone)}: volume unknown, nothing sent`);
      }
      const cap = this.config.maxVolume;
      if (volume > cap) {
        this.logger.info(`${deviceName(zone)}: volume ${volume} lowered to ${cap} before unmuting`);
        try {
          await this.send(zone, link, 'Volume', cap, started, context);
        } catch (err) {
          if (err.sent) {
            throw sent(
              `${deviceName(zone)}: volume not lowered to the cap (sent, without confirmation), mute kept`,
            );
          }
          throw err;
        }
        // Unmuted only once the controller says it is at or under the cap.
        await this.confirm(
          zone,
          link,
          'volume',
          (v) => Number.isFinite(v) && v <= this.config.maxVolume,
          started,
          `${deviceName(zone)}: volume not lowered to the cap, mute kept`,
        );
      }
    }
    await this.send(zone, link, muted ? 'ZoneMuteOff' : 'ZoneMuteOn', undefined, started, context);
    await this.confirm(zone, link, 'mute', !muted, started);
    return undefined;
  }

  /**
   * Standby (protective): never queued, first on the connection, and
   * possible as soon as the controller is checked (`ready`), before the rest
   * of the snapshot: after a restart, before the first full read. When the
   * link waits for its next attempt, it is opened now.
   */
  async standby(zone, started, context) {
    const link = this.linkOf(zone);
    if (!link) {
      throw new DeviceError(
        ERROR_KINDS.UNREACHABLE,
        `${deviceName(zone)} is not connected: nothing sent`,
      );
    }
    if (!link.isReady) {
      link.connectNow();
      const ready = await link.whenReady(this.remaining(started) - 300);
      if (!ready) {
        throw new DeviceError(
          ERROR_KINDS.UNREACHABLE,
          `${deviceName(zone)} is not connected (off or unreachable): nothing sent`,
        );
      }
    }
    if (link.identified && !link.hasZone(zone.controller, zone.zone)) {
      throw new DeviceError(
        ERROR_KINDS.UNREACHABLE,
        `${deviceName(zone)} is no longer found on the controller: nothing sent`,
      );
    }
    try {
      await this.send(zone, link, 'ZoneOff', undefined, started, context, { priority: true });
      await this.confirm(zone, link, 'status', false, started);
    } catch (err) {
      if (err.sent) {
        // Sent, not confirmed: read again and sent again a few times.
        this.startStandbyCheck(zone, started);
      }
      throw err;
    }
    this.cancelStandbyCheck(zone.id);
    return undefined;
  }

  /** Cancels the Standby reaffirmation chain of a zone, if any. */
  cancelStandbyCheck(id) {
    const chain = this.standbyChecks.get(id);
    if (chain) {
      this.timers.clearTimeout(chain.timer);
      this.standbyChecks.delete(id);
    }
  }

  /**
   * After a Standby without confirmation: every `standbyCheckDelay`,
   * `standbyChecks` times at most, the zone is read again and ZoneOff sent
   * again while it is on. A failed resend keeps the chain going. A Power on
   * asked after the Standby ends it.
   */
  startStandbyCheck(zone, asked) {
    this.cancelStandbyCheck(zone.id);
    const chain = { timer: undefined };
    this.standbyChecks.set(zone.id, chain);
    const current = () =>
      this.standbyChecks.get(zone.id) === chain &&
      (this.powerOnAt.get(zone.id) ?? -Infinity) <= asked;
    const generation = this.generation;
    const next = (attempt) => {
      if (attempt > this.timings.standbyChecks) {
        this.standbyChecks.delete(zone.id);
        this.logger.warn(`${deviceName(zone)}: standby not confirmed by the controller`);
        return;
      }
      chain.timer = this.timers.setTimeout(async () => {
        if (generation !== this.generation || !current()) {
          return;
        }
        const link = this.linkOf(zone);
        let off = false;
        if (link?.isReady) {
          const status = await link
            .readZone(zone.controller, zone.zone, 'status', this.timings.preRead)
            .catch(() => undefined);
          off = status === false;
          if (status === true && current()) {
            await link
              .exchange(eventRequest(zone.controller, zone.zone, 'ZoneOff'), this.timings.preRead, {
                priority: true,
                // A Power on asked while it waits on the connection wins (review 1, M4).
                shouldSend: current,
              })
              .catch(() => {});
          }
        }
        if (!current()) {
          return;
        }
        if (off) {
          this.standbyChecks.delete(zone.id);
        } else {
          next(attempt + 1);
        }
      }, this.timings.standbyCheckDelay);
    };
    next(1);
  }

  /**
   * Reads the status and the volume, and lowers the volume to the cap when
   * the zone is on and above it. True when settled (lowered and read back at
   * or under the cap, or nothing to lower), false when the zone cannot tell
   * yet or did not confirm the lowering (the checks go on). `alive` false
   * stops it.
   */
  async capVolume(zone, link, budget, alive = () => true) {
    const { controller: c, zone: z } = zone;
    if (!(budget() > 0) || !link.connected || !alive()) {
      return false;
    }
    if ((await link.readZone(c, z, 'status', budget())) !== true || !alive()) {
      return false;
    }
    if (!(budget() > 0)) {
      return false;
    }
    const volume = await link.readZone(c, z, 'volume', budget());
    if (!Number.isFinite(volume)) {
      return false;
    }
    const cap = this.config.maxVolume;
    if (volume <= cap) {
      return true;
    }
    if (!(budget() > 0) || !alive()) {
      return false;
    }
    this.logger.info(`${deviceName(zone)}: turned on at volume ${volume}, lowered to ${cap}`);
    await link.exchange(eventRequest(c, z, 'Volume', cap), budget(), { shouldSend: alive });
    if (!(budget() > 0)) {
      return false;
    }
    // Settled only on the volume read back, never on the command alone.
    const after = await link.readZone(c, z, 'volume', budget());
    return Number.isFinite(after) && after <= this.config.maxVolume;
  }

  /**
   * A volume pushed above the cap while a zone wakes up (within the window
   * of the checks after Power on): lowered through the zone queue, one at a
   * time per zone.
   */
  watchWakeVolume(zone, link) {
    const until = this.wakeWatch.get(zone.id);
    if (until === undefined || this.now() > until || this.lowering.has(zone.id)) {
      return;
    }
    const state = link.state.zones[`${zone.controller}.${zone.zone}`];
    if (state?.status !== true || !(state.volume > this.config.maxVolume)) {
      return;
    }
    this.lowering.add(zone.id);
    this.enqueue(zone.id, () => {
      const current = this.linkOf(zone);
      return current?.connected && this.wakeWatch.has(zone.id)
        ? this.capVolume(
            zone,
            current,
            () => this.timings.preRead,
            () => this.wakeWatch.has(zone.id),
          )
        : false;
    })
      .catch(() => false)
      .finally(() => this.lowering.delete(zone.id));
  }

  /** Cancels the wake-up check chain of a zone, if any. */
  cancelWakeCheck(id) {
    const chain = this.wakeChecks.get(id);
    if (chain) {
      this.timers.clearTimeout(chain.timer);
      this.wakeChecks.delete(id);
    }
  }

  /**
   * After a Power on: the cap checked again every `wakeCheckDelay`,
   * `wakeChecks` times at most, through the zone queue. One chain per zone:
   * a new chain (another Power on) replaces the running one; Standby
   * cancels it.
   */
  capAfterWake(zone, attempt, chain = { timer: undefined }) {
    if (attempt === 1) {
      this.cancelWakeCheck(zone.id);
      this.wakeChecks.set(zone.id, chain);
    }
    const current = () => this.wakeChecks.get(zone.id) === chain;
    if (attempt > this.timings.wakeChecks) {
      this.wakeChecks.delete(zone.id);
      this.logger.info(`${deviceName(zone)}: volume not confirmed after turning on`);
      return;
    }
    const generation = this.generation;
    chain.timer = this.timers.setTimeout(() => {
      if (generation !== this.generation || !current()) {
        return;
      }
      this.enqueue(zone.id, async () => {
        const link = this.linkOf(zone);
        if (!link?.connected || !current()) {
          return !current();
        }
        return this.capVolume(zone, link, () => this.timings.preRead, current);
      })
        .catch(() => false)
        .then((done) => {
          if (!current()) {
            return;
          }
          if (done) {
            this.wakeChecks.delete(zone.id);
          } else {
            this.capAfterWake(zone, attempt + 1, chain);
          }
        });
    }, this.timings.wakeCheckDelay);
  }

  // --- Device lifecycle --------------------------------------------------------------

  async deviceCreated(gladysDevice) {
    const zone = this.zoneOf(gladysDevice);
    if (!zone) {
      return;
    }
    this.created.add(zone.id);
    this.syncLinks();
    // The SDK forgot what was published for this device: everything again.
    const prefix = `${this.gladys.externalIds(DEVICE_TYPE, zone.id).device}:`;
    for (const key of [...this.published.keys()]) {
      if (key.startsWith(prefix)) {
        this.published.delete(key);
      }
    }
    await this.publishStates(zone);
    await this.updateStatus();
  }

  async deviceDeleted(gladysDevice) {
    const zone = this.zoneOf(gladysDevice);
    if (zone) {
      this.created.delete(zone.id);
      this.syncLinks();
      await this.updateStatus();
    }
  }

  // --- Configuration screen button --------------------------------------------------

  async checkDevices() {
    if (this.zones.length === 0 && this.config.addresses.length === 0) {
      return T.noDevice;
    }
    const keys = new Set();
    const lines = [];
    for (const target of [...this.config.addresses, ...this.zones]) {
      const key = addressKey(target);
      if (keys.has(key)) {
        continue;
      }
      keys.add(key);
      const link = this.links.get(key);
      lines.push(
        T.checkController(
          `Russound ${key}`,
          link?.connected
            ? { version: link.state.version, mac: link.mac, zones: link.zoneList.length }
            : undefined,
          link?.lastError ? String(link.lastError.message).slice(0, 120) : undefined,
        ),
      );
      if (link?.connected) {
        for (const zone of this.zones.filter((z) => addressKey(z) === key)) {
          lines.push(
            T.checkZone(deviceName(zone), link.state.zones[`${zone.controller}.${zone.zone}`]),
          );
        }
      }
    }
    return T.check(lines, this.config);
  }

  // --- Status ---------------------------------------------------------------------

  /** The typed addresses where no controller answers yet (another one excluded). */
  silentAddresses() {
    return this.config.addresses
      .filter((a) => !this.zones.some((z) => addressKey(z) === addressKey(a)))
      .filter((a) => {
        const link = this.links.get(addressKey(a));
        return (
          link && !link.connected && link.lastError && link.lastError.kind !== ERROR_KINDS.IDENTITY
        );
      })
      .map(addressKey);
  }

  async updateStatus() {
    if (!this.started || !this.data) {
      return;
    }
    const generation = this.generation;
    const notes = [];
    if (this.store.corrupted) {
      notes.push(T.dataReset);
    }
    if (this.config.invalid.length > 0) {
      notes.push(T.invalidEntries(this.config.invalid));
    }
    const other = [...this.links.values()]
      .filter((l) => !l.connected && l.lastError?.kind === ERROR_KINDS.IDENTITY)
      .map((l) => l.key);
    if (other.length > 0) {
      notes.push(T.otherController(other));
    }
    const silent = this.silentAddresses();
    if (silent.length > 0) {
      notes.push(T.noAnswerAt(silent));
    }
    const off = this.zones
      .filter((z) => this.created.has(z.id) && this.zoneState(z) === null)
      .map(deviceName);
    if (off.length > 0) {
      notes.push(T.unreachable(off.slice(0, 10)));
    }
    // A local integration without an account: "connected" means running; what
    // does not answer is said in the message.
    const status = { connected: true };
    if (notes.length > 0) {
      status.message = {
        en: notes.map((n) => n.en).join(' '),
        fr: notes.map((n) => n.fr).join(' '),
      };
    }
    const key = JSON.stringify(status);
    if (key === this.lastStatus) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      if (generation === this.generation) {
        this.lastStatus = key;
      }
    } catch (err) {
      this.logger.warn(`Could not publish the status: ${err.message}`);
    }
  }
}

const publishedKey = (state) => (state.text !== undefined ? `t:${state.text}` : `n:${state.state}`);

// -----------------------------------------------------------------------------
// The persistent link with the Russound controller at one address: one TCP
// connection (RIO, port 9621 by default; never the RS-232 serial port).
//
// On connection, in this order: `VERSION` must be answered (a RIO version,
// 1.05.00 at least), `GET C[1].type` must name a controller, its MAC address
// is read (when the firmware tells it) and checked against the one known for
// this address (a DHCP swap never makes another controller "this one"; an
// unreadable MAC is never "another one"). From then on the link is `ready`:
// a Standby can be sent. Then the snapshot: the chained controllers (RNET),
// the sources, the zones and their state, and a WATCH on each zone and named
// source, so the controller pushes its changes. Then the link is `connected`.
// A poll every minute reads the MAC address and the zones again.
//
// The RIO answers (`S`, `E`) carry no request id: one exchange at a time on
// the connection (a FIFO), each answer checked against the request it ends
// (a GET answer names the key asked). An exchange without answer in time, or
// an answer that matches nothing, means the two sides are out of step: the
// connection is closed and opened again, spaced out (10 s, then doubled up to
// 5 minutes; the count is only reset by a connection that stayed up a minute).
//
// The link knows nothing of Gladys: it reports to the app through `onEvent`
// ('ready', 'up', 'update', 'down', 'failed').
// -----------------------------------------------------------------------------

import { createConnection } from 'node:net';
import { DEFAULT_PORT, LIMITS, MIN_RIO_VERSION, TIMINGS } from '../constants.js';
import {
  LineSplitter,
  applyMessage,
  controllerPath,
  emptyState,
  encode,
  fixControllerType,
  getRequest,
  isRnetCapable,
  maxZones,
  parseLine,
  parseMac,
  sourcePath,
  versionAtLeast,
  versionRequest,
  watchRequest,
  zonePath,
} from './protocol.js';

export const ERROR_KINDS = Object.freeze({
  /** No connection: nothing was sent. */
  UNREACHABLE: 'unreachable',
  /** Written, no answer in time: the controller may have done it. */
  TIMEOUT: 'timeout',
  /** The connection closed while the answer was awaited: the controller may have done it. */
  CLOSED: 'closed',
  /** Something answers, but not as a supported Russound controller. */
  PROTOCOL: 'protocol',
  /** Another controller answers at this address (another MAC address). */
  IDENTITY: 'identity',
  /** The controller answered `E`: refused, not done. */
  REFUSED: 'refused',
  /** No time left: nothing was sent. */
  BUDGET: 'budget',
  /** Dropped before it was written (a Standby asked after it): nothing was sent. */
  CANCELLED: 'cancelled',
});

export class DeviceError extends Error {
  constructor(kind, message, { sent = false } = {}) {
    super(message);
    this.name = 'DeviceError';
    this.kind = kind;
    this.sent = sent;
  }
}

/** The leaves of a zone read on connection and at every poll. */
export const ZONE_READS = Object.freeze(['status', 'volume', 'mute', 'currentSource']);

export class RioLink {
  constructor({
    address,
    onEvent = () => {},
    checkIdentity = () => true,
    beforeAttempt,
    logger,
    timings = TIMINGS,
    timers = globalThis,
    now = Date.now,
    connect = createConnection,
    lastAttempt = -Infinity,
    failures = 0,
  }) {
    this.host = address.host;
    this.port = address.port ?? DEFAULT_PORT;
    this.onEvent = onEvent;
    this.checkIdentity = checkIdentity;
    this.beforeAttempt = beforeAttempt;
    this.logger = logger;
    this.timings = timings;
    this.timers = timers;
    this.now = now;
    this.connectSocket = connect;
    this.socket = undefined;
    this.connecting = false;
    this.stopped = false;
    this.ready = false;
    this.identified = false;
    this.failures = failures;
    this.connectedAt = undefined;
    this.lastAttempt = lastAttempt;
    this.retryTimer = undefined;
    this.pollTimer = undefined;
    this.polling = false;
    this.lines = [];
    /** The last error of a connection attempt (shown by "Check" and the status). */
    this.lastError = undefined;
    this.state = emptyState();
    /** The MAC address read on this connection, when the firmware tells it. */
    this.mac = undefined;
    /** The zones found by the snapshot: [{ c, z }]. */
    this.zoneList = [];
    /** The named sources found by the snapshot: [s]. */
    this.sourceList = [];
    /** The exchange written, waiting for its answer. */
    this.current = undefined;
    /** The exchanges waiting for their turn (priority ones first). */
    this.queue = [];
    /** Promises waiting for `ready`: [{ resolve, timer }]. */
    this.readyWaiters = [];
  }

  get key() {
    return this.port === DEFAULT_PORT ? this.host : `${this.host}:${this.port}`;
  }

  get open() {
    return Boolean(this.socket) && !this.socket.destroyed;
  }

  /** The snapshot is read: every command can be sent. */
  get connected() {
    return this.open && this.identified;
  }

  /** The controller is checked (version, type, MAC): a Standby can be sent. */
  get isReady() {
    return this.open && this.ready;
  }

  hasZone(c, z) {
    return this.zoneList.some((zone) => zone.c === c && zone.z === z);
  }

  start(delay = 0) {
    this.stopped = false;
    if (delay > 0) {
      this.schedule(delay);
    } else {
      this.connect();
    }
  }

  stop() {
    this.stopped = true;
    this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.timers.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.ready = false;
    this.identified = false;
    socket?.destroy();
    this.failCurrent();
    this.settleReady(false);
  }

  /**
   * A reconnection asked now (configuration saved, Discovery scan): skips the
   * backoff, never the base interval since the last attempt.
   */
  retrySoon() {
    if (this.stopped || this.open || this.connecting) {
      return;
    }
    this.schedule(Math.max(0, this.lastAttempt + this.timings.reconnectBase - this.now()));
  }

  /**
   * A connection asked by a protective command (Standby): now, whatever the
   * backoff. A pause must never prevent turning a zone off.
   */
  connectNow() {
    if (this.stopped || this.open || this.connecting) {
      return;
    }
    this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.connect();
  }

  /** Resolves true once `ready` (at once when already), false after `timeoutMs` or a failure. */
  whenReady(timeoutMs) {
    if (this.isReady) {
      return Promise.resolve(true);
    }
    if (!(timeoutMs > 0) || this.stopped) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const waiter = { resolve, timer: undefined };
      waiter.timer = this.timers.setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== waiter);
        resolve(false);
      }, timeoutMs);
      this.readyWaiters.push(waiter);
    });
  }

  settleReady(value) {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) {
      this.timers.clearTimeout(waiter.timer);
      waiter.resolve(value);
    }
  }

  schedule(ms) {
    this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, ms);
  }

  backoff() {
    if (
      this.connectedAt !== undefined &&
      this.now() - this.connectedAt >= this.timings.stableAfter
    ) {
      this.failures = 0;
    }
    this.connectedAt = undefined;
    this.failures += 1;
    return backoffDelay(this.failures, this.timings);
  }

  /** Opens the TCP connection; rejects UNREACHABLE when nothing accepts it in time. */
  openSocket() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let socket;
      const timer = this.timers.setTimeout(() => {
        if (!settled) {
          settled = true;
          socket?.destroy();
          reject(new DeviceError(ERROR_KINDS.UNREACHABLE, 'No connection (timeout)'));
        }
      }, this.timings.connectTimeout);
      try {
        socket = this.connectSocket({ host: this.host, port: this.port });
      } catch (err) {
        this.timers.clearTimeout(timer);
        settled = true;
        reject(new DeviceError(ERROR_KINDS.UNREACHABLE, `Cannot connect: ${err.message}`));
        return;
      }
      socket.once('error', (err) => {
        if (!settled) {
          settled = true;
          this.timers.clearTimeout(timer);
          socket.destroy();
          reject(
            new DeviceError(ERROR_KINDS.UNREACHABLE, `No connection (${err.code ?? 'error'})`),
          );
        }
      });
      socket.once('connect', () => {
        if (settled) {
          socket.destroy();
          return;
        }
        settled = true;
        this.timers.clearTimeout(timer);
        resolve(socket);
      });
    });
  }

  async connect() {
    if (this.stopped || this.connecting || this.socket) {
      return;
    }
    this.connecting = true;
    this.lastAttempt = this.now();
    let socket;
    try {
      // The time of the attempt is kept (in /data) before anything is asked.
      await this.beforeAttempt?.(this)?.catch?.(() => {});
      if (this.stopped) {
        return;
      }
      socket = await this.openSocket();
      if (this.stopped) {
        socket.destroy();
        return;
      }
      this.attach(socket);
      await this.handshake();
      this.ready = true;
      this.settleReady(true);
      this.onEvent('ready', this);
      await this.readSnapshot();
      if (!this.open || this.socket !== socket) {
        throw new DeviceError(ERROR_KINDS.UNREACHABLE, 'Connection closed while connecting');
      }
      this.identified = true;
      this.connectedAt = this.now();
      this.lastError = undefined;
      this.startPolling();
      this.onEvent('up', this);
    } catch (err) {
      this.lastError = err;
      if (socket && this.socket === socket) {
        // Opened, then not a usable controller: closed, spaced out.
        this.socket = undefined;
        this.ready = false;
        this.identified = false;
        socket.destroy();
        this.failCurrent();
      }
      this.settleReady(false);
      if (!this.stopped) {
        const delay = this.backoff();
        this.logger?.debug?.(`${this.key}: ${err.message}, next attempt in ${delay / 1000} s`);
        this.schedule(delay);
        this.onEvent('failed', this, err);
      }
    } finally {
      this.connecting = false;
    }
  }

  attach(socket) {
    this.socket = socket;
    this.ready = false;
    this.identified = false;
    this.state = emptyState();
    this.mac = undefined;
    this.zoneList = [];
    this.sourceList = [];
    const splitter = new LineSplitter();
    socket.setNoDelay?.(true);
    socket.setKeepAlive?.(true, 30_000);
    socket.on('data', (chunk) => {
      if (this.socket !== socket) {
        return;
      }
      const lines = splitter.push(chunk.toString('latin1'));
      // Lines dropped as too long count in the flood guard too (review 1, M3).
      for (let i = splitter.takeDropped(); i > 0; i -= 1) {
        if (this.socket !== socket || socket.destroyed || !this.countLine()) {
          return;
        }
      }
      for (const line of lines) {
        if (this.socket !== socket || socket.destroyed) {
          return;
        }
        this.receive(line);
      }
    });
    socket.on('error', () => {
      // 'close' follows: handled there.
    });
    socket.on('close', () => this.closed(socket));
  }

  /** Out of step with the controller: closed, opened again spaced out. */
  desync(reason) {
    this.logger?.info?.(`${this.key}: ${reason}, connection closed`);
    this.socket?.destroy();
  }

  /**
   * Every line, counted before it is parsed: only a real flood (thousands of
   * lines in 10 s) closes the connection; every line under it is decoded.
   */
  receive(text) {
    if (!this.countLine()) {
      return;
    }
    let message = parseLine(text);
    if (!message) {
      return;
    }
    if (message.unreadable) {
      // An `S` line the strict expression refuses (a control character in a
      // name...): while a GET is current, it is its answer, with an
      // unreadable value, nothing applied (review 1, M2); otherwise out of
      // step.
      const request = this.current?.request;
      if (request?.kind !== 'get') {
        this.desync('unreadable answer');
        return;
      }
      message = {
        type: 'S',
        branch: request.path,
        leaf: request.leaf,
        value: null,
        unreadable: true,
      };
      this.end(message);
      return;
    }
    if (
      message.type === 'S' &&
      message.branch === '' &&
      message.leaf !== 'VERSION' &&
      this.current?.request.kind === 'get'
    ) {
      // An answer naming the leaf only: the branch is the one asked.
      message = { ...message, branch: this.current.request.path };
    }
    // A keyed line (answer or push) always carries the state of the
    // controller when it wrote it: applied first.
    const change = message.leaf ? applyMessage(this.state, message) : undefined;
    if (message.type === 'S' || message.type === 'E') {
      const current = this.current;
      if (!current) {
        this.desync('answer without request');
        return;
      }
      if (message.type === 'S' && !answers(current.request, message)) {
        this.desync('answer to another request');
        return;
      }
      this.end(message);
    }
    if (change && this.ready) {
      this.onEvent('update', this, change);
    }
  }

  /**
   * Counts one line (decoded or dropped as too long) in the flood guard;
   * false when a real flood closed the connection.
   */
  countLine() {
    const now = this.now();
    this.lines.push(now);
    while (this.lines.length > 0 && now - this.lines[0] > this.timings.floodWindow) {
      this.lines.shift();
    }
    if (this.lines.length > this.timings.floodLines) {
      this.lines = [];
      this.desync('too many lines');
      return false;
    }
    return true;
  }

  /** Ends the current exchange with its answer (an orphan's answer is only absorbed). */
  end(message) {
    const current = this.current;
    this.current = undefined;
    this.timers.clearTimeout(current.timer);
    if (message.type === 'E') {
      current.reject(
        new DeviceError(ERROR_KINDS.REFUSED, `Refused by the controller: ${message.message}`),
      );
    } else {
      current.resolve(message);
    }
    this.pump();
  }

  /** The connection is gone: the exchange written may have acted, the waiting ones did not. */
  failCurrent() {
    const current = this.current;
    this.current = undefined;
    if (current) {
      this.timers.clearTimeout(current.timer);
      current.reject(
        new DeviceError(ERROR_KINDS.CLOSED, 'Connection closed before the answer', { sent: true }),
      );
    }
    const waiting = this.queue;
    this.queue = [];
    for (const item of waiting) {
      item.reject(new DeviceError(ERROR_KINDS.UNREACHABLE, 'Not connected: nothing sent'));
    }
  }

  closed(socket) {
    if (socket !== this.socket) {
      return;
    }
    const wasIdentified = this.identified;
    this.socket = undefined;
    this.ready = false;
    this.identified = false;
    this.timers.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.failCurrent();
    if (this.stopped || !wasIdentified) {
      // Closed while connecting: connect() fails and spaces the next attempt.
      return;
    }
    const delay = this.backoff();
    this.schedule(delay);
    this.logger?.info?.(`${this.key}: connection lost, next attempt in ${delay / 1000} s`);
    this.onEvent('down', this);
  }

  /**
   * One exchange: writes the request and resolves with the `S` message that
   * ends it (rejects REFUSED on `E`). `timeoutMs` counts from now, the wait
   * for the turn included. `shouldSend` is asked again right before the
   * write: false drops the exchange (CANCELLED, nothing sent). `onSent` is
   * called right before the bytes leave.
   * Before that, every failure is "nothing sent" (UNREACHABLE, BUDGET);
   * after, TIMEOUT and CLOSED (`sent: true`).
   */
  exchange(request, timeoutMs, { onSent, shouldSend, priority = false, minRemaining = 0 } = {}) {
    if (!this.open) {
      return Promise.reject(
        new DeviceError(ERROR_KINDS.UNREACHABLE, 'Not connected: nothing sent'),
      );
    }
    if (this.queue.length >= LIMITS.pending) {
      return Promise.reject(
        new DeviceError(ERROR_KINDS.BUDGET, 'Too many commands waiting: nothing sent'),
      );
    }
    if (!(timeoutMs > 0)) {
      return Promise.reject(new DeviceError(ERROR_KINDS.BUDGET, 'No time left: nothing sent'));
    }
    let bytes;
    try {
      bytes = encode(request);
    } catch (err) {
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      const item = {
        request,
        bytes,
        socket: this.socket,
        deadline: this.now() + timeoutMs,
        onSent,
        shouldSend,
        priority,
        minRemaining,
        resolve,
        reject,
      };
      if (priority) {
        // Before the exchanges waiting (after the other priority ones), never
        // before the one already written.
        const index = this.queue.findIndex((q) => !q.priority);
        this.queue.splice(index === -1 ? this.queue.length : index, 0, item);
      } else {
        this.queue.push(item);
      }
      this.pump();
    });
  }

  /** Writes the next exchange when none waits for its answer. */
  pump() {
    while (!this.current && this.queue.length > 0) {
      const item = this.queue.shift();
      const remaining = item.deadline - this.now();
      if (remaining <= 0) {
        item.reject(new DeviceError(ERROR_KINDS.BUDGET, 'No time left: nothing sent'));
        continue;
      }
      if (!this.open || this.socket !== item.socket) {
        item.reject(new DeviceError(ERROR_KINDS.UNREACHABLE, 'Not connected: nothing sent'));
        continue;
      }
      if (remaining < item.minRemaining) {
        // Too little time for the controller to answer: never written (review 1, I1).
        item.reject(new DeviceError(ERROR_KINDS.BUDGET, 'No time left: nothing sent'));
        continue;
      }
      if (item.shouldSend && !item.shouldSend()) {
        item.reject(new DeviceError(ERROR_KINDS.CANCELLED, 'Cancelled by Standby, nothing sent'));
        continue;
      }
      const entry = {
        request: item.request,
        resolve: item.resolve,
        reject: item.reject,
        timer: undefined,
        orphan: false,
      };
      // The caller's deadline and the life of the exchange on the wire are
      // two things (review 1, I1): at the deadline the caller gets "sent,
      // without answer", but the exchange stays the current one, orphaned,
      // until `requestTimeout` at least after the write. Its late answer is
      // then absorbed (it confirms nothing: a command is only confirmed by a
      // GET read back, matched by its key), and the next exchange follows.
      // Only an exchange still unanswered past that ceiling closes the link.
      const wireLife = Math.max(remaining, this.timings.requestTimeout);
      const expire = () => {
        if (this.current !== entry) {
          return;
        }
        this.current = undefined;
        // A later answer would be taken for the one of the next request.
        this.desync('no answer in time');
      };
      entry.timer = this.timers.setTimeout(() => {
        if (this.current !== entry) {
          return;
        }
        entry.orphan = true;
        entry.reject(
          new DeviceError(ERROR_KINDS.TIMEOUT, 'Sent, without answer from the controller', {
            sent: true,
          }),
        );
        if (wireLife > remaining) {
          entry.timer = this.timers.setTimeout(expire, wireLife - remaining);
        } else {
          expire();
        }
      }, remaining);
      this.current = entry;
      try {
        item.onSent?.();
        item.socket.write(item.bytes);
      } catch (err) {
        this.current = undefined;
        this.timers.clearTimeout(entry.timer);
        item.reject(new DeviceError(ERROR_KINDS.UNREACHABLE, `Not sent: ${err.message}`));
      }
    }
  }

  /** `GET <path>.<leaf>`; resolves with the raw value (null when empty). */
  async get(path, leaf, timeoutMs = this.timings.requestTimeout) {
    const message = await this.exchange(getRequest(path, leaf), timeoutMs);
    return message.value;
  }

  /**
   * `GET` of a zone leaf; resolves with the parsed value now in the state,
   * or undefined when the answer was unreadable: the value in memory never
   * stands for a read (review 2, R2-1), so a decision refuses and a
   * confirmation fails.
   */
  async readZone(c, z, leaf, timeoutMs) {
    const message = await this.exchange(getRequest(zonePath(c, z), leaf), timeoutMs);
    if (message.unreadable) {
      return undefined;
    }
    return this.state.zones[`${c}.${z}`]?.[leaf];
  }

  async handshake() {
    let version;
    try {
      version = (await this.exchange(versionRequest(), this.timings.requestTimeout)).value;
    } catch (err) {
      throw new DeviceError(
        ERROR_KINDS.PROTOCOL,
        `Not a Russound RIO controller (no answer to VERSION: ${err.message})`,
      );
    }
    if (!versionAtLeast(version, MIN_RIO_VERSION)) {
      throw new DeviceError(
        ERROR_KINDS.PROTOCOL,
        `RIO version ${String(version).slice(0, 16)} not supported (${MIN_RIO_VERSION} at least)`,
      );
    }
    const type = await this.get(controllerPath(1), 'type').catch((err) => {
      throw new DeviceError(ERROR_KINDS.PROTOCOL, `No controller found (${err.message})`);
    });
    if (!type) {
      throw new DeviceError(ERROR_KINDS.PROTOCOL, 'No controller found');
    }
    // Not every firmware tells it: unreadable is never "another controller".
    const mac = await this.get(controllerPath(1), 'macAddress').then(parseMac, (err) => {
      if (err.kind === ERROR_KINDS.REFUSED) {
        return undefined;
      }
      throw err;
    });
    if (!this.checkIdentity(this, mac)) {
      throw new DeviceError(
        ERROR_KINDS.IDENTITY,
        `Another controller answers at ${this.key} (MAC address ${mac})`,
      );
    }
    this.mac = mac;
  }

  /** A GET whose `E` answer means "not there": undefined. */
  optional(path, leaf) {
    return this.get(path, leaf).catch((err) => {
      if (err.kind === ERROR_KINDS.REFUSED) {
        return undefined;
      }
      throw err;
    });
  }

  async readSnapshot() {
    const first = fixControllerType(this.state.controllers['1']?.type);
    const controllers = [1];
    if (isRnetCapable(first)) {
      for (let c = 2; c <= LIMITS.controllers; c += 1) {
        if (await this.optional(controllerPath(c), 'type')) {
          controllers.push(c);
        }
      }
    }
    for (let s = 1; s <= LIMITS.sources; s += 1) {
      let name;
      try {
        name = await this.get(sourcePath(s), 'name');
      } catch (err) {
        if (err.kind === ERROR_KINDS.REFUSED) {
          break;
        }
        throw err;
      }
      if (name) {
        this.sourceList.push(s);
      }
    }
    const zones = [];
    for (const c of controllers) {
      const type = fixControllerType(this.state.controllers[String(c)]?.type);
      for (let z = 1; z <= Math.min(maxZones(type), LIMITS.zonesPerController); z += 1) {
        let name;
        try {
          name = await this.get(zonePath(c, z), 'name');
        } catch (err) {
          if (err.kind === ERROR_KINDS.REFUSED) {
            break;
          }
          throw err;
        }
        if (name && zones.length < LIMITS.zones) {
          zones.push({ c, z });
        }
      }
    }
    this.zoneList = zones;
    for (const { c, z } of zones) {
      for (const leaf of ZONE_READS) {
        await this.optional(zonePath(c, z), leaf);
      }
    }
    // Pushed changes from now on. A WATCH refused leaves the poll.
    for (const path of [
      ...zones.map(({ c, z }) => zonePath(c, z)),
      ...this.sourceList.map(sourcePath),
    ]) {
      await this.exchange(watchRequest(path), this.timings.requestTimeout).catch((err) => {
        if (err.kind !== ERROR_KINDS.REFUSED) {
          throw err;
        }
      });
    }
  }

  startPolling() {
    this.timers.clearInterval(this.pollTimer);
    this.pollTimer = this.timers.setInterval(() => this.poll(), this.timings.pollInterval);
  }

  /**
   * The MAC address and the zones read again (the controller pushes its
   * changes, this catches what was missed), one request at a time so a
   * command waits at most for one. A request without answer closes the
   * connection (then spaced reconnection).
   */
  async poll() {
    if (!this.connected || this.polling) {
      return;
    }
    this.polling = true;
    try {
      if (this.mac) {
        const mac = parseMac(await this.optional(controllerPath(1), 'macAddress'));
        if (mac && mac !== this.mac) {
          this.lastError = new DeviceError(
            ERROR_KINDS.IDENTITY,
            `Another controller answers at ${this.key} (MAC address ${mac})`,
          );
          this.desync('another controller answers');
          return;
        }
      } else {
        await this.exchange(versionRequest(), this.timings.requestTimeout);
      }
      for (const { c, z } of this.zoneList) {
        for (const leaf of ZONE_READS) {
          if (!this.connected) {
            return;
          }
          await this.optional(zonePath(c, z), leaf);
        }
      }
    } catch {
      // A request without answer closed the connection: reconnection follows.
    } finally {
      this.polling = false;
    }
  }
}

/** The delay before attempt number `failures` (1: reconnectBase, doubled, up to reconnectMax). */
export function backoffDelay(failures, timings = TIMINGS) {
  if (!(failures > 0)) {
    return 0;
  }
  return Math.min(
    timings.reconnectMax,
    timings.reconnectBase * 2 ** Math.min(Math.floor(failures) - 1, 16),
  );
}

/**
 * Whether an `S` message ends `request`: a GET or VERSION is answered by its
 * own key; WATCH and EVENT by a bare `S`.
 */
function answers(request, message) {
  if (request.kind === 'version') {
    return message.branch === '' && message.leaf === 'VERSION';
  }
  if (request.kind === 'get') {
    return (
      message.leaf !== undefined &&
      message.leaf.toLowerCase() === request.leaf.toLowerCase() &&
      message.branch.toLowerCase() === request.path.toLowerCase()
    );
  }
  return message.leaf === undefined;
}

// -----------------------------------------------------------------------------
// RussoundApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), a memory store and the fake Russound controller on the
// loopback interface. The background round and the poll never fire by
// themselves: the tests drive them.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { RussoundApp, parseVolumeCommand } from '../src/app.js';
import { LIMITS, TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { MemoryStore } from '../src/store.js';
import { MAC, closedPort, startFakeRussound } from './fixtures/fakeRussound.js';

const SELECTOR = 'russound';

/** No background round, no poll; real (short) timeouts. */
const timers = {
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

const FAST = {
  ...TIMINGS,
  connectTimeout: 500,
  requestTimeout: 300,
  commandBudget: 1_200,
  preRead: 500,
  reconnectBase: 40,
  reconnectMax: 200,
  stableAfter: 10_000,
  attemptPersistEvery: 60_000,
  publishDelay: 5,
  persistDelay: 5,
  wakeCheckDelay: 30,
  standbyCheckDelay: 30,
};

async function waitFor(predicate, what, timeout = 3_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(t, { fakeOptions, config, devices, store, timings = {} } = {}) {
  const fake = await startFakeRussound(fakeOptions);
  t.after(() => fake.close());
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: config ? config(fake) : { addresses: `127.0.0.1:${fake.port}` },
    devices: devices ? devices(fake) : [],
  });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  const app = new RussoundApp({
    gladys,
    logger,
    store: store ? store(fake) : new MemoryStore(),
    timers,
    timings: { ...FAST, ...timings },
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.stop());
  await gladys.connect();
  const id = (zone, key) =>
    `ext:${SELECTOR}:russound:127.0.0.1_${fake.port}_c1_z${zone}${key ? `:${key}` : ''}`;
  return { fake, gladys, app, logs, id };
}

async function discovered({ gladys, id }, zone = 1) {
  await waitFor(
    () => gladys.fake.discoveredDevices.some((d) => d.external_id === id(zone)),
    `zone ${zone} in the Discovery tab`,
  );
  return gladys.fake.discoveredDevices.find((d) => d.external_id === id(zone));
}

async function createZone(ctx, zone = 1) {
  const device = await discovered(ctx, zone);
  await ctx.gladys.fake.deviceCreated(device);
  await waitFor(
    () => ctx.gladys.fake.lastState(ctx.id(zone, 'power')) !== undefined,
    'the power state',
  );
  return device;
}

/** A command through the fake Gladys; a failed ack rejects with its message. */
async function set({ gladys, id }, device, zone, key, value = 1) {
  const ack = await gladys.fake.setValue(
    device,
    device.features.find((f) => f.external_id === id(zone, key)),
    value,
  );
  if (!ack.success) {
    throw new Error(ack.error);
  }
  return ack;
}

test('the zones of a typed address become Gladys devices; their states once created', async (t) => {
  const ctx = await setup(t);
  const kitchen = await discovered(ctx, 1);
  const patio = await discovered(ctx, 2);
  assert.equal(kitchen.name, 'Russound Kitchen');
  assert.equal(patio.name, 'Russound Patio');
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 2, 'one device per named zone');
  const keys = kitchen.features.map((f) => f.external_id.slice(ctx.id(1).length + 1));
  assert.deepEqual(keys, [
    'power',
    'power_on',
    'standby',
    'volume',
    'mute',
    'source',
    'now_playing',
  ]);
  const byKey = Object.fromEntries(
    kitchen.features.map((f) => [f.external_id.split(':').pop(), f]),
  );
  // No switch, nothing an "everything on / off" could command; the power is read only.
  assert.ok(kitchen.features.every((f) => f.category !== 'switch'));
  assert.deepEqual([byKey.power.category, byKey.power.read_only], ['unknown', true]);
  assert.deepEqual([byKey.power_on.category, byKey.power_on.type], ['button', 'push']);
  assert.deepEqual([byKey.standby.category, byKey.standby.type], ['button', 'push']);
  assert.deepEqual(
    [byKey.volume.category, byKey.volume.type, byKey.volume.min, byKey.volume.max],
    ['music', 'volume', 0, 100],
  );
  assert.deepEqual([byKey.mute.category, byKey.mute.type], ['television', 'volume-mute']);
  assert.deepEqual(
    [byKey.now_playing.category, byKey.now_playing.type, byKey.now_playing.read_only],
    ['text', 'text', true],
  );
  assert.ok(
    kitchen.features.every((f) => f.unit === undefined),
    'no unit',
  );
  assert.deepEqual(byKey.source.supported_options, [
    { value: '1', label: 'Tuner' },
    { value: '2', label: 'Streamer' },
  ]);
  assert.equal(ctx.gladys.fake.states.length, 0, 'no state before the device is created');

  await createZone(ctx, 1);
  const last = (key) => ctx.gladys.fake.lastState(ctx.id(1, key));
  await waitFor(() => last('now_playing') !== undefined, 'now playing');
  assert.equal(last('power'), 1);
  // 20 on a cap of 25: 80 %.
  assert.equal(last('volume'), 80);
  assert.equal(last('mute'), 0);
  assert.equal(last('source'), '2');
  assert.equal(last('now_playing'), 'Miles Davis - So What');
  assert.equal(ctx.gladys.fake.lastState(ctx.id(2, 'power')), undefined, 'zone 2 not created');
  // Only reads and watches: nothing set by the connection itself.
  assert.deepEqual(ctx.fake.events(), []);
  assert.ok(ctx.fake.received.includes('WATCH C[1].Z[1] ON'));
  assert.ok(ctx.fake.received.includes('WATCH S[2] ON'));
  assert.deepEqual(ctx.gladys.fake.connectionStatus, { connected: true });
  // The MAC address is kept for the address, the attempt time too.
  await waitFor(() => ctx.app.store.saves > 0, 'a save');
  const entry = ctx.app.data.addresses[`127.0.0.1_${ctx.fake.port}`];
  assert.equal(entry.mac, MAC);
  assert.ok(entry.lastAttempt > 0);
});

test('pushed changes are published', async (t) => {
  const ctx = await setup(t);
  await createZone(ctx, 1);
  const last = (key) => ctx.gladys.fake.lastState(ctx.id(1, key));
  ctx.fake.set('C[1].Z[1].volume', '5');
  ctx.fake.set('C[1].Z[1].mute', 'ON');
  await waitFor(() => last('mute') === 1, 'mute 1');
  assert.equal(last('volume'), 20);
  ctx.fake.set('S[2].songName', 'Blue in Green');
  await waitFor(() => last('now_playing') === 'Miles Davis - Blue in Green', 'the new title');
  ctx.fake.set('C[1].Z[1].status', 'OFF');
  await waitFor(() => last('power') === 0, 'power 0');
  assert.equal(last('now_playing'), '', 'nothing plays in a zone off');
  // A volume above the cap shows 100 %.
  ctx.fake.set('C[1].Z[1].volume', '40');
  await waitFor(() => last('volume') === 100, '100 %');
});

test('volume: mapped onto 0..cap, never above it, confirmed by the value read back', async (t) => {
  const ctx = await setup(t);
  const device = await createZone(ctx, 1);
  await set(ctx, device, 1, 'volume', 100);
  assert.deepEqual(ctx.fake.events(), ['EVENT C[1].Z[1]!KeyPress Volume 25']);
  await set(ctx, device, 1, 'volume', '40');
  assert.equal(ctx.fake.events().at(-1), 'EVENT C[1].Z[1]!KeyPress Volume 10');
  for (const bad of [null, '', true, 12.5, '12abc', 101, -1, NaN]) {
    await assert.rejects(set(ctx, device, 1, 'volume', bad), /Invalid volume/);
  }
  assert.equal(ctx.fake.events().length, 2, 'nothing sent for an invalid value');
  // The cap is read just before sending: a new configuration applies at once.
  await ctx.app.start({ addresses: `127.0.0.1:${ctx.fake.port}`, max_volume: 10 });
  await set(ctx, device, 1, 'volume', 100);
  assert.equal(ctx.fake.events().at(-1), 'EVENT C[1].Z[1]!KeyPress Volume 10');
});

test('a command the controller ignores is "sent, without confirmation"', async (t) => {
  const ctx = await setup(t, { fakeOptions: { ignore: ['KeyPress', 'SelectSource'] } });
  const device = await createZone(ctx, 1);
  await assert.rejects(set(ctx, device, 1, 'volume', 50), /without confirmation/);
  await assert.rejects(set(ctx, device, 1, 'source', '1'), /without confirmation/);
});

test('a command without answer is "sent, without confirmation", the link opened again', async (t) => {
  const ctx = await setup(t);
  const device = await createZone(ctx, 1);
  ctx.fake.unanswered.add('EVENT C[1].Z[1]!SelectSource');
  await assert.rejects(set(ctx, device, 1, 'source', '1'), /without confirmation/);
  ctx.fake.unanswered.clear();
  await waitFor(() => ctx.fake.connections >= 2, 'a new connection');
  await waitFor(() => ctx.app.linkOf(ctx.app.zones[0])?.connected, 'connected again');
  await set(ctx, device, 1, 'source', '1');
});

test('source: only the options of the dropdown, confirmed', async (t) => {
  const ctx = await setup(t);
  const device = await createZone(ctx, 1);
  await set(ctx, device, 1, 'source', '1');
  assert.deepEqual(ctx.fake.events(), ['EVENT C[1].Z[1]!SelectSource 1']);
  await waitFor(() => ctx.gladys.fake.lastState(ctx.id(1, 'source')) === '1', 'source 1');
  await assert.rejects(set(ctx, device, 1, 'source', '9'), /Unknown source/);
  await assert.rejects(set(ctx, device, 1, 'source', '1\rEVENT'), /Unknown source/);
  assert.equal(ctx.fake.events().length, 1);
});

test('power on brings a zone turned on above the cap back to it', async (t) => {
  const ctx = await setup(t, { fakeOptions: { wakeVolume: 40 } });
  const device = await createZone(ctx, 2);
  await set(ctx, device, 2, 'power_on');
  assert.deepEqual(ctx.fake.events(), [
    'EVENT C[1].Z[2]!ZoneOn',
    'EVENT C[1].Z[2]!KeyPress Volume 25',
  ]);
  assert.equal(ctx.fake.values['C[1].Z[2].volume'], '25');
  await waitFor(() => ctx.gladys.fake.lastState(ctx.id(2, 'power')) === 1, 'power 1');
});

test('power on: a lowering ignored by the controller is tried again', async (t) => {
  const ctx = await setup(t, { fakeOptions: { wakeVolume: 40, ignore: ['KeyPress'] } });
  const device = await createZone(ctx, 2);
  await set(ctx, device, 2, 'power_on');
  await waitFor(
    () => ctx.fake.events().filter((e) => e.includes('Volume 25')).length >= 3,
    'the lowering tried again',
  );
  // Standby ends the checks.
  await set(ctx, device, 2, 'standby');
  await settle(100);
  const count = ctx.fake.events().length;
  await settle(150);
  assert.equal(ctx.fake.events().length, count, 'no check after Standby');
});

test('standby is protective: first, confirmed, and cancels a Power on waiting', async (t) => {
  const ctx = await setup(t);
  const device = await createZone(ctx, 1);
  // A slow mute press holds the queue of the zone; a Power on waits behind it.
  ctx.fake.delays['GET C[1].Z[1].mute'] = 150;
  const outcome = (promise) =>
    promise.then(
      () => 'ok',
      (err) => err.message,
    );
  const mute = outcome(set(ctx, device, 1, 'mute'));
  await settle(20);
  const powerOn = outcome(set(ctx, device, 1, 'power_on'));
  await settle(20);
  await set(ctx, device, 1, 'standby');
  assert.match(await powerOn, /Cancelled by Standby, nothing sent/);
  // The mute press running read its state before the Standby: its line is dropped too.
  assert.match(await mute, /Cancelled by Standby, nothing sent/);
  assert.ok(ctx.fake.events().includes('EVENT C[1].Z[1]!ZoneOff'));
  assert.ok(!ctx.fake.events().includes('EVENT C[1].Z[1]!ZoneOn'));
  assert.equal(ctx.fake.values['C[1].Z[1].status'], 'OFF');
});

test('standby not confirmed is sent again', async (t) => {
  const ctx = await setup(t, { fakeOptions: { ignore: ['ZoneOff'] } });
  const device = await createZone(ctx, 1);
  await assert.rejects(set(ctx, device, 1, 'standby'), /without confirmation/);
  await waitFor(
    () => ctx.fake.events().filter((e) => e.endsWith('ZoneOff')).length >= 3,
    'ZoneOff sent again',
  );
  // A Power on asked after it ends the reaffirmation.
  ctx.fake.ignore.clear();
  await set(ctx, device, 1, 'power_on');
  await settle(150);
  assert.equal(ctx.fake.values['C[1].Z[1].status'], 'ON');
});

test('mute: read, then the opposite; unmute lowers a volume above the cap first', async (t) => {
  const ctx = await setup(t);
  const device = await createZone(ctx, 1);
  await set(ctx, device, 1, 'mute');
  assert.deepEqual(ctx.fake.events(), ['EVENT C[1].Z[1]!ZoneMuteOn']);
  ctx.fake.set('C[1].Z[1].volume', '45');
  await set(ctx, device, 1, 'mute');
  assert.deepEqual(ctx.fake.events().slice(1), [
    'EVENT C[1].Z[1]!KeyPress Volume 25',
    'EVENT C[1].Z[1]!ZoneMuteOff',
  ]);
});

test('unmute is refused, mute kept, when the lowering is ignored', async (t) => {
  const ctx = await setup(t, { fakeOptions: { ignore: ['KeyPress'] } });
  const device = await createZone(ctx, 1);
  ctx.fake.set('C[1].Z[1].mute', 'ON');
  ctx.fake.set('C[1].Z[1].volume', '45');
  await assert.rejects(set(ctx, device, 1, 'mute'), /mute kept/);
  assert.ok(!ctx.fake.events().includes('EVENT C[1].Z[1]!ZoneMuteOff'));
});

test('mute on an old firmware (no explicit mute) is refused, nothing sent', async (t) => {
  const ctx = await setup(t, { fakeOptions: { version: '1.08.00' } });
  const device = await createZone(ctx, 1);
  await assert.rejects(set(ctx, device, 1, 'mute'), /no explicit mute/);
  assert.deepEqual(ctx.fake.events(), []);
});

test('another controller at the address (another MAC) is neither read nor commanded', async (t) => {
  const ctx = await setup(t, {
    store: (fake) =>
      new MemoryStore({
        zones: {},
        addresses: { [`127.0.0.1_${fake.port}`]: { mac: '00:21:c7:aa:bb:cc', failures: 0 } },
      }),
  });
  await waitFor(
    () => /Another controller/.test(ctx.gladys.fake.connectionStatus?.message?.en ?? ''),
    'the status',
  );
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 0);
  assert.ok(!ctx.fake.received.some((l) => l.startsWith('WATCH')));
});

test('an unreadable MAC address is never "another controller"', async (t) => {
  const ctx = await setup(t, {
    fakeOptions: { mac: false },
    store: (fake) =>
      new MemoryStore({
        zones: {},
        addresses: { [`127.0.0.1_${fake.port}`]: { mac: '00:21:c7:aa:bb:cc', failures: 0 } },
      }),
  });
  await discovered(ctx, 1);
});

test('nothing answers: said in the status, no device', async (t) => {
  const port = await closedPort();
  const ctx = await setup(t, { config: () => ({ addresses: `127.0.0.1:${port}, COM3` }) });
  await waitFor(
    () =>
      /No Russound controller answers/.test(ctx.gladys.fake.connectionStatus?.message?.en ?? ''),
    'the status',
  );
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /invalid\): COM3/);
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 0);
});

test('not a RIO controller (an old version) is refused', async (t) => {
  const ctx = await setup(t, { fakeOptions: { version: '1.04.00' } });
  await waitFor(() => ctx.app.links.values().next().value?.lastError, 'the error');
  assert.match(ctx.app.links.values().next().value.lastError.message, /not supported/);
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 0);
});

test('after a restart: no attempt sooner than the interval, but Standby connects at once', async (t) => {
  const zone = (fake) => `127.0.0.1_${fake.port}_c1_z1`;
  const ctx = await setup(t, {
    store: (fake) =>
      new MemoryStore({
        zones: {
          [zone(fake)]: {
            id: zone(fake),
            host: '127.0.0.1',
            port: fake.port,
            controller: 1,
            zone: 1,
            name: 'Kitchen',
            sourceOptions: [],
          },
        },
        addresses: {
          [`127.0.0.1_${fake.port}`]: { mac: MAC, lastAttempt: Date.now(), failures: 0 },
        },
      }),
    devices: (fake) => [
      {
        name: 'Russound Kitchen',
        external_id: `ext:${SELECTOR}:russound:${zone(fake)}`,
        features: [
          { external_id: `ext:${SELECTOR}:russound:${zone(fake)}:standby`, name: 'Standby' },
        ],
      },
    ],
  });
  await settle(150);
  assert.equal(ctx.fake.connections, 0, 'no attempt right after the restart');
  const device = ctx.gladys.devices[0];
  const ack = await ctx.gladys.fake.setValue(device, device.features[0], 1);
  assert.equal(ack.success, true, ack.error);
  assert.equal(ctx.fake.connections, 1);
  assert.ok(ctx.fake.events().includes('EVENT C[1].Z[1]!ZoneOff'));
});

test('a reconnection to Gladys republishes the devices and the status', async (t) => {
  const ctx = await setup(t);
  await createZone(ctx, 1);
  const before = ctx.gladys.fake.discoveredDevices.length;
  const connections = ctx.fake.connections;
  await ctx.app.start(await ctx.gladys.getConfig(), { connected: true });
  assert.ok(ctx.gladys.fake.discoveredDevices.length >= before);
  assert.deepEqual(ctx.gladys.fake.connectionStatus, { connected: true });
  assert.equal(ctx.fake.connections, connections, 'the link is kept, never asked faster');
});

test('the global state budget is never exceeded', async (t) => {
  const ctx = await setup(t);
  await createZone(ctx, 1);
  const now = Date.now();
  ctx.app.budget = Array.from({ length: LIMITS.statesPerWindow }, () => now);
  const count = ctx.gladys.fake.states.length;
  ctx.fake.set('C[1].Z[1].volume', '1');
  await settle(100);
  assert.equal(ctx.gladys.fake.states.length, count, 'held while the window is full');
  ctx.app.budget = [];
  ctx.app.schedulePublish(ctx.app.zones[0].id, 0);
  await waitFor(() => ctx.gladys.fake.lastState(ctx.id(1, 'volume')) === 4, 'published later');
});

test('a flood of lines below the real-flood limit is decoded line by line', async (t) => {
  const ctx = await setup(t);
  await createZone(ctx, 1);
  let text = '';
  for (let i = 0; i < 500; i += 1) {
    text += `N C[1].Z[1].volume="${i % 26}"\r\n`;
  }
  text += 'N C[1].Z[1].volume="24"\r\n';
  ctx.fake.write(text);
  await waitFor(() => ctx.gladys.fake.lastState(ctx.id(1, 'volume')) === 96, 'the last value');
  assert.equal(ctx.fake.connections, 1, 'never cut');
});

test('the check button tells each controller and zone', async (t) => {
  const ctx = await setup(t);
  await discovered(ctx, 2);
  const result = await ctx.app.checkDevices();
  assert.match(result.en, /connected, RIO 1\.10\.00, MAC 00:21:c7:01:02:03, 2 zone\(s\)/);
  assert.match(result.en, /Russound Kitchen: on, volume 20, not muted, source 2/);
  assert.match(result.fr, /Russound Patio : éteinte/);
});

test('parseVolumeCommand is strict', () => {
  assert.equal(parseVolumeCommand(0), 0);
  assert.equal(parseVolumeCommand(' 42 '), 42);
  for (const bad of [null, undefined, '', true, 12.5, '1e2', 101, -1, NaN, '12abc']) {
    assert.equal(parseVolumeCommand(bad), undefined, String(bad));
  }
});

// --- Review 1 -------------------------------------------------------------------------

const outcome = (promise) =>
  promise.then(
    () => 'ok',
    (err) => err.message,
  );

test('review 1, I1: a burst of volumes on a slow controller never closes the link', async (t) => {
  const ctx = await setup(t, { fakeOptions: { delays: { 'EVENT C[1].Z[1]!KeyPress': 150 } } });
  const kitchen = await createZone(ctx, 1);
  const patio = await createZone(ctx, 2);
  const acks = [];
  for (let v = 10; v <= 100; v += 10) {
    acks.push(outcome(set(ctx, kitchen, 1, 'volume', v)));
  }
  const results = await Promise.all(acks);
  assert.ok(results.includes('ok'));
  // Late ones are refused before any byte, or "sent, without confirmation": never a cut link.
  for (const result of results.filter((r) => r !== 'ok')) {
    assert.match(result, /nothing sent|without confirmation/);
  }
  await settle(400);
  assert.equal(ctx.fake.connections, 1, 'the link is kept');
  assert.ok(!ctx.logs.some((l) => /connection closed/.test(l)), ctx.logs.join('\n'));
  assert.equal(await outcome(set(ctx, patio, 2, 'power_on')), 'ok', 'the other zone answers');
});

test('review 1, I1: an exchange past its deadline absorbs its late answer', async (t) => {
  const ctx = await setup(t, { timings: { requestTimeout: 400 } });
  const kitchen = await createZone(ctx, 1);
  const link = ctx.app.linkOf(ctx.app.zones[0]);
  ctx.fake.delays['GET C[1].Z[1].volume'] = 150;
  await assert.rejects(link.get('C[1].Z[1]', 'volume', 50), /without answer/);
  // The next exchange waits for the orphan's answer, then gets its own.
  assert.equal(await link.get('C[1].Z[1]', 'mute', 600), 'OFF');
  assert.equal(ctx.fake.connections, 1);
  await set(ctx, kitchen, 1, 'source', '1');
});

test('review 1, I2: Standby cancels a Source and a Volume waiting, never woken after', async (t) => {
  const ctx = await setup(t, { fakeOptions: { delays: { 'EVENT C[1].Z[1]!KeyPress': 200 } } });
  const kitchen = await createZone(ctx, 1);
  const original = ctx.fake.set.bind(ctx.fake);
  ctx.fake.set = (key, value) => {
    original(key, value);
    if (key.endsWith('.currentSource')) {
      original(key.replace('currentSource', 'status'), 'ON');
    }
  };
  const volume = outcome(set(ctx, kitchen, 1, 'volume', 40));
  await settle(20);
  const source = outcome(set(ctx, kitchen, 1, 'source', '1'));
  const volume2 = outcome(set(ctx, kitchen, 1, 'volume', 60));
  await settle(20);
  await set(ctx, kitchen, 1, 'standby');
  assert.match(await source, /Cancelled by Standby, nothing sent/);
  assert.match(await volume2, /Cancelled by Standby, nothing sent/);
  await volume;
  await settle(100);
  const events = ctx.fake.events();
  assert.ok(!events.some((e) => e.includes('SelectSource')), events.join());
  assert.equal(events.at(-1), 'EVENT C[1].Z[1]!ZoneOff');
  assert.equal(ctx.fake.values['C[1].Z[1].status'], 'OFF');
});

test('review 1, I3: Source on a zone off is refused, nothing sent', async (t) => {
  const ctx = await setup(t);
  const patio = await createZone(ctx, 2);
  await assert.rejects(set(ctx, patio, 2, 'source', '2'), /is off .*nothing sent/);
  assert.deepEqual(ctx.fake.events(), []);
});

test('review 1, M1: a Power on overridden by a Standby after it left is never "ok"', async (t) => {
  const ctx = await setup(t, { fakeOptions: { delays: { 'EVENT C[1].Z[2]!ZoneOn': 150 } } });
  const patio = await createZone(ctx, 2);
  const powerOn = outcome(set(ctx, patio, 2, 'power_on'));
  await settle(40);
  await set(ctx, patio, 2, 'standby');
  assert.match(await powerOn, /without confirmation/);
});

test('review 1, M2: an unreadable answer ends its GET; the other zones are published', async (t) => {
  const ctx = await setup(t, { fakeOptions: { values: { 'C[1].Z[2].name': 'Pa\ttio' } } });
  await discovered(ctx, 1);
  await settle(100);
  assert.equal(ctx.fake.connections, 1, 'no reconnection loop');
  assert.ok(!ctx.gladys.fake.discoveredDevices.some((d) => d.external_id === ctx.id(2)));
});

test('review 1, M2: a bare E ends the request', async (t) => {
  const ctx = await setup(t);
  await createZone(ctx, 1);
  const link = ctx.app.linkOf(ctx.app.zones[0]);
  ctx.fake.unanswered.add('GET C[1].Z[1].bass');
  const read = link.get('C[1].Z[1]', 'bass', 1_000);
  await settle(30);
  ctx.fake.push('E');
  await assert.rejects(read, /Refused by the controller: error/);
  assert.equal(ctx.fake.connections, 1);
});

test('review 1, M3: a flood of oversized lines closes the link', async (t) => {
  const ctx = await setup(t, { timings: { floodLines: 100 } });
  await createZone(ctx, 1);
  ctx.fake.write(`N C[1].Z[1].name="${'x'.repeat(1_100)}"\r\n`.repeat(500));
  await waitFor(() => ctx.logs.some((l) => /too many lines/.test(l)), 'the flood guard');
});

test('review 1, M4: the Standby resend is dropped when a Power on comes while it waits', async (t) => {
  const ctx = await setup(t, { fakeOptions: { ignore: ['ZoneOff'] } });
  const kitchen = await createZone(ctx, 1);
  const zone = ctx.app.zones.find((z) => z.zone === 1);
  const link = ctx.app.linkOf(zone);
  ctx.fake.delays['GET C[1].Z[2].volume'] = 150;
  await assert.rejects(set(ctx, kitchen, 1, 'standby'), /without confirmation/);
  // The reaffirmation reads the zone (on), then queues ZoneOff: right then, a
  // poll request is on the wire, and a Power on is asked while ZoneOff waits.
  const exchange = link.exchange.bind(link);
  let patched = true;
  link.exchange = (request, ...rest) => {
    if (patched && request.kind === 'event' && request.name === 'ZoneOff') {
      patched = false;
      link.get('C[1].Z[2]', 'volume', 1_000).catch(() => {});
      const queued = exchange(request, ...rest);
      ctx.app.powerOnAt.set(zone.id, Date.now() + 1);
      return queued;
    }
    return exchange(request, ...rest);
  };
  await settle(300);
  assert.equal(ctx.fake.events().filter((e) => e.endsWith('ZoneOff')).length, 1);
});

test('review 1, M6: the queue of a zone is bounded', async (t) => {
  const ctx = await setup(t, { fakeOptions: { delays: { 'EVENT C[1].Z[1]!KeyPress': 300 } } });
  const kitchen = await createZone(ctx, 1);
  const acks = [];
  for (let i = 0; i < 12; i += 1) {
    acks.push(outcome(set(ctx, kitchen, 1, 'volume', i)));
  }
  const results = await Promise.all(acks);
  assert.ok(
    results.some((r) => /Too many commands waiting, nothing sent/.test(r)),
    results.join(),
  );
});

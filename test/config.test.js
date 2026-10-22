// -----------------------------------------------------------------------------
// The configuration, the frozen zone ids and the /data store.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeConfig,
  parseAddress,
  parseZoneId,
  percentToVolume,
  volumeToPercent,
  zoneId,
} from '../src/config.js';
import { FileStore, sanitizeData } from '../src/store.js';

test('addresses', () => {
  assert.deepEqual(parseAddress('192.168.1.40'), { host: '192.168.1.40', port: 9621 });
  assert.deepEqual(parseAddress(' tcp://MCA.local:9622/x '), { host: 'mca.local', port: 9622 });
  for (const bad of ['', 'COM3', '/dev/ttyUSB0', '1.2.3', 'a_b', 'host:0', 'host:99999', 'a b']) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
  const config = normalizeConfig({ addresses: '192.168.1.40, COM3;192.168.1.40 mca:9622' });
  assert.deepEqual(
    config.addresses.map((a) => `${a.host}:${a.port}`),
    ['192.168.1.40:9621', 'mca:9622'],
  );
  assert.deepEqual(config.invalid, ['COM3']);
});

test('zone ids are frozen and read back', () => {
  const a = { host: '192.168.1.40', port: 9621 };
  const b = { host: 'mca.local', port: 9622 };
  assert.equal(zoneId(a, 1, 3), '192.168.1.40_c1_z3');
  assert.equal(zoneId(b, 2, 12), 'mca.local_9622_c2_z12');
  assert.deepEqual(parseZoneId('192.168.1.40_c1_z3'), { ...a, controller: 1, zone: 3 });
  assert.deepEqual(parseZoneId('mca.local_9622_c2_z12'), { ...b, controller: 2, zone: 12 });
  for (const bad of ['192.168.1.40', '192.168.1.40_c0_z1', 'h_c7_z1', 'h_c1_z17', 'h_9621_c1_z1']) {
    assert.equal(parseZoneId(bad), undefined, bad);
  }
});

test('the volume cap', () => {
  assert.equal(normalizeConfig({}).maxVolume, 25);
  assert.equal(normalizeConfig({ max_volume: '60' }).maxVolume, 50);
  assert.equal(normalizeConfig({ max_volume: 0 }).maxVolume, 1);
  assert.equal(normalizeConfig({ max_volume: '' }).maxVolume, 25);
  assert.equal(normalizeConfig({ max_volume: true }).maxVolume, 25);
  const range = { maxVolume: 25 };
  assert.equal(percentToVolume(100, range), 25);
  assert.equal(percentToVolume(0, range), 0);
  assert.equal(percentToVolume(50, range), 13);
  for (let p = 0; p <= 100; p += 1) {
    assert.ok(percentToVolume(p, range) <= 25);
  }
  assert.equal(volumeToPercent(20, range), 80);
  assert.equal(volumeToPercent(50, range), 100);
});

test('the store keeps only valid entries, without prototype', () => {
  const data = sanitizeData({
    zones: {
      '192.168.1.40_c1_z3': {
        id: '192.168.1.40_c1_z3',
        name: 'Kitchen',
        sourceOptions: [
          { value: '1', label: 'Tuner' },
          { value: '1', label: 'Again' },
          { value: '99', label: 'Bad' },
          { value: '2' },
        ],
      },
      __proto__: { id: '__proto__' },
      x_c1_z1: { id: 'other' },
    },
    addresses: {
      '192.168.1.40': { mac: '00:21:C7:01:02:03', lastAttempt: 5, failures: 3 },
      'bad host': { mac: 'x' },
    },
  });
  assert.deepEqual(Object.keys(data.zones), ['192.168.1.40_c1_z3']);
  assert.deepEqual(data.zones['192.168.1.40_c1_z3'].sourceOptions, [
    { value: '1', label: 'Tuner' },
    { value: '2', label: 'Source 2' },
  ]);
  assert.deepEqual(data.addresses['192.168.1.40'], {
    mac: '00:21:c7:01:02:03',
    lastAttempt: 5,
    failures: 3,
  });
  assert.equal(Object.keys(data.addresses).length, 1);
  assert.equal(Object.getPrototypeOf(data.zones), null);
});

test('the file store: mode 0600, an unreadable file moved aside', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'russound-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore({ dir });
  await store.save({ zones: {}, addresses: {} });
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'russound.json'), 'utf8')), {
    zones: {},
    addresses: {},
  });
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(dir, 'russound.json'))).mode & 0o777, 0o600);
  }
  await writeFile(join(dir, 'russound.json'), '{oops');
  const broken = new FileStore({ dir });
  const data = await broken.load();
  assert.equal(broken.corrupted, true);
  assert.deepEqual(Object.keys(data.zones), []);
  await stat(join(dir, 'russound.json.bad'));
});

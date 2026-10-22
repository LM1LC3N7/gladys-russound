// -----------------------------------------------------------------------------
// The RIO protocol (pure): commands from a closed list, lines parsed once and
// bounded, values strict, no prototype pollution.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LineSplitter,
  applyMessage,
  commandLine,
  emptyState,
  encode,
  eventRequest,
  getRequest,
  maxZones,
  nowPlaying,
  parseLine,
  parseMac,
  parseVolume,
  versionAtLeast,
  watchRequest,
} from '../src/russound/protocol.js';

test('commands are built from a closed list, never from a text', () => {
  assert.equal(commandLine({ kind: 'version' }), 'VERSION');
  assert.equal(commandLine(getRequest('C[1].Z[2]', 'volume')), 'GET C[1].Z[2].volume');
  assert.equal(commandLine(watchRequest('S[3]')), 'WATCH S[3] ON');
  assert.equal(commandLine(eventRequest(1, 2, 'Volume', 25)), 'EVENT C[1].Z[2]!KeyPress Volume 25');
  assert.equal(
    commandLine(eventRequest(1, 2, 'SelectSource', 4)),
    'EVENT C[1].Z[2]!SelectSource 4',
  );
  assert.equal(commandLine(eventRequest(2, 8, 'ZoneOff')), 'EVENT C[2].Z[8]!ZoneOff');
  assert.deepEqual([...encode(eventRequest(1, 1, 'ZoneOn'))].at(-1), 13);
  for (const bad of [
    getRequest('C[1].Z[2]', 'volume\rEVENT'),
    getRequest('C[1].Z[2];', 'volume'),
    getRequest('C[7]', 'type'),
    getRequest('S[17]', 'name'),
    eventRequest(1, 1, 'Volume', 51),
    eventRequest(1, 1, 'Volume', 12.5),
    eventRequest(1, 1, 'Volume', '20'),
    eventRequest(1, 1, 'SelectSource', 0),
    eventRequest(1, 1, 'Reboot'),
    eventRequest(1, 1, 'toString'),
    eventRequest(1, 17, 'ZoneOn'),
    { kind: 'raw' },
  ]) {
    assert.throws(() => commandLine(bad), JSON.stringify(bad));
  }
});

test('lines', () => {
  assert.deepEqual(parseLine('S'), { type: 'S' });
  assert.deepEqual(parseLine('S VERSION="1.10.00"'), {
    type: 'S',
    branch: '',
    leaf: 'VERSION',
    value: '1.10.00',
  });
  assert.deepEqual(parseLine('N C[1].Z[2].volume="20"'), {
    type: 'N',
    branch: 'C[1].Z[2]',
    leaf: 'volume',
    value: '20',
  });
  assert.deepEqual(parseLine('N S[2].songName="Say "Hi""'), {
    type: 'N',
    branch: 'S[2]',
    leaf: 'songName',
    value: 'Say "Hi"',
  });
  assert.equal(parseLine('N S[2].songName="------"').value, null);
  assert.equal(parseLine('S C[1].Z[1].name=""').value, null);
  assert.deepEqual(parseLine('E Invalid zone'), { type: 'E', message: 'Invalid zone' });
  for (const bad of [
    '',
    'X a="b"',
    'N C[1].Z[1].volume=20',
    'N C[1].Z[1].vol\u0001ume="2"',
    'Sx',
  ]) {
    assert.equal(parseLine(bad), undefined, bad);
  }
  assert.equal(parseLine('N C[1].Z[1].__proto__="x"'), undefined);
});

test('the state reads only the known leaves, without prototype', () => {
  const state = emptyState();
  assert.deepEqual(applyMessage(state, parseLine('N C[1].Z[2].volume="20"')), {
    kind: 'zone',
    id: '1.2',
    leaf: 'volume',
  });
  assert.equal(state.zones['1.2'].volume, 20);
  assert.equal(applyMessage(state, parseLine('N C[1].Z[2].volume="20"')), undefined, 'unchanged');
  assert.equal(applyMessage(state, parseLine('N C[1].Z[2].volume="99"')).leaf, 'volume');
  assert.equal(state.zones['1.2'].volume, undefined, 'out of range: unknown');
  assert.equal(applyMessage(state, parseLine('N C[1].Z[2].bass="3"')), undefined);
  assert.equal(applyMessage(state, parseLine('N C[9].Z[2].volume="3"')), undefined);
  assert.equal(applyMessage(state, parseLine('N constructor.prototype.volume="3"')), undefined);
  applyMessage(state, parseLine('N C[1].Z[2].status="ON"'));
  applyMessage(state, parseLine('N C[1].Z[2].currentSource="3"'));
  applyMessage(state, parseLine('N S[3].name="Tuner‮"'));
  assert.equal(state.zones['1.2'].status, true);
  assert.equal(state.zones['1.2'].currentSource, 3);
  assert.equal(state.sources['3'].name, 'Tuner');
  assert.equal(Object.getPrototypeOf(state.zones), null);
  assert.equal({}.volume, undefined);
});

test('values', () => {
  assert.equal(parseVolume('0'), 0);
  assert.equal(parseVolume('50'), 50);
  for (const bad of ['51', '-1', '1.5', '', null, ' 2']) {
    assert.equal(parseVolume(bad), undefined, String(bad));
  }
  assert.equal(parseMac('00-21-C7-01-02-03'), '00:21:c7:01:02:03');
  assert.equal(parseMac('00:00:00:00:00:00'), undefined);
  assert.equal(parseMac('nope'), undefined);
  assert.equal(versionAtLeast('1.10.00', '1.09.00'), true);
  assert.equal(versionAtLeast('1.09.00', '1.09.00'), true);
  assert.equal(versionAtLeast('1.08.03', '1.09.00'), false);
  assert.equal(versionAtLeast('2.00.00', '1.09.00'), true);
  assert.equal(versionAtLeast('x', '1.09.00'), false);
  assert.equal(maxZones('MCA-88X'), 8);
  assert.equal(maxZones('MBX-PRE'), 1);
  assert.equal(maxZones('constructor'), 1);
  assert.equal(
    nowPlaying({ songName: 'So What', artistName: 'Miles Davis' }),
    'Miles Davis - So What',
  );
  assert.equal(nowPlaying({ songName: 'So What' }), 'So What');
  assert.equal(nowPlaying({ channelName: 'FIP' }), 'FIP');
  assert.equal(nowPlaying({}), undefined);
});

test('lines are split on CR or LF and bounded', () => {
  const splitter = new LineSplitter(20);
  assert.deepEqual(splitter.push('S\r\nN a="1"\rN b'), ['S', 'N a="1"']);
  assert.deepEqual(splitter.push('="2"\n'), ['N b="2"']);
  assert.deepEqual(splitter.push(`${'x'.repeat(15)}`), []);
  assert.deepEqual(splitter.push(`${'x'.repeat(15)}\nS\n`), ['S'], 'a too long line is dropped');
  // Linear on a long run without line break.
  const big = new LineSplitter();
  const start = Date.now();
  for (let i = 0; i < 2_000; i += 1) {
    big.push('y'.repeat(1_000));
  }
  assert.ok(Date.now() - start < 1_000);
  assert.deepEqual(big.push('\nS\n'), ['S']);
});

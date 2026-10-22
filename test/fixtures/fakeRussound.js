// -----------------------------------------------------------------------------
// A fake Russound controller on 127.0.0.1 (a random port), speaking RIO:
// `VERSION`, `GET <key>`, `WATCH <branch> ON` (then every value of the branch
// pushed as `N` lines, and every change after), `EVENT C[1].Z[n]!...`. An
// unknown key is answered `E`, as the real controllers.
// -----------------------------------------------------------------------------

import { createServer } from 'node:net';

export const MAC = '00:21:c7:01:02:03';

export async function startFakeRussound(options = {}) {
  const values = {
    VERSION: options.version ?? '1.10.00',
    'C[1].type': options.type ?? 'MCA-66',
    ...(options.mac === false ? {} : { 'C[1].macAddress': options.mac ?? MAC }),
    'S[1].name': 'Tuner',
    'S[2].name': 'Streamer',
    'S[2].songName': 'So What',
    'S[2].artistName': 'Miles Davis',
    'S[3].name': '',
    'C[1].Z[1].name': 'Kitchen',
    'C[1].Z[1].status': 'ON',
    'C[1].Z[1].volume': '20',
    'C[1].Z[1].mute': 'OFF',
    'C[1].Z[1].currentSource': '2',
    'C[1].Z[1].turnOnVolume': '20',
    'C[1].Z[2].name': 'Patio',
    'C[1].Z[2].status': 'OFF',
    'C[1].Z[2].volume': '10',
    'C[1].Z[2].mute': 'OFF',
    'C[1].Z[2].currentSource': '1',
    'C[1].Z[2].turnOnVolume': options.turnOnVolume ?? '20',
    ...options.values,
  };
  const fake = {
    values,
    received: [],
    sockets: new Set(),
    watched: new Map(),
    connections: 0,
    /** Commands (line prefixes) never answered. */
    unanswered: new Set(options.unanswered ?? []),
    /** Line prefix -> ms before the answer. */
    delays: { ...options.delays },
    silent: Boolean(options.silent),
    /** Events answered S but not applied (a controller ignoring them). */
    ignore: new Set(options.ignore ?? []),
    events() {
      return this.received.filter((line) => line.startsWith('EVENT'));
    },
    push(line) {
      for (const socket of this.sockets) {
        socket.write(`${line}\r\n`);
      }
    },
    write(data) {
      for (const socket of this.sockets) {
        socket.write(data);
      }
    },
    dropAll() {
      for (const socket of this.sockets) {
        socket.destroy();
      }
    },
    /** Sets a value and pushes it to the connections watching its branch. */
    set(key, value) {
      values[key] = value;
      const branch = key.slice(0, key.lastIndexOf('.'));
      for (const [socket, branches] of this.watched) {
        if (branches.has(branch) && !socket.destroyed) {
          socket.write(`N ${key}="${value}"\r\n`);
        }
      }
    },
  };

  const reply = (socket, line, text) => {
    if (fake.silent || [...fake.unanswered].some((p) => line.startsWith(p))) {
      return;
    }
    const send = () => {
      if (!socket.destroyed) {
        socket.write(`${text}\r\n`);
      }
    };
    const delay = Object.entries(fake.delays).find(([p]) => line.startsWith(p))?.[1];
    if (delay) {
      setTimeout(send, delay);
    } else {
      send();
    }
  };

  const event = (zone, name, arg) => {
    if (fake.ignore.has(name)) {
      return;
    }
    switch (name) {
      case 'ZoneOn':
        fake.set(`${zone}.status`, 'ON');
        if (options.wakeVolume !== undefined) {
          fake.set(`${zone}.volume`, String(options.wakeVolume));
        }
        break;
      case 'ZoneOff':
        fake.set(`${zone}.status`, 'OFF');
        break;
      case 'ZoneMuteOn':
        fake.set(`${zone}.mute`, 'ON');
        break;
      case 'ZoneMuteOff':
        fake.set(`${zone}.mute`, 'OFF');
        break;
      case 'KeyPress':
        if (arg[0] === 'Volume') {
          fake.set(`${zone}.volume`, arg[1]);
        }
        break;
      case 'SelectSource':
        fake.set(`${zone}.currentSource`, arg[0]);
        break;
      default:
    }
  };

  const handle = (socket, line) => {
    fake.received.push(line);
    if (line === 'VERSION') {
      reply(socket, line, `S VERSION="${values.VERSION}"`);
      return;
    }
    let m = /^GET (.+)$/.exec(line);
    if (m) {
      const key = m[1];
      if (Object.hasOwn(values, key)) {
        reply(socket, line, `S ${key}="${values[key]}"`);
      } else {
        reply(socket, line, 'E Invalid key');
      }
      return;
    }
    m = /^WATCH (.+) ON$/.exec(line);
    if (m) {
      const branch = m[1];
      if (!Object.keys(values).some((k) => k.startsWith(`${branch}.`))) {
        reply(socket, line, 'E Invalid branch');
        return;
      }
      if (!fake.watched.has(socket)) {
        fake.watched.set(socket, new Set());
      }
      fake.watched.get(socket).add(branch);
      reply(socket, line, 'S');
      if (!fake.silent) {
        for (const [key, value] of Object.entries(values)) {
          if (key.startsWith(`${branch}.`)) {
            socket.write(`N ${key}="${value}"\r\n`);
          }
        }
      }
      return;
    }
    m = /^EVENT (C\[\d\]\.Z\[\d{1,2}\])!(\w+)(?: (.*))?$/.exec(line);
    if (m) {
      if (!Object.hasOwn(values, `${m[1]}.name`)) {
        reply(socket, line, 'E Invalid zone');
        return;
      }
      if (fake.silent || [...fake.unanswered].some((p) => line.startsWith(p))) {
        return;
      }
      reply(socket, line, 'S');
      event(m[1], m[2], (m[3] ?? '').split(' '));
      return;
    }
    reply(socket, line, 'E Unknown command');
  };

  const server = createServer((socket) => {
    fake.connections += 1;
    fake.sockets.add(socket);
    socket.on('close', () => {
      fake.sockets.delete(socket);
      fake.watched.delete(socket);
    });
    socket.on('error', () => {});
    let text = '';
    socket.on('data', (chunk) => {
      for (const byte of chunk) {
        if (byte === 10 || byte === 13) {
          if (text.trim() !== '') {
            handle(socket, text.trim());
          }
          text = '';
        } else {
          text += String.fromCharCode(byte);
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.port = server.address().port;
  fake.close = () =>
    new Promise((resolve) => {
      fake.dropAll();
      server.close(() => resolve());
    });
  return fake;
}

/** A port on 127.0.0.1 where nothing listens (opened, then closed). */
export async function closedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

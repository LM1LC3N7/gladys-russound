// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark gradient, the front of
// a multiroom controller (a rack unit with a row of lit zone lights), a wall
// keypad with its small display, and sound waves. Plain Node (zlib), no
// dependency. Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
/** Antialiased coverage of a signed distance (negative inside). */
const inside = (distance) => Math.min(1, Math.max(0, 0.5 - distance));

/** Signed distance to a rounded rectangle centred on (cx, cy). */
function roundRect(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

const DARK = [10, 14, 22];
const NAVY = [30, 44, 70];
const FRONT = [40, 44, 52];
const FRONT_LIGHT = [74, 80, 92];
const PANEL = [16, 18, 22];
const GLOW = [90, 180, 255];
const OFF = [44, 60, 82];
const KEYPAD = [226, 228, 232];
const KEYPAD_SHADE = [188, 192, 200];
const KEY = [206, 210, 216];

const RACK = { cx: 290, cy: 300, w: 230, h: 58, r: 8 };
const PAD = { cx: 610, cy: 250, w: 62, h: 104, r: 14 };

function pixel(x, y) {
  let color = mix(DARK, NAVY, (x / WIDTH) * 0.5 + (y / HEIGHT) * 0.5);
  // Soft shadows under the controller and the keypad.
  color = mix(color, [0, 0, 0], (1 - Math.hypot((x - RACK.cx) / 260, (y - 378) / 16)) * 0.7);
  color = mix(color, [0, 0, 0], (1 - Math.hypot((x - PAD.cx) / 80, (y - 350) / 12)) * 0.5);
  // The rack unit: a brushed front, rack ears, a dark band.
  const rack = roundRect(x, y, RACK.cx, RACK.cy, RACK.w, RACK.h, RACK.r);
  const brushed = ((x * 7 + Math.floor(y / 2) * 13) % 17) / 17;
  const front = mix(
    mix(FRONT_LIGHT, FRONT, (y - RACK.cy + RACK.h) / (2 * RACK.h)),
    FRONT_LIGHT,
    brushed * 0.12,
  );
  color = mix(color, front, inside(rack));
  for (const ex of [RACK.cx - RACK.w + 14, RACK.cx + RACK.w - 14]) {
    color = mix(color, PANEL, inside(Math.hypot(x - ex, y - (RACK.cy - 30)) - 5));
    color = mix(color, PANEL, inside(Math.hypot(x - ex, y - (RACK.cy + 30)) - 5));
  }
  color = mix(color, PANEL, inside(roundRect(x, y, RACK.cx + 10, RACK.cy, 170, 22, 6)));
  // Six zone lights, four lit.
  for (let i = 0; i < 6; i += 1) {
    const lx = RACK.cx - 130 + i * 52;
    const lit = i !== 2 && i !== 5;
    const d = Math.hypot(x - lx, y - RACK.cy);
    if (lit) {
      color = mix(color, GLOW, Math.max(0, 1 - d / 22) * 0.35);
    }
    color = mix(color, lit ? GLOW : OFF, inside(d - 7));
  }
  // The power led.
  color = mix(color, GLOW, inside(Math.hypot(x - (RACK.cx - 200), y - RACK.cy) - 4));
  // The wall keypad: a plate, a small lit display, rows of keys.
  const pad = roundRect(x, y, PAD.cx, PAD.cy, PAD.w, PAD.h, PAD.r);
  color = mix(color, mix(KEYPAD, KEYPAD_SHADE, (y - PAD.cy + PAD.h) / (2 * PAD.h)), inside(pad));
  color = mix(color, PANEL, inside(roundRect(x, y, PAD.cx, PAD.cy - 56, 44, 22, 4)));
  color = mix(color, GLOW, inside(roundRect(x, y, PAD.cx - 6, PAD.cy - 62, 28, 3, 3)) * 0.9);
  color = mix(color, GLOW, inside(roundRect(x, y, PAD.cx - 14, PAD.cy - 50, 20, 2.5, 2.5)) * 0.7);
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 2; col += 1) {
      const kx = PAD.cx - 22 + col * 44;
      const ky = PAD.cy + 4 + row * 32;
      color = mix(color, KEY, inside(roundRect(x, y, kx, ky, 17, 11, 5)));
      color = mix(color, KEYPAD_SHADE, inside(Math.abs(roundRect(x, y, kx, ky, 17, 11, 5)) - 0.6));
    }
  }
  // Sound waves from the keypad.
  const wd = Math.hypot(x - PAD.cx, y - PAD.cy);
  const angle = Math.abs(Math.atan2(y - PAD.cy, x - PAD.cx));
  if (x > PAD.cx + 70 && angle < 0.55) {
    for (const r of [96, 122, 148]) {
      color = mix(color, GLOW, inside(Math.abs(wd - r) - 3.5) * (1 - angle / 0.55) * 0.9);
    }
  }
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);

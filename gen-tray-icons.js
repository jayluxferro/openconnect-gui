// Generates lib/tray-icon.js: the two menu-bar padlock icons (idle: hollow
// body; connected: filled body with a punched keyhole), each as a 16×16
// and a 32×32 @2x PNG. Monochrome black + alpha only — the app marks them
// as template images so macOS adapts them to light/dark menu bars.
//
// PNGs are encoded by hand (IHDR/IDAT/IEND, zlib IDAT, CRC32) because the
// project has no image dependencies and Node ships zlib.
//
// Run: node tmp/gen-tray-icons.js   (writes lib/tray-icon.js)

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  if (!crc32.table) {
    crc32.table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crc32.table[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = crc32.table[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(pixels, w, h) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      raw[o++] = 0; raw[o++] = 0; raw[o++] = 0;                    // black
      raw[o++] = pixels.has(`${x},${y}`) ? 255 : 0;                // alpha
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// The padlock on a 16×16 grid. Same shackle for both states; the body is
// hollow when idle and solid with a punched 2×2 keyhole when connected —
// the state distinction reads at 16 px without two different shapes.
const SHACKLE = new Set();
for (let x = 6; x <= 9; x++) SHACKLE.add(`${x},3`);
for (let y = 4; y <= 7; y++) { SHACKLE.add(`5,${y}`); SHACKLE.add(`10,${y}`); }
const KEYHOLE = [[7, 10], [8, 10], [7, 11], [8, 11]];

const idle = new Set(SHACKLE);
for (let x = 3; x <= 12; x++) { idle.add(`${x},8`); idle.add(`${x},13`); }
for (let y = 9; y <= 12; y++) { idle.add(`3,${y}`); idle.add(`12,${y}`); }
for (const [x, y] of KEYHOLE) idle.add(`${x},${y}`);

const connected = new Set(SHACKLE);
for (let y = 8; y <= 13; y++) for (let x = 3; x <= 12; x++) connected.add(`${x},${y}`);
for (const [x, y] of KEYHOLE) connected.delete(`${x},${y}`);

// Blocky scale for the @2x sheet: each logical pixel becomes factor×factor.
function scale(pixels, factor) {
  const out = new Set();
  for (const key of pixels) {
    const [x, y] = key.split(',').map(Number);
    for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) {
      out.add(`${x * factor + dx},${y * factor + dy}`);
    }
  }
  return out;
}

const b64 = (pixels, factor) =>
  encodePng(scale(pixels, factor), 16 * factor, 16 * factor).toString('base64');

const header = `// GENERATED FILE — do not edit by hand. Regenerate with:
//   node tmp/gen-tray-icons.js
//
// Two menu-bar padlock icons as embedded PNGs (monochrome + alpha; the app
// marks them template so macOS adapts them to light/dark menu bars):
//   TRAY_ICON_IDLE      hollow body (no tunnel)
//   TRAY_ICON_CONNECTED solid body with a punched keyhole (tunnel up)
// Each carries a 16×16 x1 and a 32×32 x2 (@2x) representation.

`;

const body = `module.exports = {
  TRAY_ICON_IDLE: {
    x1: '${b64(idle, 1)}',
    x2: '${b64(idle, 2)}'
  },
  TRAY_ICON_CONNECTED: {
    x1: '${b64(connected, 1)}',
    x2: '${b64(connected, 2)}'
  }
};
`;

fs.writeFileSync(path.join(__dirname, 'lib', 'tray-icon.js'), header + body);
console.log('lib/tray-icon.js written:',
  'idle', idle.size, 'px;',
  'connected', connected.size, 'px');

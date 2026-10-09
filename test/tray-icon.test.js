const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { TRAY_ICON_IDLE, TRAY_ICON_CONNECTED } = require('../lib/tray-icon');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function assertPng(b64, size, what) {
  const png = Buffer.from(b64, 'base64');
  assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), `${what} is not a PNG`);
  // IHDR starts at byte 8: 4-byte length + "IHDR", then big-endian width/height
  assert.strictEqual(png.readUInt32BE(16), size, `${what} width`);
  assert.strictEqual(png.readUInt32BE(20), size, `${what} height`);
}

test('tray icons decode to valid PNGs at 16px and 32px @2x', () => {
  assertPng(TRAY_ICON_IDLE.x1, 16, 'idle x1');
  assertPng(TRAY_ICON_IDLE.x2, 32, 'idle x2');
  assertPng(TRAY_ICON_CONNECTED.x1, 16, 'connected x1');
  assertPng(TRAY_ICON_CONNECTED.x2, 32, 'connected x2');
});

test('the two tray states are different art', () => {
  assert.notStrictEqual(TRAY_ICON_IDLE.x1, TRAY_ICON_CONNECTED.x1);
});

test('main.js builds the tray from the embedded buffers, not an asset file', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(code, /Buffer\.from\(spec\.x1, 'base64'\)/);
  assert.match(code, /addRepresentation\(\{ scaleFactor: 2/);
  // Template images let macOS restyle for light/dark menu bars.
  assert.match(code, /setTemplateImage\(true\)/);
  // The old failure mode: loading assets/tray-icon.png, a postinstall-generated
  // file that fresh clones and packaged builds silently shipped without.
  assert.doesNotMatch(code, /'assets',\s*'tray-icon\.png'/);
});

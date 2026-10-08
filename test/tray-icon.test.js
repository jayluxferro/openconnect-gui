const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { TRAY_ICON_BASE64 } = require('../lib/tray-icon');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('tray icon constant decodes to a valid 16x16 PNG', () => {
  const png = Buffer.from(TRAY_ICON_BASE64, 'base64');
  assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), 'constant is not a PNG');
  // IHDR starts at byte 8: 4-byte length + "IHDR", then big-endian width/height
  assert.strictEqual(png.readUInt32BE(16), 16, 'width');
  assert.strictEqual(png.readUInt32BE(20), 16, 'height');
});

test('main.js builds the tray from the embedded buffer, not an asset file', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(code, /nativeImage\.createFromBuffer\(Buffer\.from\(TRAY_ICON_BASE64/);
  // The old failure mode: loading assets/tray-icon.png, a postinstall-generated
  // file that fresh clones and packaged builds silently shipped without.
  assert.doesNotMatch(code, /'assets',\s*'tray-icon\.png'/);
});

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('update check only runs in packaged builds and can never crash startup', () => {
  const code = read('main.js');
  assert.match(code, /if \(!app\.isPackaged\)\s*\{\s*return;/, 'dev builds must skip the updater');
  assert.match(code, /autoUpdater\.checkForUpdates\(\)\.catch/, 'checkForUpdates must be caught');
  assert.match(code, /setupAutoUpdate\(\);/, 'updater must be wired into app startup');
});

test('a downloaded update installs via quitAndInstall after the user is asked', () => {
  const code = read('main.js');
  assert.match(code, /autoUpdater\.on\('update-downloaded'/);
  assert.match(code, /autoUpdater\.quitAndInstall\(\)/);
});

test('signature verification and downgrade protection stay at their secure defaults', () => {
  const code = read('main.js');
  // Disabling either would let a compromised feed push old or differently
  // signed builds.
  assert.doesNotMatch(code, /verifyUpdateCodeSignature\s*=\s*false/);
  assert.doesNotMatch(code, /allowDowngrade\s*=\s*true/);
});

test('build ships an update feed: zip target plus GitHub publish config', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.build.mac.target.includes('zip'), 'macOS updates ride the zip target');
  assert.strictEqual(pkg.build.publish.provider, 'github');
  assert.strictEqual(pkg.build.publish.owner, 'jayluxferro');
  assert.strictEqual(pkg.build.publish.repo, 'openconnect-gui');
});

test('SECURITY.md discloses the update channel', () => {
  const doc = read('SECURITY.md');
  assert.match(doc, /Application updates\./);
  assert.match(doc, /matches the Developer ID/);
});

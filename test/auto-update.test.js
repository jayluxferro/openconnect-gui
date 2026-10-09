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
  // The prompt must warn that restarting drops an active VPN session
  assert.match(code, /Restarting will disconnect the active VPN session/);
});

test('updater diagnostics reach stdout, not only the Logs tab', () => {
  const code = read('main.js');
  // sendLog delivers only while the main window is alive; the console mirror
  // keeps update errors visible in terminal captures of packaged builds
  assert.match(code, /console\.error\(`\[update\] \$\{message\}`\)/);
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

test('manual update check: footer and tray share one path, dev builds answer honestly', () => {
  const code = read('main.js');
  // A second click (window + tray racing the automatic check) must return
  // the in-flight state instead of starting a competing check
  assert.match(code, /updateCheckInFlight/);
  assert.match(code, /ipcMain\.handle\('check-for-updates', async \(\) => checkForUpdatesFromUI\(\)\)/);
  assert.match(code, /'check-update': \(\) => checkForUpdatesFromTray\(\)/);
  // Dev builds have no update feed (setupAutoUpdate skips them): the manual
  // check must say so rather than pretend or crash
  assert.match(code, /phase: 'unavailable'/);
  // Live phases stream to the renderer while the check runs, so the footer
  // can show download progress, not just a final answer
  assert.match(code, /send\('update-state', updateState\)/);
  // Restart-and-install is guarded on a completed download — a stale
  // renderer must not be able to quit the app via quitAndInstall
  assert.match(code, /ipcMain\.handle\('install-update', async \(\) => \{/);
  assert.match(code, /if \(updateState\.phase === 'ready'\) \{/);
});

test('preload exposes the manual update surface to the renderer', () => {
  const code = read('preload.js');
  assert.match(code, /checkForUpdates: \(\) => ipcRenderer\.invoke\('check-for-updates'\)/);
  assert.match(code, /installUpdate: \(\) => ipcRenderer\.invoke\('install-update'\)/);
  assert.match(code, /onUpdateState/);
});

test('the footer offers the check and renders its live status', () => {
  const code = read('src/App.jsx');
  assert.match(code, /window\.electronAPI\.checkForUpdates\(\)/);
  assert.match(code, /window\.electronAPI\.onUpdateState/);
  assert.match(code, /Check for Updates/);
  assert.match(code, /phase === 'downloading'/);
  assert.match(code, /window\.electronAPI\.installUpdate\(\)/);
});

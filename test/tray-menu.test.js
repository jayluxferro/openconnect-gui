const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { buildTrayTemplate, statusLabel } = require('../lib/tray-menu');

const PROFILES = [
  { name: 'work', server: 'vpn.work.example', username: 'alice', password: 'secret' },
  { name: 'lab', server: 'vpn.lab.example', username: 'bob', password: '' }
];

const find = (items, label) => items.find((item) => item.label === label);

test('disconnected: status line, Connect submenu of profiles, no Disconnect', () => {
  const items = buildTrayTemplate({ status: 'disconnected', activeProfile: null, profiles: PROFILES });

  const status = items[0];
  assert.strictEqual(status.label, 'OpenConnect VPN — Not connected');
  assert.strictEqual(status.enabled, false);

  const connect = find(items, 'Connect');
  assert.ok(connect, 'Connect item present');
  assert.strictEqual(connect.enabled, true);
  assert.deepStrictEqual(
    connect.submenu.map((item) => item.profile),
    ['work', 'lab'],
    'submenu lists every saved profile by name'
  );
  assert.strictEqual(connect.submenu[0].action, 'connect-profile');

  assert.ok(!find(items, 'Disconnect work'), 'no disconnect item while idle');
  assert.strictEqual(find(items, 'Show OpenConnect VPN').action, 'show');
  assert.strictEqual(find(items, 'Quit OpenConnect VPN').action, 'quit');
});

test('connected: Disconnect named after the active profile, no Connect submenu', () => {
  const items = buildTrayTemplate({ status: 'connected', activeProfile: 'work', profiles: PROFILES });

  assert.strictEqual(items[0].label, 'OpenConnect VPN — Connected to work');
  const disconnect = find(items, 'Disconnect work');
  assert.ok(disconnect, 'Disconnect names the profile');
  assert.strictEqual(disconnect.action, 'disconnect');
  assert.strictEqual(disconnect.enabled, true);
  assert.ok(!find(items, 'Connect'), 'no Connect submenu while connected');
});

test('connecting: aborting is offered; disconnecting: it is not', () => {
  const connecting = buildTrayTemplate({ status: 'connecting', activeProfile: 'work', profiles: PROFILES });
  assert.strictEqual(find(connecting, 'Disconnect work').enabled, true);

  const disconnecting = buildTrayTemplate({ status: 'disconnecting', activeProfile: 'work', profiles: PROFILES });
  assert.strictEqual(find(disconnecting, 'Disconnect work').enabled, false);
});

test('no saved profiles: Connect is present but disabled', () => {
  const items = buildTrayTemplate({ status: 'disconnected', activeProfile: null, profiles: [] });
  assert.strictEqual(find(items, 'Connect').enabled, false);
});

test('statusLabel wording and safe fallbacks', () => {
  assert.strictEqual(statusLabel({ status: 'connected', activeProfile: 'work' }), 'Connected to work');
  assert.strictEqual(statusLabel({ status: 'connected', activeProfile: null }), 'Connected');
  assert.strictEqual(statusLabel({ status: 'connecting' }), 'Connecting…');
  assert.strictEqual(statusLabel({ status: 'disconnecting' }), 'Disconnecting…');
  assert.strictEqual(statusLabel({ status: 'disconnected' }), 'Not connected');
  // An unknown internal state must read as idle, never leak a raw enum word
  assert.strictEqual(statusLabel({ status: 'reconnecting' }), 'Not connected');
  assert.strictEqual(statusLabel({}), 'Not connected');
});

test('main.js wires the tray through the builder and real handlers', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  // The menu comes from the pure builder, not a second hand-written template
  assert.match(code, /buildFromTemplate\(wire\(buildTrayTemplate\(state\)\)\)/);
  // Tray actions reuse the exact IPC paths the window uses
  assert.match(code, /connectFromTray/);
  assert.match(code, /'connect-profile': \(\{ profile \}\) => connectFromTray\(profile\)/);
  assert.match(code, /disconnect: \(\) => disconnectVPN\(\)/);
  assert.match(code, /async function connectVpn\(config\)/);
  assert.match(code, /ipcMain\.handle\('connect-vpn', async \(event, config\) => connectVpn\(config\)\)/);
  assert.match(code, /activeProfileName = config\.profileName \|\| null/);
  // Connected state swaps the icon
  assert.match(code, /TRAY_ICON_CONNECTED : TRAY_ICON_IDLE/);
  // Quitting from the tray warns about a live tunnel
  assert.match(code, /Quit and disconnect the VPN\?/);
  // Headless connect on a password-less profile opens the window instead
  assert.match(code, /send\('select-profile', profile\.name\)/);
});

test('preload exposes the select-profile event to the renderer', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(code, /onSelectProfile/);
  assert.match(code, /'select-profile'/);
});

test('renderer forwards the profile name with every connect', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ConnectionForm.jsx'), 'utf8');
  assert.match(code, /profileName: formData\.profileName \|\| undefined/);
});

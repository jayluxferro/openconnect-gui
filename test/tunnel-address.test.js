const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { parseTunnelAddress } = require('../lib/tunnel-address');

test('parses the address from a real current-build line', () => {
  // Verbatim shape from a 2026-10-09 session log (address replaced):
  assert.equal(
    parseTunnelAddress('Configured as 192.168.98.179, with SSL connected and DTLS disabled [EXPECT] VPN connection established!'),
    '192.168.98.179'
  );
});

test('parses the older "Connected as" phrasing', () => {
  assert.equal(parseTunnelAddress('Connected as 10.0.0.2'), '10.0.0.2');
});

test('parses an IPv6 tunnel address', () => {
  assert.equal(parseTunnelAddress('Configured as fd00:1234:5678::1, with SSL connected'), 'fd00:1234:5678::1');
});

test('case-insensitive and mid-line', () => {
  assert.equal(parseTunnelAddress('oke: CONFIGURED AS 10.1.2.3 done'), '10.1.2.3');
});

test('non-matching and malformed lines return null', () => {
  assert.equal(parseTunnelAddress('Configured as'), null); // address missing
  assert.equal(parseTunnelAddress('Configured as '), null);
  assert.equal(parseTunnelAddress('Session authentication will expire at Fri, 23 Oct 2026 10:32:28 GMT'), null);
  assert.equal(parseTunnelAddress('Disconnected'), null);
  assert.equal(parseTunnelAddress(''), null);
  assert.equal(parseTunnelAddress(null), null);
  assert.equal(parseTunnelAddress(undefined), null);
  assert.equal(parseTunnelAddress(42), null);
});

test('a hostname after "as" is not mistaken for an address', () => {
  // The capture only accepts dotted-quad or hex/colon shapes; "vpn.example" qualifies
  // as neither, so a hypothetical phrasing like this yields nothing rather than junk.
  assert.equal(parseTunnelAddress('Configured as vpn.example.com, with SSL connected'), null);
});

test('server-controlled banner lines cannot spoof the address', () => {
  // openconnect prefixes Connect Banner lines with "| " and the banner text
  // is whatever the VPN server sends. A hostile server must not be able to
  // plant a fake "VPN:" address in the header.
  assert.equal(parseTunnelAddress('| Configured as 6.6.6.6'), null);
  assert.equal(parseTunnelAddress('  | Connected as 6.6.6.6'), null);
  // The genuine line never carries the banner prefix
  assert.equal(parseTunnelAddress('Configured as 6.6.6.6, with SSL connected'), '6.6.6.6');
});

test('main.js feeds connection lines to the parser and retires the address on disconnect', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  // Both stream loggers share one line callback (openconnect speaks on stderr;
  // whole lines only, so the parser never sees half an address)
  assert.match(code, /const onConnectionLine = \(text\) => \{/);
  assert.match(code, /const address = parseTunnelAddress\(text\);/);
  assert.match(code, /createLineLogger\(onConnectionLine\)/);
  // The parsed address reaches the renderer as its own event
  assert.match(code, /send\('tunnel-address', address\)/);
  // Disconnect clears it and tells the renderer, so no stale address from a
  // previous session can survive into the next one's header
  assert.match(code, /send\('tunnel-address', null\)/);
});

test('preload exposes the tunnel-address event', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(code, /onTunnelAddress/);
  assert.match(code, /'tunnel-address'/);
});

test('the header shows the VPN address beside the public IP', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.jsx'), 'utf8');
  assert.match(code, /onTunnelAddress\(\(address\) => \{/);
  assert.match(code, /\{vpnAddress && \(/);
  // The tooltip must explain why the public IP does not change on split tunnel
  assert.match(code, /split-tunnel VPNs your public IP stays the same/);
});

// Run with: npm run test:unit
// The expect harness (test/vpn-connect.test.sh) feeds the script's stdin
// itself, so it cannot notice if main.js stops writing the credentials to
// stdin -- or puts them back on argv. This reads main.js's source, the same
// approach as openconnect-args.test.js, and pins the wiring: argv stays
// credential-free (#4), and the three credentials plus the sudo-prompt nonce
// reach the child on stdin (#36).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
// Drop whole-line comments only; a trailing // would also cut https:// strings.
const code = mainSource.replace(/^\s*\/\/.*$/gm, '');

test('expect argv carries only the script, the binary and openconnect flags', () => {
  const m = code.match(/const expectArgs = \[([\s\S]*?)\];/);
  assert.ok(m, 'expectArgs array not found in main.js');
  assert.doesNotMatch(m[1], /sudoPassword|config\.username|config\.password|vpnPassword/i);
});

test('credentials are pre-encoded, then written to the child stdin as lines', () => {
  // Pre-encoding before the spawn matters: encodeURIComponent throws on
  // lone surrogates, and a throw after spawn would strand the child.
  assert.match(code, /\.map\(\(value\) => encodeURIComponent\(value\)\)/);
  assert.match(code, /\[\.\.\.encodedCredentials, sudoPromptNonce\]/);
  assert.match(code, /stdin\.write\(line \+ '\\n'\)/);
});

test('username and password are type-checked before the handshake', () => {
  assert.match(code, /typeof config\.username !== 'string' \|\| typeof config\.password !== 'string'/);
});

test('the sudo-prompt nonce comes from crypto, not something a peer could predict', () => {
  assert.match(code, /crypto\.randomBytes\(16\)\.toString\('hex'\)/);
});

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('load-profiles reports the storage mode so the UI is not guessing', () => {
  const code = read('main.js');
  assert.match(
    code,
    /passwordStorage:\s*passwordStorageMode\(\)/,
    'load-profiles must return passwordStorage on every success path'
  );
  assert.match(
    code,
    /function passwordStorageMode\(\)\s*\{\s*return safeStorage\.isEncryptionAvailable\(\) \? 'encrypted' : 'unavailable';/,
    'storage mode must be derived from safeStorage, not hard-coded'
  );
});

test('ConnectionForm states the storage mode from props, never a fixed claim', () => {
  const form = read('src/components/ConnectionForm.jsx');
  // The pre-#6 UI hard-coded "stored in plaintext locally" under the password
  // field and kept showing it after encryption landed — the pin ensures that
  // unconditional claim stays gone.
  assert.ok(!form.includes('stored in plaintext locally'), 'static plaintext claim is back');
  assert.match(form, /passwordStorage === 'encrypted'/);
  assert.match(form, /passwordStorage === 'unavailable'/);
});

test('App.jsx passes the storage mode down to ConnectionForm', () => {
  const app = read('src/App.jsx');
  assert.match(app, /setPasswordStorage\(result\.passwordStorage \|\| null\)/);
  assert.match(app, /passwordStorage=\{passwordStorage\}/);
});

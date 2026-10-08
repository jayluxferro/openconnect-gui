const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.jsx'), 'utf8');

test('IP refetch fires only on real status transitions, not on mount', () => {
  // Deps-effects also run on mount; without the previous-status guard the
  // "disconnected" startup state triggered a second Current IP log line
  // right after the mount fetch.
  assert.match(app, /prevStatusRef/, 'transition guard missing');
  assert.match(
    app,
    /const disconnectedNow = currentStatus === 'disconnected' && prev === 'connected';/,
    'disconnect must only count when the VPN was actually connected before'
  );
  assert.match(
    app,
    /const connectedNow = currentStatus === 'connected' && prev && prev !== 'connected';/,
    'connect must require a previous status (skips the startup settle)'
  );
});

test('the IP fetch timeout is actually enforced', () => {
  // fetch() silently ignores a bare `timeout` option; AbortSignal.timeout
  // is the working form.
  assert.match(app, /AbortSignal\.timeout\(5000\)/);
  assert.doesNotMatch(app, /\{ timeout: 5000 \}/);
});

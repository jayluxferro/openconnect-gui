const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('splash auto-advances once every check passes', () => {
  const splash = read('src/Splash.jsx');
  // The beat exists
  assert.match(splash, /const AUTO_ADVANCE_MS = \d+;/);
  // The auto-advance lives in the all-green branch only — the failure
  // branch ("Setup Required") must keep waiting for a human decision.
  assert.match(
    splash,
    /setStatusText\('System checks completed successfully!'\);[\s\S]{0,120}timers\.push\(setTimeout\(\(\) => advance\(\), AUTO_ADVANCE_MS\)\);/
  );
  // Exactly one auto-advance call site: not also wired into the failure path
  assert.equal((splash.match(/, AUTO_ADVANCE_MS\)/g) || []).length, 1);
});

test('button and timer share one gate; the button stays as the manual path', () => {
  const splash = read('src/Splash.jsx');
  assert.match(
    splash,
    /const advance = \(\) => \{\s*if \(advanced\.current\) return;\s*advanced\.current = true;\s*window\.ocSplash\?\.ready\(\);\s*\};/
  );
  assert.match(splash, /const handleLoginClick = \(\) => \{\s*advance\(\);\s*\};/);
  // The button itself is not removed — impatient users skip the beat, and it
  // is the fallback if the timer somehow never fires
  assert.match(splash, /Continue to OpenConnect/);
});

test('main window creation is double-fire safe', () => {
  const main = read('main.js');
  // A second splash-ready (auto-advance racing a click) must not stack a
  // second main window; a stale reference after a real close must not block.
  assert.match(main, /if \(mainWindow && !mainWindow\.isDestroyed\(\)\) \{/);
});

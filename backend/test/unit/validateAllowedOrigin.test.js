'use strict';
// UNIT TESTS for the production ALLOWED_ORIGIN boot check (audit point 3).
// No network, no browser.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const { validateAllowedOrigin } = require('../../src/config/validateAllowedOrigin');

test('production without ALLOWED_ORIGIN throws a clear error naming the missing variable', () => {
  assert.throws(
    () => validateAllowedOrigin({ nodeEnv: 'production', allowedOrigin: undefined }),
    /ALLOWED_ORIGIN/,
    'error message must name the exact missing variable'
  );
});

test('production with an empty-string ALLOWED_ORIGIN also throws (same as unset)', () => {
  assert.throws(
    () => validateAllowedOrigin({ nodeEnv: 'production', allowedOrigin: '' }),
    /ALLOWED_ORIGIN/
  );
});

test('production with ALLOWED_ORIGIN configured does not throw', () => {
  assert.doesNotThrow(() =>
    validateAllowedOrigin({ nodeEnv: 'production', allowedOrigin: 'https://flipradar.example.com' })
  );
});

test('development without ALLOWED_ORIGIN does not throw (local dev keeps working as-is)', () => {
  assert.doesNotThrow(() => validateAllowedOrigin({ nodeEnv: 'development', allowedOrigin: undefined }));
});

test('development without NODE_ENV set at all does not throw (same as development)', () => {
  assert.doesNotThrow(() => validateAllowedOrigin({ nodeEnv: undefined, allowedOrigin: undefined }));
});

// End-to-end confirmation that the REAL server.js actually refuses to boot,
// not just that the extracted validator throws — guards against a future
// change accidentally moving the check after getBrowser()/app.listen(), or
// wiring it up incorrectly. Spawns the real file as a child process; the
// check runs before getBrowser() so this never touches a real browser and
// should exit almost immediately.
test('server.js integration: process exits with a failure status when booted in production without ALLOWED_ORIGIN', () => {
  const backendRoot = path.join(__dirname, '..', '..');
  const result = spawnSync(process.execPath, [path.join(backendRoot, 'src/server.js')], {
    cwd: backendRoot,
    env: { ...process.env, NODE_ENV: 'production', ALLOWED_ORIGIN: '', PORT: '0' },
    timeout: 5000,
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0, 'the process must not exit successfully');
  assert.equal(result.signal, null, 'the process must exit on its own (process.exit), not be killed/timed out');
});

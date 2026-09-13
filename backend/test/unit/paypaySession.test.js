'use strict';
// UNIT TESTS for the in-memory PayPay cookie cache (src/paypaySession.js).
// No network, no browser. Pure logic: get/set/invalidate, TTL expiry,
// snapshot immutability, and the essential-cookies-only filter.

const { test, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const {
  ESSENTIAL_COOKIE_NAMES,
  CACHE_TTL_MS,
  getCachedCookies,
  setCachedCookies,
  invalidateCachedCookies,
} = require('../../src/paypaySession');

function cookie(name, value = 'v') {
  return { name, value, domain: '.yahoo.co.jp', path: '/', expires: 4000000000, httpOnly: true, secure: true, sameSite: 'Lax' };
}

// The cache is process-wide (module-level) state — reset it before every
// test so tests can't leak into each other.
beforeEach(() => {
  invalidateCachedCookies();
});

test('getCachedCookies returns null when nothing has been cached yet', () => {
  assert.equal(getCachedCookies(), null);
});

// Test 10: only the 4 essential cookies are ever stored, even if the caller
// passes extras (analytics/tracking cookies like _gcl_au, or anything else).
test('setCachedCookies stores only A, XA, B, XB — never analytics/tracking cookies', () => {
  setCachedCookies([
    cookie('A'),
    cookie('_gcl_au'),
    cookie('XA'),
    cookie('_yjsu_yjad'),
    cookie('B'),
    cookie('someOtherCookie'),
    cookie('XB'),
  ]);
  const cached = getCachedCookies();
  assert.ok(cached);
  assert.deepEqual(
    cached.map((c) => c.name).sort(),
    [...ESSENTIAL_COOKIE_NAMES].sort()
  );
});

test('setCachedCookies with none of the essential cookies present does not populate the cache', () => {
  setCachedCookies([cookie('_gcl_au'), cookie('someOtherCookie')]);
  assert.equal(getCachedCookies(), null, 'a result with none of the 4 essential cookies must not look like a valid cache');
});

test('invalidateCachedCookies clears a previously cached session', () => {
  setCachedCookies([cookie('A'), cookie('XA'), cookie('B'), cookie('XB')]);
  assert.ok(getCachedCookies());
  invalidateCachedCookies();
  assert.equal(getCachedCookies(), null);
});

// Test 9: getCachedCookies() must return an immutable snapshot — neither
// mutating the returned array/objects, nor a later setCachedCookies() call,
// may affect a snapshot already handed to a caller.
test('getCachedCookies returns an immutable snapshot unaffected by later cache writes or mutation', () => {
  setCachedCookies([cookie('A', 'first'), cookie('XA', 'first'), cookie('B', 'first'), cookie('XB', 'first')]);

  // Mutating a caller's own snapshot must not affect the cache (uses its own
  // snapshot instance, separate from the one used below).
  const snapshotForMutationTest = getCachedCookies();
  snapshotForMutationTest[0].value = 'tampered';
  const freshAfterMutation = getCachedCookies();
  assert.equal(freshAfterMutation.find((c) => c.name === 'A').value, 'first', 'mutating a returned snapshot must not affect the underlying cache');

  // Replacing the cache must not retroactively change a DIFFERENT, untouched
  // snapshot taken before the replacement (simulates: search A took a
  // snapshot, search B concurrently refreshes the cache — A's in-flight
  // snapshot must be safe).
  const snapshotBeforeRefresh = getCachedCookies();
  setCachedCookies([cookie('A', 'second'), cookie('XA', 'second'), cookie('B', 'second'), cookie('XB', 'second')]);
  assert.equal(snapshotBeforeRefresh.find((c) => c.name === 'A').value, 'first', 'a snapshot taken before a cache refresh must stay unchanged');
  const snapshotAfterRefresh = getCachedCookies();
  assert.equal(snapshotAfterRefresh.find((c) => c.name === 'A').value, 'second');
});

// Test 8: TTL expiry — a cache older than CACHE_TTL_MS must be treated as
// empty, forcing a fresh warmup. Uses node:test's built-in timer mocking so
// this runs instantly instead of waiting the real TTL.
test('a cache older than CACHE_TTL_MS is treated as expired (empty)', () => {
  mock.timers.enable({ apis: ['Date'] });
  try {
    setCachedCookies([cookie('A'), cookie('XA'), cookie('B'), cookie('XB')]);
    assert.ok(getCachedCookies(), 'must be valid immediately after being set');

    mock.timers.tick(CACHE_TTL_MS - 1000);
    assert.ok(getCachedCookies(), 'must still be valid just before the TTL elapses');

    mock.timers.tick(2000); // now past CACHE_TTL_MS since it was set
    assert.equal(getCachedCookies(), null, 'must be treated as expired once the TTL has elapsed');
  } finally {
    mock.timers.reset();
  }
});

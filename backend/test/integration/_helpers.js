'use strict';
// Shared helpers for test/integration/* — see test/README.md.
// Not itself a test file (no `.test.js` suffix), so node:test won't run it.

const assert = require('node:assert/strict');

const NONSENSE_QUERY = 'zzzzxqwnonexistentitem999888';
const DEFAULT_TIMEOUT_MS = 45000;

// Checks the invariants every normalized item must satisfy, regardless of
// which real listing came back (title/price/exact URL are never asserted —
// live inventory changes constantly).
function assertWellFormedItem(item, expectedSource, urlPrefix) {
  assert.equal(typeof item.title, 'string', 'item.title must be a string');
  assert.ok(item.title.length > 0, 'item.title must not be empty');
  assert.ok(
    item.price === null || (typeof item.price === 'number' && Number.isFinite(item.price)),
    'item.price must be a finite number or null'
  );
  assert.equal(typeof item.url, 'string', 'item.url must be a string');
  assert.ok(
    item.url.startsWith(urlPrefix),
    `item.url should start with ${urlPrefix}, got: ${item.url}`
  );
  assert.equal(item.source, expectedSource, `item.source must equal '${expectedSource}'`);
}

module.exports = { NONSENSE_QUERY, DEFAULT_TIMEOUT_MS, assertWellFormedItem };

'use strict';
// FAILURE-SCENARIO TESTS — no network, no real browser. See test/README.md
// and src/scrapers/yahoo.skill.md ("Maintenance signals").

const { test } = require('node:test');
const assert = require('node:assert/strict');

const yahoo = require('../../src/scrapers/yahoo');
const { makeFakeContext } = require('./_fakeContext');

test('yahoo.search: rethrows on navigation failure (retryable)', async () => {
  const ctx = makeFakeContext({
    goto: async () => {
      throw new Error('page.goto: Timeout 12000ms exceeded');
    },
  });
  await assert.rejects(() => yahoo.search(ctx, 'iphone'), /Timeout/);
});

test('yahoo.search: resolves to [] without throwing when .Product never renders', async () => {
  // Ambiguous by design: could mean a legitimate 0-result search page, or a
  // slow render. yahoo.js intentionally treats this as "no results", not an
  // error — see yahoo.skill.md "Maintenance signals". This test locks in that
  // choice so a future change doesn't accidentally turn empty Yahoo searches
  // into errors.
  const ctx = makeFakeContext({
    waitForSelector: async () => {
      throw new Error('Timeout waiting for selector "li.Product"');
    },
  });
  const results = await yahoo.search(ctx, 'iphone');
  assert.deepEqual(results, []);
});

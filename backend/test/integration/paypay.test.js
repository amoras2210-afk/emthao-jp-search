'use strict';
// INTEGRATION TEST — requires real internet access and launches a real
// Chromium browser via Playwright. Hits the live paypayfleamarket.yahoo.co.jp
// (including its geo-warmup navigation). See test/README.md and
// src/scrapers/paypay.skill.md.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { getBrowser, newContext } = require('../../src/browser');
const paypay = require('../../src/scrapers/paypay');
const { NONSENSE_QUERY, DEFAULT_TIMEOUT_MS, assertWellFormedItem } = require('./_helpers');

let context;

before(async () => {
  await getBrowser();
  context = await newContext();
});

after(async () => {
  await context?.close().catch(() => {});
  const browser = await getBrowser();
  await browser.close().catch(() => {});
});

test('paypay.search: real query returns an array of well-formed items', { timeout: DEFAULT_TIMEOUT_MS }, async () => {
  const results = await paypay.search(context, 'iphone', { limit: 5 });

  assert.ok(Array.isArray(results), 'paypay.search must resolve to an array');
  assert.ok(
    results.length > 0,
    'expected at least one live result for a popular query — if this fails ' +
      'consistently (not just a one-off flake), the homepage-warmup geo-bypass ' +
      'may have stopped working; see paypay.skill.md "Maintenance signals"'
  );

  for (const item of results) {
    assertWellFormedItem(item, 'paypay', 'https://paypayfleamarket.yahoo.co.jp/');
  }
});

test('paypay.search: a query with no plausible matches does not throw', { timeout: DEFAULT_TIMEOUT_MS }, async () => {
  const results = await paypay.search(context, NONSENSE_QUERY, { limit: 5 });
  assert.ok(Array.isArray(results), 'paypay.search must resolve to an array even for an empty result set');
});

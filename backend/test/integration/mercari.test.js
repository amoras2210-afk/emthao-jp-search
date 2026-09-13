'use strict';
// INTEGRATION TEST — requires real internet access and launches a real
// Chromium browser via Playwright. Hits the live jp.mercari.com. See
// test/README.md and src/scrapers/mercari.skill.md.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { getBrowser, newContext } = require('../../src/browser');
const mercari = require('../../src/scrapers/mercari');
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

test('mercari.search: real query returns an array of well-formed items', { timeout: DEFAULT_TIMEOUT_MS }, async () => {
  const results = await mercari.search(context, 'iphone', { limit: 5 });

  assert.ok(Array.isArray(results), 'mercari.search must resolve to an array');
  assert.ok(
    results.length > 0,
    'expected at least one live result for a popular query — if this fails ' +
      'consistently (not just a one-off flake), check for API drift per ' +
      'mercari.skill.md "Maintenance signals"'
  );

  for (const item of results) {
    assertWellFormedItem(item, 'mercari', 'https://jp.mercari.com/item/');
  }
});

test('mercari.search: a query with no plausible matches does not throw', { timeout: DEFAULT_TIMEOUT_MS }, async () => {
  const results = await mercari.search(context, NONSENSE_QUERY, { limit: 5 });
  assert.ok(Array.isArray(results), 'mercari.search must resolve to an array even for an empty result set');
});

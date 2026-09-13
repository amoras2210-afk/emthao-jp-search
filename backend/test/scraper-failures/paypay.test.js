'use strict';
// FAILURE-SCENARIO TESTS — no network, no real browser. See test/README.md
// and src/scrapers/paypay.skill.md ("Maintenance signals" + "Lessons learned").

const { test } = require('node:test');
const assert = require('node:assert/strict');

const paypay = require('../../src/scrapers/paypay');
const { makeFakeContext, sequence } = require('./_fakeContext');

test('paypay.search: rethrows when the homepage warmup navigation fails (retryable)', async () => {
  const ctx = makeFakeContext({
    goto: async () => {
      throw new Error('page.goto: Timeout 12000ms exceeded');
    },
  });
  await assert.rejects(() => paypay.search(ctx, 'iphone'), /Timeout/);
});

test('paypay.search: resolves to [] without throwing on a non-200 search response after warmup', async () => {
  const ctx = makeFakeContext({
    goto: sequence([
      async () => ({ status: () => 200 }), // homepage warmup
      async () => ({ status: () => 404 }), // search still gated
    ]),
  });
  const results = await paypay.search(ctx, 'iphone');
  assert.deepEqual(results, []);
});

test('paypay.search: resolves to [] without throwing when no item anchors render', async () => {
  const ctx = makeFakeContext({
    goto: async () => ({ status: () => 200 }),
    waitForSelector: async () => {
      throw new Error('Timeout waiting for selector \'a[href*="/item/"]\'');
    },
  });
  const results = await paypay.search(ctx, 'iphone');
  assert.deepEqual(results, []);
});

test('paypay.search: detects the geo-block/recommendations fallback and resolves to [] instead of leaking fake results', async () => {
  // This is the single most important defensive check in paypay.js: without
  // it, the scraper would return ~96 unrelated recommendation items as if
  // they were real search hits, identically for every query. See
  // paypay.skill.md "Lessons learned" #1. $$eval throws if reached, so this
  // test also fails loudly if the geo-block short-circuit ever gets bypassed.
  const ctx = makeFakeContext({
    goto: async () => ({ status: () => 200 }),
    waitForSelector: async () => {},
    evaluate: async () => 'データの取得に失敗しました ... あなたへのおすすめ ...',
    $$eval: async () => {
      throw new Error('should never reach $$eval once geo-block markers are detected');
    },
  });
  const results = await paypay.search(ctx, 'iphone');
  assert.deepEqual(results, []);
});

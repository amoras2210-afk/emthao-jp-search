'use strict';
// FAILURE-SCENARIO TESTS — no network, no real browser. Exercises the real
// mercari.search() function with a fake Playwright context/page so its
// navigation/response error handling can be tested deterministically. See
// test/README.md and src/scrapers/mercari.skill.md ("Maintenance signals").

const { test } = require('node:test');
const assert = require('node:assert/strict');

const mercari = require('../../src/scrapers/mercari');
const { makeFakeContext } = require('./_fakeContext');

function fakeApiResponse(body) {
  return {
    url: () => 'https://api.mercari.jp/v2/entities:search',
    request: () => ({ method: () => 'POST' }),
    json: async () => body,
  };
}

test('mercari.search: rethrows on navigation failure (retryable)', async () => {
  const ctx = makeFakeContext({
    goto: async () => {
      throw new Error('page.goto: Timeout 12000ms exceeded');
    },
  });
  await assert.rejects(() => mercari.search(ctx, 'iphone'), /Timeout/);
});

test('mercari.search: rethrows when the search API response is never observed (retryable)', async () => {
  const ctx = makeFakeContext({
    // Mercari's SPA fires this API call for every search, including 0-result
    // ones — never observing it means the page failed to load, not a real
    // empty search. Real Playwright resolves this to null via .catch(() =>
    // null) after its own internal timeout; we simulate that outcome directly.
    waitForResponse: async () => null,
  });
  await assert.rejects(() => mercari.search(ctx, 'iphone'), /not observed/);
});

test('mercari.search: rethrows on malformed API JSON (retryable)', async () => {
  const ctx = makeFakeContext({
    waitForResponse: async () => ({
      url: () => 'https://api.mercari.jp/v2/entities:search',
      request: () => ({ method: () => 'POST' }),
      json: async () => {
        throw new Error('Unexpected token in JSON');
      },
    }),
  });
  await assert.rejects(() => mercari.search(ctx, 'iphone'), /Unexpected token/);
});

test('mercari.search: a genuinely empty result set resolves to [] without throwing', async () => {
  const ctx = makeFakeContext({
    waitForResponse: async () => fakeApiResponse({ items: [] }),
  });
  const results = await mercari.search(ctx, 'iphone');
  assert.deepEqual(results, []);
});

test('mercari.search: filters out sold-out items and Shops/Beyond listings', async () => {
  const ctx = makeFakeContext({
    waitForResponse: async () =>
      fakeApiResponse({
        items: [
          {
            id: 'm111',
            name: 'Sold item',
            price: '1000',
            status: 'ITEM_STATUS_SOLD_OUT',
            itemType: 'ITEM_TYPE_MERCARI',
            itemConditionId: '1',
          },
          {
            id: 'P9oQg44shop',
            name: 'Shop item',
            price: '2000',
            status: 'ITEM_STATUS_ON_SALE',
            itemType: 'ITEM_TYPE_MERCARI',
            shop: { id: 's1' },
            itemConditionId: '1',
          },
          {
            id: 'm222',
            name: 'Live item',
            price: '3000',
            status: 'ITEM_STATUS_ON_SALE',
            itemType: 'ITEM_TYPE_MERCARI',
            itemConditionId: '1',
          },
        ],
      }),
  });
  const results = await mercari.search(ctx, 'iphone');
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Live item');
  assert.equal(results[0].price, 3000);
  assert.equal(results[0].url, 'https://jp.mercari.com/item/m222');
  assert.equal(results[0].source, 'mercari');
});

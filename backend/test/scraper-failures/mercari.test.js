'use strict';
// FAILURE-SCENARIO TESTS — no network, no real browser. Exercises the real
// mercari.search() function with a fake Playwright context/page so its
// navigation/response error handling can be tested deterministically. See
// test/README.md and src/scrapers/mercari.skill.md ("Maintenance signals").

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');

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

// --- Cancellation via opts.signal (2026-09-17 "zombie attempt" fix) ---
// See routes/search.js/withTimeout.js: when the outer per-source deadline
// expires, it aborts a controller scoped to this attempt. mercari.js reacts
// by closing its page immediately instead of waiting out its own internal
// navigation timeout. These fakes emulate the one real-Playwright contract
// this relies on — closing a page rejects its pending goto/waitForResponse —
// since the shared _fakeContext.js double does not model that on its own.

test('mercari.search: on abort, closes the page promptly and rejects without waiting for a hung navigation', async () => {
  let closeCalls = 0;
  let rejectGoto;
  const gotoPromise = new Promise((_resolve, reject) => {
    rejectGoto = reject;
  });
  const controller = new AbortController();
  let gotoInvokedAt = null;

  const ctx = makeFakeContext({
    // Abort right as the (hung) navigation begins, via queueMicrotask rather
    // than a fixed wall-clock delay: paceDomain() (src/concurrency.js) can
    // itself impose a real ≥1s wait per host BEFORE goto() is even called,
    // shared as module-level state across every test in this file — a fixed
    // setTimeout(30ms) would then race unpredictably against that delay and
    // could fire before `await page.goto(...)` has even attached its
    // rejection handler. Deferring to a microtask instead guarantees the
    // abort only happens once goto() has been invoked and its promise is
    // already being awaited, matching the real-world case (an external
    // deadline firing while goto/waitForResponse is genuinely in flight).
    goto: () => {
      gotoInvokedAt = Date.now();
      queueMicrotask(() => controller.abort());
      return gotoPromise;
    },
    // waitForResponse is registered before goto but never matters here:
    // goto itself never settles until close() rejects it below.
    waitForResponse: () => new Promise(() => {}),
    close: async () => {
      closeCalls++;
      rejectGoto(new Error('Target page, context or browser has been closed'));
    },
  });

  const searchPromise = mercari.search(ctx, 'iphone', { signal: controller.signal });

  await assert.rejects(() => searchPromise);

  // Measured from when goto() actually started (not from search()'s own
  // start), since paceDomain()'s real ≥1s per-host pacing happens BEFORE
  // goto() and is unrelated to how fast abort-driven cancellation reacts.
  const elapsedSinceGoto = Date.now() - gotoInvokedAt;
  // onAbort() closes the page immediately, AND the existing unconditional
  // `finally { await page.close() }` calls it again afterwards (real
  // Playwright tolerates closing an already-closed page) — so this fires
  // at least once, promptly, not exactly once.
  assert.ok(closeCalls >= 1, 'page.close() must be called at least once on abort');
  assert.ok(
    elapsedSinceGoto < 500,
    `search() must reject shortly after abort, not hang for a full internal timeout (took ${elapsedSinceGoto}ms since goto() started)`
  );
});

test('mercari.search: removes its abort listener when finishing normally (no leak)', async () => {
  const ctx = makeFakeContext({
    waitForResponse: async () => ({
      url: () => 'https://api.mercari.jp/v2/entities:search',
      request: () => ({ method: () => 'POST' }),
      json: async () => ({ items: [] }),
    }),
  });
  const controller = new AbortController();
  await mercari.search(ctx, 'iphone', { signal: controller.signal });
  assert.equal(
    getEventListeners(controller.signal, 'abort').length,
    0,
    'search() must remove its abort listener once it settles, success or failure'
  );
});

test('mercari.search: removes its abort listener even when the scrape fails (no leak on the error path)', async () => {
  const ctx = makeFakeContext({
    waitForResponse: async () => null,
  });
  const controller = new AbortController();
  await assert.rejects(() => mercari.search(ctx, 'iphone', { signal: controller.signal }));
  assert.equal(
    getEventListeners(controller.signal, 'abort').length,
    0,
    'the abort listener must be removed on the error path too'
  );
});

test('mercari.search: never opens a page if the signal is already aborted before start', async () => {
  const ctx = makeFakeContext({});
  let newPageCalls = 0;
  const realNewPage = ctx.newPage;
  ctx.newPage = async (...args) => {
    newPageCalls++;
    return realNewPage(...args);
  };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => mercari.search(ctx, 'iphone', { signal: controller.signal }),
    /aborted before start/
  );
  assert.equal(newPageCalls, 0, 'context.newPage() must never be called once the signal is already aborted');
});

test('mercari.search: without a signal, behavior is unchanged', async () => {
  const ctx = makeFakeContext({
    waitForResponse: async () => fakeApiResponse({ items: [] }),
  });
  const results = await mercari.search(ctx, 'iphone');
  assert.deepEqual(results, []);
});

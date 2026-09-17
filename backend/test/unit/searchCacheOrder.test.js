'use strict';
// UNIT TEST for the cache-key/sources-order bug fixed 2026-09-17 (audit
// finding): cache.js's cacheKey() used to sort `sources` before building the
// key, so `sources=mercari,yahoo` and `sources=yahoo,mercari` collided on
// the SAME cache entry — but routes/search.js echoes `sources`/`results`
// back in the REQUESTED order, baked into the cached payload at write time.
// A second request with a different order than the one that originally
// populated the cache silently got back the first request's order instead
// of its own.
//
// No network, no real Chromium: browser.js and the 3 scrapers are
// substituted via require.cache before routes/search.js is required — same
// technique as test/unit/searchGlobalConcurrency.test.js /
// flipradarContract.test.js. Runs the REAL, unmodified route handler and
// cache module behind a real (ephemeral, localhost-only) HTTP server.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const backendRoot = path.join(__dirname, '..', '..');

function fakeModule(relPath, exportsObj) {
  const fullPath = require.resolve(path.join(backendRoot, relPath));
  require.cache[fullPath] = { id: fullPath, filename: fullPath, loaded: true, exports: exportsObj };
}

fakeModule('src/browser.js', {
  newContext: async () => ({ close: async () => {} }),
  getBrowser: async () => ({ close: async () => {} }),
  isConnected: async () => true,
});

let mercariCalls = 0;
let yahooCalls = 0;

// MERCARI_API_TIMEOUT_MS is required on the fake: routes/search.js reads it
// at module-load time to compute Mercari's explicit outer deadline (Option A
// design) — omitting it makes that computation NaN.
fakeModule('src/scrapers/mercari.js', {
  MERCARI_API_TIMEOUT_MS: 40000,
  search: async (context, q) => {
    mercariCalls++;
    return [
      {
        title: `mercari-item-${q}`,
        url: 'https://jp.mercari.com/item/m1',
        source: 'mercari',
        price: 1000,
        currency: 'JPY',
        condition: null,
      },
    ];
  },
});
fakeModule('src/scrapers/yahoo.js', {
  search: async (context, q) => {
    yahooCalls++;
    return [
      {
        title: `yahoo-item-${q}`,
        url: 'https://auctions.yahoo.co.jp/jp/auction/y1',
        source: 'yahoo',
        price: 2000,
        currency: 'JPY',
      },
    ];
  },
});
fakeModule('src/scrapers/paypay.js', {
  search: async () => [],
});

// NOW require the real, unmodified route + cache — they pick up the fakes above.
const express = require(path.join(backendRoot, 'node_modules/express'));
const searchRouter = require(path.join(backendRoot, 'src/routes/search.js'));

async function startServer() {
  const app = express();
  app.use(searchRouter);
  const server = app.listen(0);
  return { server, port: server.address().port };
}

test('legacy sources=: two different source orders for the same query never collide, and cache hits then respect each order', async () => {
  const { server, port } = await startServer();
  try {
    const q = 'CacheOrderTestLegacy';

    // 1. mercari,yahoo -> cache miss, order preserved
    const r1 = await fetch(`http://127.0.0.1:${port}/search?q=${q}&sources=mercari,yahoo`);
    const b1 = await r1.json();
    assert.equal(r1.status, 200);
    assert.equal(b1.cached, false, 'first request for this order must be a cache miss');
    assert.deepEqual(b1.sources, ['mercari', 'yahoo']);
    assert.deepEqual(b1.results.map((it) => it.source), ['mercari', 'yahoo']);

    // 2. yahoo,mercari (same q, different order) -> must ALSO be a cache
    // miss (this is the exact bug: it used to be a false cache hit that
    // returned request 1's order instead of its own).
    const r2 = await fetch(`http://127.0.0.1:${port}/search?q=${q}&sources=yahoo,mercari`);
    const b2 = await r2.json();
    assert.equal(r2.status, 200);
    assert.equal(b2.cached, false, 'a different source order must not collide with the first order\'s cache entry');
    assert.deepEqual(b2.sources, ['yahoo', 'mercari'], 'the response must reflect THIS request\'s order, not the first one\'s');
    assert.deepEqual(b2.results.map((it) => it.source), ['yahoo', 'mercari']);

    // 3. Data correctness: both responses carry the same underlying items,
    // just in different order/shape position.
    assert.equal(b1.count, 2);
    assert.equal(b2.count, 2);
    assert.deepEqual(
      new Set(b1.results.map((it) => it.url)),
      new Set(b2.results.map((it) => it.url)),
      'both orders must resolve to the same underlying set of items'
    );

    // 4. A third request identical to request 2 (yahoo,mercari) -> cache hit.
    const r3 = await fetch(`http://127.0.0.1:${port}/search?q=${q}&sources=yahoo,mercari`);
    const b3 = await r3.json();
    assert.equal(b3.cached, true, 'repeating the exact same order must be a cache hit');
    assert.deepEqual(b3.sources, ['yahoo', 'mercari']);

    // 5. A fourth request identical to request 1 (mercari,yahoo) -> cache hit.
    const r4 = await fetch(`http://127.0.0.1:${port}/search?q=${q}&sources=mercari,yahoo`);
    const b4 = await r4.json();
    assert.equal(b4.cached, true, 'repeating the exact same order must be a cache hit');
    assert.deepEqual(b4.sources, ['mercari', 'yahoo']);

    // Exactly 2 real scrapes per source happened in total: one for each
    // distinct order (requests 1 and 2) — requests 3 and 4 must have been
    // served entirely from cache, not re-scraped.
    assert.equal(mercariCalls, 2, 'mercari.search() must run once per distinct order, not per request');
    assert.equal(yahooCalls, 2, 'yahoo.search() must run once per distinct order, not per request');
  } finally {
    server.close();
  }
});

test('FlipRadar marketplaces=: the same order-independence fix applies to the FlipRadar contract', async () => {
  const { server, port } = await startServer();
  try {
    const q = 'CacheOrderTestFlipRadar';

    const rA = await fetch(`http://127.0.0.1:${port}/search?q=${q}&marketplaces=MERCARI_JP,YAHOO_AUCTIONS_JP`);
    const bA = await rA.json();
    assert.equal(bA.cached, false);
    assert.deepEqual(
      bA.sources.map((s) => s.source),
      ['MERCARI_JP', 'YAHOO_AUCTIONS_JP']
    );

    const rB = await fetch(`http://127.0.0.1:${port}/search?q=${q}&marketplaces=YAHOO_AUCTIONS_JP,MERCARI_JP`);
    const bB = await rB.json();
    assert.equal(bB.cached, false, 'a different marketplaces= order must not collide with the first cache entry');
    assert.deepEqual(
      bB.sources.map((s) => s.source),
      ['YAHOO_AUCTIONS_JP', 'MERCARI_JP'],
      'the FlipRadar response must reflect THIS request\'s order too'
    );

    // Repeating request B exactly must now be a cache hit.
    const rB2 = await fetch(`http://127.0.0.1:${port}/search?q=${q}&marketplaces=YAHOO_AUCTIONS_JP,MERCARI_JP`);
    const bB2 = await rB2.json();
    assert.equal(bB2.cached, true);
    assert.deepEqual(
      bB2.sources.map((s) => s.source),
      ['YAHOO_AUCTIONS_JP', 'MERCARI_JP']
    );
  } finally {
    server.close();
  }
});

test('the legacy and FlipRadar contracts never share a cache entry for the same query/sources (unchanged, pre-existing behavior)', async () => {
  const { server, port } = await startServer();
  try {
    const q = 'CacheOrderTestContractSeparation';

    const legacy = await fetch(`http://127.0.0.1:${port}/search?q=${q}&sources=mercari,yahoo`);
    const legacyBody = await legacy.json();
    assert.equal(legacyBody.cached, false);
    // Legacy shape: `sources` is a plain string array.
    assert.deepEqual(legacyBody.sources, ['mercari', 'yahoo']);

    const flipradar = await fetch(`http://127.0.0.1:${port}/search?q=${q}&marketplaces=MERCARI_JP,YAHOO_AUCTIONS_JP`);
    const flipradarBody = await flipradar.json();
    assert.equal(flipradarBody.cached, false, 'the FlipRadar contract must not accidentally hit the legacy contract\'s cache entry');
    // FlipRadar shape: `sources` is an array of {source, status, error, count}.
    assert.deepEqual(
      flipradarBody.sources.map((s) => s.source),
      ['MERCARI_JP', 'YAHOO_AUCTIONS_JP']
    );
  } finally {
    server.close();
  }
});

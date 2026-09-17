'use strict';
// UNIT TESTS for the FlipRadar API-contract adapter added to routes/search.js,
// routes/health.js and config/searchAuth.js. No network, no real Chromium:
// browser.js and the 3 scrapers are substituted via require.cache before the
// real route modules are required (same technique as
// searchGlobalConcurrency.test.js / searchRateLimit.test.js). Runs the REAL,
// unmodified route handlers behind a real (ephemeral, localhost-only) HTTP
// server.
//
// Covers:
//  - `marketplaces=MERCARI_JP,...` reshapes results into FlipRadar's
//    JpSearchItem/JpSearchResponse contract (emthaoProvider.ts /
//    httpProvider.ts on the FlipRadar side).
//  - The legacy `sources=mercari,...` param used by the existing
//    emthao-jp-search/frontend is completely unaffected (same item shape as
//    before this change).
//  - Cache entries for the two contracts don't collide.
//  - Per-source ERROR status when a scraper exhausts every retry attempt,
//    without failing the whole request (other sources still return LIVE).
//  - /health's per-marketplace `providers` breakdown.
//  - The optional JP_SEARCH_SERVICE_TOKEN Bearer-auth middleware, scoped to
//    /search only (never /health).

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

// Mercari fake includes a realistic Japanese condition label + /item/<id> url
// so externalId derivation and condition mapping can both be exercised.
// MERCARI_API_TIMEOUT_MS is required here too: routes/search.js reads it at
// module-load time to compute Mercari's explicit outer deadline (2026-09-17
// Option A design) — omitting it makes that computation NaN, and
// setTimeout(fn, NaN) fires almost immediately in Node (see
// searchGlobalConcurrency.test.js's fuller comment on this).
fakeModule('src/scrapers/mercari.js', {
  MERCARI_API_TIMEOUT_MS: 40000,
  search: async (context, q) => [
    {
      title: `mercari-${q}`,
      price: 1000,
      image: 'https://static.mercdn.net/item/thumb1.jpg',
      url: 'https://jp.mercari.com/item/m12345678901',
      condition: '新品、未使用',
      source: 'mercari',
      currency: 'JPY',
    },
  ],
});

fakeModule('src/scrapers/yahoo.js', {
  search: async (context, q) => [
    {
      title: `yahoo-${q}`,
      price: 2000,
      image: 'https://example.com/yahoo.jpg',
      url: 'https://auctions.yahoo.co.jp/jp/auction/x987654321',
      condition: null,
      source: 'yahoo',
      currency: 'JPY',
      bidCount: 3,
      timeLeft: '残り 1日',
      mode: 'auction',
    },
  ],
});

// PAYPAY_ALWAYS_FAIL lets individual tests opt a fake paypay scraper into
// always throwing (to exercise the ERROR-status path) vs. succeeding
// normally, without needing a second require.cache swap mid-file (the module
// is only require()'d once, the first time routes/search.js pulls it in).
let paypayShouldFail = false;
fakeModule('src/scrapers/paypay.js', {
  search: async (context, q) => {
    if (paypayShouldFail) throw new Error('simulated PayPay scraper failure');
    return [
      {
        title: `paypay-${q}`,
        price: 500,
        image: null,
        url: 'https://paypayfleamarket.yahoo.co.jp/item/z1122334455',
        condition: null,
        source: 'paypay',
        currency: 'JPY',
      },
    ];
  },
});

const express = require(path.join(backendRoot, 'node_modules/express'));
const searchRouter = require(path.join(backendRoot, 'src/routes/search.js'));
const healthRouter = require(path.join(backendRoot, 'src/routes/health.js'));
const { requireBearerToken } = require(path.join(backendRoot, 'src/config/searchAuth.js'));

async function startServer({ token = '' } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.use('/search', requireBearerToken(token));
  app.use(searchRouter);
  app.use(healthRouter);
  const server = app.listen(0);
  const port = server.address().port;
  return { server, port };
}

test('marketplaces= reshapes results into the FlipRadar JpSearchItem/JpSearchResponse contract', async () => {
  const { server, port } = await startServer();
  try {
    const resp = await fetch(
      `http://127.0.0.1:${port}/search?q=bag&marketplaces=MERCARI_JP,YAHOO_AUCTIONS_JP,PAYPAY_FLEA_JP&nocache=1`
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();

    assert.equal(body.unofficial, true, 'FlipRadar-contract responses must set unofficial: true');
    assert.equal(typeof body.hasNextPage, 'boolean', 'JpSearchResponse requires hasNextPage');

    assert.deepEqual(
      body.sources.map((s) => s.source),
      ['MERCARI_JP', 'YAHOO_AUCTIONS_JP', 'PAYPAY_FLEA_JP'],
      'sources must use FlipRadar marketplace IDs, in requested order'
    );
    for (const s of body.sources) {
      assert.equal(s.status, 'LIVE');
      assert.equal(s.error, null);
      assert.equal(s.count, 1);
    }

    assert.deepEqual(
      body.results.map((r) => r.source),
      ['MERCARI_JP', 'YAHOO_AUCTIONS_JP', 'PAYPAY_FLEA_JP'],
      'item.source must match one of opts.id exactly — httpProvider.ts filters on r.source === opts.id'
    );

    const mercariItem = body.results.find((r) => r.source === 'MERCARI_JP');
    assert.equal(mercariItem.externalId, 'm12345678901', 'externalId must be derived from the /item/<id> url');
    assert.deepEqual(mercariItem.images, ['https://static.mercdn.net/item/thumb1.jpg'], 'image (singular) must become images (array)');
    assert.equal(mercariItem.condition, 'NEW', 'Japanese Mercari condition label must map to the FlipRadar enum');
    assert.equal(mercariItem.currency, 'JPY');
    assert.equal(mercariItem.sourceCountry, 'JP');
    assert.equal(mercariItem.isDemo, false);
    assert.equal(mercariItem.availability, 'AVAILABLE');
    assert.equal(mercariItem.listingType, 'BUY_NOW');
    assert.equal(typeof mercariItem.fetchedAt, 'string');

    const yahooItem = body.results.find((r) => r.source === 'YAHOO_AUCTIONS_JP');
    assert.equal(yahooItem.externalId, 'x987654321', 'externalId must be derived from the /auction/<id> url');
    assert.equal(yahooItem.listingType, 'AUCTION', 'mode: "auction" must map to listingType: AUCTION');
    assert.equal(yahooItem.bidCount, 3);
  } finally {
    server.close();
  }
});

test('legacy sources= keeps the exact original item/response shape for the existing emthao-jp-search/frontend', async () => {
  const { server, port } = await startServer();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/search?q=bag&sources=mercari,yahoo,paypay&nocache=1`);
    assert.equal(resp.status, 200);
    const body = await resp.json();

    assert.equal(body.unofficial, undefined, 'legacy shape must not gain the unofficial field');
    assert.equal(body.hasNextPage, undefined, 'legacy shape must not gain the hasNextPage field');
    assert.deepEqual(body.sources, ['mercari', 'yahoo', 'paypay'], 'legacy sources field stays a plain string array');

    const mercariItem = body.results.find((r) => r.source === 'mercari');
    assert.ok(mercariItem, 'item.source must stay the internal lowercase id (ResultCard.jsx keys CSS classes on it)');
    assert.equal(mercariItem.image, 'https://static.mercdn.net/item/thumb1.jpg', 'item.image (singular) must be preserved');
    assert.equal(mercariItem.condition, '新品、未使用', 'raw Japanese condition must be preserved (frontend translates client-side)');
    assert.equal(mercariItem.externalId, undefined, 'legacy items must not gain FlipRadar-only fields');
    assert.equal(mercariItem.images, undefined);

    const yahooItem = body.results.find((r) => r.source === 'yahoo');
    assert.equal(yahooItem.mode, 'auction', 'item.mode must be preserved for the mode badge');
    assert.equal(yahooItem.timeLeft, '残り 1日', 'item.timeLeft must be preserved for client-side translation');
  } finally {
    server.close();
  }
});

test('the two contracts do not share cache entries for the same effective query', async () => {
  const { server, port } = await startServer();
  try {
    const flipradarResp = await fetch(`http://127.0.0.1:${port}/search?q=cachekey&marketplaces=MERCARI_JP`);
    const legacyResp = await fetch(`http://127.0.0.1:${port}/search?q=cachekey&sources=mercari`);
    const flipradarBody = await flipradarResp.json();
    const legacyBody = await legacyResp.json();

    assert.equal(flipradarBody.results[0].source, 'MERCARI_JP');
    assert.equal(legacyBody.results[0].source, 'mercari');

    // Re-fetch both a second time (cache hit path) — shapes must still be
    // correct per-contract, proving the cache key doesn't collide across
    // the two contracts.
    const flipradarResp2 = await fetch(`http://127.0.0.1:${port}/search?q=cachekey&marketplaces=MERCARI_JP`);
    const legacyResp2 = await fetch(`http://127.0.0.1:${port}/search?q=cachekey&sources=mercari`);
    const flipradarBody2 = await flipradarResp2.json();
    const legacyBody2 = await legacyResp2.json();

    assert.equal(flipradarBody2.cached, true);
    assert.equal(legacyBody2.cached, true);
    assert.equal(flipradarBody2.results[0].source, 'MERCARI_JP');
    assert.equal(legacyBody2.results[0].source, 'mercari');
  } finally {
    server.close();
  }
});

test('a source that exhausts every retry attempt reports ERROR without failing the whole request', async (t) => {
  paypayShouldFail = true;
  t.after(() => {
    paypayShouldFail = false;
  });

  const { server, port } = await startServer();
  try {
    const resp = await fetch(
      `http://127.0.0.1:${port}/search?q=bag&marketplaces=MERCARI_JP,PAYPAY_FLEA_JP&nocache=1`
    );
    assert.equal(resp.status, 200, 'one failing source must not fail the whole /search request');
    const body = await resp.json();

    const mercariStatus = body.sources.find((s) => s.source === 'MERCARI_JP');
    const paypayStatus = body.sources.find((s) => s.source === 'PAYPAY_FLEA_JP');
    assert.equal(mercariStatus.status, 'LIVE', 'a healthy source must be unaffected by another source failing');
    assert.equal(mercariStatus.count, 1);
    assert.equal(paypayStatus.status, 'ERROR');
    assert.equal(paypayStatus.count, 0);
    assert.match(paypayStatus.error, /unavailable/i);

    assert.deepEqual(body.results.map((r) => r.source), ['MERCARI_JP'], 'the failing source must contribute zero items');
  } finally {
    server.close();
  }
});

test('/health returns the per-marketplace providers breakdown FlipRadar reads', async () => {
  const { server, port } = await startServer();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.unofficial, true);
    assert.deepEqual(body.providers, {
      MERCARI_JP: 'LIVE',
      YAHOO_AUCTIONS_JP: 'LIVE',
      PAYPAY_FLEA_JP: 'LIVE',
    });
  } finally {
    server.close();
  }
});

test('Bearer token: /search requires the configured token, /health never does', async () => {
  const { server, port } = await startServer({ token: 'secret-token' });
  try {
    const noAuth = await fetch(`http://127.0.0.1:${port}/search?q=bag&marketplaces=MERCARI_JP&nocache=1`);
    assert.equal(noAuth.status, 401, 'missing Authorization header must be rejected once a token is configured');

    const wrongAuth = await fetch(`http://127.0.0.1:${port}/search?q=bag&marketplaces=MERCARI_JP&nocache=1`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.equal(wrongAuth.status, 401);

    const rightAuth = await fetch(`http://127.0.0.1:${port}/search?q=bag&marketplaces=MERCARI_JP&nocache=1`, {
      headers: { Authorization: 'Bearer secret-token' },
    });
    assert.equal(rightAuth.status, 200);

    // /health must stay reachable with no Authorization header at all —
    // Render's own platform health check sends none (see config/searchAuth.js).
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200, '/health must never require the search token, or Render marks the service unhealthy');
  } finally {
    server.close();
  }
});

test('Bearer token: unset JP_SEARCH_SERVICE_TOKEN is a no-op (local dev / legacy frontend unaffected)', async () => {
  const { server, port } = await startServer({ token: '' });
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/search?q=bag&sources=mercari&nocache=1`);
    assert.equal(resp.status, 200, 'no Authorization header must be accepted when no token is configured');
  } finally {
    server.close();
  }
});

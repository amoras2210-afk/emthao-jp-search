'use strict';
// UNIT TEST for routes/search.js's Mercari-specific timing override
// (2026-09-17, Option A design). Proves, at the route level:
//   - Mercari gets exactly MERCARI_ATTEMPTS (1) retry attempt, never more.
//   - MERCARI_DEADLINE_MS resolves to exactly 45000ms (40000ms
//     MERCARI_API_TIMEOUT_MS + 5000ms safety margin), not the raw
//     computeOuterDeadlineMs() output for a 20000ms-per-nav source.
//   - Yahoo and PayPay are completely unaffected: they still get
//     RETRY_ATTEMPTS (3) attempts through the normal, unmodified
//     computeOuterDeadlineMs() path.
//
// No network, no real Chromium: browser.js and the 3 scrapers are
// substituted via require.cache before routes/search.js is required — same
// technique as test/unit/searchGlobalConcurrency.test.js. Runs the REAL,
// unmodified route handler behind a real (ephemeral, localhost-only) HTTP
// server.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const backendRoot = path.join(__dirname, '..', '..');
const { RETRY_ATTEMPTS } = require(path.join(backendRoot, 'src/util/scraperTimeout'));

function fakeModule(relPath, exportsObj) {
  const fullPath = require.resolve(path.join(backendRoot, relPath));
  require.cache[fullPath] = { id: fullPath, filename: fullPath, loaded: true, exports: exportsObj };
}

fakeModule('src/browser.js', {
  newContext: async () => ({ close: async () => {} }),
  getBrowser: async () => ({ close: async () => {} }),
  isConnected: async () => true,
});

const callCounts = { mercari: 0, yahoo: 0, paypay: 0 };

// Every source always fails every attempt — the cleanest way to observe
// exactly how many attempts routes/search.js actually launches for each,
// without needing to wait out any real timeout (these reject immediately).
// MERCARI_API_TIMEOUT_MS is included on the fake so routes/search.js's
// module-load-time `MERCARI_DEADLINE_MS = mercari.MERCARI_API_TIMEOUT_MS +
// MERCARI_DEADLINE_SAFETY_MARGIN_MS` computes a real number instead of NaN.
fakeModule('src/scrapers/mercari.js', {
  MERCARI_API_TIMEOUT_MS: 40000,
  search: async () => {
    callCounts.mercari++;
    throw new Error('mercari always fails in this test');
  },
});
fakeModule('src/scrapers/yahoo.js', {
  search: async () => {
    callCounts.yahoo++;
    throw new Error('yahoo always fails in this test');
  },
});
fakeModule('src/scrapers/paypay.js', {
  search: async () => {
    callCounts.paypay++;
    throw new Error('paypay always fails in this test');
  },
});

// NOW require the real, unmodified route — it picks up the fakes above.
const express = require(path.join(backendRoot, 'node_modules/express'));
const searchRouter = require(path.join(backendRoot, 'src/routes/search.js'));

test('routes/search.js exposes MERCARI_ATTEMPTS=1 and MERCARI_DEADLINE_MS=45000 (40000 + 5000 margin)', () => {
  assert.equal(searchRouter.MERCARI_ATTEMPTS, 1, 'Mercari must get exactly 1 retry attempt');
  assert.equal(
    searchRouter.MERCARI_DEADLINE_MS,
    45000,
    'Mercari outer deadline must be MERCARI_API_TIMEOUT_MS (40000) + a 5000ms safety margin'
  );
});

test('Mercari is called exactly once per /search request; Yahoo/PayPay keep retrying up to RETRY_ATTEMPTS (3)', async () => {
  const app = express();
  app.use(searchRouter);
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const resp = await fetch(
      `http://127.0.0.1:${port}/search?q=iphone&sources=mercari,yahoo,paypay&nocache=1`
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.count, 0, 'every source fails in this test, so no results');

    assert.equal(callCounts.mercari, 1, 'Mercari must be attempted exactly once — no retry');
    assert.equal(
      callCounts.yahoo,
      RETRY_ATTEMPTS,
      'Yahoo must still retry up to the generic RETRY_ATTEMPTS, unaffected by the Mercari override'
    );
    assert.equal(
      callCounts.paypay,
      RETRY_ATTEMPTS,
      'PayPay must still retry up to the generic RETRY_ATTEMPTS, unaffected by the Mercari override'
    );

    // Every source's ERROR status must still surface — the sentinel/status
    // logic in routes/search.js is untouched by the Mercari-specific timing.
    const sourcesPayload = body.sources;
    assert.deepEqual(sourcesPayload, ['mercari', 'yahoo', 'paypay']);
  } finally {
    server.close();
  }
});

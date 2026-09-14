'use strict';
// UNIT TEST for the module-level (process-wide) concurrency limiter in
// routes/search.js. Proves pLimit(SCRAPE_CONCURRENCY) is created ONCE at
// module load and shared across every /search request, not instantiated
// fresh per-request — the fix for the audit finding that a per-request
// limiter lets N concurrent users each open their own SCRAPE_CONCURRENCY
// Chromium pages, multiplying memory use on Render free tier.
//
// No network, no real Chromium: browser.js and the 3 scrapers are
// substituted via require.cache before routes/search.js is required (same
// technique used to verify the result-ordering fix). Runs the REAL,
// unmodified route handler behind a real (ephemeral, localhost-only)
// HTTP server.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const backendRoot = path.join(__dirname, '..', '..');

function fakeModule(relPath, exportsObj) {
  const fullPath = require.resolve(path.join(backendRoot, relPath));
  require.cache[fullPath] = { id: fullPath, filename: fullPath, loaded: true, exports: exportsObj };
}

// Fake browser.js — no real Chromium needed.
fakeModule('src/browser.js', {
  newContext: async () => ({ close: async () => {} }),
  getBrowser: async () => ({ close: async () => {} }),
  isConnected: async () => true,
});

let currentConcurrent = 0;
let maxConcurrentObserved = 0;

// Fake each scraper: tracks how many are running AT ONCE, across ALL
// requests sharing this process, with a delay long enough that two
// concurrent /search requests (6 scraper calls total) will clearly overlap
// if the limiter isn't actually enforcing a shared, process-wide cap.
function fakeScraper(name, delayMs) {
  fakeModule(`src/scrapers/${name}.js`, {
    search: async (context, q) => {
      currentConcurrent++;
      maxConcurrentObserved = Math.max(maxConcurrentObserved, currentConcurrent);
      await new Promise((r) => setTimeout(r, delayMs));
      currentConcurrent--;
      return [{ title: `${name}-item`, url: `https://example.com/${name}/${q}`, source: name, price: 100 }];
    },
  });
}
fakeScraper('mercari', 50);
fakeScraper('yahoo', 50);
fakeScraper('paypay', 50);

// NOW require the real, unmodified route — it picks up the fakes above,
// including the real (module-level) `limiter`.
const express = require(path.join(backendRoot, 'node_modules/express'));
const searchRouter = require(path.join(backendRoot, 'src/routes/search.js'));

test('the concurrency limiter is shared across concurrent /search requests (global, not per-request)', async () => {
  const app = express();
  app.use(searchRouter);
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // Fire 2 full /search requests (3 sources each = 6 scraper calls total)
    // AT THE SAME TIME, with nocache=1 so both genuinely hit the scrapers.
    // A per-request limiter would let each request use its own 2-slot pool,
    // so up to 4 could run concurrently overall (2 requests x 2 slots). With
    // a real process-wide limiter (SCRAPE_CONCURRENCY=2 default), the
    // observed max across BOTH requests combined must never exceed 2.
    const [respA, respB] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/search?q=queryA&sources=mercari,yahoo,paypay&nocache=1`),
      fetch(`http://127.0.0.1:${port}/search?q=queryB&sources=mercari,yahoo,paypay&nocache=1`),
    ]);

    assert.equal(respA.status, 200);
    assert.equal(respB.status, 200);
    const bodyA = await respA.json();
    const bodyB = await respB.json();
    assert.equal(bodyA.count, 3, 'each request must still get all 3 sources worth of results');
    assert.equal(bodyB.count, 3);

    // Historical result order preserved (mercari, yahoo, paypay), even
    // though scheduling/launch order differs and requests overlap.
    assert.deepEqual(bodyA.results.map((r) => r.source), ['mercari', 'yahoo', 'paypay']);
    assert.deepEqual(bodyB.results.map((r) => r.source), ['mercari', 'yahoo', 'paypay']);

    // The critical invariant: a per-request limiter would allow up to 4
    // concurrent scraper calls (2 requests x 2 slots each); a truly shared,
    // process-wide limiter never exceeds SCRAPE_CONCURRENCY (2) no matter
    // how many requests are in flight.
    assert.ok(
      maxConcurrentObserved <= 2,
      `expected at most SCRAPE_CONCURRENCY (2) concurrent scraper calls across BOTH requests combined, ` +
        `observed ${maxConcurrentObserved} — the limiter must be a single shared instance created once at ` +
        `module load, not one created fresh per request`
    );
    // Sanity check that this isn't trivially true because nothing actually
    // overlapped (e.g. requests ran fully sequentially by accident) — with
    // 6 total scraper calls and a cap of 2, genuine concurrency must occur.
    assert.ok(
      maxConcurrentObserved >= 2,
      `expected genuine concurrency (>=2 simultaneous scraper calls) to actually occur, observed ${maxConcurrentObserved}`
    );
  } finally {
    server.close();
  }
});

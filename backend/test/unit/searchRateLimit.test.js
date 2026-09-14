'use strict';
// UNIT TESTS for the per-IP rate limiter on GET /search (routes/search.js).
// No network, no real Chromium: browser.js and the 3 scrapers are
// substituted via require.cache before routes/search.js is required (same
// technique as searchGlobalConcurrency.test.js). Runs the REAL, unmodified
// route + rate limiter behind a real (ephemeral, localhost-only) HTTP
// server, using a small window/max injected via env vars so the test runs
// fast without waiting a real 60s window.
//
// express-rate-limit keys by req.ip by default; to test IP isolation
// without real distinct sockets, requests set X-Forwarded-For and the
// server trusts proxy hop 1 (matching production's Render setup), so each
// distinct X-Forwarded-For value is treated as a distinct client — exactly
// how a real reverse-proxied deployment resolves client IPs.

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

function fakeScraper(name) {
  fakeModule(`src/scrapers/${name}.js`, {
    search: async (context, q) => [{ title: `${name}-item`, url: `https://example.com/${name}/${q}`, source: name, price: 100 }],
  });
}
fakeScraper('mercari');
fakeScraper('yahoo');
fakeScraper('paypay');

const express = require(path.join(backendRoot, 'node_modules/express'));
const searchRouter = require(path.join(backendRoot, 'src/routes/search.js'));

async function startServer() {
  const app = express();
  app.set('trust proxy', 1); // mirror production's server.js setting
  app.use(searchRouter);
  const server = app.listen(0);
  const port = server.address().port;
  return { server, port };
}

function searchUrl(port, q) {
  return `http://127.0.0.1:${port}/search?q=${encodeURIComponent(q)}&sources=mercari&nocache=1`;
}

async function hit(port, q, ip) {
  return fetch(searchUrl(port, q), {
    headers: ip ? { 'X-Forwarded-For': ip } : {},
  });
}

test('normal usage: requests well under the limit all succeed with 200', async () => {
  const { server, port } = await startServer();
  try {
    for (let i = 0; i < 5; i++) {
      const resp = await hit(port, `q${i}`, '10.0.0.1');
      assert.equal(resp.status, 200, `request #${i + 1} should succeed`);
      const body = await resp.json();
      assert.equal(body.count, 1);
    }
  } finally {
    server.close();
  }
});

test('exceeding the limit returns 429 with a clear error and rate-limit headers', async () => {
  const { server, port } = await startServer();
  try {
    // express-rate-limit's default max here is the module's real
    // SEARCH_RATE_LIMIT_MAX (20) — drive one IP past it.
    let lastResp;
    for (let i = 0; i < 21; i++) {
      lastResp = await hit(port, `q${i}`, '10.0.0.2');
    }
    assert.equal(lastResp.status, 429, 'the 21st request from the same IP within the window must be rate-limited');
    const body = await lastResp.json();
    assert.match(body.error, /too many/i);
    // standardHeaders: true must expose RateLimit-* headers.
    assert.ok(
      lastResp.headers.get('ratelimit-limit') || lastResp.headers.get('RateLimit-Limit'),
      'expected a RateLimit-Limit header on the 429 response'
    );
  } finally {
    server.close();
  }
});

test('IP isolation: one IP being rate-limited does not affect a different IP', async () => {
  const { server, port } = await startServer();
  try {
    // Exhaust the limit for IP A.
    let lastRespA;
    for (let i = 0; i < 21; i++) {
      lastRespA = await hit(port, `qa${i}`, '10.0.0.3');
    }
    assert.equal(lastRespA.status, 429, 'IP A must be rate-limited after exceeding its own quota');

    // A completely different IP must be unaffected.
    const respB = await hit(port, 'qb', '10.0.0.4');
    assert.equal(respB.status, 200, 'a different IP must not be affected by IP A hitting its limit');
    const bodyB = await respB.json();
    assert.equal(bodyB.count, 1);
  } finally {
    server.close();
  }
});

test('other routes are not affected by the /search rate limiter', async () => {
  // DELETE /search/cache shares the /search path prefix but must not be
  // subject to the GET /search rate limiter, which is attached only to
  // that specific route, not mounted globally for the whole router.
  const { server, port } = await startServer();
  try {
    // Exhaust the GET /search limit for this IP.
    for (let i = 0; i < 21; i++) {
      await hit(port, `q${i}`, '10.0.0.5');
    }
    const cacheDeleteResp = await fetch(`http://127.0.0.1:${port}/search/cache?q=test`, {
      method: 'DELETE',
      headers: { 'X-Forwarded-For': '10.0.0.5' },
    });
    assert.equal(cacheDeleteResp.status, 200, 'DELETE /search/cache must not be rate-limited by the GET /search limiter');
  } finally {
    server.close();
  }
});

'use strict';
// FAILURE-SCENARIO TESTS — no network, no real browser. See test/README.md
// and src/scrapers/paypay.skill.md ("Maintenance signals" + "Lessons learned").

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const paypay = require('../../src/scrapers/paypay');
const { retry } = require('../../src/util/retry');
const { getCachedCookies, setCachedCookies, invalidateCachedCookies } = require('../../src/paypaySession');
const { makeFakeContext, sequence } = require('./_fakeContext');

function cookie(name, value = 'v') {
  return { name, value, domain: '.yahoo.co.jp', path: '/', expires: 4000000000, httpOnly: true, secure: true, sameSite: 'Lax' };
}
const ESSENTIAL_COOKIES = [cookie('A'), cookie('XA'), cookie('B'), cookie('XB')];

// paypaySession's cache is process-wide (module-level) state, shared by
// every paypay.search() call regardless of which test invokes it — reset it
// before every test so tests can't leak cached cookies into each other.
beforeEach(() => {
  invalidateCachedCookies();
});

// --- Lightweight HTTP warmup (context.request.get) ---------------------

// The default fake context's request.get() always succeeds (see
// _fakeContext.js), so any test below that doesn't override `requestGet`
// implicitly exercises the "HTTP warmup succeeded" path.
test('paypay.search: uses the lightweight HTTP warmup and never falls back to a full page warmup when it succeeds', async () => {
  let requestGetCalls = 0;
  let gotoCalls = 0;
  const ctx = makeFakeContext(
    {
      goto: async (url) => {
        gotoCalls++;
        return { status: () => 200 };
      },
      waitForSelector: async () => {},
      evaluate: async () => 'no markers here',
      $$eval: async () => [{ href: '/item/z1', image: null, title: 'Item', priceText: '1,000' }],
    },
    {
      requestGet: async (url) => {
        requestGetCalls++;
        assert.equal(url, 'https://paypayfleamarket.yahoo.co.jp');
        return { ok: () => true, status: () => 200 };
      },
    }
  );

  const results = await paypay.search(ctx, 'iphone');

  assert.equal(requestGetCalls, 1, 'the lightweight HTTP warmup must be attempted');
  assert.equal(gotoCalls, 1, 'page.goto must only be called once (the search page) — no full-page warmup fallback needed');
  assert.equal(results.length, 1);
});

test('paypay.search: falls back to the full page warmup when the lightweight HTTP request rejects, and the search still succeeds', async () => {
  const gotoUrls = [];
  const ctx = makeFakeContext(
    {
      goto: async (url) => {
        gotoUrls.push(url);
        return { status: () => 200 };
      },
      waitForSelector: async () => {},
      evaluate: async () => 'no markers here',
      $$eval: async () => [{ href: '/item/z1', image: null, title: 'Item', priceText: '1,000' }],
    },
    {
      requestGet: async () => {
        throw new Error('network error during HTTP warmup');
      },
    }
  );

  const results = await paypay.search(ctx, 'iphone');

  assert.deepEqual(gotoUrls, ['https://paypayfleamarket.yahoo.co.jp', 'https://paypayfleamarket.yahoo.co.jp/search/iphone'], 'must fall back to a full page.goto(BASE) warmup, then proceed to the search page');
  assert.equal(results.length, 1, 'the search must still succeed via the fallback');
});

test('paypay.search: falls back to the full page warmup when the lightweight HTTP request returns a non-ok status', async () => {
  const gotoUrls = [];
  const ctx = makeFakeContext(
    {
      goto: async (url) => {
        gotoUrls.push(url);
        return { status: () => 200 };
      },
      waitForSelector: async () => {},
      evaluate: async () => 'no markers here',
      $$eval: async () => [{ href: '/item/z1', image: null, title: 'Item', priceText: '1,000' }],
    },
    {
      requestGet: async () => ({ ok: () => false, status: () => 500 }),
    }
  );

  const results = await paypay.search(ctx, 'iphone');

  assert.deepEqual(gotoUrls, ['https://paypayfleamarket.yahoo.co.jp', 'https://paypayfleamarket.yahoo.co.jp/search/iphone']);
  assert.equal(results.length, 1);
});

test('paypay.search: rethrows when BOTH the HTTP warmup and the page-warmup fallback fail (retryable)', async () => {
  const ctx = makeFakeContext(
    {
      goto: async () => {
        throw new Error('page.goto: Timeout 12000ms exceeded');
      },
    },
    {
      requestGet: async () => {
        throw new Error('network error during HTTP warmup');
      },
    }
  );
  await assert.rejects(() => paypay.search(ctx, 'iphone'), /Timeout/);
});

// --- Search page response handling (unchanged by the warmup change) ----

// Test 1: a 404 search response is a genuine zero-result signal (confirmed
// via a live curl diagnostic, 2026-09-13, with an already-valid warmup
// cookie: a 404 consistently rendered a full page with generic/unrelated
// fallback recommendations for a query with no real matches — the same
// shape as Next.js's own notFound:true zero-result handling, not a block).
// It must resolve to [] without throwing, so retry() is never invoked.
test('paypay.search: resolves to [] without throwing on a 404 search response (genuine zero-result)', async () => {
  const ctx = makeFakeContext({
    goto: async () => ({ status: () => 404 }),
  });
  const results = await paypay.search(ctx, 'zzzzxqwnonexistentitem999888');
  assert.deepEqual(results, []);
});

// Test 2: a 403 is NOT explained by the zero-result case above — treat it as
// a possible transient block and retry.
test('paypay.search: rethrows on a 403 search response after warmup (retryable)', async () => {
  const ctx = makeFakeContext({
    goto: async () => ({ status: () => 403 }),
  });
  await assert.rejects(() => paypay.search(ctx, 'iphone'), /PayPay HTTP error: 403/);
});

// Test 3: a 5xx is a server-side error, not a zero-result signal — retry.
test('paypay.search: rethrows on a 5xx search response after warmup (retryable)', async () => {
  const ctx = makeFakeContext({
    goto: async () => ({ status: () => 503 }),
  });
  await assert.rejects(() => paypay.search(ctx, 'iphone'), /PayPay HTTP error: 503/);
});

// Test 5: no-anchors is intentionally left as a real zero-result state, not
// an error — unchanged.
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

// Test 4: the geo-block/data-fetch-failed banner still throws (retryable) —
// confirmed transient via a live Chrome+VPN diagnostic (2026-09-13): a real
// session hit this exact banner once, then succeeded on a plain reload
// moments later with no other change.
test('paypay.search: rethrows on the geo-block/data-fetch-failed marker (retryable)', async () => {
  // $$eval throws if reached, so this test also fails loudly if the
  // geo-block short-circuit ever gets bypassed before the throw.
  const ctx = makeFakeContext({
    goto: async () => ({ status: () => 200 }),
    waitForSelector: async () => {},
    evaluate: async () => 'データの取得に失敗しました ... あなたへのおすすめ ...',
    $$eval: async () => {
      throw new Error('should never reach $$eval once geo-block markers are detected');
    },
  });
  await assert.rejects(() => paypay.search(ctx, 'iphone'), /PayPay data fetch failed/);
});

// Test 6: a 404 must NOT trigger retry() — it's a settled zero-result
// answer, not a failure. Wrapping in the real retry() and counting calls
// proves fn only ever runs once.
test('paypay.search + retry(): a 404 zero-result resolves on the first call, with no retry attempts', async () => {
  let searchCalls = 0;
  const ctx = makeFakeContext({
    goto: async () => ({ status: () => 404 }),
  });

  const result = await retry(
    async () => {
      searchCalls++;
      return paypay.search(ctx, 'zzzzxqwnonexistentitem999888');
    },
    { attempts: 3, delays: [10, 10], label: 'paypay' }
  );

  assert.equal(searchCalls, 1, 'a 404 must resolve on the first call — retry() must never re-invoke paypay.search()');
  assert.deepEqual(result, []);
});

// The two remaining failure states (non-404 http-error, geo-blocked marker)
// are actually caught and retried by retry() — not just thrown. Each
// scenario fails on attempt 1 and succeeds on attempt 2, proving retry()
// re-invoked paypay.search() rather than the outcome happening to succeed on
// the first try.
test('paypay.search + retry(): a 403 failure is retried and can succeed on attempt 2', async () => {
  let gotoCalls = 0;
  const countingGoto = (fn) => async (...args) => {
    gotoCalls++;
    return fn(...args);
  };
  const ctx = makeFakeContext({
    goto: sequence([
      countingGoto(async () => ({ status: () => 403 })), // attempt 1 search: throws
      countingGoto(async () => ({ status: () => 200 })), // attempt 2 search: ok
    ]),
    waitForSelector: async () => {},
    evaluate: async () => 'no markers here',
    $$eval: async () => [{ href: '/item/z1', image: null, title: 'Retried item', priceText: '1,000' }],
  });

  const result = await retry(() => paypay.search(ctx, 'iphone'), {
    attempts: 3,
    delays: [10, 10], // small delays to keep the test fast; production uses [1000, 2000] via scraperTimeout.js
    label: 'paypay',
  });

  assert.equal(gotoCalls, 2, 'expected exactly 2 attempts (1 search navigation each — the warmup is now a lightweight HTTP request, not a page.goto) — proves retry() re-ran paypay.search()');
  assert.equal(result.length, 1);
  assert.equal(result[0].title, 'Retried item');
});

test('paypay.search + retry(): a geo-blocked/data-fetch-failed failure is retried and can succeed on attempt 2', async () => {
  const ctx = makeFakeContext({
    goto: async () => ({ status: () => 200 }),
    waitForSelector: async () => {},
    evaluate: sequence([
      async () => 'データの取得に失敗しました ... あなたへのおすすめ ...', // attempt 1: geo-blocked
      async () => 'no markers here', // attempt 2: clean
    ]),
    $$eval: async () => [{ href: '/item/z2', image: null, title: 'Recovered item', priceText: '2,000' }],
  });

  const result = await retry(() => paypay.search(ctx, 'iphone'), {
    attempts: 3,
    delays: [10, 10],
    label: 'paypay',
  });

  assert.equal(result.length, 1, 'result must only be reachable via a 2nd attempt — attempt 1 always throws');
  assert.equal(result[0].title, 'Recovered item');
});

// Confirms the production retry policy itself (attempts + delays) is
// untouched by this change — this test asserts against the actual exported
// constants, not a hardcoded copy, so it fails if scraperTimeout.js's values
// ever drift without this test being updated deliberately.
test('retry policy: attempts and delays used by routes/search.js remain [3 attempts, 1000ms/2000ms delays]', () => {
  const { RETRY_ATTEMPTS, RETRY_DELAYS_MS } = require('../../src/util/scraperTimeout');
  assert.equal(RETRY_ATTEMPTS, 3);
  assert.deepEqual(RETRY_DELAYS_MS, [1000, 2000]);
});

// --- Session cookie cache integration (paypaySession.js) ----------------

// Test 1: empty cache -> HTTP warmup runs -> the 4 essential cookies get
// saved to the cache for the next search.
test('paypay.search: with an empty cache, runs the HTTP warmup and saves the essential cookies afterwards', async () => {
  let requestGetCalls = 0;
  const ctx = makeFakeContext(
    {
      goto: async () => ({ status: () => 200 }),
      waitForSelector: async () => {},
      evaluate: async () => 'no markers here',
      $$eval: async () => [{ href: '/item/z1', image: null, title: 'Item', priceText: '1,000' }],
    },
    {
      requestGet: async () => {
        requestGetCalls++;
        return { ok: () => true, status: () => 200 };
      },
      // Simulate a real warmup response: the 4 essential cookies plus an
      // analytics cookie that must NOT end up cached.
      cookies: async () => [...ESSENTIAL_COOKIES, cookie('_gcl_au')],
    }
  );

  assert.equal(getCachedCookies(), null, 'sanity check: cache starts empty');
  await paypay.search(ctx, 'iphone');

  assert.equal(requestGetCalls, 1, 'the HTTP warmup must run when the cache is empty');
  const cached = getCachedCookies();
  assert.ok(cached, 'the cache must be populated after a successful warmup');
  assert.deepEqual(cached.map((c) => c.name).sort(), ['A', 'B', 'XA', 'XB']);
});

// Test 2 + 3: a valid cache is used via addCookies(), the HTTP warmup is
// skipped entirely, and the search still succeeds normally.
test('paypay.search: with a valid cache, injects cookies via addCookies() and skips the HTTP warmup, search succeeds', async () => {
  setCachedCookies(ESSENTIAL_COOKIES);

  let requestGetCalls = 0;
  let addCookiesCallArgs = null;
  const ctx = makeFakeContext(
    {
      goto: async () => ({ status: () => 200 }),
      waitForSelector: async () => {},
      evaluate: async () => 'no markers here',
      $$eval: async () => [{ href: '/item/z1', image: null, title: 'Cached-session item', priceText: '1,000' }],
    },
    {
      requestGet: async () => {
        requestGetCalls++;
        return { ok: () => true, status: () => 200 };
      },
      addCookies: async (cookies) => {
        addCookiesCallArgs = cookies;
      },
    }
  );

  const results = await paypay.search(ctx, 'iphone');

  assert.equal(requestGetCalls, 0, 'the HTTP warmup must NOT run when a valid cache exists');
  assert.ok(addCookiesCallArgs, 'context.addCookies() must be called with the cached cookies');
  assert.deepEqual(addCookiesCallArgs.map((c) => c.name).sort(), ['A', 'B', 'XA', 'XB']);
  assert.equal(results.length, 1, 'the search must succeed normally using the cached session');
  assert.equal(results[0].title, 'Cached-session item');
});

// Test 4: a 403 while using a cached session invalidates the cache and still
// propagates to retry() as before.
test('paypay.search: a 403 with a cached session invalidates the cache and rethrows (retryable)', async () => {
  setCachedCookies(ESSENTIAL_COOKIES);
  const ctx = makeFakeContext({
    goto: async () => ({ status: () => 403 }),
  });

  await assert.rejects(() => paypay.search(ctx, 'iphone'), /PayPay HTTP error: 403/);
  assert.equal(getCachedCookies(), null, 'the cache must be invalidated after a 403 with a cached session');
});

// Test 5: the geo-blocked/data-fetch-failed marker while using a cached
// session invalidates the cache and still propagates to retry() as before.
test('paypay.search: a data-fetch-failed marker with a cached session invalidates the cache and rethrows (retryable)', async () => {
  setCachedCookies(ESSENTIAL_COOKIES);
  const ctx = makeFakeContext({
    goto: async () => ({ status: () => 200 }),
    waitForSelector: async () => {},
    evaluate: async () => 'データの取得に失敗しました ... あなたへのおすすめ ...',
    $$eval: async () => {
      throw new Error('should never reach $$eval once geo-block markers are detected');
    },
  });

  await assert.rejects(() => paypay.search(ctx, 'iphone'), /PayPay data fetch failed/);
  assert.equal(getCachedCookies(), null, 'the cache must be invalidated after a data-fetch-failed marker with a cached session');
});

// Test 6: a 404 with a cached session is still a genuine zero-result — the
// cache must NOT be invalidated (it isn't a sign of a bad session).
test('paypay.search: a 404 with a cached session resolves to [] WITHOUT invalidating the cache', async () => {
  setCachedCookies(ESSENTIAL_COOKIES);
  const ctx = makeFakeContext({
    goto: async () => ({ status: () => 404 }),
  });

  const results = await paypay.search(ctx, 'zzzzxqwnonexistentitem999888');

  assert.deepEqual(results, []);
  const cached = getCachedCookies();
  assert.ok(cached, 'the cache must survive a 404 — it is a genuine zero-result, not a bad session');
  assert.deepEqual(cached.map((c) => c.name).sort(), ['A', 'B', 'XA', 'XB']);
});

// Test 7: no-anchors with a cached session is still a genuine zero-result —
// the cache must NOT be invalidated.
test('paypay.search: no-anchors with a cached session resolves to [] WITHOUT invalidating the cache', async () => {
  setCachedCookies(ESSENTIAL_COOKIES);
  const ctx = makeFakeContext({
    goto: async () => ({ status: () => 200 }),
    waitForSelector: async () => {
      throw new Error('Timeout waiting for selector \'a[href*="/item/"]\'');
    },
  });

  const results = await paypay.search(ctx, 'iphone');

  assert.deepEqual(results, []);
  assert.ok(getCachedCookies(), 'the cache must survive a no-anchors zero-result');
});

// Ties requirement 5 from the spec together end-to-end through the real
// retry(): attempt 1 uses a cached (but bad) session and gets a 403,
// invalidating the cache; attempt 2 must therefore do a fresh HTTP warmup
// (not reuse the now-invalidated cache) and can succeed. No extra retry
// mechanism is introduced — this is the existing retry() from
// src/util/retry.js doing exactly what it already does.
test('paypay.search + retry(): attempt 1 fails with a cached session (403) and invalidates it; attempt 2 does a fresh warmup and can succeed', async () => {
  setCachedCookies(ESSENTIAL_COOKIES);
  let requestGetCalls = 0;
  let addCookiesCalls = 0;
  const ctx = makeFakeContext(
    {
      goto: sequence([
        async () => ({ status: () => 403 }), // attempt 1 search: throws (cached session was bad)
        async () => ({ status: () => 200 }), // attempt 2 search: ok
      ]),
      waitForSelector: async () => {},
      evaluate: async () => 'no markers here',
      $$eval: async () => [{ href: '/item/z1', image: null, title: 'Recovered after fresh warmup', priceText: '1,000' }],
    },
    {
      requestGet: async () => {
        requestGetCalls++;
        return { ok: () => true, status: () => 200 };
      },
      addCookies: async () => {
        addCookiesCalls++;
      },
      cookies: async () => ESSENTIAL_COOKIES,
    }
  );

  const result = await retry(() => paypay.search(ctx, 'iphone'), {
    attempts: 3,
    delays: [10, 10],
    label: 'paypay',
  });

  assert.equal(addCookiesCalls, 1, 'attempt 1 must use the cached session via addCookies()');
  assert.equal(requestGetCalls, 1, 'attempt 2 must do a fresh HTTP warmup — the cache was invalidated after attempt 1\'s 403');
  assert.equal(result.length, 1);
  assert.equal(result[0].title, 'Recovered after fresh warmup');
});

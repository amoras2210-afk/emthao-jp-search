'use strict';
// FAILURE-SCENARIO TESTS — no network, no real browser. See test/README.md
// and src/scrapers/yahoo.skill.md ("Maintenance signals").

const { test } = require('node:test');
const assert = require('node:assert/strict');

const yahoo = require('../../src/scrapers/yahoo');
const { logger } = require('../../src/logger');
const { makeFakeContext } = require('./_fakeContext');

// _fakeContext.js's fake page has no `.title()`/`.url()` at all (yahoo.js
// guards both on `typeof page.X === 'function'`, exactly so it doesn't need
// them). The 2026-09-17 page.title() fix needs a page that DOES have them,
// controllable per test, so this wraps makeFakeContext locally — the shared
// fixture (also used by mercari.test.js/paypay.test.js) is left untouched.
function makeFakeContextWithPage(pageOverrides, extras = {}) {
  const ctx = makeFakeContext(pageOverrides);
  const realNewPage = ctx.newPage;
  ctx.newPage = async (...args) => {
    const page = await realNewPage(...args);
    if (extras.title) page.title = extras.title;
    if (extras.url) page.url = extras.url;
    return page;
  };
  return ctx;
}

// A minimal $$eval fake standing in for the real DOM evaluation — returns
// one well-formed raw card straight from the shape yahoo.js's own $$eval
// callback would normally produce, so the parsing/normalize pipeline after
// it is genuinely exercised.
async function fakeOneItem$$eval() {
  return [
    {
      title: 'Louis Vuitton Test Item',
      priceText: '¥12,345',
      image: '/img/test.jpg',
      href: '/jp/auction/x123456789',
      bidText: '3件',
      timeText: '1日',
      isFixed: false,
    },
  ];
}

test('yahoo.search: rethrows on navigation failure (retryable)', async () => {
  const ctx = makeFakeContext({
    goto: async () => {
      throw new Error('page.goto: Timeout 12000ms exceeded');
    },
  });
  await assert.rejects(() => yahoo.search(ctx, 'iphone'), /Timeout/);
});

test('yahoo.search: resolves to [] without throwing when .Product never renders', async () => {
  // Ambiguous by design: could mean a legitimate 0-result search page, or a
  // slow render. yahoo.js intentionally treats this as "no results", not an
  // error — see yahoo.skill.md "Maintenance signals". This test locks in that
  // choice so a future change doesn't accidentally turn empty Yahoo searches
  // into errors.
  const ctx = makeFakeContext({
    waitForSelector: async () => {
      throw new Error('Timeout waiting for selector "li.Product"');
    },
  });
  const results = await yahoo.search(ctx, 'iphone');
  assert.deepEqual(results, []);
});

// --- page.title() non-blocking diagnostic (2026-09-17 fix) ---
// See src/scrapers/yahoo.js: page.title() used to sit directly between
// goto() and waitForSelector(), and was observed taking ~12.2s under Render
// CPU load, eating almost the entire functional wait budget and causing a
// false "no-items" result. These tests prove the fix: waitForSelector() is
// called before page.title() is ever awaited, page.title() is capped and
// degrades to null, and the scrape itself is completely unaffected either
// way.

test('yahoo.search: normal success is unaffected — page.title() resolves normally, items parsed correctly', async () => {
  const ctx = makeFakeContextWithPage(
    { $$eval: fakeOneItem$$eval },
    { title: async () => 'Louis Vuitton - Yahoo!オークション', url: () => `${'https://auctions.yahoo.co.jp'}/search/search?p=x` }
  );

  let capturedGotoDiagnostic = null;
  const originalInfo = logger.info.bind(logger);
  logger.info = (obj, msg) => {
    if (obj && obj.status === 'goto-diagnostic') capturedGotoDiagnostic = obj;
    return originalInfo(obj, msg);
  };
  let results;
  try {
    results = await yahoo.search(ctx, 'Louis Vuitton');
  } finally {
    logger.info = originalInfo;
  }

  assert.equal(results.length, 1, 'the normal success path must still return the parsed item');
  assert.equal(results[0].title, 'Louis Vuitton Test Item');
  assert.equal(results[0].price, 12345);
  assert.equal(results[0].url, 'https://auctions.yahoo.co.jp/jp/auction/x123456789');
  assert.equal(results[0].source, 'yahoo');

  assert.ok(capturedGotoDiagnostic, 'goto-diagnostic must still be logged');
  assert.equal(
    capturedGotoDiagnostic.pageTitle,
    'Louis Vuitton - Yahoo!オークション',
    'when page.title() resolves normally and quickly, its real value must still be logged'
  );
});

test('yahoo.search: a slow/hanging page.title() does not block waitForSelector, does not consume the functional budget, and does not fail the scrape', async () => {
  let gotoResolvedAt = null;
  let waitForSelectorCalledAt = null;
  const ctx = makeFakeContextWithPage(
    {
      goto: async () => {
        // paceDomain() (src/concurrency.js) can impose a real ≥1s wait per
        // host BEFORE goto() is even called, shared as module-level state
        // across every test in this file — measuring from goto's own
        // resolution (not from search()'s own `start`, which is captured
        // before paceDomain) avoids that unrelated delay polluting this
        // assertion, same lesson as mercari.test.js's abort tests.
        gotoResolvedAt = Date.now();
        return { status: () => 200 };
      },
      waitForSelector: async () => {
        waitForSelectorCalledAt = Date.now();
        // Resolves quickly — the fake selector "is found" almost immediately.
        return undefined;
      },
      $$eval: fakeOneItem$$eval,
    },
    {
      // Never resolves — simulates the observed ~12.2s (or worse) stall.
      title: () => new Promise(() => {}),
      url: () => 'https://auctions.yahoo.co.jp/search/search?p=x',
    }
  );

  const start = Date.now();
  let capturedGotoDiagnostic = null;
  const originalInfo = logger.info.bind(logger);
  logger.info = (obj, msg) => {
    if (obj && obj.status === 'goto-diagnostic') capturedGotoDiagnostic = obj;
    return originalInfo(obj, msg);
  };
  let results;
  try {
    results = await yahoo.search(ctx, 'Louis Vuitton');
  } finally {
    logger.info = originalInfo;
  }
  const elapsed = Date.now() - start;

  assert.deepEqual(
    results.map((r) => r.title),
    ['Louis Vuitton Test Item'],
    'a hanging page.title() must not fail or empty out an otherwise successful scrape'
  );
  assert.ok(
    elapsed < 2000,
    `search() must not be held up by a hanging page.title() (took ${elapsed}ms — should be bounded by the ~500ms diagnostic cap, not hang)`
  );
  assert.ok(
    waitForSelectorCalledAt && gotoResolvedAt && waitForSelectorCalledAt - gotoResolvedAt < 100,
    'waitForSelector() must be CALLED essentially immediately after goto() resolves, not after waiting on page.title()'
  );
  assert.ok(capturedGotoDiagnostic, 'goto-diagnostic must still be logged');
  assert.equal(
    capturedGotoDiagnostic.pageTitle,
    null,
    'a page.title() that never resolves must degrade to null, not block or throw'
  );
});

test('yahoo.search: a slow page.title() does not shrink waitForSelector\'s functional timeout budget', async () => {
  let capturedTimeout = null;
  const ctx = makeFakeContextWithPage(
    {
      waitForSelector: async (_selector, options) => {
        capturedTimeout = options?.timeout;
        return undefined;
      },
      $$eval: fakeOneItem$$eval,
    },
    {
      title: () => new Promise(() => {}), // hangs
      url: () => 'https://auctions.yahoo.co.jp/search/search?p=x',
    }
  );

  await yahoo.search(ctx, 'Louis Vuitton');

  // PER_NAV_TIMEOUT_MS defaults to 20000ms; goto/pacing overhead in this
  // fake is negligible, so the real budget should be essentially the full
  // 20000ms — nowhere near reduced by the old bug's ~12.2s of page.title()
  // stall (which would have left only ~1000ms, the Math.max() floor).
  assert.ok(
    capturedTimeout > 19000,
    `waitForSelector's timeout must not be reduced by page.title()'s latency (got ${capturedTimeout}ms, expected close to 20000ms)`
  );
});

test('yahoo.search: a rejecting page.title() degrades to null and creates no unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandledRejection = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);

  const ctx = makeFakeContextWithPage(
    { $$eval: fakeOneItem$$eval },
    {
      title: async () => {
        throw new Error('Target page, context or browser has been closed');
      },
      url: () => 'https://auctions.yahoo.co.jp/search/search?p=x',
    }
  );

  try {
    const results = await yahoo.search(ctx, 'Louis Vuitton');
    assert.equal(results.length, 1, 'a rejecting page.title() must not fail the scrape');
  } finally {
    // Give any stray microtask/rejection a tick to surface before asserting.
    await new Promise((r) => setTimeout(r, 50));
    process.off('unhandledRejection', onUnhandledRejection);
  }

  assert.deepEqual(unhandled, [], 'a rejecting page.title() must never surface as an unhandled rejection');
});

test('yahoo.search: no unhandled rejection even when waitForSelector rejects while page.title() is still pending', async () => {
  const unhandled = [];
  const onUnhandledRejection = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);

  const ctx = makeFakeContextWithPage(
    {
      waitForSelector: async () => {
        // Rejects almost immediately — before the ~500ms title diagnostic
        // cap elapses — to exercise the "second .catch() attached early"
        // safety net for Node's unhandled-rejection bookkeeping.
        throw new Error('Timeout waiting for selector "li.Product"');
      },
    },
    {
      title: () => new Promise((resolve) => setTimeout(() => resolve('slow title'), 100)),
      url: () => 'https://auctions.yahoo.co.jp/search/search?p=x',
    }
  );

  let results;
  try {
    results = await yahoo.search(ctx, 'iphone');
  } finally {
    await new Promise((r) => setTimeout(r, 200));
    process.off('unhandledRejection', onUnhandledRejection);
  }

  assert.deepEqual(results, [], 'the pre-existing no-items behavior must be unchanged');
  assert.deepEqual(unhandled, [], 'an early waitForSelector rejection must never surface as an unhandled rejection');
});

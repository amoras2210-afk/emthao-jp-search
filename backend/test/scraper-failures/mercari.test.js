'use strict';
// FAILURE-SCENARIO TESTS — no network, no real browser. Exercises the real
// mercari.search() function with a fake Playwright context/page so its
// navigation/response error handling can be tested deterministically. See
// test/README.md and src/scrapers/mercari.skill.md ("Maintenance signals").

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners, EventEmitter } = require('node:events');

const mercari = require('../../src/scrapers/mercari');
const { logger } = require('../../src/logger');
const { makeFakeContext } = require('./_fakeContext');

function fakeApiResponse(body) {
  return {
    url: () => 'https://api.mercari.jp/v2/entities:search',
    request: () => ({ method: () => 'POST' }),
    json: async () => body,
  };
}

// _fakeContext.js's fake page has no `.on()` at all (see its own comment —
// mercari.js guards every listener registration on `typeof page.on ===
// 'function'`, exactly so it doesn't need one). These CASE A/B/C/D
// diagnostic tests are the one place that needs a page which DOES emit
// events, so this wraps makeFakeContext locally, without touching the
// shared fixture used by yahoo.test.js/paypay.test.js.
function makeFakeContextWithEvents(pageOverrides, contextOverrides) {
  const ctx = makeFakeContext(pageOverrides, contextOverrides);
  const emitter = new EventEmitter();
  const realNewPage = ctx.newPage;
  ctx.newPage = async (...args) => {
    const page = await realNewPage(...args);
    page.on = (event, handler) => emitter.on(event, handler);
    return page;
  };
  return { ctx, emitter };
}

function fakeApiRequest(overrides = {}) {
  return {
    url: () => overrides.url || 'https://api.mercari.jp/v2/entities:search',
    method: () => overrides.method || 'POST',
    resourceType: () => overrides.resourceType || 'fetch',
    failure: () => overrides.failure || null,
  };
}

function fakeApiResponseEvent(overrides = {}) {
  return {
    url: () => overrides.url || 'https://api.mercari.jp/v2/entities:search',
    status: () => overrides.status ?? 200,
    statusText: () => overrides.statusText || 'OK',
    request: () => ({ method: () => overrides.method || 'GET' }),
  };
}

function fakeConsoleMessage(type, text) {
  return { type: () => type, text: () => text };
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

// --- CASE A/B/C/D diagnostic listeners (2026-09-17) ---
// See src/scrapers/mercari.js: the goal is distinguishing "no request to
// api.mercari.jp was ever sent" (CASE A) from "one was sent but nothing
// (response or failure) was ever observed for it" (CASE B), on top of the
// already-existing CASE C (a real response, any status) and CASE D
// (requestfailed). These tests only check that the new listeners fire
// correctly and never change search()'s actual outcome — they do not (and
// cannot, with this fake fixture) reproduce the real Playwright network
// stack, so they are not a substitute for the Render verification pass.

test('mercari.search: request/requestfinished listeners for api.mercari.jp do not affect a successful scrape', async () => {
  const { ctx, emitter } = makeFakeContextWithEvents({
    waitForResponse: async () => {
      // Mirrors the real ordering: request/requestfinished fire around the
      // same waitForResponse() call that ultimately resolves with the match.
      emitter.emit('request', fakeApiRequest());
      emitter.emit('requestfinished', fakeApiRequest());
      return fakeApiResponse({ items: [] });
    },
  });
  const results = await mercari.search(ctx, 'iphone');
  assert.deepEqual(results, [], 'the new diagnostic listeners must not change a normal successful outcome');
});

test('mercari.search: apiRequestsSeen counts only api.mercari.jp requests and is included in the no-api-response log (CASE A/B)', async () => {
  const { ctx, emitter } = makeFakeContextWithEvents({
    waitForResponse: async () => {
      // Not api.mercari.jp — must NOT be counted.
      emitter.emit('request', fakeApiRequest({ url: 'https://jp.mercari.com/some-asset.js' }));
      // Two real api.mercari.jp requests, neither ever gets a matching
      // response or failure before the timeout — this is CASE B.
      emitter.emit('request', fakeApiRequest());
      emitter.emit('request', fakeApiRequest());
      return null;
    },
  });

  const originalWarn = logger.warn.bind(logger);
  let captured = null;
  logger.warn = (obj, msg) => {
    if (obj && obj.status === 'no-api-response') captured = obj;
    return originalWarn(obj, msg);
  };
  try {
    await assert.rejects(() => mercari.search(ctx, 'iphone'), /not observed/);
  } finally {
    logger.warn = originalWarn;
  }

  assert.ok(captured, 'the no-api-response log must have been emitted');
  assert.equal(captured.apiRequestsSeen, 2, 'only the two api.mercari.jp requests must be counted');
  assert.ok('finalUrl' in captured, 'no-api-response log must include finalUrl');
  assert.ok('pageTitle' in captured, 'no-api-response log must include pageTitle');
});

test('mercari.search: no api.mercari.jp request at all leaves apiRequestsSeen at 0 (CASE A)', async () => {
  const { ctx } = makeFakeContextWithEvents({
    waitForResponse: async () => null,
  });

  const originalWarn = logger.warn.bind(logger);
  let captured = null;
  logger.warn = (obj, msg) => {
    if (obj && obj.status === 'no-api-response') captured = obj;
    return originalWarn(obj, msg);
  };
  try {
    await assert.rejects(() => mercari.search(ctx, 'iphone'), /not observed/);
  } finally {
    logger.warn = originalWarn;
  }

  assert.ok(captured, 'the no-api-response log must have been emitted');
  assert.equal(captured.apiRequestsSeen, 0, 'no request observed must report apiRequestsSeen: 0');
});

test('mercari.search: the widened response listener observes a 200 without changing the no-api-response outcome (CASE C)', async () => {
  const { ctx, emitter } = makeFakeContextWithEvents({
    waitForResponse: async () => {
      // A real 200 arrives, but on a method our real predicate doesn't match
      // (GET instead of POST) — the diagnostic listener must observe it
      // without making waitForResponse() itself resolve. The real
      // predicate/matching logic in mercari.js is untouched by this test.
      emitter.emit('response', fakeApiResponseEvent({ status: 200, method: 'GET' }));
      return null;
    },
  });
  await assert.rejects(() => mercari.search(ctx, 'iphone'), /not observed/);
});

test('mercari.search: requestfailed for api.mercari.jp is still observed and does not change the outcome (CASE D)', async () => {
  const { ctx, emitter } = makeFakeContextWithEvents({
    waitForResponse: async () => {
      emitter.emit('requestfailed', fakeApiRequest({ failure: { errorText: 'net::ERR_CONNECTION_RESET' } }));
      return null;
    },
  });
  await assert.rejects(() => mercari.search(ctx, 'iphone'), /not observed/);
});

// --- console/pageerror listeners + goto/api-wait progress logs (2026-09-17) ---
// See src/scrapers/mercari.js: the question here is whether Mercari's own
// client-side JS ever gets far enough to attempt /v2/entities:search, or
// throws/reports something before that. These tests only check the new
// listeners fire correctly and never change search()'s actual outcome.

test('mercari.search: a successful scrape is unaffected by console/pageerror listeners and the new progress logs', async () => {
  const { ctx, emitter } = makeFakeContextWithEvents({
    goto: async () => {
      emitter.emit('console', fakeConsoleMessage('log', 'ignored — not a relevant type'));
      return { status: () => 200 };
    },
    waitForResponse: async () => fakeApiResponse({ items: [] }),
  });
  const results = await mercari.search(ctx, 'iphone');
  assert.deepEqual(results, [], 'the new listeners/logs must not change a normal successful outcome');
});

test('mercari.search: only relevant console types (error/warning/assert) are counted, "log"/"info" are ignored', async () => {
  const { ctx, emitter } = makeFakeContextWithEvents({
    waitForResponse: async () => {
      emitter.emit('console', fakeConsoleMessage('log', 'noisy debug line'));
      emitter.emit('console', fakeConsoleMessage('info', 'noisy info line'));
      emitter.emit('console', fakeConsoleMessage('error', 'a real page error message'));
      emitter.emit('console', fakeConsoleMessage('warning', 'a real page warning'));
      return null;
    },
  });

  const originalWarn = logger.warn.bind(logger);
  let captured = null;
  logger.warn = (obj, msg) => {
    if (obj && obj.status === 'no-api-response') captured = obj;
    return originalWarn(obj, msg);
  };
  try {
    await assert.rejects(() => mercari.search(ctx, 'iphone'), /not observed/);
  } finally {
    logger.warn = originalWarn;
  }

  assert.ok(captured, 'the no-api-response log must have been emitted');
  assert.equal(captured.consoleMessagesSeen, 2, 'only "error" and "warning" must be counted, not "log"/"info"');
});

test('mercari.search: pageerror events are counted and included in the no-api-response summary', async () => {
  const { ctx, emitter } = makeFakeContextWithEvents({
    waitForResponse: async () => {
      emitter.emit('pageerror', Object.assign(new Error('boom in page JS'), { name: 'TypeError' }));
      emitter.emit('pageerror', Object.assign(new Error('boom again'), { name: 'ReferenceError' }));
      return null;
    },
  });

  const originalWarn = logger.warn.bind(logger);
  let captured = null;
  logger.warn = (obj, msg) => {
    if (obj && obj.status === 'no-api-response') captured = obj;
    return originalWarn(obj, msg);
  };
  try {
    await assert.rejects(() => mercari.search(ctx, 'iphone'), /not observed/);
  } finally {
    logger.warn = originalWarn;
  }

  assert.ok(captured, 'the no-api-response log must have been emitted');
  assert.equal(captured.pageErrorsSeen, 2, 'both pageerror events must be counted');
});

test('mercari.search: emits a goto-diagnostic log with finalUrl/pageTitle/httpStatus right after navigation', async () => {
  const ctx = makeFakeContext({
    goto: async () => ({ status: () => 200 }),
    waitForResponse: async () => null,
  });

  const originalInfo = logger.info.bind(logger);
  let captured = null;
  logger.info = (obj, msg) => {
    if (obj && obj.status === 'goto-diagnostic') captured = obj;
    return originalInfo(obj, msg);
  };
  try {
    await assert.rejects(() => mercari.search(ctx, 'iphone'), /not observed/);
  } finally {
    logger.info = originalInfo;
  }

  assert.ok(captured, 'a goto-diagnostic log must be emitted right after page.goto() resolves');
  assert.equal(captured.httpStatus, 200);
  // The shared fake page has no .url()/.title() — both must degrade to null,
  // not throw (same guarded pattern already used at no-api-response).
  assert.equal(captured.finalUrl, null);
  assert.equal(captured.pageTitle, null);
});

test('mercari.search: a page-error/console message beyond the diagnostic cap is counted but not logged (no flooding)', async () => {
  const { ctx, emitter } = makeFakeContextWithEvents({
    waitForResponse: async () => {
      for (let i = 0; i < 25; i++) {
        emitter.emit('pageerror', new Error(`error #${i}`));
      }
      return null;
    },
  });

  const originalWarn = logger.warn.bind(logger);
  let captured = null;
  let warnCallsForPageError = 0;
  logger.warn = (obj, msg) => {
    if (obj && obj.status === 'page-error') warnCallsForPageError++;
    if (obj && obj.status === 'no-api-response') captured = obj;
    return originalWarn(obj, msg);
  };
  try {
    await assert.rejects(() => mercari.search(ctx, 'iphone'), /not observed/);
  } finally {
    logger.warn = originalWarn;
  }

  assert.ok(captured, 'the no-api-response log must have been emitted');
  assert.equal(captured.pageErrorsSeen, 25, 'the true total must still be counted past the cap');
  assert.equal(warnCallsForPageError, 20, 'individual page-error log lines must stop at the cap (no flooding)');
});

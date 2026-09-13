'use strict';
// Lightweight test doubles for the small slice of the Playwright
// Context/Page API the scrapers actually call. These are NOT mocks of the
// scraper functions themselves — mercari.search()/yahoo.search()/
// paypay.search() run for real; only their `context`/`page` dependency is
// swapped for a deterministic double, so navigation/response failure paths
// can be tested without a real browser or network access. See
// test/README.md. Not itself a test file, so node:test won't run it.

function makeFakePage(overrides = {}) {
  return {
    goto: overrides.goto || (async () => ({ status: () => 200 })),
    waitForResponse: overrides.waitForResponse || (async () => null),
    waitForSelector: overrides.waitForSelector || (async () => {}),
    $$eval:
      overrides.$$eval ||
      (async () => {
        throw new Error('fake page.$$eval was not configured for this test');
      }),
    evaluate: overrides.evaluate || (async () => ''),
    close: overrides.close || (async () => {}),
  };
}

// `context.newPage()` is called once per scraper invocation, so a single page
// config is normally enough — a scraper reuses the same page object for every
// navigation within one search() call (see paypay.js's warmup + search).
//
// contextOverrides.requestGet fakes `context.request.get()` — paypay.js's
// lightweight HTTP warmup. Defaults to an always-successful 200 response so
// every existing test (which only cares about the search page response) does
// not need to know about the warmup request at all.
//
// contextOverrides.cookies / .addCookies fake the cookie-jar side of
// paypay.js's session cache (see paypaySession.js): `cookies()` is what gets
// read after a fresh warmup to populate the cache, `addCookies()` is what
// gets called instead of doing a warmup at all when a cached session exists.
// Both default to harmless no-ops so tests that don't care about the cache
// don't need to know about it.
function makeFakeContext(pageOverrides, contextOverrides = {}) {
  return {
    newPage: async () => makeFakePage(pageOverrides),
    request: {
      get: contextOverrides.requestGet || (async () => ({ ok: () => true, status: () => 200 })),
    },
    cookies: contextOverrides.cookies || (async () => []),
    addCookies: contextOverrides.addCookies || (async () => {}),
  };
}

// Helper for scrapers that call the same page method more than once per
// search() with different intended outcomes per call (e.g. paypay.js's
// homepage warmup `page.goto` succeeding, then the search `page.goto`
// failing).
function sequence(fns) {
  let i = 0;
  return async (...args) => {
    const fn = fns[Math.min(i, fns.length - 1)];
    i++;
    return fn(...args);
  };
}

module.exports = { makeFakePage, makeFakeContext, sequence };

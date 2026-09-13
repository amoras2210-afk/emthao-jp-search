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
function makeFakeContext(pageOverrides) {
  return {
    newPage: async () => makeFakePage(pageOverrides),
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

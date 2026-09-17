const { logger } = require('../logger');
const { paceDomain } = require('../concurrency');
const { toItem } = require('./normalize');
const { PER_NAV_TIMEOUT_MS: TIMEOUT_MS } = require('../util/scraperTimeout');

const SOURCE = 'mercari';
const HOST = 'jp.mercari.com';
const BASE = 'https://jp.mercari.com';
const API_MATCH = '/v2/entities:search';
// The search API lives on a separate host from the page itself (jp.mercari.com
// loads the SPA shell; api.mercari.jp serves the actual search data) — see
// mercari.skill.md's "no-api-response" maintenance signal. Diagnostic-only
// listeners below are scoped to this host so a failure there (DNS, connection
// reset, timeout, 403/429, ...) is distinguishable in logs from a generic
// "the SPA never called the API" timeout, without changing any scrape
// behavior, timeout, retry, or concurrency logic.
const API_HOST = 'api.mercari.jp';

// Mercari item-condition codes → human label (Japanese, as shown on listing).
const CONDITION_MAP = {
  1: '新品、未使用',
  2: '未使用に近い',
  3: '目立った傷や汚れなし',
  4: 'やや傷や汚れあり',
  5: '傷や汚れあり',
  6: '全体的に状態が悪い',
};

async function search(context, query, opts = {}) {
  const limit = opts.limit ?? 20;
  const pageNum = Math.max(1, opts.page || 1);
  const { signal } = opts;
  const url = `${BASE}/search?keyword=${encodeURIComponent(query)}`;

  // If the outer deadline (routes/search.js) already gave up on THIS attempt
  // before we even got here (e.g. it aborted while we were still queued
  // behind context.newPage()'s own await), don't bother opening a Chromium
  // page at all — retry() also won't launch a further attempt once it sees
  // signal.aborted (see retry.js), so there is nothing left to wait for.
  if (signal?.aborted) {
    throw new Error('mercari scrape aborted before start (outer deadline already expired)');
  }

  const page = await context.newPage();
  const start = Date.now();
  // Count of api.mercari.jp requests observed via the diagnostic `request`
  // listener below, since the moment this attempt started — see the
  // 'no-api-response' log further down. Purely observational, never read by
  // any control-flow decision.
  let apiRequestsSeen = 0;
  // Counts for the console/pageerror listeners below — same purely
  // observational role as apiRequestsSeen, surfaced in the 'no-api-response'
  // summary log. Never read by any control-flow decision.
  let consoleMessagesSeen = 0;
  let pageErrorsSeen = 0;
  // Safety cap so a chatty/broken page can't flood the logs — counters above
  // still track the true total regardless of this cap.
  const DIAGNOSTIC_LOG_CAP = 20;

  // --- Cancellation on the outer per-source deadline (additive) ---
  // When routes/search.js's withTimeout() gives up on this source, it aborts
  // `signal` — see 2026-09-17 incident: without this, an in-flight
  // page.goto()/waitForResponse() kept running for its own ~20s internal
  // timeout, holding a Chromium page open (and using CPU) while the NEXT
  // source (Yahoo) had already started, even under SCRAPE_CONCURRENCY=1.
  // Closing the page here makes any pending goto/waitForResponse on it
  // reject almost immediately instead of waiting out their own timeout.
  // `{ once: true }` plus the `finally` removeEventListener below means this
  // never fires more than once and never leaks past this call.
  const onAbort = () => {
    page.close().catch(() => {});
  };
  if (signal) {
    if (signal.aborted) {
      // Aborted in the gap between the check above and page creation.
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  // --- Diagnostic-only network logging (additive, no behavior change) ---
  // Purely observational: these listeners never throw, never alter control
  // flow, and never affect what search() returns. They exist to turn
  // "mercari API not observed" (the one error every failed run currently
  // logs) into a precise network-level reason on the next Render failure —
  // whether a request to api.mercari.jp was ever sent at all, whether it got
  // a response (any status) or a network-level failure, or whether it just
  // never resolved either way — instead of a generic timeout. Scoped to
  // api.mercari.jp only. Guarded on `page.on` existing: the scraper-failure
  // test suite (test/scraper-failures/_fakeContext.js) doubles `page` with
  // only the methods real scrapers call, which didn't include `.on()`
  // before — guarding here keeps this change scoped to this file instead of
  // touching that shared fixture (also used by yahoo.test.js/paypay.test.js).
  // A real Playwright page always has `.on`, so this is a no-op in production.
  if (typeof page.on === 'function') {
    // --- 2026-09-17: distinguish CASE A (no request ever emitted) from
    // CASE B (request emitted, never fails or responds) ---
    // `requestfailed` and the (pre-widen) `response` listener below only
    // ever fire once Chromium already knows the outcome — neither can fire
    // in a scenario where a request is either never dispatched at all, or
    // dispatched and left hanging with no failure/response yet. `request`
    // is the only event that fires the instant Chromium attempts to send
    // it, independent of what happens next — it's the missing signal needed
    // to tell A and B apart on the next Render failure. `requestfinished`
    // complements `response`/`requestfailed` by confirming the network
    // exchange fully completed. Both are purely observational: no header,
    // cookie, or body is read or logged, and neither can throw or alter
    // control flow.
    page.on('request', (req) => {
      if (!req.url().includes(API_HOST)) return;
      apiRequestsSeen += 1;
      logger.info(
        {
          scraper: SOURCE,
          status: 'api-request',
          method: req.method(),
          url: req.url(),
          resourceType: req.resourceType(),
          durationMs: Date.now() - start,
        },
        'mercari API request observed'
      );
    });
    page.on('requestfinished', (req) => {
      if (!req.url().includes(API_HOST)) return;
      logger.info(
        {
          scraper: SOURCE,
          status: 'api-request-finished',
          method: req.method(),
          url: req.url(),
          resourceType: req.resourceType(),
          durationMs: Date.now() - start,
        },
        'mercari API request finished'
      );
    });
    page.on('requestfailed', (req) => {
      if (!req.url().includes(API_HOST)) return;
      const failure = req.failure();
      logger.warn(
        {
          scraper: SOURCE,
          status: 'api-request-failed',
          url: req.url(),
          method: req.method(),
          resourceType: req.resourceType(),
          errorText: failure?.errorText || 'unknown',
          durationMs: Date.now() - start,
        },
        'mercari API request failed at network layer'
      );
    });
    // Widened for this diagnostic (2026-09-17): log EVERY api.mercari.jp
    // response, not just >=300, so a real 200 that our waitForResponse()
    // predicate below simply doesn't match (e.g. a method other than POST)
    // becomes visible too (CASE C) — this listener is purely observational
    // and does not touch the real predicate or matching logic in any way.
    page.on('response', (resp) => {
      if (!resp.url().includes(API_HOST)) return;
      const isError = resp.status() >= 300;
      const payload = {
        scraper: SOURCE,
        status: isError ? 'api-response-error-status' : 'api-response-observed',
        url: resp.url(),
        method: resp.request().method(),
        httpStatus: resp.status(),
        httpStatusText: resp.statusText(),
        durationMs: Date.now() - start,
      };
      // Called as logger.warn(...)/logger.info(...) (not extracted into a
      // bare `const log = ...` reference) — pino's methods rely on `this`
      // being the logger instance; calling one unbound throws inside this
      // event handler, which can disrupt Playwright's own event dispatch
      // (this exact bug was caught by the real integration test below).
      if (isError) {
        logger.warn(payload, 'mercari API responded with a non-2xx/3xx status');
      } else {
        logger.info(payload, 'mercari API response observed (diagnostic)');
      }
    });
    // --- 2026-09-17: was the page's own JS ever going to fire the search
    // call at all? ---
    // The network listeners above proved api.mercari.jp itself is reachable
    // and responsive from Render (other endpoints return clean 200s) while
    // /v2/entities:search is never requested — so the next question is
    // whether Mercari's client-side bootstrap hits a JS error or reports
    // something relevant via console before ever reaching the point where it
    // would fire that call. Purely observational: never throws, never reads
    // cookies/headers/bodies, never alters control flow. Only 'error',
    // 'warning', and 'assert' console message types are logged (not
    // 'log'/'info'/'debug') to stay close to "relevant" without flooding.
    page.on('console', (msg) => {
      const type = typeof msg.type === 'function' ? msg.type() : null;
      if (type !== 'error' && type !== 'warning' && type !== 'assert') return;
      consoleMessagesSeen += 1;
      if (consoleMessagesSeen > DIAGNOSTIC_LOG_CAP) return;
      logger.info(
        {
          scraper: SOURCE,
          status: 'console-message',
          type,
          text: typeof msg.text === 'function' ? msg.text() : null,
          durationMs: Date.now() - start,
        },
        'mercari page console message'
      );
    });
    page.on('pageerror', (err) => {
      pageErrorsSeen += 1;
      if (pageErrorsSeen > DIAGNOSTIC_LOG_CAP) return;
      logger.warn(
        {
          scraper: SOURCE,
          status: 'page-error',
          name: err?.name || null,
          message: err?.message || String(err),
          durationMs: Date.now() - start,
        },
        'mercari page threw an unhandled error'
      );
    });
  }

  try {
    await paceDomain(HOST);

    // Listen for the API response BEFORE navigating, so we don't miss it.
    const apiResponsePromise = page
      .waitForResponse(
        (resp) => resp.url().includes(API_MATCH) && resp.request().method() === 'POST',
        { timeout: TIMEOUT_MS }
      )
      .catch(() => null);

    const gotoStart = Date.now();
    const gotoResp = await page.goto(url, { timeout: TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    // Minimal progress log (2026-09-17), mirroring yahoo.js's own
    // goto-diagnostic: an early, independent snapshot of finalUrl/pageTitle
    // right after the page shell loads — separate from the (unchanged) live
    // snapshot taken at the no-api-response point below, so a later
    // client-side redirect/degradation between the two becomes visible.
    logger.info(
      {
        scraper: SOURCE,
        status: 'goto-diagnostic',
        gotoDurationMs: Date.now() - gotoStart,
        httpStatus: gotoResp ? gotoResp.status() : null,
        finalUrl: typeof page.url === 'function' ? page.url() : null,
        pageTitle: typeof page.title === 'function' ? await page.title().catch(() => null) : null,
      },
      'mercari goto complete'
    );

    logger.info(
      { scraper: SOURCE, status: 'api-wait-start', durationMs: Date.now() - start },
      'mercari waiting for API response'
    );

    const resp = await apiResponsePromise;
    if (!resp) {
      logger.warn(
        {
          scraper: SOURCE,
          status: 'no-api-response',
          durationMs: Date.now() - start,
          // apiRequestsSeen === 0 here means the browser never even attempted
          // to send a request to api.mercari.jp (CASE A); >= 1 means one was
          // sent but never got a matching response/failure before this point
          // (CASE B) — see the `request` listener above. consoleMessagesSeen/
          // pageErrorsSeen (2026-09-17) add whether the page's own JS
          // reported anything relevant before giving up. finalUrl/pageTitle
          // mirror yahoo.js's same diagnostic pattern, to catch a silent
          // redirect or degraded page (CASE F) — this is a fresh, live
          // snapshot at the point of failure, independent of the
          // goto-diagnostic snapshot taken right after navigation above.
          apiRequestsSeen,
          consoleMessagesSeen,
          pageErrorsSeen,
          finalUrl: typeof page.url === 'function' ? page.url() : null,
          pageTitle: typeof page.title === 'function' ? await page.title().catch(() => null) : null,
        },
        'mercari API not observed'
      );
      // Mercari's SPA fires this API call for every search, including 0-result ones —
      // never observing it means the page failed to load in time, not a real empty
      // result. Throw so the retry() wrapper in routes/search.js retries the navigation.
      throw new Error('mercari API response not observed (timeout)');
    }

    let body;
    try {
      body = await resp.json();
    } catch (err) {
      logger.warn(
        { scraper: SOURCE, status: 'bad-json', error: err.message },
        'mercari API JSON parse failed'
      );
      // Malformed/truncated response — transient, not a real empty search. Retry.
      throw err;
    }

    const apiItems = Array.isArray(body?.items) ? body.items : [];
    // Drop:
    //   - items not ON_SALE (sold/stopped/in trade — clicking these shows "エラーが発生しました")
    //   - non-MERCARI itemTypes (Beyond/Shops items use a different URL routing that
    //     `/item/<id>` does not always resolve cleanly to)
    const onSale = apiItems.filter(
      (it) =>
        it &&
        it.id &&
        it.name &&
        it.status === 'ITEM_STATUS_ON_SALE' &&
        (!it.itemType || it.itemType === 'ITEM_TYPE_MERCARI') &&
        !it.shop
    );
    // Mercari's API returns ~120 items in one response — paginate by slicing
    // rather than re-querying. Phase 2 may switch to API cursor (searchConditionId).
    const sliceStart = (pageNum - 1) * limit;
    const items = onSale
      .slice(sliceStart, sliceStart + limit)
      .map((it) => {
        const priceNum = Number.parseInt(it.price, 10);
        const condition = CONDITION_MAP[Number.parseInt(it.itemConditionId, 10)] || null;
        const image =
          it.thumbnails?.[0] ||
          it.photos?.[0]?.uri ||
          null;
        // Mercari ships UNIX seconds in `updated`/`created` strings.
        const tsSec = Number.parseInt(it.updated || it.created, 10);
        const updatedAt = Number.isFinite(tsSec) && tsSec > 0
          ? new Date(tsSec * 1000).toISOString()
          : null;
        return toItem({
          title: it.name,
          price: Number.isFinite(priceNum) && priceNum > 0 ? priceNum : null,
          image,
          url: `${BASE}/item/${it.id}`,
          condition,
          source: SOURCE,
          updatedAt,
        });
      })
      .filter((it) => it.title && it.url);

    logger.info(
      { scraper: SOURCE, durationMs: Date.now() - start, itemCount: items.length, status: 'ok' },
      'scrape ok'
    );
    return items;
  } catch (err) {
    logger.error(
      { scraper: SOURCE, durationMs: Date.now() - start, error: err.message },
      'mercari scrape failed'
    );
    // Rethrow so retry() can retry a transient navigation/response failure. A
    // genuinely empty search never reaches here — it returns [] above without throwing.
    throw err;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    // Unchanged from before: safe even if onAbort() already closed the page
    // (Playwright tolerates closing an already-closing/closed page, and
    // .catch(() => {}) swallows either way).
    await page.close().catch(() => {});
  }
}

module.exports = { search };

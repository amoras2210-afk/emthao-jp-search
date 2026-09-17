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
  // flow, and never affect what search() returns. They exist only to turn
  // "mercari API not observed" (the one error every failed run currently
  // logs) into a precise network-level reason on the next Render failure —
  // DNS resolution failure, connection reset/timeout, or an actual HTTP
  // status (403/429/5xx) from api.mercari.jp — instead of a generic timeout.
  // Scoped to api.mercari.jp only, and to non-2xx/3xx responses only, to
  // avoid adding noise for the (expected) successful case. Guarded on
  // `page.on` existing: the scraper-failure test suite (test/scraper-
  // failures/_fakeContext.js) doubles `page` with only the methods real
  // scrapers call, which didn't include `.on()` before — guarding here
  // keeps this change scoped to this file instead of touching that shared
  // fixture (also used by yahoo.test.js/paypay.test.js). A real Playwright
  // page always has `.on`, so this is a no-op in production.
  if (typeof page.on === 'function') {
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
    page.on('response', (resp) => {
      if (!resp.url().includes(API_HOST)) return;
      if (resp.status() < 300) return;
      logger.warn(
        {
          scraper: SOURCE,
          status: 'api-response-error-status',
          url: resp.url(),
          httpStatus: resp.status(),
          httpStatusText: resp.statusText(),
          durationMs: Date.now() - start,
        },
        'mercari API responded with a non-2xx/3xx status'
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

    await page.goto(url, { timeout: TIMEOUT_MS, waitUntil: 'domcontentloaded' });

    const resp = await apiResponsePromise;
    if (!resp) {
      logger.warn(
        { scraper: SOURCE, status: 'no-api-response', durationMs: Date.now() - start },
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

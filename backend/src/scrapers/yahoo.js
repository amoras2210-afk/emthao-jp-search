const { logger } = require('../logger');
const { paceDomain } = require('../concurrency');
const { toItem } = require('./normalize');
const { parsePrice } = require('../util/parsePrice');
const { absoluteUrl } = require('../util/absoluteUrl');
const { PER_NAV_TIMEOUT_MS: TIMEOUT_MS } = require('../util/scraperTimeout');

const SOURCE = 'yahoo';
const HOST = 'auctions.yahoo.co.jp';
const BASE = 'https://auctions.yahoo.co.jp';
// Diagnostic-only cap for the (async, browser-round-trip) page.title() call
// below — see the 2026-09-17 incident: page.title() was observed taking
// ~12.2s under Render CPU load, sitting between goto() and waitForSelector()
// in sequence, silently consuming most of the functional wait budget and
// causing a false "no-items" result on an otherwise successful page.
// page.waitForSelector() is now CALLED (its own internal timeout clock
// starts) BEFORE this diagnostic is ever awaited, so this can no longer
// delay the functional path — see search() below. 500ms is generous for a
// same-page round trip and small enough to never matter next to the ~20s
// functional budget it now runs concurrently with, not before.
const DIAGNOSTIC_TITLE_TIMEOUT_MS = 500;

// Resolves to `null` — never rejects — if `promise` doesn't settle within
// `ms`, or if it rejects on its own (e.g. the page closed mid-flight).
// Diagnostic-only: deliberately separate from util/withTimeout.js, which
// wraps a whole scraper attempt for retry()/routes/search.js — this is a
// purely local, best-effort helper for one non-blocking logging value.
function withDiagnosticTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

function buildUrl(query, mode, page, limit) {
  let url = `${BASE}/search/search?p=${encodeURIComponent(query)}&va=${encodeURIComponent(query)}`;
  if (mode === 'auction') url += '&fixed=2';
  if (mode === 'fixed') url += '&fixed=1';
  // Yahoo paginates with `b=<1-indexed offset>&n=<page-size>`.
  if (page && page > 1) {
    const offset = (page - 1) * limit + 1;
    url += `&b=${offset}&n=${limit}`;
  } else if (limit) {
    url += `&n=${limit}`;
  }
  return url;
}

async function search(context, query, opts = {}) {
  const limit = opts.limit ?? 20;
  const pageNum = Math.max(1, opts.page || 1);
  const mode = opts.yahooMode || 'all';
  const url = buildUrl(query, mode, pageNum, limit);
  const page = await context.newPage();
  const start = Date.now();

  // --- Diagnostic-only instrumentation (additive, no behavior change) ---
  // Purely observational: never throws, never alters what search() returns,
  // never changes timeouts/retries. Exists to distinguish, when comparing
  // Yahoo solo vs Yahoo 3rd-in-request: (A) an abnormally slow goto(), (B) a
  // goto() that "succeeds" but lands on the wrong page, (C) the real page
  // loading but .Product never appearing, (D) .Product appearing but a later
  // step failing, (E) a failed network request to auctions.yahoo.co.jp.
  // Guarded on each Playwright method existing: the scraper-failure test
  // suite's fake page (test/scraper-failures/_fakeContext.js) only
  // implements goto/waitForResponse/waitForSelector/$$eval/evaluate/close —
  // not on/title/url/locator — so these guards keep this change from
  // touching that shared fixture (same pattern as mercari.js's 93eaf26).
  if (typeof page.on === 'function') {
    page.on('requestfailed', (req) => {
      if (!req.url().includes(HOST)) return;
      const failure = req.failure();
      logger.warn(
        {
          scraper: SOURCE,
          status: 'yahoo-request-failed',
          url: req.url(),
          method: req.method(),
          resourceType: req.resourceType(),
          errorText: failure?.errorText || 'unknown',
          durationMs: Date.now() - start,
        },
        'yahoo request failed at network layer'
      );
    });
  }

  try {
    await paceDomain(HOST);

    const gotoStart = Date.now();
    const gotoResp = await page.goto(url, { timeout: TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    const gotoEnd = Date.now();
    // page.url() is synchronous (cached from the last navigation, no browser
    // round trip) — safe to read immediately, unlike page.title() below.
    const finalUrl = typeof page.url === 'function' ? page.url() : null;

    const remaining = TIMEOUT_MS - (Date.now() - start);
    const waitStart = Date.now();
    // CALLED here, immediately after goto — its internal timeout clock
    // starts ticking now, BEFORE the diagnostic page.title() fetch below is
    // ever awaited, so that fetch can never delay this. Not awaited yet.
    const waitForSelectorPromise = page.waitForSelector('li.Product', { timeout: Math.max(1000, remaining) });
    // A second handler on the same promise, attached immediately, so Node
    // never treats it as an unhandled rejection during the short window
    // before the try/catch below actually awaits it (right after the title
    // diagnostic). This does not consume or alter the rejection the
    // try/catch observes — multiple handlers on one promise are independent.
    waitForSelectorPromise.catch(() => {});

    // Diagnostic-only, capped and non-blocking (see DIAGNOSTIC_TITLE_TIMEOUT_MS
    // above) — runs concurrently with waitForSelectorPromise, which is
    // already in flight by this point, so this can add at most its own
    // short ceiling, never stack on top of the functional wait.
    const pageTitle =
      typeof page.title === 'function'
        ? await withDiagnosticTimeout(page.title(), DIAGNOSTIC_TITLE_TIMEOUT_MS)
        : null;

    logger.info(
      {
        scraper: SOURCE,
        status: 'goto-diagnostic',
        gotoStart,
        gotoEnd,
        gotoDurationMs: gotoEnd - gotoStart,
        httpStatus: gotoResp ? gotoResp.status() : null,
        finalUrl,
        pageTitle,
      },
      'yahoo goto complete'
    );

    try {
      await waitForSelectorPromise;
      const waitEnd = Date.now();
      logger.info(
        {
          scraper: SOURCE,
          status: 'waitforselector-diagnostic',
          waitStart,
          waitEnd,
          waitDurationMs: waitEnd - waitStart,
          productCount:
            typeof page.locator === 'function'
              ? await page.locator('li.Product').count().catch(() => -1)
              : null,
        },
        'yahoo .Product found'
      );
    } catch {
      const waitEnd = Date.now();
      logger.warn(
        {
          scraper: SOURCE,
          status: 'no-items',
          mode,
          durationMs: Date.now() - start,
          waitStart,
          waitEnd,
          waitDurationMs: waitEnd - waitStart,
        },
        'yahoo .Product not found'
      );
      return [];
    }

    const raws = await page.$$eval(
      'li.Product',
      (cards, arg) => {
        return cards.slice(0, arg.limit).map((card) => {
          const titleLink =
            card.querySelector('.Product__titleLink') ||
            card.querySelector('.Product__title a') ||
            card.querySelector('a[href*="/auction/"]');
          const titleEl = card.querySelector('.Product__title') || titleLink;
          const title = (titleEl?.textContent || '').trim() || null;
          const href = titleLink?.getAttribute('href') || null;

          const priceEl = card.querySelector('.Product__priceValue') || card.querySelector('.Product__price');
          const priceText = priceEl?.textContent || null;

          const img =
            card.querySelector('.Product__image img') ||
            card.querySelector('.Product__imageBox img') ||
            card.querySelector('img');
          const imageSrc = img?.getAttribute('src') || img?.getAttribute('data-src') || null;

          const bidEl = card.querySelector('.Product__bid') || card.querySelector('.Product__bidValue');
          const bidText = bidEl?.textContent?.trim() || null;

          const timeEl = card.querySelector('.Product__time') || card.querySelector('.Product__timeValue');
          const timeText = timeEl?.textContent?.trim() || null;

          const cardText = card.textContent || '';
          const isFixed =
            !!card.querySelector('.Product__icon--buynow, [class*="buynow" i]') || /即決/.test(cardText);

          return { title, priceText, image: imageSrc, href, bidText, timeText, isFixed };
        });
      },
      { limit }
    );

    const items = raws
      .map((r) => {
        // When the URL filtered for one mode, every result is that mode by definition.
        // Only fall back to per-card heuristic when querying 'all'.
        let resolvedMode;
        if (mode === 'auction') resolvedMode = 'auction';
        else if (mode === 'fixed') resolvedMode = 'fixed';
        else resolvedMode = r.isFixed ? 'fixed' : 'auction';

        return toItem({
          title: r.title,
          price: parsePrice(r.priceText),
          image: r.image ? absoluteUrl(r.image, BASE) : null,
          url: r.href ? absoluteUrl(r.href, BASE) : null,
          source: SOURCE,
          bidCount: r.bidText ? parseInt(String(r.bidText).replace(/[^\d]/g, ''), 10) || null : null,
          timeLeft: r.timeText,
          mode: resolvedMode,
        });
      })
      .filter((it) => it.title && it.url);

    logger.info(
      { scraper: SOURCE, durationMs: Date.now() - start, itemCount: items.length, mode, status: 'ok' },
      'scrape ok'
    );
    return items;
  } catch (err) {
    logger.error(
      { scraper: SOURCE, durationMs: Date.now() - start, error: err.message },
      'yahoo scrape failed'
    );
    // Rethrow so retry() can retry a transient navigation/response failure (e.g.
    // page.goto timeout). A genuinely empty search ('no-items' above) still returns
    // [] without throwing.
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { search };

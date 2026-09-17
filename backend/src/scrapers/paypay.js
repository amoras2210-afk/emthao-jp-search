const { logger } = require('../logger');
const { paceDomain } = require('../concurrency');
const { toItem } = require('./normalize');
const { parsePrice } = require('../util/parsePrice');
const { absoluteUrl } = require('../util/absoluteUrl');
const { PER_NAV_TIMEOUT_MS: TIMEOUT_MS } = require('../util/scraperTimeout');
const { getCachedCookies, setCachedCookies, invalidateCachedCookies } = require('../paypaySession');

const SOURCE = 'paypay';
const HOST = 'paypayfleamarket.yahoo.co.jp';
const BASE = 'https://paypayfleamarket.yahoo.co.jp';
// PayPay does 2 sequential navigations per attempt (homepage warmup, then
// search) — each uses the full TIMEOUT_MS below. routes/search.js's
// NAVIGATIONS_PER_ATTEMPT.paypay = 2 accounts for this when sizing the outer
// retry deadline (see scraperTimeout.js). The warmup is now normally a
// lightweight HTTP request rather than a full page load (see below), so this
// remains a conservative upper bound, not a tight one.
// PayPay shows this string and falls back to generic recommendations when it can't load
// search results — typically because the request originates from outside Japan.
const GEO_FAIL_MARKERS = ['データの取得に失敗しました', 'あなたへのおすすめ'];

async function search(context, query, opts = {}) {
  const limit = opts.limit ?? 20;
  const { signal } = opts;
  const url = `${BASE}/search/${encodeURIComponent(query)}`;

  // If the outer deadline (routes/search.js) already gave up on THIS attempt
  // before we even got here (e.g. it aborted while we were still queued
  // behind context.newPage()'s own await), don't bother opening a Chromium
  // page at all — retry() also won't launch a further attempt once it sees
  // signal.aborted (see retry.js), so there is nothing left to wait for.
  // Same pattern as mercari.js.
  if (signal?.aborted) {
    throw new Error('paypay scrape aborted before start (outer deadline already expired)');
  }

  const page = await context.newPage();
  const start = Date.now();
  const cachedCookies = getCachedCookies();
  const usedCachedCookies = !!(cachedCookies && cachedCookies.length > 0);

  // --- Cancellation on the outer per-source deadline (additive) ---
  // Same pattern as mercari.js's 2026-09-17 fix: without this, an in-flight
  // page.goto()/waitForSelector()/context.request.get() kept running for its
  // own internal timeout after routes/search.js's withTimeout() had already
  // given up on this source and freed the SCRAPE_CONCURRENCY slot — a zombie
  // page holding Chromium/CPU while the NEXT source (or a new request)
  // started. Closing the page here makes any pending page.goto/
  // waitForSelector/$$eval on it reject almost immediately instead of
  // waiting out their own timeout. Does NOT cover the lightweight HTTP
  // warmup (`context.request.get`, not tied to any page) — see the note
  // below where that call is made.
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

  try {
    // Homepage warmup. Without a prior hit on the Yahoo!フリマ domain, /search/<q>
    // returns 404 + the "データの取得に失敗しました" banner from non-JP IPs (the SPA's
    // first data-fetch is server-gated). After any homepage hit, a session cookie
    // is minted and /search returns HTTP 200 with the real result anchors.
    //
    // A live diagnostic (2026-09-13) confirmed the warmup only needs to mint 4
    // cookies (A, XA, B, XB on .yahoo.co.jp), and that reusing just those 4
    // cookies from an earlier warmup — in a totally different BrowserContext,
    // with no warmup at all — is enough for the search to succeed. See
    // paypaySession.js. So: reuse a cached session if we have one (no network
    // request at all — `context.addCookies` is local); otherwise do the
    // lightweight HTTP warmup (falling back to a full page load if that
    // fails) and cache the resulting cookies for the next search in this
    // process.
    if (usedCachedCookies) {
      await context.addCookies(cachedCookies);
    } else {
      await paceDomain(HOST);
      try {
        const warmupResp = await context.request.get(BASE, { timeout: TIMEOUT_MS });
        if (!warmupResp.ok()) {
          throw new Error(`PayPay HTTP warmup returned ${warmupResp.status()}`);
        }
      } catch (err) {
        logger.warn(
          {
            scraper: SOURCE,
            status: 'http-warmup-failed',
            error: err.message,
            durationMs: Date.now() - start,
          },
          'paypay lightweight HTTP warmup failed — falling back to full page warmup'
        );
        await paceDomain(HOST);
        await page.goto(BASE, { timeout: TIMEOUT_MS, waitUntil: 'domcontentloaded' });
      }
      setCachedCookies(await context.cookies());
    }

    await paceDomain(HOST);
    const resp = await page.goto(url, { timeout: TIMEOUT_MS, waitUntil: 'domcontentloaded' });

    if (resp && resp.status() !== 200) {
      logger.warn(
        {
          scraper: SOURCE,
          status: 'http-error',
          httpStatus: resp.status(),
          durationMs: Date.now() - start,
          usedCachedCookies,
        },
        'paypay search returned non-200 after warmup'
      );
      if (resp.status() === 404) {
        // Confirmed via a live curl diagnostic (2026-09-13, warmup cookie
        // already valid): a 404 here consistently rendered a full page with
        // generic/unrelated fallback recommendations for a query with no
        // real matches — the same shape as Next.js's own notFound:true zero-
        // result handling, not a block. Retrying a deterministic zero-result
        // 3x would just waste attempts, so treat it like no-anchors below.
        // Not a sign of a bad session, so the cookie cache is left as-is.
        return [];
      }
      // Any other non-200 (403, 5xx, ...) is unexplained by the zero-result
      // case above. Confirmed transient for at least one such status via a
      // live VPN diagnostic: a real Chrome session hit a non-200 here, then
      // succeeded on a plain reload moments later with no other change.
      // Invalidate any cached session — it may be stale or bad — so the next
      // retry attempt does a fresh warmup instead of reusing it, then throw
      // so retry() gets a chance to re-run the whole sequence.
      invalidateCachedCookies();
      throw new Error(`PayPay HTTP error: ${resp.status()}`);
    }

    try {
      await page.waitForSelector('a[href*="/item/"]', { timeout: 6000 });
    } catch {
      logger.warn(
        { scraper: SOURCE, status: 'no-anchors', durationMs: Date.now() - start, usedCachedCookies },
        'paypay no item anchors rendered'
      );
      // A real zero-result state, not a sign of a bad session — cookie cache
      // is left as-is.
      return [];
    }

    // Defensive: even after warmup, surface the geo/data-failed fallback if it appears.
    // Both markers must be present together — the recommendations heading alone shows up
    // legitimately on some pages.
    const pageText = await page.evaluate(() => document.body.innerText || '');
    if (GEO_FAIL_MARKERS.every((m) => pageText.includes(m))) {
      logger.warn(
        {
          scraper: SOURCE,
          status: 'geo-blocked',
          durationMs: Date.now() - start,
          usedCachedCookies,
          hint: 'Homepage warmup did not unblock search — Yahoo may have tightened geo-gating.',
        },
        'paypay geo-blocked or data-fetch-failed'
      );
      // Confirmed transient (live VPN diagnostic, 2026-09-13): a real Chrome
      // session hit this exact banner once, then succeeded on a plain reload
      // moments later with no other change. Invalidate any cached session
      // (it may be stale or bad), then throw so retry() gets a chance to
      // re-run the whole sequence with a fresh warmup.
      invalidateCachedCookies();
      throw new Error('PayPay data fetch failed');
    }

    const raws = await page.$$eval(
      'a[href*="/item/"]',
      (anchors, arg) => {
        return anchors.slice(0, arg.limit).map((a) => {
          const href = a.getAttribute('href');
          const img = a.querySelector('img');
          const imageSrc = img?.getAttribute('src') || img?.getAttribute('data-src') || null;
          const imgAlt = img?.getAttribute('alt') || null;
          const text = (a.innerText || '').replace(/\s+/g, ' ').trim();
          const priceMatch = text.match(/([\d,]+)\s*円/);
          const priceText = priceMatch ? priceMatch[1] : null;
          return { href, image: imageSrc, title: imgAlt, priceText };
        });
      },
      { limit }
    );

    const items = raws
      .map((r) =>
        toItem({
          title: r.title,
          price: parsePrice(r.priceText),
          image: r.image ? absoluteUrl(r.image, BASE) : null,
          url: r.href ? absoluteUrl(r.href, BASE) : null,
          source: SOURCE,
        })
      )
      .filter((it) => it.title && it.url);

    logger.info(
      { scraper: SOURCE, durationMs: Date.now() - start, itemCount: items.length, status: 'ok', usedCachedCookies },
      'scrape ok'
    );
    return items;
  } catch (err) {
    logger.error(
      { scraper: SOURCE, durationMs: Date.now() - start, error: err.message },
      'paypay scrape failed'
    );
    // Rethrow so retry() can retry a transient navigation/response failure —
    // covers non-404 http-error and the geo-blocked/data-fetch-failed marker
    // (both confirmed transient via a live VPN diagnostic, 2026-09-13).
    // no-anchors and a 404 status still return [] above without throwing:
    // both are treated as a genuine zero-result search, not a block.
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

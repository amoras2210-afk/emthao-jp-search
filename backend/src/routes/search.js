const express = require('express');
const rateLimit = require('express-rate-limit');
const pLimit = require('p-limit');
const { logger } = require('../logger');
const { newContext } = require('../browser');
const { cache, cacheKey, deleteByQuery } = require('../cache');
const pricing = require('../config/pricing');
const mercari = require('../scrapers/mercari');
const yahoo = require('../scrapers/yahoo');
const paypay = require('../scrapers/paypay');
const { retry } = require('../util/retry');
const { withTimeout } = require('../util/withTimeout');
const { RETRY_ATTEMPTS, RETRY_DELAYS_MS, computeOuterDeadlineMs } = require('../util/scraperTimeout');

const router = express.Router();

const SCRAPERS = {
  mercari: mercari.search,
  yahoo: yahoo.search,
  paypay: paypay.search,
};

const ALL_SOURCES = ['mercari', 'yahoo', 'paypay'];

// --- FlipRadar API-contract adapter (route layer only — scrapers below are
// untouched). FlipRadar's emthaoProvider.ts / httpProvider.ts speak a
// specific wire contract: source IDs are MERCARI_JP/YAHOO_AUCTIONS_JP/
// PAYPAY_FLEA_JP (not our internal mercari/yahoo/paypay), the marketplace
// filter param is `marketplaces` (not `sources`), and each result item needs
// a `source` field matching one of those IDs exactly — httpProvider.ts does
// `data.results.filter((r) => r.source === opts.id)`, so a mismatched ID
// silently drops every item for that marketplace. Everything below only
// reshapes what the scrapers already return; it does not change scraper
// behavior. `sources=` (lowercase, comma-separated) keeps working unchanged
// for the existing emthao-jp-search/frontend.
const MARKETPLACE_TO_INTERNAL = {
  MERCARI_JP: 'mercari',
  YAHOO_AUCTIONS_JP: 'yahoo',
  PAYPAY_FLEA_JP: 'paypay',
};
const INTERNAL_TO_MARKETPLACE = {
  mercari: 'MERCARI_JP',
  yahoo: 'YAHOO_AUCTIONS_JP',
  paypay: 'PAYPAY_FLEA_JP',
};

// Mercari condition labels are intentionally kept in Japanese on the item
// itself (source-of-truth value, see .claude/CLAUDE.md "Frontend UI is
// English-only" — the emthao-jp-search frontend translates them at render
// time via labels.js). FlipRadar instead expects raw.condition to already be
// one of NEW/LIKE_NEW/GOOD/FAIR/POOR (asCondition() in httpProvider.ts
// defaults anything else to GOOD), so this maps only for the FlipRadar-shaped
// response — the scraper's own Japanese-label output is untouched.
const MERCARI_CONDITION_TO_ENUM = {
  '新品、未使用': 'NEW',
  '未使用に近い': 'LIKE_NEW',
  '目立った傷や汚れなし': 'GOOD',
  'やや傷や汚れあり': 'FAIR',
  '傷や汚れあり': 'FAIR',
  '全体的に状態が悪い': 'POOR',
};

function mapCondition(condition) {
  if (!condition) return null;
  return MERCARI_CONDITION_TO_ENUM[condition] || null;
}

// Our scrapers don't carry a marketplace externalId (normalize.js's toItem()
// only keeps title/price/image/url/condition/source/currency) — FlipRadar's
// JpSearchItem requires one. Every scraper's url is the real, DOM-verified
// listing link (never id-constructed — see mercari.js/paypay.js comments), so
// the trailing /item/<id> or /auction/<id> path segment is a stable,
// non-invented identifier. Falls back to a short, deterministic hash of the
// url on the rare listing whose url doesn't match that shape, rather than
// dropping the item.
function deriveExternalId(url, internalSource) {
  if (!url) return `${internalSource}-unknown`;
  const match = String(url).match(/\/(?:item|auction)\/([^/?#]+)/);
  if (match) return match[1];
  return Buffer.from(String(url)).toString('base64url').slice(0, 40);
}

// Reshapes one already-scraped item (normalize.js's toItem() shape) into
// FlipRadar's JpSearchItem contract. Fields the scrapers never collected
// (sellerName/sellerRating/sellerReviewCount/currentBid/auctionEnd — dropped
// from MVP per .claude/CLAUDE.md, or never scraped) are null, which
// httpProvider.ts already treats as `?? undefined`.
function toJapanSearchItem(item, internalSource) {
  return {
    source: INTERNAL_TO_MARKETPLACE[internalSource],
    externalId: deriveExternalId(item.url, internalSource),
    title: item.title || '',
    price: typeof item.price === 'number' ? item.price : null,
    currency: item.currency || 'JPY',
    url: item.url || null,
    images: item.image ? [item.image] : [],
    condition: mapCondition(item.condition),
    sellerName: null,
    sellerRating: null,
    sellerReviewCount: null,
    listingType: item.mode === 'auction' ? 'AUCTION' : 'BUY_NOW',
    currentBid: null,
    bidCount: typeof item.bidCount === 'number' ? item.bidCount : null,
    auctionEnd: null,
    sourceCountry: 'JP',
    isDemo: false,
    fetchedAt: new Date().toISOString(),
    availability: 'AVAILABLE',
  };
}

// Sentinel distinguishing "this source produced zero results" (still a
// success — DEGRADED) from "this source timed out or threw after every retry
// attempt" (ERROR). withTimeout() resolves to the `fallback` value passed to
// it in BOTH cases (see util/withTimeout.js) without exposing which one
// happened, so a unique, non-array sentinel is what lets the two be told
// apart afterwards without touching withTimeout.js itself.
const SCRAPER_UNAVAILABLE = Symbol('scraper-unavailable');
// How many sequential page navigations one retry attempt needs for each
// source. Everyone does a single page.goto; PayPay does homepage-warmup +
// search (see paypay.skill.md). This feeds computeOuterDeadlineMs() below so
// PayPay's outer deadline accounts for needing 2x the per-navigation budget
// per attempt — without it, PayPay's own internal timeout could exceed a
// deadline sized only for a single navigation.
const NAVIGATIONS_PER_ATTEMPT = { paypay: 2 };
// Concurrency cap on cross-source scrapes. Free tier OOMs at 3 parallel
// Chromium tabs; 2 leaves room for 2 sources to run at once while the 3rd
// waits its turn.
const SCRAPE_CONCURRENCY = parseInt(process.env.SCRAPE_CONCURRENCY, 10) || 2;
// Order in which sources are SUBMITTED to the concurrency limiter below —
// this only changes who gets a slot first, not SCRAPE_CONCURRENCY itself.
// PayPay is submitted alongside Mercari (both start immediately under the
// default concurrency of 2) instead of after Yahoo. A live diagnostic
// (2026-09-13) showed PayPay's own work drops from ~26s to ~10s when it
// isn't forced to wait behind the two faster sources — Yahoo (the fastest
// source) absorbs the wait for a slot instead. Purely a LAUNCH-order
// optimization: the `sources` field echoed in the response, and the order of
// items in `results` below, both stay in the original requested order — the
// results are re-keyed by source and flattened via `sources`, not this order.
const SUBMISSION_PRIORITY = { paypay: 0, mercari: 1, yahoo: 2 };
// Shared by every /search request in this process — created once at module
// load, NOT per-request. A per-request limiter only caps concurrency within
// one request's own 3 scrapers: under real concurrent users, N simultaneous
// requests would each open their own SCRAPE_CONCURRENCY Chromium pages,
// multiplying total memory use far beyond what SCRAPE_CONCURRENCY was tuned
// for (Render free tier OOMs above ~2-3 parallel Chromium tabs — see
// .claude/CLAUDE.md). This module-level limiter makes SCRAPE_CONCURRENCY an
// actual process-wide cap, regardless of how many requests are in flight.
const limiter = pLimit(SCRAPE_CONCURRENCY);

// Basic per-IP abuse guard on GET /search only — not /health, not
// DELETE /search/cache. 20 requests/minute is generous for legitimate use
// (several searches, filter/sort tweaks, "Load more", the odd "Refresh")
// while still cutting off a scripted loop quickly. This is deliberately NOT
// the primary defense against resource exhaustion — the module-level
// `limiter` above already caps real Chromium concurrency process-wide
// regardless of request volume. This just avoids letting one IP flood the
// queue and degrade the shared budget for everyone else.
const SEARCH_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const SEARCH_RATE_LIMIT_MAX = 20;
const searchRateLimiter = rateLimit({
  windowMs: SEARCH_RATE_LIMIT_WINDOW_MS,
  max: SEARCH_RATE_LIMIT_MAX,
  standardHeaders: true, // RateLimit-Limit / -Remaining / -Reset headers
  legacyHeaders: false,
  handler: (req, res, _next, options) => {
    logger.warn({ ip: req.ip, path: req.path }, 'search rate limit exceeded');
    res.status(options.statusCode).json({
      error: 'Too many search requests — please slow down and try again shortly.',
    });
  },
});

router.get('/search', searchRateLimiter, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing query param: q' });
  if (q.length > 100) return res.status(400).json({ error: 'Query too long (max 100 chars)' });

  // `marketplaces=MERCARI_JP,YAHOO_AUCTIONS_JP,...` is FlipRadar's param
  // (emthaoProvider.ts's fetchJapanSearch()); `sources=mercari,yahoo,...`
  // is the existing emthao-jp-search/frontend's param. Both are accepted;
  // `marketplaces` takes priority when both are present.
  const marketplacesParam = req.query.marketplaces != null ? String(req.query.marketplaces).trim() : '';
  let sources;
  if (marketplacesParam) {
    sources = marketplacesParam
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .map((s) => MARKETPLACE_TO_INTERNAL[s])
      .filter((s) => s && ALL_SOURCES.includes(s));
  } else {
    const sourcesParam = String(req.query.sources || ALL_SOURCES.join(','));
    sources = sourcesParam
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => ALL_SOURCES.includes(s));
  }
  if (sources.length === 0) return res.status(400).json({ error: 'No valid sources' });

  // Which response shape to build. The existing emthao-jp-search/frontend
  // (ResultCard.jsx, useSearch.js, BookmarksView.jsx, filters.js, etc.) reads
  // item.image (singular), item.source (lowercase mercari/yahoo/paypay),
  // item.mode, item.timeLeft, item.updatedAt, and the raw Japanese
  // item.condition directly — it does NOT use `marketplaces=`, so detecting
  // on that param is a safe, request-scoped switch: only requests that
  // actually ask for the FlipRadar contract get reshaped into it. Requests
  // using the legacy `sources=` param get the exact original item/response
  // shape, byte-for-byte, so the existing frontend is completely unaffected.
  const isFlipRadarContract = Boolean(marketplacesParam);

  const limit = Math.max(1, Math.min(40, parseInt(req.query.limit, 10) || 20));
  const page = Math.max(1, Math.min(20, parseInt(req.query.page, 10) || 1));
  const yahooMode = ['all', 'auction', 'fixed'].includes(req.query.yahooMode)
    ? req.query.yahooMode
    : 'all';
  const noCache = req.query.nocache === '1' || req.query.nocache === 'true';

  const key = cacheKey({ q, sources, yahooMode, limit, page, contract: isFlipRadarContract ? 'flipradar' : 'legacy' });
  if (!noCache) {
    const cached = cache.get(key);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }
  }

  const start = Date.now();
  let context;
  try {
    context = await newContext();
  } catch (err) {
    logger.error({ error: err.message }, 'failed to create browser context');
    return res.status(500).json({ error: 'Search failed', detail: err.message });
  }

  // Scheduling order only (see SUBMISSION_PRIORITY above) — `sources` itself
  // (used for the response payload and cache key) stays in its original,
  // requested order.
  const schedulingOrder = [...sources].sort(
    (a, b) => (SUBMISSION_PRIORITY[a] ?? 99) - (SUBMISSION_PRIORITY[b] ?? 99)
  );
  try {
    const perScraperResults = await Promise.all(
      schedulingOrder.map((src) => {
        // The outer deadline is derived from the retry policy (attempts +
        // delays) and how many navigations this source needs per attempt —
        // not an independently-picked constant — so it always has room for
        // every attempt retry() might actually make. See scraperTimeout.js.
        const deadlineMs = computeOuterDeadlineMs({
          navigationsPerAttempt: NAVIGATIONS_PER_ATTEMPT[src] || 1,
        });
        return limiter(() =>
          withTimeout(
            retry(
              () => SCRAPERS[src](context, q, { limit, yahooMode, page }),
              {
                attempts: RETRY_ATTEMPTS,
                delays: RETRY_DELAYS_MS,
                label: src,
              }
            ),
            deadlineMs,
            SCRAPER_UNAVAILABLE,
            src
          )
        );
      })
    );
    // perScraperResults is positionally aligned with schedulingOrder (launch
    // order), not `sources` (requested order) — re-key by source first so
    // the flattening below can iterate in the original `sources` order.
    // Otherwise the item order in `results` would silently follow whichever
    // source got launched first, which is a launch-time optimization detail,
    // not something callers should see reflected in response ordering.
    // Each outcome is either the scraper's item array (possibly empty — a
    // legitimate no-result/known-blocked state, see .claude/CLAUDE.md) or the
    // SCRAPER_UNAVAILABLE sentinel (every retry attempt failed or timed out).
    const resultsBySource = new Map();
    const statusBySource = new Map();
    schedulingOrder.forEach((src, i) => {
      const outcome = perScraperResults[i];
      if (outcome === SCRAPER_UNAVAILABLE) {
        resultsBySource.set(src, []);
        statusBySource.set(src, { status: 'ERROR', error: 'Scraper unavailable: every retry attempt failed or timed out.' });
      } else {
        resultsBySource.set(src, outcome);
        statusBySource.set(src, {
          status: outcome.length ? 'LIVE' : 'DEGRADED',
          error: outcome.length ? null : 'No results returned for this query.',
        });
      }
    });

    // Flatten (in the original requested `sources` order) and dedupe by URL
    // — the dedupe is a defensive guard against scrapers that accidentally
    // pick up the same listing twice (selector overlap, etc.). Item shape
    // depends on isFlipRadarContract (see its definition above): the
    // existing frontend's items are pushed completely unchanged; only
    // FlipRadar-contract requests get reshaped via toJapanSearchItem().
    const seen = new Set();
    const results = [];
    for (const src of sources) {
      for (const item of resultsBySource.get(src) || []) {
        if (!item.url || seen.has(item.url)) continue;
        seen.add(item.url);
        results.push(isFlipRadarContract ? toJapanSearchItem(item, src) : item);
      }
    }

    // Heuristic: a source is presumed to have more pages if it came back
    // with a full page of results. Scrapers don't currently report a real
    // hasNextPage (see .claude/CLAUDE.md FR-22 — pagination is per-source and
    // client-driven), so this is the same "Load more" heuristic the existing
    // frontend already relies on, just exposed on the response for
    // FlipRadar's JpSearchResponse contract, which requires the field.
    const hasNextPage = sources.some((src) => (resultsBySource.get(src) || []).length >= limit);

    const sourcesPayload = isFlipRadarContract
      ? // FlipRadar's JpSearchResponse.sources contract: one entry per
        // requested marketplace with a health status FlipRadar surfaces
        // directly (see statusFromHealth() in httpProvider.ts).
        sources.map((src) => {
          const st = statusBySource.get(src);
          return {
            source: INTERNAL_TO_MARKETPLACE[src],
            status: st.status,
            error: st.error,
            count: (resultsBySource.get(src) || []).length,
          };
        })
      : // Existing emthao-jp-search/frontend shape: unchanged.
        sources;

    const payload = {
      query: q,
      count: results.length,
      page,
      limit,
      cached: false,
      pricing: {
        rate: pricing.JPY_VND_RATE,
        markupPct: pricing.MARKUP_PCT,
        shipVndPerKg: pricing.SHIP_VND_PER_KG,
        defaultWeightKg: pricing.DEFAULT_WEIGHT_KG,
      },
      results,
      sources: sourcesPayload,
      // Only added for FlipRadar-contract requests — JpSearchResponse
      // requires `hasNextPage`, and `unofficial` mirrors services/jp-search's
      // convention. Omitted (not just falsy) for the legacy shape so the
      // existing frontend's response stays byte-for-byte identical to before.
      ...(isFlipRadarContract ? { hasNextPage, unofficial: true } : {}),
    };
    cache.set(key, payload);
    logger.info(
      { q, sources, yahooMode, durationMs: Date.now() - start, count: results.length },
      'search complete'
    );
    res.json(payload);
  } catch (err) {
    logger.error({ q, error: err.message }, 'search failed');
    res.status(500).json({ error: 'Search failed', detail: err.message });
  } finally {
    await context.close().catch(() => {});
  }
});

// Invalidate every cached entry for a query. Wired to the frontend's "remove from
// recent searches" action so deleting a history item also flushes its server cache.
router.delete('/search/cache', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing query param: q' });
  if (q.length > 100) return res.status(400).json({ error: 'Query too long (max 100 chars)' });
  const removed = deleteByQuery(q);
  logger.info({ q, removed }, 'cache invalidated for query');
  res.json({ q, removed });
});

module.exports = router;

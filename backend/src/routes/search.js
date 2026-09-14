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

  const sourcesParam = String(req.query.sources || ALL_SOURCES.join(','));
  const sources = sourcesParam
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => ALL_SOURCES.includes(s));
  if (sources.length === 0) return res.status(400).json({ error: 'No valid sources' });

  const limit = Math.max(1, Math.min(40, parseInt(req.query.limit, 10) || 20));
  const page = Math.max(1, Math.min(20, parseInt(req.query.page, 10) || 1));
  const yahooMode = ['all', 'auction', 'fixed'].includes(req.query.yahooMode)
    ? req.query.yahooMode
    : 'all';
  const noCache = req.query.nocache === '1' || req.query.nocache === 'true';

  const key = cacheKey({ q, sources, yahooMode, limit, page });
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
            [],
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
    const resultsBySource = new Map(schedulingOrder.map((src, i) => [src, perScraperResults[i]]));

    // Flatten (in the original requested `sources` order) and dedupe by URL
    // — the dedupe is a defensive guard against scrapers that accidentally
    // pick up the same listing twice (selector overlap, etc.).
    const seen = new Set();
    const results = [];
    for (const src of sources) {
      for (const item of resultsBySource.get(src) || []) {
        if (!item.url || seen.has(item.url)) continue;
        seen.add(item.url);
        results.push(item);
      }
    }
    const payload = {
      query: q,
      count: results.length,
      sources,
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

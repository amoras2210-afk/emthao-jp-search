const express = require('express');
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
// Chromium tabs; 2 leaves Mercari + Yahoo room while PayPay (which fast-fails
// via geo-block detection) waits its turn.
const SCRAPE_CONCURRENCY = parseInt(process.env.SCRAPE_CONCURRENCY, 10) || 2;

router.get('/search', async (req, res) => {
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

  const limiter = pLimit(SCRAPE_CONCURRENCY);
  try {
    const perScraperResults = await Promise.all(
      sources.map((src) => {
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
    // Flatten and dedupe by URL — defensive guard against scrapers that
    // accidentally pick up the same listing twice (selector overlap, etc.).
    const seen = new Set();
    const results = [];
    for (const arr of perScraperResults) {
      for (const item of arr) {
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

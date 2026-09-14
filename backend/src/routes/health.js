const express = require('express');
const { isConnected } = require('../browser');
const { cache } = require('../cache');

const router = express.Router();

// FlipRadar's httpProvider.ts reads health.providers[healthKey] (MERCARI_JP /
// YAHOO_AUCTIONS_JP / PAYPAY_FLEA_JP) to decide each marketplace's status
// badge (statusFromHealth() in httpProvider.ts). This endpoint doesn't run an
// actual scrape per marketplace — that would make /health as slow and
// resource-heavy as a real search, defeating its purpose as a fast liveness
// probe — so all three report off the one signal actually available here:
// whether the shared Chromium process (used by every scraper) is up. This is
// deliberately not a claim about any single marketplace's site being
// scrapable right now (geo-blocks, layout changes, etc. aren't detectable
// without a real request) — it only reflects the shared browser dependency
// every scraper needs to run at all.
router.get('/health', async (req, res) => {
  const browserConnected = await isConnected();
  const providerStatus = browserConnected ? 'LIVE' : 'UNAVAILABLE';
  res.json({
    status: browserConnected ? 'ok' : 'degraded',
    unofficial: true,
    cacheEntries: cache.size,
    browserConnected,
    providers: {
      MERCARI_JP: providerStatus,
      YAHOO_AUCTIONS_JP: providerStatus,
      PAYPAY_FLEA_JP: providerStatus,
    },
  });
});

module.exports = router;

const { LRUCache } = require('lru-cache');

const TTL_MS = parseInt(process.env.CACHE_TTL_MS, 10) || 7 * 60 * 1000;

const cache = new LRUCache({
  max: 500,
  ttl: TTL_MS,
});

// `contract` distinguishes the legacy emthao-jp-search/frontend response
// shape from the FlipRadar JpSearchResponse shape (see routes/search.js's
// isFlipRadarContract) — the same q/sources/yahooMode/limit/page can be
// requested through either one, and they return different item/response
// shapes, so without this a cache hit from one contract could serve the
// wrong shape to the other. Optional and defaults to '' so the key format
// for any other future caller that doesn't pass it is unaffected.
//
// `sources` is joined in the order it was given — deliberately NOT sorted.
// routes/search.js echoes `sources` back in the cached payload (the
// `sources` field, and the order items are flattened into `results`) in
// exactly the order the ORIGINAL request asked for. A sorted key made two
// requests for the same source set but a different order (e.g.
// `mercari,yahoo` vs `yahoo,mercari`) collide on one cache entry, so the
// second request silently got back the first request's order instead of
// its own (2026-09-17 audit finding, reproduced against the real
// routes/search.js). Not sorting means those two orders now get their own
// cache entries — a request's cached response always matches the order it
// actually asked for. The only cost is one extra scrape the first time a
// new order is seen for the same source set, same as any other cache-key
// dimension (limit/page/yahooMode) already works.
function cacheKey({ q, sources, yahooMode, limit, page, contract = '' }) {
  const sourcesKey = sources.join(',');
  return `${q}|${sourcesKey}|${yahooMode}|${limit}|p${page || 1}|${contract}`;
}

// Evict every entry for a given query (across all source/yahooMode/limit/page combos).
// Prefix match is safe enough — queries containing a literal '|' would collide, but
// Japanese marketplace queries in practice don't, and the worst case is an extra re-scrape.
function deleteByQuery(q) {
  const prefix = `${q}|`;
  let removed = 0;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
      removed++;
    }
  }
  return removed;
}

module.exports = { cache, cacheKey, deleteByQuery };

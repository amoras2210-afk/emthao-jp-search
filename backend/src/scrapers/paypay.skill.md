# PayPay Flea Market scraper — mechanism and maintenance

**File:** `paypay.js`
**Strategy:** Homepage warmup → DOM scrape from `/search/<q>`, with defensive geo-fail detector
**Status (2026-05-11):** ✅ Working from VN IPs. Homepage warmup mints a session cookie that unblocks search.

---

## How it works

PayPay Flea Market (Yahoo!フリマ, `paypayfleamarket.yahoo.co.jp`) does a **server-side gate** on cold `/search/<q>` requests from non-JP IPs — without a prior session cookie, the URL responds **HTTP 404** with a `データの取得に失敗しました` ("Data retrieval failed") banner. Item-detail pages (`/item/<id>`) are not gated and always work.

The fix (2026-05-11): visit the homepage first to mint a session cookie, then load `/search/<q>`. After the warmup, the same URL responds HTTP 200 with real result anchors. Verified across multiple keywords (カメラ, iPhone, 香水) from a VN IP.

Sequence per scrape:
1. `paceDomain(HOST)` — respect ≥1 s same-host pacing.
2. `page.goto(BASE)` (`https://paypayfleamarket.yahoo.co.jp/`) — homepage warmup.
3. `paceDomain(HOST)` again.
4. `page.goto(${BASE}/search/${encodeURIComponent(query)})` — actual search.
5. If `resp.status() !== 200` → log `http-error` and return `[]`.
6. `waitForSelector('a[href*="/item/"]', { timeout: 6000 })` — wait for cards.
7. Defensive check: if page text contains **both** `データの取得に失敗しました` AND `あなたへのおすすめ`, log `geo-blocked` and return `[]` (rare under warmup; covers the case where Yahoo tightens the gate further).
8. Extract from each anchor: `href`, `<img alt>` (title), `<img src>` (image), innerText `/([\d,]+)\s*円/` (price).

Total overhead vs cold scrape: ~1-2 s.

PayPay is the one scraper that does **2 sequential navigations per attempt**
(homepage warmup + search), each budgeted up to `TIMEOUT_MS`
(`src/util/scraperTimeout.js`'s `PER_NAV_TIMEOUT_MS`, default 20 s). One retry
attempt can therefore legitimately take up to ~2x a single-navigation
scraper's worst case. `routes/search.js` accounts for this via
`NAVIGATIONS_PER_ATTEMPT.paypay = 2` when computing the outer retry deadline —
don't remove that entry, or PayPay's own internal timeout budget can exceed
the deadline the route allows it and every retry after the first gets cut
off.

## Error handling contract: throw vs. return `[]`

- **Throws** (retryable, transient/technical failure — `retry()` in
  `routes/search.js` retries the whole `search()` call, including re-running
  the warmup): the homepage warmup `page.goto` failing, or any other
  unexpected error during navigation.
- **Returns `[]` without throwing** (known no-result / blocked state,
  retrying wouldn't change the outcome): non-200 response after warmup
  (`http-error`), no item anchors rendered in time (`no-anchors`), or the
  geo-block/recommendations-fallback markers detected (`geo-blocked`).

## Item shape

```jsonc
{
  "title": "Nikon D60デジタル一眼レフカメラ ダブルズームキット",
  "price": 13000,
  "image": "https://auc-pctr.c.yimg.jp/i/auctions.c.yimg.jp/...",
  "url": "https://paypayfleamarket.yahoo.co.jp/item/z607414898",
  "condition": null,           // not on listing card
  "source": "paypay",
  "currency": "JPY"
}
```

(Card uses Yahoo Auctions' image CDN — PayPay Flea Market and Yahoo Auctions share storage. The DOM still uses generated class names like `sc-698fe364-0`, so we scrape via `a[href*="/item/"]` anchors and read fields off the contained image + innerText.)

The internal JSON API at `/api/v1/recommend/items?recommendType=fleamarket_web_search&resultNum=96` exposes a richer shape (`itemId`, `title`, `price`, `image.url`, `likeCount`, `seller.id`) but **does not accept the search keyword** — it's a recommendation endpoint despite the URL name. We don't use it. The real search API at `/api/v1/search?keyword=...` exists but rejects requests from non-JP IPs (HTTP 400 with `検索できませんでした`), so we scrape the HTML page instead.

## Maintenance signals

- **Returns `[]` with `status: 'http-error', httpStatus: 404`** → homepage warmup failed to mint a working cookie. Inspect via `node scripts/debug-paypay-warmup.js` to compare cold vs warm behavior. Yahoo may have tightened gating.
- **Returns `[]` with `status: 'no-anchors'`** → page came back 200 but `a[href*="/item/"]` never rendered in 6 s. Inspect with `node scripts/debug-paypay-deep.js` to see all XHR responses.
- **Returns `[]` with `status: 'geo-blocked'`** → page rendered with both `データの取得に失敗しました` and `あなたへのおすすめ` markers. Warmup didn't work; likely needs a real JP proxy.
- **Returns wrong items (e.g. searching "fan" but getting Disney brooches)** → the geo-fail detector failed to fire. Either Yahoo changed the banner text or the recommendations heading. Compare two distinct queries — if identical results, recommendations are leaking through. Update `GEO_FAIL_MARKERS`.

## Lessons learned

1. **Don't trust visible items just because they exist.** PayPay renders 96 anchors on the recommendations-fallback page — without the marker check we'd return them as if they were search hits, every query returning the same useless list. Detect the failure state, return empty.
2. **The "recommend" API is not a search API.** The URL `recommendType=fleamarket_web_search` is misleading. Always verify by querying two different keywords and comparing — if results are identical, it's recommendations not search.
3. **Cold vs warm matters even with the right URL.** `/search/<q>` returns 404 on the first request of a fresh context from a non-JP IP, but 200 once any other page on the origin has been loaded first. The cost of an extra `page.goto(BASE)` is the price of admission for non-JP scraping.
4. **Item-detail pages aren't geo-gated.** `/item/<id>` works without warmup. If you ever need item-level enrichment (review counts, full description, condition), it's a single direct fetch.
5. **PayPay uses image `alt` for the listing title** — the visible card doesn't have a title element separate from the image. Don't waste time hunting for `<h3>` or `[class*="title"]`.

## Future-proofing ideas

- **If Yahoo tightens gating further** (e.g. warmup stops working): try a JP residential proxy (Webshare). Inject via `browser.newContext({ proxy: { server, username, password } })`.
- **Alternative path:** Sign in with a Yahoo Japan account to get session cookies and call the authenticated `/api/v1/search?keyword=...` endpoint directly. Requires legal review re: ToS for an internal tool.

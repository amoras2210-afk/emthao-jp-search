# Backend tests

Run everything with `npm test` (uses Node's built-in `node:test` runner — no
extra dependencies, no new devDependencies).

## `test/unit/` — no network, no browser, no scrapers

Pure unit tests for shared utilities: `src/util/retry.js` (first-attempt
success, retry-then-succeed, inter-attempt delays, exhausting all attempts)
and the retry/withTimeout/scraperTimeout composition used by
`routes/search.js` (`test/unit/retryTimeoutBudget.test.js` — covers the outer
deadline being correctly sized to fit every retry attempt, including a
regression test for the bug where an undersized deadline silently starved
retries 2 and 3). Uses small injected millisecond values, not the real
production timeouts, so it runs in well under a second.

Run alone: `npm run test:unit`.

## `test/integration/` — requires real internet access + a real Chromium browser

These call `mercari.search()` / `yahoo.search()` / `paypay.search()` for real,
against the live Mercari, Yahoo Auctions, and PayPay Flea Market sites, using
Playwright to launch an actual Chromium instance. They assert on **shape and
invariants only** (array type, item fields, `source`, URL prefix) — never on
exact titles/prices/counts, since live inventory changes constantly.

Run alone: `npm run test:integration`. Slower (real page loads), and will fail
if you're offline or if a marketplace changes its API/DOM — see the relevant
`backend/src/scrapers/*.skill.md` "Maintenance signals" section first.

## `test/scraper-failures/` — no network, no real browser

These also call the real scraper functions, but with a fake Playwright
`context`/`page` (`_fakeContext.js`) standing in for the real dependency, so
the navigation/response error-handling paths documented in each
`*.skill.md` (timeouts, malformed responses, PayPay's geo-block detector,
Mercari's sold-out/Shops filtering, etc.) can be tested deterministically and
offline. The scraper logic itself is never mocked — only its `context`/`page`
input.

Run alone: `npm run test:failures`. Fast, deterministic, no internet required.

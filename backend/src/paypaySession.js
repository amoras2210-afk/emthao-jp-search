'use strict';
// In-memory cache for PayPay's session cookies — lets paypay.js skip its
// warmup entirely on searches after the first one in this process, instead
// of re-minting the same cookies every time. See paypay.skill.md and the
// live diagnostic (2026-09-13) that identified these 4 cookies as the only
// ones the search actually needs.
//
// Deliberately NOT cached: `_gcl_au` / `_yjsu_yjad` (Google/Yahoo analytics
// cookies) — confirmed unnecessary for the search to succeed.
//
// Concurrency: getCachedCookies() always returns a fresh snapshot (a new
// array of new objects). A later setCachedCookies()/invalidateCachedCookies()
// call replaces the module's internal reference but can never mutate a
// snapshot a caller already holds — so a search already using an older
// snapshot in its own BrowserContext is unaffected by another search
// concurrently refreshing or invalidating the shared cache.

const ESSENTIAL_COOKIE_NAMES = ['A', 'XA', 'B', 'XB'];

// Precautionary TTL — NOT based on the cookies' own real expiry (~2027, per
// the live diagnostic). Guards against a silent server-side invalidation
// (e.g. a security rotation) that wouldn't show up as an expired cookie,
// only as a failed search. 30 minutes is short enough to catch such a
// rotation well within a single browsing session, long enough to eliminate
// the warmup for the common case of several searches in a row.
const CACHE_TTL_MS = 30 * 60 * 1000;

let cachedEntry = null; // { cookies: object[], cachedAt: number } | null

function getCachedCookies() {
  if (!cachedEntry) return null;
  if (Date.now() - cachedEntry.cachedAt > CACHE_TTL_MS) {
    cachedEntry = null;
    return null;
  }
  return cachedEntry.cookies.map((c) => ({ ...c }));
}

function setCachedCookies(cookies) {
  const essentialOnly = (cookies || [])
    .filter((c) => ESSENTIAL_COOKIE_NAMES.includes(c.name))
    .map((c) => ({ ...c }));
  // Don't cache a result that doesn't actually contain the cookies the
  // search needs — that would make later reads look "valid" (non-null,
  // within TTL) while being useless, silently skipping the warmup for
  // nothing.
  if (essentialOnly.length === 0) return;
  cachedEntry = { cookies: essentialOnly, cachedAt: Date.now() };
}

function invalidateCachedCookies() {
  cachedEntry = null;
}

module.exports = {
  ESSENTIAL_COOKIE_NAMES,
  CACHE_TTL_MS,
  getCachedCookies,
  setCachedCookies,
  invalidateCachedCookies,
};

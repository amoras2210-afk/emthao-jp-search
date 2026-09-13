// Shared timeout budgeting for scrapers + routes/search.js's retry/withTimeout
// composition. Single source of truth so the per-navigation timeout used inside
// each scraper and the outer per-source deadline used by the route can never
// silently collide again.
//
// Background (see code review that led to this file): routes/search.js used to
// pass the SAME value (SCRAPER_TIMEOUT_MS) both as each scraper's internal
// page.goto/waitForResponse timeout AND as the outer withTimeout() deadline for
// the whole retry(...) sequence. A single attempt's internal timeout could then
// consume the entire outer deadline, so retry's 2nd/3rd attempts never got a
// chance to run.
//
// Model:
//   - PER_NAV_TIMEOUT_MS is what ONE page navigation is allowed to take. This is
//     the number tuned for Render free tier (0.1 CPU/512MB — see
//     .claude/CLAUDE.md "Lessons learned" #-1: page.goto routinely needs 8-15s
//     there). Scrapers import this directly for their own page.goto/
//     waitForResponse/waitForSelector calls.
//   - A single retry "attempt" may need more than one navigation in sequence
//     (PayPay: homepage warmup + search page), so an attempt's total budget is
//     PER_NAV_TIMEOUT_MS * navigationsPerAttempt.
//   - The outer deadline handed to withTimeout() in routes/search.js must cover
//     every attempt's worst case plus the fixed inter-attempt retry delays, or
//     later attempts get starved exactly like the bug above. computeOuterDeadlineMs
//     derives that value instead of it being picked independently.
const DEFAULT_PER_NAV_TIMEOUT_MS = parseInt(process.env.SCRAPER_TIMEOUT_MS, 10) || 20000;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 2000];

function computeOuterDeadlineMs({
  navigationsPerAttempt = 1,
  perNavTimeoutMs = DEFAULT_PER_NAV_TIMEOUT_MS,
  attempts = RETRY_ATTEMPTS,
  delays = RETRY_DELAYS_MS,
} = {}) {
  const perAttemptMs = perNavTimeoutMs * navigationsPerAttempt;
  const totalDelayMs = delays.slice(0, Math.max(0, attempts - 1)).reduce((sum, d) => sum + d, 0);
  return perAttemptMs * attempts + totalDelayMs;
}

module.exports = {
  PER_NAV_TIMEOUT_MS: DEFAULT_PER_NAV_TIMEOUT_MS,
  RETRY_ATTEMPTS,
  RETRY_DELAYS_MS,
  computeOuterDeadlineMs,
};

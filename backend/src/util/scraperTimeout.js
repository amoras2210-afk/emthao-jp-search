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
//     derives that value from the retry policy instead of it being picked
//     independently.
//   - That derived value is then capped by MAX_SEARCH_DEADLINE_MS: uncapped, 3
//     attempts x 2 navigations (PayPay) x a Render-tuned ~20-25s per nav reaches
//     ~150s, which is far too long for an interactive /search request. The cap's
//     default is itself derived (one full worst-case attempt + a safety margin)
//     so it can never starve a source's very first legitimate attempt — see
//     resolveDefaultMaxDeadlineMs. Under the cap, single-navigation sources
//     (Mercari, Yahoo) typically still get ~2 full attempts; PayPay is
//     guaranteed exactly 1 full attempt (its structural minimum — 2 navigations
//     cost too much per attempt to guarantee it a 2nd within a sane cap) plus a
//     small chance at a 2nd attempt if the 1st fails fast rather than timing out.
const DEFAULT_PER_NAV_TIMEOUT_MS = parseInt(process.env.SCRAPER_TIMEOUT_MS, 10) || 20000;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 2000];

// The most sequential navigations any single retry attempt needs today
// (PayPay: homepage warmup + search). The default deadline cap below is sized
// off this so it always covers at least one full attempt for every source.
const MAX_NAVIGATIONS_PER_ATTEMPT = 2;
// Buffer on top of one full worst-case attempt so a legitimately-slow (not
// stuck) navigation isn't cut off right at the edge of its own timeout.
const DEADLINE_SAFETY_MARGIN_MS = 5000;

function resolveDefaultMaxDeadlineMs(perNavTimeoutMs, maxNavigationsPerAttempt, safetyMarginMs) {
  const envOverride = parseInt(process.env.MAX_SEARCH_DEADLINE_MS, 10);
  if (Number.isFinite(envOverride) && envOverride > 0) return envOverride;
  return perNavTimeoutMs * maxNavigationsPerAttempt + safetyMarginMs;
}

// Absolute ceiling on how long routes/search.js will wait for any single
// source, regardless of how many retry attempts the policy above would
// otherwise allow. Exported (pre-resolved against the process's actual env)
// for logging/introspection; computeOuterDeadlineMs re-resolves it per call
// so env overrides and per-call parameter overrides both work.
const MAX_SEARCH_DEADLINE_MS = resolveDefaultMaxDeadlineMs(
  DEFAULT_PER_NAV_TIMEOUT_MS,
  MAX_NAVIGATIONS_PER_ATTEMPT,
  DEADLINE_SAFETY_MARGIN_MS
);

function computeOuterDeadlineMs({
  navigationsPerAttempt = 1,
  perNavTimeoutMs = DEFAULT_PER_NAV_TIMEOUT_MS,
  attempts = RETRY_ATTEMPTS,
  delays = RETRY_DELAYS_MS,
  maxDeadlineMs,
  maxNavigationsPerAttempt = MAX_NAVIGATIONS_PER_ATTEMPT,
  safetyMarginMs = DEADLINE_SAFETY_MARGIN_MS,
} = {}) {
  const perAttemptMs = perNavTimeoutMs * navigationsPerAttempt;
  const totalDelayMs = delays.slice(0, Math.max(0, attempts - 1)).reduce((sum, d) => sum + d, 0);
  const rawDeadlineMs = perAttemptMs * attempts + totalDelayMs;

  const resolvedMaxDeadlineMs =
    maxDeadlineMs !== undefined
      ? maxDeadlineMs
      : resolveDefaultMaxDeadlineMs(perNavTimeoutMs, maxNavigationsPerAttempt, safetyMarginMs);

  return Math.min(rawDeadlineMs, resolvedMaxDeadlineMs);
}

module.exports = {
  PER_NAV_TIMEOUT_MS: DEFAULT_PER_NAV_TIMEOUT_MS,
  RETRY_ATTEMPTS,
  RETRY_DELAYS_MS,
  MAX_NAVIGATIONS_PER_ATTEMPT,
  DEADLINE_SAFETY_MARGIN_MS,
  MAX_SEARCH_DEADLINE_MS,
  computeOuterDeadlineMs,
};

'use strict';
// UNIT TESTS for the hard cap on computeOuterDeadlineMs (src/util/scraperTimeout.js).
// No network, no browser.
//
// Context: the raw attempts x per-attempt-timeout formula can reach ~150s in
// production for PayPay (3 attempts x 2 navigations x ~25s + delays) — far too
// long for an interactive /search request. These tests prove: the formula's
// result is actually capped, the default cap is derived (not an arbitrary
// constant) and scales with the per-navigation timeout, an env override wins,
// and — most importantly — the cap can never starve a source's first
// legitimate attempt (in particular PayPay's 2-navigation attempt).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { retry } = require('../../src/util/retry');
const { withTimeout } = require('../../src/util/withTimeout');
const {
  computeOuterDeadlineMs,
  PER_NAV_TIMEOUT_MS,
  MAX_SEARCH_DEADLINE_MS,
  MAX_NAVIGATIONS_PER_ATTEMPT,
  DEADLINE_SAFETY_MARGIN_MS,
} = require('../../src/util/scraperTimeout');

test('an explicit maxDeadlineMs truncates a raw deadline that would otherwise be far larger', () => {
  const raw = computeOuterDeadlineMs({
    navigationsPerAttempt: 2,
    perNavTimeoutMs: 25000,
    attempts: 3,
    delays: [1000, 2000],
    maxDeadlineMs: Number.POSITIVE_INFINITY, // effectively uncapped, to see the raw value
  });
  assert.equal(raw, 25000 * 2 * 3 + 3000, 'sanity check: uncapped formula matches the known worst case (153s)');

  const capped = computeOuterDeadlineMs({
    navigationsPerAttempt: 2,
    perNavTimeoutMs: 25000,
    attempts: 3,
    delays: [1000, 2000],
    maxDeadlineMs: 55000,
  });
  assert.equal(capped, 55000, 'the cap must win when the raw formula exceeds it');
});

test('the default cap is derived from perNavTimeoutMs, not a fixed constant', () => {
  const capSmall = computeOuterDeadlineMs({ navigationsPerAttempt: 1, perNavTimeoutMs: 1000 });
  const capLarge = computeOuterDeadlineMs({ navigationsPerAttempt: 1, perNavTimeoutMs: 25000 });

  // Raw deadline for perNavTimeoutMs=1000 (3 attempts, default delays) is
  // 1000*3+3000=6000, which is below its own derived cap (1000*2+5000=7000),
  // so this reflects the RAW value, not the cap — proving the cap scales
  // rather than clamping every small value to one fixed number.
  assert.equal(capSmall, 1000 * 3 + 3000);
  // Raw deadline for perNavTimeoutMs=25000 (single nav, 3 attempts) is
  // 25000*3+3000=78000, well above its derived cap (25000*2+5000=55000), so
  // this DOES reflect the cap.
  assert.equal(capLarge, 25000 * 2 + 5000);
  assert.ok(capLarge > capSmall, 'a larger per-navigation timeout must yield a larger effective cap');
});

test('MAX_SEARCH_DEADLINE_MS env override wins over the derived default', () => {
  const original = process.env.MAX_SEARCH_DEADLINE_MS;
  try {
    process.env.MAX_SEARCH_DEADLINE_MS = '12345';
    const deadline = computeOuterDeadlineMs({ navigationsPerAttempt: 2, perNavTimeoutMs: 25000 });
    assert.equal(deadline, 12345, 'an explicit env override must be used verbatim as the cap');
  } finally {
    if (original === undefined) delete process.env.MAX_SEARCH_DEADLINE_MS;
    else process.env.MAX_SEARCH_DEADLINE_MS = original;
  }
});

test('the default cap always covers at least one full PayPay-style (2-navigation) attempt', () => {
  // This is the key correctness invariant: whatever PER_NAV_TIMEOUT_MS is
  // configured to in this environment, the default cap must never be smaller
  // than one full 2-navigation attempt — otherwise PayPay's very first
  // legitimate attempt would get cut off mid-navigation, which is worse than
  // having no retry logic at all.
  const oneFullPaypayAttemptMs = PER_NAV_TIMEOUT_MS * MAX_NAVIGATIONS_PER_ATTEMPT;
  assert.ok(
    MAX_SEARCH_DEADLINE_MS >= oneFullPaypayAttemptMs,
    `default cap (${MAX_SEARCH_DEADLINE_MS}ms) must be >= one full PayPay attempt (${oneFullPaypayAttemptMs}ms)`
  );
  assert.equal(MAX_SEARCH_DEADLINE_MS, oneFullPaypayAttemptMs + DEADLINE_SAFETY_MARGIN_MS);
});

test('regression: an interactive request is bounded by the cap even when every attempt keeps failing on a timeout', async () => {
  // Simulates the worst case this fix targets: a source that fails on every
  // attempt by hanging until its own per-navigation timeout, for a
  // PayPay-shaped (2 navigations/attempt) scraper. Without the cap, retry()
  // would keep going for the full uncapped deadline (scaled down here to run
  // fast); with the cap, withTimeout must cut it off close to maxDeadlineMs
  // and return the fallback, never approaching the raw uncapped total.
  const perNavTimeoutMs = 20;
  const navigationsPerAttempt = 2;
  const attempts = 3;
  const delays = [10, 10];
  const maxDeadlineMs = 50; // deliberately less than one full attempt (2*20=40) plus a 2nd attempt

  const rawDeadlineMs = computeOuterDeadlineMs({
    navigationsPerAttempt,
    perNavTimeoutMs,
    attempts,
    delays,
    maxDeadlineMs: Number.POSITIVE_INFINITY,
  });
  const cappedDeadlineMs = computeOuterDeadlineMs({
    navigationsPerAttempt,
    perNavTimeoutMs,
    attempts,
    delays,
    maxDeadlineMs,
  });
  assert.equal(cappedDeadlineMs, maxDeadlineMs);
  assert.ok(rawDeadlineMs > cappedDeadlineMs * 2, 'the uncapped formula must be dramatically larger than the cap in this scenario');

  const attemptDurationMs = perNavTimeoutMs * navigationsPerAttempt; // 40ms: always "times out"
  let calls = 0;
  const start = Date.now();

  const outcome = await withTimeout(
    retry(
      async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, attemptDurationMs));
        throw new Error(`attempt ${calls} timed out`);
      },
      { attempts, delays, label: 'test' }
    ),
    cappedDeadlineMs,
    [],
    'test'
  );
  const elapsedMs = Date.now() - start;

  assert.deepEqual(outcome, [], 'a fully-failing source must still resolve to [] via the cap, not hang for the full raw deadline');
  // Generous margin for scheduler jitter, but must stay far below the raw
  // (uncapped) deadline this scenario would otherwise reach.
  assert.ok(elapsedMs < cappedDeadlineMs + 50, `elapsed (${elapsedMs}ms) must stay close to the cap (${cappedDeadlineMs}ms), not the raw deadline (${rawDeadlineMs}ms)`);
  assert.ok(calls < attempts, 'the cap must prevent every attempt from running when each one fully times out');
});

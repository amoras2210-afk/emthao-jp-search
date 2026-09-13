'use strict';
// UNIT TESTS for the retry() + withTimeout() + computeOuterDeadlineMs()
// composition used by routes/search.js. No network, no browser.
//
// Context: a prior version of routes/search.js passed the SAME constant both
// as each scraper's internal per-navigation timeout AND as the outer
// withTimeout() deadline for the whole retry(...) sequence. A single attempt's
// internal timeout could then consume the entire outer deadline, so retry's
// 2nd/3rd attempts never got a chance to run. These tests use small, injected
// timings (not the real 20s production values) so they run fast, but exercise
// the exact same composition and formula as production.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { retry } = require('../../src/util/retry');
const { withTimeout } = require('../../src/util/withTimeout');
const { computeOuterDeadlineMs } = require('../../src/util/scraperTimeout');

// Stand-in for a scraper call that behaves like a real (slow but eventually
// successful) Playwright navigation: it takes close to its full per-navigation
// budget, and fails on its first N-1 attempts.
function makeSlowFlakyOperation({ perNavTimeoutMs, failUntilAttempt }) {
  let calls = 0;
  const attemptTimestamps = [];
  const fn = async () => {
    calls++;
    attemptTimestamps.push(Date.now());
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, perNavTimeoutMs - 5)));
    if (calls < failUntilAttempt) throw new Error(`transient failure #${calls}`);
    return ['item'];
  };
  return { fn, attemptTimestamps, getCalls: () => calls };
}

test('a correctly computed outer deadline lets every retry attempt run to completion', async () => {
  const perNavTimeoutMs = 30;
  const attempts = 3;
  const delays = [10, 10];
  const deadlineMs = computeOuterDeadlineMs({ navigationsPerAttempt: 1, perNavTimeoutMs, attempts, delays });

  const { fn, getCalls } = makeSlowFlakyOperation({ perNavTimeoutMs, failUntilAttempt: 3 });

  const outcome = await withTimeout(
    retry(fn, { attempts, delays, label: 'test' }),
    deadlineMs,
    [],
    'test'
  );

  assert.deepEqual(outcome, ['item']);
  assert.equal(getCalls(), 3, 'all 3 attempts must run within the computed deadline');
});

test('computeOuterDeadlineMs scales the RAW (uncapped) deadline for multi-navigation attempts (PayPay-style)', () => {
  // maxDeadlineMs is set to Infinity here to isolate the raw attempts x
  // per-attempt-timeout formula from the hard cap (see
  // test/unit/deadlineCap.test.js) — at real production scale
  // (perNavTimeoutMs=20000) the default cap flattens both of these to the
  // same ~45000ms ceiling, which is the whole point of the cap, but the raw
  // formula underneath must still scale correctly with navigation count.
  const perNavTimeoutMs = 20000;
  const maxDeadlineMs = Number.POSITIVE_INFINITY;
  const singleNavDeadline = computeOuterDeadlineMs({ navigationsPerAttempt: 1, perNavTimeoutMs, maxDeadlineMs });
  const doubleNavDeadline = computeOuterDeadlineMs({ navigationsPerAttempt: 2, perNavTimeoutMs, maxDeadlineMs });

  assert.equal(singleNavDeadline, perNavTimeoutMs * 3 + 3000);
  assert.equal(doubleNavDeadline, perNavTimeoutMs * 2 * 3 + 3000);
  assert.ok(
    doubleNavDeadline > singleNavDeadline,
    'a source needing 2 navigations per attempt (PayPay) must get a larger raw deadline'
  );
});

test('regression: an outer deadline sized for only one attempt starves every retry (the fixed bug)', async () => {
  const perNavTimeoutMs = 30;
  // This is the OLD, buggy sizing: the outer deadline equals a single
  // attempt's own internal timeout, instead of accounting for `attempts`
  // retries plus the delays between them.
  const brokenDeadlineMs = perNavTimeoutMs;

  const { fn, getCalls } = makeSlowFlakyOperation({ perNavTimeoutMs, failUntilAttempt: 3 });

  const outcome = await withTimeout(
    retry(fn, { attempts: 3, delays: [10, 10], label: 'test' }),
    brokenDeadlineMs,
    [],
    'test'
  );

  assert.deepEqual(outcome, [], 'an undersized deadline cuts the retry sequence off, falling back to []');
  assert.ok(getCalls() < 3, 'the buggy deadline must not have allowed every attempt to run');
});

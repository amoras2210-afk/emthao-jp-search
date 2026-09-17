'use strict';
// UNIT TESTS for src/util/retry.js — no network, no browser, no scrapers
// involved. See test/README.md.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { retry } = require('../../src/util/retry');

test('retry: resolves on the first attempt without retrying', async () => {
  let calls = 0;
  const result = await retry(
    async () => {
      calls++;
      return 'ok';
    },
    { attempts: 3, delays: [10, 20] }
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 1, 'fn must not be called again after a successful first attempt');
});

test('retry: retries after a failure and resolves once a later attempt succeeds', async () => {
  let calls = 0;
  const result = await retry(
    async () => {
      calls++;
      if (calls < 2) throw new Error('transient');
      return 'recovered';
    },
    { attempts: 3, delays: [10, 20] }
  );
  assert.equal(result, 'recovered');
  assert.equal(calls, 2, 'fn should have been called twice: one failure, one success');
});

test('retry: waits the configured delay between attempts', async () => {
  const timestamps = [];
  await retry(
    async () => {
      timestamps.push(Date.now());
      if (timestamps.length < 2) throw new Error('fail once');
      return 'ok';
    },
    { attempts: 3, delays: [50, 100] }
  );

  assert.equal(timestamps.length, 2);
  const gap = timestamps[1] - timestamps[0];
  // Real setTimeout is never exact; allow a small margin below the nominal delay.
  assert.ok(gap >= 45, `expected the gap between attempt 1 and 2 to be ~50ms, got ${gap}ms`);
});

test('retry: uses the last configured delay when there are more attempts than delays', async () => {
  const timestamps = [];
  await retry(
    async () => {
      timestamps.push(Date.now());
      if (timestamps.length < 3) throw new Error('fail');
      return 'ok';
    },
    { attempts: 4, delays: [10] } // only one delay for up to 3 gaps
  );

  assert.equal(timestamps.length, 3);
  const secondGap = timestamps[2] - timestamps[1];
  assert.ok(secondGap >= 8, `expected the fallback delay (~10ms) to be reused, got ${secondGap}ms`);
});

test('retry: throws the last error once every attempt is exhausted', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retry(
        async () => {
          calls++;
          throw new Error(`fail #${calls}`);
        },
        { attempts: 3, delays: [5, 5] }
      ),
    /fail #3/
  );
  assert.equal(calls, 3, 'fn must be called exactly `attempts` times before giving up');
});

// --- options.signal (AbortController-based cancellation) ---
// See src/util/withTimeout.js — when an external deadline gives up on this
// operation, it aborts the shared signal so retry() stops launching further
// attempts nobody is waiting for anymore (2026-09-17 "zombie Mercari
// attempt" incident).

test('retry: without a signal, behavior is unchanged (no signal is not an error)', async () => {
  let calls = 0;
  const result = await retry(
    async () => {
      calls++;
      return 'ok';
    },
    { attempts: 3, delays: [5, 5] }
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('retry: does not launch the next attempt once the signal is aborted between attempts', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    () =>
      retry(
        async () => {
          calls++;
          if (calls === 1) {
            // Simulate the external deadline firing while we were still
            // inside the (failed) first attempt's own cleanup.
            controller.abort();
            throw new Error('transient failure #1');
          }
          throw new Error(`attempt ${calls} should never run`);
        },
        { attempts: 3, delays: [5, 5], signal: controller.signal }
      ),
    /transient failure #1/
  );
  assert.equal(calls, 1, 'a second attempt must never be launched once the signal is aborted');
});

test('retry: does not call fn at all if the signal is already aborted before the first attempt', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    () =>
      retry(
        async () => {
          calls++;
          return 'should not happen';
        },
        { attempts: 3, delays: [5, 5], signal: controller.signal }
      )
  );
  assert.equal(calls, 0, 'fn must never be called once the signal is already aborted');
});

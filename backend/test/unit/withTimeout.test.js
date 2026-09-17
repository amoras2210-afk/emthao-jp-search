'use strict';
// UNIT TESTS for src/util/withTimeout.js — no network, no browser. See
// test/README.md. Composition with retry() is covered separately in
// test/unit/retryTimeoutBudget.test.js; this file covers withTimeout() in
// isolation, including the optional AbortController cancellation hook added
// 2026-09-17 (see routes/search.js/mercari.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { withTimeout } = require('../../src/util/withTimeout');

function neverResolves() {
  return new Promise(() => {});
}

test('withTimeout: resolves with the promise value when it wins before the deadline', async () => {
  const result = await withTimeout(Promise.resolve('value'), 50, 'fallback', 'test');
  assert.equal(result, 'value');
});

test('withTimeout: resolves with the fallback (not a rejection) when the promise throws', async () => {
  const result = await withTimeout(Promise.reject(new Error('boom')), 50, 'fallback', 'test');
  assert.equal(result, 'fallback');
});

test('withTimeout: resolves with the fallback when the timer wins — no controller (unchanged behavior)', async () => {
  const result = await withTimeout(neverResolves(), 10, 'fallback', 'test');
  assert.equal(result, 'fallback');
});

test('withTimeout: calls controller.abort() exactly once when the timer wins', async () => {
  const controller = new AbortController();
  let abortCount = 0;
  controller.signal.addEventListener('abort', () => {
    abortCount++;
  });

  const result = await withTimeout(neverResolves(), 10, 'fallback', 'test', controller);

  assert.equal(result, 'fallback', 'fallback resolution must stay identical to the no-controller case');
  assert.equal(abortCount, 1, 'controller.abort() must be called exactly once');
  assert.equal(controller.signal.aborted, true);
});

test('withTimeout: does NOT call controller.abort() when the promise wins before the deadline', async () => {
  const controller = new AbortController();
  let abortCount = 0;
  controller.signal.addEventListener('abort', () => {
    abortCount++;
  });

  const result = await withTimeout(Promise.resolve('value'), 50, 'fallback', 'test', controller);

  assert.equal(result, 'value');
  assert.equal(abortCount, 0, 'a normal success must never trigger an abort');
  assert.equal(controller.signal.aborted, false);
});

test('withTimeout: a controller whose abort() throws does not break fallback resolution', async () => {
  const controller = { abort: () => { throw new Error('abort exploded'); } };
  const result = await withTimeout(neverResolves(), 10, 'fallback', 'test', controller);
  assert.equal(result, 'fallback', 'a throwing controller.abort() must be caught, not propagated');
});

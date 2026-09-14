'use strict';
// UNIT TESTS for the requireBearerToken() middleware factory (config/searchAuth.js)
// in isolation, using fake req/res objects — no HTTP server, no network.
// See test/unit/flipradarContract.test.js for the same behavior exercised
// through a real HTTP server end-to-end.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { requireBearerToken } = require('../../src/config/searchAuth');

function fakeReq(authHeader) {
  return { get: (name) => (name.toLowerCase() === 'authorization' ? authHeader : undefined) };
}

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

test('no token configured: always calls next(), regardless of Authorization header', () => {
  const middleware = requireBearerToken('');
  let nextCalled = false;
  const res = fakeRes();
  middleware(fakeReq(undefined), res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test('token configured, no Authorization header: 401', () => {
  const middleware = requireBearerToken('secret');
  let nextCalled = false;
  const res = fakeRes();
  middleware(fakeReq(undefined), res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Unauthorized' });
});

test('token configured, wrong token: 401', () => {
  const middleware = requireBearerToken('secret');
  let nextCalled = false;
  const res = fakeRes();
  middleware(fakeReq('Bearer wrong'), res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('token configured, correct token: calls next()', () => {
  const middleware = requireBearerToken('secret');
  let nextCalled = false;
  const res = fakeRes();
  middleware(fakeReq('Bearer secret'), res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test('token configured, correct token but wrong scheme: 401', () => {
  const middleware = requireBearerToken('secret');
  let nextCalled = false;
  const res = fakeRes();
  middleware(fakeReq('Token secret'), res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

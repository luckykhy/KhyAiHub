'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRateLimiter } = require('../lib/ratelimit');

test('fixed-window limiter allows N calls and denies the next one', () => {
  let now = 0;
  const limiter = createRateLimiter({ perMinute: 2, now: () => now });
  assert.equal(limiter.check('k').allowed, true);
  assert.equal(limiter.check('k').allowed, true);
  const denied = limiter.check('k');
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfter >= 1);

  now = 61000;
  assert.equal(limiter.check('k').allowed, true, 'a new window resets the bucket');
  assert.deepEqual(limiter.snapshot(), { limit: 2, keys: 1, used: 1 });
});

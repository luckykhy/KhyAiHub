'use strict';

/**
 * jestCompat — the minimal `expect` bridge for co-located suites under `src/`.
 *
 * Three suites in `src/services/__tests__/` were written with jest's globals but
 * are executed by `node --test` (`npm run test:node:src`). Without these globals
 * each file died on its first `describe(...)` line, so `node --test` reported one
 * failed file and zero assertions — the tests had been dead, not green.
 *
 * Rewriting those suites to `node:assert` would have buried the production diff
 * in test churn, so this module supplies only the matchers they use. Anything
 * outside that surface throws instead of silently passing: a no-op matcher is
 * exactly the failure mode this file exists to remove.
 */

const assert = require('node:assert');

function show(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function expect(actual) {
  const api = {
    toBe: (expected) => assert.strictEqual(actual, expected),

    toEqual: (expected) => assert.deepStrictEqual(actual, expected),

    toBeNull: () => assert.strictEqual(actual, null),

    toBeGreaterThan: (expected) =>
      assert.ok(actual > expected, `expected ${show(actual)} > ${show(expected)}`),

    toContain: (needle) => {
      assert.ok(
        actual != null && typeof actual.includes === 'function',
        `toContain() needs a string/array, got ${show(actual)}`,
      );
      assert.ok(actual.includes(needle), `expected ${show(actual)} to contain ${show(needle)}`);
    },
  };

  api.not = {
    toThrow: () => {
      assert.strictEqual(typeof actual, 'function', 'not.toThrow() needs a function');
      let thrown = null;
      try {
        actual();
      } catch (err) {
        thrown = err;
      }
      assert.ok(!thrown, `expected no throw, got: ${thrown && thrown.message}`);
    },
  };

  return api;
}

module.exports = { expect };

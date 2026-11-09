'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('../lib/contracts');
const { newId, isValidId } = require('../lib/ids');

test('newId returns a valid, prefixed, unique id', () => {
  const a = newId('job_');
  const b = newId('job_');
  assert.match(a, /^job_/);
  assert.equal(isValidId(a), true);
  assert.equal(C.isValidId(a), true);
  assert.notEqual(a, b);
});

test('isValidId rejects short, long and unsafe ids', () => {
  assert.equal(isValidId('abcd1234'), true);
  assert.equal(isValidId('short'), false);
  assert.equal(isValidId('has space1'), false);
  assert.equal(isValidId('x'.repeat(65)), false);
});

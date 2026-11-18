'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { obtainCore } = require('./index');

test('client 出口只暴露 obtainCore（attach 专用）', () => {
  assert.strictEqual(typeof obtainCore, 'function');
});

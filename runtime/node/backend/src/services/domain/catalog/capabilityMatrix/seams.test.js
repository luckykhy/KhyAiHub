'use strict';

// 单元契约测试：seams 是能力矩阵的「注入点符号表」——它必须冻结、必须与 SEAM_ORDER/SEAM_OWNER
// 同集合、且 isSeam 不走原型链。真源判据：本目录 README / [RESEARCH-018] §2.3 功能单元。

const test = require('node:test');
const assert = require('node:assert/strict');

const { SEAMS, SEAM_ORDER, SEAM_OWNER, isSeam } = require('./seams');

test('五个接缝，全部冻结（ descriptors/composer 只能引用符号，不能塞进新位置）', () => {
  assert.deepEqual(Object.values(SEAMS), [
    'PRE_DISPATCH',
    'EMPTY_TOOLCALLS',
    'POST_TOOL_GOVERNANCE',
    'DELIVERY_GATE',
    'OUTER_RALPH',
  ]);
  for (const table of [SEAMS, SEAM_ORDER, SEAM_OWNER]) assert.equal(Object.isFrozen(table), true);
  assert.deepEqual(Object.keys(SEAM_ORDER).sort(), Object.keys(SEAM_OWNER).sort());
  assert.deepEqual(Object.keys(SEAM_ORDER).sort(), Object.values(SEAMS).slice().sort());
});

test('相位地板单调递增且间隔 100，给 descriptor 的 phase 偏移留出空间', () => {
  assert.deepEqual(Object.values(SEAM_ORDER), [0, 100, 200, 300, 400]);
});

test('SEAM_OWNER 只作观测用，值是物理宿主文件名', () => {
  for (const owner of Object.values(SEAM_OWNER)) {
    assert.match(owner, /\.js$/);
  }
});

test('isSeam：认符号、不认原型链、垃圾入参不抛', () => {
  assert.equal(isSeam('PRE_DISPATCH'), true);
  assert.equal(isSeam('NOPE'), false);
  assert.equal(isSeam('toString'), false, 'hasOwnProperty 守卫不许把原型方法当接缝');
  for (const junk of [null, undefined, 42, {}]) assert.equal(isSeam(junk), false);
});

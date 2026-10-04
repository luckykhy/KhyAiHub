'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { MATRIX, DOCTRINE, solveFloor } = require('./constraintMatrix.js');

// Constant values pinned from capabilityProbe.BANDS / riskClassifier.RISK /
// constraintStrategy.STRATEGIES (measured on current source).

test('宾客行：creative/logic 走 Prompt_Soft，irreversible 仍挂 Code_Hard', () => {
  assert.equal(solveFloor('guest', 'creative').floor, 'Prompt_Soft');
  assert.equal(solveFloor('guest', 'logic').floor, 'Prompt_Soft');
  assert.equal(solveFloor('guest', 'irreversible').floor, 'Code_Hard');
});

test('标准行：creative Prompt_Soft / logic Code_Hard / irreversible System_Block', () => {
  assert.equal(solveFloor('standard', 'creative').floor, 'Prompt_Soft');
  assert.equal(solveFloor('standard', 'logic').floor, 'Code_Hard');
  assert.equal(solveFloor('standard', 'irreversible').floor, 'System_Block');
});

test('电笼行：连 creative 也 Code_Hard，irreversible System_Block', () => {
  assert.equal(solveFloor('cage', 'creative').floor, 'Code_Hard');
  assert.equal(solveFloor('cage', 'logic').floor, 'Code_Hard');
  assert.equal(solveFloor('cage', 'irreversible').floor, 'System_Block');
});

test('solveFloor 返回形状：归一化后的 band/risk 与中文 rationale 逐字节', () => {
  assert.deepEqual(solveFloor('guest', 'creative'), {
    floor: 'Prompt_Soft',
    band: 'guest',
    riskClass: 'creative',
    doctrine: '宾客原则（释放最大自由度）',
    rationale: '宾客原则（释放最大自由度） × 风险[creative] ⇒ 约束地板 Prompt_Soft。',
  });
});

test('未知 band 归一为 cage（fail-safe 只收紧）', () => {
  const r = solveFloor('alien', 'creative');
  assert.equal(r.band, 'cage');
  assert.equal(r.riskClass, 'creative');
  assert.equal(r.floor, 'Code_Hard');
  assert.equal(r.doctrine, '高压电笼（重点关押，代码级物理阻断）');
});

test('未知 risk 归一为 irreversible（guest 也兜到 Code_Hard）', () => {
  const r = solveFloor('guest', 'alien');
  assert.equal(r.band, 'guest');
  assert.equal(r.riskClass, 'irreversible');
  assert.equal(r.floor, 'Code_Hard');
});

test('垃圾输入：null band + undefined risk 收敛到最严格 cage/irreversible', () => {
  assert.deepEqual(
    solveFloor(null, undefined),
    {
      floor: 'System_Block',
      band: 'cage',
      riskClass: 'irreversible',
      doctrine: '高压电笼（重点关押，代码级物理阻断）',
      rationale: '高压电笼（重点关押，代码级物理阻断） × 风险[irreversible] ⇒ 约束地板 System_Block。',
    },
  );
  assert.equal(solveFloor('', '').band, 'cage');
});

test('MATRIX 行与列均冻结，DOCTRINE 三档齐全', () => {
  assert.equal(Object.isFrozen(MATRIX), true);
  assert.equal(Object.isFrozen(MATRIX.guest), true);
  assert.equal(Object.isFrozen(MATRIX.cage), true);
  assert.deepEqual(DOCTRINE.guest, '宾客原则（释放最大自由度）');
  assert.deepEqual(DOCTRINE.standard, '标准管控（按风险分级）');
  assert.deepEqual(DOCTRINE.cage, '高压电笼（重点关押，代码级物理阻断）');
});

test('KNOWN-DEFECT: band="toString" 经原型链穿透，floor 为 undefined——声称的 fail-safe 只过度约束在此失效', () => {
  // constraintMatrix.js:89 — `MATRIX[band] ? band : CAGE` reads the prototype chain:
  // MATRIX['toString'] is the inherited Function (truthy), so band survives as
  // 'toString'; hasOwnProperty guard then maps risk to 'irreversible', and
  // MATRIX['toString']['irreversible'] is undefined. DOCTRINE['toString'] likewise
  // resolves to Object.prototype.toString (a Function, not a doctrine string).
  // input: solveFloor('toString', 'creative') → measured: band 'toString',
  // floor undefined, doctrine is a function — a bad input UNDER-constrains here.
  const r = solveFloor('toString', 'creative');
  assert.equal(r.band, 'toString');
  assert.equal(r.riskClass, 'irreversible');
  assert.equal(r.floor, undefined);
  assert.equal(r.doctrine, Object.prototype.toString);
});

'use strict';

// 流式思考合成 key 清空时机的源码契约测试 —— 回归锚定 2026-11-02 修复：
// 清 key 从「思考由空转非空的那一跳」搬到「由非空转空的那一跳」。
//
// 背景：React 的顺序是 render → commit → passive effect。旧实现只在**非空**那一跳
// 收 key，而 render 先于 effect，于是被中断/报错轮次残留的
// `_STREAM_THINKING_KEY` 会让下一轮的第一帧仍按展开态渲染，effect 收起后才出第二帧
// —— 用户看到思考块闪一帧（先展开再收起）。
//
// 组件依赖 inkRuntime 惰性加载，无法在 node:test 里廉价实例化，故按
// appViewportScrollKeys.test.js 的源码契约范式锚定结构。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC_ROOT = path.resolve(__dirname, '../../../../src');
const appJs = fs.readFileSync(path.join(SRC_ROOT, 'cli/tui/ink-components/App.js'), 'utf8');

function block(fromMarker, toMarker) {
  const from = appJs.indexOf(fromMarker);
  assert.ok(from > 0, `锚点 ${fromMarker} 应存在`);
  const to = appJs.indexOf(toMarker, from);
  assert.ok(to > from, `锚点 ${toMarker} 应在 ${fromMarker} 之后`);
  return appJs.slice(from, to);
}

const STICKY_BLOCK = block('// 流式思考合成 key 的清空点。', '// Ctrl+T');

test('流式思考 key 在「段已空」那一跳就收, 且收在 return 之前', () => {
  const at = STICKY_BLOCK.indexOf('if (!live) {');
  assert.ok(at > 0, '必须有 if (!live) 分支（空帧才收 key）');
  const tail = STICKY_BLOCK.slice(at);
  const clearAt = tail.indexOf('setExpandedThinking');
  const returnAt = tail.indexOf('return;');
  assert.ok(clearAt > 0, 'if (!live) 分支内必须收 key');
  assert.ok(returnAt > clearAt, '收 key 必须写在 return; 之前，否则永远走不到');
});

test('流式思考 key 的清空 effect 不用 useLayoutEffect', () => {
  // useLayoutEffect 在 commit 后、浏览器/终端绘制前同步跑，但它仍然晚于 render：
  // 那一帧已经用旧的 expandedThinking 算过投影了，救不了一帧闪现。用它会白付
  // 「阻塞绘制」的成本。渲染期派生才是根治，但那是 follow-up，不塞进最小修法。
  assert.ok(!STICKY_BLOCK.includes('useLayoutEffect'), '不得改用 useLayoutEffect');
  assert.ok(STICKY_BLOCK.includes('React.useEffect'), '必须仍是 passive effect');
});

test('流式思考 key 的清空 effect 不新增 KHY_ 门控 token', () => {
  // check-tui-gates 的门预算是全仓硬约束（实测 223/242），这块没有资格再花一个。
  assert.ok(!STICKY_BLOCK.includes('process.env.KHY_'), '不得引入 process.env.KHY_ 读取');
});

test('流式思考合成 key 仍是单一常量字符串, 未被改成 turn-scoped', () => {
  const decl = /^const _STREAM_THINKING_KEY = '([^']*)';$/m.exec(appJs);
  assert.ok(decl, '必须保持单行字符串常量声明');
  assert.equal(decl[1], '__stream__:thinking', 'key 取值不得漂移（App.js 多处硬绑这个串）');
  // 改成模板串 / turn-scoped 会同时牵动 _mainContentRecords 的 folds 写入与
  // lineClickAt 的 key 比对，超出最小修法，这里明确钉住不做。
  assert.ok(
    !appJs.includes('_STREAM_THINKING_KEY = `'),
    '不得把合成 key 改成模板字符串'
  );
});

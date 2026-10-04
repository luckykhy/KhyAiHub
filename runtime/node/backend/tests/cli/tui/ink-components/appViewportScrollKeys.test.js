'use strict';

// App.js 主视口滚动键源码契约测试 —— 回归锚定 2026-09-27 修复：块 4.8/4.9 不再
// 把裸字母 j/k/g/G/space 绑定为主视口滚动键。该分支先于文本编辑（块 5）执行且
// 不看输入框是否为空，只要消息内容超视口，输入框就打不出这些字符（用户实测
// 「g 与 k 无法正常输入」）。组件依赖 inkRuntime 惰性加载，无法在 node:test 里
// 廉价实例化，故按 ccPromptInput.test.js 的源码契约范式锚定结构。
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

test('App.js 4.8 主视口滚动: 只绑 PgUp/PgDn, 裸字母/空格不再劫持输入', () => {
  const b = block('// 4.8)', '// 4.9)');
  assert.ok(/key\.pageUp/.test(b) && /key\.pageDown/.test(b), 'PgUp/PgDn 滚动须保留');
  for (const bad of ["input === 'k'", "input === 'j'", "input === 'g'", "input === 'G'", "input === ' '"]) {
    assert.ok(!b.includes(bad), `4.8 不得再绑定裸键 ${bad}(会吞掉输入框字符)`);
  }
});

test('App.js 4.9 Preview 滚动: 只绑 PgUp/PgDn, 裸字母/空格不再劫持输入', () => {
  const b = block('// 4.9)', '// 5) Everything else');
  assert.ok(/key\.pageUp/.test(b) && /key\.pageDown/.test(b), 'PgUp/PgDn 滚动须保留');
  for (const bad of ["input === 'k'", "input === 'j'", "input === 'g'", "input === 'G'", "input === ' '"]) {
    assert.ok(!b.includes(bad), `4.9 不得再绑定裸键 ${bad}(会吞掉输入框字符)`);
  }
});

test('App.js 转录子视图(块 1b)保留 j/k/g/G/space 滚动键(独占输入, 无冲突)', () => {
  const b = block('if (transcriptOpen) {', '//    a double-press exit');
  for (const good of ["input === 'k'", "input === 'j'", "input === 'g'"]) {
    assert.ok(b.includes(good), `转录子视图须保留滚动键 ${good}`);
  }
});

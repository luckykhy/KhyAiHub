'use strict';
// 契约(轮二十六):`resume <空串/纯空白>` 是脚本事故(`resume "$SID"` 而 SID 为空),
// 必须**就地拒绝**——旧行为等同裸 resume,静默恢复「最近会话」并往其追加消息(写路径改意)。
// 裸 `resume`(arg0 缺席)保持原设计。测试走导出的 _handleResumeFlow 接缝,fake ai
// 全程零调用即证明拒绝发生在任何会话副作用之前。
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROUTER = path.resolve(__dirname, '..', '..', 'src/cli/router.js');

function freshFlow() {
  delete require.cache[require.resolve(ROUTER)];
  return require(ROUTER)._handleResumeFlow;
}

function makeSink() {
  const calls = { ok: [], info: [], err: [], warn: [] };
  const ai = {
    _touched: 0,
    resumeLastPersistedSession() {
      ai._touched += 1;
      return { success: true, title: 'fake', messageCount: 1 };
    },
    resumePersistedSession() {
      ai._touched += 1;
      return { success: false };
    },
  };
  const deps = {
    ai,
    printSuccess: (m) => calls.ok.push(String(m)),
    printInfo: (m) => calls.info.push(String(m)),
    printError: (m) => calls.err.push(String(m)),
    printWarn: (m) => calls.warn.push(String(m)),
    chalkApi: { dim: (s) => String(s), bold: (s) => String(s), white: (s) => String(s) },
  };
  return { calls, ai, deps };
}

test('arg0="" → 拒绝并报「空串」,零成功回执、fake ai 未被触碰', () => {
  const flow = freshFlow();
  const { calls, ai, deps } = makeSink();
  // r196(#82 族):✗ 分支现在会置 process.exitCode=1。本测试同进程直调接缝,
  // 不许把失败码泄漏给 node:test 子进程(否则文件级红)——断言它被置上再复原。
  const prev = process.exitCode;
  try {
    const ret = flow({ ...deps, arg0: '' });
    assert.equal(ret, true);
    assert.match(calls.err.join('\n'), /空串/);
    assert.match(calls.err.join('\n'), /history list/, '须给可执行的修复建议(Rule 2.2)');
    assert.equal(calls.ok.length, 0, '拒绝路径不得打成功回执');
    assert.equal(ai._touched, 0, '任何会话恢复副作用都不许发生');
    assert.equal(process.exitCode, 1, '✗ 拒绝必须置进程失败码,shell 才能看见');
  } finally {
    process.exitCode = prev;
  }
});

test('arg0=" "(纯空白)同罪', () => {
  const flow = freshFlow();
  const { calls, ai, deps } = makeSink();
  const prev = process.exitCode;
  try {
    flow({ ...deps, arg0: '   ' });
    assert.match(calls.err.join('\n'), /空串/);
    assert.equal(ai._touched, 0);
    assert.equal(process.exitCode, 1, '✗ 拒绝必须置进程失败码');
  } finally {
    process.exitCode = prev;
  }
});

test('裸 resume(arg0 缺席)不触发空串拒绝 —— 原「继续最近会话」设计保留', () => {
  const flow = freshFlow();
  const { calls, deps } = makeSink();
  flow({ ...deps, arg0: undefined });
  assert.doesNotMatch(calls.err.join('\n'), /空串/);
  assert.doesNotMatch(calls.warn.join('\n'), /空串/);
});

test('arg0=null 视同缺席(与既有 `||` 语义一致),不报空串', () => {
  const flow = freshFlow();
  const { calls, deps } = makeSink();
  flow({ ...deps, arg0: null });
  assert.doesNotMatch(calls.err.join('\n'), /空串/);
});

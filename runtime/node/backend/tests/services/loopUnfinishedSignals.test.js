'use strict';

/**
 * loopUnfinishedSignals.test.js — 「循环自陈没跑完」家族里两处未被别的锁覆盖的面。
 *
 * 同族锁分布（避免重复造锁）：
 *   - `_loopUnfinishedReason` / `_loopTerminalFlags` 的各出口形状 →
 *     tests/tools/AgentTool.loopUnfinished.test.js（bp-1）
 *   - 编排链软失败与 execute() 状态机 → tests/tools/AgentTool.orchestratedUnfinished.test.js（bp-2）
 *   - deliveryGate 七个信号逐个判 fail + 排除项 → tests/services/deliveryGate.test.js
 * 本文件只补两个真缺口：
 *   C. `_unfinishedErrorText`——父循环 failed 分支只渲染 error 不渲染 output，
 *      部分成果+修复建议必须写进 error，否则父智能体看不见子代理已做了什么。
 *      （该函数在全测试树零覆盖。）
 *   D. `LOOP_UNFINISHED_SIGNALS` 名单本身—— deliveryGate.test.js 的逐信号用例能抓住
 *      「删信号」，抓不住「加信号」（它遍历自己本地抄的名单）；这里钉导出的真名单，
 *      增减任一都红。
 */

const AgentTool = require('../../src/tools/AgentTool');
const { LOOP_UNFINISHED_SIGNALS } = require('../../src/services/deliveryGate');

describe('C. _unfinishedErrorText — 部分成果写进 error（父循环只渲染 error）', () => {
  test('含原因标签、进度、部分正文与修复建议', () => {
    const text = AgentTool._unfinishedErrorText('max-iterations', {
      output: '已改完 login.js 的前半部分',
      elapsed: '95s',
      toolCalls: 12,
      filesModified: ['a.js', 'b.js'],
    });
    expect(text).toContain('达到迭代上限，任务未完成');
    expect(text).toContain('已运行 95s');
    expect(text).toContain('12 次工具调用');
    expect(text).toContain('改动 2 个文件');
    expect(text).toContain('已改完 login.js 的前半部分');
    expect(text).toContain('khy gateway status');
  });

  test('超长 output 截断并标注省略量', () => {
    const long = 'x'.repeat(2500);
    const text = AgentTool._unfinishedErrorText('truncated', {
      output: long,
      elapsed: '1s',
      toolCalls: 1,
      filesModified: [],
    });
    expect(text).toContain('[部分结果已省略 500 字符]');
    expect(text).not.toContain(long);
  });

  test('无正文时给占位说明而不是空串', () => {
    const text = AgentTool._unfinishedErrorText('idle-timeout', {
      output: '   ',
      elapsed: '30s',
      toolCalls: 0,
      filesModified: [],
    });
    expect(text).toContain('（本次未产出可用正文）');
  });
});

describe('D. LOOP_UNFINISHED_SIGNALS — 导出名单逐项钉死（增减任一即红）', () => {
  test('与七个已知未完成信号逐一对应', () => {
    expect([...LOOP_UNFINISHED_SIGNALS].sort()).toEqual(
      [
        'maxIterationsReached',
        'timeLimitReached',
        'truncated',
        'consecutiveFailureBailout',
        'graceFallback',
        'budgetStopped',
        'loopDetected',
      ].sort()
    );
  });
});

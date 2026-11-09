'use strict';

/**
 * toolOutputSuccessWarning.test.js —「成功但带告警」不被两条提取链滤掉的回归锁
 * （bp-27）。
 *
 * 仓内确有 `{ success: true, error: <非空> }` 这种产出者：ccSwitch/appWriters.js
 * 的 `{ success: true, error: r.error, detail: r }`、restoreAgentService.js 的
 * `{ success: true, output: stdout, error: stderr }`（零退出码命令的 stderr）。
 * 两条成功分支提取链过去都不读 error：loop/toolOutput.js 的 `_extractToolOutput`
 * Priority 3 把 error 当噪音 continue 掉、deliveryFormatter.js 的 extractToolOutput
 * 字段表同样没有它。于是模型看到的是一个干净的成功——partial failure 的告警
 * 消失，`is_error` 还是 false。
 *
 * 本锁钉四件事：
 *   1. 两个提取器：`{success:true, error:W}`（无 payload）必须返回告警本身，
 *      不再返回 null 让消息构建器渲染成裸 "Success"；
 *   2. `{success:true, error:W, output:'...'}`（有 payload）必须把告警附在
 *      payload 之后——这个形态即使先过标准链的 normalizeToolResult 也一样丢
 *      （归一后 content 取 output，error 留在结果对象上无人再读）；
 *   3. 去重护栏：标准链会把裸 error 折进 content（_toolResultNormalizer 的
 *      Priority 4），此时告警不得被回显两遍；
 *   4. 不误伤：纯成功、error 为 null/''/false、以及 success:false 的失败路径
 *      （`[ERROR:code] message` + Hint + Retryable）逐字节保持原样。
 *
 * 谁改红了谁：把 error 从成功分支的字段表里删回去、把 `[Warning: …]` 附加逻辑
 * 去掉、或让失败路径也开始挂 warning。
 */

const leafOutput = require('../../src/services/tool/loop/toolOutput');
const { extractToolOutput, buildToolResultMessage } = require('../../src/services/deliveryFormatter');
const helpers = require('../../src/services/tool/toolUseLoopHelpers');
const { normalizeToolResult } = require('../../src/tools/_toolResultNormalizer');

const WARNING = 'partial failure: 3/12 files skipped';
// 成功 + 告警 + 空 payload（断点 prediction 的确切场景）
const SHAPE_A = { success: true, error: WARNING, data: null };
// 成功 + 告警 + 有 payload（复核确认的端到端丢失场景）
const SHAPE_B = { success: true, error: WARNING, output: '9 files edited' };

// core 加载时经 setToolUseLoopHelpersDeps 注入，这里补最小注入（与
// tests/searchFailureSignal.test.js 同方言）。
helpers.setToolUseLoopHelpersDeps({
  _extractToolOutput: leafOutput._extractToolOutput,
  _getActiveModelContextWindow: leafOutput._getActiveModelContextWindow,
});

describe('bp-27 提取链：成功态 error 告警必须存活', () => {
  test('两个提取器：只有告警没有 payload 时返回告警，不是 null', () => {
    expect(leafOutput._extractToolOutput({ ...SHAPE_A })).toBe(WARNING);
    expect(extractToolOutput({ ...SHAPE_A })).toBe(WARNING);
  });

  test('两个提取器：有 payload 时把告警附在 payload 之后', () => {
    const expected = `9 files edited\n[Warning: ${WARNING}]`;
    expect(leafOutput._extractToolOutput({ ...SHAPE_B })).toBe(expected);
    expect(extractToolOutput({ ...SHAPE_B })).toBe(expected);
  });

  test('过标准链（normalizeToolResult）后两个形态都仍然带告警', () => {
    // 归一把裸 error 折进 content（Priority 4）时告警本就可见；有 payload 时
    // content 取 output，告警过去正是死在这里。
    expect(leafOutput._extractToolOutput(normalizeToolResult({ ...SHAPE_A }))).toBe(WARNING);
    expect(leafOutput._extractToolOutput(normalizeToolResult({ ...SHAPE_B }))).toBe(
      `9 files edited\n[Warning: ${WARNING}]`
    );
    expect(extractToolOutput(normalizeToolResult({ ...SHAPE_B }))).toBe(
      `9 files edited\n[Warning: ${WARNING}]`
    );
  });

  test('去重护栏：content 已等于告警原文时不得回显两遍', () => {
    // 标准链 shape A：normalizeToolResult 的 Priority 4 已把 error 折进 content，
    // 提取器若再附一次 warning，模型会看到同一句告警两次。
    for (const extract of [leafOutput._extractToolOutput, extractToolOutput]) {
      const text = String(extract(normalizeToolResult({ ...SHAPE_A })));
      expect(text).toBe(WARNING);
      expect(text.match(/partial failure/g)).toHaveLength(1);
    }
  });

  test('error 是对象时取 message', () => {
    const result = { success: true, error: { message: 'stderr: deprecation notice' }, output: 'ok' };
    expect(leafOutput._extractToolOutput({ ...result })).toBe('ok\n[Warning: stderr: deprecation notice]');
    expect(extractToolOutput({ ...result })).toBe('ok\n[Warning: stderr: deprecation notice]');
  });
});

describe('bp-27 端到端：两条 _buildToolResultMessage 都把告警带给模型', () => {
  const drive = (builder, result) => {
    const msg = builder([{ tool: 'edit', result, _toolUseId: 'tu_1' }]);
    const entry = (msg.structuredToolResults || []).find((e) => e.tool === 'edit') || {};
    return { content: String(entry.content), isError: entry.is_error, text: msg.text };
  };

  for (const [name, builder] of [
    ['deliveryFormatter.buildToolResultMessage', buildToolResultMessage],
    ['toolUseLoopHelpers._buildToolResultMessage', helpers._buildToolResultMessage],
  ]) {
    describe(name, () => {
      test('成功 + 告警（无 payload）→ 模型看到告警，不是裸 Success', () => {
        const { content, isError, text } = drive(builder, { ...SHAPE_A });
        expect(content).toBe(WARNING);
        expect(isError).toBe(false); // 有结果就不是错误，不翻 is_error
        expect(text).toContain(WARNING);
      });

      test('成功 + 告警 + payload → 模型同时看到两者', () => {
        const { content, isError } = drive(builder, { ...SHAPE_B });
        expect(content).toBe(`9 files edited\n[Warning: ${WARNING}]`);
        expect(isError).toBe(false);
      });

      test('纯成功结果逐字节不变', () => {
        const { content, isError } = drive(builder, { success: true, output: '9 files edited' });
        expect(content).toBe('9 files edited');
        expect(isError).toBe(false);
      });

      test('error 为 null/空串/false 时不挂 warning', () => {
        for (const error of [null, '', false, undefined]) {
          const { content } = drive(builder, { success: true, output: 'ok', error });
          expect(content).toBe('ok');
        }
      });

      test('失败路径原样：[ERROR:code] + Hint + Retryable，且不挂 warning', () => {
        const { content, isError } = drive(builder, {
          success: false,
          error: { code: 'TIMEOUT', message: 'Command timed out after 30s', hint: 'Try a shorter command', retryable: true },
        });
        expect(content).toBe(
          '[ERROR:TIMEOUT] Command timed out after 30s\nHint: Try a shorter command\nRetryable: yes'
        );
        expect(isError).toBe(true);
        expect(content).not.toContain('[Warning:');
      });
    });
  }
});

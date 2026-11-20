/**
 * Unit tests for the tool_use / tool_result event mappings that drive the
 * inline tool-call flow and the digital-human status orb. Zero deps — run with
 * the built-in Node test runner (apps/ai-frontend is type:module):
 *   npx vitest run src/views/aiChatEventUtils.toolEvents.test.js
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  describeToolEvent,
  resolveAiChatThinkingEvent,
  mapEventToOrbState,
  formatToolParams,
  maskSecretsForDisplay,
  summarizeToolProgress,
  toolResultOutcome,
  settleOrphanSteps,
} from './aiChatEventUtils.js';

test('describeToolEvent maps a tool_use to a 工具调用 status log', () => {
  const ev = describeToolEvent({ type: 'tool_use', tool: 'web_search' });
  assert.equal(ev.type, 'status');
  assert.match(ev.text, /工具调用：web_search/);
});

test('describeToolEvent maps a successful tool_result to a status log with detail', () => {
  const ev = describeToolEvent({
    type: 'tool_result',
    tool: 'read_file',
    success: true,
    text: 'ok 12 lines',
  });
  assert.equal(ev.type, 'status');
  assert.match(ev.text, /工具结果：read_file 完成/);
  assert.match(ev.text, /ok 12 lines/);
});

test('describeToolEvent maps a failed tool_result to an error log', () => {
  const ev = describeToolEvent({
    type: 'tool_result',
    tool: 'run_cmd',
    success: false,
    text: 'denied',
  });
  assert.equal(ev.type, 'error');
  assert.match(ev.text, /工具结果：run_cmd 失败/);
});

test('describeToolEvent renders the _system_retry pseudo-tool as a clean status (no leaked name)', () => {
  // The backend pushes the network-fluctuation retry notice through the
  // tool_result channel with tool="_system_retry". It must NOT read
  // "工具结果：_system_retry 完成" — just the human status text.
  const ev = describeToolEvent({
    type: 'tool_result',
    tool: '_system_retry',
    success: true,
    text: '回复为空，疑似网络波动，正在重试（1/2）…',
  });
  assert.equal(ev.type, 'status');
  assert.match(ev.text, /正在重试（1\/2）/);
  assert.doesNotMatch(ev.text, /_system_retry/);
  assert.doesNotMatch(ev.text, /工具结果/);
});

test('describeToolEvent falls back to a label for an internal pseudo-tool with no detail', () => {
  const ev = describeToolEvent({ type: 'tool_result', tool: '_system_summarize', success: true });
  assert.equal(ev.type, 'status');
  assert.equal(ev.text, '正在生成总结…');
  assert.doesNotMatch(ev.text, /_system/);
});

test('describeToolEvent never marks an internal pseudo-tool as 失败 even when success=false', () => {
  // A pseudo-tool is a status carrier, not a tool that can "fail".
  const ev = describeToolEvent({
    type: 'tool_result',
    tool: '_task_notification',
    success: false,
    text: '后台任务已完成',
  });
  assert.equal(ev.type, 'status');
  assert.match(ev.text, /后台任务已完成/);
  assert.doesNotMatch(ev.text, /失败/);
});

test('describeToolEvent returns null for non-tool events', () => {
  assert.equal(describeToolEvent({ type: 'text' }), null);
  assert.equal(describeToolEvent({}), null);
});

test('describeToolEvent falls back to a generic tool name', () => {
  const ev = describeToolEvent({ type: 'tool_use' });
  assert.match(ev.text, /工具调用：tool/);
});

test('resolveAiChatThinkingEvent stream surfaces tool_use / tool_result / thinking', () => {
  assert.match(
    resolveAiChatThinkingEvent('stream', { type: 'tool_use', tool: 'grep' }).text,
    /工具调用：grep/
  );
  assert.equal(
    resolveAiChatThinkingEvent('stream', { type: 'tool_result', tool: 'grep', success: false })
      .type,
    'error'
  );
  assert.match(
    resolveAiChatThinkingEvent('stream', { type: 'thinking', text: '推理中' }).text,
    /推理中/
  );
});

test('resolveAiChatThinkingEvent ws surfaces tool_use / tool_result', () => {
  assert.match(
    resolveAiChatThinkingEvent('ws', { type: 'tool_use', tool: 'ls' }).text,
    /工具调用：ls/
  );
  assert.equal(
    resolveAiChatThinkingEvent('ws', { type: 'tool_result', tool: 'ls', success: true }).type,
    'status'
  );
});

test('mapEventToOrbState puts tool events into the thinking state on both transports', () => {
  assert.equal(mapEventToOrbState('stream', { type: 'tool_use' }), 'thinking');
  assert.equal(mapEventToOrbState('stream', { type: 'tool_result' }), 'thinking');
  assert.equal(mapEventToOrbState('ws', { type: 'tool_use' }), 'thinking');
  assert.equal(mapEventToOrbState('ws', { type: 'tool_result' }), 'thinking');
});

test('reset event maps to thinking orb state and a status log on both transports', () => {
  // 响应防抖抗拼接：丢弃废稿后回到 thinking 态，并给一条状态日志。
  assert.equal(mapEventToOrbState('stream', { type: 'reset' }), 'thinking');
  assert.equal(mapEventToOrbState('ws', { type: 'reset' }), 'thinking');
  const sLog = resolveAiChatThinkingEvent('stream', {
    type: 'reset',
    reason: 'bare-refusal-retry',
  });
  assert.equal(sLog.type, 'status');
  assert.match(sLog.text, /丢弃废稿并重试/);
  const wLog = resolveAiChatThinkingEvent('ws', { type: 'reset', reason: 'bare-refusal-retry' });
  assert.equal(wLog.type, 'status');
  assert.match(wLog.text, /丢弃废稿并重试/);
});

// ── #7 工具调用透明化：可展开卡片显示完整参数（非 120 字截断）───────────────

test('formatToolParams pretty-prints a full object (no 120-char truncation)', () => {
  const input = {
    path: '/home/user/project/src/services/aVeryLongModuleName/deeplyNestedFile.js',
    pattern: 'someVeryLongSearchPatternThatWouldExceedTheOldChipPreviewLimit',
    options: { recursive: true, caseInsensitive: false, maxResults: 200 },
  };
  const out = formatToolParams(input);
  // Whole content preserved, not clipped to 120 chars.
  assert.ok(out.length > 120);
  assert.match(out, /deeplyNestedFile\.js/);
  assert.match(out, /someVeryLongSearchPattern/);
  assert.match(out, /maxResults/);
  // Pretty-printed (indented multi-line), not a single JSON blob line.
  assert.match(out, /\n/);
});

test('formatToolParams passes a string through, trimmed', () => {
  assert.equal(formatToolParams('  ls -la /tmp  '), 'ls -la /tmp');
});

test('formatToolParams returns empty string for nullish / empty input', () => {
  assert.equal(formatToolParams(null), '');
  assert.equal(formatToolParams(undefined), '');
  assert.equal(formatToolParams(''), '');
  assert.equal(formatToolParams('   '), '');
  assert.equal(formatToolParams({}), '{}');
});

test('formatToolParams caps output at maxChars with a truncation note', () => {
  const big = 'x'.repeat(500);
  const out = formatToolParams(big, { maxChars: 100 });
  assert.ok(out.length < 200);
  assert.match(out, /已截断，共 500 字符/);
  assert.ok(out.startsWith('x'.repeat(100)));
});

test('formatToolParams masks credential-looking values (never leaks a full key)', () => {
  const out = formatToolParams({
    provider: 'openai',
    apiKey: 'sk-examplekey12345',
    model: 'gpt',
  });
  assert.doesNotMatch(out, /examplekey12345/);
  assert.match(out, /\*\*\*/);
  // Non-secret fields survive intact.
  assert.match(out, /openai/);
  assert.match(out, /gpt/);
});

test('maskSecretsForDisplay masks sk- literals embedded in a plain string', () => {
  const masked = maskSecretsForDisplay('use key sk-ABCDEFGH1234 for auth');
  assert.doesNotMatch(masked, /sk-ABCDEFGH1234/);
  assert.match(masked, /sk-\*\*\*1234/);
});

test('maskSecretsForDisplay recurses into arrays and nested objects without mutating input', () => {
  const input = { creds: [{ token: 'topsecretvalue99' }], keep: 'visible' };
  const out = maskSecretsForDisplay(input);
  assert.equal(input.creds[0].token, 'topsecretvalue99', 'original not mutated');
  assert.doesNotMatch(JSON.stringify(out), /topsecretvalue99/);
  assert.match(out.creds[0].token, /\*\*\*ue99/);
  assert.equal(out.keep, 'visible');
});

test('formatToolParams never throws on a circular structure', () => {
  const a = {};
  a.self = a;
  assert.doesNotThrow(() => formatToolParams(a));
});

// ── #6 一眼看清进度：从 steps 派生 at-a-glance 进度摘要 ─────────────────────

test('summarizeToolProgress returns null when there are no steps', () => {
  assert.equal(summarizeToolProgress([]), null);
  assert.equal(summarizeToolProgress(null), null);
  assert.equal(summarizeToolProgress(undefined), null);
});

test('summarizeToolProgress counts a run in progress (分段计数 + running)', () => {
  const p = summarizeToolProgress([{ status: 'ok' }, { status: 'ok' }, { status: 'running' }]);
  assert.equal(p.total, 3);
  assert.equal(p.done, 2);
  assert.equal(p.running, 1);
  assert.equal(p.failed, 0);
  assert.equal(p.active, true);
  // 刻意不写 done/total：total 会随新步骤到达而变大，分数读数会倒退。
  assert.equal(p.label, '已完成 2 个 · 1 个进行中');
});

test('summarizeToolProgress marks a fully settled run as inactive', () => {
  const p = summarizeToolProgress([{ status: 'ok' }, { status: 'ok' }]);
  assert.equal(p.done, 2);
  assert.equal(p.running, 0);
  assert.equal(p.active, false);
  assert.equal(p.label, '已完成 2 个');
});

test('summarizeToolProgress surfaces failures in the label and counts them apart from done', () => {
  const p = summarizeToolProgress([{ status: 'ok' }, { status: 'error' }, { status: 'running' }]);
  assert.equal(p.total, 3);
  assert.equal(p.done, 1); // 「已完成」只数 ok，失败另计 —— 两者混在一起会虚报完成数
  assert.equal(p.failed, 1);
  assert.equal(p.running, 1);
  assert.match(p.label, /1 个失败/);
  assert.match(p.label, /1 个进行中/);
});

test('summarizeToolProgress keeps the reading monotonic as steps arrive', () => {
  // total 是「已到达步骤数」，会变大；分数读数会从 1/1 退回 1/2 再到 2/3。
  const at = (n) => summarizeToolProgress(Array.from({ length: n }, (_, i) => ({ status: 'ok' })));
  assert.equal(at(1).label, '已完成 1 个');
  assert.equal(at(2).label, '已完成 2 个');
  assert.equal(at(5).label, '已完成 5 个');
});

test('summarizeToolProgress counts unknown steps as their own bucket, not as done', () => {
  const p = summarizeToolProgress([
    { status: 'ok' },
    { status: 'unknown' },
    { status: 'error' },
  ]);
  assert.equal(p.done, 1);
  assert.equal(p.unknown, 1);
  assert.equal(p.failed, 1);
  assert.equal(p.active, false);
  assert.equal(p.label, '已完成 1 个 · 1 个失败 · 1 个结果未返回');
});

test('summarizeToolProgress ignores malformed entries without throwing', () => {
  assert.doesNotThrow(() => summarizeToolProgress([null, 42, 'x', { status: 'ok' }]));
  const p = summarizeToolProgress([null, 42, { status: 'ok' }]);
  assert.equal(p.total, 1);
  assert.equal(p.done, 1);
});

// ── 结果三态：缺 success 就是「未返回」，不是「完成」 ─────────────────────────

test('toolResultOutcome only trusts an explicit boolean', () => {
  assert.equal(toolResultOutcome({ success: true }), 'ok');
  assert.equal(toolResultOutcome({ success: false }), 'error');
  // 旧写法 success !== false 会把这三种全判成成功。
  assert.equal(toolResultOutcome({}), 'unknown');
  assert.equal(toolResultOutcome({ success: undefined }), 'unknown');
  assert.equal(toolResultOutcome({ success: 'true' }), 'unknown'); // 真值不是 true
});

test('describeToolEvent renders a result without success as unknown, never as 完成', () => {
  const ev = describeToolEvent({ type: 'tool_result', tool: 'web_search', text: '' });
  assert.equal(ev.type, 'status'); // 不是 error：没有被证伪过
  assert.match(ev.text, /结果未返回/);
  assert.doesNotMatch(ev.text, /完成/);
});

// ── 孤儿步骤收口 ────────────────────────────────────────────────────────────

test('settleOrphanSteps settles only the still-running steps and stamps the duration', () => {
  const steps = [
    { tool: 'a', status: 'ok', startedAt: 1000 },
    { tool: 'b', status: 'running', startedAt: 1000 },
    { tool: 'c', status: 'running', startedAt: 4000 },
  ];
  const n = settleOrphanSteps(steps, '结果未返回（可能因中断/超时）', 6000);
  assert.equal(n, 2);
  assert.equal(steps[0].status, 'ok'); // 已定的步骤不碰
  assert.equal(steps[1].status, 'unknown');
  assert.equal(steps[1].endedAt, 6000);
  assert.equal(steps[1].durationMs, 5000); // 从发出起算，不是从收到结果起算
  assert.match(steps[1].note, /可能因中断\/超时/);
  assert.equal(steps[2].durationMs, 2000);
});

test('settleOrphanSteps is idempotent — a second pass settles nothing', () => {
  const steps = [{ status: 'running', startedAt: 0 }];
  assert.equal(settleOrphanSteps(steps, undefined, 1000), 1);
  assert.equal(settleOrphanSteps(steps, undefined, 2000), 0);
  assert.equal(steps[0].durationMs, 1000); // 收口时间不会被第二次调用改写
  assert.equal(steps[0].endedAt, 1000);
});

test('settleOrphanSteps leaves durationMs null when the step never started', () => {
  const steps = [{ status: 'running' }];
  settleOrphanSteps(steps, undefined, 5000);
  assert.equal(steps[0].status, 'unknown');
  assert.equal(steps[0].durationMs, null);
});

test('settleOrphanSteps does not throw on malformed input', () => {
  assert.doesNotThrow(() => settleOrphanSteps([null, 42, 'x'], undefined, 1));
  assert.equal(settleOrphanSteps(null), 0);
  assert.equal(settleOrphanSteps(undefined), 0);
});

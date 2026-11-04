'use strict';

/**
 * toolUseLoop.nonStreamedFinalText.test.js — a non-streaming adapter that ran
 * tools used to leave the final answer outside the chunk stream: the consumer
 * only saw the pre-tool narration + tool cards, while the answer lived solely
 * in `finalResponse` (session eca57528: `_timeline` had 38 chars + 3 tools,
 * `content` had the full 3480). TUI/desktop rebuild the transcript from
 * chunks, so the answer silently disappeared on screen and reappeared only
 * after `khy resume` replayed the persisted content.
 *
 * The fix re-emits the finished `finalText` as one text chunk, gated on
 * "tools actually ran && nothing streamed this turn". The no-tool path is
 * untouched (consumer already falls back to `result.reply`).
 */

const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.KHY_TASK_CAPABILITY_GATE = 'false';
process.env.KHY_EXEC_APPROVAL = 'off';

const toolCalling = require('../src/services/toolCalling');
const toolUseLoop = require('../src/services/toolUseLoop');

const PREAMBLE = '好的，这就开始。\n先查一下今天的外部资料，补齐再回来。\n';
const ANSWER =
  '交叉核验完成。\n\n' +
  '## 今日要闻（2026-11-04）\n' +
  '- 美国中期选举投票结束，民主党赢得众议院控制权。\n' +
  '- 俄乌宣布临时停火及大规模换俘计划。\n\n' +
  '以上两条均已由两路以上来源交叉核验。';

const countOf = (haystack, needle) => haystack.split(needle).length - 1;

describe('toolUseLoop — non-streamed final answer after tool rounds must reach onChunk', () => {
  let _origExecute;
  let _saved;

  before(() => {
    _saved = {
      gate: process.env.KHY_TASK_CAPABILITY_GATE,
      appr: process.env.KHY_EXEC_APPROVAL,
      delay: process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS,
    };
    process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS = '1';
  });

  after(() => {
    const restore = (k, v) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore('KHY_TASK_CAPABILITY_GATE', _saved.gate);
    restore('KHY_EXEC_APPROVAL', _saved.appr);
    restore('KHY_TOOL_LOOP_RECOVERY_DELAY_MS', _saved.delay);
  });

  beforeEach(() => {
    _origExecute = toolCalling.executeTool;
  });
  afterEach(() => {
    toolCalling.executeTool = _origExecute;
  });

  test('tool round + one-shot final reply → answer arrives as text exactly once', async () => {
    toolCalling.executeTool = async () => ({ success: true, content: '搜索结果：两条主线。' });

    let calls = 0;
    const chat = async (_msg, opts = {}) => {
      calls += 1;
      if (opts._forceNoTools === true || calls > 1) {
        return { reply: ANSWER, stopReason: 'stop', provider: 'mock', model: 'mock' };
      }
      return {
        reply: PREAMBLE,
        toolUseBlocks: [
          { type: 'tool_use', id: 't1', name: 'web_search', input: { query: '今天有些什么新闻？' } },
        ],
        stopReason: 'tool_use',
        provider: 'mock',
        model: 'mock',
      };
    };

    const chunks = [];
    const result = await toolUseLoop.runToolUseLoop('今天有些什么新闻？', {
      chat,
      maxIterations: 6,
      chatOpts: { onChunk: (c) => chunks.push(c) },
    });

    const streamed = chunks
      .filter((c) => c && c.type === 'text' && c.text)
      .map((c) => c.text)
      .join('');

    assert.ok(result.iterations > 1, 'the tool round must have run');
    assert.ok(streamed.includes(PREAMBLE.trim()), 'pre-tool narration still streams');
    assert.ok(streamed.includes('## 今日要闻（2026-11-04）'), 'final answer must be in the chunk stream');
    assert.equal(countOf(streamed, '## 今日要闻（2026-11-04）'), 1, 'answer is emitted exactly once');
    assert.ok(
      streamed.endsWith(String(result.finalResponse || '')),
      'consumers that only see chunks end up with the same text as finalResponse (tail included)'
    );
  });

  test('streaming adapter → answer is not re-emitted a second time', async () => {
    toolCalling.executeTool = async () => ({ success: true, content: 'ok' });

    let calls = 0;
    const chat = async (_msg, opts = {}) => {
      calls += 1;
      const reply = calls === 1 ? `${PREAMBLE}\n<tool_call>{"name":"web_search"}</tool_call>` : ANSWER;
      if (calls === 1) {
        return {
          reply: PREAMBLE,
          toolUseBlocks: [
            { type: 'tool_use', id: 't1', name: 'web_search', input: { query: '新闻' } },
          ],
          stopReason: 'tool_use',
          provider: 'mock',
          model: 'mock',
        };
      }
      if (typeof opts.onChunk === 'function') {
        opts.onChunk({ type: 'text', text: reply });
      }
      return { reply, stopReason: 'stop', provider: 'mock', model: 'mock' };
    };

    const chunks = [];
    const result = await toolUseLoop.runToolUseLoop('今天有些什么新闻？', {
      chat,
      maxIterations: 6,
      chatOpts: { onChunk: (c) => chunks.push(c) },
    });

    const streamed = chunks
      .filter((c) => c && c.type === 'text' && c.text)
      .map((c) => c.text)
      .join('');

    assert.equal(countOf(streamed, '## 今日要闻（2026-11-04）'), 1, 'streamed answer must not double');
    assert.ok(String(result.finalResponse || '').includes('## 今日要闻（2026-11-04）'));
  });

  test('no tool calls → no synthetic text chunk (consumer reply fallback stays byte-identical)', async () => {
    const chat = async () => ({ reply: ANSWER, stopReason: 'stop', provider: 'mock', model: 'mock' });

    const chunks = [];
    await toolUseLoop.runToolUseLoop('打个招呼', {
      chat,
      maxIterations: 3,
      chatOpts: { onChunk: (c) => chunks.push(c) },
    });

    const textChunks = chunks.filter((c) => c && c.type === 'text' && c.text);
    assert.equal(textChunks.length, 0, 'single-shot non-streaming replies keep the legacy fallback');
  });
});

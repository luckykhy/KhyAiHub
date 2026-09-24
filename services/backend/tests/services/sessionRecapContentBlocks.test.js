'use strict';

// khy recap 曾对任何带工具调用的会话必崩：buildConversationChain 返回的 content
// 是内容块数组（[{type:'text'|'tool_use'|'tool_result'}]），而抽取器一律按字符串
// 处理（.split/.matchAll）→ `text.split is not a function`。现于 generateRecap
// 入口把 content 归一化为纯文本，两种形态都不再抛。

process.env.NO_COLOR = '1';
process.env.FORCE_COLOR = '0';

const assert = require('assert');

let _describe = global.describe;
let _test = global.test || global.it;
let _expect = global.expect;
if (typeof _describe !== 'function' || typeof _expect !== 'function') {
  const assert = require('assert');
  const nt = require('node:test');
  _describe = (n, fn) => nt.describe(n, fn);
  _test = (n, fn) => nt.test(n, fn);
  _expect = (actual) => ({
    toBe: (e) => assert.strictEqual(actual, e),
    toEqual: (e) => assert.deepStrictEqual(actual, e),
    toContain: (s) => assert.ok(String(actual).includes(s), `expected to contain: ${s}`),
    toBeUndefined: () => assert.ok(actual === undefined, `expected undefined, got ${actual}`),
  });
}

const { generateRecap } = require('../../src/services/sessionRecapService');
const { formatRecap } = require('../../src/services/sessionRecapService');

_describe('generateRecap content-block normalization', () => {
  _test('tool_result-only array content does NOT throw (was: text.split is not a function)', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'x', content: '{"a":1,"path":"/src/foo.js","cmd":"npm run build"}' },
        ],
      },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
    ];
    const recap = generateRecap(messages);
    // 机器 I/O 不该被当作人读散文抽取 → 无主题、无文件引用噪音。
    _expect(recap.turns).toBe(1);
    _expect(recap.sections.topics).toEqual([]);
  });

  _test('text blocks inside an array content are still extracted (anti-vacuity)', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Please refactor the authentication module for clarity' },
          { type: 'tool_result', tool_use_id: 'x', content: '{"ignored":true}' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: "I'll rewrite the auth middleware to use JWT" }] },
    ];
    const recap = generateRecap(messages);
    _expect(recap.sections.topics.length).toBe(1);
    _expect(recap.sections.topics[0]).toContain('refactor the authentication');
    _expect(recap.sections.decisions.join(' ')).toContain('rewrite the auth middleware');
  });

  _test('plain string content behavior is preserved', () => {
    const messages = [
      { role: 'user', content: 'Fix the login page flicker' },
      { role: 'assistant', content: 'I will fix the login page flicker.' },
    ];
    const recap = generateRecap(messages);
    _expect(recap.turns).toBe(1);
    _expect(recap.sections.topics[0]).toContain('Fix the login page flicker');
  });
});

// formatRecap / _buildSummary 直接把段标题与摘要句打印到用户终端，AGENTS.md
// 「面向用户的字符串：中文」要求它们是中文。此前全是硬编码英文。toProtocolMessage
// 仅转发原始 recap 对象（段标题不在对象里）、无 live 消费方，故非 SDK 契约。
_describe('formatRecap user-facing strings are localized (中文)', () => {
  const msgs = [
    { role: 'user', content: 'refactor the authentication module to use JWT' },
    { role: 'assistant', content: 'I will rewrite the auth middleware. Files: src/auth.js src/jwt.js' },
    { role: 'user', content: 'also run npm test to check and run npm run build' },
  ];
  // commandsRun 由 context 提供（非从消息文本抽取），给一条以驱动「执行命令：」段。
  const out = formatRecap(generateRecap(msgs, { commandsRun: ['npm run build'] }));

  _test('section headers render in Chinese', () => {
    for (const h of ['会话回顾', '主题：', '关键决策：', '改动文件：', '执行命令：']) {
      _expect(out).toContain(h);
    }
  });

  _test('summary sentence is Chinese (no English frame)', () => {
    _expect(out).toContain('轮对话');
    _expect(out).toContain('讨论了');
  });

  _test('the old English tokens are gone (anti-regression)', () => {
    for (const bad of ['Session Recap', 'Topics:', 'Key Decisions:', 'Files Changed:', 'Commands Run:', '-turn conversation.', 'Discussed ', 'touched ']) {
      assert.ok(!out.includes(bad), `expected NOT to contain English token: ${bad}`);
    }
  });
});


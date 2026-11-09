'use strict';

// transcriptTools.test.cjs — 存档里的工具过程配对契约。
//
// 用户报障：重开旧会话只看得到一问一答，看不到当时的工具过程。存档本身没丢：
// 后端 JSONL 里 assistant 的 tool_use 与工具轮的 tool_result 都在，丢的是
// host 的 session.messages 映射（只拍平成正文）。本文件钉住配对规则：
//   (a) tool_use 按 id 配到 tool_result，成功带上结果文本；
//   (b) is_error → 失败并带上错误文本；结果块在后续任意 user 轮都能配上；
//   (c) 没有结果的调用标成 cancelled，不假装成功；
//   (d) 结果块 content 是块数组时也拍平；非 assistant 轮不产出调用。

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');

const modulePath = join(__dirname, '..', 'src', 'host', 'transcriptTools.ts');

function loadCjs(src) {
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('exports', 'module', 'require', js)(module.exports, module, require);
  return module.exports;
}

const { collectToolCalls } = loadCjs(readFileSync(modulePath, 'utf-8').replace(/^﻿/, ''));

const textBlock = (text) => ({ type: 'text', text });

test('tool_use 按 id 配到 tool_result：成功带结果，只挂在发起它的那条消息上', () => {
  const messages = [
    { role: 'user', content: '今天有些什么新闻' },
    {
      role: 'assistant',
      content: [
        textBlock('[模型请求执行工具: webSearch]'),
        { type: 'tool_use', id: 'call_1', name: 'webSearch', input: { query: '新闻', freshness: 'day' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: '{"success":true,"results":[]}' },
        textBlock('[SYSTEM: Tool results above. Continue the task]'),
      ],
    },
    { role: 'assistant', content: '今天的主要新闻如下' },
  ];

  const calls = collectToolCalls(messages);
  assert.deepEqual([...calls.keys()], [1], '只有发起 tool_use 的 assistant 轮带调用');
  assert.equal(calls.get(1).length, 1);
  assert.equal(calls.get(1)[0].name, 'webSearch');
  assert.deepEqual(calls.get(1)[0].input, { query: '新闻', freshness: 'day' });
  assert.equal(calls.get(1)[0].status, 'success');
  assert.equal(calls.get(1)[0].result, '{"success":true,"results":[]}');
  assert.equal(calls.get(1)[0].error, undefined);
});

test('is_error 的结果标成失败，错误文本进 error 而不是 result', () => {
  const calls = collectToolCalls([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.ts' } }] },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ENOENT: no such file', is_error: true }],
    },
  ]);

  assert.equal(calls.get(0)[0].status, 'error');
  assert.equal(calls.get(0)[0].error, 'ENOENT: no such file');
  assert.equal(calls.get(0)[0].result, undefined);
});

test('同一轮的多个调用只要有结果就各自配对；结果在更靠后的 user 轮也能找到', () => {
  const calls = collectToolCalls([
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'a', name: 'bash', input: { command: 'ls' } },
        { type: 'tool_use', id: 'b', name: 'grep', input: { pattern: 'main' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
    { role: 'assistant', content: '继续' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'main.ts' }] },
  ]);

  const [bash, grep] = calls.get(0);
  assert.equal(bash.name, 'bash');
  assert.equal(bash.result, 'ok');
  assert.equal(grep.name, 'grep');
  assert.equal(grep.result, 'main.ts');
});

test('没有结果的调用标成 cancelled：中断的会话不假装成功', () => {
  const calls = collectToolCalls([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'webSearch', input: { query: 'x' } }] },
  ]);

  assert.equal(calls.get(0)[0].status, 'cancelled');
  assert.equal(calls.get(0)[0].result, undefined);
  assert.equal(calls.get(0)[0].error, undefined);
});

test('结果块 content 是块数组时拍平成文本', () => {
  const calls = collectToolCalls([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read_file', input: {} }] },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'c1',
          content: [textBlock('第一段'), textBlock('第二段')],
        },
      ],
    },
  ]);

  assert.equal(calls.get(0)[0].result, '第一段第二段');
});

test('纯文本存档（老会话 / JSON 快照）不产出任何调用', () => {
  const calls = collectToolCalls([
    { role: 'user', content: '纯问候' },
    { role: 'assistant', content: '你好' },
  ]);
  assert.equal(calls.size, 0);
});

test('工具块挂错角色也不认：user 轮里的 tool_use 不产出调用', () => {
  const calls = collectToolCalls([
    { role: 'user', content: [{ type: 'tool_use', id: 'c1', name: 'webSearch', input: {} }] },
  ]);
  assert.equal(calls.size, 0);
});

// ── 旧一代存档：工具轮是纯文本，结果只在 `[tool_use_id=…]` 标记后面 ──

test('纯文本结果按 [tool_use_id=] 回填，不把有结果的调用误判成已取消', () => {
  const calls = collectToolCalls([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_db', name: 'Read', input: { file_path: 'a.js' } }] },
    {
      role: 'user',
      content: '[Tool execution results]\nTool: readFile [tool_use_id=call_db]\nResult: 1 const x = 1\n',
    },
  ]);

  assert.equal(calls.get(0)[0].status, 'success');
  assert.equal(calls.get(0)[0].result, '1 const x = 1', '去掉 Result: 前缀，只留工具输出');
});

test('一条纯文本消息里的多个结果各归各的调用', () => {
  const calls = collectToolCalls([
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'a', name: 'bash', input: {} },
        { type: 'tool_use', id: 'b', name: 'grep', input: {} },
      ],
    },
    {
      role: 'user',
      content: '[Tool execution results]\nTool: shell [tool_use_id=a]\nResult: ok\nTool: grep [tool_use_id=b]\nResult: main.ts',
    },
  ]);

  assert.equal(calls.get(0)[0].result, 'ok');
  assert.equal(calls.get(0)[1].result, 'main.ts');
});

test('纯文本里 [ERROR:CANCELLED] 判已取消，SKIPPED 判失败', () => {
  const calls = collectToolCalls([
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'esc', name: 'readFile', input: {} },
        { type: 'tool_use', id: 'skip', name: 'shell_command', input: {} },
      ],
    },
    {
      role: 'user',
      content:
        '[Tool execution results]\nTool: readFile [tool_use_id=esc]\n[ERROR:CANCELLED] 工具 readFile 已被用户中断(ESC)\n' +
        'Tool: shell_command [tool_use_id=skip] (SKIPPED — identical call already failed.)\nResult: (SKIPPED — identical call already failed.)',
    },
  ]);

  assert.equal(calls.get(0)[0].status, 'cancelled');
  assert.equal(calls.get(0)[0].error, undefined, '用户主动中断不是错误，不塞红色错误块');
  assert.equal(calls.get(0)[1].status, 'error');
  assert.match(calls.get(0)[1].error, /SKIPPED/);
});

test('同一 id 两代都有时以结构化块为准', () => {
  const calls = collectToolCalls([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'webSearch', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '结构化结果' }] },
    { role: 'user', content: '[Tool execution results]\nTool: webSearch [tool_use_id=c1]\nResult: 纯文本结果' },
  ]);

  assert.equal(calls.get(0)[0].status, 'success');
  assert.equal(calls.get(0)[0].result, '结构化结果');
});

test('结果与错误文本按在线路径同一档截断（4000 / 600）', () => {
  const calls = collectToolCalls([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'ok', name: 'bash', input: {} }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'bad', name: 'bash', input: {} }] },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'ok', content: 'x'.repeat(5000) },
        { type: 'tool_result', tool_use_id: 'bad', content: 'e'.repeat(1000), is_error: true },
      ],
    },
  ]);

  assert.equal(calls.get(0)[0].result.length, 4000);
  assert.equal(calls.get(1)[0].error.length, 600);
});

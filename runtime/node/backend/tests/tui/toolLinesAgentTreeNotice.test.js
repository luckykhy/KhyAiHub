'use strict';

/**
 * toolLinesAgentTreeNotice — 回归:ToolLines 的 agentTree 分支曾在 `isNotice` 声明前
 * 引用它(const TDZ ReferenceError),带 `_agentTree` 的工具卡一进渲染即抛错崩掉整帧。
 * 修复后 done/isErr/isNotice 在分支前统一计算,卡片按 notice 档正确出黄边框。
 *
 * 走与 toolLinesErrorFaithful 同一个 ink 渲染探针(headless 渲染成帧串再断言)。
 * 需 NODE_OPTIONS=--experimental-vm-modules(经 `npm run --workspace backend test:tui`)。
 */

const { Writable } = require('stream');
const { EventEmitter } = require('events');
const React = require('react');

const rt = require('../../src/cli/tui/inkRuntime');

const VM_MODULES = (process.env.NODE_OPTIONS || '').includes('experimental-vm-modules');
const describeOrSkip = VM_MODULES ? describe : describe.skip;

if (!VM_MODULES) {
  // eslint-disable-next-line no-console
  console.warn(
    '[toolLinesAgentTreeNotice] skipped — needs NODE_OPTIONS=--experimental-vm-modules. ' +
      'Run: npm run --workspace backend test:tui'
  );
}

function fakeStdout(columns = 80) {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _enc, cb) { buffer += chunk.toString(); cb(); },
  });
  stream.columns = columns;
  stream.rows = 24;
  stream.isTTY = false;
  stream.getBuffer = () => buffer;
  return stream;
}

function fakeStdin() {
  const stream = new EventEmitter();
  stream.isTTY = true;
  stream.setRawMode = () => stream;
  stream.setEncoding = () => stream;
  stream.resume = () => stream;
  stream.pause = () => stream;
  stream.ref = () => {};
  stream.unref = () => {};
  stream.read = () => null;
  return stream;
}

describeOrSkip('ToolLines agentTree branch (isNotice TDZ 回归)', () => {
  let ink;
  let ToolLines;

  beforeAll(async () => {
    rt.registerJsx();
    await rt.loadInk();
    ink = rt.get();
    ToolLines = require('../../src/cli/tui/ink-components/ToolLines');
  });

  async function frameFor(tools) {
    const stdout = fakeStdout();
    const instance = ink.render(
      React.createElement(ToolLines, { tools, live: true }),
      { stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false }
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    const frame = stdout.getBuffer();
    instance.unmount();
    return frame;
  }

  const { STATUS } = require('../../src/cli/agentTreeView');
  const NOTICE_TOOL = {
    name: 'Task',
    input: { prompt: '并行调研' },
    result: { severity: 'notice', notice: '部分子代理超时跳过' },
    _agentTree: [
      { name: '分析师', status: STATUS.COMPLETED },
      { name: '风控', status: STATUS.RUNNING },
    ],
  };

  test('带 _agentTree 的工具卡渲染不抛错(修复前: isNotice TDZ ReferenceError)', async () => {
    const frame = await frameFor([NOTICE_TOOL]);
    expect(typeof frame).toBe('string');
    // 有树时树替换通用行,头行是 AgentTree 的 "Running N agents…"(行语法契约)。
    expect(frame).toContain('Running 2 agents');
    expect(frame).toContain('分析师');
  });

  test('notice 档在 agentTree 分支同样成立:无红色失败标记', async () => {
    const frame = await frameFor([NOTICE_TOOL]);
    // notice 是中性说明档,不是 error:错误字样不得出现。
    expect(frame).not.toContain('✗');
  });

  test('普通工具卡(无 _agentTree)不受上提重构影响', async () => {
    const frame = await frameFor([
      { name: 'Read', input: { file_path: 'src/x.js' }, result: { summary: '340 行' } },
    ]);
    // 行语法头行:`✓ 读取 src/x.js · 340 行`([DESIGN-ARCH-155],非旧 `Read(...)`)。
    expect(frame).toContain('读取 src/x.js');
    expect(frame).toContain('340 行');
    expect(frame).not.toContain('✗');
  });
});

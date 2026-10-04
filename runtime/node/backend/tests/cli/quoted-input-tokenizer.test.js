'use strict';
// 契约(轮二十一):REPL/TUI 手敲行的引号必须分组且引号字符本身消失;
// 无引号行行为逐字节不变(闸门在前);KHY_QUOTED_INPUT_ARGS=off 回到旧拆分。
// 病症复现:`doc view "my file.md"` 旧行为 ['view','"my','file.md"'] —— 存在带空格的
// 文件被报不存在,碎 token 原样进用户可见错误(convert 实测回显 'no' vs 'no such file.xyz')。
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const ROUTER = path.join(BE, 'src/cli/router.js');

function freshParse(line, envVal) {
  const savedEnv = process.env.KHY_QUOTED_INPUT_ARGS;
  if (envVal === undefined) delete process.env.KHY_QUOTED_INPUT_ARGS;
  else process.env.KHY_QUOTED_INPUT_ARGS = envVal;
  try {
    delete require.cache[require.resolve(ROUTER)];
    return require(ROUTER).parseInput(line);
  } finally {
    if (savedEnv === undefined) delete process.env.KHY_QUOTED_INPUT_ARGS;
    else process.env.KHY_QUOTED_INPUT_ARGS = savedEnv;
  }
}

test('双引号分组:args 合并为一个 token 且引号剥离', () => {
  const p = freshParse('doc view "my file.md"');
  assert.deepEqual(p.args, ['view', 'my file.md']);
});

test('单引号分组;引号混排', () => {
  assert.deepEqual(freshParse("note add 'a b c'").args, ['add', 'a b c']);
  assert.deepEqual(freshParse(`say it's "so nice"`).args, ["it's", 'so nice']);
});

test('内嵌转义引号:"he said \\"hi\\"" → 一个含字面双引号的参数', () => {
  const p = freshParse('quote demo "he said \\"hi\\""');
  assert.deepEqual(p.args, ['demo', 'he said "hi"']);
});

test('引号空串是显式空参数;未闭合引号就地收尾,不吃残余', () => {
  assert.deepEqual(freshParse('cmd "" x').args, ['', 'x']);
  assert.deepEqual(freshParse('cmd "unclosed rest').args, ['unclosed rest']);
});

test('旗标值可带引号空格:--path "a b" → options.path === "a b"', () => {
  const p = freshParse('config set --path "a b"');
  assert.equal(p.options.path, 'a b');
  // 'set' 被既有的子命令提升逻辑吃进 subCommand,与引号改动无关。
  assert.equal(p.subCommand, 'set');
});

test('无引号行逐字节不变(与 off 通道路径对拍)', () => {
  for (const line of ['health', 'a  b   c', 'cmd arg1\targ2  ', 'x --flag v', 'config set --path x']) {
    const a = freshParse(line);
    const b = freshParse(line, 'off');
    assert.deepEqual(a.args, b.args, `line=${JSON.stringify(line)} args`);
    assert.deepEqual(a.options, b.options, `line=${JSON.stringify(line)} options`);
    assert.equal(a.subCommand, b.subCommand, `line=${JSON.stringify(line)} subCommand`);
  }
});

test('kill switch:on 关闭后回到旧的撕碎行为', () => {
  const p = freshParse('doc view "my file.md"', 'off');
  assert.deepEqual(p.args, ['view', '"my', 'file.md"']);
});

test('argv 数组通道不受影响(OS 已分词,原样透传)', () => {
  const p = freshParse(['doc', 'view', 'my file.md']);
  assert.deepEqual(p.args, ['view', 'my file.md']);
});

test('端到端判据:route(convert "<no such spaced>.xyz") 错误回显完整短语而非碎词', async () => {
  const fmtPath = require.resolve(path.join(BE, 'src/cli/formatters.js'));
  const fmt = require(fmtPath);
  const savedErr = fmt.printError;
  const lines = [];
  fmt.printError = (m) => lines.push(String(m));
  try {
    delete require.cache[require.resolve(ROUTER)];
    const r = require(ROUTER);
    await r.route(r.parseInput('convert "D:/ProgramData/no such file.xyz"'), {});
  } finally {
    fmt.printError = savedErr;
  }
  const all = lines.join('\n');
  assert.match(all, /no such file\.xyz/, '应回显完整带空格名');
  assert.doesNotMatch(all, /"D:/, '碎 token/残留引号不得出现在用户可见错误里');
});

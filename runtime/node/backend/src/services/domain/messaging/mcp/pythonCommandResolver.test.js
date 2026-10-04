/**
 * pythonCommandResolver.test.js — 钉死裸 python 启动器的四级解析序与 staleness 语义。
 *
 * 为什么这支套件必须存在：这个叶子决定 MCP stdio 服务器 spawn 哪个解释器——
 * 便携安装下错误解析会 ENOENT 或以系统 python 丢失包依赖。它是纯函数、注入式，
 * 却没有测试；解析序（VIRTUAL_ENV→PYTHON_PATH→venvCandidates→PATH 扫描）与
 * stale/portable 标志的组合只能靠测钉死。
 *
 * 实测更正（与源码注释/上游直觉不同处，按真实语义钉死）：
 * 1. isBareLauncher 用 base.startsWith('python') 宽判：'python-hack'、'pythonw'、
 *    'PYTHON3' 都算裸启动器 — 与 BARE 集合四词的直觉不同 — 实测钉住。
 * 2. resolveStdioCommand('python', null) 抛 TypeError：默认参数 `ctx = {}` 只兜
 *    undefined — 实测钉住。
 * 3. source:'bare_unresolved' 时 stale:false（即使实际不存在！）—— 与显式路径
 *    不存在时 stale:true 形成不对称 — 实测钉住。
 * 4. pathScan 命中但 fsExists 为假 → {source:'path_scan', exists:false, stale:true,
 *    portable:true} —— portable 与 stale 可以同时为真。
 * 5. win32 的 VIRTUAL_ENV 候选用反斜杠 `\\Scripts\\python.exe`，其他平台正斜杠。
 * 6. platform 缺省是 'win32'（ctx.platform || 'win32'），不是 process.platform。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveStdioCommand, isBareLauncher } = require('./pythonCommandResolver');

test('resolver: isBareLauncher 宽判 startsWith(python)（实测钉住）', () => {
  assert.equal(isBareLauncher('python'), true);
  assert.equal(isBareLauncher('python.exe'), true);
  assert.equal(isBareLauncher('PYTHON3'), true);
  assert.equal(isBareLauncher('py'), true);
  assert.equal(isBareLauncher('pythonw'), true);   // startsWith 收编
  assert.equal(isBareLauncher('python-hack'), true); // 连字符也算裸 — 偏差注册
  assert.equal(isBareLauncher('  python  '), true); // trim 后判定
  assert.equal(isBareLauncher(''), false);
  assert.equal(isBareLauncher(null), false);
  assert.equal(isBareLauncher(undefined), false);
  assert.equal(isBareLauncher('node'), false);
  assert.equal(isBareLauncher('C:/x/python'), false); // 含路径分隔符
  assert.equal(isBareLauncher('scripts\\python'), false);
});

test('resolver: 显式路径走 as_configured，缺失即 stale:true', () => {
  const r = resolveStdioCommand('C:\\venvs\\a\\python.exe', {
    platform: 'win32', env: {}, fsExists: () => false, pathScan: () => null,
  });
  assert.deepStrictEqual(r, { command: 'C:\\venvs\\a\\python.exe', source: 'as_configured', exists: false, stale: true, portable: false });
  assert.ok(r.command.length > 0); // 非空输入防呆
  const ok = resolveStdioCommand('/usr/bin/python3', { fsExists: () => true });
  assert.equal(ok.source, 'as_configured');
  assert.equal(ok.stale, false);
});

test('resolver: null ctx 抛 TypeError；undefined ctx 回落安全默认', () => {
  assert.throws(() => resolveStdioCommand('python', null), TypeError);
  // undefined ctx → 默认 {}，探针缺省 (存在性恒 false / pathScan 恒 null) → bare_unresolved
  assert.deepStrictEqual(resolveStdioCommand('python'), { command: 'python', source: 'bare_unresolved', exists: false, stale: false, portable: false });
});

test('resolver: 命令 null → 空串按显式路径处理（as_configured, stale）', () => {
  // String(null||'').trim() === '' → isBareLauncher('')===false → as_configured 分支
  const r = resolveStdioCommand(null, { fsExists: () => false });
  assert.equal(r.source, 'as_configured');
  assert.equal(r.command, '');
  assert.equal(r.stale, true);
});

test('resolver: 解析序 VIRTUAL_ENV > PYTHON_PATH > venvCandidates > pathScan', () => {
  const existsMap = new Set([
    'V:\\env\\Scripts\\python.exe',   // virtualenv 候选（win32 反斜杠）
    'C:\\py\\python.exe',             // PYTHON_PATH
    'C:\\install\\.venv\\Scripts\\python.exe', // venvCandidate
    'C:\\Windows\\python.exe',        // pathScan 命中
  ]);
  const ctx = {
    platform: 'win32',
    fsExists: (p) => existsMap.has(p),
    pathScan: (n) => (n === 'python' ? 'C:\\Windows\\python.exe' : null),
    venvCandidates: ['C:\\install\\.venv\\Scripts\\python.exe'],
  };
  // 1. 四级全可用 → VIRTUAL_ENV 胜出
  let r = resolveStdioCommand('python', { ...ctx, env: { VIRTUAL_ENV: 'V:\\env', PYTHON_PATH: 'C:\\py\\python.exe' } });
  assert.equal(r.source, 'virtualenv');
  assert.equal(r.command, 'V:\\env\\Scripts\\python.exe'); // 反斜杠格式实测
  assert.equal(r.portable, true);
  // 2. VIRTUAL_ENV 指向坏 venv → 落 PYTHON_PATH
  r = resolveStdioCommand('python', { ...ctx, env: { VIRTUAL_ENV: 'Z:\\gone', PYTHON_PATH: 'C:\\py\\python.exe' } });
  assert.equal(r.source, 'python_path');
  // 3. PYTHON_PATH 也坏 → venvCandidate
  r = resolveStdioCommand('python', { ...ctx, env: { PYTHON_PATH: 'Z:\\gone' } });
  assert.equal(r.source, 'venv_candidate');
  // 4. 候选列表都坏（含 null 元素被跳过）→ pathScan
  r = resolveStdioCommand('python', { ...ctx, env: {}, venvCandidates: [null, '', 'Z:\\x'] });
  assert.equal(r.source, 'path_scan');
  assert.equal(r.command, 'C:\\Windows\\python.exe');
  // 5. pathScan 落空 → bare_unresolved, stale:false（不对称注册）
  r = resolveStdioCommand('python', { ...ctx, env: {}, venvCandidates: [], pathScan: () => null });
  assert.deepStrictEqual(r, { command: 'python', source: 'bare_unresolved', exists: false, stale: false, portable: false });
});

test('resolver: posix 平台 VIRTUAL_ENV 用 /bin/python；platform 缺省 win32', () => {
  const r = resolveStdioCommand('python3', {
    platform: 'linux', env: { VIRTUAL_ENV: '/opt/venv' },
    fsExists: (p) => p === '/opt/venv/bin/python',
  });
  assert.equal(r.command, '/opt/venv/bin/python');
  const d = resolveStdioCommand('python', { env: { VIRTUAL_ENV: 'D:\\v' }, fsExists: (p) => p === 'D:\\v\\Scripts\\python.exe' });
  assert.equal(d.source, 'virtualenv'); // 未传 platform → 按 win32
});

test('resolver: pathScan 命中但文件不存在 → portable:true 且 stale:true 并存', () => {
  const r = resolveStdioCommand('python', {
    env: {}, fsExists: () => false, pathScan: () => 'C:\\ghost\\python.exe',
  });
  assert.equal(r.source, 'path_scan');
  assert.equal(r.exists, false);
  assert.equal(r.stale, true);
  assert.equal(r.portable, true);
});

test('resolver: 脏 ctx（数组非数组 / 函数非函数）全部安全回落', () => {
  const r = resolveStdioCommand('python', { env: 'not-an-obj', fsExists: 'no', pathScan: 42, venvCandidates: 'str', platform: '' });
  assert.equal(r.source, 'bare_unresolved'); // env 非对象 → {}；探针非函数 → 全失败
  assert.equal(r.stale, false);
});

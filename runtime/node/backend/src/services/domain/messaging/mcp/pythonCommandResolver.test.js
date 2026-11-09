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
 * 4. pathScan 命中即信任 {source:'path_scan', exists:true, stale:false,
 *    portable:true} —— 旧预期把 existsSync 对 WindowsApps 重解析点的 EACCES 假阴性
 *    当成「路径陈旧」证据（实测 existsSync→false / statSync→EACCES，而该路径正是
 *    本机 where python 自己返回的），那是 2026-11-06 误报的测试侧根源。
 * 5. win32 的 VIRTUAL_ENV 候选用反斜杠 `\\Scripts\\python.exe`，其他平台正斜杠。
 * 6. platform 缺省是 'win32'（ctx.platform || 'win32'），不是 process.platform。
 * 7. isStoreAliasStub 大小写不敏感（PATH 条目按安装时的 casing 原样回显），且
 *    STUB_DIR_SEGMENT 含尾部分隔符 —— 目录本体（...\WindowsApps）不判存根。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveStdioCommand,
  isBareLauncher,
  isStoreAliasStub,
  isPythonCommand,
  describeStubLaunchFailure,
} = require('./pythonCommandResolver');

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

test('resolver: pathScan 命中即信任，fsExists 假阴性不算陈旧（WindowsApps 重解析点）', () => {
  // 旧预期 {exists:false, stale:true} 错在：existsSync stat 的是链接目标，
  // WindowsApps 重解析点上它抛 EACCES 被吞成 false；而该路径正是本机
  // where python 自己返回的。where/which 命中按定义来自本机 PATH，spawn 也不
  // ENOENT（存根是 exit 9009，实测无 'error' 事件）。
  const stub = 'C:\\Users\\25789\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe';
  const r = resolveStdioCommand('python', {
    env: {}, fsExists: () => false, pathScan: () => stub,
  });
  assert.equal(r.source, 'path_scan');
  assert.equal(r.command, stub);
  assert.equal(r.exists, true);
  assert.equal(r.stale, false);
  assert.equal(r.portable, true);
});

test('resolver: isStoreAliasStub 只认 WindowsApps 段之后的 python 路径', () => {
  // 真存根（本机 where python 回显的原样 casing）
  assert.equal(isStoreAliasStub('C:\\Users\\25789\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe'), true);
  // PATH 条目按安装 casing 回显 → 小写形态也必须命中
  assert.equal(isStoreAliasStub('c:\\users\\25789\\appdata\\local\\microsoft\\windowsapps\\python.exe'), true);
  // 全大写形态
  assert.equal(isStoreAliasStub('C:\\USERS\\25789\\APPDATA\\LOCAL\\MICROSOFT\\WINDOWSAPPS\\PYTHON.EXE'), true);
  // 正斜杠形态
  assert.equal(isStoreAliasStub('C:/Users/25789/AppData/Local/Microsoft/WindowsApps/python.exe'), true);
  // 本机 PATH 索引 14 的真路径：WindowsApps 在前、microsoft 在后 → 不是存根
  assert.equal(
    isStoreAliasStub('C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_1.6.10571.0_x64__8wekyb3d8bbwe'),
    false
  );
  // 真解释器 / 裸名 / 目录本体（无尾部分隔符）都不判存根
  assert.equal(isStoreAliasStub('C:\\Python312\\python.exe'), false);
  assert.equal(isStoreAliasStub('python'), false);
  assert.equal(isStoreAliasStub('C:\\Users\\25789\\AppData\\Local\\Microsoft\\WindowsApps'), false);
  assert.equal(isStoreAliasStub(null), false);
});

test('resolver: isPythonCommand 只放行 python 系目标（stale 补救文案是 python 专属的）', () => {
  // 裸启动器
  assert.equal(isPythonCommand('python'), true);
  assert.equal(isPythonCommand('python3'), true);
  assert.equal(isPythonCommand('py'), true);
  // 显式路径（basename 判定）
  assert.equal(isPythonCommand('C:\\Python312\\python.exe'), true);
  assert.equal(isPythonCommand('D:\\venv\\Scripts\\python3.11.exe'), true);
  assert.equal(isPythonCommand('C:/opt/py/pythonw'), true);
  assert.equal(isPythonCommand('C:\\Users\\25789\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe'), true);
  // 非 python 启动器：as_configured 分支的 existsSync 对裸名恒假，若不 gate 住，
  // 用户会收到「改成本机可用的 python.exe / 设 VIRTUAL_ENV」这种错建议。
  assert.equal(isPythonCommand('npx'), false);
  assert.equal(isPythonCommand('node'), false);
  assert.equal(isPythonCommand('uvx'), false);
  assert.equal(isPythonCommand('docker'), false);
  assert.equal(isPythonCommand('C:\\nodejs\\node.exe'), false);
  assert.equal(isPythonCommand('C:\\nodejs\\npx.cmd'), false);
  assert.equal(isPythonCommand(''), false);
  assert.equal(isPythonCommand(null), false);
});

test('resolver: describeStubLaunchFailure 只在「存根 + exit 9009」给诊断，且不点名任何 server', () => {
  const stub = 'C:\\Users\\25789\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe';
  const msg = describeStubLaunchFailure(stub, 9009);
  assert.equal(typeof msg, 'string');
  assert.match(msg, /code 9009/);
  assert.match(msg, /商店应用执行别名存根/);
  assert.match(msg, /加进 PATH/);
  assert.match(msg, /Add python\.exe to PATH/);
  assert.match(msg, /应用执行别名/);
  assert.match(msg, /Python 包与 API key/);
  // 反向钉死：叶子不接 server 上下文，任何 python MCP 都会走到这句文案
  assert.ok(!msg.includes('deepseek_eyes'));
  assert.ok(!msg.includes('MODELSCOPE_API_KEY'));
  // 反向钉死：不得断言路径来源。存根既可来自 PATH 扫描也可来自显式配置
  // （index.js 的 gate 正是为后者抑制 warn），叶子只有 command+code 无从分辨，
  // 写「来自本机 PATH」会把配置指错存根的用户引去修 PATH 而非配置文件。
  assert.ok(!msg.includes('来自本机 PATH'));
  assert.ok(!msg.includes('并非其它机器写死的配置'));
  // 非存根路径 / 非 9009 退出码 → null（交给通用文案）
  assert.equal(describeStubLaunchFailure('C:\\Python312\\python.exe', 9009), null);
  assert.equal(describeStubLaunchFailure(stub, 1), null);
  assert.equal(describeStubLaunchFailure(stub, null), null);
});

test('resolver: 脏 ctx（数组非数组 / 函数非函数）全部安全回落', () => {
  const r = resolveStdioCommand('python', { env: 'not-an-obj', fsExists: 'no', pathScan: 42, venvCandidates: 'str', platform: '' });
  assert.equal(r.source, 'bare_unresolved'); // env 非对象 → {}；探针非函数 → 全失败
  assert.equal(r.stale, false);
});

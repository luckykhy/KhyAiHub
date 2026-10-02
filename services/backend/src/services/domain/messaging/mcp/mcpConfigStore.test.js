/**
 * mcpConfigStore.test.js — 钉死按 scope 定点读改写的失败方向与字节格式。
 *
 * 为什么这支套件必须存在：这个模块直接写用户/项目的 mcp.json，红线有两条：
 * ①损坏文件绝不静默覆盖（readConfigFile 抛给调用方）；②写入字节与旧实现一致
 * （原子写 + 尾换行，project 文件常进仓库，少换行就是一条 diff）。测试全程把
 * KHY_DATA_HOME/KHY_PROJECT_DATA_HOME/KHY_APP_HOME 钉到新鲜临时目录并注入
 * dataHome/cwd，绝不触碰真实 ~/.khy。
 *
 * 实测更正（与源码注释/上游直觉不同处，按真实语义钉死）：
 * 1. scopePath 优先级 dataHome > homedir > getDataHome()；project 分支无视 dataHome。
 * 2. 已存在的 JSON 标量文件（如 '123'）→ 静默给空壳；而损坏文件（'{{{'）→ 抛 —
 *    "损坏不覆盖"只覆盖语法损坏，合法 JSON 但形状不对的文件会被当空配置继续写 — 偏差注册。
 * 3. 已存在的 JSON 数组文件 → 返回"数组 + mcpServers 附加属性"怪胎对象（typeof [] === object
 *    通过了非对象闸）— 实测钉住。
 * 4. readConfigFile 对 mcpServers:null / mcpServers:'str' 都替换成 {}（!raw.mcpServers 或 typeof 非 object）。
 * 5. setServerEnabled(enabled) 把入参原样回显（传 'truthy 垃圾' 也回 'truthy 垃圾'）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 数据家隔离：require 任何会碰 getDataHome 的模块之前先钉死 ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-mcpcs-'));
const savedEnv = {
  KHY_DATA_HOME: process.env.KHY_DATA_HOME,
  KHY_PROJECT_DATA_HOME: process.env.KHY_PROJECT_DATA_HOME,
  KHY_APP_HOME: process.env.KHY_APP_HOME,
};
process.env.KHY_DATA_HOME = TMP;
process.env.KHY_PROJECT_DATA_HOME = path.join(TMP, 'proj-pinned');
process.env.KHY_APP_HOME = path.join(TMP, 'apphome');

const store = require('./mcpConfigStore');

test.after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('configStore: 导出面', () => {
  assert.deepStrictEqual(Object.keys(store).sort(), ['addServer', 'readConfigFile', 'removeServer', 'scopePath', 'setServerEnabled']);
});

test('configStore: scopePath 优先级与 project 分支', () => {
  assert.equal(store.scopePath('project', { cwd: '/abs/proj' }), path.join('/abs/proj', '.khy', 'mcp.json'));
  assert.equal(store.scopePath('project', { cwd: '/abs/proj', dataHome: '/dh' }), path.join('/abs/proj', '.khy', 'mcp.json')); // project 无视 dataHome
  assert.equal(store.scopePath('user', { dataHome: '/dh' }), path.join('/dh', 'mcp.json'));
  assert.equal(store.scopePath('user', { dataHome: '/dh', homedir: '/hd' }), path.join('/dh', 'mcp.json')); // dataHome 赢
  assert.equal(store.scopePath('user', { homedir: '/hd' }), path.join('/hd', '.khy', 'mcp.json'));
  // 都不给 → getDataHome()（KHY_DATA_HOME 已钉 TMP）
  assert.equal(store.scopePath('user', {}), path.join(TMP, 'mcp.json'));
  assert.equal(store.scopePath('user'), path.join(TMP, 'mcp.json')); // opts 默认 {}
  // 未知 scope 字符串 → 落 user 语义（非 project 全按 user）
  assert.equal(store.scopePath('bogus', { dataHome: '/dh' }), path.join('/dh', 'mcp.json'));
});

test('configStore: readConfigFile —— 缺失壳/损坏抛/标量静默壳/数组怪胎', () => {
  const missing = path.join(TMP, 'nope.json');
  assert.deepStrictEqual(store.readConfigFile(missing), { mcpServers: {} });
  const corrupt = path.join(TMP, 'corrupt.json');
  fs.writeFileSync(corrupt, '{{{not json');
  assert.throws(() => store.readConfigFile(corrupt), /无法解析已存在的 MCP 配置文件/);
  const scalar = path.join(TMP, 'scalar.json');
  fs.writeFileSync(scalar, '123');
  assert.deepStrictEqual(store.readConfigFile(scalar), { mcpServers: {} }); // 合法 JSON 标量不抛 — 偏差注册
  const arr = path.join(TMP, 'arr.json');
  fs.writeFileSync(arr, '[1,2]');
  const r = store.readConfigFile(arr);
  assert.ok(Array.isArray(r));           // 数组被当"对象"返回
  assert.deepStrictEqual(r.mcpServers, {}); // 附加属性补上
  // mcpServers 形状不正 → 替换 {}，顶层未知字段保留
  const weird = path.join(TMP, 'weird.json');
  fs.writeFileSync(weird, JSON.stringify({ mcpServers: null, customTop: 1 }));
  assert.deepEqual(store.readConfigFile(weird), { mcpServers: {}, customTop: 1 });
  const weird2 = path.join(TMP, 'weird2.json');
  fs.writeFileSync(weird2, JSON.stringify({ mcpServers: 'str' }));
  assert.deepEqual(store.readConfigFile(weird2), { mcpServers: {} });
});

test('configStore: addServer —— 定点写、同名覆盖、尾换行字节、损坏拒绝覆盖', () => {
  const dh = path.join(TMP, 'dh1');
  const p = store.scopePath('user', { dataHome: dh });
  const r1 = store.addServer('alpha', { command: 'node', args: ['a.js'] }, { dataHome: dh });
  assert.equal(r1.path, p);
  assert.equal(r1.replaced, false);
  assert.equal(fs.existsSync(p), true); // 目录自动创建
  const bytes = fs.readFileSync(p, 'utf-8');
  assert.ok(bytes.endsWith('\n'));      // 尾换行红线
  assert.equal(bytes, JSON.stringify({ mcpServers: { alpha: { command: 'node', args: ['a.js'] } } }, null, 2) + '\n'); // indent-2 字节级钉死
  // 第二台 server + 顶层未知字段共存
  const cfg0 = { mcpServers: { keep: { command: 'k' } }, topField: { z: 1 } };
  fs.writeFileSync(p, JSON.stringify(cfg0, null, 2) + '\n');
  const r2 = store.addServer('beta', { url: 'http://x' }, { dataHome: dh });
  assert.equal(r2.replaced, false);
  const after = JSON.parse(fs.readFileSync(p, 'utf-8'));
  assert.deepEqual(Object.keys(after.mcpServers).sort(), ['beta', 'keep']);
  assert.deepEqual(after.topField, { z: 1 });
  // 同名覆盖 → replaced:true
  const r3 = store.addServer('beta', { url: 'http://y' }, { dataHome: dh });
  assert.equal(r3.replaced, true);
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf-8')).mcpServers.beta.url, 'http://y');
  // 损坏文件 → addServer 抛且原字节不改（fail-closed）
  const badPath = path.join(dh, 'bad', 'mcp.json');
  fs.mkdirSync(path.dirname(badPath), { recursive: true });
  fs.writeFileSync(badPath, '{{{');
  const before = fs.readFileSync(badPath, 'utf-8');
  assert.throws(() => store.addServer('x', { command: 'c' }, { dataHome: path.join(dh, 'bad') }));
  assert.equal(fs.readFileSync(badPath, 'utf-8'), before);
  // 原子写不留 .tmp 残留
  const leftovers = fs.readdirSync(dh).filter((f) => f.includes('.tmp'));
  assert.deepStrictEqual(leftovers, []);
});

test('configStore: removeServer —— 缺失文件/缺失名不写盘，删一台保留其余', () => {
  const dh = path.join(TMP, 'dh2');
  const r0 = store.removeServer('ghost', { dataHome: dh });
  assert.equal(r0.removed, false);
  assert.equal(fs.existsSync(r0.path), false); // 不创建文件
  store.addServer('a', { command: 'a' }, { dataHome: dh });
  store.addServer('b', { command: 'b' }, { dataHome: dh });
  const p = r0.path;
  const r1 = store.removeServer('ghost', { dataHome: dh });
  assert.equal(r1.removed, false);
  const beforeBytes = fs.readFileSync(p, 'utf-8');
  const r2 = store.removeServer('a', { dataHome: dh });
  assert.equal(r2.removed, true);
  const after = JSON.parse(fs.readFileSync(p, 'utf-8'));
  assert.deepEqual(Object.keys(after.mcpServers), ['b']);
  assert.ok(beforeBytes.includes('"a"')); // 非空输入防呆
});

test('configStore: setServerEnabled —— disabled 写/删不动其余字段，入参回显', () => {
  const dh = path.join(TMP, 'dh3');
  store.addServer('srv', { command: 'c', env: { K: 'V' } }, { dataHome: dh });
  const r = store.setServerEnabled('srv', false, { dataHome: dh });
  assert.deepEqual(r, { path: store.scopePath('user', { dataHome: dh }), found: true, enabled: false });
  let cfg = JSON.parse(fs.readFileSync(r.path, 'utf-8'));
  assert.equal(cfg.mcpServers.srv.disabled, true);
  assert.deepEqual(cfg.mcpServers.srv.env, { K: 'V' }); // 其余字段原样
  store.setServerEnabled('srv', true, { dataHome: dh });
  cfg = JSON.parse(fs.readFileSync(r.path, 'utf-8'));
  assert.equal('disabled' in cfg.mcpServers.srv, false);
  // 未知名 / 缺失文件
  assert.deepEqual(store.setServerEnabled('ghost', true, { dataHome: dh }), { path: r.path, found: false, enabled: true });
  const dhEmpty = path.join(TMP, 'dh4');
  assert.deepEqual(store.setServerEnabled('x', false, { dataHome: dhEmpty }), { path: path.join(dhEmpty, 'mcp.json'), found: false, enabled: false });
  assert.equal(fs.existsSync(path.join(dhEmpty, 'mcp.json')), false);
  // 入参非布尔原样回显（enabled 语义只看 truthy）— 实测钉住
  const echo = store.setServerEnabled('srv', 'truthy-junk', { dataHome: dh });
  assert.equal(echo.enabled, 'truthy-junk');
  assert.equal('disabled' in JSON.parse(fs.readFileSync(echo.path, 'utf-8')).mcpServers.srv, false);
});

test('configStore: project scope 走注入 cwd 的 .khy/mcp.json', () => {
  const proj = path.join(TMP, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const r = store.addServer('p1', { command: 'pp' }, { scope: 'project', cwd: proj });
  assert.equal(r.path, path.join(proj, '.khy', 'mcp.json'));
  assert.equal(fs.existsSync(r.path), true);
  const rm = store.removeServer('p1', { scope: 'project', cwd: proj });
  assert.equal(rm.removed, true);
});

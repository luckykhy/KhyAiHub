'use strict';

/**
 * intentSchema.test.js — 意图规约 / 旁路探测 / 校验契约（纯函数，依赖注入 cwd/home，零 IO）。
 *
 * fail 方向：buildIntent **永不抛**——任何解析异常降级为 UNKNOWN 动作 + 保守作用域
 * （无资源 UNKNOWN → 'na'；沙箱逃逸声明 → SYSTEM）。detectBypassMarkers 对 null 参数返回
 * 空数组（无标记），validateIntent 对缺失意图返回 ok:false。
 * 门控：旁路「字段作用域化」KHY_GATEWAY_BYPASS_SCOPED 默认开（仅经 env 参数传入，不碰 process.env）。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { ACTIONS, SCOPES, buildIntent, validateIntent, detectBypassMarkers } = require('./intentSchema');

const BASE = { cwd: 'D:/proj', home: 'D:/home' };

test('ACTIONS 非空且含规约动作枚举', () => {
  assert.ok(Object.values(ACTIONS).length > 0);
  assert.strictEqual(ACTIONS.READ, 'read');
  assert.strictEqual(ACTIONS.SANDBOX_ESCAPE, 'sandbox_escape');
});

test('SCOPES 非空且含作用域枚举', () => {
  assert.ok(Object.values(SCOPES).length > 0);
  assert.deepStrictEqual(SCOPES, {
    PROJECT: 'project',
    HOME: 'home',
    SYSTEM: 'system',
    NETWORK: 'network',
    PROCESS: 'process',
    NA: 'na',
  });
});

test('buildIntent 返回冻结对象且默认 risk=medium', () => {
  const i = buildIntent({ ...BASE, tool: 'Read', params: { file_path: 'src/a.js' } });
  assert.ok(Object.isFrozen(i), 'intent 必须不可变');
  assert.strictEqual(i.risk, 'medium');
  assert.strictEqual(i.tool, 'Read');
});

test('buildIntent 从命令文本派生删除动作', () => {
  const i = buildIntent({ ...BASE, tool: 'Bash', params: { command: 'rm -rf tmp' } });
  assert.strictEqual(i.action, ACTIONS.DELETE);
});

test('buildIntent 从命令文本派生全局安装动作并锁系统作用域', () => {
  const i = buildIntent({ ...BASE, tool: 'Bash', params: { command: 'npm i -g typescript' } });
  assert.strictEqual(i.action, ACTIONS.INSTALL);
  assert.strictEqual(i.scope, SCOPES.SYSTEM);
});

test('buildIntent 从命令文本派生杀进程动作', () => {
  const i = buildIntent({ ...BASE, tool: 'Bash', params: { command: 'kill 4321' } });
  assert.strictEqual(i.action, ACTIONS.KILL);
});

test('buildIntent 从 export 命令派生环境变量动作', () => {
  const i = buildIntent({ ...BASE, tool: 'Bash', params: { command: 'export FOO=bar' } });
  assert.strictEqual(i.action, ACTIONS.ENV);
});

test('buildIntent git 写操作归 WRITE、git 只读带 isReadOnly 归 READ', () => {
  const push = buildIntent({ ...BASE, tool: 'gitPush', params: {}, isReadOnly: false });
  const status = buildIntent({ ...BASE, tool: 'gitStatus', params: {}, isReadOnly: true });
  assert.strictEqual(push.action, ACTIONS.WRITE);
  assert.strictEqual(status.action, ACTIONS.READ);
});

test('buildIntent 网络类工具归 NETWORK / 网络作用域', () => {
  const i = buildIntent({ ...BASE, tool: 'webfetch', params: { url: 'https://example.com' } });
  assert.strictEqual(i.action, ACTIONS.NETWORK);
  assert.strictEqual(i.scope, SCOPES.NETWORK);
});

test('buildIntent 写入工具按路径判定项目/家/系统作用域', () => {
  assert.strictEqual(buildIntent({ ...BASE, tool: 'Write', params: { file_path: 'src/a.js' } }).scope, SCOPES.PROJECT);
  assert.strictEqual(buildIntent({ ...BASE, tool: 'Write', params: { file_path: 'D:/home/notes.txt' } }).scope, SCOPES.HOME);
  assert.strictEqual(buildIntent({ ...BASE, tool: 'Write', params: { file_path: 'D:/other/x.txt' } }).scope, SCOPES.SYSTEM);
});

test('buildIntent sandboxEscape 声明覆盖动作并锁系统作用域', () => {
  const i = buildIntent({ ...BASE, tool: 'Read', params: { file_path: 'src/a.js' }, sandboxEscape: true });
  assert.strictEqual(i.action, ACTIONS.SANDBOX_ESCAPE);
  assert.strictEqual(i.scope, SCOPES.SYSTEM);
});

test('buildIntent 对空 call fail-closed 为 UNKNOWN/na 且不抛', () => {
  const i = buildIntent({});
  assert.strictEqual(i.action, ACTIONS.UNKNOWN);
  assert.strictEqual(i.scope, SCOPES.NA);
  assert.strictEqual(i.tool, 'unknown');
});

test('buildIntent 对畸形 params（非对象）不抛，降级', () => {
  const i = buildIntent({ ...BASE, tool: 'Read', params: 'not-an-object' });
  assert.ok(typeof i.action === 'string');
  assert.ok(i.raw && typeof i.raw === 'object');
});

test('detectBypassMarkers 键 force:true 命中（任意层级）', () => {
  assert.deepStrictEqual(detectBypassMarkers({ force: true }, {}), ['key:force']);
});

test('detectBypassMarkers 键 force:false 不命中（假值放行）', () => {
  assert.deepStrictEqual(detectBypassMarkers({ force: false }, {}), []);
});

test('detectBypassMarkers 嵌套数据里的 autoApprove 键仍命中', () => {
  assert.deepStrictEqual(detectBypassMarkers({ a: { autoApprove: 'yes' } }, {}), ['key:autoApprove']);
});

test('detectBypassMarkers 作用域化：命令字段命中 --skip-approval', () => {
  assert.deepStrictEqual(detectBypassMarkers({ command: 'run --skip-approval' }, {}), ['flag:--skip-approval']);
});

test('detectBypassMarkers 作用域化：子进程自有 --yes 不当旁路', () => {
  assert.deepStrictEqual(detectBypassMarkers({ command: 'npx --yes asar ls' }, {}), []);
});

test('detectBypassMarkers 作用域化：数据载荷字段 content 不扫 flag', () => {
  assert.deepStrictEqual(detectBypassMarkers({ content: 'text with -f and --yes' }, {}), []);
});

test('detectBypassMarkers 门控关（legacy）：无差别扫描，裸 -f 命中', () => {
  const env = { KHY_GATEWAY_BYPASS_SCOPED: 'off' };
  assert.deepStrictEqual(detectBypassMarkers({ content: 'has -f here' }, env), ['flag:-f']);
});

test('detectBypassMarkers null 参数返回空数组', () => {
  assert.deepStrictEqual(detectBypassMarkers(null, {}), []);
});

test('validateIntent 干净意图 ok:true', () => {
  const i = buildIntent({ ...BASE, tool: 'Read', params: { file_path: 'src/a.js' } });
  const v = validateIntent(i);
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(v.bypass, []);
  assert.deepStrictEqual(v.errors, []);
});

test('validateIntent 命中旁路键 ok:false + bypass 非空', () => {
  const i = buildIntent({ ...BASE, tool: 'Bash', params: { command: 'ls', force: true } });
  const v = validateIntent(i);
  assert.strictEqual(v.ok, false);
  assert.deepStrictEqual(v.bypass, ['key:force']);
});

test('validateIntent null 返回 ok:false + 意图缺失', () => {
  assert.deepStrictEqual(validateIntent(null), { ok: false, bypass: [], errors: ['意图缺失'] });
});

test('validateIntent 未知动作类别记入 errors', () => {
  const v = validateIntent({ action: 'zzz', raw: {} });
  assert.strictEqual(v.ok, false);
  assert.deepStrictEqual(v.errors, ['未知动作类别']);
});

// B28-S1（潜在缺陷，本文件钉住**实测行为**而非期望行为；语义真源见 README「已知边界」）：
// detectBypassMarkers 把整段递归 visit 包在**一个** try/catch 里（intentSchema.js:373-377），
// 而 Object.entries(obj) 会在进入循环前**急切求值所有 getter**——因此任何一个取值即抛的属性
// 会中止**整场扫描**，catch 静默吞掉，返回已累积的 hits（此处为空前中止 = 空数组）。
// 后果：真实旁路标记 force:true 因同层存在一个抛错的键而**完全丢失**，validateIntent 随即
// 报 ok:true / bypass:[]，而 breachBreaker 把旁路探测当作零容忍跳闸的依据。
// 与本文件头「任何解析异常都降级成『未知高危』而非放行」的 fail-closed 契约相悖。
// 不修不是失败，谎报已修才是；修复需人裁决（改动会放宽/收紧旁路判定，属裁决面）。
test('B28-S1 实测钉住：取值即抛的键会中止整场旁路扫描并吞掉真实 force 标记（fail-open）', () => {
  const mixed = {};
  Object.defineProperty(mixed, 'force', { value: true, enumerable: true });
  Object.defineProperty(mixed, 'boom', {
    enumerable: true,
    get() {
      throw new Error('getter-boom');
    },
  });
  // 对照组：同一 force 标记单独出现时确实被探测到
  assert.deepStrictEqual(detectBypassMarkers({ force: true }), ['key:force']);
  // 实验组：加一个抛错键后，探测结果退化为空（且键序不影响结论）
  assert.deepStrictEqual(detectBypassMarkers(mixed), []);
  const reversed = {};
  Object.defineProperty(reversed, 'boom', {
    enumerable: true,
    get() {
      throw new Error('g');
    },
  });
  Object.defineProperty(reversed, 'force', { value: true, enumerable: true });
  assert.deepStrictEqual(detectBypassMarkers(reversed), []);
  // 上游后果钉住：validateIntent 对同一意图判为「无旁路、可放行」
  assert.deepStrictEqual(validateIntent({ action: ACTIONS.EXEC_CODE, raw: { params: mixed } }), {
    ok: true,
    bypass: [],
    errors: [],
  });
});

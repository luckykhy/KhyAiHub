'use strict';

/**
 * assetModel.test.js — 钉死外部 agent 资产 IR 的纯叶子：门控、凭据脱敏/回填、三类资产
 * 规整与校验、稳定身份、内容哈希、同步判定与冲突副本命名。
 *
 * 为什么这支套件必须存在：本文件是 D2 域层里唯一的「判定真源」——registry/sync/六个适配器
 * 全部把「什么算同一个资产」「什么算冲突」「哪些字段是凭据」这三件事委托给它。这三件事的
 * 结果会直接决定「要不要往用户磁盘写第二份文件」与「密钥会不会跟着 IR 流到另一家工具」，
 * 所以判据的边界（默认值、大小写、键序、时间戳缺失）必须逐条钉死。
 *
 * 实测更正（与注释/直觉不同处，按真实语义钉死）：
 *   · isEnabled 的关闭词表只有 CANON 四词（0/false/off/no）；'disable'、空串、未设置**都是开**。
 *     flagRegistry 可用时走注册表分支且优先级高于本地词表，两者词表此刻恰好同集。
 *   · normalizeTool 认两种入参形态：原生 `kind`，以及已进过 IR 的 `kind:'tool' + toolKind`
 *     （assetModel.js:380）。只认后者的话 listTools() 的产物导不出去。
 *   · contentHash 刻意排除 source / updatedAt / raw，并排除技能的**主文件名**，故判等与
 *     「哪家工具、什么键序、文件叫什么」无关；tags 排序后入哈希。
 *   · decideSync 永不返回覆盖：两侧哈希不同就是 conflict，时间戳只用于汇报「谁更新」。
 *   · conflictCopyName 内嵌内容哈希前 8 位而非时间戳 → 重复同步幂等。
 *   · conflictCopyPath 对点文件（`.env`）不切扩展名：`dot > 0` 守卫把整个 basename 当 stem。
 *   · normalizeSource 的 redactedFields 走 _trim 强转，数字 0 会以字符串 '0' 留下。
 *
 * 钉住的缺陷（只断言实际行为，不修不软化，详见各 KNOWN-DEFECT 用例）：
 *   · assetModel.js:450 validateAsset 查表无 own-property 守卫 → 原型链键绕过校验。
 *   · assetModel.js:295 restoreRedacted 把目标侧引用挂进返回结构 → 写载荷写穿真源。
 *   · assetModel.js:418 normalizeSkill 先去重后归一分隔符 → 规整对自有输出不幂等。
 *   · assetModel.js:115 isCredentialKey 对不可调用 toString 的对象入参抛 TypeError，
 *     与本模块头部「纯叶子…绝不抛」的承诺相悖。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const M = require('./assetModel');

const HASHABLE_MEMORY = {
  kind: 'memory',
  id: 'conv',
  scope: 'project',
  title: '项目约定',
  content: '用 pnpm',
  tags: ['build'],
};

// ── 导出面与常量表 ────────────────────────────────────────────────────────

test('assetModel 恰导出 19 个符号（IR 契约面）', () => {
  assert.deepStrictEqual(Object.keys(M).sort(), [
    'ASSET_KINDS',
    'CREDENTIAL_KEY_HINTS',
    'MEMORY_SCOPES',
    'REDACTED',
    'TOOL_KINDS',
    'assetIdentity',
    'conflictCopyName',
    'conflictCopyPath',
    'contentHash',
    'decideSync',
    'isEnabled',
    'isCredentialKey',
    'normalizeMemory',
    'normalizeSkill',
    'normalizeSource',
    'normalizeTool',
    'redactCredentials',
    'restoreRedacted',
    'validateAsset',
  ].sort());
});

test('三张枚举表 frozen 且内容封闭（新增一类资产必须同时改 normalize/validate）', () => {
  assert.deepStrictEqual(M.ASSET_KINDS, ['memory', 'tool', 'skill']);
  assert.deepStrictEqual(M.MEMORY_SCOPES, ['global', 'project']);
  assert.deepStrictEqual(M.TOOL_KINDS, ['mcp_server', 'local_command', 'builtin']);
  assert.ok(Object.isFrozen(M.ASSET_KINDS) && Object.isFrozen(M.TOOL_KINDS) && Object.isFrozen(M.MEMORY_SCOPES));
  assert.throws(() => M.ASSET_KINDS.push('prompt'), TypeError, 'frozen 数组在严格模式下追加必须抛');
  assert.strictEqual(M.REDACTED, '__KHY_REDACTED__');
  assert.ok(M.CREDENTIAL_KEY_HINTS.includes('authorization'));
});

// ── 门控 ─────────────────────────────────────────────────────────────────

test('isEnabled 默认开；四个 CANON 关闭词在注册表分支与本地分支下同解', () => {
  assert.strictEqual(M.isEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(M.isEnabled({ KHY_AGENT_ASSETS: off }), false, `${off} 应关门`);
    assert.strictEqual(
      M.isEnabled({ KHY_FLAG_REGISTRY: 'off', KHY_AGENT_ASSETS: off }),
      false,
      `${off} 在注册表不可用的本地兜底里同样关门`
    );
  }
});

test('isEnabled 大小写与空格归一，但 disable / 空串 / 未设置一律算开（词表只有 CANON 四词）', () => {
  assert.strictEqual(M.isEnabled({ KHY_AGENT_ASSETS: ' OFF ' }), false);
  assert.strictEqual(M.isEnabled({ KHY_AGENT_ASSETS: 'Off' }), false);
  assert.strictEqual(M.isEnabled({ KHY_AGENT_ASSETS: 'disable' }), true,
    'EXTENDED 词表不在本门控的 CANON 档，"disable" 读成开');
  assert.strictEqual(M.isEnabled({ KHY_AGENT_ASSETS: '' }), true, '显式空值不等于关闭');
  assert.strictEqual(M.isEnabled({ KHY_FLAG_REGISTRY: 'off', KHY_AGENT_ASSETS: 'disabled' }), true);
  assert.strictEqual(M.isEnabled({ KHY_AGENT_ASSETS: 0 }), false, '数字 0 归一后仍是关闭词');
});

test('isEnabled 的注册表分支优先：注册表开着时本地词表说了不算', () => {
  // KHY_FLAG_REGISTRY 开着 → 由 flagRegistry 判定；此时本地兜底词表根本不参与。
  assert.strictEqual(M.isEnabled({ KHY_FLAG_REGISTRY: '1', KHY_AGENT_ASSETS: 'off' }), false);
  assert.strictEqual(M.isEnabled({ KHY_FLAG_REGISTRY: 'off', KHY_AGENT_ASSETS: 'off' }), false);
  assert.strictEqual(M.isEnabled({ KHY_FLAG_REGISTRY: 'bogus-value', KHY_AGENT_ASSETS: 'no' }), false);
  assert.strictEqual(M.isEnabled(undefined), M.isEnabled());
  assert.strictEqual(M.isEnabled(null), M.isEnabled(process.env));
});

// ── isCredentialKey ──────────────────────────────────────────────────────

test('isCredentialKey 按键名子串判凭据：下划线/连字符/大小写/空格四种方言都认', () => {
  for (const key of ['apiKey', 'API_KEY', 'api-key', 'access_token', 'clientSecret',
    'PRIVATE KEY', 'Authorization', 'bearer', 'sessionCookie', 'password', 'passwd',
    'passphrase', 'credential', 'token']) {
    assert.strictEqual(M.isCredentialKey(key), true, `${key} 应判为凭据`);
  }
  for (const key of ['name', 'title', 'command', 'url', 'description', 'env', 'args', '', '   ']) {
    assert.strictEqual(M.isCredentialKey(key), false, `${key} 不该被判为凭据`);
  }
});

test('isCredentialKey 对 null / 数字 / 数组 / 纯对象入参不抛，且刻意宽松到 tokenizer 这种近义键', () => {
  assert.strictEqual(M.isCredentialKey(null), false);
  assert.strictEqual(M.isCredentialKey(undefined), false);
  assert.strictEqual(M.isCredentialKey(0), false);
  assert.strictEqual(M.isCredentialKey(NaN), false);
  assert.strictEqual(M.isCredentialKey(false), false);
  assert.strictEqual(M.isCredentialKey({}), false, 'Object.prototype.toString 的产物不是凭据词');
  assert.strictEqual(M.isCredentialKey([]), false);
  assert.strictEqual(M.isCredentialKey(['api_key']), true, '数组靠 String 强转成 "api_key" 后被识别');
  assert.strictEqual(M.isCredentialKey({ toString() { return 'api_key'; } }), true, '可调用 toString 走正常强转');
  assert.strictEqual(M.isCredentialKey('tokenizer'), true, '宽松侧：多抹一个非机密字段的代价小于漏抹一个');
});

test('KNOWN-DEFECT: assetModel.js:115 isCredentialKey 遇不可调用 toString 的对象入参抛 TypeError，违背本模块「纯叶子…绝不抛」', () => {
  // Defect: the module header (assetModel.js:4-5) advertises this leaf as
  // side-effect-free and never throwing, but _str() falls through to String(v),
  // and String({ toString: 'x' }) raises TypeError because the ToPrimitive
  // algorithm finds a non-callable `toString` and a non-primitive `valueOf`.
  // isCredentialKey is exported (assetModel.js:662), so any future caller that
  // forwards a JSON value instead of a key name crashes the redaction path —
  // which is the one place that must never fail open.
  assert.throws(() => M.isCredentialKey({ toString: 'x' }),
    (err) => err instanceof TypeError && /Cannot convert object to primitive value/.test(err.message));
  // 低危说明：本仓库内唯一调用点 assetModel.js:205 只喂 Object.keys 的结果（恒为字符串），
  // 故当前不可达；钉住的是「导出面与模块契约不符」这一层。
  assert.strictEqual(M.isCredentialKey('api_key'), true);
});

// ── redactCredentials ────────────────────────────────────────────────────

test('redactCredentials 按键名脱敏并记下无前置的路径，数组元素带下标', () => {
  const input = {
    command: 'node',
    API_KEY: 'sk-live-abcdef123456',
    env: { TOKEN: 'plain-value', PATH_HOME: '/usr/bin' },
    servers: [{ url: 'http://x', accessToken: 'a' }, { secret: 'b' }],
  };
  const out = M.redactCredentials(input);
  assert.deepStrictEqual(out.redactedFields.slice().sort(),
    ['API_KEY', 'env.TOKEN', 'servers[0].accessToken', 'servers[1].secret']);
  assert.strictEqual(out.value.API_KEY, M.REDACTED);
  assert.strictEqual(out.value.env.TOKEN, M.REDACTED);
  assert.strictEqual(out.value.env.PATH_HOME, '/usr/bin');
  assert.strictEqual(out.value.command, 'node');
  assert.strictEqual(out.value.servers[0].url, 'http://x');
  assert.strictEqual(out.value.servers[0].accessToken, M.REDACTED);
});

test('redactCredentials 输入不被修改，返回的是新结构', () => {
  const input = { nested: { token: 't', keep: 'k' } };
  const snapshot = JSON.parse(JSON.stringify(input));
  const out = M.redactCredentials(input);
  assert.deepStrictEqual(input, snapshot, '原文必须一字不动（凭据真值还要靠它回填）');
  assert.notStrictEqual(out.value, input);
  assert.notStrictEqual(out.value.nested, input.nested);
});

test('redactCredentials 按键名之外的「值长得像密钥」兜底，多段现代 key 整体命中', () => {
  const out = M.redactCredentials({ note: 'sk-proj-AbCdEf1234567890', benign: 'sk-12' });
  assert.deepStrictEqual(out.redactedFields, ['note']);
  assert.strictEqual(out.value.note, M.REDACTED);
  assert.strictEqual(out.value.benign, 'sk-12', '不足 8 位 body 不算现代 key');
  const jwt = M.redactCredentials({ blob: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEFG12345678' });
  assert.deepStrictEqual(jwt.redactedFields, ['blob']);
});

test('redactCredentials 的 pathPrefix 会带进记录路径（同步层用它寻 spec 内部）', () => {
  const out = M.redactCredentials({ token: 't' }, { pathPrefix: 'spec' });
  assert.deepStrictEqual(out.redactedFields, ['spec.token']);
  assert.strictEqual(out.value.token, M.REDACTED);
});

test('redactCredentials 对循环结构整块丢弃而不抛（宁可全抹也不放行可能含密钥的内容）', () => {
  const cyclic = { name: 'x' };
  cyclic.self = cyclic;
  const out = M.redactCredentials(cyclic);
  assert.strictEqual(out.value, null);
  assert.ok(Array.isArray(out.redactedFields));
});

test('redactCredentials 对 null / 数组 / 标量 / 空对象入参都回可用结构', () => {
  assert.deepStrictEqual(M.redactCredentials(null), { value: null, redactedFields: [] });
  assert.deepStrictEqual(M.redactCredentials([]), { value: [], redactedFields: [] });
  assert.deepStrictEqual(M.redactCredentials('just-a-string'), { value: 'just-a-string', redactedFields: [] });
  assert.deepStrictEqual(M.redactCredentials({}), { value: {}, redactedFields: [] });
  assert.deepStrictEqual(M.redactCredentials({ a: 1, b: true, c: null }, { pathPrefix: '   ' }).value,
    { a: 1, b: true, c: null }, 'pathPrefix 空白被 trim 成空串，路径不带前缀');
});

// ── restoreRedacted ──────────────────────────────────────────────────────

test('restoreRedacted 用目标侧现值填回被抹路径；目标没有该键就整键删除', () => {
  const incoming = { command: 'node', API_KEY: M.REDACTED, env: { TOKEN: M.REDACTED, SHELL: '/bin/zsh' } };
  const existing = { API_KEY: 'sk-real', env: { SHELL: '/bin/bash' } };
  const out = M.restoreRedacted(incoming, existing, ['API_KEY', 'env.TOKEN', 'env.SHELL']);
  assert.strictEqual(out.API_KEY, 'sk-real');
  assert.strictEqual(out.env.TOKEN, undefined, '目标侧没有该凭据 → 整键删掉，占位符绝不落盘');
  assert.strictEqual(out.env.SHELL, '/bin/bash', '命中凭据键名之外的路径也按清单处理：真值以目标侧为准');
});

test('restoreRedacted 处理数组下标路径：目标缺该项时把元素删掉而不是留占位符', () => {
  const incoming = { servers: [{ token: M.REDACTED }, { token: M.REDACTED }] };
  const existing = { servers: [{ token: 'real-0' }, {}] };
  const out = M.restoreRedacted(incoming, existing, ['servers[0].token', 'servers[1].token']);
  assert.strictEqual(out.servers[0].token, 'real-0');
  assert.deepStrictEqual(out.servers[1], {}, '第二个服务器没有凭据可回填 → 键被删');
});

test('restoreRedacted 清单为空 / 非数组 / 空白项 / 寻址不到时都原样回克隆，不碰入参', () => {
  const incoming = { a: 1 };
  assert.deepStrictEqual(M.restoreRedacted(incoming, { a: 2 }, []), { a: 1 });
  assert.deepStrictEqual(M.restoreRedacted(incoming, { a: 2 }, null), { a: 1 });
  assert.deepStrictEqual(M.restoreRedacted(incoming, null, ['   ', '']), { a: 1 });
  assert.deepStrictEqual(M.restoreRedacted(incoming, {}, ['missing.deep.path']), { a: 1 });
  assert.deepStrictEqual(M.restoreRedacted(incoming, {}, ['a.b']), { a: 1 }, '叶子是标量时父级不可写，跳过');
  assert.notStrictEqual(M.restoreRedacted(incoming, null, []), incoming, '返回新结构（深克隆）');
});

test('restoreRedacted 对 undefined / 循环入参如实回退（不抛、不产半成品）', () => {
  assert.strictEqual(M.restoreRedacted(undefined, {}, ['x']), null);
  const cyclic = { token: M.REDACTED };
  cyclic.self = cyclic;
  assert.strictEqual(M.restoreRedacted(cyclic, {}, ['token']), cyclic, '克隆失败时原样返回，由调用方自行判断');
});

test('KNOWN-DEFECT: assetModel.js:295 restoreRedacted 把目标侧的引用直接挂进返回结构，违背「新结构，不改动入参」', () => {
  // File: assetModel.js:295 `parent.value[leaf] = prior.value;` copies the *reference* held
  // by `existing`. The function's own doc (assetModel.js:237) promises "处理后的结构(新结构,
  // 不改动入参)", but the returned tree then shares nested objects/arrays with the target-side
  // document: any later mutation of the write payload writes straight into the live config the
  // caller read from disk (opencode.js:374 / khyOs.js:364 pass the freshly parsed doc as
  // `existing`), so the "rollback = re-read the file" assumption no longer holds in-process.
  const incoming = { session: M.REDACTED };
  const existing = { session: { cookies: ['a'] } };
  const out = M.restoreRedacted(incoming, existing, ['session']);
  assert.strictEqual(out.session, existing.session, '返回结构与入参共享同一对象（应为克隆）');
  out.session.cookies.push('tampered');
  assert.deepStrictEqual(existing.session.cookies, ['a', 'tampered'], '写载荷会写穿目标侧真源');
});

// ── normalizeSource ──────────────────────────────────────────────────────

test('normalizeSource 恒回四字段结构：路径转正斜杠、凭据路径去空去重、垃圾入参归零', () => {
  assert.deepStrictEqual(M.normalizeSource({
    tool: ' opencode ',
    path: 'memory\\sub\\a.md',
    format: ' markdown+frontmatter ',
    redactedFields: ['env.TOKEN', '', 'env.TOKEN', '  a  ', 0, null],
  }), { tool: 'opencode', path: 'memory/sub/a.md', format: 'markdown+frontmatter', redactedFields: ['env.TOKEN', 'a', '0'] });
  // _strArray 走 _trim(item)，数字 0 被 String() 成 '0' 后算非空项留下；null/undefined/'' 才被丢。
  assert.deepStrictEqual(M.normalizeSource({ redactedFields: [null, undefined, '', false] }).redactedFields, ['false']);
  for (const junk of [null, undefined, 0, 'str', [], true]) {
    assert.deepStrictEqual(M.normalizeSource(junk), { tool: '', path: '', format: '', redactedFields: [] });
  }
});

// ── normalizeMemory ──────────────────────────────────────────────────────

test('normalizeMemory 正例：scope 默认 project、title 回落 id、tags 规整、raw 非对象归零', () => {
  const res = M.normalizeMemory({ id: ' note ', content: '正文', tags: ['a', ' a ', '', 'b'] });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.asset, {
    kind: 'memory',
    id: 'note',
    scope: 'project',
    title: 'note',
    content: '正文',
    tags: ['a', 'b'],
    source: { tool: '', path: '', format: '', redactedFields: [] },
    updatedAt: '',
    raw: {},
  });
});

test('normalizeMemory 拒绝：非对象 / 空 id / 非法 scope / content 非字符串（数字 0 也算非法）', () => {
  assert.deepStrictEqual(M.normalizeMemory(null), { ok: false, error: 'memory 必须是对象' });
  assert.strictEqual(M.normalizeMemory([]).ok, false, '数组不是 plain object');
  assert.strictEqual(M.normalizeMemory({ content: 'x' }).error, 'memory.id 不能为空');
  assert.strictEqual(M.normalizeMemory({ id: ' ', content: 'x' }).error, 'memory.id 不能为空');
  assert.match(M.normalizeMemory({ id: 'a', scope: 'team', content: 'x' }).error, /仅 global\/project/);
  assert.strictEqual(M.normalizeMemory({ id: 'a', content: 0 }).error, 'memory.content 必须是字符串');
  assert.strictEqual(M.normalizeMemory({ id: 'a', content: false }).error, 'memory.content 必须是字符串');
  assert.strictEqual(M.normalizeMemory({ id: 'a', content: '' }).ok, true, '空正文是合法记忆体');
});

test('normalizeMemory 的 updatedAt 规整：合法时间戳转 ISO，epoch 0 不被吞成空串，垃圾归空', () => {
  assert.strictEqual(M.normalizeMemory({ id: 'a', content: '', updatedAt: '2026-09-01T00:00:00Z' }).asset.updatedAt,
    '2026-09-01T00:00:00.000Z');
  assert.strictEqual(M.normalizeMemory({ id: 'a', content: '', updatedAt: 0 }).asset.updatedAt,
    '1970-01-01T00:00:00.000Z', '合法的 0 必须留在 IR 里，不能和「没有时间」混同');
  assert.strictEqual(M.normalizeMemory({ id: 'a', content: '', updatedAt: new Date('2026-01-02T03:04:05Z') }).asset.updatedAt,
    '2026-01-02T03:04:05.000Z');
  for (const bad of ['not-a-date', {}, [], NaN, -1 / 0]) {
    assert.strictEqual(M.normalizeMemory({ id: 'a', content: '', updatedAt: bad }).asset.updatedAt, '');
  }
});

// ── normalizeTool ────────────────────────────────────────────────────────

test('normalizeTool 认两种形态：原生 kind，以及 IR 回炉的 kind:"tool" + toolKind', () => {
  const native = M.normalizeTool({ name: 'fs', kind: 'mcp_server', spec: { command: 'x' } });
  assert.strictEqual(native.ok, true);
  assert.strictEqual(native.asset.toolKind, 'mcp_server');
  const roundTrip = M.normalizeTool({ name: 'fs', kind: 'tool', toolKind: 'local_command', spec: {} });
  assert.strictEqual(roundTrip.ok, true);
  assert.strictEqual(roundTrip.asset.toolKind, 'local_command');
  assert.strictEqual(roundTrip.asset.kind, 'tool');
  // 只有 kind:'tool' 而没有 toolKind 时不得假装能猜出类型；实测报的是被拒绝的字面量 'tool'。
  assert.strictEqual(M.normalizeTool({ name: 'fs', kind: 'tool', spec: {} }).error,
    'tool.kind 非法:tool（仅 mcp_server/local_command/builtin）');
  assert.strictEqual(M.normalizeTool({ name: 'fs', kind: 'tool', toolKind: '  ', spec: {} }).error,
    'tool.kind 非法:tool（仅 mcp_server/local_command/builtin）', 'toolKind 全空白等同于缺失');
  assert.strictEqual(M.normalizeTool({ name: 'fs', kind: 'tool', toolKind: 'MCP_SERVER', spec: {} }).ok,
    false, 'toolKind 大小写敏感：不做隐式降级');
  assert.strictEqual(M.normalizeTool({ name: 'fs', kind: ' mcp_server ', spec: {} }).asset.toolKind,
    'mcp_server', '原生形态两侧空白被吃掉');
});

test('normalizeTool 拒绝：空 name / 未知 kind / spec 非对象；描述去空白', () => {
  assert.strictEqual(M.normalizeTool(null).error, 'tool 必须是对象');
  assert.strictEqual(M.normalizeTool({ spec: {} }).error, 'tool.name 不能为空');
  assert.strictEqual(M.normalizeTool({ name: 'a', kind: 'http', spec: {} }).error,
    'tool.kind 非法:http（仅 mcp_server/local_command/builtin）');
  assert.strictEqual(M.normalizeTool({ name: 'a', kind: 'builtin' }).error,
    'tool.spec 必须是对象(该 kind 下的原始配置,不做有损压缩)');
  assert.strictEqual(M.normalizeTool({ name: 'a', kind: 'builtin', spec: [] }).ok, false, '数组不是 spec 的合法形态');
  assert.strictEqual(M.normalizeTool({ name: 'a', kind: 'builtin', spec: {}, description: ' 剪藏 ' }).asset.description, '剪藏');
});

// ── normalizeSkill ───────────────────────────────────────────────────────

test('normalizeSkill：entry 必填且转正斜杠，files 规整，contents/metadata 缺省回空对象', () => {
  const res = M.normalizeSkill({
    name: ' pdf ',
    entry: 'SKILL.md',
    files: ['assets\\a.md', 'assets\\a.md', '', '  b.txt  ', 'b.txt'],
    contents: 'not-an-object',
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.asset.name, 'pdf');
  assert.strictEqual(res.asset.entry, 'SKILL.md');
  assert.deepStrictEqual(res.asset.files, ['assets/a.md', 'b.txt'], '同形重复与空白项被去掉，反斜杠归一');
  assert.deepStrictEqual(res.asset.contents, {});
  assert.deepStrictEqual(res.asset.metadata, {});
  assert.strictEqual(M.normalizeSkill({ name: 'x' }).error, 'skill.entry 不能为空(技能主文件的相对路径)');
  assert.strictEqual(M.normalizeSkill({ entry: 'SKILL.md' }).error, 'skill.name 不能为空');
  assert.strictEqual(M.normalizeSkill(undefined).error, 'skill 必须是对象');
  assert.strictEqual(M.normalizeSkill({ name: 'x', entry: '   ' }).ok, false);
});

test('KNOWN-DEFECT: assetModel.js:418 normalizeSkill 先去重后转正斜杠，混合分隔符的同一路径留下重复项', () => {
  // File: assetModel.js:418 `_strArray(input.files).map((f) => f.replace(/\\/g, '/'))`.
  // _strArray (assetModel.js:127-139) dedupes on the *raw* strings, so a manifest written by a
  // Windows tool that lists the same file once with `\` and once with `/` survives as two
  // entries that only become byte-identical afterwards. The helper's own doc promises
  // "字符串数组规整:去空、去重、保序" and normalizeSkill is the single gate every adapter passes
  // through (validateAsset → normalizeSkill), so the emitted IR is not canonical: `files` still
  // carries the duplicate, and feeding the IR back through the gate gives a *different* array —
  // i.e. normalization is not idempotent on its own output.
  const mixed = M.normalizeSkill({ name: 'x', entry: 'SKILL.md', files: ['assets\\a.md', 'assets/a.md'] });
  assert.deepStrictEqual(mixed.asset.files, ['assets/a.md', 'assets/a.md']);
  assert.strictEqual(mixed.asset.files.length, 2, '去重承诺落空：两条实为同一个文件');
  const clean = M.normalizeSkill({ name: 'x', entry: 'SKILL.md', files: ['assets/a.md'] });
  assert.deepStrictEqual(clean.asset.files, ['assets/a.md']);
  // 二次规整会收敛，说明这就是「规整没跑完」而不是设计选择。
  const twice = M.normalizeSkill({ name: 'x', entry: 'SKILL.md', files: mixed.asset.files });
  assert.deepStrictEqual(twice.asset.files, ['assets/a.md'], '同输入再过一遍才去重');
  // 低危边界：contentHash 自己又跑了一遍 _strArray（assetModel.js:557），把重复项吃掉，
  // 所以假哈希/假冲突不成立；本仓库也没有任何适配器读取 asset.files（grep 只见赋值）。
  assert.strictEqual(M.contentHash(mixed.asset), M.contentHash(clean.asset));
});

// ── validateAsset ────────────────────────────────────────────────────────

test('validateAsset 按 kind 分派，未知 kind 回错并列出合法集', () => {
  assert.strictEqual(M.validateAsset(' memory ', { id: 'a', content: '' }).ok, true);
  assert.match(M.validateAsset('', {}).error, /未知资产类型:\(空\)/);
  assert.match(M.validateAsset(null, {}).error, /未知资产类型:\(空\)/);
  assert.match(M.validateAsset('prompt', {}).error, /未知资产类型:prompt/);
  assert.match(M.validateAsset('prompt', {}).error, /仅 memory\/tool\/skill/);
});

test('KNOWN-DEFECT: assetModel.js:450 validateAsset 查表无 own-property 守卫，原型链键绕过校验与兜底', () => {
  // File: assetModel.js:450 `const fn = _NORMALIZERS[k];` — an inherited Object.prototype key
  // is truthy, so the "unknown kind" fallback never runs and the inherited member is *called*
  // as a normalizer. The result is whatever that call returns rather than the documented
  // `{ ok, asset } | { ok, error }` envelope: 'constructor' hands the caller's own input
  // straight back (identity-equal!), so every downstream reader of `.ok` sees undefined and
  // the failure is silently unlabelled instead of reporting "未知资产类型".
  const input = { id: 'a', content: 'x' };
  assert.strictEqual(M.validateAsset('constructor', input), input);
  assert.strictEqual(M.validateAsset('constructor', input).ok, undefined);
  assert.strictEqual(M.validateAsset('toString', input), '[object Undefined]');
  assert.strictEqual(typeof M.validateAsset('toString', input), 'string');
  // valueOf throws on a null this — only the surrounding try/catch keeps that in contract.
  assert.strictEqual(M.validateAsset('valueOf', input).ok, false);
  assert.match(M.validateAsset('valueOf', input).error, /资产校验异常/);
  // Contrast: the guard is present for keys that are merely absent.
  assert.strictEqual(M.validateAsset('definitely_not_a_kind', input).ok, false);
});

// ── assetIdentity ────────────────────────────────────────────────────────

test('assetIdentity：memory 用 scope:id（缺 scope 按 project），tool/skill 用 name，非对象回空串', () => {
  assert.strictEqual(M.assetIdentity({ kind: 'memory', scope: 'global', id: 'a' }), 'global:a');
  assert.strictEqual(M.assetIdentity({ kind: 'memory', id: ' a ' }), 'project:a');
  assert.strictEqual(M.assetIdentity({ kind: 'tool', name: ' fs ' }), 'fs');
  assert.strictEqual(M.assetIdentity({ kind: 'skill', name: 'pdf' }), 'pdf');
  assert.strictEqual(M.assetIdentity({ name: 'no-kind' }), 'no-kind');
  for (const junk of [null, undefined, 0, 'str', [], true]) {
    assert.strictEqual(M.assetIdentity(junk), '');
  }
});

// ── contentHash ──────────────────────────────────────────────────────────

test('contentHash 只吃语义内容：键序、来源路径、mtime、raw 都不参与判等', () => {
  const a = M.validateAsset('memory', { ...HASHABLE_MEMORY, source: { tool: 'opencode', path: 'x/a.md' } }).asset;
  const b = M.validateAsset('memory', {
    content: '用 pnpm',
    title: '项目约定',
    tags: ['build'],
    id: 'conv',
    scope: 'project',
    source: { tool: 'claude-code', path: 'projects/y/memory/b.md' },
    updatedAt: '2026-01-01T00:00:00Z',
    raw: { frontmatterText: 'name: conv' },
  }).asset;
  assert.strictEqual(M.contentHash(a), M.contentHash(b));
  assert.match(M.contentHash(a), /^[0-9a-f]{64}$/);
  const changed = { ...b, tags: ['build', 'pnpm'] };
  assert.notStrictEqual(M.contentHash(changed), M.contentHash(b));
  assert.notStrictEqual(M.contentHash({ ...b, title: '另一个标题' }), M.contentHash(b));
});

test('contentHash 对 tags 顺序不敏感、对 memory 的 scope 敏感', () => {
  const t1 = M.validateAsset('memory', { id: 'a', content: 'c', tags: ['x', 'y'] }).asset;
  const t2 = M.validateAsset('memory', { id: 'a', content: 'c', tags: ['y', 'x'] }).asset;
  assert.strictEqual(M.contentHash(t1), M.contentHash(t2));
  assert.notStrictEqual(M.contentHash({ ...t1, scope: 'global' }), M.contentHash(t1));
});

test('contentHash 剥掉被提升的 spec 键与凭据占位，导出去回写后仍判等', () => {
  const before = M.validateAsset('tool', { name: 'fs', kind: 'mcp_server', description: 'd', spec: { command: 'x' } }).asset;
  const after = M.validateAsset('tool', {
    kind: 'tool',
    name: 'fs',
    toolKind: 'mcp_server',
    description: 'd',
    spec: { command: 'x', kind: 'mcp_server', description: 'd', API_KEY: M.REDACTED },
    source: { tool: 'khy-os', path: 'tools.json' },
  }).asset;
  assert.strictEqual(M.contentHash(before), M.contentHash(after));
  const withKey = M.validateAsset('tool', { name: 'fs', kind: 'mcp_server', description: 'd', spec: { command: 'x', API_KEY: 'sk-real' } }).asset;
  assert.notStrictEqual(M.contentHash(withKey), M.contentHash(before), '真凭据值参与判等，占位符不参与');
});

test('contentHash 把技能主文件正文入哈希而排除其文件名，附属文件按内容判等', () => {
  const dir = M.validateAsset('skill', {
    name: 'pdf', entry: 'SKILL.md', files: ['assets/a.md'],
    contents: { 'SKILL.md': '主文件正文', 'assets/a.md': '附件' },
  }).asset;
  const single = M.validateAsset('skill', {
    name: 'pdf', entry: 'pdf.md', files: [],
    contents: { 'pdf.md': '主文件正文' },
  }).asset;
  assert.strictEqual(M.contentHash({ ...dir, entry: 'pdf.md', contents: { 'pdf.md': '主文件正文', 'assets/a.md': '附件' } }),
    M.contentHash(dir), '主文件叫什么名是布局而非内容');
  assert.notStrictEqual(M.contentHash(single), M.contentHash(dir), '少了附属文件就是不同内容');
  assert.notStrictEqual(M.contentHash({ ...dir, contents: { 'SKILL.md': '改过的正文', 'assets/a.md': '附件' } }),
    M.contentHash(dir));
});

test('contentHash 对未知 kind / 非对象 / 循环 spec 一律回空串（调用方据此判「无法比较」）', () => {
  assert.strictEqual(M.contentHash({ kind: 'prompt', name: 'x' }), '');
  assert.strictEqual(M.contentHash(null), '');
  assert.strictEqual(M.contentHash('memory'), '');
  assert.strictEqual(M.contentHash({}), '');
  const cyclic = M.validateAsset('tool', { name: 'a', kind: 'builtin', spec: {} }).asset;
  cyclic.spec.self = cyclic.spec;
  assert.strictEqual(M.contentHash(cyclic), '', '循环 spec 不抛，退化成空哈希');
});

// ── decideSync ───────────────────────────────────────────────────────────

test('decideSync 四态：都不存在 noop / 只有源 create / 只有目标 noop / 哈希一致 in-sync', () => {
  assert.deepStrictEqual(M.decideSync(null, null),
    { action: 'noop', reason: '两侧都不存在', newer: 'unknown', sourceHash: '', targetHash: '' });
  const mem = M.validateAsset('memory', HASHABLE_MEMORY).asset;
  const created = M.decideSync(mem, null);
  assert.strictEqual(created.action, 'create');
  assert.strictEqual(created.newer, 'source');
  assert.strictEqual(created.sourceHash, M.contentHash(mem));
  assert.strictEqual(created.targetHash, '');
  const onlyTarget = M.decideSync(null, mem);
  assert.strictEqual(onlyTarget.action, 'noop');
  assert.strictEqual(onlyTarget.reason, '仅目标侧存在,本方向不动它');
  assert.strictEqual(onlyTarget.newer, 'target');
  const same = M.decideSync(mem, { ...mem, source: { tool: 'x', path: 'y', format: '', redactedFields: [] } });
  assert.strictEqual(same.action, 'in-sync');
  assert.strictEqual(same.newer, 'unknown');
});

test('decideSync 同名不同内容一律 conflict，绝不返回覆盖；时间戳只决定 newer', () => {
  const src = M.validateAsset('memory', { ...HASHABLE_MEMORY, content: '新内容', updatedAt: '2026-09-01T00:00:00Z' }).asset;
  const dst = M.validateAsset('memory', { ...HASHABLE_MEMORY, content: '旧内容', updatedAt: '2026-08-01T00:00:00Z' }).asset;
  const res = M.decideSync(src, dst);
  assert.strictEqual(res.action, 'conflict');
  assert.match(res.reason, /同名但内容哈希不同/);
  assert.match(res.reason, /源侧更新时间较晚/);
  assert.strictEqual(res.newer, 'source');
  assert.strictEqual(M.decideSync(dst, src).newer, 'target');
  assert.match(M.decideSync(dst, src).reason, /目标侧更新时间较晚/);
});

test('decideSync 时间戳缺失或相等时 newer=unknown，且两侧哈希都取不到也判 conflict', () => {
  const a = M.validateAsset('memory', { ...HASHABLE_MEMORY, content: 'A' }).asset;
  const b = M.validateAsset('memory', { ...HASHABLE_MEMORY, content: 'B' }).asset;
  const eq = M.decideSync(
    { ...a, updatedAt: '2026-01-01T00:00:00Z' },
    { ...b, updatedAt: '2026-01-01T00:00:00.000Z' }
  );
  assert.strictEqual(eq.action, 'conflict');
  assert.strictEqual(eq.newer, 'unknown');
  assert.match(eq.reason, /两侧时间戳无法比较/);
  const bothBad = M.decideSync({ kind: 'prompt', name: 'x' }, { kind: 'prompt', name: 'x' });
  assert.strictEqual(bothBad.action, 'conflict', '哈希为空串时不许误判 in-sync');
});

// ── 冲突副本命名 ─────────────────────────────────────────────────────────

test('conflictCopyName 内嵌工具名与哈希前 8 位，重复调用逐字相同（幂等）', () => {
  const hash = '0123456789abcdef';
  const one = M.conflictCopyName('项目约定', 'Claude Code', hash);
  assert.strictEqual(one, '项目约定.conflict-claude-code-01234567');
  assert.strictEqual(M.conflictCopyName('项目约定', 'Claude Code', hash), one);
  assert.strictEqual(M.conflictCopyName('', '', ''), 'asset.conflict-unknown-nohash');
  assert.strictEqual(M.conflictCopyName('x', '-_-', 'abcdef'), 'x.conflict-unknown-abcdef');
});

test('conflictCopyPath 保留目录与扩展名，把副本后缀插在扩展名之前', () => {
  const hash = 'deadbeefcafe';
  assert.strictEqual(M.conflictCopyPath('memory/a.md', 'opencode', hash), 'memory/a.conflict-opencode-deadbeef.md');
  assert.strictEqual(M.conflictCopyPath('a.md', 'opencode', hash), 'a.conflict-opencode-deadbeef.md');
  assert.strictEqual(M.conflictCopyPath('memory\\a.b.md', 'OpenClaw', hash), 'memory/a.b.conflict-openclaw-deadbeef.md');
  assert.strictEqual(M.conflictCopyPath('.env', 'harness', hash), '.env.conflict-harness-deadbeef',
    '点文件不切扩展名：base.lastIndexOf(".") 为 0 时 dot > 0 不成立，整名当 stem');
  assert.strictEqual(M.conflictCopyPath('a/b/.env', 'harness', hash), 'a/b/.env.conflict-harness-deadbeef');
  assert.strictEqual(M.conflictCopyPath('md', 'harness', hash), 'md.conflict-harness-deadbeef', '无扩展名时后缀直接接尾');
  assert.strictEqual(M.conflictCopyPath('', 'harness', hash), '');
  assert.strictEqual(M.conflictCopyPath('   ', 'harness', hash), '');
});

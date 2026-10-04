'use strict';

/**
 * Colocated contract tests for codexWriter.js (config-only Codex 上游切换).
 * Batch 38 (C-4 test-colocated). Source file untouched.
 *
 * Isolation: setCodexUpstreamConfigOnly resolves ~/.codex / ~/.config/codex via
 * a lazy `require('os').homedir()` and has NO env seam, so `os.homedir` is
 * monkey-patched to a fresh fs.mkdtempSync() root around every write-capable
 * call and restored in the same `finally`. Every assertion that a produced
 * configPath starts with that temp root is part of the test, so a leak into the
 * real user home fails the case instead of silently writing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('node:path');

const cw = require('./codexWriter');
const MODULE_PATH = path.join(__dirname, 'codexWriter.js');

const tmpRoots = [];

/**
 * Runs `body(homedir)` with os.homedir() pointed at a fresh temp directory.
 * Returns whatever body returns; always restores the real homedir.
 */
function withFakeHome(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ccswitch-codex-'));
  tmpRoots.push(root);
  const real = os.homedir;
  os.homedir = () => root;
  try {
    return body(root);
  } finally {
    os.homedir = real;
  }
}

test.after(() => {
  for (const root of tmpRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* scratch cleanup is best effort */
    }
  }
});

test('sanitizeProviderName：小写、非法字符折叠为下划线、空结果回退 custom', () => {
  const f = cw.sanitizeProviderName;
  assert.equal(f('DeepSeek API'), 'deepseek_api');
  assert.equal(f('__Foo__Bar__'), 'foo__bar', '内部下划线保留，只裁首尾');
  assert.equal(f(''), 'custom');
  assert.equal(f('!!!'), 'custom', '全非法字符 → 空串 → custom 兜底');
  assert.equal(f(undefined), 'custom');
  assert.equal(f(123), '123', '数字名本身即合法 slug');
  assert.equal(f('a.b-c'), 'a_b_c', '点与连字符都被折叠（TOML 表名安全化）');
});

test('保留 id 集合是区分大小写的固定 5 项', () => {
  assert.deepEqual(
    [...cw.RESERVED_PROVIDER_IDS].sort(),
    // Measured sort order: 'ollama' sorts before 'openai' ('l' < 'p').
    ['amazon-bedrock-runtime', 'lmstudio', 'ollama', 'openai', 'openai-experimental']
  );
});

test('preflightCodexWrite：六道必填门按名字逐个拒绝，不写盘', () => {
  const base = { providerName: 'p', baseUrl: 'https://a.com/v1', model: 'm', apiKey: 'k' };
  assert.deepEqual(cw.preflightCodexWrite({}), { ok: false, reason: 'providerName 是必填项' });
  assert.deepEqual(cw.preflightCodexWrite({ ...base, providerName: '' }), { ok: false, reason: 'providerName 是必填项' });
  assert.deepEqual(cw.preflightCodexWrite({ ...base, baseUrl: '' }), { ok: false, reason: 'baseUrl 是必填项' });
  assert.deepEqual(
    cw.preflightCodexWrite({ ...base, baseUrl: 'not a url' }),
    { ok: false, reason: 'baseUrl 必须是合法的 http(s) URL: not a url' }
  );
  assert.deepEqual(cw.preflightCodexWrite({ ...base, model: '' }), {
    ok: false,
    reason: 'model 是必填项（切换后 Codex 用不到当前模型会直接失败）',
  });
  assert.deepEqual(cw.preflightCodexWrite({ ...base, apiKey: '' }), {
    ok: false,
    reason: '既无 API 密钥也未标记 requiresOpenaiAuth —— 0.149 无法加载这种无凭据第三方表',
  });
  assert.deepEqual(cw.preflightCodexWrite(base), { ok: true });
});

test('KNOWN-DEFECT preflightCodexWrite.baseUrl：文案承诺 http(s)，实现只做 new URL()，file:// 与 javascript: 都放行', () => {
  // Measured input → output: both non-http schemes satisfy the gate.
  for (const bad of ['file:///C:/WINDOWS/system32/config.toml', 'javascript:alert(1)', 'data:text/plain,x']) {
    assert.deepEqual(
      cw.preflightCodexWrite({ providerName: 'p', baseUrl: bad, model: 'm', apiKey: 'k' }),
      { ok: true },
      bad
    );
  }
  // Asymmetry: the only scheme-shaped strings new URL() rejects are the ones
  // without a parseable scheme at all, so the 「http(s)」 promise is unenforced.
});

test('preflightCodexWrite：provider 名 sanitize 后落在保留 id 上即拒绝（大小写不敏感来自 sanitize）', () => {
  assert.deepEqual(
    cw.preflightCodexWrite({ providerName: 'Ollama!', baseUrl: 'https://a', model: 'm', apiKey: 'k' }),
    { ok: false, reason: 'provider 名「Ollama!」落在 Codex 保留 id 上（ollama），无法加载' }
  );
  // requiresOpenaiAuth without a key is allowed but warned about.
  assert.deepEqual(
    cw.preflightCodexWrite({ providerName: 'p', baseUrl: 'https://a', model: 'm', requiresOpenaiAuth: true }),
    { ok: true, warn: '无自有密钥且 requiresOpenaiAuth=true —— 将回退官方登录' }
  );
});

test('resolveCodexConfigPaths：.codex 优先于 .config/codex，两者皆无时回退首个候选', () => {
  withFakeHome((root) => {
    const bare = cw.resolveCodexConfigPaths();
    assert.equal(bare.configPath, path.join(root, '.codex', 'config.toml'));
    assert.equal(bare.authPath, path.join(root, '.codex', 'auth.json'));
    assert.ok(bare.configPath.startsWith(root), 'path must stay inside the temp home');

    fs.mkdirSync(path.join(root, '.config', 'codex'), { recursive: true });
    fs.writeFileSync(path.join(root, '.config', 'codex', 'config.toml'), 'x = 1\n');
    assert.deepEqual(cw.resolveCodexConfigPaths(), {
      dir: path.join(root, '.config', 'codex'),
      configPath: path.join(root, '.config', 'codex', 'config.toml'),
      authPath: path.join(root, '.config', 'codex', 'auth.json'),
    });

    fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codex', 'config.toml'), 'model = "old"\n');
    assert.equal(cw.resolveCodexConfigPaths().dir, path.join(root, '.codex'), '存在 config.toml 的 .codex 胜出');
  });
});

test('首次切换写入 provider 表、前言键与 .khy-bak 备份，全部落在临时家目录', () => {
  withFakeHome(() => {
    const r = cw.setCodexUpstreamConfigOnly({
      providerName: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: 'sk-real',
      wireApi: 'chat',
    });
    assert.equal(r.success, true);
    assert.equal(r.provider, 'deepseek');
    assert.equal(r.wireApi, 'chat');
    assert.ok(r.configPath.startsWith(os.tmpdir()), '写入目标必须在临时目录内：' + r.configPath);
    const content = fs.readFileSync(r.configPath, 'utf-8');
    assert.ok(content.includes('[model_providers.deepseek]\nname = "deepseek"\n'), '表头与 name 相邻');
    assert.ok(content.includes('base_url = "https://api.deepseek.com/v1"'));
    assert.ok(content.includes('wire_api = "chat"'));
    assert.ok(content.includes('experimental_bearer_token = "sk-real"'), 'key 写在 provider 表内，不进 auth.json');
    assert.ok(content.includes('model_provider = "deepseek"'), '前言键被补上');
    assert.ok(content.includes('model = "deepseek-chat"'));
    assert.ok(!fs.existsSync(path.join(path.dirname(r.configPath), 'auth.json')), 'auth.json 不被创建');
    assert.deepEqual(r.detail, { renames: [], backfills: [], migrated: false, authJsonTouched: false });
    // The empty-file first write has nothing to back up.
    assert.equal(fs.existsSync(`${r.configPath}.khy-bak`), false, '原文件不存在时不留备份');
  });
});

test('已有配置时备份 .khy-bak 为改写前的原始字节', () => {
  withFakeHome(() => {
    const first = cw.setCodexUpstreamConfigOnly({ providerName: 'A', baseUrl: 'https://a.com/v1', model: 'ma', apiKey: 'k1' });
    const afterFirst = fs.readFileSync(first.configPath, 'utf-8');
    const second = cw.setCodexUpstreamConfigOnly({ providerName: 'B', baseUrl: 'https://b.com/v1', model: 'mb', apiKey: 'k2' });
    assert.equal(second.provider, 'b');
    assert.equal(fs.readFileSync(`${second.configPath}.khy-bak`, 'utf-8'), afterFirst, '备份 = 本次改写前内容');
    const content = fs.readFileSync(second.configPath, 'utf-8');
    // Old provider table survives (only the SAME table is rewritten), while the
    // preamble keys are replaced in place, not duplicated.
    assert.ok(content.includes('[model_providers.a]'));
    assert.equal(content.match(/^model = /gm).length, 1, '前言 model 只出现一次（upsert 而非追加）');
    assert.equal(content.match(/^model_provider = /gm).length, 1);
    assert.ok(content.includes('model_provider = "b"'));
    assert.ok(content.includes('model = "mb"'));
  });
});

test('wireApi 归一：仅 chat/responses 合法，其余（含大小写混写之外的垃圾值）回退 responses', () => {
  withFakeHome(() => {
    const upper = cw.setCodexUpstreamConfigOnly({ providerName: 'U', baseUrl: 'https://u.com/v1', model: 'm', apiKey: 'k', wireApi: 'CHAT' });
    assert.equal(upper.wireApi, 'chat', '大小写被 lower 后接受');
    const bogus = cw.setCodexUpstreamConfigOnly({ providerName: 'V', baseUrl: 'https://v.com/v1', model: 'm', apiKey: 'k', wireApi: ' completions ' });
    assert.equal(bogus.wireApi, 'responses', '非法值回退默认');
    const omitted = cw.setCodexUpstreamConfigOnly({ providerName: 'W', baseUrl: 'https://w.com/v1', model: 'm', apiKey: 'k' });
    assert.equal(omitted.wireApi, 'responses', '缺省即 responses');
  });
});

test('requiresOpenaiAuth 写真 flag 且允许无密钥；空入参整批拒绝', () => {
  withFakeHome(() => {
    const r = cw.setCodexUpstreamConfigOnly({
      providerName: 'OAuth',
      baseUrl: 'https://o.com/v1',
      model: 'm',
      requiresOpenaiAuth: true,
    });
    assert.equal(r.success, true);
    const content = fs.readFileSync(r.configPath, 'utf-8');
    assert.ok(content.includes('requires_openai_auth = true'));
    assert.ok(!content.includes('experimental_bearer_token'), '无 key 时不写 bearer token');
    assert.deepEqual(cw.setCodexUpstreamConfigOnly(), { success: false, error: 'providerName 是必填项' });
    assert.equal(cw.setCodexUpstreamConfigOnly({ providerName: 'openai', baseUrl: 'https://a', model: 'm', apiKey: 'k' }).success, false);
  });
});

test('auth.json 策略：默认保留官方登录，preserveOfficialLogin=false 且有 key 时删除', () => {
  withFakeHome((root) => {
    const codexDir = path.join(root, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const authPath = path.join(codexDir, 'auth.json');
    fs.writeFileSync(authPath, '{"OPENAI_API_KEY":"official"}');

    const keep = cw.setCodexUpstreamConfigOnly({ providerName: 'K', baseUrl: 'https://k.com/v1', model: 'm', apiKey: 'sk' });
    assert.equal(keep.success, true);
    assert.equal(fs.existsSync(authPath), true, '默认 preserveOfficialLogin=true → 登录文件保留');
    assert.equal(keep.detail.authJsonTouched, false);

    const drop = cw.setCodexUpstreamConfigOnly({
      providerName: 'D',
      baseUrl: 'https://d.com/v1',
      model: 'm',
      apiKey: 'sk',
      preserveOfficialLogin: false,
    });
    assert.equal(fs.existsSync(authPath), false, '带 key + 不保留登录 → auth.json 被删');
    assert.equal(drop.detail.authJsonTouched, true);

    // No key means the delete branch never runs, even with preserve off.
    fs.writeFileSync(authPath, '{"again":1}');
    const noKey = cw.setCodexUpstreamConfigOnly({
      providerName: 'N',
      baseUrl: 'https://n.com/v1',
      model: 'm',
      requiresOpenaiAuth: true,
      preserveOfficialLogin: false,
    });
    assert.equal(noKey.success, true);
    assert.equal(fs.existsSync(authPath), true, '无 key 不动 auth.json');
    assert.equal(noKey.detail.authJsonTouched, '', 'measured: 见下一条 KNOWN-DEFECT');
  });
});

test('KNOWN-DEFECT authJsonTouched：无 key 时字段是空字符串而不是 false（&& 短路把 apiKey 原文透出）', () => {
  withFakeHome((root) => {
    const codexDir = path.join(root, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const res = cw.setCodexUpstreamConfigOnly({
      providerName: 'NK',
      baseUrl: 'https://nk.com/v1',
      model: 'm',
      requiresOpenaiAuth: true,
      preserveOfficialLogin: false,
    });
    // `apiKey && !preserveOfficialLogin` short-circuits on the raw apiKey string.
    assert.equal(res.detail.authJsonTouched, '');
    assert.equal(typeof res.detail.authJsonTouched, 'string', '有 key 时同字段却是 boolean');
    const withKey = cw.setCodexUpstreamConfigOnly({
      providerName: 'WK',
      baseUrl: 'https://wk.com/v1',
      model: 'm',
      apiKey: 'sk',
      preserveOfficialLogin: true,
    });
    assert.equal(withKey.detail.authJsonTouched, false);
    assert.equal(typeof withKey.detail.authJsonTouched, 'boolean');
    assert.ok(codexDir.startsWith(root), '写盘必须落在临时家目录');
  });
});

test('_healLegacyShapes：保留 id 无损改名（body 字节不变），非保留表只在缺 name 时补', () => {
  const reserved = cw._healLegacyShapes('[model_providers.openai]\nbase_url = "x"\nname = "o"\n');
  assert.deepEqual(reserved, {
    content: '[model_providers.openai_khy]\nbase_url = "x"\nname = "o"\n',
    renames: [{ from: 'openai', to: 'openai_khy' }],
    backfills: [],
  });
  // Header whitespace is trimmed before the reserved-id comparison.
  assert.deepEqual(cw._healLegacyShapes('[model_providers.  openai  ]\nx = 1\n').renames, [
    { from: 'openai', to: 'openai_khy' },
  ]);
  const single = cw._healLegacyShapes('[model_providers.alpha]\nbase_url = "a"\n');
  assert.deepEqual(single, {
    content: '[model_providers.alpha]\nname = "alpha"\nbase_url = "a"\n',
    renames: [],
    backfills: ['alpha'],
  });
  assert.deepEqual(cw._healLegacyShapes(''), { content: '', renames: [], backfills: [] });
  assert.deepEqual(cw._healLegacyShapes('model = "only preamble"\n'), {
    content: 'model = "only preamble"\n',
    renames: [],
    backfills: [],
  });
  // A header with no body still gets its name backfilled (insert lands after
  // the header, so the trailing newline is consumed).
  assert.equal(cw._healLegacyShapes('[model_providers.a]').content, '[model_providers.a]\nname = "a"');
});

test('KNOWN-DEFECT _healLegacyShapes：Bedrock「刻意不命名」的豁免对保留 id 改名后失效', () => {
  // Measured: the skip guard compares `currentTable !== 'amazon-bedrock-runtime'`
  // but the rename already rewrote the header to amazon_bedrock_runtime_khy,
  // so the table is renamed AND named — the exact combo the docstring forbids.
  const r = cw._healLegacyShapes('[model_providers.amazon-bedrock-runtime]\nbase_url="x"\n');
  assert.deepEqual(r.renames, [{ from: 'amazon-bedrock-runtime', to: 'amazon_bedrock_runtime_khy' }]);
  assert.deepEqual(r.backfills, ['amazon_bedrock_runtime_khy']);
  assert.ok(r.content.includes('name = "amazon_bedrock_runtime_khy"'));
  // A non-reserved bedrock table is the only shape the exemption actually honors.
  assert.deepEqual(cw._healLegacyShapes('[model_providers.amazon-bedrock-runtime]\nname = "keep"\n').backfills, []);
});

test('KNOWN-DEFECT _healLegacyShapes：两张 provider 表且前一张缺 name 时永不返回（实测子进程 3s 超时）', () => {
  // Bounded reproduction: the repair loop splices a `name` line at a stale
  // index, which re-presents the same header to the still-running for-loop and
  // it splices again — unbounded growth. Run in a child so the suite survives.
  const hanging = '[model_providers.alpha]\nbase_url = "a"\n\n[model_providers.beta]\nbase_url = "b"\n';
  const src =
    `const cw = require(${JSON.stringify(MODULE_PATH)});\n` +
    `cw._healLegacyShapes(${JSON.stringify(hanging)});\n`;
  const r = cp.spawnSync(process.execPath, ['-e', src], { timeout: 3000, encoding: 'utf-8' });
  assert.equal(r.error && r.error.code, 'ETIMEDOUT', '输入含 2 张 provider 表时函数不收敛');
  assert.equal(r.stdout, '');
  // Contrast (terminates): the same file with the FIRST table named.
  const ok = cw._healLegacyShapes('[model_providers.alpha]\nname = "a"\n\n[model_providers.beta]\nbase_url = "b"\n');
  assert.deepEqual(ok.backfills, ['beta']);
});

test('_collectProviderTables 取表名与首行行号，点分表名整体视为一个名字', () => {
  const content = 'k = 1\n\n[model_providers.foo]\nbase_url = "a"\n\n[other]\nx = 1\n\n[model_providers.bar]\nname = "b"\n';
  assert.deepEqual(cw._collectProviderTables(content), [
    { name: 'foo', index: 2 },
    { name: 'bar', index: 8 },
  ]);
  assert.deepEqual(cw._collectProviderTables('[model_providers.a.b]\nx=1\n'), [{ name: 'a.b', index: 0 }]);
  assert.deepEqual(cw._collectProviderTables('nothing here\n'), []);
  assert.deepEqual(cw._collectProviderTables(''), []);
});

test('_migrateLegacyOpenaiBaseUrl：把顶层路由搬进 cc_switch_legacy 表，wire_api 固定 responses', () => {
  const r = cw._migrateLegacyOpenaiBaseUrl('openai_base_url = "https://x/v1"\nmodel = "m"\n');
  assert.equal(r.migrated, true);
  assert.equal(r.providerName, 'cc_switch_legacy');
  assert.equal(
    r.content,
    '\nmodel = "m"\n\n[model_providers.cc_switch_legacy]\nname = "cc_switch_legacy"\nbase_url = "https://x/v1"\nwire_api = "responses"\n'
  );
  assert.deepEqual(cw._migrateLegacyOpenaiBaseUrl('nothing\n'), { content: 'nothing\n', migrated: false, providerName: '' });
  assert.deepEqual(cw._migrateLegacyOpenaiBaseUrl(''), { content: '', migrated: false, providerName: '' });
  // 幂等：迁移后源键已消失，第二次调用原样返回。
  assert.equal(cw._migrateLegacyOpenaiBaseUrl(r.content).migrated, false);
  // 只认双引号写法。
  assert.equal(cw._migrateLegacyOpenaiBaseUrl("openai_base_url = 'https://x'\n").migrated, false);
});

test('KNOWN-DEFECT _migrateLegacyOpenaiBaseUrl：正则不判断层级，表内的同名键也会被吞掉', () => {
  // `openai_base_url` inside a [section] body belongs to that table, yet the
  // /m-anchored regex matches it and deletes the line while claiming the key
  // was a "legacy top-level route".
  const r = cw._migrateLegacyOpenaiBaseUrl('[my.table]\nopenai_base_url = "https://y"\nk = 1\n');
  assert.equal(r.migrated, true);
  assert.ok(!r.content.includes('https://y"') || r.content.indexOf('https://y') > r.content.indexOf('[my.table]'));
  assert.ok(r.content.includes('[my.table]\n\n'), '表体里的键被替换成空行，[my.table] 变成空表');
});

test('切换会先修形再迁移：保留 id 改名 + 顶层路由迁移在同一轮生效', () => {
  withFakeHome(() => {
    // Seed a legacy shape: reserved id table (named, so the repair loop
    // terminates) plus a top-level openai_base_url route.
    const seed = [
      '[model_providers.openai]',
      'name = "openai"',
      'base_url = "https://legacy/v1"',
      '',
      'openai_base_url = "https://legacy-route/v1"',
      '',
    ].join('\n');
    const first = cw.setCodexUpstreamConfigOnly({ providerName: 'New', baseUrl: 'https://new.com/v1', model: 'm', apiKey: 'k' });
    fs.writeFileSync(first.configPath, seed);
    const r = cw.setCodexUpstreamConfigOnly({ providerName: 'New', baseUrl: 'https://new.com/v1', model: 'm', apiKey: 'k' });
    assert.equal(r.success, true);
    assert.deepEqual(r.detail.renames, [{ from: 'openai', to: 'openai_khy' }]);
    assert.equal(r.detail.migrated, true);
    const content = fs.readFileSync(r.configPath, 'utf-8');
    assert.ok(content.includes('[model_providers.openai_khy]'));
    assert.ok(content.includes('[model_providers.cc_switch_legacy]'));
    assert.ok(content.includes('[model_providers.new]'));
    assert.equal(content.match(/^openai_base_url = /gm), null, '顶层路由键已移除');
  });
});

test('导出面只暴露公共 API 与四个内部整形函数', () => {
  assert.deepEqual(Object.keys(cw).sort(), [
    'RESERVED_PROVIDER_IDS',
    '_collectProviderTables',
    '_healLegacyShapes',
    '_migrateLegacyOpenaiBaseUrl',
    'preflightCodexWrite',
    'resolveCodexConfigPaths',
    'sanitizeProviderName',
    'setCodexUpstreamConfigOnly',
  ].sort());
  // upsertPreambleKey / removeTomlSection stay private.
  assert.equal(cw.upsertPreambleKey, undefined);
  assert.equal(cw.removeTomlSection, undefined);
});

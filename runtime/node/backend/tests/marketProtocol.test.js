'use strict';

/**
 * khy-market/1 translation protocol + StepFun live adapter.
 *
 * Run: node --test tests/marketProtocol.test.js
 *
 * The StepFun fixture never touches the network: every case injects `fetch`,
 * and cache keys use a unique base URL so cases cannot see each other's state.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const protocol = require('../src/services/marketProtocol');
const stepfun = require('../src/services/marketProtocol/stepfunOpenclaw');
const vscode = require('../src/services/marketProtocol/vscodeMarketplace');
const kimi = require('../src/services/marketProtocol/kimiCode');
const mcpRegistry = require('../src/services/marketProtocol/mcpRegistry');
const { parseManifestJson } = require('../src/services/domain/extensions/extensions/extensionManifest');
const extensionRoots = require('../src/services/domain/extensions/extensions/extensionRoots');

function asset(overrides) {
  return {
    assetId: 'asset-1',
    assetType: 2,
    name: 'demo-skill',
    displayName: '演示技能',
    description: '短介绍',
    longDescription: '完整介绍：做一件事。',
    latestSemver: '1.2.3',
    author: { displayName: '作者甲', userId: 'user-1', avatarUrl: 'https://example.test/a.png' },
    tags: [{ displayName: '标签一' }, { displayName: '标签二' }],
    downloadCount: '17',
    totalStars: '3',
    ...overrides,
  };
}

function okJson(payload) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  };
}

function fetchByType(byType) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const handler = byType[body.assetType];
    if (typeof handler === 'function') return handler(body, url);
    if (handler === undefined) return okJson({ items: [] });
    return handler;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('JSON5 manifest: comments and trailing commas parse; garbage stays null', () => {
  const parsed = parseManifestJson(`{
    // identity
    "id": "voice-call",
    "skills": ["skills/a", "skills/b",],
    /* config */
    "configSchema": { "type": "object", },
  }`);
  assert.deepStrictEqual(parsed, {
    id: 'voice-call',
    skills: ['skills/a', 'skills/b'],
    configSchema: { type: 'object' },
  });
  assert.strictEqual(parseManifestJson('{ not json'), null);
  assert.deepStrictEqual(parseManifestJson('{"a":1}'), { a: 1 });
});

test('OpenClaw JSON5 manifest reaches the extension loader, not just the parser', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-market-json5-'));
  try {
    const dir = path.join(base, 'voice-call');
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'openclaw.plugin.json'),
      `{
        // shipped by OpenClaw plugins, JSON5 dialect
        "id": "voice-call",
        "name": "Voice Call",
        "contracts": { "tools": ["call.start", "call.end",], },
      }`
    );
    const found = extensionRoots.discover({
      env: { KHY_EXTENSION_PATH: base },
      includeDisabled: true,
    });
    const ext = found.find((item) => item.id === 'voice-call');
    assert.ok(ext, 'JSON5 manifest must be discovered, not silently skipped');
    assert.strictEqual(ext.manifestFile, 'openclaw.plugin.json');
    assert.strictEqual(ext.isLegacyFormat, true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('catalog entry: direct skill keeps its native CLI command', () => {
  const canonical = protocol.fromCatalogEntry(
    {
      name: 'archify',
      upstreamUrl: 'https://github.com/tt-a1i/archify',
      type: 'skill',
      khyosMarket: 'skill',
      compat: 'direct',
      license: 'Apache-2.0',
      what: 'agent skill',
    },
    'deepseek-harness'
  );
  assert.strictEqual(canonical.protocol, 'khy-market/1');
  assert.strictEqual(canonical.route.market, 'skill');
  assert.strictEqual(canonical.route.compat, 'direct');
  assert.strictEqual(canonical.install.khyos, 'khy skill add https://github.com/tt-a1i/archify');
  assert.strictEqual(canonical.blocker, undefined);
});

test('catalog entry: blockers are structural, not prose', () => {
  const licensed = protocol.fromCatalogEntry(
    { name: 'gpl-tool', upstreamUrl: 'https://github.com/x/y', type: 'plugin', khyosMarket: 'extension', compat: 'blocked', license: 'GPL-3.0' },
    'zcode'
  );
  assert.strictEqual(licensed.blocker.code, 'license-c');
  assert.strictEqual(licensed.blocker.resolution, 'human-approval');

  const surface = protocol.fromCatalogEntry(
    { name: 'desktop', upstreamUrl: 'https://github.com/x/d', type: 'plugin', khyosMarket: 'none', compat: 'blocked', license: 'MIT' },
    'deepseek-harness'
  );
  assert.strictEqual(surface.blocker.code, 'unsupported-surface');
  assert.strictEqual(surface.blocker.resolution, 'not-supported');
});

test('catalog entry: covered means native capability, not a weaker block', () => {
  const canonical = protocol.fromCatalogEntry(
    {
      name: 'dsh-context',
      upstreamUrl: 'https://github.com/bowenliang123/dsh-context',
      type: 'plugin',
      khyosMarket: 'skill',
      compat: 'covered',
      license: 'Apache-2.0',
      blockerNote: 'khyos 的 tokenUsageService 已覆盖上下文与成本面板。',
    },
    'deepseek-harness'
  );
  assert.strictEqual(canonical.route.compat, 'covered');
  assert.strictEqual(canonical.route.market, 'none');
  assert.strictEqual(canonical.route.adapter, null);
  assert.strictEqual(canonical.install.khyos, undefined);
  assert.strictEqual(canonical.blocker.code, 'covered-by-native');
  assert.strictEqual(canonical.blocker.resolution, 'use-native');
  assert.ok(canonical.blocker.note.includes('tokenUsageService'));
});

test('catalog entry: skill-add adapter names the skill subdirectory', () => {
  const canonical = protocol.fromCatalogEntry(
    {
      name: 'modlens',
      upstreamUrl: 'https://github.com/liustack/modlens',
      type: 'plugin',
      khyosMarket: 'skill',
      compat: 'adapter-needed',
      adapter: 'skill-add',
      skillSubdir: 'skills/modlens',
      license: 'MIT',
    },
    'deepseek-harness'
  );
  assert.strictEqual(canonical.route.market, 'skill');
  assert.strictEqual(canonical.route.adapter, 'skill-add');
  assert.strictEqual(
    canonical.install.khyos,
    'khy skill add https://github.com/liustack/modlens --skill skills/modlens'
  );
});

test('catalog entry: an explicit khyCommand wins over command synthesis', () => {
  const canonical = protocol.fromCatalogEntry(
    {
      name: 'dsh-find-plugin',
      upstreamUrl: 'https://github.com/awesome-dsh-plugin/dsh-find-plugin',
      khyCommand: 'node delivery/extension/tools/khy-dsh-compat/lib/importPlugin.js dsh-find-plugin --allow-network',
      type: 'plugin',
      khyosMarket: 'extension',
      compat: 'adapter-needed',
      license: 'MIT',
    },
    'deepseek-harness'
  );
  assert.strictEqual(
    canonical.install.khyos,
    'node delivery/extension/tools/khy-dsh-compat/lib/importPlugin.js dsh-find-plugin --allow-network'
  );
});

test('delivery/market catalogs: compat values and blocked lists stay in sync', () => {
  const root = path.resolve(__dirname, '../../../../delivery/market');
  const indexPath = path.join(root, 'index.json');
  // The catalog is not part of the published package, so a shipped install has
  // nothing to check here; only an in-repo run asserts the catalog contract.
  if (!fs.existsSync(indexPath)) return;
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  for (const item of index.ecosystems) {
    const catalog = JSON.parse(fs.readFileSync(path.join(root, item.file), 'utf8'));
    const entries = catalog.entries || [];
    const blockedNames = new Set((catalog.blocked || []).map((entry) => entry.name));
    for (const entry of entries) {
      assert.ok(
        protocol.COMPAT_VALUES.includes(entry.compat),
        `${item.eco}/${entry.name} 的 compat 非法：${entry.compat}`
      );
      if (entry.compat === 'blocked') {
        assert.ok(blockedNames.has(entry.name), `${item.eco}/${entry.name} 标为阻塞但未进 blocked 列表`);
      }
    }
    const entryNames = new Set(entries.map((entry) => entry.name));
    for (const name of blockedNames) {
      assert.ok(entryNames.has(name), `${item.eco}/${name} 只在 blocked 列表里，entries 中缺兼容判定`);
    }
  }
});

test('annotateEntry keeps survey prose and adds the protocol block', () => {
  const annotated = protocol.annotateEntry(
    { name: 'wshobson/agents', upstreamUrl: 'https://github.com/wshobson/agents', type: 'plugin', khyosMarket: 'extension', compat: 'adapter-needed', compatNote: '需适配', what: '原介绍' },
    'claude-code'
  );
  assert.strictEqual(annotated.compatNote, '需适配');
  assert.strictEqual(annotated.what, '原介绍');
  assert.strictEqual(annotated.protocol.id, 'khy-market/1');
  assert.strictEqual(annotated.protocol.market, 'extension');
});

test('OpenClaw manifest: tools route to extension and never invent schemas', () => {
  const canonical = protocol.fromOpenClawManifest({
    manifest: {
      id: 'voice-call',
      name: 'Voice Call',
      version: '0.4.0',
      contracts: { tools: ['call.start', { name: 'call.end' }] },
      skills: ['skills/dial'],
      mcpServers: { phone: { command: 'phone-mcp' } },
      providers: ['twilio'],
    },
    packageJson: { main: 'dist/index.js', license: 'MIT', repository: { url: 'https://github.com/acme/voice-call' } },
    source: { eco: 'openclaw' },
  });
  assert.strictEqual(canonical.route.market, 'extension');
  assert.strictEqual(canonical.route.compat, 'adapter-needed');
  assert.strictEqual(canonical.route.adapter, 'openclaw-manifest');
  assert.deepStrictEqual(canonical.khyManifest.tools, []);
  assert.strictEqual(canonical.khyManifest.main, 'dist/index.js');
  assert.strictEqual(canonical.khyManifest.skills[0], 'skills/dial');
  assert.strictEqual(canonical.capabilities.filter((c) => c.type === 'tool').length, 2);
});

test('OpenClaw manifest: provider-only plugins are an unsupported surface', () => {
  const canonical = protocol.fromOpenClawManifest({
    manifest: { id: 'provider-x', providers: ['x'], channels: ['slack'] },
    packageJson: { license: 'MIT' },
  });
  assert.strictEqual(canonical.route.market, 'none');
  assert.strictEqual(canonical.route.compat, 'blocked');
  assert.strictEqual(canonical.blocker.code, 'unsupported-surface');
  assert.strictEqual(canonical.khyManifest, null);
});

test('OpenClaw manifest: skill roots route to skill import', () => {
  const canonical = protocol.fromOpenClawManifest({
    manifest: { id: 'skill-pack', agentSkillsDir: 'skills' },
    packageJson: { license: 'Apache-2.0' },
  });
  assert.strictEqual(canonical.route.market, 'skill');
  assert.strictEqual(canonical.install.khyos, 'khy skill import <抽出的技能目录>');
});

test('StepFun asset: skill keeps upstream identity and offers both commands', () => {
  const canonical = protocol.fromOpenClawAsset(asset(), {
    baseUrl: 'https://market.test/',
    nowMs: Date.parse('2026-11-02T00:00:00Z'),
  });
  assert.strictEqual(canonical.kind, 'skill');
  assert.strictEqual(canonical.route.market, 'skill');
  assert.strictEqual(canonical.route.compat, 'adapter-needed');
  assert.strictEqual(canonical.install.upstream, 'openclawmp install skill/asset-1');
  assert.strictEqual(canonical.install.khyos, 'khy skill import <解压后的技能目录>');
  assert.strictEqual(canonical.description, '完整介绍：做一件事。');
  assert.strictEqual(canonical.author.avatarUrl, 'https://example.test/a.png');
  assert.strictEqual(canonical.source.url, 'https://market.test/asset/asset-1');
  assert.strictEqual(canonical.blocker.code, 'license-unknown');

  const row = protocol.toCatalogEntry(canonical);
  assert.strictEqual(row.command, 'openclawmp install skill/asset-1');
  assert.strictEqual(row.khyCommand, 'khy skill import <解压后的技能目录>');
  assert.strictEqual(row.avatarUrl, 'https://example.test/a.png');
  assert.strictEqual(row.protocol.market, 'skill');
});

test('StepFun asset: six types map to three routes plus honest blockers', () => {
  const cases = [
    [3, 'extension', 'adapter-needed'],
    [6, 'skill', 'adapter-needed'],
    [1, 'none', 'blocked'],
    [4, 'none', 'blocked'],
    [5, 'none', 'blocked'],
    [99, 'none', 'blocked'],
  ];
  for (const [assetType, market, compat] of cases) {
    const canonical = protocol.fromOpenClawAsset(asset({ assetType }), { baseUrl: 'https://market.test' });
    assert.strictEqual(canonical.route.market, market, `type ${assetType}`);
    assert.strictEqual(canonical.route.compat, compat, `type ${assetType}`);
  }
});

test('openClawSkillSource ignores paths outside a skills/<owner>/<name> directory', () => {
  assert.strictEqual(protocol.openClawSkillSource('no link here'), null);
  assert.strictEqual(
    protocol.openClawSkillSource('https://github.com/openclaw/skills/tree/main/docs'),
    null
  );
  assert.deepStrictEqual(
    protocol.openClawSkillSource('(https://github.com/openclaw/skills/tree/main/skills/l-fy/myfeed)'),
    { repoUrl: 'https://github.com/openclaw/skills', subdir: 'skills/l-fy/myfeed' }
  );
});

test('StepFun asset: ClawHub skill filed under trigger/connector routes by source path', () => {
  const source =
    '📦 ClawHub: [l-fy/myfeed](https://clawhub.ai/l-fy/myfeed)\n' +
    '📂 Source: [openclaw/skills](https://github.com/openclaw/skills/tree/main/skills/l-fy/myfeed)';
  const trigger = protocol.fromOpenClawAsset(asset({ assetType: 4, longDescription: source }), {
    baseUrl: 'https://market.test',
  });
  assert.strictEqual(trigger.kind, 'skill');
  assert.strictEqual(trigger.route.market, 'skill');
  assert.strictEqual(trigger.route.compat, 'adapter-needed');
  assert.strictEqual(trigger.route.adapter, 'skill-extract');
  assert.strictEqual(trigger.install.upstream, 'openclawmp install trigger/asset-1');
  assert.strictEqual(
    trigger.install.khyos,
    'khy skill add https://github.com/openclaw/skills --skill skills/l-fy/myfeed'
  );

  const connector = protocol.fromOpenClawAsset(asset({ assetType: 5, longDescription: source }), {
    baseUrl: 'https://market.test',
  });
  assert.strictEqual(connector.kind, 'skill');
  assert.strictEqual(connector.install.upstream, 'openclawmp install channel/asset-1');
  const row = protocol.toCatalogEntry(connector);
  assert.strictEqual(row.type, 'skill');
  assert.strictEqual(
    row.khyCommand,
    'khy skill add https://github.com/openclaw/skills --skill skills/l-fy/myfeed'
  );
});

function tarEntry(name, content) {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.write('0'.repeat(8), 148, 8, 'ascii');
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, pad]);
}

function tarOf(entries) {
  return Buffer.concat([...entries.map(([name, content]) => tarEntry(name, content)), Buffer.alloc(1024)]);
}

test('StepFun archive probe: tar listing finds the SKILL.md directory', () => {
  const names = stepfun.tarNames(tarOf([['demo/SKILL.md', '# demo'], ['demo/run.py', 'print(1)']]));
  assert.deepStrictEqual(names, ['demo/SKILL.md', 'demo/run.py']);
  assert.strictEqual(stepfun.skillDirOf(names), 'demo');
  assert.strictEqual(stepfun.skillDirOf(['README.md']), '');
});

test('StepFun archive probe: blocked assets with SKILL.md reroute to skill, others stay blocked', async () => {
  const archives = {
    'probe-skill': tarOf([['demo/SKILL.md', '# demo'], ['demo/run.py', 'print(1)']]),
    'probe-text': tarOf([['README.md', 'just words']]),
  };
  const fetchImpl = async (url, init) => {
    if (init && init.body) {
      const body = JSON.parse(init.body);
      if (body.assetType !== undefined) {
        if (body.assetType !== 1) return okJson({ items: [] });
        return okJson({
          items: [
            asset({
              assetType: 1,
              assetId: 'probe-skill',
              name: 'knowledge-skill',
              displayName: 'knowledge-skill',
              longDescription: '无链接',
            }),
            asset({
              assetType: 1,
              assetId: 'probe-text',
              name: 'knowledge-text',
              displayName: 'knowledge-text',
              longDescription: '无链接',
            }),
          ],
        });
      }
      return okJson({ downloadUrl: `https://cdn.test/${body.assetId}.tar` });
    }
    const key = url.replace('https://cdn.test/', '').replace('.tar', '');
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => archives[key],
    };
  };

  const ecosystem = await stepfun.fetchStepfunEcosystem({
    baseUrl: 'https://market.test',
    fetch: fetchImpl,
    pageSize: 5,
    probeArtifacts: true,
    nowMs: Date.parse('2026-11-02T00:00:00Z'),
  });

  const byName = Object.fromEntries(ecosystem.entries.map((entry) => [entry.name, entry]));
  assert.strictEqual(byName['knowledge-skill'].compat, 'adapter-needed');
  assert.strictEqual(byName['knowledge-skill'].khyosMarket, 'skill');
  assert.strictEqual(byName['knowledge-skill'].protocol.adapter, 'openclawmp-archive');
  assert.strictEqual(byName['knowledge-skill'].khyCommand, 'khy skill import <解压后的技能目录>');
  assert.match(byName['knowledge-skill'].targetPath, /demo/);
  assert.strictEqual(byName['knowledge-text'].compat, 'blocked');
  assert.strictEqual(ecosystem.blocked.length, 1);
  assert.ok(ecosystem.uncertainties.some((line) => line.includes('归档探测') && line.includes('1 条命中')));
});

test('StepFun fetch: all six types are queried and mapped', async () => {
  const fetchImpl = fetchByType({
    2: () => okJson({ items: [asset({ assetId: 's1' })] }),
    3: () => okJson({ items: [asset({ assetId: 'p1', assetType: 3, name: 'plug' })] }),
    6: () => okJson({ items: [asset({ assetId: 'a1', assetType: 6, name: 'agent' })] }),
    1: () => okJson({ items: [asset({ assetId: 'e1', assetType: 1, name: 'exp' })] }),
    4: () => okJson({ items: [asset({ assetId: 't1', assetType: 4, name: 'trig' })] }),
    5: () => okJson({ items: [asset({ assetId: 'c1', assetType: 5, name: 'conn' })] }),
  });

  const ecosystem = await stepfun.fetchStepfunEcosystem({
    baseUrl: 'https://market.test',
    fetch: fetchImpl,
    nowMs: Date.parse('2026-11-02T00:00:00Z'),
    pageSize: 5,
  });

  assert.strictEqual(fetchImpl.calls.length, 6);
  assert.deepStrictEqual(
    fetchImpl.calls.map((call) => call.body.assetType).sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6]
  );
  assert.strictEqual(ecosystem.eco, 'stepfun-openclaw');
  assert.strictEqual(ecosystem.entries.length, 6);
  assert.strictEqual(ecosystem.blocked.length, 3);
  assert.strictEqual(ecosystem.entries[0].what, '完整介绍：做一件事。');
  assert.ok(ecosystem.uncertainties.some((line) => line.includes('每类资产只取最新 5 条')));
});

test('StepFun fetch: one failed type degrades without losing the others', async () => {
  const fetchImpl = fetchByType({
    2: () => okJson({ items: [asset()] }),
    3: () => ({ ok: false, status: 503, text: async () => JSON.stringify({ message: 'upstream down' }) }),
  });

  const ecosystem = await stepfun.fetchStepfunEcosystem({
    baseUrl: 'https://market.test',
    fetch: fetchImpl,
  });

  assert.strictEqual(ecosystem.entries.length, 1);
  assert.ok(ecosystem.uncertainties.some((line) => line.includes('plugin') && line.includes('503')));
});

test('StepFun fetch: every type failing is an actionable error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => '' });
  await assert.rejects(
    () => stepfun.fetchStepfunEcosystem({ baseUrl: 'https://market.test', fetch: fetchImpl }),
    /阶跃水产市场读取失败.*修复：检查网络/
  );
});

test('StepFun cache: TTL hit, force refresh, and stale fallback', async () => {
  const baseUrl = 'https://cache.test';
  let fail = false;
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    if (fail) return { ok: false, status: 502, text: async () => 'bad gateway' };
    const { assetType } = JSON.parse(init.body);
    return okJson({ items: assetType === 2 ? [asset()] : [] });
  };

  const first = await stepfun.getStepfunEcosystem({ baseUrl, fetch: fetchImpl, nowMs: 1000, ttlMs: 60000 });
  assert.strictEqual(first.entries.length, 1);
  assert.strictEqual(calls, 6);

  const cached = await stepfun.getStepfunEcosystem({ baseUrl, fetch: fetchImpl, nowMs: 2000, ttlMs: 60000 });
  assert.strictEqual(cached, first);
  assert.strictEqual(calls, 6);

  fail = true;
  const stale = await stepfun.getStepfunEcosystem({ baseUrl, fetch: fetchImpl, nowMs: 100000, ttlMs: 60000 });
  assert.strictEqual(stale.stale, true);
  assert.strictEqual(stale.entries.length, 1);
  assert.ok(stale.uncertainties.some((line) => line.includes('本次刷新失败')));
  assert.strictEqual(calls, 12);
});

test('VS Code extension: MCP provider routes to mcp, themes are not an artifact', () => {
  const mcp = protocol.fromVsCodeExtension(
    {
      namespace: 'acme',
      name: 'tool-mcp',
      displayName: 'Tool MCP',
      description: 'bundles a server',
      version: '1.0.0',
      license: 'Apache-2.0',
      files: { icon: 'https://cdn.test/icon.png', manifest: 'https://cdn.test/package.json' },
      publishedBy: { fullName: 'Acme', loginName: 'acme' },
      downloadCount: 42,
      categories: ['AI'],
    },
    { name: 'tool-mcp', main: './dist/extension.js', contributes: { mcpServerDefinitionProviders: [{ id: 'a' }] } },
    { baseUrl: 'https://openvsx.test' }
  );
  assert.strictEqual(mcp.kind, 'mcp');
  assert.strictEqual(mcp.route.market, 'mcp');
  assert.strictEqual(mcp.route.compat, 'adapter-needed');
  assert.strictEqual(mcp.route.adapter, 'vscode-mcp-provider');
  assert.strictEqual(mcp.install.upstream, 'code --install-extension acme.tool-mcp');
  assert.strictEqual(mcp.author.avatarUrl, 'https://cdn.test/icon.png');
  assert.strictEqual(mcp.source.license, 'Apache-2.0');
  assert.strictEqual(mcp.blocker, undefined);

  const theme = protocol.fromVsCodeExtension(
    { namespace: 'acme', name: 'theme', displayName: 'Theme', license: 'MIT' },
    { name: 'theme', contributes: { themes: [{ label: 'Dark', uiTheme: 'vs-dark', path: './d.json' }] } },
    { baseUrl: 'https://openvsx.test' }
  );
  assert.strictEqual(theme.route.compat, 'blocked');
  assert.strictEqual(theme.blocker.code, 'not-an-artifact');

  const agpl = protocol.fromVsCodeExtension(
    { namespace: 'acme', name: 'gpl', displayName: 'GPL', license: 'AGPL-3.0' },
    { name: 'gpl', main: './out.js' },
    { baseUrl: 'https://openvsx.test' }
  );
  assert.strictEqual(agpl.route.compat, 'blocked');
  assert.strictEqual(agpl.blocker.code, 'license-c');
});

test('VS Code live fetch: search, detail and package.json are merged', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/api/-/search')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          extensions: [{ namespace: 'acme', name: 'tool-mcp', displayName: 'Tool MCP', version: '1.0.0' }],
        }),
      };
    }
    if (url.endsWith('/api/acme/tool-mcp')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          namespace: 'acme',
          name: 'tool-mcp',
          displayName: 'Tool MCP',
          description: 'bundles a server',
          version: '1.0.0',
          license: 'MIT',
          downloadCount: 7,
          files: { icon: 'https://cdn.test/icon.png', manifest: 'https://cdn.test/acme/package.json' },
        }),
      };
    }
    if (url === 'https://cdn.test/acme/package.json') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ name: 'tool-mcp', main: './out.js', contributes: { mcpServerDefinitionProviders: [{}] } }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const ecosystem = await vscode.fetchVsCodeEcosystem({
    baseUrl: 'https://openvsx.test',
    fetch: fetchImpl,
    queries: ['mcp'],
    size: 3,
  });

  assert.strictEqual(ecosystem.eco, 'vscode');
  assert.strictEqual(ecosystem.entries.length, 1);
  assert.strictEqual(ecosystem.entries[0].khyosMarket, 'mcp');
  assert.strictEqual(ecosystem.entries[0].license, 'MIT');
  assert.ok(ecosystem.uncertainties.some((line) => line.includes('Open VSX')));
  assert.ok(ecosystem.uncertainties.some((line) => line.includes('下载量前 3 条')));
});

test('Kimi plugin: skill roots produce a khy skill add command; agents stay blocked', () => {
  const skill = protocol.fromKimiPlugin(
    { id: 'go', displayName: 'Go', source: 'https://github.com/acme/kimi-go' },
    {
      name: 'go',
      version: '1.0.0',
      license: 'MIT',
      description: 'go rules',
      interface: { displayName: 'Go', shortDescription: 'go rules' },
      skills: './skills/',
    },
    { repoUrl: 'https://github.com/acme/kimi-go' }
  );
  assert.strictEqual(skill.kind, 'skill');
  assert.strictEqual(skill.route.market, 'skill');
  assert.strictEqual(skill.route.adapter, 'kimi-skill-extract');
  assert.strictEqual(skill.install.khyos, 'khy skill add https://github.com/acme/kimi-go --skill skills');
  assert.strictEqual(skill.blocker, undefined);

  const agents = protocol.fromKimiPlugin(
    { id: 'crew', displayName: 'Crew', source: 'https://github.com/acme/crew' },
    { name: 'crew', license: 'MIT', agents: ['./agents/'] },
    { repoUrl: 'https://github.com/acme/crew' }
  );
  assert.strictEqual(agents.route.compat, 'blocked');
  assert.strictEqual(agents.blocker.code, 'unsupported-surface');
});

test('Kimi live fetch: marketplace JSON resolves plugin repo manifests', async () => {
  const marketplaceUrl = 'https://kimi.test/marketplace.json';
  const fetchImpl = async (url) => {
    if (url === marketplaceUrl) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: '2', plugins: [{ id: 'go', displayName: 'Go', source: 'https://github.com/acme/kimi-go' }] }),
      };
    }
    if (url.startsWith('https://raw.githubusercontent.com/acme/kimi-go/HEAD/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ name: 'go', license: 'MIT', skills: ['./skills/'] }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const ecosystem = await kimi.fetchKimiEcosystem({
    marketplaceUrls: [marketplaceUrl],
    fetch: fetchImpl,
  });

  assert.strictEqual(ecosystem.eco, 'kimi-code');
  assert.strictEqual(ecosystem.entries.length, 1);
  assert.strictEqual(ecosystem.entries[0].khyCommand, 'khy skill add https://github.com/acme/kimi-go --skill skills');
  assert.strictEqual(ecosystem.blocked.length, 0);
  assert.ok(ecosystem.marketplaces.some((source) => source.url === marketplaceUrl));
});

test('Kimi source parsing: GitHub tree URLs keep ref and subdirectory', () => {
  assert.deepStrictEqual(kimi.parseGitHubSource('https://github.com/acme/pack/tree/dev/plugins/go'), {
    repoUrl: 'https://github.com/acme/pack',
    owner: 'acme',
    repo: 'pack',
    ref: 'dev',
    subdir: 'plugins/go',
  });
  assert.strictEqual(
    kimi.parseGitHubSource('https://example.test/pack.zip').repoUrl,
    'https://example.test/pack.zip'
  );
});

function registryRow(server, status) {
  return {
    server,
    _meta: {
      'io.modelcontextprotocol.registry/official': {
        status: status || 'active',
        publishedAt: '2026-01-02T03:04:05Z',
        updatedAt: '2026-01-02T03:04:05Z',
      },
    },
  };
}

test('MCP Registry: npm package becomes a direct stdio install spec', () => {
  const canonical = protocol.fromMcpRegistryServer(
    registryRow({
      name: 'io.github.acme/fetch',
      title: 'Fetch',
      description: 'fetch urls',
      version: '1.2.3',
      repository: { url: 'https://github.com/acme/fetch' },
      packages: [
        {
          registryType: 'npm',
          identifier: '@acme/mcp-fetch',
          version: '1.2.3',
          transport: { type: 'stdio' },
          environmentVariables: [
            { name: 'ACME_TOKEN', description: 'token', isRequired: true, isSecret: true },
            { name: 'ACME_MODE', description: 'optional mode' },
          ],
        },
      ],
    }),
    { eco: 'mcp-registry' }
  );
  assert.strictEqual(canonical.kind, 'mcp');
  assert.strictEqual(canonical.route.market, 'mcp');
  assert.strictEqual(canonical.route.compat, 'direct');
  assert.deepStrictEqual(canonical.install.spec, {
    mode: 'mcp',
    name: 'io-github-acme-fetch',
    scope: 'user',
    config: { type: 'stdio', command: 'npx', args: ['-y', '@acme/mcp-fetch'] },
  });
  assert.deepStrictEqual(
    canonical.install.requires.env.map((item) => item.name),
    ['ACME_TOKEN', 'ACME_MODE']
  );
  assert.strictEqual(canonical.source.url, 'https://github.com/acme/fetch');

  const entry = protocol.toCatalogEntry(canonical);
  assert.strictEqual(entry.installSpec.mode, 'mcp');
  assert.strictEqual(entry.publishedAt, '2026-01-02T03:04:05Z');
  assert.strictEqual(entry.installRequires.env.length, 2);
});

test('MCP Registry: pypi/oci runtimes and remote endpoints stay installable', () => {
  const pypi = protocol.fromMcpRegistryServer(
    registryRow({
      name: 'io.github.acme/pkg',
      version: '1.0.0',
      packages: [
        {
          registryType: 'pypi',
          identifier: 'mcp-server-fetch',
          runtimeHint: 'uvx',
          runtimeArguments: [{ type: 'positional', value: '--quiet' }],
        },
      ],
    }),
    { eco: 'mcp-registry' }
  );
  assert.deepStrictEqual(pypi.install.spec.config, {
    type: 'stdio',
    command: 'uvx',
    args: ['--quiet', 'mcp-server-fetch'],
  });

  const oci = protocol.fromMcpRegistryServer(
    registryRow({
      name: 'io.github.acme/image',
      packages: [{ registryType: 'oci', identifier: 'docker.io/acme/mcp:1' }],
    }),
    { eco: 'mcp-registry' }
  );
  assert.deepStrictEqual(oci.install.spec.config.args, ['run', '-i', '--rm', 'docker.io/acme/mcp:1']);

  const remote = protocol.fromMcpRegistryServer(
    registryRow({
      name: 'io.github.acme/remote',
      remotes: [
        {
          type: 'streamable-http',
          url: 'https://mcp.acme.dev/mcp',
          headers: [
            { name: 'Authorization', isRequired: true, isSecret: true, value: 'Bearer {token}' },
            { name: 'X-Static', value: 'ok' },
          ],
        },
      ],
    }),
    { eco: 'mcp-registry' }
  );
  assert.deepStrictEqual(remote.install.spec.config, {
    type: 'http',
    url: 'https://mcp.acme.dev/mcp',
    headers: { 'X-Static': 'ok' },
  });
  assert.deepStrictEqual(remote.install.requires.headers.map((item) => item.name), ['Authorization']);
});

test('MCP Registry: inactive or untranslatable rows become honest blockers', () => {
  const deleted = protocol.fromMcpRegistryServer(
    registryRow({ name: 'io.github.acme/gone', remotes: [{ type: 'stdio', url: 'https://x.test' }] }, 'deleted'),
    { eco: 'mcp-registry' }
  );
  assert.strictEqual(deleted.route.compat, 'blocked');
  assert.strictEqual(deleted.blocker.code, 'user-decision');

  const unsupported = protocol.fromMcpRegistryServer(
    registryRow({
      name: 'io.github.acme/nuget',
      packages: [{ registryType: 'nuget', identifier: 'Acme.Mcp' }],
    }),
    { eco: 'mcp-registry' }
  );
  assert.strictEqual(unsupported.route.market, 'none');
  assert.strictEqual(unsupported.blocker.code, 'unsupported-surface');
  assert.strictEqual(unsupported.install.spec, undefined);
});

test('MCP Registry live fetch: dedupes servers and reports counts', async () => {
  const baseUrl = 'https://registry.test';
  const fetchImpl = async (url) => {
    const query = new URL(url).searchParams.get('search');
    const row = registryRow({
      name: `io.github.acme/${query}-server`,
      title: `${query} server`,
      remotes: [{ type: 'streamable-http', url: `https://mcp.acme.dev/${query}` }],
    });
    return { ok: true, status: 200, json: async () => ({ servers: [row], metadata: { count: 1 } }) };
  };

  const ecosystem = await mcpRegistry.fetchMcpRegistryEcosystem({
    baseUrl,
    queries: ['filesystem', 'github', 'filesystem'],
    size: 5,
    fetch: fetchImpl,
  });

  assert.strictEqual(ecosystem.eco, 'mcp-registry');
  assert.strictEqual(ecosystem.entries.length, 2);
  assert.strictEqual(ecosystem.blocked.length, 0);
  assert.ok(ecosystem.entries.every((entry) => entry.installSpec.mode === 'mcp'));
  assert.strictEqual(ecosystem.counts.servers, 2);
});

test('parseKhyCommand: skill commands become source + subdirectory specs', () => {
  assert.deepStrictEqual(protocol.parseKhyCommand('khy skill add acme/pack'), {
    mode: 'skill',
    source: 'acme/pack',
    skills: [],
  });
  assert.deepStrictEqual(protocol.parseKhyCommand('khy skill add acme/pack --skill skills/demo'), {
    mode: 'skill',
    source: 'acme/pack',
    skills: ['skills/demo'],
  });
  assert.strictEqual(protocol.parseKhyCommand('node scripts/import.js x'), null);
});

test('parseKhyCommand: mcp commands reuse the khy mcp add config shape', () => {
  assert.deepStrictEqual(
    protocol.parseKhyCommand('khy mcp add ouroboros -- uvx --from ouroboros-ai ouroboros mcp serve'),
    {
      mode: 'mcp',
      name: 'ouroboros',
      scope: 'user',
      config: { type: 'stdio', command: 'uvx', args: ['--from', 'ouroboros-ai', 'ouroboros', 'mcp', 'serve'] },
    }
  );
  assert.deepStrictEqual(protocol.parseKhyCommand('khy mcp add remote --transport http --url https://mcp.test/v1'), {
    mode: 'mcp',
    name: 'remote',
    scope: 'user',
    config: { type: 'http', url: 'https://mcp.test/v1' },
  });
});

test('catalog entries expose installSpec when the khy command is executable', () => {
  const canonical = protocol.fromCatalogEntry(
    {
      name: 'demo',
      upstreamUrl: 'https://github.com/acme/demo',
      type: 'skill',
      khyosMarket: 'skill',
      compat: 'direct',
      khyCommand: 'khy skill add https://github.com/acme/demo --skill skills/demo',
    },
    'demo-eco'
  );
  assert.deepStrictEqual(canonical.install.spec, {
    mode: 'skill',
    source: 'https://github.com/acme/demo',
    skills: ['skills/demo'],
  });
  const entry = protocol.toCatalogEntry(canonical);
  assert.deepStrictEqual(entry.installSpec, canonical.install.spec);

  const annotated = protocol.annotateEntry(
    {
      name: 'native',
      upstreamUrl: 'https://github.com/acme/native',
      type: 'skill',
      khyosMarket: 'skill',
      compat: 'direct',
      khyCommand: 'khy skill add https://github.com/acme/native',
      what: '已勘定条目',
    },
    'demo-eco'
  );
  assert.strictEqual(annotated.what, '已勘定条目');
  assert.strictEqual(annotated.installSpec.mode, 'skill');
  assert.strictEqual(annotated.installSpec.source, 'https://github.com/acme/native');
});

test('Kimi skill plugin carries a multi-skill installSpec and drops it when blocked', () => {
  const canonical = protocol.fromKimiPlugin(
    { id: 'demo', source: 'https://github.com/acme/demo' },
    { name: 'demo', license: 'MIT', skills: ['skills/a', 'skills/b'] },
    { repoUrl: 'https://github.com/acme/demo' }
  );
  assert.deepStrictEqual(canonical.install.spec, {
    mode: 'skill',
    source: 'https://github.com/acme/demo',
    skills: ['skills/a', 'skills/b'],
  });

  const blocked = protocol.fromKimiPlugin(
    { id: 'gpl', source: 'https://github.com/acme/gpl' },
    { name: 'gpl', license: 'GPL-3.0', skills: ['skills/a'] },
    { repoUrl: 'https://github.com/acme/gpl' }
  );
  assert.strictEqual(blocked.route.compat, 'blocked');
  assert.strictEqual(blocked.install.spec, undefined);
});

test('domain categories prefer the upstream field and fall back to a deterministic text read', () => {
  assert.deepStrictEqual(protocol.categoryOf({ category: 'Themes', name: 'dracula' }), {
    key: 'design',
    label: '设计媒体',
    source: 'upstream',
  });
  assert.deepStrictEqual(protocol.categoryOf({ category: 'Data Science,Other', name: 'x' }), {
    key: 'data',
    label: '数据与分析',
    source: 'upstream',
  });
  assert.strictEqual(protocol.categoryOf({ name: 'excel-mcp', what: '读写 Excel 表格' }).key, 'office');
  assert.strictEqual(protocol.categoryOf({ name: 'com-acme-data-github-changelog' }).key, 'data');
  // A pure "UI" mention must not outrank an explicit red-team description.
  assert.strictEqual(
    protocol.categoryOf({ name: 'dsh-purge', what: '红队工具：宿主级篡改 + UI/session 面' }).key,
    'security'
  );
  assert.deepStrictEqual(protocol.categoryOf({ name: 'modlens' }), {
    key: 'other',
    label: '其他',
    source: 'default',
  });
});

test('catalog entries and surveyed entries expose the same category fields', () => {
  const live = protocol.toCatalogEntry(
    protocol.fromVsCodeExtension(
      { namespace: 'acme', name: 'themes', displayName: 'Acme Themes', categories: ['Themes'], license: 'MIT', files: {} },
      { main: 'out/extension.js' },
      { eco: 'vscode', baseUrl: 'https://open-vsx.org' }
    )
  );
  assert.strictEqual(live.category, 'design');
  assert.strictEqual(live.categoryLabel, '设计媒体');
  assert.strictEqual(live.categorySource, 'upstream');

  const surveyed = protocol.annotateEntry(
    { name: 'excel-helper', upstreamUrl: 'https://github.com/acme/excel-helper', type: 'skill', what: '批量处理表格' },
    'demo-eco'
  );
  assert.strictEqual(surveyed.category, 'office');
  assert.strictEqual(surveyed.categoryLabel, '办公效率');
  assert.strictEqual(surveyed.categorySource, 'derived');
});


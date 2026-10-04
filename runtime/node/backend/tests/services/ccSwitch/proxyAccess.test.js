'use strict';

/**
 * DESIGN-ARCH-101 代理模式测试：
 *   - proxyAccess.resolveProxyAccess()  端点/令牌发现 + fail-soft 状态透明
 *   - proxyAccess.resolvePoolKeyFromCard() / buildProxyCard()  池映射与字段替换
 *   - appWriters.applyCardToApp(mode:'proxy')  写代理接入 + agentMode 回写
 *
 * 隔离手段：全部用 KHY_DATA_HOME 指向临时目录（dataHome 四级解析的第一级），
 * 并 resetModules 让 dataHome/proxyAccess 重新解析。绝不触碰真实 ~/.khy。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CC_SWITCH_MODULE = '../../../src/services/domain/config/ccSwitch';

function makeTempDataHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'khy-proxyaccess-'));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

/** 在指定 dataHome 下加载一份全新的模块（绕过 module 级缓存）。 */
function loadFresh(dataHome) {
  jest.resetModules();
  process.env.KHY_DATA_HOME = dataHome;
  delete process.env.KHY_PROXY_ENDPOINT;
  return {
    proxyAccess: require(`${CC_SWITCH_MODULE}/proxyAccess.js`),
    appWriters: require(`${CC_SWITCH_MODULE}/appWriters.js`),
    constants: require(`${CC_SWITCH_MODULE}/constants.js`),
  };
}

const ORIGINAL_DATA_HOME = process.env.KHY_DATA_HOME;
const ORIGINAL_ENDPOINT = process.env.KHY_PROXY_ENDPOINT;
let tempHomes = [];

afterEach(() => {
  for (const dir of tempHomes) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  tempHomes = [];
  if (ORIGINAL_DATA_HOME === undefined) delete process.env.KHY_DATA_HOME;
  else process.env.KHY_DATA_HOME = ORIGINAL_DATA_HOME;
  if (ORIGINAL_ENDPOINT === undefined) delete process.env.KHY_PROXY_ENDPOINT;
  else process.env.KHY_PROXY_ENDPOINT = ORIGINAL_ENDPOINT;
  jest.resetModules();
});

function freshHome() {
  const dir = makeTempDataHome();
  tempHomes.push(dir);
  return dir;
}

/**
 * 隔离 agent 家目录并跑一段断言。
 *
 * ⚠ 不能只改 `HOME`：Windows 上 `os.homedir()` 读 `USERPROFILE`（实测本机
 * `HOME` 覆盖无效），且 homedir 可能被缓存。正解是用**适配器自己的 env 覆盖口**——
 * `claudeCodeAdapter.configPath()` 优先读 `CLAUDE_CONFIG_DIR`，这是既有的、
 * 确定性的隔离入口。finally 里逐字节还原。
 */
async function withAgentHome(fn) {
  const agentHome = freshHome();
  const claudeDir = path.join(agentHome, '.claude');
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  try {
    return await fn(claudeDir);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
}

describe('proxyAccess.resolveProxyAccess', () => {
  test('网关未运行时 fail-soft 且给出具体修复动作（状态透明）', () => {
    const { proxyAccess } = loadFresh(freshHome());
    const r = proxyAccess.resolveProxyAccess();
    expect(r.ok).toBe(false);
    expect(r.proxyEndpoint).toBe('');
    expect(r.proxyToken).toBe('');
    expect(r.source.endpoint).toBe('absent');
    expect(r.source.token).toBe('absent');
    // 修复动作必须可执行（规则 2.2：说清缺什么 + 怎么做）
    expect(r.error).toContain('修复动作');
    expect(r.error).toMatch(/gateway|KHY_PROXY_ENDPOINT/);
  });

  test('runtime + auth 文件齐备时返回端点与令牌', () => {
    const home = freshHome();
    writeJson(path.join(home, 'proxy_server_runtime.json'), {
      running: true,
      endpoint: 'http://127.0.0.1:9100',
      port: 9100,
      startedAt: new Date().toISOString(),
    });
    writeJson(path.join(home, 'proxy_server_auth.json'), {
      authToken: 'khy-0123456789abcdef0123456789abcdef0123456789abcdef',
    });
    const { proxyAccess } = loadFresh(home);
    const r = proxyAccess.resolveProxyAccess();
    expect(r.ok).toBe(true);
    expect(r.proxyEndpoint).toBe('http://127.0.0.1:9100');
    expect(r.proxyToken).toMatch(/^khy-[0-9a-f]{48}$/);
    expect(r.source.endpoint).toBe('runtime-file');
    expect(r.source.token).toBe('runtime-file');
  });

  test('端点尾斜杠被归一（避免拼接出 //v1）', () => {
    const home = freshHome();
    writeJson(path.join(home, 'proxy_server_runtime.json'), {
      running: true,
      endpoint: 'http://127.0.0.1:9100/',
      startedAt: new Date().toISOString(),
    });
    writeJson(path.join(home, 'proxy_server_auth.json'), { authToken: 'khy-abc' });
    const { proxyAccess } = loadFresh(home);
    expect(proxyAccess.resolveProxyAccess().proxyEndpoint).toBe('http://127.0.0.1:9100');
  });

  test('只有端点没有令牌 → ok:false 且报令牌缺失（不假装成功）', () => {
    const home = freshHome();
    writeJson(path.join(home, 'proxy_server_runtime.json'), {
      running: true,
      endpoint: 'http://127.0.0.1:9100',
      startedAt: new Date().toISOString(),
    });
    const { proxyAccess } = loadFresh(home);
    const r = proxyAccess.resolveProxyAccess();
    expect(r.ok).toBe(false);
    expect(r.proxyEndpoint).toBe('http://127.0.0.1:9100');
    expect(r.proxyToken).toBe('');
    expect(r.error).toContain('令牌');
  });

  test('runtime 文件过期（startedAt 超窗口）不被当作运行中', () => {
    const home = freshHome();
    writeJson(path.join(home, 'proxy_server_runtime.json'), {
      running: true,
      endpoint: 'http://127.0.0.1:9100',
      startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    });
    writeJson(path.join(home, 'proxy_server_auth.json'), { authToken: 'khy-abc' });
    const { proxyAccess } = loadFresh(home);
    const r = proxyAccess.resolveProxyAccess();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('端点');
  });

  test('env KHY_PROXY_ENDPOINT 优先于 runtime 文件（显式覆盖）', () => {
    const home = freshHome();
    writeJson(path.join(home, 'proxy_server_runtime.json'), {
      running: true,
      endpoint: 'http://127.0.0.1:9100',
      startedAt: new Date().toISOString(),
    });
    writeJson(path.join(home, 'proxy_server_auth.json'), { authToken: 'khy-abc' });
    jest.resetModules();
    process.env.KHY_DATA_HOME = home;
    process.env.KHY_PROXY_ENDPOINT = 'http://10.0.0.5:9200';
    const proxyAccess = require(`${CC_SWITCH_MODULE}/proxyAccess.js`);
    const r = proxyAccess.resolveProxyAccess();
    expect(r.proxyEndpoint).toBe('http://10.0.0.5:9200');
    expect(r.source.endpoint).toBe('env');
  });

  test('损坏的 runtime 文件不抛异常（fail-soft）', () => {
    const home = freshHome();
    fs.writeFileSync(path.join(home, 'proxy_server_runtime.json'), '{ not json', 'utf-8');
    const { proxyAccess } = loadFresh(home);
    expect(() => proxyAccess.resolveProxyAccess()).not.toThrow();
    expect(proxyAccess.resolveProxyAccess().ok).toBe(false);
  });
});

describe('proxyAccess poolKey 解析与代理卡片构造', () => {
  test('keyId 命中密钥池 → poolKey 取池内 provider 名（pool-scan）', () => {
    const home = freshHome();
    const key = 'sk-deepseek-secret-abcdef';
    // keyId 口径 = md5(`${provider}:${key}`).slice(0,12)，与 apiKeyPool 一致
    const crypto = require('crypto');
    const keyId = crypto.createHash('md5').update(`deepseek:${key}`).digest('hex').slice(0, 12);
    writeJson(path.join(home, 'api_keys.json'), {
      deepseek: [{ key, endpoint: 'https://api.deepseek.com/v1', label: 'ds' }],
    });
    const { proxyAccess } = loadFresh(home);
    const r = proxyAccess.resolvePoolKeyFromCard({ name: 'DeepSeek 卡片', keyId }, { raw: true });
    expect(r.poolKey).toBe('deepseek');
    expect(r.source).toBe('pool-scan');
  });

  test('keyId 未命中 → 回退卡片名 slug（name-fallback，仍可路由）', () => {
    const home = freshHome();
    writeJson(path.join(home, 'api_keys.json'), { deepseek: [{ key: 'sk-other' }] });
    const { proxyAccess } = loadFresh(home);
    const r = proxyAccess.resolvePoolKeyFromCard({ name: 'DeepSeek V3', keyId: 'nope' }, { raw: true });
    expect(r.poolKey).toBe('deepseek_v3');
    expect(r.source).toBe('name-fallback');
  });

  test('密钥池缺失也不抛（回退 slug）', () => {
    const home = freshHome();
    const { proxyAccess } = loadFresh(home);
    const r = proxyAccess.resolvePoolKeyFromCard({ name: 'GLM', keyId: 'x' }, { raw: true });
    expect(r.poolKey).toBe('glm');
  });

  test('buildProxyCard 替换端点与模型名，不改动入参', () => {
    const home = freshHome();
    const { proxyAccess } = loadFresh(home);
    const card = {
      id: 'c_1',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      defaultModel: 'deepseek-chat',
    };
    const proxied = proxyAccess.buildProxyCard(card, {
      proxyEndpoint: 'http://127.0.0.1:9100/',
      poolKey: 'deepseek',
    });
    expect(proxied.baseUrl).toBe('http://127.0.0.1:9100');
    expect(proxied.defaultModel).toBe('api:deepseek:deepseek-chat');
    // 原始卡片不被就地修改
    expect(card.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(card.defaultModel).toBe('deepseek-chat');
  });

  test('已是三段可路由模型名时不二次拼接（幂等）', () => {
    const home = freshHome();
    const { proxyAccess } = loadFresh(home);
    const proxied = proxyAccess.buildProxyCard(
      { name: 'X', baseUrl: 'https://x', defaultModel: 'api:custom:some-model' },
      { proxyEndpoint: 'http://127.0.0.1:9100', poolKey: 'deepseek' }
    );
    expect(proxied.defaultModel).toBe('api:custom:some-model');
  });
});

describe('appWriters.applyCardToApp —— 代理模式', () => {
  function seedProxy(home) {
    writeJson(path.join(home, 'proxy_server_runtime.json'), {
      running: true,
      endpoint: 'http://127.0.0.1:9100',
      startedAt: new Date().toISOString(),
    });
    writeJson(path.join(home, 'proxy_server_auth.json'), {
      authToken: 'khy-0123456789abcdef0123456789abcdef0123456789abcdef',
    });
  }

  const CARD = {
    id: 'c_proxy_1',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    keyId: '',
    protocol: 'openai',
    models: ['deepseek-chat'],
    defaultModel: 'deepseek-chat',
    apps: ['opencode'],
    enabled: true,
  };

  test('代理未运行时拒绝写入并报具体原因（不写入 agent 配置）', async () => {
    const home = freshHome();
    const { appWriters } = loadFresh(home);
    const r = await appWriters.applyCardToApp(CARD, 'opencode', { mode: 'proxy' });
    expect(r.success).toBe(false);
    expect(r.mode).toBe('proxy');
    expect(r.error).toContain('修复动作');
  });

  test('代理运行时跳过协议门（OpenAI 卡可写 Claude Code —— §4 桥接）', async () => {
    const home = freshHome();
    seedProxy(home);
    const { appWriters } = loadFresh(home);
    // direct 模式：OpenAI 卡对 Claude Code 仍可写但会给出转换提示（preflight 通过）
    const pre = appWriters.preflightCardForApp(
      { ...CARD, protocol: 'openai' },
      'claude-code',
      { mode: 'proxy' }
    );
    expect(pre.ok).toBe(true);
  });

  test('direct 模式仍保持历史协议约束（Codex 拒 gemini）', () => {
    const home = freshHome();
    const { appWriters } = loadFresh(home);
    const pre = appWriters.preflightCardForApp(
      { ...CARD, protocol: 'gemini' },
      'codex',
      { mode: 'direct' }
    );
    expect(pre.ok).toBe(false);
    expect(pre.reason).toContain('OpenAI');
  });

  test('缺 baseUrl 的卡在两种模式下都被拒', () => {
    const home = freshHome();
    const { appWriters } = loadFresh(home);
    const bad = { ...CARD, baseUrl: '' };
    expect(appWriters.preflightCardForApp(bad, 'opencode', { mode: 'proxy' }).ok).toBe(false);
    expect(appWriters.preflightCardForApp(bad, 'opencode', { mode: 'direct' }).ok).toBe(false);
  });

  test('代理模式成功后回写 store.agentMode（写必走正门 + 记账）', async () => {
    const home = freshHome();
    seedProxy(home);
    const { appWriters } = loadFresh(home);

    const recorded = [];
    const fakeStore = {
      getCardCredential: () => null,
      setAgentMode: (app, mode, cardId) => recorded.push({ app, mode, cardId }),
    };
    const r = await appWriters.applyCardToApp(CARD, 'trae', { mode: 'proxy', store: fakeStore });
    // trae 适配器写入 profile 存储（不触碰真实 home，因为 dataHome 已指向临时目录）
    expect(r.mode).toBe('proxy');
    if (r.success) {
      expect(recorded).toEqual([{ app: 'trae', mode: 'proxy', cardId: 'c_proxy_1' }]);
      // detail.proxy 内含脱敏令牌与端点，绝不回原文 provider key
      expect(r.detail.proxy.endpoint).toBe('http://127.0.0.1:9100');
      expect(r.detail.proxy.tokenMasked).not.toContain('0123456789abcdef0123456789abcdef');
      expect(r.detail.proxy.model).toBe('api:deepseek:deepseek-chat');
    }
  });

  test('direct 模式不回写 agentMode（保持历史语义不被污染）', async () => {
    const home = freshHome();
    const { appWriters } = loadFresh(home);
    const recorded = [];
    const fakeStore = {
      getCardCredential: () => null,
      setAgentMode: (app, mode, cardId) => recorded.push({ app, mode, cardId }),
    };
    await appWriters.applyCardToApp(CARD, 'opencode', { mode: 'direct', store: fakeStore });
    expect(recorded).toEqual([]);
  });

  test('Claude Code 代理模式把端点/令牌落 ANTHROPIC_* 命名空间（§5.3）', async () => {
    const home = freshHome();
    seedProxy(home);
    await withAgentHome(async (claudeDir) => {
      const { appWriters } = loadFresh(home);
      const r = await appWriters.applyCardToApp(CARD, 'claude-code', { mode: 'proxy' });
      expect(r.success).toBe(true);
      const settings = JSON.parse(
        fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8')
      );
      const env = settings.env || {};
      // 端点 + 令牌落 ANTHROPIC_*（而非 DeepSeek_API_KEY 之类命名空间）
      expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9100');
      expect(env.ANTHROPIC_API_KEY).toMatch(/^khy-/);
      expect(env.ANTHROPIC_MODEL).toBe('api:deepseek:deepseek-chat');
      // 代理模式下绝不出现 provider 真实 key
      expect(JSON.stringify(settings)).not.toContain('sk-deepseek');
    });
  });

  test('direct 模式保持 <PROVIDER>_* 命名空间（代理改动不影响历史行为）', async () => {
    const home = freshHome();
    await withAgentHome(async (claudeDir) => {
      const { appWriters } = loadFresh(home);
      const r = await appWriters.applyCardToApp(CARD, 'claude-code', { mode: 'direct' });
      expect(r.success).toBe(true);
      const settings = JSON.parse(
        fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8')
      );
      const env = settings.env || {};
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(env.DEEPSEEK_BASE_URL).toBe('https://api.deepseek.com/v1');
    });
  });
});

describe('constants —— APPS 扩面与模式枚举', () => {
  test('APPS 含 DESIGN-ARCH-101 新增的 5 个应用', () => {
    const { constants } = loadFresh(freshHome());
    for (const app of ['deepseek', 'reasonix', 'openclaw', 'coze', 'trae']) {
      expect(Object.values(constants.APPS)).toContain(app);
      expect(constants.APP_LABELS[app]).toBeTruthy();
    }
  });

  test('AGENT_MODES 只有 proxy / direct 两档', () => {
    const { constants } = loadFresh(freshHome());
    expect(constants.AGENT_MODES).toEqual({ DIRECT: 'direct', PROXY: 'proxy' });
  });
});

describe('store.agentMode 持久化', () => {
  test('默认 proxy；setAgentMode 落盘后可读回；null 清除', () => {
    const home = freshHome();
    jest.resetModules();
    process.env.KHY_DATA_HOME = home;
    const store = require(`${CC_SWITCH_MODULE}/store.js`);
    store._reset();

    expect(store.getAgentMode('opencode')).toEqual({ mode: 'proxy', cardId: '', ts: '' });

    const r = store.setAgentMode('opencode', 'direct', 'c_1');
    expect(r.success).toBe(true);
    const back = store.getAgentMode('opencode');
    expect(back.mode).toBe('direct');
    expect(back.cardId).toBe('c_1');

    // 落盘验证（cc_switch.json 真的写了 agentMode）
    const disk = JSON.parse(fs.readFileSync(path.join(home, 'cc_switch.json'), 'utf-8'));
    expect(disk.agentMode.opencode.mode).toBe('direct');

    store.setAgentMode('opencode', null);
    expect(store.getAgentMode('opencode').mode).toBe('proxy');
  });

  test('非法模式被拒（不静默写成别的值）', () => {
    const home = freshHome();
    jest.resetModules();
    process.env.KHY_DATA_HOME = home;
    const store = require(`${CC_SWITCH_MODULE}/store.js`);
    store._reset();
    const r = store.setAgentMode('opencode', 'rubbish');
    expect(r.success).toBe(false);
    expect(r.error).toContain('未知模式');
  });

  test('未知应用被拒', () => {
    const home = freshHome();
    jest.resetModules();
    process.env.KHY_DATA_HOME = home;
    const store = require(`${CC_SWITCH_MODULE}/store.js`);
    store._reset();
    expect(store.setAgentMode('not-an-app', 'proxy').success).toBe(false);
  });
});

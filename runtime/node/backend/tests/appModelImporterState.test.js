'use strict';

/**
 * appModelImporterState.test.js — 外部应用导入的「可用性三态」(jest)。
 *
 * 钉死 design [DESIGN-MEM-009] §3 #9 / 解包结论 F09 落在 appModelImporter.discover 上的那层信号:
 * discover 的返回体必须带 state(ok / stale / reauth / unsupported)+ stateReason(是什么问题)
 * + next(用户能做的下一步),让调用方按态给不同的修复动作,而不是笼统地成功或报错。
 *
 * 为什么这支套件必须存在:discover 之前只有 success/providers[]/error 三样东西,「本机没装这个
 * 外部软件」「配置在但凭据过期了」「配置在但残缺」三种完全不同的情况全塌缩成同一个
 * success:true + providers:[]——用户看不出下一步该干什么。这层信号一旦被改坏(比如退回
 * 单一 success 布尔),外部工具面只会「安静地不导入」,没有任何回归会拦住它。
 *
 * 隔离:数据家与两个外部软件的家目录全部钉到本次 mkdtemp 分配的临时目录,绝不碰用户真实的
 * ~/.khyquant 与 ~/.openclaw。provider id 一律用本套件专用名(如 stateprov),避免与 khy 密钥池
 * 里任何真实厂商 key 撞上(_resolveKey 会借池里同厂商 key,撞上就测不出 reauth)。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-xa-state-data-'));
process.env.KHY_DATA_HOME = DATA_HOME;
process.env.KHY_PROJECT_DATA_HOME = DATA_HOME;

const IMP = require('../src/services/domain/network/externalApps/appModelImporter');

let HOME;
let ENV;

beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-xa-state-home-'));
  ENV = { KHY_EXTERNAL_APP_IMPORT: '1', OPENCLAW_HOME: HOME };
});

afterEach(() => {
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(DATA_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** 写一份 openclaw.json + 旁路 .env(与 openclawAdapter 的读法同源)。 */
function seedOpenclaw(providers, envMap = {}) {
  fs.writeFileSync(
    path.join(HOME, 'openclaw.json'),
    JSON.stringify({ models: { providers } }, null, 2) + '\n'
  );
  const lines = Object.entries(envMap).map(([k, v]) => `${k}=${v}`).join('\n');
  fs.writeFileSync(path.join(HOME, '.env'), lines ? `${lines}\n` : '');
}

/** 把配置文件的时间戳往前挪 days 天(保鲜期判定用)。 */
function ageConfig(days) {
  const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  fs.utimesSync(path.join(HOME, 'openclaw.json'), when, when);
}

describe('discover — 可用性三态', () => {
  test('unsupported:本机没有该外部软件的配置', () => {
    // 家目录存在但没有 openclaw.json → 该外部软件在当前设备上不可用。
    const r = IMP.discover('openclaw', ENV);
    expect(r.success).toBe(true);
    expect(r.state).toBe('unsupported');
    expect(r.stateReason).toMatch(/本机找不到/);
    expect(r.next).toMatch(/当前设备不可用/);
  });

  test('unsupported:khy 不认识的外部软件', () => {
    const r = IMP.discover('NoSuchApp', { KHY_EXTERNAL_APP_IMPORT: '1' });
    expect(r.success).toBe(false);
    expect(r.state).toBe('unsupported');
    expect(r.stateReason).toMatch(/不认识/);
    // 既有 error 文案逐字保留(MEM-008 的措辞纪律:不改既有文案)。
    expect(r.error).toBe('不支持的外部软件: NoSuchApp');
  });

  test('unsupported:门控关闭时给出可执行的下一步,既有 error 文案不变', () => {
    const r = IMP.discover('openclaw', { KHY_EXTERNAL_APP_IMPORT: 'off' });
    expect(r.success).toBe(false);
    expect(r.state).toBe('unsupported');
    expect(r.next).toMatch(/KHY_EXTERNAL_APP_IMPORT/);
    expect(r.error).toBe('外部模型导入已被门控关闭（KHY_EXTERNAL_APP_IMPORT）');
  });

  test('reauth:配置在但该 provider 在外部软件侧与 khy 池里都没有凭据', () => {
    seedOpenclaw(
      { stateprov: { baseUrl: 'https://state.example/v1', models: ['s-1'] } },
      {}
    );
    const r = IMP.discover('openclaw', ENV);
    expect(r.success).toBe(true);
    expect(r.state).toBe('reauth');
    expect(r.stateReason).toMatch(/没有可用凭据/);
    expect(r.next).toMatch(/重新登录/);
  });

  test('reauth 优先于 stale:既缺凭据又缺 model 时按 reauth 报', () => {
    seedOpenclaw(
      {
        stateprov: { baseUrl: 'https://state.example/v1', models: ['s-1'] },
        stateother: { baseUrl: 'https://state2.example/v1' },
      },
      {}
    );
    const r = IMP.discover('openclaw', ENV);
    expect(r.state).toBe('reauth');
  });

  test('stale:凭据在但 provider 残缺(缺 model)', () => {
    seedOpenclaw(
      { stateprov: { baseUrl: 'https://state.example/v1' } },
      { STATEPROV_API_KEY: 'sk-state-0123456789' }
    );
    const r = IMP.discover('openclaw', ENV);
    expect(r.success).toBe(true);
    expect(r.state).toBe('stale');
    expect(r.stateReason).toMatch(/配置不完整/);
    expect(r.next).toMatch(/补齐/);
  });

  test('stale:配置存在但一个 provider 都没有', () => {
    seedOpenclaw({}, {});
    const r = IMP.discover('openclaw', ENV);
    expect(r.state).toBe('stale');
    expect(r.stateReason).toMatch(/没有可用 provider/);
  });

  test('stale:配置超过保鲜期(阈值只从 env 取)', () => {
    seedOpenclaw(
      { stateprov: { baseUrl: 'https://state.example/v1', models: ['s-1'] } },
      { STATEPROV_API_KEY: 'sk-state-0123456789' }
    );
    ageConfig(10);
    const r = IMP.discover('openclaw', { ...ENV, KHY_EXTERNAL_APP_STALE_DAYS: '1' });
    expect(r.state).toBe('stale');
    expect(r.stateReason).toMatch(/天未更新/);
    expect(r.next).toMatch(/可用性无法保证/);
  });

  test('保鲜期未设时不按时间判 stale(源码不拍默认值)', () => {
    seedOpenclaw(
      { stateprov: { baseUrl: 'https://state.example/v1', models: ['s-1'] } },
      { STATEPROV_API_KEY: 'sk-state-0123456789' }
    );
    ageConfig(400);
    const r = IMP.discover('openclaw', ENV);
    expect(r.state).toBe('ok');
  });

  test('ok:凭据/端点/模型齐备', () => {
    seedOpenclaw(
      { stateprov: { baseUrl: 'https://state.example/v1', models: ['s-1', 's-2'] } },
      { STATEPROV_API_KEY: 'sk-state-0123456789' }
    );
    const r = IMP.discover('openclaw', ENV);
    expect(r.success).toBe(true);
    expect(r.state).toBe('ok');
    expect(r.stateReason).toMatch(/齐备/);
    expect(r.next).toMatch(/可直接导入/);
    // 既有 providers 视图不受影响(密钥仍只以脱敏形态出现)。
    expect(r.providers).toHaveLength(1);
    expect(r.providers[0].keyMasked).toBe('sk-s…6789');
    expect('apiKey' in r.providers[0]).toBe(false);
  });

  test('每一态都带 stateReason 与 next(调用方按态分派的依据)', () => {
    const states = [
      IMP.discover('openclaw', { KHY_EXTERNAL_APP_IMPORT: 'off' }),
      IMP.discover('NoSuchApp', { KHY_EXTERNAL_APP_IMPORT: '1' }),
    ];
    seedOpenclaw({ stateprov: { baseUrl: 'https://state.example/v1', models: ['s-1'] } }, {});
    states.push(IMP.discover('openclaw', ENV));
    for (const r of states) {
      expect(typeof r.state).toBe('string');
      expect(r.stateReason.length).toBeGreaterThan(0);
      expect(r.next.length).toBeGreaterThan(0);
    }
  });
});

describe('discoverAll — 逐 app 带状态', () => {
  test('每个 app 都带 state', () => {
    seedOpenclaw(
      { stateprov: { baseUrl: 'https://state.example/v1', models: ['s-1'] } },
      { STATEPROV_API_KEY: 'sk-state-0123456789' }
    );
    const r = IMP.discoverAll(ENV);
    expect(r.success).toBe(true);
    expect(r.apps).toHaveLength(IMP.APPS.length);
    for (const a of r.apps) {
      expect(typeof a.state).toBe('string');
      expect(a.stateReason.length).toBeGreaterThan(0);
    }
    expect(r.apps.find((a) => a.app === 'openclaw').state).toBe('ok');
  });

  test('门控关闭时整体无操作并带状态', () => {
    const r = IMP.discoverAll({ KHY_EXTERNAL_APP_IMPORT: 'off' });
    expect(r.success).toBe(false);
    expect(r.state).toBe('unsupported');
    expect(r.apps).toEqual([]);
  });
});

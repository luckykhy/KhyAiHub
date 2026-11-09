import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * useEcoMarkets（生态市场编目）行为测试。
 * 锁 GET /api/eco-markets 的唯一调用、unwrap 回填、载荷逐个兜底、
 * 同名条目按 eco 隔离（不互串），以及失败时保留上一次快照。
 * request 用 vi.mock 打桩，不发真实请求。
 */

const get = vi.fn();

vi.mock('@/api/request', () => ({
  default: {
    get: (...a) => get(...a),
  },
}));

const { useEcoMarkets } = await import('@/composables/useEcoMarkets');

const envelope = (data) => ({ data: { success: true, data } });

// The same upstream is surveyed once per ecosystem with different verdicts, so
// these fixtures reuse one name across tabs on purpose.
const entry = (name, khyosMarket) => ({
  name,
  upstreamUrl: 'https://example.com/agents',
  type: 'agent',
  khyosMarket,
  compat: 'adapter-needed',
  license: 'MIT',
  what: 'multi-agent orchestration repository',
});

const market = (eco, title, entries) => ({
  eco,
  title,
  surveyedAt: '2026-10-29',
  marketplaces: [{ name: `${title}市场源`, url: 'https://example.com/list', kind: '清单' }],
  entries,
  blocked: [{ name: 'blocked-one', upstreamUrl: 'https://example.com/b', reason: 'license 未定档' }],
  uncertainties: ['上游元数据缺失'],
});

beforeEach(() => {
  get.mockReset();
});

describe('编目读取', () => {
  it('loadMarkets：GET /api/eco-markets 只发一次并回填全部字段', async () => {
    get.mockResolvedValueOnce(
      envelope({
        ecosystems: [market('zcode', 'ZCode 生态', [entry('skill-creator', 'skill')])],
        rules: ['compat=blocked → 不路由'],
        licenseGate: 'A 档可 vendored 进仓',
        generatedAt: '2026-10-29',
        degraded: '',
        warnings: [],
      })
    );
    const eco = useEcoMarkets();
    await eco.loadMarkets();

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/api/eco-markets');
    expect(eco.markets.value.map((m) => m.eco)).toEqual(['zcode']);
    expect(eco.markets.value[0].title).toBe('ZCode 生态');
    expect(eco.rules.value).toEqual(['compat=blocked → 不路由']);
    expect(eco.licenseGate.value).toBe('A 档可 vendored 进仓');
    expect(eco.generatedAt.value).toBe('2026-10-29');
    expect(eco.degraded.value).toBe('');
    expect(eco.warnings.value).toEqual([]);
    expect(eco.loading.value).toBe(false);
    expect(eco.loadError.value).toBe('');
  });

  it('空载荷：data={} 与 data=null 都不抛，markets 收敛为 []', async () => {
    get.mockResolvedValueOnce(envelope({}));
    const eco = useEcoMarkets();
    await eco.loadMarkets();
    expect(eco.markets.value).toEqual([]);

    get.mockReset();
    get.mockResolvedValueOnce(envelope(null));
    await eco.loadMarkets();
    expect(eco.markets.value).toEqual([]);
    expect(eco.loadError.value).toBe('');
  });

  it('载荷字段逐个兜底：非数组收敛 []、非字符串收敛空串', async () => {
    get.mockResolvedValueOnce(
      envelope({
        ecosystems: { eco: 'zcode' },
        rules: '规则',
        licenseGate: 42,
        generatedAt: null,
        degraded: [],
        warnings: '告警',
      })
    );
    const eco = useEcoMarkets();
    await eco.loadMarkets();

    expect(eco.markets.value).toEqual([]);
    expect(eco.rules.value).toEqual([]);
    expect(eco.licenseGate.value).toBe('');
    expect(eco.generatedAt.value).toBe('');
    expect(eco.degraded.value).toBe('');
    expect(eco.warnings.value).toEqual([]);
  });

  it('单个生态缺失列表字段时收敛为空数组（视图不再逐个判空）', async () => {
    get.mockResolvedValueOnce(envelope({ ecosystems: [{ eco: 'zcode', title: 'ZCode 生态' }] }));
    const eco = useEcoMarkets();
    await eco.loadMarkets();

    const m = eco.marketFor('zcode');
    expect(m.entries).toEqual([]);
    expect(m.blocked).toEqual([]);
    expect(m.marketplaces).toEqual([]);
    expect(m.uncertainties).toEqual([]);
  });

  it('degraded 非空时原样透传（装机环境缺编目数据根）', async () => {
    get.mockResolvedValueOnce(
      envelope({
        ecosystems: [],
        degraded: '未找到编目数据根，请设置 KHY_ECO_MARKET_DIR 指向 delivery/market 后重试',
      })
    );
    const eco = useEcoMarkets();
    await eco.loadMarkets();

    expect(eco.degraded.value).toContain('KHY_ECO_MARKET_DIR');
    expect(eco.markets.value).toEqual([]);
  });
});

describe('单市场读取（按 eco 隔离）', () => {
  it('同名条目按 eco 各取各的记录，不按名合并', async () => {
    get.mockResolvedValueOnce(
      envelope({
        ecosystems: [
          market('claude-code', 'Claude Code 生态', [
            entry('wshobson/agents', 'none'),
            entry('skill-creator', 'skill'),
          ]),
          market('zcode', 'ZCode 生态', [entry('wshobson/agents', 'skill')]),
        ],
      })
    );
    const eco = useEcoMarkets();
    await eco.loadMarkets();

    const cc = eco.marketFor('claude-code');
    const zc = eco.marketFor('zcode');
    expect(cc.eco).toBe('claude-code');
    expect(zc.eco).toBe('zcode');
    expect(cc.entries).toHaveLength(2);
    expect(zc.entries).toHaveLength(1);
    expect(cc.entries[0].khyosMarket).toBe('none');
    expect(zc.entries[0].khyosMarket).toBe('skill');
    expect(cc.entries[0]).not.toBe(zc.entries[0]);
    // 每个 tab 只渲染各自生态的列表：blocked/市场源不跨 tab 共享
    expect(cc.blocked).toHaveLength(1);
    expect(cc.marketplaces[0].name).toContain('Claude Code');
    expect(zc.marketplaces[0].name).toContain('ZCode');
    expect(eco.marketFor('opencode')).toBeNull();
    expect(eco.marketFor('')).toBeNull();
  });
});

describe('失败态', () => {
  it('请求被拒：loadError 含「生态市场加载失败」且保留上一次 markets', async () => {
    get.mockResolvedValueOnce(
      envelope({ ecosystems: [market('zcode', 'ZCode 生态', [entry('a', 'skill')])] })
    );
    const eco = useEcoMarkets();
    await eco.loadMarkets();
    expect(eco.markets.value).toHaveLength(1);

    get.mockReset();
    get.mockRejectedValueOnce({ response: { status: 503 } });
    await eco.loadMarkets();

    expect(eco.loadError.value).toContain('生态市场加载失败');
    expect(eco.loadError.value).toContain('服务端错误 (503)');
    // 写回 [] 会让一次 503 在页面上显示成「生态编目为空」
    expect(eco.markets.value).toHaveLength(1);
    expect(eco.markets.value[0].eco).toBe('zcode');
    expect(eco.loading.value).toBe(false);
  });

  it('网络异常也走同一条降级文案（问题+状态码+修复建议）', async () => {
    get.mockRejectedValueOnce(new Error('socket hang up'));
    const eco = useEcoMarkets();
    await eco.loadMarkets();

    expect(eco.loadError.value).toContain('生态市场加载失败');
    expect(eco.loadError.value).toContain('请稍后重试');
    expect(eco.markets.value).toEqual([]);
  });

  it('再次成功时清掉上一次的 loadError', async () => {
    get.mockRejectedValueOnce(new Error('boom'));
    const eco = useEcoMarkets();
    await eco.loadMarkets();
    expect(eco.loadError.value).not.toBe('');

    get.mockReset();
    get.mockResolvedValueOnce(envelope({ ecosystems: [] }));
    await eco.loadMarkets();
    expect(eco.loadError.value).toBe('');
  });
});

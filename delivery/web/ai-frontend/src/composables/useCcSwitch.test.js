import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * useCcSwitch（CC-Switch 应用矩阵，DESIGN-ARCH-101）行为测试。
 * 锁 /api/cc-switch/* 的 URL 组装、mode 语义（缺省 proxy / 显式 direct /
 * 后端回显优先）、fetchAll 预填与忙态翻转。request 用 vi.mock 打桩。
 */

const get = vi.fn();
const post = vi.fn();

vi.mock('@/api/request', () => ({
  default: {
    get: (...a) => get(...a),
    post: (...a) => post(...a),
  },
}));

const { useCcSwitch } = await import('@/composables/useCcSwitch');

const envelope = (data) => ({ data: { success: true, data } });

const STATUS = envelope([
  { app: 'claude-code', label: 'Claude Code', activeCardId: 'c1' },
  { app: 'opencode', label: 'OpenCode CLI', activeCardId: null },
  { app: 'trae', label: 'Trae', activeCardId: null },
]);
const CARDS = envelope([
  { id: 'c1', name: 'DeepSeek', enabled: true },
  { id: 'c2', name: 'GLM', enabled: false },
]);

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});

describe('fetchAll', () => {
  it('并行拉取 status + cards，只留 enabled 卡，激活卡预填 pick', async () => {
    get.mockImplementation((url) =>
      url === '/api/cc-switch/status' ? Promise.resolve(STATUS) : Promise.resolve(CARDS)
    );
    const svc = useCcSwitch();
    await svc.fetchAll();
    expect(svc.apps.value.map((a) => a.app)).toEqual(['claude-code', 'opencode', 'trae']);
    expect(svc.cards.value.map((c) => c.id)).toEqual(['c1']);
    expect(svc.pick.value).toEqual({ 'claude-code': 'c1' });
    expect(svc.loading.value).toBe(false);
  });

  it('请求失败 → 收敛为空矩阵不抛（拦截器已 toast）', async () => {
    get.mockRejectedValue(new Error('401'));
    const svc = useCcSwitch();
    await expect(svc.fetchAll()).resolves.toBeUndefined();
    expect(svc.apps.value).toEqual([]);
  });
});

describe('applyToApp mode 语义', () => {
  it('未选卡 → 拒绝且不发请求', async () => {
    const svc = useCcSwitch();
    const out = await svc.applyToApp('opencode');
    expect(out.ok).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('mode 省略 → POST 不带 mode（后端缺省 proxy），回显取后端值', async () => {
    get.mockImplementation((url) =>
      url === '/api/cc-switch/status' ? Promise.resolve(STATUS) : Promise.resolve(CARDS)
    );
    post.mockResolvedValue(envelope({ app: 'opencode', cardId: 'c1', mode: 'proxy' }));
    const svc = useCcSwitch();
    await svc.fetchAll();
    svc.pick.value.opencode = 'c1';
    const out = await svc.applyToApp('opencode');
    expect(out.ok).toBe(true);
    expect(post).toHaveBeenCalledWith('/api/cc-switch/use', { cardId: 'c1', app: 'opencode', mode: undefined });
    expect(out.mode).toBe('proxy');
  });

  it('显式 direct → POST 携带 mode:direct 且原样组装 URL', async () => {
    get.mockImplementation((url) =>
      url === '/api/cc-switch/status' ? Promise.resolve(STATUS) : Promise.resolve(CARDS)
    );
    post.mockResolvedValue(envelope({ app: 'opencode', cardId: 'c1', mode: 'direct' }));
    const svc = useCcSwitch();
    await svc.fetchAll();
    svc.pick.value.opencode = 'c1';
    const out = await svc.applyToApp('opencode', 'direct');
    expect(post).toHaveBeenCalledWith('/api/cc-switch/use', { cardId: 'c1', app: 'opencode', mode: 'direct' });
    expect(out.mode).toBe('direct');
  });

  it('失败 → { ok:false, error } 且忙态复位', async () => {
    get.mockImplementation((url) =>
      url === '/api/cc-switch/status' ? Promise.resolve(STATUS) : Promise.resolve(CARDS)
    );
    post.mockRejectedValue(new Error('代理未运行：请先启动网关'));
    const svc = useCcSwitch();
    await svc.fetchAll();
    svc.pick.value.opencode = 'c1';
    const out = await svc.applyToApp('opencode', 'proxy');
    expect(out.ok).toBe(false);
    expect(out.error).toContain('代理未运行');
    expect(svc.applying.value).toBe('');
  });
});

describe('labelOf', () => {
  it('未知 app 回退原 id', async () => {
    get.mockImplementation((url) =>
      url === '/api/cc-switch/status' ? Promise.resolve(STATUS) : Promise.resolve(CARDS)
    );
    const svc = useCcSwitch();
    await svc.fetchAll();
    expect(svc.labelOf('claude-code')).toBe('Claude Code');
    expect(svc.labelOf('not-an-app')).toBe('not-an-app');
  });
});

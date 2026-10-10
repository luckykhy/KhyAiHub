/**
 * Unit tests for requirementIntakeService (aggregate routing) and
 * requirementArtifact (deterministic assembly / readback / reconciliation).
 * [DESIGN-ARCH-164] 用户需求理解管线 S1 观察者档。
 */
process.env.KHY_DATA_HOME = require('os').tmpdir() + '/khy-req-test-' + process.pid;

const intake = require('../requirementIntakeService');
const artifact = require('../requirementArtifact');

describe('requirementIntakeService.aggregate', () => {
  it('disabled by default (S1 gate off) → proceed, no directives', () => {
    const s = intake.aggregate({ text: '优化一下代码', scale: 'normal', clarificationNeeded: true });
    expect(s.enabled).toBe(false);
    expect(s.route).toBe('proceed');
    expect(s.injectedDirectives).toEqual([]);
  });

  it('explicit on → clarify when prompt unclear and no mode active', () => {
    const s = intake.aggregate({
      text: '优化一下代码',
      scale: 'normal',
      clarificationNeeded: true,
      options: { requirementIntake: 'on' },
    });
    expect(s.enabled).toBe(true);
    expect(s.route).toBe('clarify');
    expect(s.injectedDirectives).toEqual(['clarification']);
  });

  it('disambiguation outranks clarification (消歧 > 澄清)', () => {
    const s = intake.aggregate({
      text: '把它改一下',
      scale: 'normal',
      clarificationNeeded: true,
      disambiguationNeeded: true,
      options: { requirementIntake: 'on' },
    });
    expect(s.route).toBe('disambiguate');
    expect(s.injectedDirectives).toEqual(['referenceDisambiguation']);
  });

  it('mode active short-circuits question routes → proceed (user already explicit)', () => {
    const s = intake.aggregate({
      text: '修复登录超时，用 coding 模式',
      scale: 'normal',
      clarificationNeeded: true,
      disambiguationNeeded: true,
      modes: ['coding'],
      options: { requirementIntake: 'on' },
    });
    expect(s.modeActive).toBe(true);
    expect(s.route).toBe('proceed');
  });

  it('plan route fires only for normal/large scale when clear', () => {
    const large = intake.aggregate({
      text: '端到端实现数据导出功能的完整链路，覆盖前后端',
      scale: 'large',
      options: { requirementIntake: 'on' },
    });
    expect(large.route).toBe('plan');

    const small = intake.aggregate({
      text: '你好',
      scale: 'small',
      options: { requirementIntake: 'on' },
    });
    expect(small.route).toBe('proceed');
  });

  it('acceptance gap: action verb without acceptance mark → plan; with mark → proceed', () => {
    const gap = intake.aggregate({
      text: '帮我把整个登录模块重构成独立的认证服务，涉及前后端',
      scale: 'normal',
      options: { requirementIntake: 'on' },
    });
    expect(gap.route).toBe('plan');
    expect(gap.reason).toBe('acceptance-gap-normal');

    const clear = intake.aggregate({
      text: '把整个登录模块重构成独立服务，验收标准是现有测试全部跑通',
      scale: 'normal',
      options: { requirementIntake: 'on' },
    });
    expect(clear.route).toBe('proceed');
    expect(clear.reason).toContain('clear-acceptance');
  });

  it('observeIntake() appends one jsonl line, never throws', () => {
    const s = intake.aggregate({
      text: '优化一下代码',
      scale: 'normal',
      clarificationNeeded: true,
      options: { requirementIntake: 'on' },
    });
    expect(() => artifact.observeIntake(s, { toolActivity: 2 })).not.toThrow();
  });

  it('pure function: same input → same output, never throws on garbage', () => {
    const a = intake.aggregate({ text: 'x', scale: 'normal', options: { requirementIntake: 'on' } });
    const b = intake.aggregate({ text: 'x', scale: 'normal', options: { requirementIntake: 'on' } });
    expect(a).toEqual(b);
    expect(() => intake.aggregate({ text: null, scale: 'bogus' })).not.toThrow();
  });

  it('S1 stage authority constant', () => {
    expect(intake.getStage()).toBe('S1');
  });
});

describe('requirementArtifact lifecycle', () => {
  const chatState = () => ({
    liveSessionId: 'sess-test',
    messages: [
      { role: 'user', content: '优化一下代码' },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '[Tool Result]xxx' },
    ],
  });

  it('no pending QA → finalize is a no-op', () => {
    expect(artifact.finalizeTurnArtifact(chatState()).ok).toBe(false);
  });

  it('QA turns → deterministic artifact with source per item', () => {
    artifact.recordQaTurn({ answers: { '优化什么范围?': '启动路径' } });
    artifact.recordQaTurn({ answers: { '怎么验收?': '首帧 < 500ms' } });
    const st = chatState();
    const f = artifact.finalizeTurnArtifact(st);
    expect(f.ok).toBe(true);
    expect(f.itemCount).toBe(3); // R1 原话 + R2/R3 问答
    expect(st._requirementArtifactId).toBe(f.id);

    const read = artifact.readArtifact(f.id);
    expect(read.ok).toBe(true);
    expect(read.body).toContain('source: 用户原话「优化一下代码」');
    expect(read.body).toContain('source: 澄清答案「启动路径」');
    expect(read.body).toContain('source: 澄清答案「首帧 < 500ms」');
  });

  it('context line requires items and cites artifact id', () => {
    const f = artifact.finalizeTurnArtifact(chatState());
    expect(f.ok).toBe(false); // no pending QA
    const read = artifact.readLatestArtifact('sess-test');
    expect(read.ok).toBe(true);
    const line = artifact.buildContextLine(read);
    expect(line).toContain('requirements/');
    expect(line).toContain('R1/');
    expect(artifact.buildContextLine({ ok: false })).toBe('');
  });

  it('reconciliation appends ○ per item once (honest stamp, idempotent)', () => {
    const read = artifact.readLatestArtifact('sess-test');
    const first = artifact.reconcileTurn({ _requirementArtifactId: read.id }, { toolActivity: 4 });
    expect(first.ok).toBe(true);
    const body = artifact.readArtifact(read.id).body;
    // S1 只记录不判定：条目一律 ○（诚实上报，不冒充 ⏳/✓/✗），见 reconcileTurn 文档。
    expect(body).toContain('R1 ○');
    expect(body).toContain('工具动作 4 次');
    expect(body).toContain('<!-- reconciled -->');
    const second = artifact.reconcileTurn({ _requirementArtifactId: read.id }, {});
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('already-reconciled');
  });

  it('rejected/empty QA turns are never recorded', () => {
    const before = artifact.consumePendingQa().length;
    artifact.recordQaTurn({ answers: {} });
    artifact.recordQaTurn(null);
    expect(artifact.consumePendingQa().length).toBe(before);
  });
});

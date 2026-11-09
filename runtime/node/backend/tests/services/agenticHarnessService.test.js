'use strict';

jest.mock('../../src/services/contextRouter', () => ({
  routeContextStrategy: jest.fn(),
  truncateToolResults: jest.fn(),
}));

jest.mock('../../src/services/contextCompressor', () => ({
  compress: jest.fn(),
}));

jest.mock('../../src/services/contextWasm', () => ({
  estimateTokens: jest.fn(() => 10),
}));

jest.mock('../../src/services/toolUseLoop', () => ({
  runToolUseLoop: jest.fn(),
}));

jest.mock('../../src/services/backgroundTaskManager', () => ({
  register: jest.fn(),
  complete: jest.fn(),
  fail: jest.fn(),
}));

jest.mock('../../src/services/projectMemoryService', () => ({
  saveSessionTrace: jest.fn(),
}));

// verificationAgent 必须打桩：它不是纯逻辑，verify() 会 spawnSync 真实外部进程 ——
// `node -c <file>`、`<包管理器> run <script>`（VERIFICATION_TIMEOUT = 60s/步）、
// linter、pytest。本用例的 toolCallLog 里有一条 editFile，于是 uniqueFiles 非空，
// 真的会跑起来。Windows 上 spawnSync('npm', …) 不走 shell、npm 是 npm.cmd → 立刻
// ENOENT，两趟验证各 74ms，所以本机看不出问题；Linux 上 npm 是真可执行文件，于是
// 在 jest 进程里**递归拉起整套测试**，用例直接撞 5s 超时线（门禁上就是这么红的，
// 且与 continuationCooldownMs 无关）。单元测试不该 spawn 任何真实进程，这里按本
// 文件既有做法把它一并 mock 掉。
jest.mock('../../src/services/verificationAgent', () => ({
  verify: jest.fn(() => ({ passed: true, summary: 'mocked verification', steps: [] })),
}));
jest.mock('../../src/services/changeRegressionGate', () => ({
  prepareBugfixRegressionGate: jest.fn(),
  evaluateBugfixRegressionGate: jest.fn(),
}));

jest.mock('../../src/memdir/memdir', () => {
  // P1-2: 复盘沉淀用例走真实的 memoryEngine.addStructuredMemory → memdir.saveMemory
  // 原子写,只有 searchMemories 需要打桩(上下文包的记忆提示)。故透传真模块、只替换
  // 这一个函数——其余既有用例仍只依赖 searchMemories,行为不变。
  const actual = jest.requireActual('../../src/memdir/memdir');
  return { ...actual, searchMemories: jest.fn() };
});

jest.mock('../../src/services/crossModelVerify', () => ({
  // 真模块会按候选清单逐个调用 chat() 打真实供应商;本文件只需要它的结构化产出。
  // 默认「未执行」,与改前行为一致(旧用例的 mock chat 返回体没有 .text/.content,
  // 真模块同样走到 performed:false)。复盘用例按需覆盖 verify 的返回值。
  verify: jest.fn(async () => ({ performed: false, reason: 'mocked' })),
  _classifyVendor: jest.fn(() => 'unknown'),
  getStage: jest.fn(() => 'S1'),
}));

jest.mock('../../src/skills', () => ({
  discoverAllSkills: jest.fn(),
  getActiveSkills: jest.fn(),
}));

const { createAgenticHarness } = require('../../src/services/agenticHarnessService');
const contextRouter = require('../../src/services/contextRouter');
const contextCompressor = require('../../src/services/contextCompressor');
const toolUseLoop = require('../../src/services/toolUseLoop');
const bgTask = require('../../src/services/backgroundTaskManager');
const projectMemoryService = require('../../src/services/projectMemoryService');
const changeRegressionGate = require('../../src/services/changeRegressionGate');
const crossModelVerify = require('../../src/services/crossModelVerify');
const memdir = require('../../src/memdir/memdir');
const skills = require('../../src/skills');

function makeBgHandle(id = 'bg_1') {
  return {
    task: {
      id,
      meta: {},
      updatedAt: Date.now(),
    },
    signal: { aborted: false },
    release: () => {},
  };
}

describe('agenticHarnessService', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    bgTask.register.mockReturnValue(makeBgHandle());
    contextCompressor.compress.mockResolvedValue({ compressed: [] });
    memdir.searchMemories.mockReturnValue([]);
    skills.discoverAllSkills.mockImplementation(() => {});
    skills.getActiveSkills.mockReturnValue([]);
    changeRegressionGate.prepareBugfixRegressionGate.mockReturnValue({
      enabled: true,
      shouldRun: false,
      reason: 'not bugfix',
      baseline: null,
    });
    changeRegressionGate.evaluateBugfixRegressionGate.mockReturnValue({
      enabled: true,
      skipped: true,
      passed: true,
      reason: 'not active',
      summary: 'Bugfix regression gate skipped.',
    });
  });

  test('buildContextPacket applies context route and tool truncation strategy', async () => {
    contextRouter.routeContextStrategy.mockReturnValue({
      route: 'truncate_tool_results_only',
      overflow: 32,
      toolResultTokens: 180,
    });

    const harness = createAgenticHarness();
    const packet = await harness.buildContextPacket({
      userMessage: 'check logs',
      systemPrompt: 'sys',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'tool', content: 'tool-result' },
      ],
    });

    expect(packet.contextRoute.route).toBe('truncate_tool_results_only');
    expect(contextRouter.truncateToolResults).toHaveBeenCalledTimes(1);
    expect(contextRouter.truncateToolResults.mock.calls[0][1]).toBe(32);
  });

  test('run retries transient loop outcome and returns recovered result', async () => {
    contextRouter.routeContextStrategy.mockReturnValue({
      route: 'fits',
      overflow: 0,
      toolResultTokens: 0,
    });

    toolUseLoop.runToolUseLoop
      .mockResolvedValueOnce({
        finalResponse: 'temporary network issue',
        errorType: 'network',
        toolCallLog: [],
        iterations: 1,
      })
      .mockResolvedValueOnce({
        finalResponse: 'recovered',
        errorType: null,
        toolCallLog: [],
        iterations: 2,
        provider: 'mock',
      });

    const harness = createAgenticHarness({
      retryAttempts: 2,
      retryMinDelayMs: 1,
      retryMaxDelayMs: 1,
    });

    const result = await harness.run({
      userMessage: 'run task',
      chat: async () => ({ reply: 'unused' }),
    });

    expect(toolUseLoop.runToolUseLoop).toHaveBeenCalledTimes(2);
    expect(result.finalResponse).toBe('recovered');
    expect(bgTask.complete).toHaveBeenCalledTimes(1);
    expect(projectMemoryService.saveSessionTrace).toHaveBeenCalledTimes(1);
    const report = bgTask.complete.mock.calls[0][1];
    expect(report.deliveryVerdict).toBeTruthy();
    expect(report.deliveryVerdict.verdict).toBe('pass');
  });

  test('Ralph continuation retains prior conversation and dedup state', async () => {
    contextRouter.routeContextStrategy.mockReturnValue({
      route: 'fits',
      overflow: 0,
      toolResultTokens: 0,
    });

    const priorMessages = [
      { role: 'user', content: 'original task' },
      { role: 'assistant', content: 'tool requested' },
      { role: 'user', content: 'tool result: changed file' },
    ];
    const executedCallKeys = new Map([
      ['{"t":"write_file","p":{"path":"src/demo.js"}}', { result: { success: true } }],
    ]);

    toolUseLoop.runToolUseLoop
      .mockResolvedValueOnce({
        finalResponse: 'iteration limit reached',
        toolCallLog: [],
        iterations: 2,
        maxIterationsReached: true,
        conversationMessages: priorMessages,
        executedCallKeys,
      })
      .mockResolvedValueOnce({
        finalResponse: 'completed after continuation',
        toolCallLog: [],
        iterations: 1,
        provider: 'mock',
      });

    const previousRalphFlag = process.env.KHY_RALPH_LOOP;
    const previousDeliveryGate = process.env.KHY_DELIVERY_GATE;
    process.env.KHY_RALPH_LOOP = '1';
    process.env.KHY_DELIVERY_GATE = '0';
    try {
      const harness = createAgenticHarness({
        continuationCooldownMs: 0,
        maxContinuationRounds: 1,
      });
      const result = await harness.run({
        userMessage: 'create a new project',
        chat: async () => ({ reply: 'unused' }),
      });

      expect(result.finalResponse).toContain('completed after continuation');
      expect(toolUseLoop.runToolUseLoop).toHaveBeenCalledTimes(2);
      const continuationOptions = toolUseLoop.runToolUseLoop.mock.calls[1][1];
      expect(continuationOptions.initialMessages).toBe(priorMessages);
      expect(continuationOptions.inheritedDedupKeys).toBe(executedCallKeys);
    } finally {
      if (previousRalphFlag === undefined) delete process.env.KHY_RALPH_LOOP;
      else process.env.KHY_RALPH_LOOP = previousRalphFlag;
      if (previousDeliveryGate === undefined) delete process.env.KHY_DELIVERY_GATE;
      else process.env.KHY_DELIVERY_GATE = previousDeliveryGate;
    }
  });

  test('run blocks delivery when bugfix regression gate reports new failures', async () => {
    contextRouter.routeContextStrategy.mockReturnValue({
      route: 'fits',
      overflow: 0,
      toolResultTokens: 0,
    });

    changeRegressionGate.prepareBugfixRegressionGate.mockReturnValue({
      enabled: true,
      shouldRun: true,
      reason: 'active',
      requiredSteps: ['syntax', 'test'],
      model: 'gpt-4o-mini',
      adapter: 'api',
      baseline: { summary: 'All 2 verification step(s) passed.' },
    });
    changeRegressionGate.evaluateBugfixRegressionGate.mockReturnValue({
      enabled: true,
      skipped: false,
      passed: false,
      reason: 'active',
      summary: 'Bugfix regression gate blocked delivery: new failing step(s): test.',
      regressedSteps: ['test'],
      changedFiles: ['backend/src/demo.js'],
      requiredSteps: ['syntax', 'test'],
      recommendations: ['Reproduce the new failing steps and fix them before final delivery.'],
    });

    toolUseLoop.runToolUseLoop.mockResolvedValue({
      finalResponse: 'patch applied',
      errorType: null,
      toolCallLog: [{ tool: 'editFile', params: { path: 'backend/src/demo.js' }, success: true }],
      iterations: 2,
      provider: 'mock',
    });

    // 用例断言的是「回归门禁如何裁决」，不是「冷却等多久」。默认
    // continuationCooldownMs 是 1500ms 的真实 setTimeout：本机整例约 1.6s 还在 5s
    // 超时线内，ubuntu runner 上多 worker 争 CPU 时定时器回调被推后，直接撞
    // 「Exceeded timeout of 5000 ms」—— 门禁红、本机绿，跟被测逻辑无关。同文件的
    // retry 用例早就用 retryMinDelayMs: 1 消掉了同类等待，这里对齐它。
    const harness = createAgenticHarness({ continuationCooldownMs: 0 });
    const result = await harness.run({
      userMessage: 'please fix bug in parser',
      chat: async () => ({ reply: 'unused' }),
    });

    expect(result.errorType).toBe('regression_gate');
    expect(result.finalResponse).toContain('[Regression Gate]');
    expect(result.finalResponse).toContain('blocked delivery');
    expect(bgTask.complete).toHaveBeenCalledTimes(1);
    const report = bgTask.complete.mock.calls[0][1];
    expect(report.deliveryVerdict).toMatchObject({
      verdict: 'fail',
      blockedBy: expect.arrayContaining(['regression_gate']),
    });
    expect(report.regressionGate).toMatchObject({
      passed: false,
      regressedSteps: ['test'],
    });
  });

  test('run reports delivery fail when the loop only ran out of room', async () => {
    // The harness exit must not read an unfinished loop as success: the loop
    // self-reports maxIterationsReached/truncated and no other gate fails. The
    // message is short and free of action words, so Ralph continuation does not
    // fire (verified: continuation.shouldAutoContinue('看下日志') === false) and
    // the last-round flags reach buildHarnessDeliveryVerdict unchanged. This is
    // the regression lock for "ran out of room !== success" — without it the
    // runtime criterion could regress silently while every suite stayed green.
    contextRouter.routeContextStrategy.mockReturnValue({
      route: 'fits',
      overflow: 0,
      toolCallTokens: 0,
    });

    toolUseLoop.runToolUseLoop.mockResolvedValue({
      finalResponse: 'half-done work',
      errorType: null,
      toolCallLog: [],
      iterations: 10,
      provider: 'mock',
      maxIterationsReached: true,
      truncated: true,
    });

    const harness = createAgenticHarness({ continuationCooldownMs: 0 });
    const result = await harness.run({
      userMessage: '看下日志',
      chat: async () => ({ reply: 'unused' }),
    });

    expect(toolUseLoop.runToolUseLoop).toHaveBeenCalledTimes(1);
    const report = bgTask.complete.mock.calls[0][1];
    expect(report.deliveryVerdict).toMatchObject({
      verdict: 'fail',
      blockedBy: expect.arrayContaining(['runtime']),
    });
    expect(report.deliveryVerdict.gates.runtime.passed).toBe(false);
    // The honest-closing contract: the verdict is appended to what the user sees.
    expect(result.finalResponse).toContain('[Delivery]');
  });

  test('run emits both change and legacy regression gate events for compatibility', async () => {
    contextRouter.routeContextStrategy.mockReturnValue({
      route: 'fits',
      overflow: 0,
      toolResultTokens: 0,
    });

    changeRegressionGate.prepareBugfixRegressionGate.mockReturnValue({
      enabled: true,
      shouldRun: true,
      reason: 'active',
      requiredSteps: ['syntax', 'test'],
      model: 'gpt-4o-mini',
      adapter: 'api',
      baseline: { summary: 'All 2 verification step(s) passed.' },
    });
    changeRegressionGate.evaluateBugfixRegressionGate.mockReturnValue({
      enabled: true,
      skipped: false,
      passed: true,
      reason: 'active',
      summary: 'Change regression gate passed.',
      regressedSteps: [],
      changedFiles: [],
      requiredSteps: ['syntax', 'test'],
      recommendations: [],
    });

    toolUseLoop.runToolUseLoop.mockResolvedValue({
      finalResponse: 'ok',
      errorType: null,
      toolCallLog: [],
      iterations: 1,
      provider: 'mock',
    });

    const events = [];
    const harness = createAgenticHarness();
    await harness.run({
      userMessage: 'fix bug in parser',
      chat: async () => ({ reply: 'unused' }),
      onEvent: (event) => { events.push(event); },
    });

    const baselineTypes = events
      .filter(e => e && e.phase === 'baseline_completed')
      .map(e => e.type);
    const finalTypes = events
      .filter(e => e && e.phase === 'final_evaluation')
      .map(e => e.type);

    expect(baselineTypes).toEqual(expect.arrayContaining(['change_regression_gate', 'bugfix_regression_gate']));
    expect(finalTypes).toEqual(expect.arrayContaining(['change_regression_gate', 'bugfix_regression_gate']));
  });

  test('buildContextPacket produces ranked memory and skill hints', async () => {
    contextRouter.routeContextStrategy.mockReturnValue({
      route: 'fits',
      overflow: 0,
      toolResultTokens: 0,
    });

    memdir.searchMemories.mockImplementation((query) => {
      if (String(query).includes('alpha')) {
        return [
          {
            filename: 'alpha.md',
            frontmatter: { name: 'Alpha Decision', description: 'alpha strategy decision' },
            matches: ['alpha strategy baseline'],
          },
          {
            filename: 'beta.md',
            frontmatter: { name: 'Beta Note', description: 'beta plan' },
            matches: ['beta context only'],
          },
        ];
      }
      return [];
    });

    skills.getActiveSkills.mockReturnValue([
      {
        name: 'alpha-skill',
        trigger: '/alpha',
        description: 'alpha workflow helper',
        tags: ['alpha', 'workflow'],
      },
      {
        name: 'beta-skill',
        trigger: '/beta',
        description: 'beta workflow helper',
        tags: ['beta'],
      },
    ]);

    const harness = createAgenticHarness();
    const packet = await harness.buildContextPacket({
      userMessage: 'need alpha workflow update',
      cwd: process.cwd(),
      recentFiles: ['src/alpha.js'],
    });

    expect(packet.memoryHints.length).toBeGreaterThan(0);
    expect(packet.memoryHints[0].filename).toBe('alpha.md');
    expect(packet.skillHints.length).toBeGreaterThan(0);
    expect(packet.skillHints[0].trigger).toBe('/alpha');
    expect(skills.discoverAllSkills).toHaveBeenCalled();
  });

  // P1-2: 复盘沉淀(crossModelVerify 接线处 → memoryTrigger.classifyReflection →
  // memoryEngine.addStructuredMemory 真实落盘)。KHY_MEMORY_DIR 指向临时目录,
  // 断言的是真文件、真 frontmatter、真去重——不是 mock 调用计数。
  describe('cross-model reflection memory capture (P1-2)', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const memPaths = require('../../src/memdir/paths');

    // 一次 run 含真实记忆写入;KHY_DELIVERY_GATE=0 已避开 Remediation 冷却,但两次 run
    // 的去重用例仍可能顶到 5s 默认线,给这个 describe 放宽。
    jest.setTimeout(30000);

    const REVIEW = {
      performed: true,
      reviewModel: 'deepseek-chat',
      reviewVendor: 'deepseek',
      primaryVendor: 'anthropic',
      verdict: 'issues',
      issues: [
        '金额解析未处理千分位逗号,1,234.56 被截断为 1',
        '缺少对负值的校验,退款场景会算出正数',
      ],
      suggestedFixes: [
        '解析前统一 strip 千分位再 parseFloat',
        '对 amount < 0 的输入直接拒绝并报错',
      ],
      remediationPrompt: '[SYSTEM: 跨模型交叉验证发现以下问题，请修复]',
      stage: 'S1',
    };

    const savedEnv = {};
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-p1-2-mem-'));
      savedEnv.reflection = process.env.KHY_MEMORY_REFLECTION;
      savedEnv.memoryDir = process.env.KHY_MEMORY_DIR;
      savedEnv.mergeLegacy = process.env.KHY_MEMORY_MERGE_LEGACY;
      savedEnv.deliveryGate = process.env.KHY_DELIVERY_GATE;
      savedEnv.cmvRemediate = process.env.KHY_CROSS_MODEL_REMEDIATE;
      process.env.KHY_MEMORY_DIR = tmpDir;
      process.env.KHY_MEMORY_MERGE_LEGACY = '0'; // 别把本机既有记忆拷进临时目录
      process.env.KHY_DELIVERY_GATE = '0'; // 避开交付门 1500ms Remediation 冷却
      process.env.KHY_CROSS_MODEL_REMEDIATE = '0'; // 只验沉淀,不跑 Remediation 轮
      memPaths._resetCache(); // 路径解析有进程内缓存,env 改完必须重置
    });

    afterEach(() => {
      if (savedEnv.reflection === undefined) delete process.env.KHY_MEMORY_REFLECTION; else process.env.KHY_MEMORY_REFLECTION = savedEnv.reflection;
      if (savedEnv.memoryDir === undefined) delete process.env.KHY_MEMORY_DIR; else process.env.KHY_MEMORY_DIR = savedEnv.memoryDir;
      if (savedEnv.mergeLegacy === undefined) delete process.env.KHY_MEMORY_MERGE_LEGACY; else process.env.KHY_MEMORY_MERGE_LEGACY = savedEnv.mergeLegacy;
      if (savedEnv.deliveryGate === undefined) delete process.env.KHY_DELIVERY_GATE; else process.env.KHY_DELIVERY_GATE = savedEnv.deliveryGate;
      if (savedEnv.cmvRemediate === undefined) delete process.env.KHY_CROSS_MODEL_REMEDIATE; else process.env.KHY_CROSS_MODEL_REMEDIATE = savedEnv.cmvRemediate;
      memPaths._resetCache();
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* 临时目录清理 best-effort */
      }
    });

    function lessonFiles() {
      return fs
        .readdirSync(tmpDir)
        .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
    }

    async function runOnce(events) {
      contextRouter.routeContextStrategy.mockReturnValue({
        route: 'fits',
        overflow: 0,
        toolResultTokens: 0,
      });
      toolUseLoop.runToolUseLoop.mockResolvedValue({
        finalResponse: '已修复金额解析',
        errorType: null,
        toolCallLog: [],
        iterations: 1,
        provider: 'mock',
      });
      const harness = createAgenticHarness({ continuationCooldownMs: 0 });
      return harness.run({
        userMessage: '修复 parser 的金额解析 bug',
        chat: async () => ({ reply: 'unused' }),
        onEvent: (e) => events.push(e),
      });
    }

    test('一条跨模型复盘落 cross_session 记忆(真实写入,隔离目录)', async () => {
      process.env.KHY_MEMORY_REFLECTION = '1';
      crossModelVerify.verify.mockResolvedValue({ ...REVIEW });

      const events = [];
      const result = await runOnce(events);

      const files = lessonFiles();
      expect(files.length).toBe(1);
      expect(files[0].startsWith('feedback_')).toBe(true);
      const saved = memdir.readMemory(files[0]);
      expect(saved.exists).toBe(true);
      expect(saved.frontmatter.type).toBe('feedback');
      expect(saved.frontmatter.tier).toBe('cross_session');
      expect(saved.body).toContain('金额解析未处理千分位逗号');
      expect(saved.body).toContain('建议修复方向:');
      expect(events.find((e) => e.type === 'reflection_memory')).toMatchObject({
        action: 'write',
        tier: 'cross_session',
        issueCount: 2,
      });
      // S1 观察数据随 harnessReport 进 session trace
      expect(result.harness.crossModelVerify.reflectionMemory).toMatchObject({
        action: 'write',
        tier: 'cross_session',
        issueCount: 2,
      });
    });

    test('重复复盘不二次写入(同一复盘第二次 run 被去重)', async () => {
      process.env.KHY_MEMORY_REFLECTION = '1';
      crossModelVerify.verify.mockResolvedValue({ ...REVIEW });

      const events = [];
      await runOnce(events);
      await runOnce(events);

      // 库内仍只有一条教训——重复复盘不会堆副本,也就无处「二次注入」
      expect(lessonFiles().length).toBe(1);
      const actions = events
        .filter((e) => e.type === 'reflection_memory')
        .map((e) => e.action);
      expect(actions).toEqual(['write', 'skip']);
    });

    test('门控默认关不沉淀;低质复盘(无修复方向)被门槛拦在库外', async () => {
      delete process.env.KHY_MEMORY_REFLECTION; // 默认关
      crossModelVerify.verify.mockResolvedValue({ ...REVIEW });

      const events = [];
      await runOnce(events);
      expect(lessonFiles().length).toBe(0);
      expect(events.find((e) => e.type === 'reflection_memory')).toBeUndefined();

      process.env.KHY_MEMORY_REFLECTION = '1';
      crossModelVerify.verify.mockResolvedValue({
        ...REVIEW,
        suggestedFixes: [], // 有问题没下一步 ⇒ 完整度 0.5,不过 0.9 线
      });
      await runOnce(events);
      expect(lessonFiles().length).toBe(0);
      expect(events.find((e) => e.type === 'reflection_memory')).toBeUndefined();
    });
  });
});

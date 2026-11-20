'use strict';

const {
  GOAL_TRIGGER_RE,
  extractGoal,
  preflightCheck,
  formatPreflightFailure,
  activate,
  deactivate,
  buildCompletionReport,
} = require('../../src/services/goalModeService');

describe('goalModeService', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ── extractGoal ────────────────────────────────────────────────────

  describe('extractGoal', () => {
    test('extracts Chinese goal with full-width colon', () => {
      expect(extractGoal('目标：构建一个 REST API')).toBe('构建一个 REST API');
    });

    test('extracts Chinese goal with half-width colon', () => {
      expect(extractGoal('目标:修复登录 bug')).toBe('修复登录 bug');
    });

    test('extracts English goal', () => {
      expect(extractGoal('goal: build a todo app')).toBe('build a todo app');
    });

    test('extracts goal case-insensitively', () => {
      expect(extractGoal('Goal: Create project')).toBe('Create project');
      expect(extractGoal('GOAL: Deploy service')).toBe('Deploy service');
    });

    test('returns null for non-goal input', () => {
      expect(extractGoal('请帮我修复这个 bug')).toBeNull();
      expect(extractGoal('ultrawork fix issue')).toBeNull();
      expect(extractGoal('')).toBeNull();
      expect(extractGoal(null)).toBeNull();
    });

    test('extracts multiline goal (first line)', () => {
      const text = '目标：搭建一个完整的电商系统\n包含用户管理和订单模块';
      const result = extractGoal(text);
      expect(result).toContain('搭建一个完整的电商系统');
    });
  });

  // ── preflightCheck ─────────────────────────────────────────────────

  describe('preflightCheck', () => {
    test('passes with good model and tools', () => {
      const result = preflightCheck('build a project', {
        modelName: 'claude-sonnet-4-6',
        enabledTools: ['read', 'write', 'edit', 'bash', 'glob', 'grep'],
      });
      expect(result.canProceed).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });

    test('rejects low-tier model (mini)', () => {
      const result = preflightCheck('build a project', {
        modelName: 'gpt-4o-mini',
        enabledTools: ['read', 'write', 'bash'],
      });
      expect(result.canProceed).toBe(false);
      expect(result.reasons.some(r => r.includes('等级过低'))).toBe(true);
    });

    test('rejects low-tier model (7b)', () => {
      const result = preflightCheck('build a project', {
        modelName: 'qwen-7b-chat',
        enabledTools: ['read', 'write', 'bash'],
      });
      expect(result.canProceed).toBe(false);
    });

    test('rejects low-tier model (flash)', () => {
      const result = preflightCheck('build a project', {
        modelName: 'gemini-flash',
        enabledTools: ['read', 'write', 'bash'],
      });
      expect(result.canProceed).toBe(false);
    });

    test('rejects insufficient context window', () => {
      const result = preflightCheck('build a project', {
        modelName: 'claude-sonnet',
        contextRemaining: 1000,
        contextTotal: 10000,
        enabledTools: ['read', 'write', 'bash'],
      });
      expect(result.canProceed).toBe(false);
      expect(result.reasons.some(r => r.includes('上下文'))).toBe(true);
    });

    test('warns on low context but still proceeds', () => {
      const result = preflightCheck('build a project', {
        modelName: 'claude-sonnet',
        contextRemaining: 4000,
        contextTotal: 10000,
        enabledTools: ['read', 'write', 'bash'],
      });
      expect(result.canProceed).toBe(true);
      expect(result.warnings.some(w => w.includes('偏低'))).toBe(true);
    });

    test('rejects missing file tools', () => {
      const result = preflightCheck('build a project', {
        modelName: 'claude-sonnet',
        enabledTools: ['bash', 'glob'],
      });
      expect(result.canProceed).toBe(false);
      expect(result.reasons.some(r => r.includes('文件操作'))).toBe(true);
    });

    test('warns on missing shell tool', () => {
      const result = preflightCheck('build a project', {
        modelName: 'claude-sonnet',
        enabledTools: ['read', 'write', 'edit', 'glob'],
      });
      expect(result.canProceed).toBe(true);
      expect(result.warnings.some(w => w.includes('shell'))).toBe(true);
    });

    test('skips tool check when no tools provided', () => {
      const result = preflightCheck('build a project', {
        modelName: 'claude-sonnet',
      });
      expect(result.canProceed).toBe(true);
    });

    test('uses env var for model name when not provided', () => {
      process.env.GATEWAY_PREFERRED_MODEL = 'gpt-4o-mini';
      const result = preflightCheck('build', { enabledTools: ['read', 'write', 'bash'] });
      expect(result.canProceed).toBe(false);
    });
  });

  // ── formatPreflightFailure ─────────────────────────────────────────

  describe('formatPreflightFailure', () => {
    test('formats failure report with reasons and warnings', () => {
      const report = formatPreflightFailure({
        canProceed: false,
        reasons: ['模型等级过低'],
        warnings: ['shell 工具缺失'],
        assessment: {},
      });
      expect(report).toContain('前置检查未通过');
      expect(report).toContain('模型等级过低');
      expect(report).toContain('shell 工具缺失');
      expect(report).toContain('建议');
    });
  });

  // ── activate / deactivate ──────────────────────────────────────────

  describe('activate / deactivate', () => {
    test('sets and clears environment variables', () => {
      delete process.env.KHY_GOAL_MODE_ACTIVE;
      delete process.env.KHY_PLAN_AUTO_APPROVE_MS;

      const saved = activate();

      expect(process.env.KHY_GOAL_MODE_ACTIVE).toBe('true');
      expect(process.env.KHY_PLAN_AUTO_APPROVE_MS).toBe('1');

      deactivate(saved);

      expect(process.env.KHY_GOAL_MODE_ACTIVE).toBeUndefined();
      expect(process.env.KHY_PLAN_AUTO_APPROVE_MS).toBeUndefined();
    });

    test('restores previous env values after deactivate', () => {
      process.env.KHY_GOAL_MODE_ACTIVE = 'some-value';
      process.env.KHY_PLAN_AUTO_APPROVE_MS = '5000';

      const saved = activate();

      expect(process.env.KHY_GOAL_MODE_ACTIVE).toBe('true');
      expect(process.env.KHY_PLAN_AUTO_APPROVE_MS).toBe('1');

      deactivate(saved);

      expect(process.env.KHY_GOAL_MODE_ACTIVE).toBe('some-value');
      expect(process.env.KHY_PLAN_AUTO_APPROVE_MS).toBe('5000');
    });

    test('deactivate handles null savedState gracefully', () => {
      process.env.KHY_GOAL_MODE_ACTIVE = 'true';
      expect(() => deactivate(null)).not.toThrow();
    });
  });

  // ── buildCompletionReport ──────────────────────────────────────────

  describe('buildCompletionReport', () => {
    test('builds success report', () => {
      const report = buildCompletionReport({
        goalText: '构建 REST API',
        success: true,
        elapsed: 65000,
        steps: [
          { id: 1, description: '创建项目结构', status: 'completed' },
          { id: 2, description: '编写路由', status: 'completed' },
        ],
        deliverables: ['server.js', 'routes/api.js'],
      });
      expect(report).toContain('执行完成');
      expect(report).toContain('成功');
      expect(report).toContain('构建 REST API');
      expect(report).toContain('1分');
      expect(report).toContain('server.js');
    });

    test('builds failure report', () => {
      const report = buildCompletionReport({
        goalText: '部署服务',
        success: false,
        error: '网络超时',
      });
      expect(report).toContain('执行结束');
      expect(report).toContain('失败');
      expect(report).toContain('网络超时');
    });
  });

  // ── GOAL_TRIGGER_RE ────────────────────────────────────────────────

  describe('GOAL_TRIGGER_RE', () => {
    test('matches Chinese goal prefix', () => {
      expect(GOAL_TRIGGER_RE.test('目标：构建项目')).toBe(true);
      expect(GOAL_TRIGGER_RE.test('目标:修复bug')).toBe(true);
    });

    test('matches English goal prefix', () => {
      expect(GOAL_TRIGGER_RE.test('goal: build app')).toBe(true);
      expect(GOAL_TRIGGER_RE.test('Goal: fix bug')).toBe(true);
    });

    test('does not match goal in middle of text', () => {
      expect(GOAL_TRIGGER_RE.test('my goal is to build')).toBe(false);
      expect(GOAL_TRIGGER_RE.test('这不是目标：而是描述')).toBe(false);
    });
  });

  // ── 提权边界（AGT-01）────────────────────────────────────────────────
  //
  // 一次 goal/coding 轮次会把进程级权限提到 yolo。此前 setProfile 按默认语义
  // **落盘**，于是进程被 SIGKILL/崩溃时 finally 不执行，permissions.json 里留下
  // profile:'yolo' —— 此后每次启动都是全自动放行，用户无从得知。
  describe('activate/deactivate 的提权边界', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');

    /** 把 app home 指到临时目录，并重载模块，使 permissionStore 重新解析落盘位置。 */
    function withTempAppHome(fn) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-goalmode-'));
      const prev = process.env.KHY_APP_HOME;
      process.env.KHY_APP_HOME = dir;
      jest.resetModules();
      try {
        return fn(dir);
      } finally {
        if (prev === undefined) delete process.env.KHY_APP_HOME;
        else process.env.KHY_APP_HOME = prev;
        jest.resetModules();
      }
    }

    test('提权只改内存，磁盘档案里的 profile 不被改写成 yolo', () => {
      withTempAppHome((dir) => {
        const permissionsFile = path.join(dir, 'permissions.json');
        fs.writeFileSync(permissionsFile, JSON.stringify({ profile: 'normal' }), 'utf8');

        const permissionStore = require('../../src/services/permissionStore');
        const goal = require('../../src/services/goalModeService');

        const saved = goal.activate();
        try {
          expect(permissionStore.getProfile()).toBe('yolo');
          const onDisk = JSON.parse(fs.readFileSync(permissionsFile, 'utf8'));
          expect(onDisk.profile).toBe('normal');
        } finally {
          goal.deactivate(saved);
        }
        // 恢复同样不落盘
        expect(permissionStore.getProfile()).toBe('normal');
        expect(JSON.parse(fs.readFileSync(permissionsFile, 'utf8')).profile).toBe('normal');
      });
    });

    test('并发 goal 会话：先结束的不能把提权撤掉', () => {
      withTempAppHome(() => {
        const permissionStore = require('../../src/services/permissionStore');
        const goal = require('../../src/services/goalModeService');

        const first = goal.activateIfNeeded();
        const second = goal.activateIfNeeded();
        expect(first).not.toBeNull();
        expect(second).not.toBeNull();

        // 第一个会话先结束 → 提权仍在（第二个会话还在跑）
        goal.deactivateIfNeeded(first);
        expect(permissionStore.getProfile()).toBe('yolo');

        // 最后一个会话结束 → 提权撤销，恢复到提权前的档案
        goal.deactivateIfNeeded(second);
        expect(permissionStore.getProfile()).not.toBe('yolo');
        expect(process.env.KHY_GOAL_MODE_ACTIVE).toBeUndefined();
      });
    });
  });
});

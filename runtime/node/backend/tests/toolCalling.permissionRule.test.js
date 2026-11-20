'use strict';

/**
 * permissionRule — the out-of-band "who let this through" evidence.
 *
 * requestPermission keeps returning a bare string, so the branch that produced
 * the decision is exposed through lastPermissionRule(params). These tests pin:
 *   1. the auto-allow branches carry distinct, stable labels;
 *   2. allow-always / allow-session are no longer collapsed into allow;
 *   3. audit records carry permissionRule and old records still read;
 *   4. receipt rendering appends the rule only when the record has one.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const originalEnv = { ...process.env };
jest.setTimeout(30000);
const mockExecApprovedSymbol = Symbol('EXEC_APPROVED');
let tmpHome;
let perm;
let mockTools = {};
const mockPolicy = { decision: null };
const mockStore = { decision: 'ask' };

function fakeTool(name, over = {}) {
  mockTools[name] = {
    name,
    risk: 'medium',
    isReadOnly: () => false,
    isDestructive: () => false,
    ...over,
  };
  return mockTools[name];
}

function loadPermissionsModule() {
  jest.doMock('os', () => ({ ...jest.requireActual('os'), homedir: () => tmpHome }));
  jest.doMock('../src/tools', () => ({ get: (name) => mockTools[name] }));
  jest.doMock('../src/services/permissionStore', () => ({
    check: jest.fn(() => mockStore.decision),
    approve: jest.fn(),
    deny: jest.fn(),
    setProfile: jest.fn(),
    getProfile: jest.fn(() => 'normal'),
  }));
  jest.doMock('../src/services/permissionPolicy', () => ({
    evaluate: jest.fn(() => (mockPolicy.decision ? { decision: mockPolicy.decision } : null)),
  }));
  jest.doMock('../src/services/execApproval', () => ({ EXEC_APPROVED: mockExecApprovedSymbol }));

  const mod = require('../src/services/tool/toolCallingPermissions');
  mod.setPermissionResolvers({
    resolveToolDescriptor: (name) =>
      mockTools[name] ? { tool: mockTools[name], resolvedName: name } : null,
    findBuiltinTool: (name) => mockTools[name] || null,
  });
  return mod;
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockTools = {};
  mockPolicy.decision = null;
  mockStore.decision = 'ask';
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-perm-rule-'));
  process.env.KHY_HUMAN_GATE = 'off';
  process.env.KHY_AUTO_APPROVE_READONLY = 'on';
  delete process.env.KHY_PERMISSION_STORE;
  delete process.env.KHY_LEGACY_PERMISSION_UI;
  perm = loadPermissionsModule();
});

afterEach(() => {
  process.env = { ...originalEnv };
  jest.resetModules();
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('requestPermission rule labels', () => {
  test('each auto-allow path produces a distinct, stable label', async () => {
    fakeTool('t_medium');
    fakeTool('t_safe', { risk: 'safe' });
    fakeTool('t_low', { risk: 'low' });
    fakeTool('t_readonly', { risk: 'medium', isReadOnly: () => true });
    fakeTool('write', { risk: 'medium' });

    const labels = {};
    const record = async (name, params, channel) => {
      const decision = await perm.requestPermission(name, params, channel);
      labels[name + ':' + decision] = perm.lastPermissionRule(params);
      return decision;
    };

    const pExec = { [mockExecApprovedSymbol]: true };
    expect(await perm.requestPermission('t_medium', pExec)).toBe('allow');
    labels['exec-approved'] = perm.lastPermissionRule(pExec);

    perm.setPreflightContext(new Set(['preflight']));
    await record('preflight', {}, null);
    perm.clearPreflightContext();

    mockStore.decision = 'allow';
    await record('store', {}, null);
    mockStore.decision = 'ask';

    mockPolicy.decision = 'auto';
    await record('policy', {}, null);
    mockPolicy.decision = null;

    await record('t_safe', {}, null);
    await record('t_low', {}, null);
    await record('t_readonly', {}, null);

    perm.setPermissionMode('acceptEdits');
    await record('write', {}, null);

    perm.setPermissionMode('bypass');
    await record('bypass', {}, null);

    perm.setPermissionMode('default');
    fakeTool('t_prior');
    perm.approveTool('t_prior');
    await record('t_prior', {}, null);

    await record('human', {}, async () => true);
    await record('human-always', {}, async () => 'always');

    expect(labels).toMatchObject({
      'exec-approved': 'exec-approved',
      'preflight:allow': 'preflight-batch',
      'store:allow': 'persisted-allow',
      'policy:allow': 'policy-whitelist',
      't_safe:allow': 'risk-safe',
      't_low:allow': 'risk-low',
      't_readonly:allow': 'read-only-default',
      'write:allow': 'accept-edits-mode',
      'bypass:allow': 'bypass-mode',
      't_prior:allow': 'prior-allow',
      'human:allow': 'user-allow',
      'human-always:allow-always': 'user-allow-always',
    });
    const values = Object.values(labels);
    expect(new Set(values).size).toBe(values.length);
  });

  test('allow-always and the legacy session answer are not collapsed to allow', async () => {
    fakeTool('t_medium');
    const pAlways = {};
    expect(await perm.requestPermission('t_medium', pAlways, async () => 'always')).toBe(
      'allow-always'
    );
    expect(perm.lastPermissionRule(pAlways)).toBe('user-allow-always');

    fakeTool('t_legacy');
    process.env.KHY_LEGACY_PERMISSION_UI = 'true';
    perm.setReadlineProvider({ question: (_prompt, cb) => cb('s') });
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const pSession = {};
    const decision = await perm.requestPermission('t_legacy', pSession);
    spy.mockRestore();
    expect(decision).toBe('allow-session');
    expect(perm.lastPermissionRule(pSession)).toBe('user-allow-session');
  });
});

describe('exec approval reader', () => {
  test('preserves allow-always instead of folding it into allow', async () => {
    jest.resetModules();
    jest.doMock('../src/services/permissionStore', () => ({ getProfile: () => 'normal' }));
    jest.doMock('../src/services/execApproval', () => ({
      EXEC_APPROVED: mockExecApprovedSymbol,
      execApproval: null,
    }));
    process.env.KHY_EXEC_APPROVAL = 'on';

    const approval = require('../src/services/tool/loop/approval');
    expect(approval._readControlDecision('always')).toBe('allow-always');
    expect(approval._readControlDecision({ behavior: 'allow-always' })).toBe('allow-always');
    expect(approval._readControlDecision(true)).toBe('allow');
    expect(approval._readControlDecision(null)).toBe('deny');

    const verdict = await approval._resolveExecApproval(
      { params: { command: 'ls' } },
      { requestId: 'r-1' },
      async () => 'always'
    );
    expect(verdict).toBe('allow-always');
  });
});

describe('audit and receipt carry the rule', () => {
  test('audit log stores permissionRule; old records still read', () => {
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-audit-rule-'));
    process.env.KHY_APP_HOME = appHome;
    jest.resetModules();
    jest.doMock('../src/utils/dataHome', () => ({ getAppHome: () => appHome }));
    const audit = require('../src/services/auditLog');
    audit._resetForTest();

    audit.logToolExecution({
      tool: 'Read',
      params: { file_path: 'x' },
      result: { success: true },
      permission: 'allow',
      permissionRule: 'risk-low',
      elapsed: 3,
    });
    const file = audit.getAuditFilePath();
    const rec = JSON.parse(fs.readFileSync(file, 'utf8').trim());
    expect(rec.permission).toBe('allow');
    expect(rec.permissionRule).toBe('risk-low');

    fs.writeFileSync(
      file,
      JSON.stringify({
        timestamp: '2026-01-01T00:00:00.000Z',
        tool: 'Old',
        params: {},
        result: { success: true },
        permission: 'allow',
        elapsed: 1,
        user: 'u',
        sessionId: 's',
      }) + '\n'
    );
    const rows = audit.queryAuditLog({ limit: 10 });
    expect(rows.some((r) => r.tool === 'Old' && r.permissionRule === undefined)).toBe(true);

    fs.rmSync(appHome, { recursive: true, force: true });
  });

  test('receipt show prints the rule only when present and maps session labels', async () => {
    jest.resetModules();
    const fixture = {
      id: 'RCPT-1',
      status: 'completed',
      goal: 'probe',
      startedAt: '2026-01-01T00:00:00.000Z',
      toolChain: [
        {
          seq: 1,
          tool: 'Read',
          status: 'ok',
          elapsedMs: 5,
          risk: 'low',
          stepType: 'flexible',
          permission: 'allow',
          error: null,
        },
      ],
      artifacts: { files: [] },
      riskApproval: { maxRisk: 'low', humanGated: [], denied: [], permissions: { allow: 1 } },
      counts: { tools: 1, ok: 1, failed: 0 },
      durationMs: 5,
      error: null,
    };
    jest.doMock('../src/services/receiptService', () => ({
      getReceipt: () => fixture,
      listReceipts: () => [],
    }));
    const { handleReceipts } = require('../src/cli/handlers/receipts');
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const lines = [];
    spy.mockImplementation((...args) => lines.push(args.join(' ')));

    await handleReceipts('show', ['RCPT-1'], {});
    let out = lines.join('\n');
    expect(out).not.toContain('undefined');
    expect(out).not.toContain('依据');

    fixture.toolChain[0].permission = 'allow-always';
    fixture.toolChain[0].permissionRule = 'user-allow-always';
    lines.length = 0;
    await handleReceipts('show', ['RCPT-1'], {});
    spy.mockRestore();
    out = lines.join('\n');
    expect(out).toContain('依据 user-allow-always');
    expect(out).toContain('始终允许');
  });
});

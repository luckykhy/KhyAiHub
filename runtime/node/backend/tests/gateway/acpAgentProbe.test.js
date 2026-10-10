'use strict';

/**
 * acpAgentProbe.test.js — locks the four-state probe's pure classification and
 * its IO seams with injected deps (no real subprocess is ever spawned here).
 *
 * Covers [MGMT-PLAN-011] L4:
 *   - classifyProbe: every branch of the four-state table
 *   - resolveOnPath: Windows `.cmd/.ps1/.bat` shim fallback (npm-global installs)
 *   - probeVersion: ok / failed / timeout are three distinct outcomes
 *   - probeAgent: end-to-end with injected deps, incl. "installed but not logged in"
 *
 * The point of the whole module: `detect()` returns a boolean, but `khy onboard`
 * (T-025) must distinguish "not installed" from "installed but not logged in" —
 * the latter is the only state the user can fix themselves.
 */

const {
  AGENT_STATE,
  PROBE_ERROR,
  classifyProbe,
  resolveOnPath,
  probeVersion,
  probeAgent,
  defaultOpenSession,
} = require('../../src/services/gateway/adapters/acpAgentProbe');

/** 造一个「按 candidate 依次回调」的假 execFile，用来驱动 resolveOnPath/probeVersion。 */
function fakeExecFile(outcomes) {
  const calls = [];
  const fn = (bin, args, opts, cb) => {
    calls.push({ bin, args, opts });
    const outcome = outcomes.shift();
    if (!outcome) {
      cb(new Error('unexpected call'), '', '');
      return;
    }
    if (outcome.throw) throw outcome.throw;
    setImmediate(() => cb(outcome.err || null, outcome.stdout || '', outcome.stderr || ''));
  };
  fn.calls = calls;
  return fn;
}

describe('classifyProbe', () => {
  test('unregistered agent is not_installed with a registry hint', () => {
    const r = classifyProbe({ registered: false });
    expect(r.state).toBe(AGENT_STATE.NOT_INSTALLED);
    expect(r.errorCode).toBe(PROBE_ERROR.COMMAND_NOT_FOUND);
    expect(r.hint).toContain('KHY_ACPCLIENT_AGENTS');
  });

  test('PATH-unreachable is not_installed', () => {
    const r = classifyProbe({ registered: true, onPath: false });
    expect(r.state).toBe(AGENT_STATE.NOT_INSTALLED);
    expect(r.errorCode).toBe(PROBE_ERROR.COMMAND_NOT_FOUND);
  });

  test('a version timeout is its own state, not a failure', () => {
    const r = classifyProbe({ registered: true, onPath: true, version: 'timeout' });
    expect(r.state).toBe(AGENT_STATE.UNAVAILABLE);
    expect(r.errorCode).toBe(PROBE_ERROR.VERSION_PROBE_TIMEOUT);
    expect(r.hint).toContain('重试');
  });

  test('a non-zero --version exit is unavailable (PATH-reachable is NOT enough)', () => {
    const r = classifyProbe({ registered: true, onPath: true, version: 'failed' });
    expect(r.state).toBe(AGENT_STATE.UNAVAILABLE);
    expect(r.errorCode).toBe(PROBE_ERROR.VERSION_PROBE_FAILED);
  });

  test('explicit path may skip the version probe', () => {
    expect(classifyProbe({ registered: true, onPath: true, version: 'skipped' }).state).toBe(AGENT_STATE.READY);
  });

  test('an auth-gated session is auth_required, not offline', () => {
    const r = classifyProbe({
      registered: true, onPath: true, version: 'ok',
      session: { ok: false, errorCode: PROBE_ERROR.AUTH_REQUIRED },
    });
    expect(r.state).toBe(AGENT_STATE.AUTH_REQUIRED);
    expect(r.errorCode).toBe(PROBE_ERROR.AUTH_REQUIRED);
  });

  test('a non-auth session failure stays unavailable', () => {
    const r = classifyProbe({
      registered: true, onPath: true, version: 'ok',
      session: { ok: false, errorCode: PROBE_ERROR.SESSION_PROBE_FAILED, message: 'boom' },
    });
    expect(r.state).toBe(AGENT_STATE.UNAVAILABLE);
    expect(r.errorCode).toBe(PROBE_ERROR.SESSION_PROBE_FAILED);
  });

  test('a healthy handshake is ready', () => {
    expect(classifyProbe({ registered: true, onPath: true, version: 'ok', session: { ok: true } }).state)
      .toBe(AGENT_STATE.READY);
  });

  test('tolerates empty facts', () => {
    expect(() => classifyProbe()).not.toThrow();
    expect(classifyProbe(null).state).toBe(AGENT_STATE.NOT_INSTALLED);
  });
});

describe('resolveOnPath', () => {
  test('finds a bare command on the first candidate', async () => {
    const exec = fakeExecFile([{ stdout: 'C:\\tools\\claude.cmd\r\n' }]);
    const r = await resolveOnPath('claude', { platform: 'win32', execFile: exec });
    expect(r.onPath).toBe(true);
    expect(r.resolvedPath).toBe('C:\\tools\\claude.cmd');
    expect(exec.calls[0].bin).toBe('where');
  });

  test('falls back to .cmd/.ps1/.bat shims when the bare name misses', async () => {
    // where claude -> fail；where claude.cmd -> hit（npm 全局装的典型形态）
    const exec = fakeExecFile([
      { err: new Error('not found') },
      { stdout: 'C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd\r\n' },
    ]);
    const r = await resolveOnPath('claude', { platform: 'win32', execFile: exec });
    expect(r.onPath).toBe(true);
    expect(exec.calls.map((c) => c.args[0])).toEqual(['claude', 'claude.cmd', 'claude.ps1', 'claude.bat']);
  });

  test('reports unreachable when every candidate misses', async () => {
    const exec = fakeExecFile([
      { err: new Error('nope') }, { err: new Error('nope') },
      { err: new Error('nope') }, { err: new Error('nope') },
    ]);
    const r = await resolveOnPath('ghost', { platform: 'win32', execFile: exec });
    expect(r.onPath).toBe(false);
    expect(r.resolvedPath).toBeUndefined();
  });

  test('uses which on non-Windows and never throws when execFile throws', async () => {
    const exec = fakeExecFile([{ throw: new Error('spawn failed') }]);
    const r = await resolveOnPath('claude', { platform: 'linux', execFile: exec });
    expect(exec.calls[0].bin).toBe('which');
    expect(r.onPath).toBe(false);
  });
});

describe('probeVersion', () => {
  test('ok when the process exits zero', async () => {
    const exec = fakeExecFile([{ stdout: '1.2.3' }]);
    expect((await probeVersion('claude', [], { execFile: exec })).version).toBe('ok');
    expect(exec.calls[0].args[0]).toBe('--version');
  });

  test('failed on a non-zero exit', async () => {
    const exec = fakeExecFile([{ err: new Error('exit 1') }]);
    expect((await probeVersion('claude', [], { execFile: exec })).version).toBe('failed');
  });

  test('timeout is distinct from failure', async () => {
    const err = new Error('killed');
    err.killed = true;
    err.signal = 'SIGTERM';
    const exec = fakeExecFile([{ err }]);
    expect((await probeVersion('claude', [], { execFile: exec })).version).toBe('timeout');
  });

  test('a synchronous spawn throw degrades to failed, never rejects', async () => {
    const exec = fakeExecFile([{ throw: new Error('ENOENT') }]);
    await expect(probeVersion('claude', [], { execFile: exec })).resolves.toEqual({ version: 'failed' });
  });
});

describe('probeAgent (end-to-end, deps injected)', () => {
  const env = { KHY_ACPCLIENT_AGENTS: 'claude-acp=npx @zed-industries/claude-code-acp' };

  test('unregistered key -> not_installed', async () => {
    const r = await probeAgent('nope', {
      env: {},
      resolveAgentCommand: () => null,
    });
    expect(r.state).toBe(AGENT_STATE.NOT_INSTALLED);
    expect(r.errorCode).toBe(PROBE_ERROR.COMMAND_NOT_FOUND);
  });

  test('registered but PATH-unreachable -> not_installed', async () => {
    const r = await probeAgent('claude-acp', {
      env,
      resolveAgentCommand: () => ({ command: 'claude', args: [] }),
      resolveOnPath: async () => ({ onPath: false }),
    });
    expect(r.state).toBe(AGENT_STATE.NOT_INSTALLED);
  });

  test('version timeout -> unavailable/timeout', async () => {
    const r = await probeAgent('claude-acp', {
      env,
      resolveAgentCommand: () => ({ command: 'claude', args: [] }),
      resolveOnPath: async () => ({ onPath: true, resolvedPath: '/usr/bin/claude' }),
      probeVersion: async () => ({ version: 'timeout' }),
    });
    expect(r.state).toBe(AGENT_STATE.UNAVAILABLE);
    expect(r.errorCode).toBe(PROBE_ERROR.VERSION_PROBE_TIMEOUT);
  });

  test('installed but not logged in -> auth_required (the state detect() cannot see)', async () => {
    const r = await probeAgent('claude-acp', {
      env,
      resolveAgentCommand: () => ({ command: 'claude', args: [] }),
      resolveOnPath: async () => ({ onPath: true, resolvedPath: '/usr/bin/claude' }),
      probeVersion: async () => ({ version: 'ok' }),
      openSession: async () => ({ ok: false, errorCode: PROBE_ERROR.AUTH_REQUIRED, message: 'login required' }),
    });
    expect(r.state).toBe(AGENT_STATE.AUTH_REQUIRED);
    expect(r.errorCode).toBe(PROBE_ERROR.AUTH_REQUIRED);
  });

  test('fully healthy -> ready, and the session result is kept as detail', async () => {
    const r = await probeAgent('claude-acp', {
      env,
      resolveAgentCommand: () => ({ command: 'claude', args: [] }),
      resolveOnPath: async () => ({ onPath: true, resolvedPath: '/usr/bin/claude' }),
      probeVersion: async () => ({ version: 'ok' }),
      openSession: async () => ({ ok: true, authMethods: 0 }),
    });
    expect(r.state).toBe(AGENT_STATE.READY);
    expect(r.detail).toEqual({ ok: true, authMethods: 0 });
  });

  test('an explicit path skips the version probe entirely', async () => {
    let versionCalled = false;
    const r = await probeAgent('claude-acp', {
      env,
      resolveAgentCommand: () => ({ command: 'C:\\tools\\claude.cmd', args: [] }),
      resolveOnPath: async () => { throw new Error('must not be called for explicit paths'); },
      probeVersion: async () => { versionCalled = true; return { version: 'ok' }; },
      openSession: async () => ({ ok: true }),
    });
    expect(versionCalled).toBe(false);
    expect(r.state).toBe(AGENT_STATE.READY);
  });

  test('no openSession injected -> ready with an explicit "skipped" note (never a silent ready)', async () => {
    const r = await probeAgent('claude-acp', {
      env,
      resolveAgentCommand: () => ({ command: 'claude', args: [] }),
      resolveOnPath: async () => ({ onPath: true, resolvedPath: '/usr/bin/claude' }),
      probeVersion: async () => ({ version: 'ok' }),
    });
    expect(r.state).toBe(AGENT_STATE.READY);
    expect(r.detail.note).toContain('跳过登录态探测');
  });

  test('a throwing openSession degrades to unavailable, never rejects', async () => {
    const r = await probeAgent('claude-acp', {
      env,
      resolveAgentCommand: () => ({ command: 'claude', args: [] }),
      resolveOnPath: async () => ({ onPath: true }),
      probeVersion: async () => ({ version: 'ok' }),
      openSession: async () => { throw new Error('spawn exploded'); },
    });
    expect(r.state).toBe(AGENT_STATE.UNAVAILABLE);
    expect(r.errorCode).toBe(PROBE_ERROR.SESSION_PROBE_FAILED);
  });

  test('a throwing resolveAgentCommand degrades to not_installed', async () => {
    const r = await probeAgent('claude-acp', {
      env,
      resolveAgentCommand: () => { throw new Error('env unreadable'); },
    });
    expect(r.state).toBe(AGENT_STATE.NOT_INSTALLED);
  });
});

describe('defaultOpenSession', () => {
  test('returns a structured failure when the connection cannot be built', async () => {
    const r = await defaultOpenSession('claude-acp', { command: 'definitely-not-a-real-binary-xyz', args: [] });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(PROBE_ERROR.SESSION_PROBE_FAILED);
    expect(typeof r.message).toBe('string');
  });
});

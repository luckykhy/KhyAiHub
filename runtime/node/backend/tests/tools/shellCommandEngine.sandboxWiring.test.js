'use strict';

/**
 * AGT-04：OS 级沙箱与真实 shell 执行路径的接线。
 *
 * 修复前：toolSandbox 提供 buildSandboxCommand / sandboxedShell，但生产里没有任何
 * 消费方 —— agent 执行的每条 shell 命令都以 backend 进程的完整权限运行，而
 * `isOsSandboxEnabled()` 在 auto 模式下恒宣称隔离（Windows）。
 *
 * 三层断言：
 *   1. wiring guard —— 引擎源码必须引用 toolSandbox（防再次脱钩）；
 *   2. 声明诚实性 —— win32 的 auto 模式不再宣称隔离，显式 true 才启用；
 *   3. 端到端 —— KHY_OS_SANDBOX=true 下经真实 shellCommand 跑命令，输出与
 *      退出码保真（Windows 用 Job 包装：脚本文件 + env 传参 + ProcessStartInfo）。
 */

const fs = require('fs');
const path = require('path');

const engineSource = fs.readFileSync(
  path.join(__dirname, '../../src/tools/shellCommandEngine.js'),
  'utf8'
);

const tool = require('../../src/tools/shellCommand');
const sandbox = require('../../src/services/tool/toolSandbox');

describe('AGT-04 OS 沙箱接线', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('wiring guard：shellCommandEngine 引用了 toolSandbox（防再次脱钩）', () => {
    expect(engineSource).toContain("require('../services/tool/toolSandbox')");
    expect(engineSource).toContain('_applyOsSandbox');
    expect(engineSource).toContain('buildWindowsJobLaunch');
  });

  test('isOsSandboxEnabled：win32 auto 模式不再宣称隔离（此前恒 true 是宣称偏差）', () => {
    if (process.platform !== 'win32') {
      return;
    }
    delete process.env.KHY_OS_SANDBOX;
    expect(sandbox.isOsSandboxEnabled()).toBe(false);
    process.env.KHY_OS_SANDBOX = 'true';
    expect(sandbox.isOsSandboxEnabled()).toBe(true);
  });

  test('buildWindowsJobLaunch：脚本文件 + env 传参，可直接 spawn', () => {
    if (process.platform !== 'win32') {
      return;
    }
    const launch = sandbox.buildWindowsJobLaunch('echo x');
    expect(launch.bin).toBe('powershell.exe');
    expect(launch.args).toContain('-File');
    expect(launch.env.KHY_SANDBOX_CMD).toBe('echo x');
    const scriptPath = launch.args[launch.args.indexOf('-File') + 1];
    expect(fs.existsSync(scriptPath)).toBe(true);
  });

  test('端到端：KHY_OS_SANDBOX=true 下 shell 命令的输出与退出码保真', async () => {
    if (process.platform !== 'win32') {
      return;
    }
    process.env.KHY_OS_SANDBOX = 'true';

    const ok = await tool.execute({ command: 'echo sandbox-wired' }, {});
    expect(ok.exitCode).toBe(0);
    expect(String(ok.output || '')).toContain('sandbox-wired');

    // 退出码语义不被包装层吞掉（旧实现的 -Command 版本实测 3 → 0）
    const nonzero = await tool.execute({ command: 'exit /b 3' }, {});
    expect(nonzero.exitCode).toBe(3);
  });
});

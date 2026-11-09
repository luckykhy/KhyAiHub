'use strict';
/**
 * Regression: a stdio MCP server that exits immediately during startup must
 * fail SOFT (connect() rejects) —it must NOT crash the process with an
 * uncaught 'error' (EPIPE) on the child's stdin socket.
 *
 * Repro history: a CC-bridged server configured with a broken launcher (a 0-byte
 * `npx` that exits 0 without serving) caused khy to write `initialize` into an
 * already-closed stdin. The write's async failure surfaced as an unhandled
 * 'error' event on stdin (write EPIPE) and took the whole process down. The fix
 * attaches a stdin 'error' listener in _connectStdio so the connection instead
 * resolves through the normal startup-exit/timeout path.
 *
 * Uses a REAL subprocess (`node -e process.exit(0)`) in the first case so the
 * actual stdin socket lifecycle is exercised — no mocks there; the later cases
 * spy on console.warn (jest.spyOn) to pin the fail-fast hints. Jest suite
 * (describe/test/expect) — run by `npm test`, not node:test.
 */
const { connectMCPServer, disconnectMCPServer } = require('../src/services/mcp/index');

describe('Mcp Stdin Fail Soft', () => {
  test('stdio server that exits at startup fails soft (no uncaught EPIPE)', async () => {
      let uncaught = null;
      const onUncaught = (e) => { uncaught = e; };
      process.on('uncaughtException', onUncaught);
    
      // A child that exits 0 the instant it starts —never reads stdin, so khy's
      // initialize write lands on a closed pipe (the EPIPE repro).
      const config = {
        type: 'stdio',
        command: process.execPath, // node
        args: ['-e', 'process.exit(0)'],
        env: {},
      };
    
      let rejected = false;
      try {
        await connectMCPServer('failsoft-probe', config, { connectTimeout: 4000 });
      } catch {
        rejected = true; // expected: connect() rejects because the child died at startup
      } finally {
        try { await disconnectMCPServer('failsoft-probe'); } catch { /* already gone */ }
      }
    
      // Give any async stdin 'error' a tick to surface before we assert.
      await new Promise((r) => setTimeout(r, 100));
      process.removeListener('uncaughtException', onUncaught);
    
      expect(uncaught).toBe(null, `must not crash on stdin EPIPE, got: ${uncaught && uncaught.message}`);
      expect(rejected).toBe(true, 'connect() must reject when the server exits during startup');
  });

  test('nonexistent explicit python path fails fast with the rewritten stale warning', async () => {
      // index.js:1382 _connections.set runs BEFORE `await client.connect()`, so a
      // client whose connect() rejects still sits in the singleton map (B30-3) —
      // hence the finally disconnect, without it the next connect under the same
      // name silently reuses the dead client.
      const warnings = [];
      const spy = jest.spyOn(console, 'warn').mockImplementation((...args) => {
        warnings.push(args.join(' '));
      });

      try {
        // Absolute path that does not exist → as_configured + stale:true → warn.
        // Not a Store stub, so the warn gate keeps it (a stub configured directly
        // is diagnosed after exit instead, avoiding two messages for one cause).
        const config = {
          type: 'stdio',
          command: 'C:\\khy-os-no-such-dir\\python.exe',
          args: ['-e', 'process.exit(0)'],
          env: {},
        };

        await expect(
          connectMCPServer('failsoft-stale-probe', config, { connectTimeout: 4000 })
        ).rejects.toThrow(/ENOENT/);
      } finally {
        await disconnectMCPServer('failsoft-stale-probe');
        spy.mockRestore();
      }

      expect(warnings.join('\n')).toMatch(/在本机不可用（探测不到可执行的解释器）/);
      expect(warnings.join('\n')).toMatch(/PYTHON_PATH/);
  });

  test('a configured Store alias stub path does NOT emit the stale warn (exit diagnosis owns that cause)', async () => {
      // Pins the `&& !isStoreAliasStub(resolved.command)` gate in index.js: deleting
      // that clause makes this case warn — and the same root cause would then be
      // reported twice (spawn-前 warn + exit-后 diagnosis). A NON-EXISTENT WindowsApps
      // path is enough: the warn fires before spawn, so no real stub is needed.
      const warnings = [];
      const spy = jest.spyOn(console, 'warn').mockImplementation((...args) => {
        warnings.push(args.join(' '));
      });

      try {
        const config = {
          type: 'stdio',
          command: 'C:\\khy-os-no-such-dir\\Microsoft\\WindowsApps\\python.exe',
          args: ['-e', 'process.exit(0)'],
          env: {},
        };

        // stale:true (existsSync false) but suppressed by the stub gate → spawn
        // still fails, here with ENOENT because the path does not exist.
        await expect(
          connectMCPServer('failsoft-stub-gate', config, { connectTimeout: 4000 })
        ).rejects.toThrow(/ENOENT/);
      } finally {
        await disconnectMCPServer('failsoft-stub-gate');
        spy.mockRestore();
      }

      expect(warnings).toHaveLength(0);
  });

  test('a bare non-python launcher does NOT get the python stale hint (factory presets are npx/uvx)', async () => {
      // Pins the `&& isPythonCommand(resolved.command)` gate in index.js: deleting
      // that clause makes this case warn, and 18 of the 19 factory presets in
      // mcpServerPresets.js launch via npx/uvx — every one of them would print
      // 「把该 server 的 command 改成本机可用的 python.exe …」 on each connect.
      // `npx` is the preset shape: no path separator → as_configured, and
      // fs.existsSync('npx') is false by construction (a PATH lookup, not a stat)
      // → stale:true, so without the gate the python remedy fires.
      const warnings = [];
      const spy = jest.spyOn(console, 'warn').mockImplementation((...args) => {
        warnings.push(args.join(' '));
      });

      try {
        const config = {
          type: 'stdio',
          command: 'npx',
          args: ['--version'],
          env: {},
        };

        // The rejection itself is incidental (ENOENT on Windows, where CreateProcess
        // does not resolve npx.cmd; a fast exit-0 elsewhere) — what this case pins
        // is that no python-specific hint is printed before the spawn.
        await expect(
          connectMCPServer('failsoft-npx-gate', config, { connectTimeout: 4000 })
        ).rejects.toThrow();
      } finally {
        await disconnectMCPServer('failsoft-npx-gate');
        spy.mockRestore();
      }

      expect(warnings).toHaveLength(0);
  });

});


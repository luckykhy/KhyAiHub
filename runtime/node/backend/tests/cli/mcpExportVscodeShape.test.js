'use strict';

/**
 * r68 contract test — `khy mcp export --agent vscode --write` must land the
 * SAME JSON shape the preview advertises (mcp.servers.khyos), merge into an
 * existing servers bucket without polluting it, and leave doctor's detection
 * reading the identical key path.
 *
 * Base defect (repro-before.txt): writeAgentConfig stripped the two-level
 * path and wrote {mcp:{khyos}} while the preview printed {mcp:{servers:{khyos}}};
 * checkAgentConnections looked under a third key ('mcpServers') and could
 * never see a successful write.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const exp = require('../../src/cli/handlers/mcpExport.js');

let tmpDirs = [];

function tmpSettings(seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r68-test-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'settings.json');
  if (seed !== undefined) {
    fs.writeFileSync(file, JSON.stringify(seed, null, 2));
  }
  return file;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

afterEach(() => {
  for (const d of tmpDirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
  jest.restoreAllMocks();
});

describe('r68: mcp export vscode write/preview/detect shape parity', () => {
  test('T0 non-vacuity: preview advertises mcp.servers.khyos', () => {
    const r = exp.generateAgentConfig('vscode');
    expect(r.ok).toBe(true);
    expect(r.config.mcp.servers.khyos).toBeTruthy();
    expect(r.target.serversPath).toEqual(['mcp', 'servers']);
  });

  test('T1 written file is byte-identical in shape to the preview', () => {
    const r = exp.generateAgentConfig('vscode');
    const file = tmpSettings();
    const wr = exp.writeAgentConfig('vscode', r.config, { ...r.target, configFile: file });
    expect(wr.ok).toBe(true);
    expect(readJson(file)).toEqual(r.config);
  });

  test('T2 pre-existing correct servers bucket is preserved and joined', () => {
    const r = exp.generateAgentConfig('vscode');
    const file = tmpSettings({ mcp: { servers: { existingTool: { command: 'x' } } } });
    const wr = exp.writeAgentConfig('vscode', r.config, { ...r.target, configFile: file });
    expect(wr.ok).toBe(true);
    const after = readJson(file);
    expect(after.mcp.servers.existingTool).toEqual({ command: 'x' });
    expect(after.mcp.servers.khyos).toEqual(r.config.mcp.servers.khyos);
    // the defect signature: khyos must NOT sit next to servers
    expect(after.mcp.khyos).toBeUndefined();
  });

  test('T3 doctor detection reads the same path the write used', () => {
    const vscodeTarget = exp.AGENT_TARGETS.vscode;
    // checkAgentConnections reads AGENT_TARGETS paths, so gate existsSync on
    // the real vscode configFile and feed it the shape T1 just wrote.
    const seeded = JSON.stringify({ mcp: { servers: { khyos: { command: 'khy' } } } });
    jest.spyOn(fs, 'existsSync').mockImplementation((p) => String(p) === vscodeTarget.configFile);
    jest.spyOn(fs, 'readFileSync').mockImplementation(() => seeded);
    const rows = exp.checkAgentConnections();
    const vs = rows.find((x) => x.agent === vscodeTarget.label);
    expect(vs).toBeTruthy();
    expect(vs.hasKhyos).toBe(true);
    expect(vs.serverName).toBe('khyos');
  });

  test('T4 standard-format targets keep single-level mcpServers merge', () => {
    const r = exp.generateAgentConfig('claude');
    expect(r.ok).toBe(true);
    const file = tmpSettings({ mcpServers: { other: { command: 'y' } } });
    const wr = exp.writeAgentConfig('claude', r.config, { ...r.target, configFile: file });
    expect(wr.ok).toBe(true);
    const after = readJson(file);
    expect(after.mcpServers.other).toEqual({ command: 'y' });
    expect(after.mcpServers.khyos).toEqual(r.config.khyos);
  });

  test('T5 missing target returns honest failure, never throws', async () => {
    const r = exp.generateAgentConfig('vscode');
    let out;
    expect(() => {
      out = exp.writeAgentConfig('vscode', r.config, undefined);
    }).not.toThrow();
    expect(out.ok).toBe(false);
    expect(out.reason).toBeTruthy();
  });
});

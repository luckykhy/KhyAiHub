'use strict';

/**
 * marketInstallService — dispatch + ledger tests.
 *
 * No network and no real HOME: every case points dataHome/appHome at a temp
 * dir, and the skill installer is injected so the git clone step never runs.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const installService = require('../src/services/marketInstallService');
const mcpConfigStore = require('../src/services/domain/messaging/mcp/mcpConfigStore');

function tempHomes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-market-install-'));
  return {
    root,
    io: { dataHome: path.join(root, 'data'), appHome: path.join(root, 'app') },
  };
}

function skillEntry(overrides) {
  return {
    marketId: 'demo-eco:demo-skill',
    name: 'demo-skill',
    agentScope: ['demo-eco'],
    installSpec: { mode: 'skill', source: 'https://github.com/acme/demo', skills: ['skills/demo'] },
    ...overrides,
  };
}

test('skill install records a ledger row and annotates the entry', async () => {
  const { io } = tempHomes();
  const calls = [];
  const entry = skillEntry();
  const result = await installService.installEntry(entry, {
    io,
    _skillInstall: {
      addFromSource: async (source, opts) => {
        calls.push({ source, opts });
        const dir = path.join(io.dataHome, 'skills', 'demo');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'), '# demo\n', 'utf-8');
        return { name: 'demo', dest: dir };
      },
    },
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.mode, 'skill');
  assert.deepStrictEqual(calls, [{ source: 'https://github.com/acme/demo', opts: { skill: 'skills/demo' } }]);

  const ledger = installService.readLedger({ io });
  assert.strictEqual(ledger.installs['demo-eco:demo-skill'].mode, 'skill');

  const ecosystems = installService.annotateInstalled(
    [{ eco: 'demo-eco', entries: [entry, skillEntry({ marketId: 'demo-eco:other', name: 'other' })] }],
    { io }
  );
  assert.strictEqual(ecosystems[0].entries[0].installed, true);
  assert.strictEqual(ecosystems[0].entries[0].installedSummary, '1 个技能目录');
  assert.strictEqual(ecosystems[0].entries[1].installed, undefined);
});

test('skill install reports partial success when one directory fails', async () => {
  const { io } = tempHomes();
  const entry = skillEntry({
    installSpec: { mode: 'skill', source: 'https://github.com/acme/demo', skills: ['skills/a', 'skills/b'] },
  });
  let call = 0;
  const result = await installService.installEntry(entry, {
    io,
    _skillInstall: {
      addFromSource: async () => {
        call += 1;
        if (call === 2) throw new Error('子目录不存在');
        const dir = path.join(io.dataHome, 'skills', 'a');
        fs.mkdirSync(dir, { recursive: true });
        return { name: 'a', dest: dir };
      },
    },
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.partial, true);
  assert.match(result.message, /失败：skills\/b/);
  assert.strictEqual(result.installed.length, 1);
});

test('mcp install writes user mcp.json, merges values, and uninstalls', async () => {
  const { io } = tempHomes();
  const entry = {
    marketId: 'mcp-registry:io.github.acme/fetch',
    name: 'Fetch',
    agentScope: ['mcp-registry'],
    installSpec: {
      mode: 'mcp',
      name: 'io-github-acme-fetch',
      scope: 'user',
      config: { type: 'stdio', command: 'npx', args: ['-y', '@acme/fetch'] },
    },
    installRequires: {
      env: [
        { name: 'ACME_TOKEN', required: true, secret: true },
        { name: 'ACME_MODE', required: true },
      ],
      headers: [],
    },
  };

  const result = await installService.installEntry(entry, {
    io,
    values: { env: { ACME_TOKEN: 't-1' } },
  });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.missing, ['ACME_MODE']);
  const written = mcpConfigStore.readConfigFile(path.join(io.dataHome, 'mcp.json'));
  assert.deepStrictEqual(written.mcpServers['io-github-acme-fetch'], {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@acme/fetch'],
    env: { ACME_TOKEN: 't-1' },
  });

  const annotated = installService.annotateInstalled([{ eco: 'mcp-registry', entries: [entry] }], { io });
  assert.strictEqual(annotated[0].entries[0].installed, true);
  assert.match(annotated[0].entries[0].installedSummary, /io-github-acme-fetch/);

  const removed = await installService.uninstallEntry(entry, { io });
  assert.strictEqual(removed.ok, true);
  assert.deepStrictEqual(removed.removed, ['io-github-acme-fetch']);
  assert.deepStrictEqual(
    mcpConfigStore.readConfigFile(path.join(io.dataHome, 'mcp.json')).mcpServers,
    {}
  );
  assert.deepStrictEqual(installService.readLedger({ io }).installs, {});
});

test('annotation prunes ledger rows whose artifact is gone', () => {
  const { io } = tempHomes();
  fs.mkdirSync(path.join(io.appHome), { recursive: true });
  installService.readLedger({ io });
  const entry = skillEntry();
  const ledger = { version: 1, installs: {} };
  ledger.installs['demo-eco:demo-skill'] = {
    mode: 'skill',
    at: '2026-01-01T00:00:00.000Z',
    skills: [{ name: 'demo', dir: path.join(io.dataHome, 'skills', 'missing') }],
  };
  fs.writeFileSync(installService.ledgerPath({ io }), JSON.stringify(ledger), 'utf-8');

  const annotated = installService.annotateInstalled([{ eco: 'demo-eco', entries: [entry] }], { io });
  assert.strictEqual(annotated[0].entries[0].installed, undefined);
  assert.deepStrictEqual(installService.readLedger({ io }).installs, {});
});

test('uninstall accepts the mapped skills dir (getDataDir alias of <dataHome>/skills)', async () => {
  const { io } = tempHomes();
  const { DATA_PATHS } = require('../src/utils/dataHome');
  const dir = path.join(io.dataHome, DATA_PATHS.skills, 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# demo\n', 'utf-8');
  fs.mkdirSync(io.appHome, { recursive: true });
  fs.writeFileSync(
    installService.ledgerPath({ io }),
    JSON.stringify({
      version: 1,
      installs: {
        'demo-eco:demo-skill': {
          mode: 'skill',
          at: '2026-01-01T00:00:00.000Z',
          skills: [{ name: 'demo', dir }],
        },
      },
    }),
    'utf-8'
  );

  const result = await installService.uninstallEntry(skillEntry(), { io });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.removed, ['demo']);
  assert.strictEqual(fs.existsSync(dir), false);
});

test('uninstall refuses skill directories outside the managed root', async () => {
  const { io, root } = tempHomes();
  const outside = path.join(root, 'outside-skill');
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(io.appHome, { recursive: true });
  fs.writeFileSync(
    installService.ledgerPath({ io }),
    JSON.stringify({
      version: 1,
      installs: {
        'demo-eco:demo-skill': {
          mode: 'skill',
          at: '2026-01-01T00:00:00.000Z',
          skills: [{ name: 'demo', dir: outside }],
        },
      },
    }),
    'utf-8'
  );

  const result = await installService.uninstallEntry(skillEntry(), { io });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /不在可管理范围内/);
  assert.strictEqual(fs.existsSync(outside), true);
});

test('entries without an install spec fail with an actionable message', async () => {
  const result = await installService.installEntry({ name: 'manual', agentScope: ['x'] }, {});
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /没有可执行的安装规格/);
});

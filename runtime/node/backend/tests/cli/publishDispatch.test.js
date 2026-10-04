'use strict';

// Contract for the `publish` dispatch bridge (handlers/publishCmd.js).
// Background: after the publish.js god-file carve-out the verb kept no manifest
// and no router case, so `khy publish check` parsed as a known command yet fell
// through to the AI gateway as raw chat text. These tests pin advertised ==
// dispatchable so that class of rot cannot silently return.

const { MANIFEST_EXPORT_KEY } = require('../../src/cli/commandManifest');

jest.mock('../../src/cli/handlers/publish', () => ({
  handlePublish: jest.fn(async () => true),
}));

describe('publish command dispatch bridge', () => {
  test('auto-registry exposes the publish verb', () => {
    const registry = require('../../src/cli/commandAutoRegistry');
    registry.init();
    expect(registry.size()).toBeGreaterThan(50); // non-vacuity: scan really ran
    expect(registry.getCommandNames()).toContain('publish');
  });

  test('manifest handler delegates (subCommand, args, options) to handlePublish', async () => {
    const { handlePublish } = require('../../src/cli/handlers/publish');
    const bridge = require('../../src/cli/handlers/publishCmd');
    const manifest = bridge[MANIFEST_EXPORT_KEY];
    expect(manifest.name).toBe('publish');
    await manifest.handler({ subCommand: 'check', args: ['extra'], options: { root: '/tmp' } });
    expect(handlePublish).toHaveBeenCalledWith('check', ['extra'], { root: '/tmp' });
  });

  test('manifest covers every schema-advertised publish subcommand (no phantom subs)', () => {
    const { getRouterSubCommands } = require('../../src/constants/commandSchema');
    const advertised = getRouterSubCommands().publish || [];
    expect(advertised.length).toBeGreaterThan(10); // non-vacuity
    const bridge = require('../../src/cli/handlers/publishCmd');
    const covered = new Set(bridge[MANIFEST_EXPORT_KEY].subCommands);
    expect(advertised.filter((s) => !covered.has(s))).toEqual([]);
  });
});

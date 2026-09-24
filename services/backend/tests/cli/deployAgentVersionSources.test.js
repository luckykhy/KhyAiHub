'use strict';

/**
 * r63 anti-rot contract: the LIVE deploy agent's version-sync safety rule must
 * enumerate (or point at) every source the CI gate actually compares.
 * Data-driven on the gate itself — a future 5th G1 source turns these red
 * without anyone remembering to amend the test.
 */

const path = require('path');

const { getBuiltInAgents } = require('../../src/agents/builtInAgents');
const gate = require('../../../../scripts/ci/check-version-sync.js');

function liveG1Files() {
  const groups = gate.VERSION_GROUPS || [];
  const g1 = groups.find((g) => JSON.stringify(g).includes('pyproject.toml'));
  if (!g1) throw new Error('gate no longer exposes a group containing pyproject.toml');
  return g1.files.map((f) => (typeof f === 'string' ? f : f.path || f.file));
}

function liveVersionSyncLine() {
  const deploy = getBuiltInAgents().find((a) => a.agentType === 'deploy');
  if (!deploy) throw new Error('deploy agent missing from default registry');
  const line = deploy.getSystemPrompt().split('\n').find((l) => l.includes('version sync'));
  if (!line) throw new Error('deploy prompt no longer has a version-sync rule');
  return line;
}

describe('deploy agent version-sync rule vs check-version-sync gate', () => {
  test('T0 non-vacuity: gate group is real and deploy agent is LIVE in the default registry', () => {
    expect(liveG1Files().length).toBeGreaterThanOrEqual(4);
    expect(liveVersionSyncLine()).toContain('version sync');
  });

  test('T1 every authoritative G1 source is named in the live prompt line', () => {
    const line = liveVersionSyncLine();
    for (const file of liveG1Files()) {
      expect(line).toContain(file);
    }
  });

  test('T2 the rule points at the gate as the authoritative spec, not just a file list', () => {
    const line = liveVersionSyncLine();
    expect(line).toContain('VERSION_GROUPS');
    expect(line).toContain('check-version-sync.js');
  });

  test('T3 field-free: neighbouring safety rules survive untouched (blast-radius guard)', () => {
    const deploy = getBuiltInAgents().find((a) => a.agentType === 'deploy');
    const sp = deploy.getSystemPrompt();
    expect(sp).toContain('NEVER force-push to main/master branches');
    expect(sp).toContain('NEVER expose secrets');
  });
});

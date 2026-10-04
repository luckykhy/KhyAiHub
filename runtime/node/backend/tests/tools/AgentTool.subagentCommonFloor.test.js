'use strict';
/**
 * AgentTool.subagentCommonFloor.test.js — the role-agnostic sub-agent common
 * floor (evidence / tool surface / closing) injected at the single seam.
 *
 * Locks: (1) the floor block is exported from constraints.js (single source,
 * injected never copy-pasted); (2) a bare-fallback role prompt (no built-in
 * agent def, e.g. the default 'general-purpose' path or schema-documented
 * 'reviewer'/'coder'/'codex'/'claude') gets floor AFTER scope and BEFORE the
 * role text; (3) idempotence — a role prompt that already embeds the canonical
 * discipline/prohibition blocks must NOT receive a second copy (prompt noise);
 * (4) KHY_SUBAGENT_COMMON_FLOOR=0/false/off/no → byte-identical fallback to
 * the pre-floor composition. Whoever changes the floor text changes (1) first.
 *
 * Who breaks it red: removing the floor injection, reordering scope/floor/role,
 * or double-injecting alongside built-in agent defs.
 */
const { AgentTool } = require('../../src/tools/AgentTool');
const {
  SUBAGENT_EXECUTION_SCOPE,
  SUBAGENT_COMMON_FLOOR,
  EXECUTION_DISCIPLINE,
  HARD_PROHIBITIONS,
} = require('../../src/agents/constraints');

const BARE_ROLE =
  'You are a general-purpose agent. Use available tools to complete the task efficiently.';

describe('SUBAGENT_COMMON_FLOOR block', () => {
  test('is a non-empty exported block carrying the three floor dimensions', () => {
    expect(typeof SUBAGENT_COMMON_FLOOR).toBe('string');
    expect(SUBAGENT_COMMON_FLOOR.length > 0).toBeTruthy();
    // Evidence: verified facts only, failures stay failures.
    expect(SUBAGENT_COMMON_FLOOR).toMatch(/verif|evidence/i);
    expect(SUBAGENT_COMMON_FLOOR).toMatch(/fail/i);
    // Tool surface: only granted tools, never fake a refused call.
    expect(SUBAGENT_COMMON_FLOOR).toMatch(/tool/i);
    // Closing: the final reply must be self-contained and honest.
    expect(SUBAGENT_COMMON_FLOOR).toMatch(/self-contained|final/i);
    // Deliberately NOT borrowed: an enumerated tool whitelist (mechanised
    // elsewhere by buildSubagentDenylist) — the floor declares behaviour only.
    expect(SUBAGENT_COMMON_FLOOR).not.toMatch(/whitelist|allowlist/i);
  });
});

describe('AgentTool.buildSubagentSystemPrompt floor injection', () => {
  test('bare fallback path carries scope AND floor, ordered scope → floor → role', () => {
    const sp = AgentTool.buildSubagentSystemPrompt(BARE_ROLE);
    expect(sp.includes(SUBAGENT_EXECUTION_SCOPE)).toBeTruthy();
    expect(sp.includes(SUBAGENT_COMMON_FLOOR)).toBeTruthy();
    expect(sp.includes(BARE_ROLE)).toBeTruthy();
    expect(sp.indexOf(SUBAGENT_EXECUTION_SCOPE)).toBeLessThan(sp.indexOf(SUBAGENT_COMMON_FLOOR));
    expect(sp.indexOf(SUBAGENT_COMMON_FLOOR)).toBeLessThan(sp.indexOf(BARE_ROLE));
  });

  test('idempotent: role prompt already carrying the canonical blocks gets NO second copy', () => {
    // Regression lock: green before the floor existed (nothing was ever
    // injected into block-carrying prompts). Both anchors must suppress.
    for (const carrier of [EXECUTION_DISCIPLINE, HARD_PROHIBITIONS]) {
      const sp = AgentTool.buildSubagentSystemPrompt(`${carrier}\n\n${BARE_ROLE}`);
      expect(sp.includes(SUBAGENT_COMMON_FLOOR)).toBeFalsy();
      expect(sp.includes(BARE_ROLE)).toBeTruthy();
    }
  });

  test('gate off (KHY_SUBAGENT_COMMON_FLOOR=0/false/off/no) → byte-identical fallback', () => {
    const expected = `${SUBAGENT_EXECUTION_SCOPE}\n\n${BARE_ROLE}`;
    for (const off of ['0', 'false', 'off', 'no']) {
      const sp = AgentTool.buildSubagentSystemPrompt(BARE_ROLE, {
        KHY_SUBAGENT_COMMON_FLOOR: off,
      });
      expect(sp).toBe(expected);
    }
  });

  test('gate on (unset env) injects the floor on the bare path — dual of the gate-off lock', () => {
    const sp = AgentTool.buildSubagentSystemPrompt(BARE_ROLE, {});
    expect(sp.includes(SUBAGENT_COMMON_FLOOR)).toBeTruthy();
  });

  test('schema-documented roles without a built-in def (reviewer-style one-liner) get the floor', () => {
    const reviewer =
      'You are a planning agent. Analyze requirements, explore the codebase, and produce a structured execution plan. Do NOT modify files.';
    const sp = AgentTool.buildSubagentSystemPrompt(reviewer);
    expect(sp.includes(SUBAGENT_COMMON_FLOOR)).toBeTruthy();
  });
});

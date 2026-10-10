'use strict';
/**
 * AgentTool.toolSurfaceDeclaration.test.js — the withheld-tools notice inside a
 * spawned sub-agent's system prompt.
 *
 * The denylist (buildSubagentDenylist: role-derived read-only strip + the depth
 * ceiling union) is the MECHANISM; the notice is its VIEW in the prompt — the
 * model learns which tools were withheld instead of discovering it by a refused
 * call. The notice text lives in constraints.js (buildToolSurfaceNotice) next
 * to the floor it concretises; the seam appends it AFTER the composed role
 * prompt. Same gate as the floor family (KHY_SUBAGENT_COMMON_FLOOR): off → the
 * composition is byte-identical to the pre-notice behaviour.
 *
 * Who breaks it red: dropping the seam's third parameter, letting an empty
 * denylist emit a notice, un-capping a huge denylist, or gating them apart.
 */
const { AgentTool } = require('../../src/tools/AgentTool');
const {
  SUBAGENT_EXECUTION_SCOPE,
  SUBAGENT_COMMON_FLOOR,
  buildToolSurfaceNotice,
} = require('../../src/agents/constraints');

const BARE_ROLE =
  'You are a general-purpose agent. Use available tools to complete the task efficiently.';

describe('buildToolSurfaceNotice', () => {
  test('非数组/null/空数组 → 空串（不产空声明）', () => {
    expect(buildToolSurfaceNotice(null, {})).toBe('');
    expect(buildToolSurfaceNotice(undefined, {})).toBe('');
    expect(buildToolSurfaceNotice([], {})).toBe('');
    expect(buildToolSurfaceNotice('Agent', {})).toBe('');
  });

  test('产出含扣留工具名的声明行（去重、保序）', () => {
    const notice = buildToolSurfaceNotice(['Agent', 'Task', 'Agent'], {});
    expect(notice).toContain('Agent, Task');
    expect(notice).not.toContain('Agent, Task, Agent');
    // behaviour guidance rides along: a refused call means withheld, not an error to retry
    expect(notice).toMatch(/withheld|refused/i);
  });

  test('>20 项封顶折叠（另有 N 项未展开）', () => {
    const many = Array.from({ length: 25 }, (_, i) => `Tool${i + 1}`);
    const notice = buildToolSurfaceNotice(many, {});
    expect(notice).toContain('Tool20');
    expect(notice).not.toContain('Tool21,');
    expect(notice).toMatch(/另有 5 项/);
  });

  test('门控关（0/false/off/no）→ 空串（与 floor 同门）', () => {
    for (const off of ['0', 'false', 'off', 'no']) {
      expect(buildToolSurfaceNotice(['Agent'], { KHY_SUBAGENT_COMMON_FLOOR: off })).toBe('');
    }
  });
});

describe('AgentTool.buildSubagentSystemPrompt tool-surface wiring', () => {
  test('三参：deniedTools 非空 → 声明行在组合尾部（role 之后）', () => {
    const sp = AgentTool.buildSubagentSystemPrompt(BARE_ROLE, {}, ['Agent', 'Task']);
    expect(sp).toContain(SUBAGENT_EXECUTION_SCOPE);
    expect(sp).toContain(SUBAGENT_COMMON_FLOOR);
    expect(sp).toContain('Agent, Task');
    expect(sp.indexOf(BARE_ROLE)).toBeLessThan(sp.indexOf('Agent, Task'));
  });

  test('双向回归锁：deniedTools 缺省 → 与第三轮组合逐字节相等', () => {
    const twoArg = AgentTool.buildSubagentSystemPrompt(BARE_ROLE);
    const threeArgNull = AgentTool.buildSubagentSystemPrompt(BARE_ROLE, {}, null);
    expect(twoArg).toBe(threeArgNull);
    expect(twoArg).not.toContain('Tools NOT available');
  });

  test('门控关时含 deniedTools 也不注入声明（同门字节回退）', () => {
    const sp = AgentTool.buildSubagentSystemPrompt(
      BARE_ROLE,
      { KHY_SUBAGENT_COMMON_FLOOR: '0' },
      ['Agent']
    );
    expect(sp).not.toContain('Tools NOT available');
    expect(sp).toBe(`${SUBAGENT_EXECUTION_SCOPE}\n\n${BARE_ROLE}`);
  });

  test('角色提示词已含既有块时（floor 幂等跳过）声明行仍可用', () => {
    const { EXECUTION_DISCIPLINE } = require('../../src/agents/constraints');
    const sp = AgentTool.buildSubagentSystemPrompt(
      `${EXECUTION_DISCIPLINE}\n\n${BARE_ROLE}`,
      {},
      ['Agent']
    );
    expect(sp).not.toContain(SUBAGENT_COMMON_FLOOR);
    expect(sp).toContain('Agent');
    expect(sp).toContain('Tools NOT available');
  });
});

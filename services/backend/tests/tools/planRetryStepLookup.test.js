'use strict';

/**
 * PlanRetry must read the active plan through a public accessor.
 *
 * The tool used to reach into `planMode._currentPlan`, a module-private `let`,
 * which reads back `undefined` from outside the service — so every retry, in
 * every state, answered "Step N not found in current plan" and the working
 * `retryPlanStep()` was never called. Nothing in tests/ covered this because the
 * executing state is awkward to enter, hence the lock here.
 */

const path = require('path');
const fs = require('fs');

const SERVICE = path.join(__dirname, '../../src/services/planModeService');
const TOOL_SRC = path.join(__dirname, '../../src/tools/PlanRetryTool/index.js');

const planMode = require(SERVICE);
const PlanRetryTool = require(TOOL_SRC);

const ORIGINALS = {
  getState: planMode.getState,
  getCurrentPlan: planMode.getCurrentPlan,
  retryPlanStep: planMode.retryPlanStep,
};

let retryCalls;

function stubExecuting(plan) {
  planMode.getState = () => 'executing';
  planMode.getCurrentPlan = () => plan;
  planMode.retryPlanStep = (id, opts) => {
    retryCalls.push({ id, opts });
    return true;
  };
}

beforeEach(() => {
  retryCalls = [];
});

afterEach(() => {
  planMode.getState = ORIGINALS.getState;
  planMode.getCurrentPlan = ORIGINALS.getCurrentPlan;
  planMode.retryPlanStep = ORIGINALS.retryPlanStep;
});

describe('PlanRetry step lookup', () => {
  test('the tool does not reach into the service\'s private plan field', () => {
    const src = fs.readFileSync(TOOL_SRC, 'utf-8');
    const PRIVATE_READ = /planMode\._currentPlan\b/;
    // Negative control: the guard is only real if it catches the old spelling.
    expect(PRIVATE_READ.test("const s = planMode._currentPlan?.steps?.find(f);")).toBe(true);
    expect(PRIVATE_READ.test(src)).toBe(false);
    expect(src).toMatch(/planMode\.getCurrentPlan\s*\(\s*\)/);
  });

  test('the service exposes a working read-only plan accessor', () => {
    expect(typeof ORIGINALS.getCurrentPlan).toBe('function');
    // Fresh process: no generated plan yet, so the accessor must say so honestly.
    expect(ORIGINALS.getCurrentPlan()).toBeNull();
  });

  test('a failed step in the active plan gets retried through the service', async () => {
    stubExecuting({ steps: [{ id: 1, status: 'failed', retryCount: 0, lastError: 'timeout' }] });
    const tool = new PlanRetryTool();

    const out = await tool.execute({ stepId: 1 });

    expect(out).toMatchObject({ success: true, status: 'pending' });
    expect(retryCalls).toEqual([{ id: 1, opts: { force: false } }]);
  });

  test('the 2-failure root-cause gate holds and blocks the retry', async () => {
    stubExecuting({ steps: [{ id: 2, status: 'failed', retryCount: 2, lastError: 'permission denied' }] });
    const tool = new PlanRetryTool();

    const out = await tool.execute({ stepId: 2 });

    expect(out.success).toBe(false);
    expect(out.error).toMatch(/Root cause analysis required/);
    expect(out.rootCause).toMatch(/Permission issue/);
    expect(retryCalls).toEqual([]);
  });

  test('NON-VACUITY: with no reachable plan the answer is still not-found', async () => {
    // Same setup, only the plan source removed — proves the assertions above
    // depend on the accessor rather than on the stubs.
    stubExecuting(undefined);
    const tool = new PlanRetryTool();

    const out = await tool.execute({ stepId: 1 });

    expect(out.success).toBe(false);
    expect(out.error).toMatch(/not found in current plan/);
    expect(retryCalls).toEqual([]);
  });

  test('a step id that is not in the plan is not retried', async () => {
    stubExecuting({ steps: [{ id: 1, status: 'failed', retryCount: 0 }] });
    const tool = new PlanRetryTool();

    const out = await tool.execute({ stepId: 99 });

    expect(out.success).toBe(false);
    expect(out.error).toMatch(/Step 99 not found/);
    expect(retryCalls).toEqual([]);
  });
});

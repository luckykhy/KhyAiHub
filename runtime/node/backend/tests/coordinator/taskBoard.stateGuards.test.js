'use strict';

/**
 * DB-02：任务看板的状态迁移守卫。
 *
 * 修复前：requeue / deadLetterOne / complete / fail 的 UPDATE 没有状态守卫，
 * 终态可被逆转 —— done→ready（重复执行）、done→dead_letter（产出被丢弃）、
 * blocked→ready（绕过重试预算）；updateTask 是全列读-改-写，并发写会互相覆盖。
 *
 * 本用例把 dataHome 指到**文件**路径（生产里 getDataDir('taskboard.db') 会把末段
 * 建成目录，SQL 路径因此静默退到 JSON 存储 —— 见审计 DB-02 的附带发现），
 * 从而真正测到 SQL 路径的守卫。JSON 回退路径的守卫见 tasks/taskBoard.jsonFallback 用例
 * （若后续补；本文件只覆盖 SQL）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-taskboard-guards-'));
const mockDbFile = path.join(mockTmpDir, 'taskboard.db');

jest.mock('../../src/utils/dataHome', () => ({
  getDataDir: () => mockDbFile,
  getDataHome: () => mockTmpDir,
}));

const taskBoard = require('../../src/coordinator/taskBoard');

describe('DB-02 任务看板状态守卫（SQL 路径）', () => {
  beforeAll(() => {
    taskBoard.initDb();
  });

  afterAll(() => {
    try {
      taskBoard.closeDb();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(mockTmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function makeRunningTask(title) {
    const created = taskBoard.createTask({ title, description: 'demo' });
    const claimed = taskBoard.claimTask(created.id, 'worker-1');
    expect(claimed).toBeTruthy();
    const rec = taskBoard.getTask(created.id);
    expect(rec.status).toBe('running');
    return rec;
  }

  test('done 的任务不能被 requeue（终态不得逆转）', () => {
    const t = makeRunningTask('requeue-done');
    const done = taskBoard.completeTask(t.id, '完成证据');
    expect(done.status).toBe('done');

    expect(taskBoard.requeueTask(t.id, { reason: 'zombie reap' })).toBeNull();
    const after = taskBoard.getTask(t.id);
    expect(after.status).toBe('done');
    expect(after.result).toBe('完成证据');
  });

  test('done 的任务不能被改写成 dead_letter（产出不得被丢弃）', () => {
    const t = makeRunningTask('deadletter-done');
    taskBoard.completeTask(t.id, '产出');
    expect(taskBoard.deadLetterTask(t.id, 'give up')).toBeNull();
    expect(taskBoard.getTask(t.id).status).toBe('done');
  });

  test('running 的任务可以正常 requeue（既有路径不变）', () => {
    const t = makeRunningTask('requeue-running');
    const rec = taskBoard.requeueTask(t.id, { reason: 'zombie' });
    expect(rec).toBeTruthy();
    expect(rec.status).toBe('ready');
  });

  test('done 的任务不能再被 complete（重复完成被拒，结果不被覆盖）', () => {
    const t = makeRunningTask('double-complete');
    expect(taskBoard.completeTask(t.id, '第一次').status).toBe('done');
    expect(taskBoard.completeTask(t.id, '第二次')).toBeNull();
    expect(taskBoard.getTask(t.id).result).toBe('第一次');
  });

  test('done 的任务不能被 failTask 改写', () => {
    const t = makeRunningTask('fail-done');
    taskBoard.completeTask(t.id, 'ok');
    expect(taskBoard.failTask(t.id, 'boom')).toBeNull();
    expect(taskBoard.getTask(t.id).status).toBe('done');
  });

  test('连续两次 updateTask 都生效（CAS 不丢更新）', () => {
    const created = taskBoard.createTask({ title: 'cas-1', description: 'd1' });
    taskBoard.updateTask(created.id, { title: 'cas-2' });
    taskBoard.updateTask(created.id, { description: 'd2' });
    const rec = taskBoard.getTask(created.id);
    expect(rec.title).toBe('cas-2');
    expect(rec.description).toBe('d2');
  });
});

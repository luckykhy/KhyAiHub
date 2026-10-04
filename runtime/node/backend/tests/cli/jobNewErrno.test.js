'use strict';

/**
 * `/job new` — raw fs errno → actionable message (#74/#2.2 honesty family).
 *
 * store.createJob does mkdir + 3 writeFileSync. Pre-fix, a write failure let the
 * raw Node errno reach the user via handleJob's generic catch:
 *   "/job 执行出错: ENOSPC: no space left on device, mkdir 'D:\...'"
 * which has no cause/fix (violates Rule 2.2). The fix wraps createJob and maps
 * the common codes to Chinese causes + a retry/list hint, while letting already-
 * good (code-less) Error messages pass through unchanged.
 *
 * Drives the REAL handleJob('new', ...) dispatch; fakes only the three modules
 * job.js binds at require time. Runs under jest or `node --test` (shim).
 */

/* ── jest-or-node:test shim ─────────────────────────────────────────────── */
let _describe = global.describe;
let _test = global.test || global.it;
let _expect = global.expect;
if (typeof _describe !== 'function' || typeof _expect !== 'function') {
  const assert = require('assert');
  const nt = require('node:test');
  _describe = nt.describe;
  _test = nt.test;
  _expect = (actual) => ({
    toBe: (e) => assert.strictEqual(actual, e),
    toContain: (e) => assert.ok(String(actual).includes(e), `expected to contain ${e}`),
    notContain: (e) => assert.ok(!String(actual).includes(e), `expected NOT to contain ${e}`),
  });
}

const jobPath = require.resolve('../../src/cli/handlers/job');
const formattersPath = require.resolve('../../src/cli/formatters');
const storePath = require.resolve('../../src/jobs/jobStore');
const templatesPath = require.resolve('../../src/jobs/jobTemplates');

function seed(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, children: [], paths: [] };
}

function loadJob({ createJobImpl }) {
  const calls = { success: [], error: [] };
  seed(formattersPath, {
    printSuccess: (m) => calls.success.push(String(m)),
    printError: (m) => calls.error.push(String(m)),
    printInfo: () => {},
    printWarn: () => {},
  });
  seed(storePath, { createJob: createJobImpl, _jobsBase: () => '/tmp/jobs' });
  seed(templatesPath, {
    loadTemplate: () => ({ frontmatter: { title: 'T' }, content: 'body' }),
    listTemplates: () => [],
    _defaultDirs: () => [],
  });
  delete require.cache[jobPath];
  return { handleJob: require(jobPath).handleJob, calls };
}

function restore() {
  for (const p of [formattersPath, storePath, templatesPath, jobPath]) delete require.cache[p];
}

function errno(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

_describe('job new fs-errno honesty', () => {
  _test('ENOSPC maps to a Chinese cause, drops the raw errno text', async () => {
    const { handleJob, calls } = loadJob({
      createJobImpl: () => {
        throw errno('ENOSPC', "ENOSPC: no space left on device, mkdir 'D:\\x'");
      },
    });
    try {
      await handleJob('new', ['tpl', 'a', 'b']);
      _expect(calls.success.length).toBe(0);
      _expect(calls.error.length).toBe(1);
      _expect(calls.error[0]).toContain('磁盘空间不足');
      _expect(calls.error[0]).toContain('ENOSPC');
      _expect(calls.error[0]).notContain('no space left on device');
      _expect(calls.error[0]).toContain('khy job jobs');
    } finally {
      restore();
    }
  });

  _test('EACCES maps to 权限不足', async () => {
    const { handleJob, calls } = loadJob({
      createJobImpl: () => {
        throw errno('EACCES', "EACCES: permission denied, mkdir 'D:\\x'");
      },
    });
    try {
      await handleJob('new', ['tpl']);
      _expect(calls.success.length).toBe(0);
      _expect(calls.error[0]).toContain('权限不足');
    } finally {
      restore();
    }
  });

  _test('already-good code-less message passes through unchanged', async () => {
    const { handleJob, calls } = loadJob({
      createJobImpl: () => {
        throw new Error('模板内容序列化失败');
      },
    });
    try {
      await handleJob('new', ['tpl']);
      _expect(calls.error[0]).toContain('模板内容序列化失败');
    } finally {
      restore();
    }
  });

  _test('successful create still prints success, no error', async () => {
    const { handleJob, calls } = loadJob({ createJobImpl: () => '/tmp/jobs/abcd1234' });
    try {
      await handleJob('new', ['tpl']);
      _expect(calls.error.length).toBe(0);
      _expect(calls.success.length).toBe(1);
      _expect(calls.success[0]).toContain('已创建任务');
    } finally {
      restore();
    }
  });
});

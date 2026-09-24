'use strict';

// toolcheck 是诊断命令，退出码是它对 CI/脚本的唯一信号。
// 旧行为：发现契约 error 时打印 ✗ printError，却 return true → rc=0（假绿）。
// 现经 _markFailure() 落 process.exitCode=1；无 error / 仅 warning 仍 rc=0。
// 真实 CLI 已复现：`khy toolcheck` 与 `khy toolcheck --json`（当前 7 error）0→1。

process.env.NO_COLOR = '1';
process.env.FORCE_COLOR = '0';

let _describe = global.describe;
let _test = global.test || global.it;
let _expect = global.expect;
if (typeof _describe !== 'function' || typeof _expect !== 'function') {
  const assert = require('assert');
  const nt = require('node:test');
  _describe = (n, fn) => nt.describe(n, fn);
  _test = (n, fn) => nt.test(n, fn);
  _expect = (actual) => ({
    toBe: (e) => assert.strictEqual(actual, e),
    toContain: (s) => assert.ok(String(actual).includes(s), `expected to contain: ${s}`),
  });
}

const CONTRACT_PATH = require.resolve(
  '../../src/services/domain/catalog/toolCatalog/toolContract.js'
);
const realContract = require(CONTRACT_PATH);
const { handleToolCheck } = require('../../src/cli/handlers/toolcheck.js');

function _seedAudit(report) {
  require.cache[CONTRACT_PATH] = {
    id: CONTRACT_PATH,
    filename: CONTRACT_PATH,
    loaded: true,
    exports: {
      auditTools: () => report,
      toolContractEnabled: () => true,
    },
  };
}

async function runWith(args, options) {
  const prev = process.exitCode;
  process.exitCode = undefined;
  const w = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => {
    w.push(String(c));
    return true;
  };
  try {
    await handleToolCheck(undefined, args, options || {});
    return { code: process.exitCode, out: w.join('') };
  } finally {
    process.stdout.write = orig;
    process.exitCode = prev;
  }
}

_describe('toolcheck exit-code propagation', () => {
  _test('contract errors set exitCode 1 in human mode (was 0)', async () => {
    _seedAudit({
      total: 3,
      errors: 2,
      warnings: 0,
      findings: [
        { severity: 'error', rule: 'collision', tool: 'news', message: 'm1' },
        { severity: 'error', rule: 'collision', tool: 'ocr', message: 'm2' },
      ],
    });
    try {
      const { code, out } = await runWith([], {});
      _expect(out).toContain('契约 error');
      _expect(code).toBe(1);
    } finally {
      require.cache[CONTRACT_PATH] = realContract;
    }
  });

  _test('contract errors set exitCode 1 in --json mode (was 0)', async () => {
    _seedAudit({
      total: 3,
      errors: 1,
      warnings: 0,
      findings: [{ severity: 'error', rule: 'collision', tool: 'news', message: 'm1' }],
    });
    try {
      const { code } = await runWith([], { json: true });
      _expect(code).toBe(1);
    } finally {
      require.cache[CONTRACT_PATH] = realContract;
    }
  });

  _test('warnings only (no errors) stay exitCode 0', async () => {
    _seedAudit({
      total: 2,
      errors: 0,
      warnings: 1,
      findings: [{ severity: 'warning', rule: 'twin', tool: 'foo', message: 'twins' }],
    });
    try {
      const { code } = await runWith([], {});
      _expect(code || 0).toBe(0);
    } finally {
      require.cache[CONTRACT_PATH] = realContract;
    }
  });

  _test('all-clean findings stay exitCode 0', async () => {
    _seedAudit({ total: 1, errors: 0, warnings: 0, findings: [] });
    try {
      const { code } = await runWith([], {});
      _expect(code || 0).toBe(0);
    } finally {
      require.cache[CONTRACT_PATH] = realContract;
    }
  });
});

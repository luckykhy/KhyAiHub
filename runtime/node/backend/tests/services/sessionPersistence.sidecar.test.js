'use strict';

/**
 * sessionPersistence 快照收集 vs 非会话 sidecar 的契约测试。
 *
 * 存在理由（BUG：`khy trace list` TypeError）：sessions 目录里并排住着三种**不是会话**的
 * JSON —— bucket 标记 `.project.json`、resume 检查点 `*.checkpoint.json`、以及
 * DESIGN-ARCH-047 P2 起的防篡改链 `*.trace-chain.json`。链的顶层是 JSON **数组**，
 * 被当快照读就会产出一行 `sessionId: undefined` 的幽灵会话：轻则污染所有列表消费者，
 * 重则令 `handlers/trace.js` 的 `s.sessionId.slice(0, 8)` 当场抛。
 *
 * 反漂移：sidecar 的文件名一律由**单一真源**拼出（`traceChain.CHAIN_EXT`、
 * `checkpointPath` 的后缀），不自造字面量——扩展名一旦改，测试先红而不是线上崩。
 *
 * 注意：在 require 任何持久化模块**之前**钉 KHY_PROJECT_DATA_HOME 到临时目录
 * （dataHome 首次解析即缓存），且全程只写临时目录，绝不碰真实会话存储。
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = path.join(os.tmpdir(), `khy-sess-sidecar-${process.pid}`);
fs.mkdirSync(TMP_HOME, { recursive: true });
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;
process.env.KHY_DATA_HOME = TMP_HOME;

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const sessionPersistence = require('../../src/services/sessionPersistence');
const traceChain = require('../../src/services/domain/trajectory/trajectoryProvenance/traceChain');

const SESS_DIR = path.join(TMP_HOME, 'sessions');
const CHAIN_SUFFIX = traceChain.CHAIN_EXT; // 单一真源，不在测试里重复字面量

after(() => {
  try {
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function write(name, payload) {
  fs.mkdirSync(SESS_DIR, { recursive: true });
  const full = path.join(SESS_DIR, name);
  fs.writeFileSync(full, typeof payload === 'string' ? payload : JSON.stringify(payload));
  return full;
}

function snapshot(sessionId, extra = {}) {
  return {
    sessionId,
    title: `t-${sessionId}`,
    model: 'm',
    messageCount: 2,
    createdAt: 1,
    updatedAt: 2,
    messages: [{ role: 'user', content: 'hi' }],
    ...extra,
  };
}

describe('非会话 sidecar 不得成为列表行', () => {
  before(() => {
    fs.rmSync(SESS_DIR, { recursive: true, force: true });
    write('alpha.json', snapshot('alpha'));
    write(`alpha${CHAIN_SUFFIX}`, [{ version: 1, seq: 0, hash: 'x'.repeat(64) }]);
    write('beta.json', snapshot('beta'));
    write('beta.checkpoint.json', snapshot('beta-checkpoint'));
    write('.project.json', snapshot('project-marker'));
  });

  test('真源扩展名非空且以 .json 结尾（否则下面的排除用例是空转）', () => {
    assert.equal(typeof CHAIN_SUFFIX, 'string');
    assert.ok(CHAIN_SUFFIX.length > 5, `CHAIN_EXT=${CHAIN_SUFFIX}`);
    assert.ok(CHAIN_SUFFIX.endsWith('.json'));
  });

  test('链 sidecar / 检查点 / bucket 标记都被剔除，只剩两条真会话', () => {
    const ids = sessionPersistence
      .listPersistedSessions({ limit: 500 })
      .map((s) => s.sessionId)
      .sort();
    assert.deepEqual(ids, ['alpha', 'beta']);
  });

  test('列表零幽灵行：每一行都有非空 sessionId', () => {
    const rows = sessionPersistence.listPersistedSessions({ limit: 500 });
    assert.ok(rows.length > 0, '反空转：必须真读到条目');
    assert.deepEqual(rows.filter((s) => !s.sessionId), []);
  });

  test('全是 sidecar 的存储 → 空数组，不是幽灵数组', () => {
    fs.rmSync(SESS_DIR, { recursive: true, force: true });
    write(`orphan${CHAIN_SUFFIX}`, [{ version: 1, seq: 0 }]);
    write('orphan.checkpoint.json', { sessionId: 'orphan' });
    const rows = sessionPersistence.listPersistedSessions({ limit: 500 });
    assert.deepEqual(rows, []);
  });

  test('chainPathFor 派生的路径确实落在被剔除的那一类里', () => {
    fs.rmSync(SESS_DIR, { recursive: true, force: true });
    write('gamma.jsonl', '');
    const derived = path.basename(traceChain.chainPathFor(path.join(SESS_DIR, 'gamma.jsonl')));
    assert.equal(derived, `gamma${CHAIN_SUFFIX}`);
    write('gamma.json', snapshot('gamma'));
    write(derived, [{ version: 1, seq: 0 }]);
    const ids = sessionPersistence.listPersistedSessions({ limit: 500 }).map((s) => s.sessionId);
    assert.deepEqual(ids, ['gamma']);
  });
});

describe('persistSession 真实写入路径的往返', () => {
  before(() => {
    fs.rmSync(SESS_DIR, { recursive: true, force: true });
    // 会话 id 刻意 ≤8 字符：handlers/trace.js 打印的是 sessionId.slice(0, 8)，
    // 更长的 id 会在输出里被截断，断言就得反过来猜截断结果。
    sessionPersistence.persistSession('sc-live', {
      title: '一条正常会话',
      model: 'm',
      metadata: { cwd: TMP_HOME },
      messages: [{ role: 'user', content: '请删除旧表' }],
    });
    // 走真实热路径补一个链 sidecar（appendMessage → traceChain.append）。
    sessionPersistence.appendMessage('sc-live', { role: 'assistant', content: '好的' });
  });

  test('盘上确实同时存在快照与链（否则本用例集在空转）', () => {
    const names = fs.readdirSync(SESS_DIR, { recursive: true }).map(String);
    const flat = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else flat.push(e.name);
      }
    })(SESS_DIR);
    assert.ok(flat.some((n) => n.endsWith(CHAIN_SUFFIX)), `无链文件：${names.length}`);
    assert.ok(flat.includes('sc-live.json'));
  });

  test('列表里只有一个 sessionId，且没有 undefined 行', () => {
    const rows = sessionPersistence.listPersistedSessions({ limit: 500 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sessionId, 'sc-live');
  });

  test('khy trace list 在「1 条会话 + 1 条链」下不抛并列出该会话', async () => {
    const { handleTrace } = require('../../src/cli/handlers/trace');
    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    try {
      await handleTrace('list', []);
    } finally {
      console.log = orig;
    }
    assert.ok(logs.join('\n').includes('sc-live'), '输出未包含会话 id');
  });
});

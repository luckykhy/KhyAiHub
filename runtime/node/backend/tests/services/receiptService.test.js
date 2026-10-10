'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate receipt persistence into a throwaway data home before requiring the
// service (dataHome caches KHY_DATA_HOME on first use).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-receipts-'));
process.env.KHY_DATA_HOME = TMP;

const receipts = require('../../src/services/receiptService');

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('receiptService —turn aggregation', () => {
  test('aggregates a tool chain into a six-field receipt and persists it', () => {
    receipts.startReceipt({ sessionId: 'sess-A', goal: 'fix login and run tests' });
    receipts.appendToolCall({
      sessionId: 'sess-A', tool: 'read_file', params: { path: 'a.js' },
      result: { success: true }, permission: 'allow', elapsedMs: 4,
      stepType: 'hardened', risk: 'safe',
    });
    receipts.appendToolCall({
      sessionId: 'sess-A', tool: 'write', params: { file_path: 'a.js', content: 'x', token: 'secret-123' },
      result: { success: true }, permission: 'allow', elapsedMs: 10,
      stepType: 'flexible', risk: 'medium',
    });
    receipts.appendToolCall({
      sessionId: 'sess-A', tool: 'bash', params: { command: 'rm -rf build' },
      result: { success: true }, permission: 'allow-always', elapsedMs: 20,
      stepType: 'human-gate', risk: 'critical',
    });
    const fin = receipts.finalizeReceipt({ sessionId: 'sess-A', summary: 'done' });

    expect(fin).toBeTruthy();
    expect(fin.id).toMatch(/^RCPT-\d{8}-\d{6}-/);
    expect(fin.status).toBe('completed');           // no failures
    expect(fin.counts).toEqual({ tools: 3, ok: 3, failed: 0 });
    expect(fin.riskApproval.maxRisk).toBe('critical');
    expect(fin.riskApproval.humanGated).toHaveLength(1);
    expect(fin.toolChain[1].params.token).toBe('***'); // secret masked
    expect(fin.artifacts.files).toEqual([{ action: 'write', path: 'a.js', seq: 2 }]);

    // Persisted to disk and retrievable by id.
    const file = path.join(TMP, 'receipts', 'sess-A', `${fin.id}.json`);
    expect(fs.existsSync(file)).toBe(true);
    expect(receipts.getReceipt(fin.id).id).toBe(fin.id);
  });

  test('a failed tool call yields a partial receipt and records the error', () => {
    receipts.startReceipt({ sessionId: 'sess-B', goal: 'build' });
    receipts.appendToolCall({
      sessionId: 'sess-B', tool: 'bash', params: { command: 'make' },
      result: { success: false, error: 'compile error' }, permission: 'allow',
      elapsedMs: 50, stepType: 'flexible', risk: 'medium', error: 'compile error',
    });
    const fin = receipts.finalizeReceipt({ sessionId: 'sess-B' });
    expect(fin.status).toBe('partial');
    expect(fin.error).toBe('compile error');
  });

  test('startReceipt auto-finalizes a previously open receipt for the session', () => {
    receipts.startReceipt({ sessionId: 'sess-C', goal: 'first' });
    receipts.appendToolCall({ sessionId: 'sess-C', tool: 'read_file', result: { success: true } });
    // Opening a new receipt for the same session must flush the first one.
    receipts.startReceipt({ sessionId: 'sess-C', goal: 'second' });
    const open = receipts.getOpenReceipt('sess-C');
    expect(open.goal).toBe('second');
    const listed = receipts.listReceipts({ sessionId: 'sess-C' });
    expect(listed.some(r => r.goal === 'first')).toBe(true); // first was persisted
  });

  test('denied calls are tracked and never counted as failures', () => {
    receipts.startReceipt({ sessionId: 'sess-D', goal: 'delete' });
    receipts.appendToolCall({
      sessionId: 'sess-D', tool: 'bash', params: { command: 'rm important' },
      result: { success: false }, permission: 'deny', stepType: 'human-gate', risk: 'high',
    });
    const fin = receipts.finalizeReceipt({ sessionId: 'sess-D' });
    expect(fin.counts.failed).toBe(0);
    expect(fin.riskApproval.denied).toHaveLength(1);
    expect(fin.toolChain[0].status).toBe('denied');
  });

  test('search matches goal and tool names', () => {
    receipts.startReceipt({ sessionId: 'sess-E', goal: 'refactor auth middleware' });
    receipts.appendToolCall({ sessionId: 'sess-E', tool: 'grep', result: { success: true } });
    receipts.finalizeReceipt({ sessionId: 'sess-E' });
    expect(receipts.searchReceipts('auth').length).toBeGreaterThan(0);
    expect(receipts.searchReceipts('grep').length).toBeGreaterThan(0);
    expect(receipts.searchReceipts('nonexistent-xyz')).toHaveLength(0);
  });

  // 达成率对账的三条不变式：裁决优先于「有没有工具报错」；无会话归属时靠 requestId
  // 认领自己那一张；被下一轮顶掉的遗留不得伪报本回合耗时。
  test('outcome.achieved=false yields partial even with zero failed tools', () => {
    receipts.startReceipt({ sessionId: 'sess-F', requestId: 'req-F', goal: 'answer' });
    const fin = receipts.finalizeReceipt({
      sessionId: 'sess-F',
      requestId: 'req-F',
      outcome: { achieved: false, hasConclusion: false, stoppedByLimit: true },
    });
    expect(fin.status).toBe('partial');
    expect(fin.outcome.stoppedByLimit).toBe(true);
    expect(fin.finalizeReason).toBe(null);
  });

  test('finalize resolves by requestId when sessionId is absent', () => {
    receipts.startReceipt({ sessionId: null, requestId: 'req-G', goal: 'no session' });
    const fin = receipts.finalizeReceipt({
      sessionId: 'sess-WRONG',
      requestId: 'req-G',
      outcome: { achieved: true },
    });
    expect(fin).toBeTruthy();
    expect(fin.requestId).toBe('req-G');
    expect(fin.status).toBe('completed');
  });

  test('a superseded receipt does not carry the gap-to-next-turn as its duration', () => {
    receipts.startReceipt({ sessionId: 'sess-H', requestId: 'req-H1', goal: 'first' });
    receipts.startReceipt({ sessionId: 'sess-H', requestId: 'req-H2', goal: 'second' });
    const stale = receipts.getReceipt(
      receipts.listReceipts({ sessionId: 'sess-H', full: true })
        .find((r) => r.requestId === 'req-H1').id
    );
    expect(stale.finalizeReason).toBe('superseded');
    expect(stale.durationMs).toBe(null);
    expect(stale.status).toBe('partial');
  });
});


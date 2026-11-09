/**
 * The data plane must bill a request exactly once.
 *
 * Both the streaming and the JSON paths call settleOutbound() from a success
 * branch and from a catch branch, so a request that settles and then throws on
 * the way out reaches both. Without a ledger that bills the customer twice for
 * one request; this asserts the ledger at the seam that matters — the monthly
 * usage bucket the quota gate later reads.
 *
 * Isolated the same way dataPlane.userRouting.test.js is: on-disk SQLite and a
 * temp data home are both bound BEFORE any model or service is required, so
 * nothing here touches the developer's real stores.
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `khy-dataplane-settle-${process.pid}.db`);
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), `khy-settle-home-${process.pid}-`));
process.env.KHY_APP_HOME = TMP_HOME;
process.env.AI_GATEWAY_CUSTOMERS_FILE = path.join(TMP_HOME, 'ai_gateway_customers.json');
process.env.PROXY_AUTH_FILE = path.join(TMP_HOME, 'proxy_server_auth.json');
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = TMP_DB;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-settle';
process.env.NODE_ENV = 'test';
delete process.env.PROXY_AUTH_TOKEN;

const enforcer = require('../src/services/gateway/dataPlaneEnforcer');
const usage = require('../src/services/customerUsageService');

const RESULT = {
  inputTokens: 100,
  outputTokens: 50,
  model: 'gpt-4o-mini',
  provider: 'openai',
  status: 'ok',
  httpStatus: 200,
};

function ctxFor(customerId, traceId) {
  return {
    source: 'customer',
    customerId,
    customerName: 'settle-test',
    group: 'default',
    estInput: 0,
    traceId,
  };
}

describe('data plane — settle exactly once', () => {
  test('a repeated settle for the same request does not bill twice', () => {
    enforcer.__test__._resetSettleLedger();
    const cid = 'cus_settle_repeat';
    usage.addUsage(cid, { requests: 0, inputTokens: 0, outputTokens: 0, tokens: 0, costCny: 0, billedCny: 0 });

    enforcer.settleOutbound(ctxFor(cid, 'trace-repeat'), RESULT);
    const once = usage.getMonthUsage(cid);
    expect(once.requests).toBe(1);
    expect(once.totalTokens).toBe(150);

    // Same request settling again — e.g. the success branch ran, then something
    // threw and the catch branch settled too.
    enforcer.settleOutbound(ctxFor(cid, 'trace-repeat'), RESULT);
    const twice = usage.getMonthUsage(cid);
    expect(twice.requests).toBe(1);
    expect(twice.totalTokens).toBe(150);
    expect(twice.billedCny).toBe(once.billedCny);
  });

  test('a different request for the same customer is still billed', () => {
    enforcer.__test__._resetSettleLedger();
    const cid = 'cus_settle_distinct';

    enforcer.settleOutbound(ctxFor(cid, 'trace-a'), RESULT);
    enforcer.settleOutbound(ctxFor(cid, 'trace-b'), RESULT);
    const u = usage.getMonthUsage(cid);
    expect(u.requests).toBe(2);
    expect(u.totalTokens).toBe(300);
  });

  test('without a traceId the request is still billed (never dropped silently)', () => {
    enforcer.__test__._resetSettleLedger();
    const cid = 'cus_settle_notrace';
    // No traceId -> no safe dedupe key; metering must still happen.
    enforcer.settleOutbound(ctxFor(cid, ''), RESULT);
    expect(usage.getMonthUsage(cid).requests).toBe(1);
  });
});

afterAll(() => {
  try { fs.unlinkSync(TMP_DB); } catch { /* ignore */ }
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

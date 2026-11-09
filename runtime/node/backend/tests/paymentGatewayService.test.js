'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const MODULES = [
  '../src/services/gateway/paymentGatewayService',
  '../src/services/gateway/customerRegistry',
  // The enforcer captures getDataHome() at require time. Left out of this list
  // it survives resetModules() holding the PREVIOUS test's resolved home, so it
  // reads a different customers file than the one this test just wrote.
  '../src/services/gateway/customerQuotaEnforcer',
  '../src/services/gateway/proxyServer',
  '../src/utils/dataHome',
];

function resetModules() {
  for (const mod of MODULES) {
    try { delete require.cache[require.resolve(mod)]; } catch { /* ignore */ }
  }
}

function withIsolatedHome(t, env = {}) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-paygw-'));
  const saved = {
    KHY_DATA_HOME: process.env.KHY_DATA_HOME,
    AI_PAYMENT_WEBHOOK_SECRET: process.env.AI_PAYMENT_WEBHOOK_SECRET,
    KHY_PAYMENT_WEBHOOK_SECRET: process.env.KHY_PAYMENT_WEBHOOK_SECRET,
    NODE_ENV: process.env.NODE_ENV,
  };

  process.env.KHY_DATA_HOME = tmpHome;
  delete process.env.AI_PAYMENT_WEBHOOK_SECRET;
  delete process.env.KHY_PAYMENT_WEBHOOK_SECRET;
  process.env.NODE_ENV = 'test';
  Object.assign(process.env, env);
  resetModules();

  t.after(() => {
    resetModules();
    if (saved.KHY_DATA_HOME === undefined) delete process.env.KHY_DATA_HOME;
    else process.env.KHY_DATA_HOME = saved.KHY_DATA_HOME;
    if (saved.AI_PAYMENT_WEBHOOK_SECRET === undefined) delete process.env.AI_PAYMENT_WEBHOOK_SECRET;
    else process.env.AI_PAYMENT_WEBHOOK_SECRET = saved.AI_PAYMENT_WEBHOOK_SECRET;
    if (saved.KHY_PAYMENT_WEBHOOK_SECRET === undefined) delete process.env.KHY_PAYMENT_WEBHOOK_SECRET;
    else process.env.KHY_PAYMENT_WEBHOOK_SECRET = saved.KHY_PAYMENT_WEBHOOK_SECRET;
    if (saved.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.NODE_ENV;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const customerRegistry = require('../src/services/gateway/customerRegistry');
  const paymentService = require('../src/services/gateway/paymentGatewayService');
  return { tmpHome, customerRegistry, paymentService };
}

test('payment gateway end-to-end: create order -> confirm -> quota applied -> duplicate webhook idempotent', async (t) => {
  const { customerRegistry, paymentService } = withIsolatedHome(t);

  customerRegistry.createCustomer({
    id: 'cus_pay',
    name: 'Quota Customer',
    quota: {
      monthlyRequests: 10,
      monthlyTokens: 20,
      monthlyBudgetCny: 100,
    },
  });

  const created = await paymentService.createPayment({
    customerId: 'cus_pay',
    amountCny: 99.5,
    grant: {
      monthlyRequests: 30,
      monthlyBudgetCny: 200,
    },
    idempotencyKey: 'idem-001',
    subject: 'Top up Quota Customer',
  }, {
    actorUser: { id: 0, role: 'admin' },
    baseUrl: 'https://pay.example.test',
  });

  assert.equal(created.status, 'pending');
  assert.equal(created.customerId, 'cus_pay');
  assert.match(created.checkout.qrCodeDataUrl, /^data:image\/png;base64,/);
  assert.equal(created.events.length, 1);

  const confirmed = await paymentService.confirmMockPayment(created.id, {
    eventId: 'evt_confirm_1',
    amountCny: 99.5,
  }, {
    actorUser: { id: 0, role: 'admin' },
    baseUrl: 'https://pay.example.test',
  });

  assert.equal(confirmed.status, 'fulfilled');
  assert.ok(confirmed.paidAt);
  assert.ok(confirmed.fulfilledAt);
  assert.equal(confirmed.result.customerId, 'cus_pay');
  assert.equal(confirmed.result.quotaAfter.monthlyRequests, 40);
  assert.equal(confirmed.result.quotaAfter.monthlyTokens, 20);
  assert.equal(confirmed.result.quotaAfter.monthlyBudgetCny, 300);
  assert.equal(confirmed.events.length, 3);

  const customerAfter = customerRegistry.getCustomer('cus_pay');
  assert.equal(customerAfter.quota.monthlyRequests, 40);
  assert.equal(customerAfter.quota.monthlyBudgetCny, 300);

  const repeated = await paymentService.processWebhook('mock', {
    orderId: created.id,
    eventId: 'evt_confirm_1',
    status: 'paid',
    amountCny: 99.5,
  }, {
    skipSignatureVerification: true,
    baseUrl: 'https://pay.example.test',
  });

  assert.equal(repeated.status, 'fulfilled');
  assert.equal(repeated.result.quotaAfter.monthlyBudgetCny, 300);
  assert.equal(repeated.events.length, 3);

  const listing = await paymentService.listPayments({}, {
    actorUser: { id: 0, role: 'admin' },
  });
  assert.equal(listing.total, 1);
  assert.equal(listing.list[0].id, created.id);
});

test('mock webhook verifies HMAC signature when secret is configured', async (t) => {
  const { customerRegistry, paymentService } = withIsolatedHome(t, {
    AI_PAYMENT_WEBHOOK_SECRET: 'sig-secret-001',
  });

  customerRegistry.createCustomer({
    id: 'cus_sig',
    name: 'Signed Customer',
    quota: { monthlyBudgetCny: 50 },
  });

  const created = await paymentService.createPayment({
    customerId: 'cus_sig',
    amountCny: 10,
  }, {
    actorUser: { id: 0, role: 'admin' },
    baseUrl: 'https://pay.example.test',
  });

  const payload = {
    orderId: created.id,
    eventId: 'evt_sig_ok',
    status: 'paid',
    amountCny: 10,
  };
  const signature = paymentService.signMockWebhookPayload(payload, 'sig-secret-001');

  const paid = await paymentService.processWebhook('mock', payload, {
    signature: `sha256=${signature}`,
    baseUrl: 'https://pay.example.test',
  });

  assert.equal(paid.status, 'fulfilled');
  assert.equal(paid.result.quotaAfter.monthlyBudgetCny, 60);

  await assert.rejects(async () => {
    await paymentService.processWebhook('mock', {
      orderId: created.id,
      eventId: 'evt_sig_bad',
      status: 'paid',
      amountCny: 10,
    }, {
      signature: 'sha256=bad-signature',
      baseUrl: 'https://pay.example.test',
    });
  }, /invalid webhook signature/);
});

// ── P2 账本缺陷回归（DESIGN-ARCH-190 §五 P2，存证 190-saas-p2-ledger）────────

test('refund: a negative grant is preserved instead of clamped to 0', async (t) => {
  const { customerRegistry, paymentService } = withIsolatedHome(t);

  assert.equal(paymentService.__test__.normalizeGrant({ monthlyBudgetCny: -100 }, 0).monthlyBudgetCny, -100);
  // An explicit all-zero grant means "credit nothing" and must not fall back to
  // the order amount the way an omitted grant does.
  assert.equal(paymentService.__test__.normalizeGrant({ monthlyBudgetCny: 0 }, 500).monthlyBudgetCny, 0);
  assert.equal(paymentService.__test__.normalizeGrant({}, 500).monthlyBudgetCny, 500);

  const cust = customerRegistry.createCustomer({
    name: 'refund-customer',
    quota: { monthlyRequests: 0, monthlyTokens: 0, monthlyBudgetCny: 0 },
  });
  customerRegistry.adjustCustomerQuota(cust.id, { monthlyBudgetCny: 100 });
  customerRegistry.adjustCustomerQuota(cust.id, { monthlyBudgetCny: -30 });
  assert.equal(
    customerRegistry.getCustomer(cust.id, { includeSecrets: false }).quota.monthlyBudgetCny,
    70
  );
});

test('refund: a balance landing exactly on 0 is refused, not silently unlimited', async (t) => {
  const { customerRegistry } = withIsolatedHome(t);
  const cust = customerRegistry.createCustomer({
    name: 'zero-balance',
    quota: { monthlyRequests: 0, monthlyTokens: 0, monthlyBudgetCny: 100 },
  });

  assert.throws(
    () => customerRegistry.adjustCustomerQuota(cust.id, { monthlyBudgetCny: -100 }),
    /zero balance/
  );
  // Untouched by the refused reversal.
  assert.equal(
    customerRegistry.getCustomer(cust.id, { includeSecrets: false }).quota.monthlyBudgetCny,
    100
  );
});

test('refund beyond the balance creates arrears, and the gateway blocks it', async (t) => {
  const { tmpHome, customerRegistry, paymentService } = withIsolatedHome(t);
  const enforcer = require('../src/services/gateway/customerQuotaEnforcer');

  const cust = customerRegistry.createCustomer({
    name: 'arrears',
    quota: { monthlyRequests: 0, monthlyTokens: 0, monthlyBudgetCny: 100 },
  });
  customerRegistry.adjustCustomerQuota(cust.id, { monthlyBudgetCny: -150 });

  const view = customerRegistry.getCustomer(cust.id, { includeSecrets: false });
  assert.equal(view.quota.monthlyBudgetCny, -50);

  const verdict = enforcer.checkQuota(view, new Date());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.scope, 'arrears');

  const issued = customerRegistry.issueToken(cust.id, { label: 'arrears' });
  const rejection = enforcer.enforce(issued.token);
  assert.equal(rejection.allowed, false);
  assert.equal(rejection.code, 'ARREARS');
  assert.match(rejection.message, /充值/);
});

test('idempotencyKey is scoped to the customer that owns the order', async (t) => {
  const { customerRegistry, paymentService } = withIsolatedHome(t);

  const a = customerRegistry.createCustomer({ name: 'idem-a', quota: { monthlyBudgetCny: 0 } });
  const b = customerRegistry.createCustomer({ name: 'idem-b', quota: { monthlyBudgetCny: 0 } });

  const store = paymentService.__test__.loadStore();
  store.payments.push({
    id: 'pay_a_1',
    customerId: a.id,
    customerName: a.name,
    amountCny: 100,
    status: 'pending',
    grant: { monthlyRequests: 0, monthlyTokens: 0, monthlyBudgetCny: 100 },
    idempotencyKey: 'shared-key',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  paymentService.__test__.saveStore(store);

  // Same customer, same key -> replay returns the original order.
  const replay = await paymentService.createPayment(
    { customerId: a.id, amountCny: 100, idempotencyKey: 'shared-key' },
    { actorUser: { id: 0, role: 'admin' } }
  );
  assert.equal(replay.id, 'pay_a_1');

  // Different customer, same key -> their own order, not A's.
  const bOrder = await paymentService.createPayment(
    { customerId: b.id, amountCny: 250, idempotencyKey: 'shared-key' },
    { actorUser: { id: 0, role: 'admin' } }
  );
  assert.notEqual(bOrder.id, 'pay_a_1');
  assert.equal(bOrder.customerId, b.id);
  assert.equal(bOrder.amountCny, 250);
});

test('concurrent quota grants do not lose updates', async (t) => {
  // Real concurrency, not a simulated one: the read-modify-write races with the
  // other process only if they overlap, and a same-process loop would pass even
  // against the unfixed code. Six child processes each credit the same customer.
  const { customerRegistry } = withIsolatedHome(t);
  const registryPath = require.resolve('../src/services/gateway/customerRegistry');

  const cust = customerRegistry.createCustomer({
    name: 'cas-race',
    quota: { monthlyRequests: 0, monthlyTokens: 0, monthlyBudgetCny: 0 },
  });

  const N = 6;
  const EACH = 25;
  const childCode =
    'const r = require(process.argv[1]);' +
    'r.adjustCustomerQuota(process.argv[2], { monthlyBudgetCny: Number(process.argv[3]) });';

  const results = await Promise.all(
    Array.from({ length: N }, () =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ['-e', childCode, registryPath, cust.id, String(EACH)], {
          env: { ...process.env, NODE_PATH: path.join(__dirname, '../../../../node_modules') },
        });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', (code) => resolve({ code, stderr }));
      })
    )
  );

  // Before the store lock, concurrent renames onto the same destination failed
  // with EPERM on Windows and silently lost updates elsewhere. Neither is
  // acceptable for a payment callback, so assert both are gone.
  const crashed = results.filter((r) => r.code !== 0);
  assert.deepEqual(
    crashed.map((r) => r.stderr.split('\n').find((l) => /EPERM|ENOENT/.test(l)) || 'unknown'),
    [],
    'concurrent quota writers must not die on rename'
  );

  const finalBalance = customerRegistry.getCustomer(cust.id, { includeSecrets: false }).quota
    .monthlyBudgetCny;
  assert.equal(finalBalance, N * EACH, `${N} concurrent grants of ${EACH} must all land`);
});

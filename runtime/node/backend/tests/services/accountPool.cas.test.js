'use strict';

/**
 * DB-01：账号池的置约必须是 CAS。
 *
 * 修复前：先裸 SELECT 挑一个 available 账号，再 `UPDATE ... WHERE id=:id`
 * （WHERE 只有主键、不查 status、也不看受影响行数）—— 并发 acquire 会选中同一
 * 个账号并双双置为 leased，同一上游账号被双租约，leased_by 互相覆盖。
 *
 * 隔离：临时 SQLite 文件在 shared models 绑定之前指定（与 accountPoolSwitch
 * 同一手法），绝不触碰真实 khy-quant.db。
 *
 * 注意 formatLease 的返回是 camelCase（requestId / leaseUntil），不是数据库列名。
 */

const os = require('node:os');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const _dbFile = path.join(os.tmpdir(), `khy-acctpool-cas-${process.pid}.sqlite`);
try {
  fs.unlinkSync(_dbFile);
} catch {
  /* fresh */
}
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = _dbFile;
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const { sequelize } = require('@khy/shared/models');
const pool = require('../../src/services/accountPool');

async function insertAvailableRow(email) {
  await sequelize.query(
    `INSERT INTO account_pool (pool_type, email, refresh_token, label, enabled, status)
     VALUES ('trae', :email, 'refresh-token-abcdef0123456789', :email, 1, 'available')`,
    { replacements: { email } }
  );
  const [rows] = await sequelize.query(
    'SELECT id FROM account_pool WHERE email = :email ORDER BY id DESC LIMIT 1',
    { replacements: { email } }
  );
  return Number(rows[0].id);
}

async function activeLeaseCount(accountId) {
  const [rows] = await sequelize.query(
    "SELECT COUNT(*) AS n FROM account_leases WHERE account_id = :id AND status = 'active'",
    { replacements: { id: accountId } }
  );
  return Number(rows[0].n || rows[0].N || 0);
}

describe('DB-01 账号池置约 CAS', () => {
  beforeAll(async () => {
    await sequelize.sync();
    await pool.init(sequelize);
  });

  afterAll(async () => {
    try {
      pool.stopGC();
    } catch {
      /* ignore */
    }
    try {
      await sequelize.close();
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(_dbFile);
    } catch {
      /* ignore */
    }
  });

  test('池内仅 1 个可用账号时，10 个并发 acquire 只产生 1 条租约', async () => {
    const accountId = await insertAvailableRow(`cas-${Date.now()}@company.io`);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => pool.acquire('trae', `user-${i}`))
    );
    const ok = results.filter((r) => r.status === 'fulfilled');

    // 关键不变量：**同一个账号不得有多条 active 租约**（修复前是 10 条互不相同的 requestId）
    assert.strictEqual(
      await activeLeaseCount(accountId),
      1,
      `同一账号的 active 租约必须恰好 1 条，实际 ${await activeLeaseCount(accountId)}`
    );
    // 成功者要么拿到唯一租约，要么走 sticky 复用同一个 requestId —— 都只对应 1 个 requestId
    const distinct = new Set(ok.map((r) => r.value && r.value.requestId));
    assert.strictEqual(distinct.size, 1);

    const [rows] = await sequelize.query(
      'SELECT status, leased_by FROM account_pool WHERE id = :id',
      { replacements: { id: accountId } }
    );
    assert.strictEqual(rows[0].status, 'leased');
    assert.ok(rows[0].leased_by, 'leased_by 必须有值');
  });

  test('两个可用账号、8 个并发 acquire：每个账号至多 1 条租约', async () => {
    const id1 = await insertAvailableRow(`cas-a-${Date.now()}@company.io`);
    const id2 = await insertAvailableRow(`cas-b-${Date.now()}@company.io`);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => pool.acquire('trae', `multi-${i}`))
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    assert.ok(ok.length >= 1);

    assert.ok((await activeLeaseCount(id1)) <= 1, 'account#1 不得双租约');
    assert.ok((await activeLeaseCount(id2)) <= 1, 'account#2 不得双租约');
  });

  test('释放后账号回到 available，可被下一个请求租走', async () => {
    const accountId = await insertAvailableRow(`cas-release-${Date.now()}@company.io`);
    const lease = await pool.acquire('trae', 'user-solo');
    assert.ok(lease && lease.requestId, 'acquire 必须返回带 requestId 的租约');

    await pool.release(lease.requestId);
    const [after] = await sequelize.query(
      'SELECT status FROM account_pool WHERE id = :id',
      { replacements: { id: accountId } }
    );
    assert.strictEqual(after[0].status, 'available');
  });
});

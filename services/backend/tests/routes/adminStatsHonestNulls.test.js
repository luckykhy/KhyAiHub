'use strict';

/**
 * Round-35 contract: GET /api/admin/stats honest-nulls (routes/admin.js)
 * plus the external khyquant admin Dashboard wiring.
 *
 * Repro (.khy/feedback/hci-r35-admin-stats-zero/): Strategy/Announcement
 * count failures were swallowed into `0` and `onlineUsers` was a hardcoded
 * `0` while notificationService.getStats().totalConnections (a real sync
 * source) existed — the admin dashboard showed a fully "healthy all-zero"
 * system for a broken one.
 *
 * Pins:
 *  T1 failed counts → JSON null (never 0), success envelope preserved;
 *  T2 healthy counts → plain numbers;
 *  T3 onlineUsers sourced from notificationService; service throwing → null;
 *  T4 external Dashboard.vue renders via statText and initializes to null
 *     (skips cleanly when the quant-app frontend is absent);
 *  T5 non-vacuity — the /stats handler really ran.
 *
 * node --test only (require.cache seeding).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const Module = require('module');

const BACKEND = path.resolve(__dirname, '..', '..');
const SRC = path.join(BACKEND, 'src');
const qa = require(path.join(SRC, 'services', 'extensions', 'quantApp.js'));
const APP = qa.resolveDir();
const DASH = APP ? path.join(APP, 'frontend', 'src', 'views', 'admin', 'Dashboard.vue') : null;

function seedModule(absPath, exportsObj) {
  const m = new Module(absPath, null);
  m.filename = absPath;
  m.loaded = true;
  m.exports = exportsObj;
  require.cache[absPath] = m;
}

function statsHandler() {
  const admin = require(path.join(SRC, 'routes', 'admin.js'));
  const route = admin.stack.find((l) => l.route && l.route.path === '/stats').route;
  return route.stack[route.stack.length - 1].handle;
}

async function callStats({ models, notif }) {
  const rels = {
    models: path.join(SRC, 'models'),
    auth: path.join(SRC, 'middleware', 'auth.js'),
    logs: path.join(SRC, 'services', 'userLogService.js'),
    whitelist: path.join(SRC, 'config', 'settingsWhitelist.js'),
    logger: path.join(SRC, 'utils', 'logger.js'),
    notif: path.join(SRC, 'services', 'notificationService.js'),
    admin: path.join(SRC, 'routes', 'admin.js'),
  };
  const keys = Object.values(rels).map((p) => require.resolve(p));
  const prev = keys.map((p) => require.cache[p]);
  try {
    seedModule(require.resolve(rels.models), models);
    seedModule(require.resolve(rels.auth), { authenticateToken: (q, s, n) => n(), requireAdmin: (q, s, n) => n() });
    seedModule(require.resolve(rels.logs), {});
    seedModule(require.resolve(rels.whitelist), { isAllowedSettingKey: () => false });
    seedModule(require.resolve(rels.logger), { info: () => {}, error: () => {}, warn: () => {}, log: () => {} });
    seedModule(require.resolve(rels.notif), notif);
    delete require.cache[require.resolve(rels.admin)];
    const handler = statsHandler();
    const res = {
      _body: null,
      status() { return this; },
      json(b) { this._body = b; return this; },
      send(b) { this._body = b; return this; },
    };
    await handler({ user: { id: 1 }, headers: {} }, res, () => {});
    return res._body;
  } finally {
    keys.forEach((p, i) => {
      if (prev[i]) require.cache[p] = prev[i];
      else delete require.cache[p];
    });
    delete require.cache[require.resolve(rels.admin)];
  }
}

const boom = (n) => async () => { throw new Error(`no such table: ${n}`); };
const ok = (v) => async () => v;
const HEALTHY_NOTIF = { getStats: () => ({ totalConnections: 5 }) };

test('T1 failed counts → null in JSON, never a fake 0', async () => {
  const body = await callStats({
    models: { sequelize: {}, User: { count: ok(12) }, Strategy: { count: boom('Strategy') }, Announcement: { count: boom('Announcement') }, Feedback: {}, Trade: {} },
    notif: HEALTHY_NOTIF,
  });
  assert.equal(body.success, true, 'partial truth must keep the success envelope');
  assert.equal(body.data.totalStrategies, null, 'failed query must serialize as null, got ' + body.data.totalStrategies);
  assert.equal(body.data.totalAnnouncements, null);
  assert.equal(body.data.totalUsers, 12, 'healthy sibling keeps its real number');
});

test('T2 healthy counts → plain numbers', async () => {
  const body = await callStats({
    models: { sequelize: {}, User: { count: ok(12) }, Strategy: { count: ok(3) }, Announcement: { count: ok(0) }, Feedback: {}, Trade: {} },
    notif: HEALTHY_NOTIF,
  });
  assert.deepEqual(
    [body.data.totalUsers, body.data.totalStrategies, body.data.totalAnnouncements],
    [12, 3, 0],
    'a genuine zero table must still render 0'
  );
});

test('T3 onlineUsers comes from notificationService; broken service → null', async () => {
  const models = { sequelize: {}, User: { count: ok(1) }, Strategy: { count: ok(1) }, Announcement: { count: ok(1) }, Feedback: {}, Trade: {} };
  const good = await callStats({ models, notif: HEALTHY_NOTIF });
  assert.equal(good.data.onlineUsers, 5, 'hardcoded 0 placeholder must be replaced by the real count');
  let called = false;
  const broken = await callStats({
    models,
    notif: { getStats: () => { called = true; throw new Error('service not ready'); } },
  });
  assert.ok(called, 'non-vacuity: getStats was reached');
  assert.equal(broken.data.onlineUsers, null, 'unavailable service must read as unknown, not 0');
});

test('T4 external admin Dashboard renders nulls as 「—」 and never seeds fake 0s', async (t) => {
  if (!DASH || !fs.existsSync(DASH)) return t.skip('no quant-app frontend on this machine');
  const src = fs.readFileSync(DASH, 'utf8');
  assert.match(src, /totalUsers:\s*null/, 'reactive init must not fake 0');
  assert.match(src, /statText\(stats\.totalStrategies\)/, 'failed/unknown stats render through statText');
  assert.match(src, /statText\(stats\.onlineUsers\)/);
  assert.doesNotMatch(src, /keep zeros/, 'the loadStats catch must stop manufacturing zeros');
});

test('T5 non-vacuity: the /stats route exists and produced a data envelope', async () => {
  const body = await callStats({
    models: { sequelize: {}, User: { count: ok(1) }, Strategy: { count: ok(1) }, Announcement: { count: ok(1) }, Feedback: {}, Trade: {} },
    notif: HEALTHY_NOTIF,
  });
  assert.ok(body && body.data && 'totalUsers' in body.data, 'handler ran and returned stats data');
});

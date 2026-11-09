'use strict';

/**
 * wireless.test.js — shared discovery file: freshness gate, and the two
 * handwritten copies of its path staying reconciled.
 *
 * The bridge reads `<home>/.khyquant/phone/discovery.json`, written by the
 * other bridge (khy phone, PC→手机 8896). runtime/ 不能反向依赖 delivery/，so the
 * path convention is handwritten twice — wireless.js:101 here and
 * phoneBridgeConfig.js:340 over there — with
 * docs/10_规范/registry/DATA-LOCATIONS.json knownGaps[phone-discovery-user-home]
 * as the shared truth. The reconciliation test is the first line of defense
 * against drift; check-data-layout L-3 `allowed` is the second.
 *
 * Behaviour cases drive the real resolveSerial() path with an in-process fake
 * transport: with an empty device table and no configured serial, a shared
 * entry is adopted by dialing it (source 'shared-discovery'). No real device,
 * no adb server, no network; KHY_PHONE_DISCOVERY_FILE always points at a temp
 * file, so the real home directory is never read.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWireless, DISCOVERY_TTL_MS } = require('../lib/wireless');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const REGISTRY_REL = path.join('docs', '10_规范', 'registry', 'DATA-LOCATIONS.json');
const WIRELESS_REL = 'delivery/extension/bridges/khy-amoon-bridge/lib/wireless.js';
const GAP_ID = 'phone-discovery-user-home';

// ─── Path reconciliation ─────────────────────────────────────────────────────

function loadKnownGap() {
  const registry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, REGISTRY_REL), 'utf8'));
  const gaps = Array.isArray(registry.knownGaps) ? registry.knownGaps : [];
  const gap = gaps.find((entry) => entry && entry.id === GAP_ID);
  assert.ok(
    gap,
    `DATA-LOCATIONS.json knownGaps[] has no ${GAP_ID} entry — the shared discovery path lost its registered truth`
  );
  return gap;
}

/** The bridge-side default literal, evaluated against the real homedir. */
function bridgeDefaultPath() {
  const source = fs.readFileSync(path.join(REPO_ROOT, WIRELESS_REL), 'utf8');
  const joins = [
    ...source.matchAll(/path\.join\(\s*os\.homedir\(\)\s*,\s*((?:'[^']*'\s*,\s*)*'[^']*')\s*\)/g),
  ];
  assert.equal(
    joins.length,
    1,
    `wireless.js must keep exactly one path.join(os.homedir(), …) default literal for the discovery file; found ${joins.length}`
  );
  const segments = joins[0][1].split(',').map((part) => part.trim().replace(/^'|'$/g, ''));
  return path.join(os.homedir(), ...segments);
}

test('discovery default literal is reconciled with DATA-LOCATIONS.json', () => {
  const gap = loadKnownGap();
  const registered = String(gap.path).replace('<user-home>', os.homedir()).replace(/\\/g, '/');
  const actual = bridgeDefaultPath().replace(/\\/g, '/');
  assert.equal(
    actual,
    registered,
    `discovery path drifted: wireless.js default is "${actual}", ${GAP_ID}.path registers "${registered}" — the two handwritten copies must change together, never one alone`
  );
  const sites = Array.isArray(gap.literalSites) ? gap.literalSites : [];
  assert.ok(
    sites.some((site) => String(site).includes(WIRELESS_REL)),
    `knownGaps[${GAP_ID}].literalSites no longer covers ${WIRELESS_REL}; this reconciliation lost its subject`
  );
});

// ─── Fake transport (in-process; wireless.js needs host() plus setters) ──────

function reply(stdout) {
  return { stdout, stderr: '', exit: 0, timedOut: false };
}

function fakeAdb(options = {}) {
  const devicesText = options.devicesText || 'List of devices attached\n';
  const mdnsText = options.mdnsText || 'List of discovered mdns services\n';
  const connectText = options.connectText || 'connected to\n';
  const stateText = options.stateText || 'device\n';
  const props = Object.assign(
    {
      'ro.serialno': 'ZYPZTEST0001',
      'ro.product.model': 'PZ261A',
      'ro.build.version.sdk': '36',
    },
    options.props
  );
  const adb = {
    calls: [],
    serial: null,
    host(argv) {
      adb.calls.push(argv.join(' '));
      const command = argv[0];
      if (command === 'devices') return reply(devicesText);
      if (command === 'mdns') return reply(mdnsText);
      if (command === 'connect') return reply(connectText);
      if (command === 'get-state') return reply(stateText);
      if (command === 'shell') {
        const match = /getprop\s+'?([^']+)'?/.exec(argv[1] || '');
        const value = match && Object.prototype.hasOwnProperty.call(props, match[1]) ? props[match[1]] : '';
        return reply(`${value}\n`);
      }
      return reply('');
    },
    setSerial(serial) {
      adb.serial = serial;
    },
    getSerial() {
      return adb.serial;
    },
    setDeviceInfo() {},
    setReverse() {},
    snapshot() {
      return { serial: adb.serial };
    },
  };
  return adb;
}

/** Write a discovery payload to a temp file and point the env override at it. */
function sandboxDiscovery(t, payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amoon-discovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'discovery.json');
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const previous = process.env.KHY_PHONE_DISCOVERY_FILE;
  process.env.KHY_PHONE_DISCOVERY_FILE = file;
  t.after(() => {
    if (previous === undefined) delete process.env.KHY_PHONE_DISCOVERY_FILE;
    else process.env.KHY_PHONE_DISCOVERY_FILE = previous;
  });
  return file;
}

function discoveryPayload(patch) {
  return Object.assign(
    {
      schema: 'khy-phone-discovery/1',
      serial: '192.168.2.46:33743',
      source: 'auto',
      by: 'khy-phone',
      detectedAt: new Date().toISOString(),
    },
    patch
  );
}

function wirelessWith(transport) {
  return createWireless({
    config: { enabled: true, serial: null },
    transport,
    logger: silentLogger,
  });
}

function dialed(transport) {
  return transport.calls.some((call) => call.startsWith('connect'));
}

// ─── Behaviour: freshness gate on the shared-discovery adoption branch ───────

test('resolveSerial adopts a fresh shared-discovery entry', async (t) => {
  sandboxDiscovery(t, discoveryPayload({ detectedAt: new Date(Date.now() - 30 * 1000).toISOString() }));
  const transport = fakeAdb();

  const resolved = await wirelessWith(transport).resolveSerial();

  assert.equal(resolved.source, 'shared-discovery');
  assert.equal(resolved.serial, '192.168.2.46:33743');
  assert.equal(resolved.deviceSerial, 'ZYPZTEST0001');
  assert.ok(dialed(transport), 'a fresh entry must be dialed');
});

test('resolveSerial ignores a stale shared-discovery entry and never dials it', async (t) => {
  const staleAt = new Date(Date.now() - DISCOVERY_TTL_MS - 60 * 1000).toISOString();
  sandboxDiscovery(t, discoveryPayload({ detectedAt: staleAt }));
  const transport = fakeAdb();

  await assert.rejects(wirelessWith(transport).resolveSerial(), (err) => err.code === 'adb_unavailable');

  assert.ok(!dialed(transport), 'a stale entry must never reach adb connect');
});

test('resolveSerial ignores an entry with no parseable detectedAt', async (t) => {
  sandboxDiscovery(t, discoveryPayload({ detectedAt: undefined }));
  const transport = fakeAdb();

  await assert.rejects(wirelessWith(transport).resolveSerial(), (err) => err.code === 'adb_unavailable');

  assert.ok(!dialed(transport), 'a timestamp-less entry fails closed');
});

test('SERIAL_RE still rejects a fresh entry whose serial is illegal', async (t) => {
  sandboxDiscovery(
    t,
    discoveryPayload({ serial: 'BAD SERIAL', detectedAt: new Date(Date.now() - 30 * 1000).toISOString() })
  );
  const transport = fakeAdb();

  await assert.rejects(wirelessWith(transport).resolveSerial(), (err) => err.code === 'adb_unavailable');

  assert.ok(!dialed(transport), 'the serial gate is untouched by the freshness check');
});

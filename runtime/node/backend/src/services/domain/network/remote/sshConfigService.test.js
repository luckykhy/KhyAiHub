'use strict';

// Co-located unit test for sshConfigService.js (thin IO: reads one file whose
// path comes from KHY_REMOTE_SSH_CONFIG_PATH, pinned inside the sandbox below,
// so the real ~/.ssh/config is never opened).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function pinSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-remote-'));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.KHY_DATA_HOME = path.join(root, 'data');
  process.env.KHY_PROJECT_DATA_HOME = path.join(root, 'project-data');
  process.env.XDG_CONFIG_HOME = path.join(root, 'config');
  process.env.KHY_REMOTE_SSH_ENABLE_EXEC = 'false';
  process.env.KHY_REMOTE_SSH_CONFIG_PATH = path.join(root, 'ssh', 'config');
  return root;
}

const SANDBOX = pinSandbox();

const svc = require('./sshConfigService');

test('export surface', () => {
  assert.deepStrictEqual(Object.keys(svc), ['getConfigPath', 'parseSshConfig', 'readConfigFile', 'listHosts']);
});

test('getConfigPath prefers the env override and resolves it', () => {
  process.env.KHY_REMOTE_SSH_CONFIG_PATH = path.join(SANDBOX, 'ssh', 'config');
  assert.strictEqual(svc.getConfigPath(), path.resolve(process.env.KHY_REMOTE_SSH_CONFIG_PATH));
  process.env.KHY_REMOTE_SSH_CONFIG_PATH = `  ${path.join(SANDBOX, 'other')}  `;
  assert.strictEqual(svc.getConfigPath(), path.resolve(path.join(SANDBOX, 'other')));
  process.env.KHY_REMOTE_SSH_CONFIG_PATH = path.join(SANDBOX, 'ssh', 'config');
});

test('a missing config file yields an empty host list, not a throw', () => {
  const res = svc.listHosts();
  assert.strictEqual(typeof res.configPath, 'string');
  assert.deepStrictEqual(res.hosts, []);
  assert.strictEqual(svc.readConfigFile().content, '');
});

test('parseSshConfig is tolerant of non-string input', () => {
  assert.deepStrictEqual(svc.parseSshConfig(undefined), []);
  assert.deepStrictEqual(svc.parseSshConfig(null), []);
  assert.deepStrictEqual(svc.parseSshConfig(42), []);
  assert.deepStrictEqual(svc.parseSshConfig(''), []);
});

test('parseSshConfig reads alias, hostname, user, port and key', () => {
  const hosts = svc.parseSshConfig([
    'Host prod',
    '  HostName prod.example.invalid',
    '  User deploy',
    '  Port 2222',
    '  IdentityFile ~/.ssh/id_deploy',
    '  ProxyJump bastion.example.invalid',
    '  RemoteWorkspace /srv/app',
    '',
    'Host unrelated',
    '  HostName other.example.invalid',
  ].join('\n'));
  assert.strictEqual(hosts.length, 2);
  const prod = hosts.find((h) => h.alias === 'prod');
  assert.strictEqual(prod.host, 'prod.example.invalid');
  assert.strictEqual(prod.user, 'deploy');
  assert.strictEqual(prod.port, 2222);
  assert.strictEqual(prod.proxyJump, 'bastion.example.invalid');
  assert.strictEqual(prod.remoteWorkspace, '/srv/app');
  // Expansion goes through os.homedir() (sshConfigService.js:50-55), which on this
  // machine resolves from the environment at CALL time: libuv prefers HOME, then
  // USERPROFILE — both pinned by pinSandbox() above. Verified by direct probe:
  // with HOME/USERPROFILE pinned to a temp root, '~/.ssh/id_deploy' expands under
  // that root, never the real account. The previous assertion failed only because
  // it expected the prefix '<root>\ssh' while the config value is '~/.ssh/...'
  // (missing dot) — a test-side typo, not a sandbox break. If a future runner
  // unpins HOME *and* USERPROFILE, os.homedir() falls back to the OS account and
  // this promise dies; keep both pinned.
  assert.strictEqual(
    prod.identityFile,
    path.join(SANDBOX, '.ssh', 'id_deploy'),
    '~ must expand into the pinned HOME, never the real account'
  );
});

test('aliases come back sorted and hostname defaults to the alias', () => {
  const hosts = svc.parseSshConfig('Host zulu\nHost alpha\n  HostName a.example.invalid\n');
  assert.deepStrictEqual(hosts.map((h) => h.alias), ['alpha', 'zulu']);
  const zulu = hosts.find((h) => h.alias === 'zulu');
  assert.strictEqual(zulu.host, 'zulu');
  assert.strictEqual(zulu.user, null);
  assert.strictEqual(zulu.identityFile, null);
});

test('a Host line may list several aliases and CRLF input parses', () => {
  const hosts = svc.parseSshConfig('Host a b c\r\n  HostName shared.example.invalid\r\n');
  assert.deepStrictEqual(hosts.map((h) => h.alias), ['a', 'b', 'c']);
  assert.strictEqual(hosts[0].host, 'shared.example.invalid');
});

test('Host * defaults merge under the specific block', () => {
  const hosts = svc.parseSshConfig([
    'Host *',
    '  User common',
    '  ServerAliveInterval 30',
    'Host web',
    '  HostName web.example.invalid',
    'Host api',
    '  User apiuser',
  ].join('\n'));
  assert.deepStrictEqual(hosts.map((h) => h.alias), ['api', 'web']);
  assert.strictEqual(hosts.find((h) => h.alias === 'web').user, 'common');
  assert.strictEqual(hosts.find((h) => h.alias === 'api').user, 'apiuser');
});

test('first value wins inside one block (OpenSSH "already set" semantics)', () => {
  const hosts = svc.parseSshConfig('Host dup\n  User first\n  User second\n');
  assert.strictEqual(hosts[0].user, 'first');
});

test('garbage and out-of-block directives are dropped, bad ports fall back', () => {
  const hosts = svc.parseSshConfig([
    'User orphan-before-any-host',
    'a single token with no value',
    'Host bad',
    '  Port not-a-number',
    'Host zero',
    '  Port 0',
  ].join('\n'));
  assert.deepStrictEqual(hosts.map((h) => h.alias), ['bad', 'zero']);
  // Port fallback is the literal 22 in sshConfigService.js:61 — pinned so a
  // future "configurable default" change has to touch this line on purpose.
  assert.strictEqual(hosts.find((h) => h.alias === 'bad').port, 22);
  assert.strictEqual(hosts.find((h) => h.alias === 'zero').port, 22);
});

// B31-R4 (registered, NOT fixed): the parser implements a subset of the ssh_config
// grammar silently. Three measured divergences from what `ssh` itself does:
// (a) `Include` is not a directive it knows, so hosts defined in included files
//     are invisible -> deployOrchestrator.js:112 reports host_not_found for a host
//     `ssh` resolves fine;
// (b) `Match` is not a block terminator, so its directives are attributed to the
//     previous Host entry -> a key that only applies conditionally for ssh is
//     reported (and later validated by sshCredentialGuard) as this host's key;
// (c) '#' cuts the value even inside it, while OpenSSH only starts a comment at
//     the beginning of a line or after whitespace — a key path containing '#'
//     silently becomes a different, likely missing, file.
test('B31-R4 Include / Match / inline-# diverge from what ssh would do', () => {
  const withInclude = svc.parseSshConfig('Include conf.d/*.conf\nHost alpha\n  HostName alpha.example.invalid\n');
  assert.deepStrictEqual(withInclude.map((h) => h.alias), ['alpha'], 'the Include line is silently ignored');
  assert.strictEqual(withInclude[0].include, undefined, 'and it never becomes a host field either');

  const withMatch = svc.parseSshConfig([
    'Host alpha',
    '  HostName alpha.example.invalid',
    'Match host other.example.invalid',
    '  IdentityFile ~/.ssh/only-for-match',
  ].join('\n'));
  assert.strictEqual(withMatch.length, 1);
  assert.ok(
    String(withMatch[0].identityFile).includes('only-for-match'),
    'current behaviour: the Match directive leaked onto the preceding Host alias'
  );

  const withHash = svc.parseSshConfig('Host gamma\n  IdentityFile ~/.ssh/id#1\n');
  assert.ok(!String(withHash[0].identityFile).includes('#'), 'the value was truncated at the #');
});

test('wildcard aliases are not enumerable (documented limitation)', () => {
  const hosts = svc.parseSshConfig('Host web-* 10.*\n  HostName gw.example.invalid\nHost real\n');
  assert.deepStrictEqual(hosts.map((h) => h.alias), ['real']);
});

test('readConfigFile returns the path alongside the content', () => {
  fs.mkdirSync(path.dirname(svc.getConfigPath()), { recursive: true });
  fs.writeFileSync(svc.getConfigPath(), 'Host fromdisk\n  HostName d.example.invalid\n', 'utf-8');
  const res = svc.readConfigFile();
  assert.strictEqual(res.path, svc.getConfigPath());
  assert.match(res.content, /Host fromdisk/);
  assert.strictEqual(svc.listHosts().hosts[0].alias, 'fromdisk');
  assert.ok(res.path.startsWith(SANDBOX), 'never reads the real ~/.ssh/config');
});

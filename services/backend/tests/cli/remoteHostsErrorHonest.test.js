'use strict';

// #118 — `khy remote hosts` must not leak a raw fs syscall string to the
// terminal (Rule 2.2). When the SSH config path resolves to a directory,
// readFileSync throws `EISDIR: illegal operation on a directory, read`;
// the handler used to print that verbatim. It must instead map the errno to
// a Chinese cause and give a concrete remedy, keeping the machine code where
// no friendly mapping exists.

const assert = require('assert');
const nt = require('node:test');
const os = require('os');
const fs = require('fs');

const { handleRemote } = require('../../src/cli/handlers/remote.js');

// chalk stub: identity formatters, so captured text is the plain payload.
const mk = () => (s) => String(s);
const chalk = { red: mk(), green: mk(), yellow: mk(), bold: mk(), dim: mk(), cyan: mk() };

function runHosts(envConfigPath, patch) {
  const logs = [];
  const origLog = console.log;
  const origRead = fs.readFileSync;
  const origEnv = process.env.KHY_REMOTE_SSH_CONFIG_PATH;
  console.log = (...a) => { logs.push(a.join(' ')); };
  if (envConfigPath === undefined) delete process.env.KHY_REMOTE_SSH_CONFIG_PATH;
  else process.env.KHY_REMOTE_SSH_CONFIG_PATH = envConfigPath;
  if (patch) fs.readFileSync = patch;
  return Promise.resolve(handleRemote('hosts', { chalk }))
    .then(() => logs.join('\n'))
    .finally(() => {
      console.log = origLog;
      fs.readFileSync = origRead;
      if (origEnv === undefined) delete process.env.KHY_REMOTE_SSH_CONFIG_PATH;
      else process.env.KHY_REMOTE_SSH_CONFIG_PATH = origEnv;
    });
}

const throwErr = (err) => () => { throw err; };

nt('#118 EISDIR leaks neither raw syscall nor errno prefix', () => {
  return runHosts(os.tmpdir()).then((out) => {
    assert.match(out, /配置路径是目录而非文件/, `cause missing: ${out}`);
    assert.match(out, /请确认 .* 是可读的 SSH 配置文件/, `remedy missing: ${out}`);
    assert.doesNotMatch(out, /illegal operation on a directory/, `raw syscall leaked: ${out}`);
    assert.doesNotMatch(out, /EISDIR:/, `errno prefix leaked: ${out}`);
  });
});

nt('#118 EACCES maps to permission cause, no raw syscall', () => {
  return runHosts(
    os.tmpdir(),
    throwErr(Object.assign(new Error('EACCES: permission denied, open \'x\''), { code: 'EACCES' }))
  ).then((out) => {
    assert.match(out, /配置文件无读取权限/, `cause missing: ${out}`);
    assert.doesNotMatch(out, /permission denied/, `raw syscall leaked: ${out}`);
    assert.doesNotMatch(out, /EACCES:/, `errno prefix leaked: ${out}`);
  });
});

nt('#118 unknown errno keeps the code and still gives a remedy', () => {
  return runHosts(
    os.tmpdir(),
    throwErr(Object.assign(new Error('EBUSY: something, open'), { code: 'EBUSY' }))
  ).then((out) => {
    assert.match(out, /EBUSY/, `code not shown: ${out}`);
    assert.match(out, /请确认 .* 是可读的 SSH 配置文件/, `remedy missing: ${out}`);
    assert.doesNotMatch(out, /something, open/, `raw syscall leaked: ${out}`);
  });
});

nt('#118 non-error path unchanged (no config -> 未发现 SSH 主机)', () => {
  return runHosts('C:/definitely/not/here/config-file').then((out) => {
    assert.match(out, /未发现 SSH 主机/, `empty-config branch changed: ${out}`);
  });
});

'use strict';

/**
 * webSearchProxyHintShellSyntax.test.js — 联网全失败时的代理提示，其「设置环境变量」
 * 一行必须跟着用户 shell 走：Windows 上印 `export` 等于给出一条粘进 cmd/PowerShell
 * 就跑不动的第一建议（`'export' 不是内部或外部命令`）。
 *
 * 零外呼：http(s).get|request 与 fetch 全部打桩成即刻 ECONNREFUSED，因此走的是
 * searchUnified 真实的「网络类失败」分支，而不是假想文案。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

const svc = require('../../src/services/webSearchService');
const { envSetSyntax } = svc.__parsersForTests;

function _refusedRequest() {
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.abort = () => {};
  req.destroy = () => {};
  req.write = () => {};
  req.end = () => {};
  process.nextTick(() => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:9 (test stub)');
    err.code = 'ECONNREFUSED';
    req.emit('error', err);
  });
  return req;
}

/** Run `fn` with every outbound channel failing as ECONNREFUSED on the given platform. */
async function _withNetworkDown(platform, fn) {
  const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const saved = {
    httpGet: http.get,
    httpRequest: http.request,
    httpsGet: https.get,
    httpsRequest: https.request,
    fetch: globalThis.fetch,
    mode: process.env.KHY_SEARCH_MODE,
    engines: process.env.KHY_SEARCH_ENGINES,
    httpsProxy: process.env.HTTPS_PROXY,
    httpProxy: process.env.HTTP_PROXY,
  };
  http.get = () => _refusedRequest();
  http.request = () => _refusedRequest();
  https.get = () => _refusedRequest();
  https.request = () => _refusedRequest();
  globalThis.fetch = async () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:9 (test stub fetch)');
    err.code = 'ECONNREFUSED';
    throw err;
  };
  // One keyless engine, request mode → no browser fan-out, no kiro round trip.
  process.env.KHY_SEARCH_MODE = 'request';
  process.env.KHY_SEARCH_ENGINES = 'duckduckgo';
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    http.get = saved.httpGet;
    http.request = saved.httpRequest;
    https.get = saved.httpsGet;
    https.request = saved.httpsRequest;
    globalThis.fetch = saved.fetch;
    if (saved.mode === undefined) delete process.env.KHY_SEARCH_MODE;
    else process.env.KHY_SEARCH_MODE = saved.mode;
    if (saved.engines === undefined) delete process.env.KHY_SEARCH_ENGINES;
    else process.env.KHY_SEARCH_ENGINES = saved.engines;
    if (saved.httpsProxy !== undefined) process.env.HTTPS_PROXY = saved.httpsProxy;
    if (saved.httpProxy !== undefined) process.env.HTTP_PROXY = saved.httpProxy;
    Object.defineProperty(process, 'platform', savedPlatform);
  }
}

test('win32: network-failure hint offers cmd + PowerShell syntax, never export', async () => {
  const result = await _withNetworkDown('win32', () => svc.search('杭州 天气'));
  // Non-vacuity: the stub must really have driven the network branch of searchUnified.
  assert.equal(result.success, false);
  assert.match(result.error, /无法访问外网搜索引擎/, 'did not reach the proxy-hint branch');
  assert.match(result.error, /set HTTPS_PROXY=<http/);
  assert.match(result.error, /\$env:HTTPS_PROXY="<http/);
  assert.doesNotMatch(result.error, /export HTTPS_PROXY/, 'POSIX-only advice on Windows');
  // The advice must not invent a machine-specific proxy endpoint (Rule 1).
  assert.doesNotMatch(result.error, /127\.0\.0\.1|7890/);
});

test('posix (control): the same branch keeps the export form', async () => {
  const result = await _withNetworkDown('linux', () => svc.search('杭州 天气'));
  assert.equal(result.success, false);
  assert.match(result.error, /无法访问外网搜索引擎/);
  assert.match(result.error, /export HTTPS_PROXY=</);
  assert.doesNotMatch(result.error, /\$env:HTTPS_PROXY/);
});

test('envSetSyntax interpolates both shell forms for any name/value', () => {
  const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    assert.equal(
      envSetSyntax('FOO', 'bar'),
      'set FOO=bar（cmd）或 $env:FOO="bar"（PowerShell）'
    );
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    assert.equal(envSetSyntax('FOO', 'bar'), 'export FOO=bar');
  } finally {
    Object.defineProperty(process, 'platform', savedPlatform);
  }
});

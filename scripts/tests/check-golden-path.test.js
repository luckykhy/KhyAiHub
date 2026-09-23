'use strict';
/**
 * check-golden-path.test.js — [DESIGN-DELIV-001] D9 执行器的回归网。
 *
 * ## 为什么 docker 通道的用例值钱
 *
 * docker 是三条交付渠道里**唯一一条本机跑不到端到端**的（`docker compose up -d --build`
 * 要拉基础镜像并起容器，本检查刻意只验到"配置可解析"）。于是它的读数天生容易退化成
 * 一句含糊的 SKIP：既不说缺什么前置，也不说怎么补 —— 而 SKIP 的读者正是想补上它的人。
 * 这些用例把两条 SKIP 的**可操作性**钉住：缺 CLI 必须报出被试过的可执行文件与
 * `KHY_GOLDEN_DOCKER` 这个补救开关；缺 daemon 必须报出 daemon 的原始错误行。
 *
 * ## 判据来源
 *
 * 用例断言的是 `--json` 的结构化读数（`results[].status` / `results[].reason`），
 * 外加"被调用方真的收到了哪条 argv"（stub docker 记 argv）——不认人读文案，
 * 防止断言在文案改写时静默失效。
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const CHECKER = path.resolve(__dirname, '..', 'ci', 'check-golden-path.js');
const DOC_REL = path.join('docs', '10_规范', '其它规范', '[DESIGN-DELIV-002] 产品任务面与交付律.md');
const DECLARED = 'docker compose up -d --build';

let seq = 0;
const TMP_ROOTS = [];

after(() => {
  for (const root of TMP_ROOTS) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响判定：临时目录在系统 temp 下，不在仓库里 */
    }
  }
});

/**
 * fixture：只放 docker 通道需要的东西 —— 阈值真源的 json 代码块 + compose 文件。
 * 真源文档用替身是刻意的：本用例测的是**执行器怎么读声明**，不是声明本身的值
 * （声明值与阈值由 check-delivery-baseline.test.js 的那份 fixture 负责）。
 */
function mkFixture({ composeFile = true } = {}) {
  seq += 1;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `khy-golden-${seq}-`));
  TMP_ROOTS.push(root);
  const doc = path.join(root, DOC_REL);
  fs.mkdirSync(path.dirname(doc), { recursive: true });
  fs.writeFileSync(
    doc,
    [
      '# 阈值真源（测试替身）',
      '',
      '```json',
      JSON.stringify(
        {
          $schema: 'khy-delivery-surface/1',
          channels: { docker: { goldenPath: DECLARED, ciWorkflow: '.github/workflows/docker.yml' } },
        },
        null,
        2
      ),
      '```',
      '',
    ].join('\n'),
    'utf8'
  );
  if (composeFile) fs.writeFileSync(path.join(root, 'docker-compose.yml'), 'services:\n  backend:\n    image: khy-os:test\n', 'utf8');
  return root;
}

/**
 * stub docker：把收到的 argv 记进 args.log，再按开关回话。
 * 用 .cmd / sh 两种壳而不是 .js，是因为执行器按平台决定是否过 shell —— 用例要测的
 * 正是它与 shell 的那层交互（Windows 上 `docker` 由 PATH 解析，便携版常在 PATH 外）。
 */
function mkStubDocker(dir, { configOk = true, daemonOk = true } = {}) {
  const log = path.join(dir, 'args.log');
  if (process.platform === 'win32') {
    const file = path.join(dir, 'docker-stub.cmd');
    fs.writeFileSync(
      file,
      [
        '@echo off',
        `echo %* >> "${log}"`,
        'if "%1"=="--version" (echo Docker version 99.0.0 & exit /b 0)',
        daemonOk
          ? 'if "%1"=="info" (echo 99.0.0 & exit /b 0)'
          : 'if "%1"=="info" (echo error during connect: daemon not running 1>&2 & exit /b 1)',
        configOk ? 'if "%1"=="compose" (exit /b 0)' : 'if "%1"=="compose" (echo compose config failed 1>&2 & exit /b 1)',
        'exit /b 1',
        '',
      ].join('\r\n'),
      'utf8'
    );
    return file;
  }
  const file = path.join(dir, 'docker-stub');
  fs.writeFileSync(
    file,
    [
      '#!/bin/sh',
      `echo "$@" >> "${log}"`,
      'case "$1" in',
      '  --version) echo "Docker version 99.0.0"; exit 0 ;;',
      daemonOk ? '  info) echo "99.0.0"; exit 0 ;;' : '  info) echo "error during connect: daemon not running" 1>&2; exit 1 ;;',
      configOk ? '  compose) exit 0 ;;' : '  compose) echo "compose config failed" 1>&2; exit 1 ;;',
      'esac',
      'exit 1',
      '',
    ].join('\n'),
    'utf8'
  );
  fs.chmodSync(file, 0o755);
  return file;
}

function runDockerChannel(root, env) {
  const r = cp.spawnSync(process.execPath, [CHECKER, '--only', 'docker', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, KHY_GOLDEN_ROOT: root, ...env },
  });
  assert.equal(r.status, 0, `执行器必须 exit 0（SKIP ≠ FAIL）：${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.results.length, 1);
  return parsed.results[0];
}

test('docker：没有 CLI 时 SKIP，且报出被试过的可执行文件与补救开关', () => {
  const root = mkFixture();
  const missing = path.join(root, 'no-such-dir', 'docker');
  const res = runDockerChannel(root, { KHY_GOLDEN_DOCKER: missing });
  assert.equal(res.status, 'SKIP');
  assert.equal(res.declared, DECLARED, '声明原文必须回显');
  assert.ok(res.reason.includes('缺前置'), `SKIP 必须点明缺什么前置：${res.reason}`);
  assert.ok(res.reason.includes('KHY_GOLDEN_DOCKER'), `SKIP 必须给出补上它的开关：${res.reason}`);
});

test('docker：配置可解析 + daemon 可达 ⇒ 仍 SKIP（端到端未跑），并回显 daemon 版本', () => {
  const root = mkFixture();
  const cli = mkStubDocker(root, { configOk: true, daemonOk: true });
  const res = runDockerChannel(root, { KHY_GOLDEN_DOCKER: cli });
  assert.equal(res.status, 'SKIP');
  assert.ok(res.reason.includes('配置可解析'), `已验部分必须报出来：${res.reason}`);
  assert.ok(res.reason.includes('daemon 可达'), `daemon 读数必须报出来：${res.reason}`);
  assert.ok(res.reason.includes('99.0.0'), `daemon 版本必须回显：${res.reason}`);
  assert.ok(/up -d --build/.test(res.reason), '端到端未跑这件事必须写清楚');
  const argv = fs.readFileSync(path.join(root, 'args.log'), 'utf8');
  assert.ok(
    argv.includes('compose -f docker-compose.yml config --quiet'),
    `被验的必须是真源里声明的那条 compose 命令，实际收到：${argv}`
  );
});

test('docker：daemon 不可达时 SKIP 必须带上 daemon 的原始错误行', () => {
  const root = mkFixture();
  const cli = mkStubDocker(root, { configOk: true, daemonOk: false });
  const res = runDockerChannel(root, { KHY_GOLDEN_DOCKER: cli });
  assert.equal(res.status, 'SKIP');
  assert.ok(res.reason.includes('daemon 不可达'), `必须写明 daemon 不可达：${res.reason}`);
  assert.ok(/daemon not running/.test(res.reason), `必须带上原始错误行（不许转述）：${res.reason}`);
});

test('docker：compose 配置不可解析 ⇒ FAIL（不是 SKIP），退出码 1', () => {
  const root = mkFixture();
  const cli = mkStubDocker(root, { configOk: false });
  const r = cp.spawnSync(process.execPath, [CHECKER, '--only', 'docker', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, KHY_GOLDEN_ROOT: root, KHY_GOLDEN_DOCKER: cli },
  });
  assert.equal(r.status, 1, '断言不成立必须是 FAIL + exit 1，不许降级成 SKIP');
  const res = JSON.parse(r.stdout).results[0];
  assert.equal(res.status, 'FAIL');
  assert.ok(res.reason.includes('配置不可解析'), res.reason);
  assert.ok(/compose config failed/.test(res.reason), `必须带上 compose 的原始错误行：${res.reason}`);
});

test('docker：CLI 可用但没有 docker-compose.yml ⇒ FAIL', () => {
  const root = mkFixture({ composeFile: false });
  const cli = mkStubDocker(root);
  const r = cp.spawnSync(process.execPath, [CHECKER, '--only', 'docker', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, KHY_GOLDEN_ROOT: root, KHY_GOLDEN_DOCKER: cli },
  });
  assert.equal(r.status, 1);
  const res = JSON.parse(r.stdout).results[0];
  assert.equal(res.status, 'FAIL');
  assert.ok(res.reason.includes('docker-compose.yml'), res.reason);
});
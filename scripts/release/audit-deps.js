#!/usr/bin/env node
'use strict';
/**
 * npm audit 执行器(薄壳)。做副作用:跑 npm、读 lockfile、解析 JSON;判定逻辑很少,
 * 但需要处理三种截然不同的结局,故独立成文件而不是塞进发布门的数据叶子:
 *
 *   0  —— audit 真的跑了,且没有 high/critical(读数:一行计数摘要)。
 *   1  —— audit 跑了,发现 high/critical(发布门 tier=recommended ⇒ 只进 warnings)。
 *   78 —— SKIP:audit 本身不可用(离线 / registry 未实现 audit 端点 / 无 lockfile /
 *           npm 不存在)。**SKIP 不是 PASS** —— 门的薄壳会把 78 映射成 status='skip',
 *           既不算通过也不算失败,读数上就是「未验证」。
 *
 * 为什么必须看 JSON 而不是退出码:实测某些 registry(如 npmmirror)对
 * /-/npm/v1/security/* 返回 404,而 `npm audit --json` 仍以 0 退出并打印一个带
 * `error`/`statusCode` 的 JSON 对象。只看退出码会把「根本没审计」读成「没有漏洞」。
 *
 * 作为 release-gate 的一个 recommended 阶段消费:
 *   node scripts/release/audit-deps.js
 *
 * 环境变量:
 *   KHY_AUDIT_TIMEOUT_MS —— 单次 npm audit 的等待上限(默认 120000)。这是对一次
 *   网络请求的 I/O 上限,不是对长任务的硬 kill(见 AGENTS.md 规则 3 的 I/O 例外)。
 */

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json'];

const EXIT_OK = 0;
const EXIT_VULNERABLE = 1;
const EXIT_SKIP = 78;

const NPM_AUDIT_COMMAND = 'npm audit --omit=dev --audit-level=high --json';

const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'info'];

function _timeoutMs() {
  const parsed = Number.parseInt(String(process.env.KHY_AUDIT_TIMEOUT_MS ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120000;
}

function _lockfile() {
  for (const name of LOCKFILES) {
    const full = path.join(REPO_ROOT, name);
    if (fs.existsSync(full)) {
      return { name, full };
    }
  }
  return null;
}

/** npm audit JSON 可能混入 npm 的 notice;取第一个 `{` 到最后一个 `}`。 */
function _parseAuditJson(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) {
      return null;
    }
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function _hostOf(uri) {
  try {
    return new URL(String(uri)).host;
  } catch {
    return '';
  }
}

function skip(reason) {
  process.stdout.write(`SKIP: 依赖漏洞未验证 — ${reason}（不得视为通过）\n`);
  process.exit(EXIT_SKIP);
}

/**
 * 从 audit JSON 里取严重度计数。支持两种形态:
 *   npm 7+  —— metadata.vulnerabilities
 *   更老的  —— vulnerabilities{ <pkg>: { severity } }
 * @returns {{ counts: object, total: number } | null}
 */
function _extractCounts(json) {
  const meta = json && json.metadata && json.metadata.vulnerabilities;
  if (meta && typeof meta === 'object') {
    const counts = {};
    let total = 0;
    for (const level of SEVERITY_ORDER) {
      const n = Number(meta[level] || 0);
      counts[level] = Number.isFinite(n) ? n : 0;
      total += counts[level];
    }
    return { counts, total };
  }
  const vulns = json && json.vulnerabilities;
  if (vulns && typeof vulns === 'object') {
    const counts = Object.fromEntries(SEVERITY_ORDER.map((level) => [level, 0]));
    for (const entry of Object.values(vulns)) {
      const level = String((entry && entry.severity) || '').toLowerCase();
      if (level in counts) {
        counts[level] += 1;
      }
    }
    return { counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
  }
  return null;
}

function main() {
  const lock = _lockfile();
  if (!lock) {
    skip(`仓库根没有 lockfile（${LOCKFILES.join(' / ')}），npm audit 无从比对`);
  }

  const res = cp.spawnSync(`${NPM_AUDIT_COMMAND}`, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: _timeoutMs(),
    // Windows 上 npm 是 .cmd 包装器,必须走 shell 才能解析;命令与参数全是本文件
    // 的固定字面量,没有外部输入拼进命令行。
    shell: true,
    windowsHide: true,
    env: process.env,
  });

  if (res.error) {
    const code = String(res.error.code || '');
    if (code === 'ENOENT') {
      skip('未找到 npm — 依赖审计无法运行');
    }
    if (code === 'ETIMEDOUT') {
      skip(`npm audit 超时（>${_timeoutMs()}ms）`);
    }
    skip(`npm audit 启动失败: ${String(res.error.message || code).slice(0, 120)}`);
  }

  const json = _parseAuditJson(res.stdout);
  if (!json) {
    const stderr = String(res.stderr || '').trim();
    skip(`npm audit 未返回可解析 JSON${stderr ? `: ${stderr.split('\n')[0].slice(0, 120)}` : ''}`);
  }

  // registry 不支持 audit 端点 / 离线:JSON 里是 error + statusCode,而不是计数。
  if (json.error || (json.statusCode && !_extractCounts(json))) {
    const host = _hostOf(json.uri);
    const detail =
      typeof json.error === 'object'
        ? String(json.error.summary || json.error.detail || '').trim()
        : String(json.error || '').trim();
    skip(
      `registry 不可审计${host ? `（${host}）` : ''}` +
        `${json.statusCode ? ` status=${json.statusCode}` : ''}` +
        `${detail ? ` ${String(detail).slice(0, 100)}` : ''}`
    );
  }

  const parsed = _extractCounts(json);
  if (!parsed) {
    skip('npm audit JSON 缺少漏洞计数（既无 metadata.vulnerabilities 也无 vulnerabilities）');
  }

  const { counts, total } = parsed;
  const blocking = counts.critical + counts.high;
  const line =
    `依赖漏洞: critical=${counts.critical} high=${counts.high} ` +
    `moderate=${counts.moderate} low=${counts.low} info=${counts.info} ` +
    `(total=${total}) · 阈值=high · 省略 devDependencies`;
  process.stdout.write(line + '\n');

  if (blocking > 0) {
    process.exit(EXIT_VULNERABLE);
  }
  process.exit(EXIT_OK);
}

main();

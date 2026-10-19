#!/usr/bin/env node
'use strict';

/**
 * check-secrets-staged.js — 暂存区「高置信密钥形态」内容扫描（离线 / 零依赖 / 纯 Node）
 *
 * 为什么在第 3 步的 check-staged-secrets.js 之外再加一个：
 *   那个检查器的 COMMIT_PATTERNS 只有四类形态（sk- / AKIA / ghp_ / PRIVATE KEY），
 *   且它按「文件 + 完整值」走 hygiene-allowlist.json 豁免。两份 .env.tmp.<时间戳>
 *   带着真实的 64 位 hex JWT_SECRET（形态是 `JWT_SECRET=<64 hex>`，四类里一类不沾）
 *   就这么进了历史。本机 gitleaks / secretlint 都不可用（不在 PATH，也不在
 *   node_modules），无法外挂，故按内容形态自建一份。
 *
 * 与 check-staged-secrets.js 的分工：那个管「白名单化的既有四类」，这个管
 * 「更宽的高置信形态 + 形态级豁免」。两者都在 pre-commit 里跑，互补，不互相替代。
 *
 * 用法:
 *   node scripts/ci/check-secrets-staged.js             扫描 git diff --cached 的新增行
 *   node scripts/ci/check-secrets-staged.js --selftest  内置样例自测（能抓到 / 白名单不误报）
 *   node scripts/ci/check-secrets-staged.js --json      机读输出
 *
 * 退出: 0 干净 / 1 有 finding（含 --selftest 断言失败）/ 2 用法或运行错误
 */

const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = process.env.KHY_RULEGUARD_ROOT
  ? path.resolve(process.env.KHY_RULEGUARD_ROOT)
  : path.resolve(__dirname, '..', '..');

// ── 形态集合 ──────────────────────────────────────────────────────────────
// 都取「高置信」：宁可漏报，也不把注释 / 标识符 / 校验和判成密钥。
// 每条形态的取舍理由写在下面。
const PATTERNS = Object.freeze([
  // 64 位 hex。sha1 只有 40 位、md5 只有 32 位；64 位 hex 在源码里几乎只出现在
  // `openssl rand -hex 32` 生成的密钥与构建指纹两类。构建指纹（docker digest
  // `...@sha256:<64hex>`）由 hex64LooksLikeDigest() 排除，所以拦到的基本是真密钥。
  ['hex64', /\b[0-9a-fA-F]{64}\b/],
  // OpenAI 风格 sk- 密钥：基础形态是 sk- 后接纯 base62（真 key 不带连字符），
  // 故 [A-Za-z0-9]{16,} 即可；另外覆盖 sk-proj- / sk-ant- / sk-svcacct- 三个带前缀形态。
  // 不加尾部 `-` 进字符类：`task-template-...` 里的 `sk-t` 不满足 `\b` 起点边界，不会误报。
  ['openai-key', /\bsk-[A-Za-z0-9]{16,}\b|\bsk-(?:proj|ant|svcacct)-[A-Za-z0-9]{16,}\b/i],
  // Windsurf / Codeium relay token：实测泄露形态是 `qual` + 38 位，整体 42 位。
  // 只认纯字母数字、且长度 >= 22，避免 `quality` 这类英文词误报（无 18 位以上纯英文后缀）。
  ['relay-token', /\bqual[A-Za-z0-9]{18,}\b/i],
  ['github-token', /\bghp_[A-Za-z0-9]{20,}\b/],
  ['github-pat', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private-key-block', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----/],
  // 赋值型长随机串：`api_key = "<24+ 位随机串>"` 这类。捕获组只取值，名字部分做右界限制。
  // 命中后还要过 looksLikeRandomSecret()（长度 / 必含数字与字母 / 非占位符）才算数。
  [
    'assigned-secret',
    /(?:api[_-]?key|secret|token|passwd|password|access[_-]?key|private[_-]?key|auth[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["']?([A-Za-z0-9+/_=-]{24,})/i,
  ],
]);

// 占位符 / 假值特征：这些不是真密钥，命中形态也要放行（`.env.example` 里那一串就是）。
const PLACEHOLDER = /(?:change[_-]?this|changeme|change-me|placeholder|example|dummy|your[_-]|xxxxxx|dev[_-]only|not[_-]?a[_-]?real|sample|redacted|\bstub\b)/i;

// ── 形态级豁免（按路径）─────────────────────────────────────────────────────
// 模板 / 文档 / 锁文件 / 测试里的「密钥形态」是设计使然（占位符、示例、校验和、夹具），
// 拦它们只会逼出「加白名单」的次生噪声。真密钥不会长在这些地方。
const EXEMPT_NAME = [
  /(^|\/)\.env\.example$/i,
  /\.example$/i,
  /\.sample$/i,
  /\.md$/i,
  /\.markdown$/i,
  /\.mdown$/i,
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock|packages\.lock\.json)$/i,
  /\.lock$/i,
];

const EXEMPT_TEST = [
  /(^|\/)(tests?|__tests__|__mocks__|__snapshots__|fixtures?|test-data|testdata)\//i,
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /\.snap$/i,
  /(^|\/)(test_[^/]*|[^/]*_test)\.py$/i,
];

function isExemptFile(file) {
  return EXEMPT_NAME.some((re) => re.test(file)) || EXEMPT_TEST.some((re) => re.test(file));
}

// docker 镜像 digest（`image: x@sha256:<64hex>`）与任何 `sha256: <64hex>` 校验和：
// 它们是可公开的完整性指纹，不是凭据。命中 64 位 hex 时看前文 12 字符里有没有 shaXXX:。
function hex64LooksLikeDigest(line, index) {
  const before = line.slice(Math.max(0, index - 12), index);
  return /sha\d{1,3}\s*[:=]?\s*$/i.test(before);
}

// 赋值型命中的值要真的像「随机串」：够长、同时含数字与字母、且不是占位符。
function looksLikeRandomSecret(value) {
  if (value.length < 24) return false;
  if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) return false;
  if (PLACEHOLDER.test(value)) return false;
  return true;
}

function maskValue(pattern, value) {
  if (pattern === 'private-key-block') return '-----BEGIN … PRIVATE KEY-----';
  if (value.length <= 8) return '***';
  // 与事实清单同口径：留前 4 位 + 长度，够定位、不够复原。
  return value.slice(0, 4) + '…(len ' + value.length + ')';
}

/** 扫一行，返回 [{pattern, value}]；同一行同一值只报一次（避免 hex64 与 assigned-secret 重复）。 */
function scanLine(line) {
  const hits = [];
  const seen = new Set();
  for (const [name, re] of PATTERNS) {
    const m = line.match(re);
    if (!m) continue;
    const value = m[1] !== undefined ? m[1] : m[0];
    if (seen.has(value)) continue;
    if (name === 'hex64' && hex64LooksLikeDigest(line, m.index)) continue;
    if (name === 'assigned-secret' && !looksLikeRandomSecret(value)) continue;
    if (PLACEHOLDER.test(value)) continue;
    seen.add(value);
    hits.push({ pattern: name, value });
  }
  return hits;
}

function scanText(file, text) {
  if (isExemptFile(file)) return [];
  const out = [];
  text.split('\n').forEach((line, i) => {
    for (const h of scanLine(line.replace(/\r$/, ''))) {
      out.push({ file, line: i + 1, pattern: h.pattern, value: h.value });
    }
  });
  return out;
}

/** 解析 `git diff --cached -U0`，返回 Map<文件, 新增行[]>。 */
function stagedAddedLines() {
  let diff;
  try {
    diff = execFileSync(
      'git',
      ['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--no-textconv'],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }
    );
  } catch (error) {
    process.stderr.write('无法读取暂存区 diff（是否在 git 仓库内？）：' + error.message + '\n');
    process.exit(2);
  }

  const byFile = new Map();
  let current = null;
  for (const raw of diff.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('+++ b/')) {
      // 路径含 [ ] 等特殊字符时 git 会在 +++ 行尾补制表符消歧，剥掉再比。
      current = line.slice(6).replace(/\t$/, '');
      continue;
    }
    if (line.startsWith('+++ /dev/null')) {
      current = null;
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('@@') || line.startsWith('diff --git')) continue;
    if (!line.startsWith('+') || current === null) continue;
    if (!byFile.has(current)) byFile.set(current, []);
    byFile.get(current).push(line.slice(1));
  }
  return byFile;
}

function scanStaged() {
  const findings = [];
  for (const [file, lines] of stagedAddedLines()) {
    if (isExemptFile(file)) continue;
    lines.forEach((line, i) => {
      for (const h of scanLine(line)) {
        findings.push({ file, line: i + 1, pattern: h.pattern, value: h.value });
      }
    });
  }
  return findings;
}

function selftest() {
  // 样例值全部在运行时拼接，源码正文里不出现任何「像密钥的字面量」——
  // 否则这个检查器自己被扫描时就会自指命中。
  const HEX64 = 'a1b2c3d4'.repeat(8);
  const SK = 'sk-' + 'AbCdEf0123456789GhIjKlMnOpQrStUvWx';
  const RELAY = 'qual' + 'Ab0Cd1Ef2Gh3Ij4Kl5Mn6Op7Qr8St9';
  const GHP = 'ghp_' + 'AbCdEf0123456789GhIjKlMnOpQrSt';
  const PAT = 'github_pat_' + '11AbCdEf0123456789GhIjKlMnOp';
  // 不用 AWS 文档里那个 AKIA...EXAMPLE 示例键：它含 "EXAMPLE" 会被占位符规则正确放行，
  // 拿它当「应命中」样例会误导。这里用一个不含 placeholder 特征的 20 位键。
  const AKIA = 'AKIA' + 'QWERTYUIOP123456';
  // 同样拼接：整段 PRIVATE KEY 头若以字面量出现在本文件里，提交本文件时这个检查器
  // （以及 pre-commit 第 3 步的 check-staged-secrets.js）会自指命中，把自己拦在门外。
  const PK = '-----BEGIN RSA ' + 'PRIVATE KEY-----';
  const RANDOM = 'AbCdEf0123456789GhIjKlMnOpQrStUv';

  const cases = [
    // —— 应命中 ——
    { file: 'runtime/node/backend/src/bootstrap/ensureAuthSecret.js', text: 'JWT_SECRET=' + HEX64, why: '64 位 hex JWT_SECRET', want: true, pattern: 'hex64' },
    { file: 'src/config.js', text: 'OPENAI_API_KEY=' + SK, why: 'sk- 密钥', want: true, pattern: 'openai-key' },
    { file: 'src/gateway.js', text: 'RELAY_API_KEY=' + RELAY, why: 'qual 长 token', want: true, pattern: 'relay-token' },
    { file: 'src/auth.js', text: 'token = ' + GHP, why: 'ghp_', want: true, pattern: 'github-token' },
    { file: 'ci/pipeline.yml', text: 'key: ' + PAT, why: 'github_pat_', want: true, pattern: 'github-pat' },
    { file: 'ci/pipeline.yml', text: 'aws: ' + AKIA, why: 'AKIA', want: true, pattern: 'aws-access-key' },
    { file: 'src/keys.js', text: PK, why: 'PRIVATE KEY 块', want: true, pattern: 'private-key-block' },
    { file: 'src/db.js', text: 'CLIENT_SECRET = "' + RANDOM + '"', why: '赋值型长随机串', want: true, pattern: 'assigned-secret' },

    // —— 不应命中（白名单 / 占位符 / 假值）——
    { file: 'src/config.js', text: 'JWT_SECRET=change_this_in_production', why: '弱占位符（无数字）', want: false },
    { file: 'src/x.js', text: 'const secret = process.env.JWT_SECRET;', why: '读取 env，非字面量', want: false },
    { file: 'src/x.js', text: "const id = 'task-template-hint-injection';", why: '标识符里的 sk-t（无 \\b 起点）', want: false },
    { file: '.env.example', text: 'JWT_SECRET=' + HEX64, why: '模板豁免', want: false },
    { file: 'README.md', text: 'checksum sha256: ' + HEX64, why: '文档豁免', want: false },
    { file: 'src/crypto.test.js', text: "const k = '" + SK + "';", why: '测试文件豁免', want: false },
    { file: 'package-lock.json', text: '"integrity": "sha512-' + HEX64 + '"', why: '锁文件豁免', want: false },
    { file: 'docker-compose.yml', text: 'image: khy-os@sha256:' + HEX64, why: 'docker digest 不是密钥', want: false },
  ];

  let failed = 0;
  for (const c of cases) {
    const findings = scanText(c.file, c.text);
    const got = findings.length > 0;
    const patOk = !c.want || !c.pattern || findings.some((f) => f.pattern === c.pattern);
    const ok = got === c.want && patOk;
    if (!ok) failed++;
    process.stdout.write(
      (ok ? '  ✓ ' : '  ✗ ') + (c.want ? '[应命中] ' : '[不应命中] ')
      + c.why + '  —  ' + c.file + '\n'
    );
  }

  if (failed === 0) {
    process.stdout.write('\n自测通过：' + cases.length + ' 例（' + cases.filter((c) => c.want).length + ' 命中 + ' + cases.filter((c) => !c.want).length + ' 豁免）\n');
    return 0;
  }
  process.stdout.write('\n自测失败：' + failed + '/' + cases.length + ' 例不符\n');
  return 1;
}

function run() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('用法: node scripts/ci/check-secrets-staged.js [--selftest] [--json]\n');
    return 2;
  }
  if (argv.includes('--selftest')) return selftest();

  const json = argv.includes('--json');
  const findings = scanStaged();

  if (json) {
    process.stdout.write(JSON.stringify({ findings: findings.map((f) => ({ ...f, value: maskValue(f.pattern, f.value) })) }, null, 2) + '\n');
  } else if (findings.length === 0) {
    process.stdout.write('  ✓ 暂存区无高置信密钥形态\n');
  } else {
    process.stdout.write('✗ 错误：暂存区检测到疑似密钥（' + findings.length + ' 处，值已打码）：\n');
    for (const f of findings) {
      process.stdout.write('  ' + f.file + ':' + f.line + '  [' + f.pattern + ']  ' + maskValue(f.pattern, f.value) + '\n');
    }
    process.stdout.write('\n真实密钥请移入 .env（已被 gitignore），不要提交。\n');
    process.stdout.write('如确认为夹具等假值，请改放到 tests/ 目录或 *.example / *.md 文件，或改写形态使其不像密钥。\n');
  }

  return findings.length === 0 ? 0 : 1;
}

if (require.main === module) {
  process.exit(run());
}

module.exports = { run, selftest, scanText, scanStaged, scanLine, isExemptFile, PATTERNS };

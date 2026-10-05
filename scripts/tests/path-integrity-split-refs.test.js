'use strict';

// path-integrity --scan-split-refs 的判据。
//
// 为什么单独测这个：拆段字面量是 `--scan-refs` 的**盲区**（别名正则要求连续
// `services/` token，而 `path.join(root, 'services', 'backend', '.env')` 里没有
// 这个子串）⇒ 桌面端 host 的 backend 加载路径整片漏报过。这里锁三件事：
//   ① 拆段写法能被拼出来并命中别名；
//   ② 连续写法**不**在这里重复报（归 --scan-refs 管）；
//   ③ 本次修好的那几个文件保持 0 命中（防回归）。
//
// 刻意**不**在这里跑全量 scanSplitRefs()：冷启实测 ~153s（git ls-files + 1 万文件），
// 放进 test:scripts 会把快档拖垮。全量扫描是人工动线，不是门禁。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const guard = require('../maintenance/path-integrity.js');
const { splitSegmentGroups, remapWithin, splitHitsInText } = guard;
const ROOT = path.resolve(__dirname, '..', '..');

const joinOf = (line) => splitSegmentGroups(line).map((g) => g.map((x) => x.val).join('/'));

test('splitSegmentGroups：拆段字面量被拼成一条路径', () => {
  const line = "const envPath = path.join(resolveKhyOsDir(), 'services', 'backend', '.env')";
  assert.deepEqual(joinOf(line), ['services/backend/.env']);
});

test('splitSegmentGroups：单段字面量不收（归 --scan-refs 管，避免重复报）', () => {
  const line = "const q = 'services/backend/src/cli/ai.js'";
  assert.deepEqual(joinOf(line), []);
});

test('splitSegmentGroups：一行里多个调用只收 ≥2 段的组', () => {
  const line = "f('a', 'b'), g('c')";
  assert.deepEqual(joinOf(line), ['a/b']);
});

test('splitSegmentGroups：双引号与变量前缀都认', () => {
  const line = 'const p = path.join(portable, "khy-os", "services", "backend", "src", "services")';
  assert.deepEqual(joinOf(line), ['khy-os/services/backend/src/services']);
});

test('splitSegmentGroups：非逗号分隔的相邻字面量不算一组', () => {
  const line = "const a = 'services' + 'backend'";
  assert.deepEqual(joinOf(line), []);
});

test('remapWithin：命中别名并给出重映射结果', () => {
  const r = remapWithin('services/backend/.env');
  assert.equal(r.ref, 'services/backend/.env');
  assert.equal(r.remapped, 'runtime/node/backend/.env');
});

test('remapWithin：别名不在开头时（变量前缀段）也能命中', () => {
  const r = remapWithin('khy-os/services/backend/src/services');
  assert.equal(r.prefix, 'khy-os/');
  assert.equal(r.ref, 'services/backend/src/services');
  assert.equal(r.remapped, 'runtime/node/backend/src/services');
});

test('remapWithin：左边界保护 —— xservices/ 不算命中', () => {
  assert.equal(remapWithin('xservices/backend/.env'), null);
});

test('remapWithin：已经是新路径的不命中', () => {
  assert.equal(remapWithin('runtime/node/backend/.env'), null);
});

// ★ 假阳性类（2026-10-04 由回归锁抓出来的一条）：迁移后的路径里**含**旧别名子串。
// 不做这个过滤时，`runtime/node/backend/src/services/gateway/x.js` 会被当成
// 「旧路径 services/gateway/x.js」，把新路径报成断链（同 --scan-refs 的 noop 规则）。
test('remapWithin：新路径里含 services/ 子串 —— 不命中', () => {
  assert.equal(remapWithin('runtime/node/backend/src/services/gateway/x.js'), null);
  assert.equal(remapWithin('khy-os/runtime/node/backend/src/services'), null);
});

test('remapWithin：新路径里含 platform/ 子串 —— 不命中', () => {
  assert.equal(remapWithin('runtime/substrate/platform/packages/shared'), null);
  assert.equal(remapWithin('runtime/substrate/platform/khy_platform'), null);
});

test('remapWithin：与别名无关的路径不命中', () => {
  assert.equal(remapWithin('src/renderer/App.tsx'), null);
});

test('splitHitsInText：注释里的拆段写法不算（避免误报）', () => {
  const src = "// path.join(x, 'services', 'backend')\n";
  assert.equal(splitHitsInText(src, '.js').length, 0);
});

test('splitHitsInText：帮助文本 / echo 输出不算', () => {
  const src = "echo \"path.join(x, 'services', 'backend')\"\n";
  assert.equal(splitHitsInText(src, '.sh').length, 0);
});

test('splitHitsInText：代码里的拆段写法命中，且行号正确', () => {
  const src = "const a = 1;\nconst b = path.join(root, 'services', 'backend', '.env');\n";
  const hits = splitHitsInText(src, '.js');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
  assert.equal(hits[0].remapped, 'runtime/node/backend/.env');
});

test('splitHitsInText：喂 null 不抛（纯叶子纪律）', () => {
  assert.deepEqual(splitHitsInText(null, '.js'), []);
  assert.deepEqual(splitHitsInText(undefined, '.js'), []);
});

test('splitHitsInText：空串不抛', () => {
  assert.deepEqual(splitHitsInText('', '.js'), []);
});

// ── 回归锁：本次修好的 5 个文件保持 0 命中 ────────────────────────────────
// 2026-10-04：桌面端 host 的 8 条 backend 加载路径全是旧路径 `services/backend/**`，
// 而该目录在 HEAD 已不存在（迁移漏改 + 守卫盲区）。修完在这里上锁。
const FIXED_FILES = [
  'apps/khyos-desktop/src/host/index.ts',
  'apps/khyos-desktop/src/main/index.ts',
  'apps/khyos-desktop/src/main/keyManager/agentWriters.ts',
  'apps/khyos-desktop/src/main/keyManager/proxyStatus.ts',
  'apps/khyos-desktop/out/host/index.js',
  'apps/khyos-desktop/out/main/index.js',
];

test('回归锁：桌面端已修的 6 个文件不得再出现拆段旧路径', () => {
  const offenders = [];
  for (const rel of FIXED_FILES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue; // 产物未构建时跳过，不误判
    const hits = splitHitsInText(fs.readFileSync(abs, 'utf8'), path.extname(rel));
    for (const h of hits) offenders.push(`${rel}:${h.line}  ${h.ref}`);
  }
  assert.deepEqual(offenders, [], '这些文件里又出现了拆段旧路径：\n' + offenders.join('\n'));
});

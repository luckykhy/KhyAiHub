#!/usr/bin/env node
/**
 * check-litter.js — 智能体卫生检查器（S1 观察者）
 *
 * 用户裁决（2026-11-19）：仓库不再使用 junction/symlink。本检查器替身
 * `python scripts/maintenance/organize.py --check`（本机无 Python 解释器，
 * Microsoft Store 残桩不可用），以 Node 实现同一职责：
 *   a) 根目录白名单外条目 + 影子数据家（复用 check-repo-layout.js 导出的纯函数）
 *   b) 全仓 reparse point（junction/symlink）
 *   c) T4 与生成目录之外的 .tmp-* / tmp-* / _tmp* 临时名
 *
 * S1 铁律（PROCESS-008）：恒 exit 0，只记录不阻断。
 *
 * 口径说明：根级「碎片名文件」由 check-repo-layout 的 root-junk 签名负责
 * （ROOT_JUNK_FILE_RES），本器不重复；全树层名的碎片判定噪声过大
 * （合法名如 "KhyOS Desktop (1).exe" 会误伤），故只保留 .tmp-* 这一
 * 高精度签名，其余交给根级硬闸。
 *
 * TMP_NAME 扫描跳过 works/data/ 整个运行时数据区（HK-2 运行时数据只读，
 * `[DESIGN-LAY-003]` §1）：该区由运行时自己写，临时名是它的正常工作方式，
 * 且「应落 T4-transient」这条规则是给源码树的，不是给运行时的——本器只盘点
 * 工作区 litter，不盘点运行时数据，故整区不参与判定。
 */

const fs = require('fs');
const path = require('path');

const GUARD_STAGE = 'S1';
const ROOT = path.resolve(__dirname, '..', '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'dist-electron', 'dist-ts',
  'out', 'win-unpacked', 'unpacked', 'coverage', 'release', '.next', 'vendor', 'third_party', 'flutter']);
const TRANSIENT = path.join(ROOT, 'works', 'data', 'khy', 'T4-transient');
const RUNTIME_DATA = path.join(ROOT, 'works', 'data');
const TMP_NAME_RE = /^\.?tmp[-_.]/i;

// 复用 check-repo-layout 的根级判定。两个函数签名不同，别当同一种用：
//   findRootJunkEntries(entries) —— 吃 Dirent 形数组，返回名字数组
//   checkRootShadowDirs(findings) —— 吃 findings 数组，往里 push，返回 undefined
// 早先统一按 fn(ROOT) 调用，两者都被各自的守卫条件挡成空数组，于是本器对
// 「根上有 .khy 影子树」恒报 0 —— 一个恒绿的检查器比没有检查器更坏。
function rootJunkNames() {
  const g = require('./check-repo-layout.js');
  const entries = fs.readdirSync(ROOT, { withFileTypes: true })
    .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  return g.findRootJunkEntries(entries);
}

function rootShadowDirNames() {
  const g = require('./check-repo-layout.js');
  const sink = [];
  g.checkRootShadowDirs(sink);
  return sink.flatMap((f) => f.full || []);
}

/** 判据拿不到就报出来，不返回空 —— 空 = 「本仓干净」，那是另一个意思。 */
function viaGuard(fn) {
  try {
    return fn();
  } catch (error) {
    findings.push({ kind: 'guard-unavailable', path: fn.name, hint: `复用判据调用失败：${error.message}` });
    return [];
  }
}

function scanLinks() {
  const hits = [];
  (function walk(dir, depth) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      let lst;
      try { lst = fs.lstatSync(full); } catch { continue; }
      let target = '';
      try { target = fs.readlinkSync(full); } catch { /* not a link */ }
      if (lst.isSymbolicLink() || target !== '') {
        hits.push({ path: path.relative(ROOT, full).replace(/\\/g, '/'), target });
      } else if (e.isDirectory() && !SKIP_DIRS.has(e.name) && depth < 8) {
        walk(full, depth + 1);
      }
    }
  })(ROOT, 0);
  return hits;
}

function scanTmpNames() {
  const hits = [];
  (function walk(dir, depth) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (full === TRANSIENT || full.startsWith(TRANSIENT + path.sep)) continue;
      // HK-2 运行时数据只读：works/data 整区不盘点，「应落 T4」只管源码树
      if (full === RUNTIME_DATA || full.startsWith(RUNTIME_DATA + path.sep)) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (depth < 8) walk(full, depth + 1);
      } else if (TMP_NAME_RE.test(e.name)) {
        hits.push(path.relative(ROOT, full).replace(/\\/g, '/'));
      }
    }
  })(ROOT, 0);
  return hits;
}

const findings = [];
for (const name of viaGuard(rootJunkNames)) findings.push({ kind: 'root-junk', path: name, hint: '根目录白名单外残留，隔离进 T4 housekeeping 并留 manifest' });
for (const name of viaGuard(rootShadowDirNames)) findings.push({ kind: 'root-shadow-dir', path: name, hint: 'B8 影子数据家，写入方应走 utils/dataHome 解析器' });
for (const l of scanLinks()) findings.push({ kind: 'junction', path: l.path, target: l.target, hint: '用户裁决禁链接；确认消费方后摘除并记录 mklink 重建命令' });
for (const p of scanTmpNames()) findings.push({ kind: 'tmp-name', path: p, hint: '临时名文件应落 T4-transient/tmp/' });

const result = { stage: GUARD_STAGE, root: path.basename(ROOT), count: findings.length, findings };
console.log(JSON.stringify(result, null, 2));
process.exit(0);

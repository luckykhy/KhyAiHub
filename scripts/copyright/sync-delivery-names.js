#!/usr/bin/env node
/**
 * sync-delivery-names.js —— 把登记全称同步到外部交付包的活文档（Node 版）
 *
 * 为什么重写（2026-10-24）
 * ───────────────────────
 * 原实现是仓外的 Python 脚本 `软著交付/Khy-OS/06_工具/sync_name.py`，**当前跑不起来**：
 * 本机没有任何 Python（`D:\Portable\Python\python.exe` 不存在、PATH 里也没有 `python`/`py`）。
 * 而名称同步是登记材料一致性的第一道关口 —— 全称出现在 5 处（申请表 / 源程序页眉 /
 * 说明书封面 / 软件界面标题 / README）外加交付包内十几份文档的交叉引用，
 * 手工改必然漏一处，而「名称不一致」是软著补正的高发原因。
 *
 * 本脚本与原 Python 实现同构，但：
 *   · 名称真源改为**仓内** `docs/10_规范/registry/COPYRIGHT.json`（唯一真源，见
 *     `scripts/copyright/repo-contract.md` §1）—— 外部 `registration.json` 降级为导出件；
 *   · 旧名清单从外部 `registration.json` 的 `superseded_names` 读，不写死在代码里；
 *   · 只做字符串替换，**不碰代码语义**；默认 `--check` 只报告，`--apply` 才写盘。
 *
 * ── 白名单式排除（与原 Python 版同源，理由不变）────────────────────────
 * 历史留档（命名候选 A/B/C 体检报告、改名影响面、就绪度体检、命名候选对照、
 * 命名规范核对、页数校准报告、阶段 0 事实确认表）**永不改写** —— 改了就把
 * 「对照证据」变成「错误结论」。这些文件里的旧名是**当时的入参**，是留痕本身。
 *
 * 用法
 * ────
 *   node scripts/copyright/sync-delivery-names.js                 # 报告将要改什么（不写盘）
 *   node scripts/copyright/sync-delivery-names.js --apply         # 执行替换
 *   node scripts/copyright/sync-delivery-names.js --audit         # 复查残留
 *   node scripts/copyright/sync-delivery-names.js --delivery-dir <路径>
 *
 * Exit: 0 成功（--check 下有改动也返回 0，那不是错误）；1 用法/数据错误。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REG_REL = 'docs/10_规范/registry/COPYRIGHT.json';

// ── argv ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const APPLY = has('--apply');
const AUDIT = has('--audit');
const DELIVERY_DIR = path.resolve(
  opt('--delivery-dir', path.resolve(REPO_ROOT, '..', '软著交付', 'Khy-OS'))
);

if (!fs.existsSync(DELIVERY_DIR)) {
  console.error(`交付包目录不存在：${DELIVERY_DIR}`);
  console.error('用 --delivery-dir <路径> 指定。');
  process.exit(1);
}

// ── 永不改写的文件（历史留档 / 自动生成物 / 工具自身）────────────────────
const EXCLUDE_FILES = new Set([
  '00_决策入口.md',
  '00_体检报告/命名候选A_体检_2026-09-20.md',
  '00_体检报告/命名候选A_体检_2026-09-20.json',
  '00_体检报告/命名候选B_体检_2026-09-20.md',
  '00_体检报告/命名候选B_体检_2026-09-20.json',
  '00_体检报告/命名候选C_体检_2026-09-20.md',
  '00_体检报告/命名候选C_体检_2026-09-20.json',
  '00_体检报告/命名候选对照_2026-09-20.md',
  '00_体检报告/命名规范核对_官方原文对照.md',
  '00_体检报告/就绪度体检_2026-09-20.md',
  '00_体检报告/就绪度体检_2026-09-20.json',
  '00_体检报告/改名影响面_2026-09-20.md',
  '00_体检报告/改名影响面_2026-09-20.json',
  '00_体检报告/阶段0_登记事实确认表.md',
  '00_体检报告/页数校准报告.md',
  '05_待办/人工待办清单.md',
  '06_工具/registration.json',
  '06_工具/sync_name.py',
]);

/** 永不改写的目录（生成物 / 临时配置 / 工具源码 / 本机态）。 */
const EXCLUDE_DIRS = new Set([
  '_calib',
  '_chromeprof',
  '.git',
  'node_modules',
  '06_工具',
  '__pycache__',
  '_整档',
]);

/** 目录名以这些前缀开头的（归档目录，如 _archive_2026-10-24_方案A）——一律不改写。 */
const EXCLUDE_DIR_PREFIX = ['_archive', '_归档', '_隔离'];

const TEXT_EXT = new Set(['.md', '.json', '.csv', '.txt']);

// ── 读真源 ──────────────────────────────────────────────────────────────
function readJson(abs) {
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

const reg = readJson(path.join(REPO_ROOT, REG_REL));
const FULL_NAME = (reg.name || '').trim();
if (!FULL_NAME) {
  console.error(`${REG_REL} 缺少 name 字段。`);
  process.exit(1);
}

/** 旧名清单：外部 registration.json 的 superseded_names + previous_placeholder。 */
function legacyNames() {
  const out = [];
  const extRegPath = path.join(DELIVERY_DIR, '06_工具', 'registration.json');
  if (fs.existsSync(extRegPath)) {
    try {
      const ext = readJson(extRegPath);
      for (const n of [].concat(ext.superseded_names || [], ext.previous_placeholder || [])) {
        const s = (n || '').trim();
        if (s && s !== FULL_NAME) out.push(s);
      }
    } catch (e) {
      console.error(`外部 registration.json 不是合法 JSON：${e.message}`);
      process.exit(1);
    }
  }
  return [...new Set(out)];
}

const LEGACY = legacyNames();

function walkTexts() {
  const out = [];
  (function scan(dir, rel) {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.has(e.name)) continue;
        if (EXCLUDE_DIR_PREFIX.some((p) => e.name.startsWith(p))) continue;
        scan(path.join(dir, e.name), childRel);
      } else if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) {
        if (EXCLUDE_FILES.has(childRel)) continue;
        out.push({ abs: path.join(dir, e.name), rel: childRel });
      }
    }
  })(DELIVERY_DIR, '');
  return out.sort((a, b) => a.rel.localeCompare(b.rel, 'zh'));
}

// ── 主流程 ──────────────────────────────────────────────────────────────

if (AUDIT) {
  console.log(`登记全称 = ${FULL_NAME}`);
  console.log(`交付包   = ${DELIVERY_DIR}`);
  console.log('='.repeat(72));
  console.log('【A】活文档残留（这些是「漏改」，应为 0）');
  console.log('='.repeat(72));
  let live = 0;
  for (const f of walkTexts()) {
    let text;
    try {
      text = fs.readFileSync(f.abs, 'utf8');
    } catch {
      continue;
    }
    for (const old of LEGACY) {
      const n = text.split(old).length - 1;
      if (n) {
        live += n;
        console.log(`  ${f.rel}  [${old}] ×${n}`);
      }
    }
  }
  if (!live) console.log('  ✅ 无残留');
  console.log('');
  console.log('='.repeat(72));
  console.log('【B】历史留档 / 生成物中的旧名（**应当保留**，仅供甄别）');
  console.log('='.repeat(72));
  (function scan(dir, rel) {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules' || e.name === '__pycache__') continue;
        scan(path.join(dir, e.name), childRel);
      } else if (TEXT_EXT.has(path.extname(e.name).toLowerCase()) && EXCLUDE_FILES.has(childRel)) {
        let text;
        try {
          text = fs.readFileSync(path.join(dir, e.name), 'utf8');
        } catch {
          continue;
        }
        const n = LEGACY.reduce((acc, old) => acc + (text.split(old).length - 1), 0);
        if (n) console.log(`  ${childRel}  ×${n}`);
      }
    }
  })(DELIVERY_DIR, '');
  process.exit(0);
}

console.log(`登记全称 : ${FULL_NAME}`);
console.log(`交付包   : ${DELIVERY_DIR}`);
console.log(`旧名清单 : ${LEGACY.length ? LEGACY.join(' / ') : '（空 —— 外部 registration.json 没有 superseded_names）'}`);
console.log('-'.repeat(72));

if (!LEGACY.length) {
  console.log('没有旧名可替换。检查外部 06_工具/registration.json 的 superseded_names 字段。');
  process.exit(0);
}

const files = walkTexts();
const changed = [];
let totalHits = 0;
for (const f of files) {
  let text;
  try {
    text = fs.readFileSync(f.abs, 'utf8');
  } catch {
    continue;
  }
  let next = text;
  const hits = [];
  for (const old of LEGACY) {
    const n = next.split(old).length - 1;
    if (n) {
      hits.push(`${old}×${n}`);
      next = next.split(old).join(FULL_NAME);
    }
  }
  if (!hits.length) continue;
  totalHits += hits.length;
  changed.push({ ...f, hits });
  console.log(`${APPLY ? '已改写' : '将改写'}  ${f.rel}   ${hits.join(' + ')}`);
  if (APPLY) fs.writeFileSync(f.abs, next, 'utf8');
}

console.log('-'.repeat(72));
console.log(`${APPLY ? '已改写' : '将改写'} ${changed.length} 份文件 / ${totalHits} 处`);
if (!APPLY && changed.length) {
  console.log('（本次为 --check，未写盘。加 --apply 执行。）');
}

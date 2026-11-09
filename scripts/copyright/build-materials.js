#!/usr/bin/env node
/**
 * build-materials.js —— 软著源程序鉴别材料生成器（Node 版，仓内唯一实现）
 *
 * 为什么重写（2026-10-24）
 * ───────────────────────
 * 原实现是仓外的 Python 脚本（`软著交付/Khy-OS/06_工具/extract_code.py` +
 * `verify_material.py`），三处问题让它**当前根本跑不起来**：
 *
 * ① **运行时缺失**：本机没有任何 Python（`D:\Portable\Python\python.exe` 不存在、
 *    PATH 里也没有 `python`/`py`）。工具链不可执行 = 材料不可再生。
 * ② **路径漂移**：脚本里硬编码的是 2026-09 的旧布局（`platform/khy_platform/cli.py`、
 *    `kernel/boot/boot.asm`、`services/backend/bin/khy.js`）。仓内已于 2026-10 走完
 *    「方案 P」目录物理化，正确路径是 `runtime/substrate/platform/…`、
 *    `runtime/boot/kernel/…`、`runtime/node/backend/…`。旧路径全部落空 → 抽取产空页。
 * ③ **两份选材清单**：`extract_code.py` 里写死一份 FRONT/BACK 常量，仓外
 *    `01_草稿/代码文件选择.json` 又一份，仓内 `COPYRIGHT-MATERIALS.json` 第三份。
 *    三份各改各的，漂移不可避免（2026-09-21 的选材清单里文件路径至今还是旧布局）。
 *
 * 本脚本把「仓内两份登记」变成唯一真源：
 *   · 名称 / 登记版本 ← `docs/10_规范/registry/COPYRIGHT.json`（C-MAT2 真源）
 *   · 两端选材      ← `docs/10_规范/registry/COPYRIGHT-MATERIALS.json`（C-MAT1 真源）
 * 与 `scripts/copyright/repo-contract.md` §1/§2 一致；外部交付包的
 * `06_工具/registration.json` 与 `01_草稿/代码文件选择.json` 降级为**导出件**。
 *
 * ── 排版规格（与原 Python 实现逐条对齐，未改口径）────────────────────────
 *   · 按完整文件抽取（不支持中间行段）
 *   · 去除纯空行；Tab 按 4 空格展开；行尾去空白
 *   · 单行超过 90 显示列时确定性折行（全角按 2 列）
 *   · 可剥离整行注释（不动行尾注释，不改变任何代码语义）
 *   · 可剥离 .vue 的 <style> 块
 *   · 页眉：软件全称 + 登记版本（与申请表一字不差）；每页显式分页 + 自带页眉
 *   · 正文 8pt / 13pt 固定行距，A4，纵向，单面
 *
 * ── 为什么用「显式分页」而不是固定页眉 ──────────────────────────────────
 * 原 Python 实现已实测记录：`.hdr { position: fixed }` 依赖「Chromium 打印时固定
 * 元素每页重复」，该行为**在末页不成立**（实测 29/30 页带页眉）。故每页切成
 * 一个 `<section class="page">` + `break-after: page` → 页数 = 块数（结构保证），
 * 且每块自带页眉（不依赖渲染器行为）。代价是每页行数须保守：实测 A4/8pt/13pt
 * 容量约 56.7 行，取 **55** 安全且 ≥ 官方「每页不少于 50 行」的要求。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node scripts/copyright/build-materials.js --side front --out-dir <交付包目录>
 *   node scripts/copyright/build-materials.js --side back  --out-dir <交付包目录>
 *   node scripts/copyright/build-materials.js --measure          # 只测量选材，不产出
 *   node scripts/copyright/build-materials.js --side front --render-pdf   # 顺带渲染 PDF
 *
 *   默认交付包目录 = 仓库根上溯 1 层的 `软著交付/Khy-OS`（Portable 规约：不硬编码盘符）。
 *
 * Exit: 0 成功；1 用法/数据错误；2 产出未达标（如页数或每页行数不满足硬指标）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const REG_REL = 'docs/10_规范/registry/COPYRIGHT.json';
const MATERIALS_REL = 'docs/10_规范/registry/COPYRIGHT-MATERIALS.json';

// ── 排版常量（与原 Python 实现一致，改动须同步 repo-contract.md）──────────
const WRAP_COLS = 90;
const LINES_PER_PAGE = 55;
const TARGET_PAGES = 30;
const MIN_LINES_PER_PAGE = 50; // 官方《计算机软件著作权登记办法》硬指标

/**
 * 正文行窗口。
 *
 * 显式分页下：块数 = ceil(正文行数 / 55)，要正好 30 块则正文行数 ∈ (1595, 1650]；
 * 末块行数 = 正文行数 − 1595，须 ≥ 官方 50 行 ⇒ **正文行数 ≥ 1645**。
 * 末页标注另占 1 行 ⇒ 源文件正文须落在 **[1644, 1649]**。
 *
 * 为什么不是死钉 1649：钉死就意味着**最后一个文件必然被截断**（截在文件中途）。
 * 允许窗口下沿 1644 是为了让选材能**收在一个完整模块的末尾** —— 审查者读到末页
 * 看到的是「一个文件的结尾 + 结束标注」，而不是「一个函数从中间被切断」。
 */
const MAX_BODY = TARGET_PAGES * LINES_PER_PAGE - 1; // 1649
const MIN_BODY = (TARGET_PAGES - 1) * LINES_PER_PAGE + MIN_LINES_PER_PAGE - 1; // 1644

const COMMENT_STYLE = {
  '.py': 'hash',
  '.sh': 'hash',
  '.c': 'c',
  '.h': 'c',
  '.js': 'c',
  '.mjs': 'c',
  '.cjs': 'c',
  '.asm': 'semi',
  '.s': 'semi',
};

/** 两端末页标注：官方要求「最后一页应是程序的结束页」，且末页必须标注收尾。 */
const END_MARKER = {
  front: '# ================ 源程序至此结束 ================',
  back: '/* ================ 源程序至此结束 ================ */',
};

// ── argv ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const SIDE = opt('--side', '');
const MEASURE = has('--measure');
const RENDER_PDF = has('--render-pdf');
/**
 * 剥离整行注释 —— **默认开**（2026-10-24 人确认的编排口径）。
 * 实测这是唯一能让前后 30 页同时达到「每页 ≥50 行」的做法：保留注释时
 * 前 30 页只有 49.8 行/页、后 30 页 43.6 行/页，均不达标。
 * 它只剥离「整行即注释」的行，不动行尾注释，不改变任何代码语义。
 */
const STRIP_COMMENTS = !has('--keep-comments');
const OUT_DIR = opt('--out-dir', path.resolve(REPO_ROOT, '..', '软著交付', 'Khy-OS'));
const LINES_ARG = Number(opt('--lines', '0')) || 0;
/** 候选选材试算：逗号分隔的仓库相对路径，覆盖登记里的选材（只用于 --measure 评估，不产出正式件）。 */
const FILES_OVERRIDE = opt('--files', '');

if (!MEASURE && !['front', 'back'].includes(SIDE)) {
  console.error('用法：node scripts/copyright/build-materials.js --side front|back [--out-dir <dir>]');
  console.error('      node scripts/copyright/build-materials.js --measure');
  process.exit(1);
}

// ── 读取登记真源 ────────────────────────────────────────────────────────
function readJson(rel) {
  const p = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(p)) {
    console.error(`缺少登记真源：${rel}`);
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`${rel} 不是合法 JSON：${e.message}`);
    process.exit(1);
  }
}

const reg = readJson(REG_REL);
const materials = readJson(MATERIALS_REL);

const NAME = (reg.name || '').trim();
const VERSION = (reg.version || '').trim();
if (!NAME || !VERSION) {
  console.error(`${REG_REL} 缺少 name 或 version 字段 —— 登记材料不允许自造名称/版本。`);
  process.exit(1);
}
const HEADER = `${NAME} ${VERSION}`;

/** 两端选材条目（{file, ...} 或纯字符串皆可）。 */
function selectionOf(group) {
  const list = materials[group];
  if (!Array.isArray(list) || !list.length) {
    console.error(`${MATERIALS_REL} 的「${group}」为空 —— 选材真源必须有条目。`);
    process.exit(1);
  }
  return list
    .map((it) => (typeof it === 'string' ? { file: it } : it))
    .map((it) => it.file)
    .filter(Boolean);
}

const FRONT_FILES = selectionOf('前30页');
const BACK_FILES = selectionOf('后30页');

/** 候选选材覆盖（仅 --measure 用）：不改登记真源就能试算另一套选材。 */
const OVERRIDE_FILES = FILES_OVERRIDE
  ? FILES_OVERRIDE.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : null;

// ── 行处理（与原 Python 实现逐条对齐）──────────────────────────────────

/** 显示列宽：全角按 2 列，其余按 1 列。 */
function displayWidth(s) {
  let w = 0;
  for (const ch of s) {
    const o = ch.codePointAt(0);
    const wide =
      (o >= 0x1100 && o <= 0x115f) ||
      (o >= 0x2e80 && o <= 0xa4cf) ||
      (o >= 0xac00 && o <= 0xd7a3) ||
      (o >= 0xf900 && o <= 0xfaff) ||
      (o >= 0xfe30 && o <= 0xfe6f) ||
      (o >= 0xff00 && o <= 0xff60) ||
      (o >= 0xffe0 && o <= 0xffe6) ||
      (o >= 0x20000 && o <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

/** 确定性折行：按显示列宽切分，不依赖渲染器的二次换行。 */
function wrapLine(line) {
  if (displayWidth(line) <= WRAP_COLS) return [line];
  const out = [];
  let cur = '';
  let w = 0;
  for (const ch of line) {
    const cw = displayWidth(ch) === 2 ? 2 : 1;
    if (w + cw > WRAP_COLS) {
      out.push(cur);
      cur = '';
      w = 0;
    }
    cur += ch;
    w += cw;
  }
  if (cur) out.push(cur);
  return out;
}

/** 剥离 .vue 的 <style> 块（C-X2：样式块会挤掉有效代码行）。 */
function stripVueStyle(text) {
  return text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '<style>/* [已按 C-MAT 规则剥离 style 块] */</style>');
}

/**
 * 处理单个文件 → { lines, stats }。
 * 注释判定按各语言行首标记识别，不做语义判断：
 *   c    → 整行斜杠星号块 与 双斜杠行，并跟踪跨行块注释
 *   hash → 整行井号
 *   semi → 整行分号
 */
function processFile(rel) {
  const abs = path.join(REPO_ROOT, rel.split('/').join(path.sep));
  if (!fs.existsSync(abs)) {
    return { missing: true, rel, stats: { file: rel, error: 'MISSING' } };
  }
  let raw = fs.readFileSync(abs, 'utf8');
  if (rel.toLowerCase().endsWith('.vue')) raw = stripVueStyle(raw);

  const ext = path.extname(rel).toLowerCase();
  const style = COMMENT_STYLE[ext];

  const stats = { file: rel, raw: 0, blank: 0, comment: 0, code: 0, wrapped: 0 };
  const out = [];
  let inBlock = false;

  for (const rawLine of raw.split('\n')) {
    stats.raw += 1;
    const line = rawLine.replace(/\t/g, '    ').replace(/\s+$/, '');
    const t = line.trim();
    if (t === '') {
      stats.blank += 1;
      continue;
    }
    let isComment = false;
    if (inBlock) {
      isComment = true;
      if (t.includes('*/')) inBlock = false;
    } else if (style === 'c' && t.startsWith('/*')) {
      isComment = true;
      if (!t.includes('*/')) inBlock = true;
    } else if (style === 'c' && t.startsWith('//')) {
      isComment = true;
    } else if (style === 'hash' && t.startsWith('#')) {
      isComment = true;
    } else if (style === 'semi' && t.startsWith(';')) {
      isComment = true;
    }

    if (isComment) {
      stats.comment += 1;
      if (STRIP_COMMENTS) continue;
    } else {
      stats.code += 1;
    }

    const wl = wrapLine(line);
    if (wl.length > 1) stats.wrapped += 1;
    out.push(...wl);
  }
  stats.kept = out.length;
  return { missing: false, rel, lines: out, stats };
}

// ── 产出格式 ────────────────────────────────────────────────────────────

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 显式分页 HTML：每块自带页眉，页数 = 块数。 */
function buildHtmlPaged(sideLabel, header, lines, title, linesPerPage) {
  const chunks = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    chunks.push(lines.slice(i, i + linesPerPage));
  }
  if (!chunks.length) chunks.push([]);
  const secs = chunks
    .map(
      (ch) =>
        '<section class="page">\n' +
        `<div class="hdr"><span class="l">${esc(header)}</span>` +
        `<span class="r">${esc(sideLabel)}</span></div>\n` +
        `<pre class="code">${ch.map(esc).join('\n')}</pre>\n` +
        '</section>'
    )
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  @page { size: A4 portrait; margin: 18mm 14mm 14mm 14mm; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .page { break-after: page; page-break-after: always; }
  .page:last-child { break-after: auto; page-break-after: auto; }
  .hdr {
    display: flex; justify-content: space-between;
    font-family: "SimSun", "Songti SC", serif; font-size: 9pt; color: #000;
    border-bottom: 0.5pt solid #000; padding-bottom: 1mm; margin-bottom: 2mm;
  }
  pre.code {
    font-family: Consolas, "Courier New", monospace;
    font-size: 8pt; line-height: 13pt; color: #000;
    margin: 0; padding: 0; white-space: pre; letter-spacing: 0;
  }
</style></head>
<body>
${secs}
</body></html>`;
}

/** Markdown 草稿格式：页眉注释 + 围栏代码块（末页标注在围栏内最后一行）。 */
function buildMd(header, lines, endMarker) {
  return `<!-- 页眉：${header} -->\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`;
}

// ── PDF 渲染（可选）──────────────────────────────────────────────────────

function findBrowser() {
  // 浏览器路径一律从环境/系统目录推导，不写死盘符：
  //   · KHY_SOFTREG_BROWSER —— 显式指定（开发机上装在别处时用）；
  //   · ProgramFiles / ProgramFiles(x86) —— 系统安装位；
  //   · PATH 上的 chrome / msedge —— 便携安装。
  // 写死 'D:\Portable\...' 这类本机路径会让本仓自己的 no-hardcoded-abs-path
  // 守卫（scripts/ci/check-agent-rules.js）对这个文件报红 —— 提交即 CI 红。
  const candidates = [
    process.env.KHY_SOFTREG_BROWSER,
    process.env.PROGRAMFILES &&
      path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env['PROGRAMFILES(X86)'] &&
      path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.PROGRAMFILES &&
      path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  for (const name of ['chrome', 'msedge', 'chromium']) {
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      const exe = path.join(dir, name + (process.platform === 'win32' ? '.exe' : ''));
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

/**
 * 数 PDF 的页数。
 * 不用 pypdf（本机无 Python）：Chromium 生成的 PDF 把页对象写成
 * `/Type /Page`（区别于页树节点 `/Type /Pages`），直接计数即可。
 * 计数与结构化分页的块数互为交叉验证。
 */
function countPdfPages(pdfPath) {
  const buf = fs.readFileSync(pdfPath);
  const text = buf.toString('latin1');
  const matches = text.match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : 0;
}

// ── 主流程 ──────────────────────────────────────────────────────────────

function sideLabel(side) {
  return side === 'front' ? '源程序鉴别材料（前 30 页）' : '源程序鉴别材料（后 30 页）';
}

function measure(label, files) {
  const rows = [];
  let totalKept = 0;
  let missing = 0;
  for (const f of files) {
    const r = processFile(f);
    if (r.missing) {
      missing += 1;
      rows.push({ file: f, error: 'MISSING' });
      continue;
    }
    totalKept += r.lines.length;
    rows.push(r.stats);
  }
  return { label, rows, totalKept, missing };
}

if (MEASURE) {
  const groups = OVERRIDE_FILES
    ? [['候选选材（--files 覆盖）', OVERRIDE_FILES]]
    : [
        ['前30页', FRONT_FILES],
        ['后30页', BACK_FILES],
      ];
  for (const [label, files] of groups) {
    const m = measure(label, files);
    console.log(`=== ${label} ===  选中 ${files.length} 个文件，剥离整行注释后可用 ${m.totalKept} 行`);
    for (const r of m.rows) {
      if (r.error) {
        console.log(`  MISSING  ${r.file}`);
        continue;
      }
      const pct = r.raw ? ((r.code / r.raw) * 100).toFixed(1) : '0.0';
      console.log(
        `  ${r.file}  总 ${r.raw} / 空 ${r.blank} / 注释 ${r.comment} / 有效 ${r.code} (${pct}%)` +
          ` → 折行后 ${r.kept} 行`
      );
    }
    const ok = m.totalKept >= MIN_BODY && m.totalKept <= MAX_BODY;
    const verdict = m.missing
      ? `❌ 有 ${m.missing} 个文件缺失`
      : m.totalKept < MIN_BODY
        ? `❌ 素材不足（< ${MIN_BODY} 行）`
        : m.totalKept > MAX_BODY
          ? `⚠ 素材超出窗口 ${MAX_BODY} 行 → 末文件将被截断 ${m.totalKept - MAX_BODY} 行`
          : '✅ 素材充足且不截断（收在完整模块末尾）';
    console.log(
      `  行窗口 ${MIN_BODY}~${MAX_BODY} 行（${TARGET_PAGES} 页 × ${LINES_PER_PAGE} 行，末块 ≥${MIN_LINES_PER_PAGE}）→ ${verdict}`
    );
  }
  process.exit(0);
}

const files = SIDE === 'front' ? FRONT_FILES : BACK_FILES;
const label = sideLabel(SIDE);

const allLines = [];
const reports = [];
let missingFiles = 0;
for (const rel of files) {
  const r = processFile(rel);
  if (r.missing) {
    missingFiles += 1;
    reports.push(r.stats);
    console.error(`  MISSING ${rel}`);
    continue;
  }
  reports.push(r.stats);
  allLines.push(...r.lines);
  if (LINES_ARG && allLines.length >= LINES_ARG) break;
}
if (LINES_ARG) allLines.length = Math.min(allLines.length, LINES_ARG);

if (missingFiles) {
  console.error(
    `❌ 选材有 ${missingFiles} 个文件不存在 —— 登记清单与实际脱节，拒绝产出（先修 ${MATERIALS_REL}）。`
  );
  process.exit(1);
}

if (allLines.length < MIN_BODY) {
  console.error(
    `❌ 素材不足：可用 ${allLines.length} 行 < 下限 ${MIN_BODY} 行` +
      `（${TARGET_PAGES} 页 × ${LINES_PER_PAGE} 行，末块仍须 ≥ ${MIN_LINES_PER_PAGE} 行）。补选材后重跑。`
  );
  process.exit(1);
}

// 取到窗口上限；选材若自然收在完整模块末尾（≤ MAX_BODY），则一个字节都不截断。
let body = allLines.slice(0, MAX_BODY);

/**
 * 截断时回退到「完整语句边界」。
 *
 * 为什么：窗口上限切下去可能落在半截语句上（实测 process.c 被切在
 * `if (target_tid >= 0)` 之后 —— 一个没有分支体的悬空 if）。审查者读到末页
 * 会看到「代码不完整 / 疑似语法错误」，对登记材料是负面观感。
 *
 * 做法：确定性回退 —— 从切点往前找**最后一行以分号或右花括号结尾**的行，
 * 在那里收尾。找不到就保持原切点（宁可有悬空语句，也不砍掉过多正文）。
 */
function backToStatementBoundary(lines, floor) {
  for (let i = lines.length - 1; i >= floor; i -= 1) {
    const t = lines[i].trim();
    if (t.endsWith(';') || t.endsWith('}')) return lines.slice(0, i + 1);
  }
  return lines;
}

if (allLines.length > MAX_BODY) {
  body = backToStatementBoundary(body, MIN_BODY);
}

const endMarker = END_MARKER[SIDE];
const outLines = body.concat([endMarker]);

const pages = Math.ceil(outLines.length / LINES_PER_PAGE);
const lastChunk = outLines.length - (pages - 1) * LINES_PER_PAGE;

const draftDir = path.join(OUT_DIR, '01_草稿');
const calibDir = path.join(draftDir, '_calib');
fs.mkdirSync(calibDir, { recursive: true });

const mdPath = path.join(draftDir, `代码-${SIDE === 'front' ? '前' : '后'}30页.md`);
const htmlPath = path.join(calibDir, `VERIFY_${SIDE}.html`);
const reportPath = path.join(calibDir, `VERIFY_${SIDE}.report.txt`);

fs.writeFileSync(mdPath, buildMd(HEADER, outLines, endMarker), 'utf8');
fs.writeFileSync(
  htmlPath,
  buildHtmlPaged(label, HEADER, outLines, `${HEADER} ${label}`, LINES_PER_PAGE),
  'utf8'
);

const totRaw = reports.reduce((n, r) => n + (r.raw || 0), 0);
const totBlank = reports.reduce((n, r) => n + (r.blank || 0), 0);
const totCmt = reports.reduce((n, r) => n + (r.comment || 0), 0);
const report =
  `side=${SIDE} strip_comments=${STRIP_COMMENTS} lines_arg=${LINES_ARG}\n` +
  `输出物理行数=${outLines.length}\n` +
  `页眉文本=${HEADER}\n` +
  `候选源总行=${totRaw} 其中纯空行=${totBlank} 整行注释=${totCmt}\n` +
  reports.map((r) => '  ' + JSON.stringify(r)).join('\n') +
  '\n';
fs.writeFileSync(reportPath, report, 'utf8');

// ── 可选：渲染 PDF 并交叉验证页数 ───────────────────────────────────────
let pdfResult = null;
if (RENDER_PDF) {
  const browser = findBrowser();
  if (!browser) {
    console.error('⚠ 未找到 Edge/Chrome，跳过 PDF 渲染（结构化分页仍保证页数与页眉）。');
  } else {
    const pdfPath = path.join(calibDir, `VERIFY_${SIDE}.pdf`);
    try {
      if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
    } catch {
      /* 忽略：文件不存在时无所谓 */
    }
    const profileRoot =
      process.env.KHY_SOFTREG_PROFILE_ROOT || path.join(REPO_ROOT, '..', '..', 'WorkBuddyData', '.workbuddy', 'tmp');
    const profile = path.join(profileRoot, 'softreg-prof');
    try {
      fs.mkdirSync(profile, { recursive: true });
    } catch {
      /* 建不出来就沿用默认档案位置 */
    }
    const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');
    try {
      execFileSync(
        browser,
        [
          '--headless=new',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          '--no-pdf-header-footer',
          `--user-data-dir=${profile}`,
          `--print-to-pdf=${pdfPath}`,
          fileUrl,
        ],
        { stdio: 'ignore', timeout: 180000 }
      );
    } catch (e) {
      console.error(`⚠ PDF 渲染失败：${e.message}`);
    }
    if (fs.existsSync(pdfPath)) {
      const pdfPages = countPdfPages(pdfPath);
      pdfResult = { pdfPath, pdfPages };
    }
  }
}

// ── 产出自检（硬指标）────────────────────────────────────────────────────
const problems = [];
if (pages !== TARGET_PAGES) {
  problems.push(`页数 ${pages} ≠ ${TARGET_PAGES}`);
}
if (lastChunk < MIN_LINES_PER_PAGE) {
  problems.push(`末页 ${lastChunk} 行 < 官方要求 ${MIN_LINES_PER_PAGE} 行`);
}
if (pdfResult && pdfResult.pdfPages !== TARGET_PAGES) {
  problems.push(`PDF 实测页数 ${pdfResult.pdfPages} ≠ ${TARGET_PAGES}`);
}

console.log(`[build-materials] side=${SIDE}`);
console.log(`  登记全称+版本 : ${HEADER}`);
console.log(`  选中文件      : ${files.length} 个`);
console.log(`  输出物理行    : ${outLines.length}（正文 ${body.length} + 末页标注 1）`);
console.log(
  `  截断          : ${allLines.length > body.length ? `截掉 ${allLines.length - body.length} 行（末文件被切断）` : '无（选材自然收在完整模块末尾）'}`
);
console.log(`  分页          : ${pages} 页 × 末页 ${lastChunk} 行（每页上限 ${LINES_PER_PAGE}）`);
console.log(`  md            : ${mdPath}`);
console.log(`  html          : ${htmlPath}`);
console.log(`  report        : ${reportPath}`);
if (pdfResult) {
  console.log(`  pdf           : ${pdfResult.pdfPath}（实测 ${pdfResult.pdfPages} 页）`);
}

if (problems.length) {
  console.error(`❌ 产出未达标：${problems.join(' ｜ ')}`);
  process.exit(2);
}
console.log('✅ 硬指标达标：30 页 × 每页 ≥50 行，每页自带页眉。');

#!/usr/bin/env node
'use strict';

/**
 * check-doc-numbers.js — 文档「数值主张」校验（DOCS-007）。
 *
 * ## 为什么需要它
 *
 * DOCS-005 管路径级、_DOCS-006 管端点级；两者都判「在不在」，
 * 不判「是多少」。而文档里最常见的漂移恰恰是数值：
 * `[DESIGN-ARCH-020]` 声称「R1 计数 30 → 28、门禁退出码 0」，
 * 实跑是 R1=9、退出码 1——文档里的每个数字都是错的，而路径全都在。
 *
 * 此前断言「数值类漂移无法机检」，理由是文档只写数字、不写可核对的字面量。
 * **该判断对绝大多数数字成立，但有一类例外**：
 * 文档写下 `<常量名> = <值>` 时，文档与代码说的是**同一个名字**——
 * 这就给了机器一个可逐字比对的锚点。
 *
 * ## 判据（两条，都不执行任何命令）
 *
 *   N1 常量值：文档写 `MAX_GATES = 227`，而代码里 `MAX_GATES` 有唯一确定的值 237
 *   N2 行号：文档写 `check-tui-gates.js:41 MAX_GATES = ...`，
 *             而该常量实际在第 50 行 —— 引用的行号已失效
 *
 * 实测（2026-10-19）：330 份适用范围内文档，83 处「常量名 = 数值」主张，
 * 其中 43 处可判定（代码里同名常量值唯一），**10 处不符，10/10 人工核实为真漂移**。
 *
 * ## 三处刻意的不做
 *
 * 1. **不执行文档里的任何命令。** 文档写 `node scripts/foo.js` 就跑它，
 *    等于让一份文档获得执行权——那不是校验，是攻击面。需执行的读数
 *    （如 archDebtScan 的 R1/R3）须由**白名单注册表**显式登记后才可跑，
 *    不在本条射程。
 * 2. **同名多值不判。** 代码里 `MAX_GATES` 若在两处定义为不同值，
 *    说明它有上下文差异，机器判不出——跳过而不是猜。
 * 3. **布尔型常量不判。** `KHY_X = 1` 表示「开关打开」，不是可比的数值。
 *
 * ## 落地阶段（PROCESS-006 PP-1 / PROCESS-008）
 *
 * `STAGE = 'S1'`：观察者，只记录不阻断，恒 exit 0。
 * 登记在 `FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms[]`（id=`doc-numbers-guard`）。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const STAGE = 'S1';
const OBSERVER_STAGES = new Set(['S1', 'S2']);

const repoRoot = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const listMode = (() => {
  const m = args.find((a) => a.startsWith('--list='));
  return m ? m.slice('--list='.length) : null;
})();

const IN_SCOPE = /^docs\/(03_DESIGN_设计|10_规范)\//;
const EXCLUDE = /(?:^|\/)00_INDEX_|^docs\/10_规范\/规则卡\//;

/**
 * 「举这个问题为例」的文档不是在下承诺。
 * 一份规范文档引用某个过期数值来论证漂移存在，与一份设计文档写下该数值
 * 声称它是当前真值，是两件事。
 *
 * ⚠ 这里**不靠语气词判定**——实测 DOCS-006 与 DOCS-007 两条规范都因此
 *   把自己的例句判成了漂移（表格行里没有「反例」二字，措辞判定漏掉了）。
 *   改用**显式声明式豁免**：文档顶部写一行 `<!-- DOCS-NUMBERS-EXEMPT: 理由 -->`，
 *   该文档的全部数值主张免判。理由必填，可被追责。
 *
 * 这与仓库既有的 `// khy-allow-<规则ID>: <理由>` 抑制同构——
 * 豁免必须是显式且带理由的，不靠机器猜。
 */
const EXEMPT_MARK = /<!--\s*DOCS-NUMBERS-EXEMPT:\s*([^\n>]+?)\s*-->/;

/** 代码侧扫描范围。entries/ 与 bundled/ 是构建产物（LAYOUT-005），
 *  bundle.mjs 单个 17MB、压缩后的常量与源码不是一回事，故排除。 */
const CODE_GLOBS = ['runtime/', 'delivery/', 'apps/', 'scripts/', 'works/ship/', 'tools/'];

function gitGrep(pattern, pathspec) {
  try {
    return execFileSync('git', ['grep', '-I', '-n', '-E', pattern, '--', ...pathspec], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch (e) {
    return e.stdout ? String(e.stdout) : '';
  }
}

// ── 代码侧：常量名 -> [{value, file, line}] ──
const codeConsts = new Map();
const codeRe = /^(.*?):(\d+):\s*(?:export\s+)?(?:const|let|var|final)\s+([A-Z][A-Z0-9_]{2,})\s*=\s*(\d+)\b/;
for (const line of gitGrep('(const|let|var) [A-Z][A-Z0-9_]{2,} = [0-9]+', CODE_GLOBS).split('\n')) {
  if (!line) continue;
  const m = codeRe.exec(line);
  if (!m) continue;
  const [, file, lineNo, name, value] = m;
  if (!codeConsts.has(name)) codeConsts.set(name, []);
  codeConsts.get(name).push({ value: Number(value), file, line: Number(lineNo) });
}

// ── 文档侧：主张 ──
const findings = [];
const stats = { docsScanned: 0, exemptDocs: 0, claims: 0, judgeable: 0, valueMismatch: 0, lineMismatch: 0 };
const raw = gitGrep('[A-Z][A-Z0-9_]{2,} = [0-9]+', ['docs/']);

for (const line of raw.split('\n')) {
  if (!line) continue;
  const dm = /^([^:]+):(\d+):(.*)$/.exec(line);
  if (!dm) continue;
  const [, file, docLine, lineText] = dm;
  if (!IN_SCOPE.test(file) || EXCLUDE.test(file)) continue;
  if (!file.endsWith('.md')) continue;   // docs/ 下还有 .js 探针脚本，不是文档
  const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  if (EXEMPT_MARK.test(text)) {
    stats.exemptDocs += 1;
    continue;
  }
  stats.docsScanned += 1;

  // 逐行判定：文档里「常量名 = 数值」是一行一对的主张，
  // 跨行匹配会把同一文件里所有常量与所有数字两两配对，凭空造出大量假漂移。
  for (const cm of lineText.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b\s*=\s*\**\s*(\d+)/g)) {
    stats.claims += 1;
    const name = cm[1];
    const claimed = Number(cm[2]);
    const cands = codeConsts.get(name);
    if (!cands) continue;
    const uniq = [...new Set(cands.map((c) => c.value))];
    if (uniq.length !== 1) continue;      // 同名多值 → 判不出
    stats.judgeable += 1;
    const actual = uniq[0];
    if (actual === claimed) continue;
    stats.valueMismatch += 1;

    // N2：文档是否同时给了 file:line，且与实际行号不符
    const cited = new RegExp('`?([A-Za-z0-9_./-]+\\.(?:js|mjs|cjs|ts|tsx|py))' + ':(\\d+)').exec(text);
    let lineNote = '';
    if (cited) {
      const citedFile = cited[1];
      const citedLine = Number(cited[2]);
      const hit = cands.find((c) => c.file.endsWith(citedFile));
      if (hit && hit.line !== citedLine) {
        stats.lineMismatch += 1;
        lineNote = `行号亦不符：文档称 ${citedFile}:${citedLine}，实际在第 ${hit.line} 行`;
      }
    }

    findings.push({
      id: 'doc-number-value-mismatch',
      doc: file,
      docLine: Number(docLine),
      constant: name,
      claimed,
      actual,
      codeFile: cands[0].file,
      codeLine: cands[0].line,
      text: text.trim().slice(0, 140),
      lineNote,
    });
  }
}

const report = {
  rule: 'DOCS-007',
  stage: STAGE,
  observer: OBSERVER_STAGES.has(STAGE),
  stats,
  findings,
};

if (listMode) {
  for (const f of report.findings) {
    process.stdout.write(
      `${f.doc}:${f.docLine}  ${f.constant} 文档称 ${f.claimed} / 代码 ${f.actual}  (${f.codeFile}:${f.codeLine})\n`,
    );
    if (f.lineNote) process.stdout.write(`    ${f.lineNote}\n`);
  }
  process.exit(0);
}

if (jsonMode) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  process.stdout.write('文档数值主张校验（DOCS-007 · S1 观察者 · 恒 exit 0）\n');
  process.stdout.write('='.repeat(60) + '\n');
  process.stdout.write(
    `「常量名 = 数值」主张 ${stats.claims} 处，可判定 ${stats.judgeable} 处，不符 ${stats.valueMismatch} 处` +
      `（其中行号亦不符 ${stats.lineMismatch} 处）\n`,
  );
  for (const f of report.findings) {
    process.stdout.write(
      ` - [warning] ${f.doc}:${f.docLine}  ${f.constant} 文档称 ${f.claimed}，代码实为 ${f.actual}` +
        `（${f.codeFile}:${f.codeLine}）\n`,
    );
  }
  process.stdout.write(
    '\n判据为「同名常量的值逐字比对」，不执行文档里的任何命令。S1 观察者：只报告，不阻断。\n',
  );
}

if (OBSERVER_STAGES.has(STAGE)) process.exit(0);
process.exit(report.findings.length > 0 ? 1 : 0);

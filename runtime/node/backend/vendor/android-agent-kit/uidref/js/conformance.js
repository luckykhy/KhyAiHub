#!/usr/bin/env node
/**
 * uidref · JavaScript 一致性测试运行器
 *
 *   node conformance.js vectors/            # 自测 JS 参考实现
 *   node conformance.js vectors/ --verbose  # 打出每个失败用例的差异
 *
 * 与 Python 侧 conformance.py 读同一批向量，因此两边结果可直接对照。
 * 退出码 0 = 全部通过。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('./uidref.js');

function outOf(s) {
  return {
    package: s.package,
    rotation: s.rotation,
    elements: s.elements.map((e) => ({
      ref: e.ref,
      role: e.role,
      label: e.label,
      bounds: e.bounds,
      center: e.center,
      clickable: e.clickable,
      long_clickable: e.long_clickable,
      scrollable: e.scrollable,
      editable: e.editable,
      checked: e.checked,
      disabled: e.disabled,
      password: e.password,
    })),
  };
}

function diff(expect, got) {
  const lines = [];
  if (expect.package !== got.package) lines.push(`package: 期望 ${expect.package} / 实得 ${got.package}`);
  if (expect.rotation !== got.rotation) lines.push(`rotation: 期望 ${expect.rotation} / 实得 ${got.rotation}`);
  const n = Math.max(expect.elements.length, got.elements.length);
  for (let i = 0; i < n; i++) {
    const a = expect.elements[i], b = got.elements[i];
    if (!a) { lines.push(`elements[${i}]: 期望无 / 实得 ${JSON.stringify(b)}`); continue; }
    if (!b) { lines.push(`elements[${i}]: 期望 ${JSON.stringify(a)} / 实得无`); continue; }
    for (const k of Object.keys(a)) {
      const av = JSON.stringify(a[k]), bv = JSON.stringify(b[k]);
      if (av !== bv) lines.push(`elements[${i}].${k}: 期望 ${av} / 实得 ${bv}`);
    }
  }
  return lines;
}

function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const dir = args.find((a) => !a.startsWith('--')) || 'vectors';

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) { console.error(`在 ${dir} 下没找到向量文件`); process.exit(2); }

  let total = 0, failedFiles = 0;
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const errs = [];
    d.cases.forEach((c, i) => {
      total++;
      let got;
      try {
        got = outOf(parse(c.in));
      } catch (e) {
        errs.push(`  case#${i} 抛异常 ${e.code || e.constructor.name}: ${e.message}`);
        return;
      }
      const dd = diff(c.out, got);
      if (dd.length) {
        errs.push(`  case#${i} why=${c.why.slice(0, 44)}`);
        if (verbose) errs.push(...dd.map((l) => '      ' + l));
        else errs.push(...dd.slice(0, 3).map((l) => '      ' + l));
      }
    });
    if (errs.length) {
      failedFiles++;
      console.log(`FAIL ${f} — ${d.title}`);
      errs.forEach((l) => console.log(l));
    } else {
      console.log(`ok   ${f.padEnd(34)} ${d.title}（${d.cases.length} cases）`);
    }
  }

  console.log(`\n向量文件 ${files.length} 个，用例 ${total} 条，失败文件 ${failedFiles} 个`);
  process.exit(failedFiles ? 1 : 0);
}

main();

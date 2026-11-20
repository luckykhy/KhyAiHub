#!/usr/bin/env node
/** JS 侧一致性运行器：node conformance.js ../vectors/ */
'use strict';
const fs = require('fs'), path = require('path');
const { diff } = require('./screendiff.js');

const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'vectors');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
if (!files.length) { console.error(`在 ${dir} 下没找到向量文件`); process.exit(2); }

let total = 0, failedFiles = 0;
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const errs = [];
  d.cases.forEach((c, i) => {
    total++;
    let got;
    try { got = diff(c.in.prev, c.in.cur).to_dict(); }
    catch (e) { errs.push(`case#${i} 抛异常：${e.message}`); return; }
    const exp = c.out;
    for (const k of ['matched', 'added', 'removed', 'is_identical', 'counts']) {
      if (!(k in got)) errs.push(`case#${i} 缺字段 ${k}`);
    }
    if (JSON.stringify(got.matched) !== JSON.stringify(exp.matched)) {
      errs.push(`case#${i} matched 不符\n        期望 ${JSON.stringify(exp.matched)}\n        实得 ${JSON.stringify(got.matched)}`);
    }
    if (JSON.stringify(got.added) !== JSON.stringify(exp.added)) errs.push(`case#${i} added 不符`);
    if (JSON.stringify(got.removed) !== JSON.stringify(exp.removed)) errs.push(`case#${i} removed 不符`);
    if (got.is_identical !== exp.is_identical) errs.push(`case#${i} is_identical 不符`);
    if (JSON.stringify(got.counts) !== JSON.stringify(exp.counts)) {
      errs.push(`case#${i} counts 不符\n        期望 ${JSON.stringify(exp.counts)}\n        实得 ${JSON.stringify(got.counts)}`);
    }
  });
  if (errs.length) { failedFiles++; console.log(`FAIL ${f} — ${d.title}（${d.cases.length} cases）`); errs.forEach(e => console.log('     ', e)); }
  else console.log(`ok   ${f.padEnd(24)} ${d.title}（${d.cases.length} cases）`);
}
console.log(`\n向量文件 ${files.length} 个，用例 ${total} 条，失败文件 ${failedFiles} 个`);
process.exit(failedFiles ? 1 : 0);

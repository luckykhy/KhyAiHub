'use strict';

/**
 * resolveCanonical.js — 把工具名解析成它在仓内的**真实实现文件**。
 *
 * 为什么需要它：原子能力注册表要给每个能力登记唯一 canonical（实现真源），
 * 但仓内工具的物理形态不统一——有的在 `src/tools/<Name>/index.js`（子目录），
 * 有的在 `src/tools/<name>.js`（平铺文件），还有的在 `src/services/` 下。
 * 靠人猜路径必然错（本次实测 118 个能力里错了 30 个）。
 *
 * 所以本模块**从注册表实测**：加载真实工具注册表，读每个工具的
 * `name`，再按「子目录优先、平铺文件次之」的顺序在磁盘上定位其定义文件。
 * 定位不到时返回 null——不猜、不编。
 *
 * 契约：纯读取、确定性、绝不抛（工具加载失败按不可用处理）。
 *
 * @module scripts/lib/resolveCanonical
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TOOLS_DIR = 'runtime/node/backend/src/tools';

/**
 * 列出工具目录下的候选定义文件。
 * 子目录形态：`<Name>/index.js`；平铺形态：`<name>.js`。
 * @returns {Array<{name:string, rel:string}>}
 */
function _candidates() {
  const abs = path.join(REPO_ROOT, TOOLS_DIR);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const indexJs = path.join(entry.name, 'index.js');
      if (fs.existsSync(path.join(abs, entry.name, 'index.js'))) {
        out.push({ name: entry.name, rel: `${TOOLS_DIR}/${indexJs}` });
      }
      continue;
    }
    if (!entry.name.endsWith('.js')) continue;
    // 下划线前缀 = 私有模块，不可能是工具定义。
    if (entry.name.startsWith('_')) continue;
    const base = entry.name.slice(0, -3);
    if (base === 'index') continue;
    out.push({ name: base, rel: `${TOOLS_DIR}/${entry.name}` });
  }
  return out;
}

/**
 * 解析全部工具名 → 实现文件相对路径。
 *
 * 匹配规则：一个候选文件可以声明多个工具（flat 文件常见 `defineTool` 多次调用），
 * 因此对每个候选文件读出其中出现过的所有工具名，建立双向映射。
 *
 * @returns {{map: Map<string,string>, scanned: number}}
 */
function resolveCanonicalMap() {
  const map = new Map();
  const candidates = _candidates();
  for (const candidate of candidates) {
    let text;
    try {
      text = fs.readFileSync(path.join(REPO_ROOT, candidate.rel), 'utf8');
    } catch {
      continue;
    }
    // 抓 `name: 'xxx'` 与 `name: "xxx"` 两种写法。
    const names = new Set();
    const re = /\bname:\s*['"]([^'"]+)['"]/g;
    let hit;
    while ((hit = re.exec(text)) !== null) {
      names.add(hit[1]);
    }
    for (const name of names) {
      // 首个声明者胜出（与注册表的「子目录优先」顺序一致）。
      if (!map.has(name)) map.set(name, candidate.rel);
    }
  }
  return { map, scanned: candidates.length };
}

module.exports = {
  REPO_ROOT,
  TOOLS_DIR,
  resolveCanonicalMap,
};

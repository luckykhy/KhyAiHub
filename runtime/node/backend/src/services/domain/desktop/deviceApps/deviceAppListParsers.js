'use strict';

/**
 * deviceAppListParsers.js — 包管理器 list 原始输出的纯解析叶子(从 deviceAppsPolicy.js 行为保真抽出)。
 *
 * 记录形状:{ name, id, version }。id 为包管理器稳定标识(winget Id / dpkg 包名 / …);无独立
 * id 者令 id === name。解析尽量宽松、绝不抛;无法解析的行跳过。零 IO、确定性、不引用
 * deviceAppsPolicy 的任何符号(无 back-edge、不成环)。deviceAppsPolicy 重新 require 再导出
 * parseListOutput,公共面与抽取前逐字节一致。
 */

// ── list 输出解析器(纯字符串 → 记录)────────────────────────────────────────────
// 记录形状:{ name, id, version }。id 为包管理器稳定标识(winget Id / dpkg 包名 / …);
// 无独立 id 的包管理器令 id === name。解析尽量宽松、绝不抛;无法解析的行跳过。

function _parseDpkg(text) {
  // dpkg -l:数据行以 `ii ` 起(已安装)。列:Desired/Status name version arch desc。
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^ii\s+(\S+)\s+(\S+)/.exec(line);
    if (!m) {
      continue;
    }
    const name = m[1].replace(/:.*/, ''); // 去架构后缀 name:amd64
    out.push({ name, id: name, version: m[2] });
  }
  return out;
}

function _parseBrew(text) {
  // brew list --versions:`name 1.2.3 [1.2.2]`,每行一个;首 token=名,其余为版本。
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    const parts = t.split(/\s+/);
    const name = parts[0];
    if (!name) {
      continue;
    }
    out.push({ name, id: name, version: parts.slice(1).join(' ') || '' });
  }
  return out;
}

function _parsePacman(text) {
  // pacman -Q:`name 1.2.3-1`,每行一个。
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    const parts = t.split(/\s+/);
    if (parts.length < 1) {
      continue;
    }
    out.push({ name: parts[0], id: parts[0], version: parts[1] || '' });
  }
  return out;
}

function _parseChoco(text) {
  // choco list --local-only --limit-output:`name|version`。也宽松兼容空格分隔。
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    if (/packages installed/i.test(t)) {
      continue;
    } // 汇总行
    let name, version;
    if (t.includes('|')) {
      [name, version] = t.split('|');
    } else {
      const parts = t.split(/\s+/);
      name = parts[0];
      version = parts[1] || '';
    }
    name = (name || '').trim();
    if (!name) {
      continue;
    }
    out.push({ name, id: name, version: (version || '').trim() });
  }
  return out;
}

function _parseDnf(text) {
  // dnf list installed:`name.arch  version  repo`。跳过标题行 "Installed Packages"。
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^installed packages/i.test(t)) {
      continue;
    }
    const parts = t.split(/\s+/);
    if (parts.length < 2) {
      continue;
    }
    const name = parts[0].replace(/\.[^.]+$/, ''); // 去 .x86_64 架构
    if (!name) {
      continue;
    }
    out.push({ name, id: parts[0], version: parts[1] });
  }
  return out;
}

// winget 表格按终端「显示列」对齐(CJK 全角占 2 列),而 JS slice 按 UTF-16 码元切。
// 应用名含中文时两种偏移会漂移(实测错位把 "MSIX\" 切进名称列),故列切分必须走显示宽度。
function _isWideCodePoint(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function _displayCols(str) {
  let w = 0;
  for (const ch of str) {
    w += _isWideCodePoint(ch.codePointAt(0)) ? 2 : 1;
  }
  return w;
}

// 取前 cols 个显示列,返回 [已取段, 剩余串]。行不足 cols 列时全部取走。
function _takeCols(line, cols) {
  let w = 0;
  let i = 0;
  while (i < line.length) {
    const cp = line.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = _isWideCodePoint(cp) ? 2 : 1;
    if (w + cw > cols) {
      break;
    }
    w += cw;
    i += ch.length;
  }
  return [line.slice(0, i), line.slice(i)];
}

function _parseWinget(text) {
  // winget list:表格,含标题行 + 分隔线,列宽随内容变化。标题行随系统 locale 本地化:
  // 英文 "Name Id Version Available",中文 "名称 ID 版本 可用"(ID 列不翻译)。
  // 稳健策略:定位标题行的 Id/Version 列起始显示列,按列切;定位失败 → 回退 2+ 空格切分。
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  const isHeader = (l) =>
    /(^|\s)(Name|名称)(\s|$)/.test(l) &&
    /(^|\s)(Id|ID|标识)(\s|$)/.test(l) &&
    /(^|\s)(Version|版本)(\s|$)/.test(l);
  const findCol = (header, tokens) => {
    for (const t of tokens) {
      const i = header.indexOf(t);
      if (i >= 0) return i;
    }
    return -1;
  };
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isHeader(lines[i])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx >= 0) {
    const header = lines[headerIdx];
    const idColU = findCol(header, ['Id', 'ID', '标识']);
    const verColU = findCol(header, ['Version', '版本']);
    if (idColU > 0 && verColU > idColU) {
      const idCol = _displayCols(header.slice(0, idColU));
      const verCol = _displayCols(header.slice(0, verColU));
      for (let i = headerIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) {
          continue;
        }
        if (/^[-─\s]+$/.test(line)) {
          continue;
        } // 分隔线
        const [namePart, rest1] = _takeCols(line, idCol);
        const [idPart, rest2] = _takeCols(rest1, verCol - idCol);
        const name = namePart.trim();
        const id = idPart.trim();
        const version = rest2.trim().split(/\s+/)[0] || '';
        if (!name && !id) {
          continue;
        }
        out.push({ name: name || id, id: id || name, version });
      }
      return out;
    }
  }
  // 回退:无法定位列 → 尽力按 2+ 空格切分(honest best-effort)。
  for (const line of lines) {
    const t = line.trim();
    if (!t || /^[-─\s]+$/.test(t)) {
      continue;
    }
    if (isHeader(t)) {
      continue;
    } // 跳标题(英文/中文 locale)
    const parts = t.split(/\s{2,}/);
    if (parts.length < 2) {
      continue;
    }
    out.push({ name: parts[0], id: parts[1], version: parts[2] || '' });
  }
  return out;
}

const _PARSERS = Object.freeze({
  dpkg: _parseDpkg,
  brew: _parseBrew,
  pacman: _parsePacman,
  choco: _parseChoco,
  dnf: _parseDnf,
  winget: _parseWinget,
});

/**
 * 把某包管理器的 list 原始输出解析为记录数组。解析器缺失/异常 → 返回 [](绝不抛)。
 * @param {string} parserId pm.parse
 * @param {string} text 原始 stdout
 * @returns {Array<{name:string,id:string,version:string}>}
 */
function parseListOutput(parserId, text) {
  const fn = _PARSERS[parserId];
  if (typeof fn !== 'function') {
    return [];
  }
  try {
    return fn(text) || [];
  } catch (_) {
    return [];
  }
}

module.exports = {
  parseListOutput,
};

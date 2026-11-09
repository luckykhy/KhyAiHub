'use strict';

/**
 * atomicCapabilitySurfaces.js — 「原子能力暴露面」抽取器（纯读取，零副作用）。
 *
 * 存在理由：khy-os 的原子能力今天散在 **6 份互不重合的清单**里（§ surfaces）。
 * 每一份都是各自代码的真源，但没有任何一处说明「这 6 份之间是什么关系」，
 * 于是同一个原子能力（读文件、跑命令、开应用…）被各端各写一遍，
 * 二级/三级能力想复用时只能重新实现——这就是项目变大的机制。
 *
 * 本模块只做一件事：**把 6 个暴露面的当前真实工具名抽出来**，交给
 * `check-atomic-capabilities.js` 与注册表对照。它不判定重复、不给建议，
 * 只如实报告「代码里现在到底暴露了什么」。
 *
 * 抽不出来时返回 `{ available: false, reason }` 而不是抛错——
 * 各端代码树有的未入仓（bridge 目录整体未跟踪），守卫必须能在缺面时
 * 降级为 warning 而不是把 CI 拉红。
 *
 * 契约：纯函数（除读文件外无副作用）、确定性、绝不抛。
 *
 * @module scripts/lib/atomicCapabilitySurfaces
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** 暴露面定义：每面一个 id、相对路径、抽取方式。 */
const SURFACE_DEFS = [
  {
    id: 'backend',
    label: '后端工具注册表',
    // 抽取：require 真实注册表，遍历 getAll()
    kind: 'node-registry',
    entry: 'runtime/node/backend/src/tools/index.js',
    // 该面的工具是「模型可调用的原子能力」的主面。
    primary: true,
  },
  {
    id: 'phone-bridge',
    label: 'PC 侧手机桥目录',
    kind: 'node-module',
    entry: 'runtime/node/backend/src/services/domain/network/phone/phoneBridgeCatalog.js',
    // 导出 getPhoneBridgeTools / getPhoneBridgeUiTools
    extract: 'phone-bridge',
  },
  {
    id: 'phone-native',
    label: 'Android 原生 Tools.NAMES',
    kind: 'java-array',
    entry:
      'delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/'
      + 'khy_os_client/bridge/Tools.java',
  },
  {
    id: 'mobile-dart',
    label: '手机端 Dart 内置工具',
    kind: 'dart-tools',
    entry: 'delivery/mobile/khy-os-client-app/lib/core/tools/builtin_tools.dart',
  },
  {
    id: 'amoo-bridge',
    label: 'amoon bridge 契约',
    kind: 'node-module',
    entry: 'delivery/extension/bridges/khy-amoon-bridge/lib/contracts.js',
    extract: 'amoo-bridge',
  },
  {
    id: 'amoo-policy',
    label: 'PC 侧 amoo 桥策略',
    kind: 'node-module',
    entry: 'runtime/node/backend/src/services/domain/network/amoo/amooBridgePolicy.js',
    extract: 'amoo-policy',
  },
];

/**
 * 读一个绝对路径下的文件文本；不存在则返回 null（不抛）。
 * @param {string} relPath 相对仓库根的路径
 * @returns {string|null}
 */
function _readText(relPath) {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
  } catch {
    return null;
  }
}

/**
 * 从 Java `String[] NAMES = { ... }` 里抽出字面量。
 * 只认双引号字符串，避免把注释里的词也算进去。
 * @param {string} text
 * @returns {string[]}
 */
function _extractJavaNames(text) {
  const m = text.match(/String\[\]\s+NAMES\s*=\s*\{([\s\S]*?)\}/);
  if (!m) return [];
  const out = [];
  const re = /"([^"]*)"/g;
  let hit;
  while ((hit = re.exec(m[1])) !== null) {
    const name = hit[1].trim();
    if (name) out.push(name);
  }
  return out;
}

/**
 * 从 Java dispatch 里抽每个工具的参数名。
 *
 * 原生侧没有结构化 schema——它从 `JSONObject a` 里用 `a.optString("cmd", ...)` 逐个取参。
 * 故这里按 `if (tool.equals("<name>"))` 分块，在每块内扫 `a.optXxx("<param>")` 取参数名。
 *
 * 这是**参数存在性**的证据（不推断类型/必填——原生侧没有这个信息，
 * 硬猜会制造假的「接口契约」）。拿不到就诚实留空，由上层标记为「原生面无结构化契约」。
 *
 * @param {string} text
 * @returns {object} 工具名 → { params, risk, category, summary }
 */
function _extractJavaContracts(text) {
  const contracts = {};
  // 以 `tool.equals("xxx")` 为块起点
  const re = /tool\.equals\("([^"]+)"\)/g;
  const starts = [];
  let hit;
  while ((hit = re.exec(text)) !== null) {
    starts.push({ name: hit[1], index: hit.index });
  }
  for (let i = 0; i < starts.length; i += 1) {
    const { name, index } = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1].index : text.length;
    const block = text.slice(index, end);
    const params = [];
    const seen = new Set();
    const pre = /a\.opt(?:String|Int|Long|Boolean|Double)\("([^"]+)"/g;
    let pm;
    while ((pm = pre.exec(block)) !== null) {
      if (seen.has(pm[1])) continue;
      seen.add(pm[1]);
      params.push({
        name: pm[1],
        type: 'unknown',
        required: false,
        description: '',
        constraints: {},
      });
    }
    if (!contracts[name]) {
      contracts[name] = { params, risk: '', category: 'phone-native', summary: '' };
    } else {
      // 同一工具多处分支，参数取并集
      for (const param of params) {
        if (!contracts[name].params.some((p) => p.name === param.name)) {
          contracts[name].params.push(param);
        }
      }
    }
  }
  return contracts;
}

/**
 * 从 Dart `ToolDef(name: 'xxx', ...)` 里抽出工具名。
 * @param {string} text
 * @returns {string[]}
 */
function _extractDartToolNames(text) {
  const out = [];
  const re = /ToolDef\(\s*name:\s*'([^']+)'/g;
  let hit;
  while ((hit = re.exec(text)) !== null) {
    const name = hit[1].trim();
    if (name) out.push(name);
  }
  return out;
}

/**
 * 从 Dart 源码里抽每个 `ToolDef` 的参数契约。
 *
 * Dart 的 `inputSchema` 是 JSON Schema 形态（`{'type':'object','properties':{...}}`），
 * 但源码是 Dart 字面量不是 JSON——单引号、无引号键名、尾部逗号都合法。
 * 故这里用**括号配平**切出每个 ToolDef 块，再从块内解析 properties。
 *
 * 只取「参数名 + 类型 + 是否必填」三项：description 是中文散文，
 * 对「接口能否被复用」这个判断没有帮助，留在 Dart 真源里即可。
 *
 * @param {string} text
 * @returns {object} 工具名 → { params, risk, category, summary }
 */
function _extractDartContracts(text) {
  const contracts = {};
  const marker = /ToolDef\(\s*name:\s*'([^']+)'/g;
  const starts = [];
  let hit;
  while ((hit = marker.exec(text)) !== null) {
    starts.push({ name: hit[1], index: hit.index });
  }

  for (let i = 0; i < starts.length; i += 1) {
    const { name, index } = starts[i];
    // 从 ToolDef( 的括号开始配平，找到该块结尾
    const open = text.indexOf('(', index);
    if (open === -1) continue;
    let depth = 0;
    let end = -1;
    for (let j = open; j < text.length; j += 1) {
      const ch = text.charAt(j);
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end === -1) continue;
    const block = text.slice(index, end);

    // 描述取 description 后第一个字符串字面量
    const descMatch = block.match(/description:\s*(?:'([^']*)'|"([^"]*)")/);
    const summary = descMatch ? (descMatch[1] || descMatch[2] || '') : '';

    // 解析 properties 块里的参数名与类型
    const params = [];
    const propStart = block.indexOf('properties');
    if (propStart !== -1) {
      const propOpen = block.indexOf('{', propStart);
      if (propOpen !== -1) {
        let pDepth = 0;
        let pEnd = -1;
        for (let j = propOpen; j < block.length; j += 1) {
          const ch = block.charAt(j);
          if (ch === '{') pDepth += 1;
          else if (ch === '}') {
            pDepth -= 1;
            if (pDepth === 0) { pEnd = j; break; }
          }
        }
        if (pEnd !== -1) {
          const propBlock = block.slice(propOpen + 1, pEnd);
          // 每个参数：'name': {'type': 'string', ...}
          const paramRe = /'([^']+)'\s*:\s*\{([^{}]*)\}/g;
          let pm;
          while ((pm = paramRe.exec(propBlock)) !== null) {
            const typeMatch = pm[2].match(/'type'\s*:\s*'([^']+)'/);
            params.push({
              name: pm[1],
              type: typeMatch ? typeMatch[1] : 'unknown',
              required: false, // 必填由下面的 required 数组补
              description: '',
              constraints: {},
            });
          }
        }
      }
    }
    // 必填参数来自 `'required': ['a', 'b']`
    const reqMatch = block.match(/'required'\s*:\s*\[([^\]]*)\]/);
    if (reqMatch) {
      const required = new Set();
      const rre = /'([^']+)'/g;
      let rm;
      while ((rm = rre.exec(reqMatch[1])) !== null) required.add(rm[1]);
      for (const param of params) {
        if (required.has(param.name)) param.required = true;
      }
    }

    contracts[name] = { params, risk: '', category: 'mobile-dart', summary };
  }
  return contracts;
}

/**
 * 把「参数契约」归一成一个可比较的形状。
 *
 * 各端的参数写法不统一：
 *   - 后端工具注册表：`inputSchema` 是 `{ paramName: { type, required, description } }`
 *   - 手机桥目录 / amoo 策略：`args` 是 `{ paramName: { type, required, maxLength|maxLen } }`
 *   - amoon bridge 契约：`inputSchema` 是 JSON Schema（`{ type:'object', properties:{...} }`）
 *   - 原生 Java / 手机 Dart：无结构化 schema，只有函数签名
 *
 * 归一后统一为 `{ name, type, required, description, constraints }`，
 * 这样两个面的参数才能**逐字段比对**——这正是判断「同一能力的两套契约是否分叉」的依据。
 *
 * @param {object} raw 单个参数的原始描述
 * @param {string} name 参数名
 * @returns {{name:string,type:string,required:boolean,description:string,constraints:object}}
 */
function normalizeParam(name, raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const constraints = {};
  for (const key of ['maxLength', 'maxLen', 'minimum', 'maximum', 'min', 'max',
    'allowed', 'enum', 'default']) {
    if (src[key] !== undefined) constraints[key] = src[key];
  }
  return {
    name,
    type: String(src.type || 'unknown'),
    required: Boolean(src.required),
    description: String(src.description || ''),
    constraints,
  };
}

/**
 * 从一个 schema 对象里抽出归一后的参数数组。
 * 同时支持两种形状：属性字典（后端/桥目录）与 JSON Schema（amoon bridge）。
 * @param {object} schema
 * @returns {Array<object>}
 */
function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return [];
  // JSON Schema 形态
  if (schema.type === 'object' && schema.properties && typeof schema.properties === 'object') {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    return Object.entries(schema.properties).map(([name, raw]) => {
      const param = normalizeParam(name, raw);
      // JSON Schema 用 required 数组表达必填
      if (required.has(name)) param.required = true;
      return param;
    });
  }
  // 属性字典形态
  return Object.entries(schema).map(([name, raw]) => normalizeParam(name, raw));
}

/**
 * 抽后端工具注册表。走真实 require，拿到的是**运行时真实集合**，
 * 而不是对源码做正则猜测——后者会漏掉 defineTool 之外的注册路径。
 * @returns {{available:boolean, reason?:string, names?:string[], contracts?:object}}
 */
function _extractBackend() {
  const entry = path.join(REPO_ROOT, 'runtime/node/backend/src/tools/index.js');
  let registry;
  try {
    registry = require(entry);
  } catch (error) {
    return { available: false, reason: `无法加载后端工具注册表：${error.message}` };
  }
  let all;
  try {
    all = registry.getAll();
  } catch (error) {
    return { available: false, reason: `后端工具注册表 getAll() 失败：${error.message}` };
  }
  const names = [];
  const contracts = {};
  for (const tool of all.values()) {
    if (tool && typeof tool.name === 'string' && tool.name) {
      names.push(tool.name);
      contracts[tool.name] = {
        params: normalizeSchema(tool.inputSchema),
        risk: String(tool.risk || ''),
        category: String(tool.category || ''),
        summary: String(tool.description || '').split('\n')[0].trim().slice(0, 200),
      };
    }
  }
  return { available: true, names, contracts };
}

/**
 * 抽 PC 侧手机桥目录（桥工具 28 + UI 工具 11）。
 * @returns {{available:boolean, reason?:string, names?:string[], contracts?:object}}
 */
function _extractPhoneBridge() {
  let mod;
  try {
    mod = require(path.join(REPO_ROOT, SURFACE_DEFS[1].entry));
  } catch (error) {
    return { available: false, reason: `无法加载 phoneBridgeCatalog：${error.message}` };
  }
  const names = [];
  const contracts = {};
  const push = (list) => {
    for (const item of list || []) {
      const name = item && item.khyName ? item.khyName : item;
      if (typeof name !== 'string' || !name) continue;
      names.push(name);
      contracts[name] = {
        params: normalizeSchema(item && item.args),
        // 桥目录用 read/actuate 表达「读」还是「改」，映射到统一档位
        risk: item && item.access === 'actuate' ? 'medium' : 'low',
        category: 'phone-bridge',
        summary: String((item && item.summary) || ''),
      };
    }
  };
  try {
    push(mod.getPhoneBridgeTools());
    push(mod.getPhoneBridgeUiTools());
  } catch (error) {
    return { available: false, reason: `phoneBridgeCatalog 读取失败：${error.message}` };
  }
  return { available: true, names, contracts };
}

/**
 * 抽 amoon bridge 契约面（12 个稳定线名）。
 * @returns {{available:boolean, reason?:string, names?:string[], contracts?:object}}
 */
function _extractAmooBridge() {
  let mod;
  try {
    mod = require(path.join(REPO_ROOT, SURFACE_DEFS[4].entry));
  } catch (error) {
    return { available: false, reason: `无法加载 amoon bridge contracts：${error.message}` };
  }
  let names;
  let tools;
  try {
    names = mod.listToolNames();
    tools = mod.TOOLS || [];
  } catch (error) {
    return { available: false, reason: `contracts.listToolNames() 失败：${error.message}` };
  }
  const contracts = {};
  for (const tool of tools) {
    if (!tool || !tool.name) continue;
    contracts[tool.name] = {
      params: normalizeSchema(tool.inputSchema),
      risk: String(tool.risk || ''),
      category: String(tool.side || ''),
      summary: String(tool.description || tool.title || ''),
    };
  }
  return { available: true, names: (names || []).slice(), contracts };
}

/**
 * 抽 PC 侧 amoo 桥策略面（22 个工具名）。
 * @returns {{available:boolean, reason?:string, names?:string[], contracts?:object}}
 */
function _extractAmooPolicy() {
  let mod;
  try {
    mod = require(path.join(REPO_ROOT, SURFACE_DEFS[5].entry));
  } catch (error) {
    return { available: false, reason: `无法加载 amooBridgePolicy：${error.message}` };
  }
  const table = mod.BRIDGE_TOOLS || {};
  const names = Object.keys(table);
  const contracts = {};
  for (const [name, spec] of Object.entries(table)) {
    contracts[name] = {
      params: normalizeSchema(spec && spec.args),
      risk: String((spec && spec.risk) || ''),
      category: 'amoo-policy',
      summary: `readOnly=${Boolean(spec && spec.readOnly)} requiresConfirm=${Boolean(spec && spec.requiresConfirm)}`,
    };
  }
  return { available: true, names, contracts };
}

/**
 * 抽某一面的当前工具名。
 * @param {object} def SURFACE_DEFS 的一项
 * @returns {{available:boolean, reason?:string, names?:string[]}}
 */
function _extractSurface(def) {
  switch (def.kind) {
    case 'node-registry':
      return _extractBackend();
    case 'node-module':
      if (def.extract === 'phone-bridge') return _extractPhoneBridge();
      if (def.extract === 'amoo-bridge') return _extractAmooBridge();
      if (def.extract === 'amoo-policy') return _extractAmooPolicy();
      return { available: false, reason: `未知抽取方式 ${def.extract}` };
    case 'java-array': {
      const text = _readText(def.entry);
      if (text === null) {
        return { available: false, reason: `文件不存在：${def.entry}` };
      }
      return {
        available: true,
        names: _extractJavaNames(text),
        contracts: _extractJavaContracts(text),
      };
    }
    case 'dart-tools': {
      const text = _readText(def.entry);
      if (text === null) {
        return { available: false, reason: `文件不存在：${def.entry}` };
      }
      return {
        available: true,
        names: _extractDartToolNames(text),
        contracts: _extractDartContracts(text),
      };
    }
    default:
      return { available: false, reason: `未知 kind ${def.kind}` };
  }
}

/**
 * 抽取全部暴露面。
 * @param {{repoRoot?:string}} [opts]
 * @returns {{surfaces: Array<object>}}
 */
function extractAllSurfaces() {
  const surfaces = SURFACE_DEFS.map((def) => {
    const result = _extractSurface(def);
    return {
      id: def.id,
      label: def.label,
      entry: def.entry,
      primary: Boolean(def.primary),
      available: Boolean(result.available),
      reason: result.reason || '',
      names: result.available ? result.names : [],
      contracts: result.available ? (result.contracts || {}) : {},
    };
  });
  return { surfaces };
}

module.exports = {
  REPO_ROOT,
  SURFACE_DEFS,
  extractAllSurfaces,
};

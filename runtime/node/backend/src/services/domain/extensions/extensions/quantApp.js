/**
 * quantApp.js — 「谁提供 khyquant 量化应用」的**单一解析点**。
 *
 * 背景（[DESIGN-TOOL-002] §1.5「入向耦合三档」）：khyquant 是全仓最严重的一处
 * **硬入向**——`services/backend/src` 里有 57 个纯 re-export 壳各自写死
 * `require('../../../../delivery/channel/khyquant/<模块>')`，其中 19 个路由壳被
 * `server.js` 在启动期直接 require。后果有两条，第二条是致命的：
 *   1. 核里写死了实现的磁盘层数，57 处各写一遍，下一次移动就要改 57 个地方；
 *   2. 删掉 khyquant 目录，那 19 个 require 在**模块加载期**抛 MODULE_NOT_FOUND，
 *      `server.js` 连启动都失败。那不叫「删目录即卸载」，那叫删目录即整机不可用，
 *      正是 §4.1 要禁的。
 *
 * 本模块把 57 处「点名实现位置」收敛成一处「点名**服务**」：核说它要 `quant-app`，
 * 不说它要 delivery/channel/khyquant 或 delivery/extension/software/khy-quant。谁来满足由 manifest
 * 的 `provides` 声明（§3.4），于是 Phase 1 把目录搬进 delivery/extension/ 时，核**一行都不用改**。
 *
 * 解析顺序（可信度降序，全程不抛，落空返回 null 由调用方按后果决定降级）：
 *   ① provides 契约发现 —— extensionRoots.findProvider() 扫全部根。**这是正路**。
 *   ② 迁移期兜底 —— khyquant 已于 2026-09-24 拆出为独立项目（[DESIGN-ARCH-144] §10），
 *      L4 `software/` 目录已不在，这一支自然落空；保留它作为回滚保险（目录移回即复活）。
 *   ③ 外部独立项目注册 —— 拆分后的常态通道：`KHY_QUANT_APP_DIR` env 直接指定，或
 *      `<dataHome>/quant-app.json` 的 `{ "dir": "..." }`。命中后由应用自带的
 *      `runtime/hostBridge.js` 安装 require 桥（逃逸路径重定向回宿主 + 依赖 fallback）。
 *
 * ## 为什么不直接用 providerModule.requireFromProvider
 *
 * 那个通用解析点把「拓展未安装」与「装了但模块加载抛错」都吞成 null。对交付/诊断
 * 路径够用，对这里不够：一个路由模块里的真 bug 会因此从**启动期大声崩**退化成
 * **静默 404**，而 §3.4 明确要求「拓展未安装」和「装了但坏了」不能报同一句话。
 * 所以本模块自己解析：目录/文件不在 → null（未安装那一档）；文件在而 require 抛错
 * → **照抛**（那是真 bug，吞掉它比崩溃更难查）。
 *
 * @module services/extensions/quantApp
 * @pattern Facade, Strategy
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ensureAiBackendResolvable } = require('../../../../bootstrap/aiBackendModuleResolve');

/** 服务名：核唯一该知道的字符串。按能力取名，不按实现取名（§3.4）。 */
const SERVICE = 'quant-app';

/**
 * 迁移期兜底目录：khyquant 的 L4 现址。
 * 从 `<repo>/services/backend/src/services/domain/extensions/extensions/` 上溯
 * 7 层到仓库根（本文件从 `src/services/delivery/extension/` 迁入此处时深了 2 层，
 * 原先的 5 层计数曾把 L4_DIR 指到 services/backend/software/ 而整级判「未安装」，
 * 2026-09-06 修正 —— [DESIGN-ARCH-078] §10.3）。
 */
const L4_DIR = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', '..', 'software', 'khyquant');

/** 目录解析缓存。`undefined` = 尚未解析；`null` = 解析过且没有。 */
let _dirCache;

/**
 * ③ 外部独立项目注册：khyquant 已拆出仓库（[DESIGN-ARCH-144] §10），宿主经注册
 * 找到它。env `KHY_QUANT_APP_DIR` 优先；其次 `<dataHome>/quant-app.json` 的
 * `{ "dir": "..." }`。注册文件里目录不存在 → 视为未注册（落空保持 null）。
 * @returns {string|null} 绝对路径；未注册 / 目录不在 → null
 */
function resolveExternalDir() {
  const envDir = process.env.KHY_QUANT_APP_DIR;
  if (envDir) {
    try {
      if (fs.statSync(path.resolve(envDir)).isDirectory()) {
        return path.resolve(envDir);
      }
    } catch (_) { /* env 指了个不存在的目录 —— 视为未注册 */ }
    return null; // 显式 env 优先且失效时不落文件注册，避免双通道打架
  }
  try {
    const { getDataHome } = require('../../../../utils/dataHome');
    const reg = path.join(getDataHome(), 'quant-app.json');
    const cfg = JSON.parse(fs.readFileSync(reg, 'utf8'));
    if (cfg && cfg.dir) {
      const dir = path.resolve(cfg.dir);
      if (fs.statSync(dir).isDirectory()) {
        return dir;
      }
    }
  } catch (_) { /* 无注册文件 / 坏 JSON / 目录不在 —— 保持 null */ }
  return null;
}

/**
 * 定位量化应用目录。
 * @returns {string|null} 绝对路径；未安装 / 已删目录 / 已禁用 → null
 */
function resolveDir() {
  if (_dirCache !== undefined) {
    return _dirCache;
  }
  _dirCache = null;

  // ① provides 契约发现（正路）
  try {
    const hit = require('./extensionRoots').findProvider(SERVICE);
    if (hit && hit.dir) {
      _dirCache = hit.dir;
      return _dirCache;
    }
  } catch (_) {
    // 契约模块本身不可用（被裁剪的模块化构建）—— 落到 ②
  }

  // ② 迁移期兜底：目录已随拆分移出仓库，仅在回滚（目录移回）时命中
  try {
    if (fs.statSync(L4_DIR).isDirectory()) {
      _dirCache = L4_DIR;
      return _dirCache;
    }
  } catch (_) {
    // 目录不在 —— 落到 ③
  }

  // ③ 外部独立项目注册（拆分后常态）
  _dirCache = resolveExternalDir();
  return _dirCache;
}

/**
 * 取量化应用里的一个模块。
 *
 * @param {string} rel - 相对应用根的模块路径，如 `'routes/market'` 或 `'models/Trade'`
 * @returns {object|null} require 到的模块；应用未安装 / 该模块不存在 → null。
 *   **模块存在但加载抛错时照抛**，不吞（见模块头「为什么不直接用 requireFromProvider」）。
 */
function loadModule(rel) {
  if (!rel || typeof rel !== 'string') {
    return null;
  }
  const dir = resolveDir();
  if (!dir) {
    return null; // 未安装
  }
  const file = rel.endsWith('.js') ? rel : `${rel}.js`;
  const abs = path.join(dir, file);
  try {
    if (!fs.statSync(abs).isFile()) {
      return null; // 该模块不在这个应用里 —— 同属「未安装」那一档
    }
  } catch (_) {
    return null;
  }
  installHostBridge(dir);
  // quant-app 模块自身的 bare require 不会沿着 backend/node_modules
  // 向上解析。复用打包安装已有的 fallback，使开发树和便携安装都能看到后端依赖。
  ensureAiBackendResolvable();
  return require(abs); // 存在即加载；抛错照抛
}

/** 桥安装去重（跨 loadModule 调用；桥自身也有 installed 幂等位）。 */
let _bridgeInstalledFrom = null;

/**
 * 应用自带宿主桥时（拆分为独立项目后，[DESIGN-ARCH-144] §10）先安装再加载：
 * 把应用内逃逸出项目根的相对 require 重定向回宿主仓原址，并注入宿主依赖 fallback。
 * 桥不存在（普通拓展形态）→ 一次 existsSync 的开销，行为不变。fail-soft：桥加载
 * 或安装抛错不阻断模块加载本身 —— 那类错误由模块自己的 require 在下一行如实暴露。
 */
function installHostBridge(dir) {
  if (_bridgeInstalledFrom === dir) {
    return;
  }
  _bridgeInstalledFrom = dir;
  try {
    const bridge = path.join(dir, 'runtime', 'hostBridge.js');
    if (fs.existsSync(bridge)) {
      const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', '..');
      require(bridge).install({ appDir: dir, repoRoot });
    }
  } catch (_) { /* fail-soft：桥坏了不掩盖模块本身的加载结果 */ }
}

/** 清缓存（仅供测试）。 */
function __resetCache() {
  _dirCache = undefined;
}

module.exports = { SERVICE, loadModule, resolveDir, resolveExternalDir, __resetCache };

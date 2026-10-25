'use strict';

/**
 * 写入编排 —— [DESIGN-ARCH-189] P5。
 *
 * 顺序固定：**备份 → 写 → 逐键回报**。备份失败则**在写之前**中止——
 * 静默继续写入等于把用户的原文件置于无保护状态，那是最不该静默的一类错误。
 *
 * 本层不重造写者：实际写入走 `ccSwitch/appWriters.js` 的 `applyCardToApp`
 * （它已有 2 个调用方：ccSwitch 的 apiHandlers 与桌面端）。本层只负责
 * 编排 + 备份 + 回读 + 回退。
 *
 * 三个已知不同构点（实测，逐条在代码里处理，不假定同构）：
 *   1. **trae 的 remove() 是位置参数**：`remove(query, {confirmed}, env)`，
 *      而其余 10 个 adapter 都是 `remove({target, confirmed, ...}, env)`。
 *      统一按 options 调会让 trae 把 options 当 query、confirmed 落默认 false
 *      从而拒绝执行。故按 adapter 分派调用形状（RESTORE_STYLES）。
 *   2. **codex 的写者在 D1 侧**：`ccSwitch/codexWriter.js` +
 *      `gateway/adapters/codexAdapter.js`，不在 externalApps 里，
 *      探测返回形状也与 CLI adapter 不同。它的 auth.json 是**销毁性删除**
 *      （codexWriter.js 的 fs.unlinkSync），故它的 backupKeys 有两份
 *      （config.toml + auth.json），编排层分别备份。
 *   3. **coze 的目标按模型分发**：`~/.coze/models/<model>/config.json`，
 *      backupKey 无法静态化。故 coze 本期**不开写**——没有静态 key 就备不了
 *      文件，而不备份就写是 fail-open。
 *
 * 读取侧的回读用 adapter 的 list()/get()（externalApps 的统一接口）。
 * codex 不在 externalApps 里，故其回读能力单独声明。
 */

const { loadCatalog } = require('./catalog');
const { backupManagedFile, backupManagedSet } = require('./backup');
const { applyCardToApp } = require('../ccSwitch/appWriters');

// ── 已知不在 externalApps 统一接口内的 app ─────────────────────────────────
// codex：写者在 ccSwitch/codexWriter.js（D1 侧），externalApps 无对应模块。
const EXTERNAL_ADAPTERS = {
  'claude-code': 'claudeCodeAdapter',
  opencode: 'opencodeAdapter',
  gemini: 'geminiCliAdapter',
  deepseek: 'deepseekTuiAdapter',
  reasonix: 'reasonixAdapter',
  'command-code': 'commandCodeAdapter',
  ycode: 'ycodeAdapter',
  zcode: 'zcodeAdapter',
  openclaw: 'openclawAdapter',
  coze: 'cozeAdapter',
  trae: 'traeAppAdapter',
};

// 只有 trae 是位置参数签名（逐行读过每个 adapter 的 function remove(...)）。
const RESTORE_STYLES = { traeAppAdapter: 'positional' };

// 本期不开写的 app 及原因。不开写 ≠ 静默跳过：调用方会拿到明确的拒绝。
// codex 单独说明：它的受管文件是真的（catalog 里配了两个 backupKey），但写者在
// D1 侧（ccSwitch/codexWriter.js + gateway/adapters/codexAdapter.js），
// externalApps 里没有对应模块，故本期编排层不接它——需要单独的目标解析器。
const WRITE_BLOCKED = {
  codex: '写者在 D1 侧（ccSwitch/codexWriter.js + gateway/adapters/codexAdapter.js），externalApps 无对应模块；本期编排层不接，需单独的目标解析器',
  coze: '目标按模型分发（~/.coze/models/<model>/config.json），backupKey 无法静态化；不备份就写是 fail-open，故本期不开写',
  trae: '无独立 live 配置（configPath 指向 khy-os 自己的 store），写它等于写自己',
  'claude-desktop': '网关接入待裁决（[DESIGN-ARCH-189] §8 D2）',
  'command-code': '只写 env 引用、不落裸密钥，无受管文件可备',
  ycode: '只写 api_key_env 引用，无受管文件可备',
};

function _fail(where, why, code) {
  const err = new Error(`clientApps 写入编排 ${where}：${why}`);
  if (code) err.code = code;
  return err;
}

function _entryFor(appId) {
  const catalog = loadCatalog();
  const entry = catalog.apps.find((a) => a.appId === appId);
  if (!entry) throw _fail('_entryFor', `登记表无此 appId：${appId}`, 'CLIENT_APPS_UNKNOWN_APP_ID');
  return entry;
}

/** 加载 externalApps adapter；不在表内的（codex / claude-desktop）返回 null。 */
function _adapterFor(appId) {
  const mod = EXTERNAL_ADAPTERS[appId];
  if (!mod) return null;
  // eslint-disable-next-line global-require
  return require(`../../network/externalApps/${mod}`);
}

/**
 * 解析某 app 的受管文件清单。
 *
 * 返回 [{ file, backupKey }] —— file 来自 adapter.configPath()（实测解析），
 * backupKey 来自 catalog 的 backupKeys（按序对应）。两者数量不一致即报错：
 * 那说明 catalog 与 adapter 漂移了，此时猜一个对应关系比报错更危险。
 */
function resolveManagedFiles(appId, env = process.env) {
  const entry = _entryFor(appId);
  if (!entry.backupKeys || entry.backupKeys.length === 0) {
    return { appId, files: [], blocked: WRITE_BLOCKED[appId] || entry.backupNote || null };
  }
  const adapter = _adapterFor(appId);
  if (!adapter || typeof adapter.configPath !== 'function') {
    // 配了 backupKeys 但 externalApps 无对应 adapter（codex 即此形状）。
    // **不抛**：这是「本期编排层接不了它」的业务拒绝，抛异常会让路由返 500，
    // 前端当成服务端故障。带理由返回，让 preview 映射成 409。
    return {
      appId,
      files: [],
      blocked: WRITE_BLOCKED[appId] || `配了 backupKeys（${entry.backupKeys.join(',')}）但 externalApps 无对应 adapter`,
    };
  }
  const file = adapter.configPath(env);
  if (!file) {
    // 探测未解析（如 COZE_HOME 未设）。不是错误——但也不能写。
    return { appId, files: [], blocked: 'configPath() 未解析出目标文件（探测失败或未安装）' };
  }
  // 单文件 app：backupKeys 应恰为 1。多文件 app（codex/reasonix）的第二个
  // 文件由各自的 adapter 另行暴露，本期只编排主文件，余者显式标注未覆盖。
  if (entry.backupKeys.length !== 1) {
    return {
      appId,
      files: [{ file, backupKey: entry.backupKeys[0] }],
      partial: `该 app 有 ${entry.backupKeys.length} 个 backupKey，本期只编排主文件；余下 ${entry.backupKeys.length - 1} 个未覆盖`,
    };
  }
  return { appId, files: [{ file, backupKey: entry.backupKeys[0] }] };
}

/**
 * 预览：返回**将要**写入什么，不落盘。
 *
 * 让 UI 能先给用户看 diff 再确认——「不静默」的要求之一。
 */
function previewConfigure({ appId, card, mode = 'proxy' } = {}) {
  let entry;
  try {
    entry = _entryFor(appId);
  } catch (e) {
    // 查询不该抛：未知 appId 是正常的业务拒绝，回 {ok:false} 让路由映射成 409
    // 而不是 500。500 会让前端当成服务端故障。
    return { ok: false, appId, reason: e.message, code: e.code || 'CLIENT_APPS_UNKNOWN_APP_ID' };
  }
  if (WRITE_BLOCKED[appId]) {
    return { ok: false, appId, reason: WRITE_BLOCKED[appId], code: 'CLIENT_APPS_WRITE_BLOCKED' };
  }
  const resolved = resolveManagedFiles(appId);
  if (resolved.blocked) return { ok: false, appId, reason: resolved.blocked, code: 'CLIENT_APPS_TARGET_UNRESOLVED' };
  return {
    ok: true,
    appId,
    name: entry.name,
    mode,
    card: { id: card && card.id, name: card && card.name, baseUrl: card && card.baseUrl },
    targets: resolved.files.map((f) => ({ file: f.file, backupKey: f.backupKey })),
    partial: resolved.partial || null,
  };
}

/**
 * 执行配置：备份 → 写 → 逐键回报。备份失败即在写之前中止。
 *
 * @returns {{ok:boolean, appId, backed:Array, write:object, readBack:Array,
 *            restored:Array, error?:string}}
 */
async function configureApp({ appId, card, mode = 'proxy', key, store } = {}) {
  if (!appId) throw _fail('configureApp', 'appId 必填');
  if (!card) throw _fail('configureApp', 'card 必填');

  const prev = previewConfigure({ appId, card, mode });
  if (!prev.ok) return { ok: false, appId, reason: prev.reason, code: prev.code };

  // ── 1. 备份（写之前） ───────────────────────────────────────────────────
  let backed;
  try {
    backed = backupManagedSet(prev.targets.map((t) => ({ file: t.file, backupKey: t.backupKey })));
  } catch (e) {
    // 备份失败：一个字节都不写。
    return { ok: false, appId, phase: 'backup', error: e.message };
  }
  if (!backed.ok) {
    return { ok: false, appId, phase: 'backup', error: backed.error, restored: backed.restored };
  }

  // ── 2. 写（复用既有写者，不重造） ───────────────────────────────────────
  let write;
  try {
    write = await applyCardToApp(card, appId, { mode, key, store });
  } catch (e) {
    write = { success: false, error: String((e && e.message) || e) };
  }
  if (!write || write.success !== true) {
    // 写失败：从 .prev 还原，让这批写入整体作废。
    const restored = [];
    for (const r of backed.results) {
      if (r.status !== 'backed-up' || !r.prevPath || !r.file) continue;
      try {
        const fs = require('fs');
        if (fs.existsSync(r.prevPath)) {
          fs.copyFileSync(r.prevPath, r.file);
          restored.push(r.file);
        }
      } catch {
        /* 尽力而为 */
      }
    }
    return { ok: false, appId, phase: 'write', error: (write && write.error) || '写入失败', restored };
  }

  // ── 3. 逐键回读 ─────────────────────────────────────────────────────────
  const readBack = readBackKeys(appId, card, mode);

  return {
    ok: true,
    appId,
    backed: backed.results,
    write,
    readBack,
    restored: [],
    partial: prev.partial || null,
  };
}

/**
 * 逐键回读：写完之后重新读目标文件，逐项比对期望值。
 *
 * 判据只有三种，且**不许有第四种**：
 *   [ok]      读到了且与期望一致
 *   [MISSING] 读不到（键不存在 / 文件没写进去）
 *   [DIFF]    读到了但值与期望不同
 * 「写成功就报成功」不算证据——那是本层存在的全部理由。
 */
function readBackKeys(appId, card, mode = 'proxy') {
  const adapter = _adapterFor(appId);
  if (!adapter || typeof adapter.list !== 'function') {
    // codex / claude-desktop：externalApps 无回读面。显式说明，不冒充成功。
    return [{ key: '(whole-file)', status: 'NO-READER', detail: '该 app 不在 externalApps 统一接口内，无逐键回读能力' }];
  }
  let providers;
  try {
    const r = adapter.list();
    providers = (r && r.providers) || [];
  } catch (e) {
    return [{ key: '(whole-file)', status: 'NO-READER', detail: `回读失败：${e.message}` }];
  }
  const wantName = String((card && card.name) || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const wantModel = card && card.model;
  const hit = providers.find((p) => p && String(p.name || p.id || '').toLowerCase() === wantName);
  if (!hit) {
    return [{ key: wantName || '(provider)', status: 'MISSING', detail: '回读未找到刚写入的 provider' }];
  }
  const out = [{ key: wantName, status: 'ok' }];
  if (wantModel) {
    const got = hit.model || (hit.models && hit.models[0]);
    out.push({ key: 'model', status: got === wantModel ? 'ok' : 'DIFF', want: wantModel, got });
  }
  return out;
}

/**
 * 恢复厂商配置（反向写），然后做零残留检查。
 *
 * remove() 的调用形状按 adapter 分派：trae 是位置参数，其余是解构 options。
 * 统一调用会让 trae 静默失败（confirmed 落默认 false），故必须分开。
 */
function restoreApp({ appId, target } = {}) {
  const adapter = _adapterFor(appId);
  if (!adapter || typeof adapter.remove !== 'function') {
    return { ok: false, appId, reason: '该 app 无反向写能力（不在 externalApps 接口内）' };
  }
  // 模块导出的是对象字面量，没有可用的构造函数名，故按 appId → 模块名查表。
  const modName = EXTERNAL_ADAPTERS[appId];
  const positional = RESTORE_STYLES[modName] === 'positional';

  let r;
  try {
    if (positional) {
      r = adapter.remove(target, { confirmed: true });
    } else {
      r = adapter.remove({ target, confirmed: true });
    }
  } catch (e) {
    return { ok: false, appId, error: String((e && e.message) || e) };
  }
  if (r && r.success === false) {
    return { ok: false, appId, error: r.error || '反向写被拒' };
  }
  return { ok: true, appId, result: r };
}

module.exports = {
  configureApp,
  previewConfigure,
  resolveManagedFiles,
  readBackKeys,
  restoreApp,
  EXTERNAL_ADAPTERS,
  RESTORE_STYLES,
  WRITE_BLOCKED,
};

'use strict';

/**
 * traeAppAdapter — Trae 的 ccSwitch 桥接适配器（DESIGN-ARCH-101 §7 步骤 4）。
 *
 * Trae 与其它外部 app 的形态不同：它**没有一份由我们直接改写的 live 配置文件**，
 * 而是由 khy 的 switch-center 子系统（`cli/handlers/proxySwitchProfiles.js` +
 * `handleProxyTraeSwitch`）把 profile 写进 `~/.khy/trae_switch_profiles.json` 并
 * 同步应用到网关环境（`applyTraeSwitchProfile`）。若在 appWriters 里另起一套写入，
 * 就会出现「同一事实两处落盘」的分叉。
 *
 * 因此本适配器只做**桥接**：把统一的 ccSwitch 适配器契约
 * （`configPath / list / get / add / remove / usable`）委托给既有 switch-center，
 * 保持「写必走正门」——真源仍是 switch-center，本文件不复制其逻辑。
 *
 * 契约同其它 adapter：fail-soft（绝不抛，收敛为 `{success:false,error}`）；
 * `remove` 带 confirmed 闸门；结果回显只给脱敏指纹，绝不回原文 key。
 */

const path = require('path');

const APP = 'trae';

/**
 * switch-center 的 profile 存储文件路径。
 *
 * 真源是 `proxy.js` 里的 `TRAE_SWITCH_STORE_FILE = path.join(KHY_DIR, 'trae_switch_profiles.json')`。
 * 这里 **不 require proxy.js**（那是 2800+ 行的 CLI 宿主，拉起成本高且带副作用），
 * 而是从 dataHome 工具取同一个 KHY_DIR，保持同一落点；这样本模块保持零重依赖。
 */
function configPath(env = process.env) {
  if (env && env.TRAE_SWITCH_STORE_PATH) {
    return env.TRAE_SWITCH_STORE_PATH;
  }
  try {
    const { getDataHome } = require('../../../../utils/dataHome');
    return path.join(getDataHome(), 'trae_switch_profiles.json');
  } catch {
    return '';
  }
}

/**
 * 读取 profile 存储（只读，不拉起 CLI 宿主）。
 * 形状（与 createSwitchStore 的 load 一致）：`{ activeId, profiles: [{id,name,endpoint,key,models,modelMap,...}] }`
 */
function _readStore() {
  const fs = require('fs');
  const file = configPath();
  const empty = { activeId: '', profiles: [] };
  if (!file) {
    return { file: '', store: empty, error: '无法解析 Trae profile 存储路径（dataHome 解析失败）' };
  }
  try {
    if (!fs.existsSync(file)) {
      return { file, store: empty };
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const profiles = Array.isArray(data && data.profiles) ? data.profiles : [];
    return {
      file,
      store: {
        activeId: String((data && data.activeId) || '').trim(),
        profiles: profiles.filter((p) => p && typeof p === 'object' && p.id),
      },
    };
  } catch (e) {
    return { file, store: empty, error: `Trae profile 存储读取失败: ${String((e && e.message) || e)}` };
  }
}

function _maskKey(key) {
  const s = String(key || '');
  if (!s) {
    return '';
  }
  if (s.length <= 10) {
    return '****';
  }
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function _view(p, activeId) {
  return {
    id: p.id,
    name: p.name || p.id,
    endpoint: p.endpoint || '',
    hasKey: Boolean(p.key),
    keyMasked: _maskKey(p.key),
    models: Array.isArray(p.models) ? p.models.slice() : [],
    active: p.id === activeId,
    // 供 importFromTool 推断协议（Trae 只接 OpenAI 兼容入口）
    kind: 'openai',
  };
}

/** 已配置的 Trae 第三方供应商列表（脱敏）。 */
function list(env = process.env) {
  try {
    const { store, error } = _readStore(env);
    if (error) {
      return { success: false, app: APP, providers: [], error };
    }
    return {
      success: true,
      app: APP,
      providers: store.profiles.map((p) => _view(p, store.activeId)),
    };
  } catch (e) {
    return { success: false, app: APP, providers: [], error: String((e && e.message) || e) };
  }
}

/** 按 id 或名称取单个 profile（脱敏）。 */
function get(query, env = process.env) {
  try {
    const { store, error } = _readStore(env);
    if (error) {
      return { success: false, app: APP, error };
    }
    const q = String(query || '').trim().toLowerCase();
    const hit =
      store.profiles.find((p) => String(p.id).toLowerCase() === q) ||
      store.profiles.find((p) => String(p.name || '').toLowerCase() === q);
    if (!hit) {
      return { success: false, app: APP, error: `未找到 Trae 配置: ${query || '(空)'}` };
    }
    return { success: true, app: APP, provider: _view(hit, store.activeId) };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

function _normalizeId(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 新增/更新一个 Trae 供应商 profile，并（默认）激活应用。
 *
 * 委托 switch-center：写入 `trae_switch_profiles.json` 的 `profiles[]`；
 * 与 `handleProxyTraeSwitch` 的 `add` 分支同语义：同名（或同 id）视为更新。
 *
 * @param {{ provider?: string, model?: string, apiKey?: string, endpoint?: string, id?: string, activate?: boolean }} input
 * @returns {{ success: boolean, app: string, error?: string, detail?: object }}
 */
function add({ provider, model, apiKey, endpoint, id, activate } = {}, env = process.env) {
  try {
    const name = String(provider || id || '').trim();
    if (!name && !id) {
      return { success: false, app: APP, error: 'provider (或 id) is required' };
    }
    if (!endpoint) {
      return { success: false, app: APP, error: 'endpoint is required（Trae 需要 OpenAI 兼容入口）' };
    }
    const fs = require('fs');
    const { file, store, error } = _readStore(env);
    if (error) {
      return { success: false, app: APP, error };
    }

    const profileId = _normalizeId(id || name) || `trae-${Date.now().toString(36)}`;
    const modelId = String(model || '').trim();
    const existing =
      store.profiles.find((p) => p.id === profileId) ||
      store.profiles.find(
        (p) => String(p.name || '').trim().toLowerCase() === name.toLowerCase()
      );

    const now = new Date().toISOString();
    const models = modelId
      ? Array.from(new Set([...(existing && existing.models) || [], modelId]))
      : (existing && existing.models) || [];
    const modelMap = { ...((existing && existing.modelMap) || {}) };
    if (modelId) {
      modelMap[modelId] = modelMap[modelId] || modelId;
    }

    const nextProfile = {
      id: existing ? existing.id : profileId,
      name: name || (existing && existing.name) || profileId,
      endpoint: String(endpoint).replace(/\/+$/, ''),
      key: apiKey || (existing && existing.key) || '',
      models,
      modelMap,
      createdAt: (existing && existing.createdAt) || now,
      updatedAt: now,
    };
    const nextProfiles = existing
      ? store.profiles.map((p) => (p.id === existing.id ? nextProfile : p))
      : [...store.profiles, nextProfile];

    const doActivate = activate !== false;
    const next = {
      activeId: doActivate ? nextProfile.id : store.activeId,
      profiles: nextProfiles,
      updatedAt: now,
    };
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf-8');
    }

    return {
      success: true,
      app: APP,
      detail: {
        id: nextProfile.id,
        name: nextProfile.name,
        endpoint: nextProfile.endpoint,
        keyMasked: _maskKey(nextProfile.key),
        models: nextProfile.models.slice(),
        active: doActivate,
        updated: Boolean(existing),
        storeFile: file,
        // 激活应用（applyTraeSwitchProfile 同步网关环境）由 switch-center 在
        // 下一次 `proxy switch-center` 运行时收敛；本适配器只维护 profile 真源，
        // 不在这里重复实现网关侧副作用。
        note: 'profile 已写入；网关侧应用请执行 `khy proxy switch-center use <id> --provider trae` 或 `khy proxy start` 使其生效',
      },
    };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

/**
 * 移除一个 Trae profile（**必须显式 confirmed:true**，与其它 adapter 的删除闸门一致）。
 */
function remove(query, { confirmed = false } = {}, env = process.env) {
  try {
    if (!confirmed) {
      return { success: false, app: APP, error: 'remove requires {confirmed:true}' };
    }
    const fs = require('fs');
    const { file, store, error } = _readStore(env);
    if (error) {
      return { success: false, app: APP, error };
    }
    const q = String(query || '').trim().toLowerCase();
    const hit =
      store.profiles.find((p) => String(p.id).toLowerCase() === q) ||
      store.profiles.find((p) => String(p.name || '').toLowerCase() === q);
    if (!hit) {
      return { success: false, app: APP, error: `未找到 Trae 配置: ${query || '(空)'}` };
    }
    const profiles = store.profiles.filter((p) => p.id !== hit.id);
    const next = {
      activeId: store.activeId === hit.id ? '' : store.activeId,
      profiles,
      updatedAt: new Date().toISOString(),
    };
    if (file) {
      fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf-8');
    }
    return { success: true, app: APP, detail: { removed: hit.id } };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

/** 本机是否具备 Trae 桥接条件（能解析到存储路径即视为可用）。 */
function usable(env = process.env) {
  return Boolean(configPath(env));
}

module.exports = { configPath, list, get, add, remove, usable, APP };

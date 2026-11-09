'use strict';

/**
 * utils/machineIdentity.js — 本机机器身份与比较（纯叶子）。
 *
 * 真源从 cli/hqStore 下沉到共享底座（D3）：机器身份是**跨层共用**的原语——cli 侧的
 * 多机协作租约（hqStore）与 services 侧的 zen 身份派生（services/zenIdentity）都要
 * 同一份取值链。原来真源留在 cli/ 里，于是 services 只能反向 require cli/（R1 分层
 * 倒置），本仓的 archDebtScan 把这条记为架构债。
 *
 * 语义不变：函数体从 cli/hqStore.js 逐字节搬来，调用点行为一致。
 * cli/hqStore.js 改为从本叶子再导出，公开面不变（R4 抽取漂移：真身只留一份）。
 *
 * @module utils/machineIdentity
 */

const os = require('os');

/**
 * 本机稳定标识：`KHY_MACHINE_ID` 优先，否则 hostname。
 * 同一台机器上二者常只差大小写，故所有比较一律走 `sameMachine`。
 */
function machineId(env = process.env) {
  const override = env && env.KHY_MACHINE_ID;
  if (override && String(override).trim()) {
    return String(override).trim();
  }
  try {
    return os.hostname() || 'unknown-machine';
  } catch {
    return 'unknown-machine';
  }
}

/**
 * 机器名大小写不敏感比较。
 *
 * 为什么必须如此：同一台 Windows 机器的 hostname 与显式设置的 `KHY_MACHINE_ID`
 * 常常只差大小写（`2541UGH10NVUR7S` vs `2541ugh10nvur7s`）。字面比较会让这台机器
 * 把自己持有的租约误判成「他机占用」，从而把自己锁死到租约到期为止。
 */
function sameMachine(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

module.exports = { machineId, sameMachine };

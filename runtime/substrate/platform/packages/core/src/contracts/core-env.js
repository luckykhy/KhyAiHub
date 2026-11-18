'use strict';

// KHY_CORE_* 的唯一真源面（CH-2）：键名与默认值只在这一处定义，backend 只从
// @khy/core/contracts/core-env 这个已导出子路径读取。import 期不读 env（零副作用），
// browser-safety 判据要求 readCoreEnv 的函数体首条语句就是 typeof process 守卫。
const CORE_ENV_KEYS = Object.freeze({
  endpoint: 'KHY_CORE_ENDPOINT',
  token: 'KHY_CORE_TOKEN',
  mode: 'KHY_CORE_MODE',
});

const CORE_MODE_VALUES = Object.freeze(['auto', 'embedded', 'attached']);

// embedded server 的绑定主机默认值；端口永远是临时的（locator.json 携带实际值），
// 所以这里不出现端口字面量。该字面量与 check-agent-rules 的白名单同批登记（[DESIGN-ARCH-220] §4.1）。
const DEFAULT_BIND_HOST = '127.0.0.1';

function readCoreEnv(env) {
  if (typeof process === 'undefined' || !process.env) return {};
  const source = env || process.env;
  const out = {};
  if (source[CORE_ENV_KEYS.endpoint]) out.endpoint = source[CORE_ENV_KEYS.endpoint];
  if (source[CORE_ENV_KEYS.token]) out.token = source[CORE_ENV_KEYS.token];
  if (source[CORE_ENV_KEYS.mode]) out.mode = source[CORE_ENV_KEYS.mode];
  return out;
}

module.exports = { CORE_ENV_KEYS, CORE_MODE_VALUES, DEFAULT_BIND_HOST, readCoreEnv };

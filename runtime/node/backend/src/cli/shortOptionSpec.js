'use strict';

/**
 * shortOptionSpec.js — 单字母短旗标的「布尔 / 取值」种子声明表(hci-audit #44,裁决 A)。
 *
 * 背景:parseInput 此前只把 `--x` 解析进 options,单破折号短旗标(`-n`/`-d 2`)原样落 args,
 * 全仓 21 文件 51 处 `options.<单字母>` 读取全部落空——广告了的语法(各 help 文本的
 * `--dry-run, -n`)从未真正可用。
 *
 * 取值还是布尔**没有统一启发式**:调查 44 处 handler 读取后实证——`-n` 在 backup 是布尔
 * (dry-run)而在 repo/gateway 是取值(条数);`-d` 在 project 是取值(深度)而在 autonomy
 * 是布尔(深聊)。故按命令声明,本表即 #43 步骤 2「逐命令选项声明表」的短旗种子:
 *   - 表内命令:按声明的 kind 解析;
 *   - 未声明命令/字母:布尔(保守默认——把取值误判为布尔只会丢默认值,把布尔误判为取值
 *     会把后续位置参数吃掉,后者危害更大)。
 *
 * 门控:KHY_SHORT_OPTION_PARSE(默认开;`0/false/off/no` 关 → 短旗标原样落 args,
 * 逐字节回退历史行为)。
 *
 * @module cli/shortOptionSpec
 */

// kind 表:command(小写、去 -/_)→ { 字母: 'value' | 'bool' }。
// 每条的依据是 handlers/<command>.js 里对 options.<字母> 的实际消费形态(2026-09-28 全量调查)。
const SPEC = {
  // project.js:53/118/203 — parseInt(options.depth || options.d),parseInt(options.nodes || options.n)
  project: { d: 'value', n: 'value', l: 'value', p: 'value' },
  // autonomy.js:108 — (options.deep || options.d) 深聊开关
  autonomy: { d: 'bool' },
  // createFrontend.js:62/77 — options.n 为项目名、options.o 为输出目录
  createfrontend: { n: 'value', o: 'value', h: 'bool' },
  // device.js:98/222 — options.y === true
  device: { y: 'bool' },
  // gateway.js:800/2983-2985 — tail 条数 / project / location / model
  gateway: { n: 'value', p: 'value', l: 'value', m: 'value' },
  // mesh.js:83/84/106 — id / name / from
  mesh: { i: 'value', n: 'value', f: 'value' },
  // persona.js:34/35 — dest 取值,force 布尔
  persona: { d: 'value', f: 'bool' },
  // publish.js:1178/1678/1684/1693 — force/u 布尔,branch/message 取值
  publish: { f: 'bool', u: 'bool', b: 'value', m: 'value' },
  // repo.js:179/244/493/498 — message/limit 取值,force 布尔
  repo: { n: 'value', m: 'value', b: 'value', f: 'bool' },
  // skill.js:98/692/737/602 — refresh/force 布尔,skill/dest 取值
  skill: { r: 'bool', f: 'bool', s: 'value', d: 'value' },
  // testKey.js:151 — timeout
  testkey: { t: 'value' },
  // backup.js:180/226 — dry-run 布尔(restore/prune;-n 严禁吃掉后面的备份集 ID)
  backup: { n: 'bool' },
};

function _normCommand(command) {
  return String(command || '').toLowerCase().replace(/[-_\s]/g, '');
}

/**
 * 解析指定命令下某短旗标的形态。
 * @param {string} command 规范化后的命令名(调用方应先过 aliases 解析)
 * @param {string} letter 单字母(不带破折号)
 * @returns {'value'|'bool'}
 */
function kindFor(command, letter) {
  const entry = SPEC[_normCommand(command)];
  if (!entry) {
    return 'bool';
  }
  return entry[String(letter || '').toLowerCase()] === 'value' ? 'value' : 'bool';
}

/**
 * 门控:KHY_SHORT_OPTION_PARSE(默认开)。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const v = String((env || process.env).KHY_SHORT_OPTION_PARSE || '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

module.exports = { kindFor, isEnabled, SPEC };

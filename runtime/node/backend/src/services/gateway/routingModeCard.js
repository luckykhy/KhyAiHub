'use strict';

/**
 * routingModeCard — 档位卡的磁盘读取层(碰磁盘的动作全部收在这里)。
 *
 * 为什么单独一个文件(见 [DESIGN-ARCH-185] §4 的叶子契约):
 *   守卫 leaf-contract 会拦「自声明纯叶子的文件里引入 fs」——判据是 declaresLeaf(),
 *   即头部「纯叶子」±16 字符窗口内出现「零 IO」契约词,随后又 require(fs) 即 error。
 *   routingMode.js 按该契约保持零 IO,所以磁盘读取必须落在本文件:
 *   本文件**不**自声明为纯叶子,是它的 IO 伴生层,故在此引入 fs 合法。
 *
 * 为什么不让调用方各自读:
 *   档位卡有三条来源(env 内联 > appHome 覆盖 > 仓内文件),路径解析与 fail-soft
 *   语义只该有一份;散到各调用点会出现「读坏一张卡、三处回退不一致」。
 *
 * 契约:
 *   - fail-soft:文件不存在 / 内容非法 → 一律 null,绝不抛,由调用方回退默认档。
 *   - 确定性:同文件内容恒同输出;只读,不写、不删、不改 env。
 */

const fs = require('fs');

/**
 * 读并解析一个 JSON 文件。
 * 文件缺失、不可读、JSON 非法 → 一律 null(fail-soft,不抛)。
 * @param {string} file 绝对路径
 * @returns {object|null}
 */
function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { readJson };

'use strict';

/**
 * ilinkFileDelivery — IlinkDispatcher 的「把工具产出的文件投递到微信」职责簇。
 *
 * 从 ilinkDispatcher.js 拆出的第三簇。它回答一个问题：**SendUserFile 的产物怎么送到人手里**。
 *
 * 为什么值得单独成文件：
 *   它是一段「有副作用、有多种失败面、但**绝不能影响主流程**」的代码。三处失败各有各的
 *   应对（超限 → 报路径；发送失败 → 报路径；读取异常 → 报路径），而顶层还有一层兜底。
 *   这类「失败矩阵」密集的代码最需要独立焦点 —— 埋在主流程里时，任何一次重构都可能
 *   悄悄把某个 catch 拿掉，而后果只是「文件静默不发」。
 *
 * 契约（与拆分前逐字节同构）：
 *   - **整体 fail-soft**：任何异常都只 log.warn，绝不向上抛 —— _deliverFiles 出错
 *     不能影响后续文本回复。
 *   - **逐文件隔离**：单个文件失败仅 log.warn + 文本告知路径，不影响其余文件。
 *   - 只投递 `tool === 'SendUserFile'` 且 `result.success === true` 的条目。
 *   - **投递前先过 ilinkDeliveryGuard**（凭据/密钥类路径一律不出站，见该文件头
 *     「为什么必须先 realpath」）。被拒时必须**回话**，不能静默丢 —— 静默会让模型
 *     换个说法重试，用户看着像工具坏了。
 *   - 读文件前先 stat 判尺寸上限；超限不发，改报「可自取路径」。
 *
 * @param {object} deps
 * @param {object} deps.msg      入站消息（取 channelId/threadId/userId）
 * @param {*}      deps.out      _chatWithWatchdog 的返回（读 out.toolCallLog）
 * @param {object} deps.channel  IlinkChannel（sendImage / sendFile）
 * @param {Function} deps.say    (msg, text) => Promise —— 由 dispatcher 注入其 _say
 * @param {Function} deps.isImageFile (fileName) => boolean
 * @param {object} deps.defaults 常量（ILINK_MAX_FILE_SIZE_BYTES）
 * @param {object} deps.log      logger
 * @returns {Promise<void>}
 */

/**
 * 守卫拒绝时的回话。**必须区分拒绝原因** —— 「路径解析失败」（断链/不存在）和
 * 「命中禁发规则」是两件事，对用户是两条不同的下一步；混成一句就成了含糊状态。
 * @param {string} fileName
 * @param {{rule:string, reason:string}} verdict
 * @returns {string}
 */
function _rejectReason(fileName, verdict) {
  if (verdict.rule === 'resolve-failed') {
    return `文件「${fileName}」投递失败：路径解析失败（${verdict.reason.replace(/^路径解析失败\(?/, '').replace(/\)?$/, '')}）。请确认路径存在后重试，或在本机直接查看。`;
  }
  if (verdict.rule === 'not-a-file' || verdict.rule === 'not-absolute' || verdict.rule === 'empty-path') {
    return `文件「${fileName}」不能投递：${verdict.reason}。请改用本机可读的文件路径。`;
  }
  if (verdict.rule === 'hardlink') {
    // 具名分支，不并进兜底：「同一份字节出现在多处」和「文件名像凭据」对用户是两件事，
    // 后者既无法解释、也没有可执行的下一步。reason 已经带了目录项数与上限，下半句只
    // 给修复动作，不复述问题（规则 2.1）。
    return (
      `文件「${fileName}」不能投递：${verdict.reason}。` +
      '请从它的原始位置投递，或先复制成一份独立文件再发（复制出来的文件只有一个目录项）。'
    );
  }
  return `文件「${fileName}」命中禁发规则（凭据/密钥类路径），已拒绝投递。`;
}
async function deliverFiles(deps = {}) {
  const { msg, out, channel, say, isImageFile, defaults, log } = deps;
  const fs = require('fs');
  const path = require('path');
  const guard = require('./ilinkDeliveryGuard');

  try {
    const logArr = out && Array.isArray(out.toolCallLog) ? out.toolCallLog : null;
    if (!logArr) {
      return;
    }
    if (!channel) {
      return;
    }
    const channelId = msg.channelId || msg.userId;
    const threadId = msg.threadId || '';

    for (const entry of logArr) {
      if (!entry || entry.tool !== 'SendUserFile') {
        continue;
      }
      const result = entry.result;
      if (!result || result.success !== true) {
        continue;
      }
      // 防御性解析文件路径:直接字段 / 则又一层 result 嵌套。
      const filePath = result.file || result.file_path || (result.result && result.result.file);
      if (!filePath) {
        continue;
      }

      const fileName = path.basename(String(filePath));
      try {
        // 闸门在 stat 之前：stat/readFile 都会跟随符号链接，只看调用方给的路径
        // 等于让 `D:\workspace\notes.txt` 链接到 ~/.khyquant/built-in-keys.json
        // 畅通无阻。判定之后一律用 realPath 读，把「判定与读取之间链接被换」
        // 的窗口收到最小（窗口不可能归零，见守卫文件头的边界说明）。
        const verdict = await guard.isDeliverablePath(filePath);
        if (!verdict.ok) {
          // 结构化元数据必须传**单个对象**：winston 只把最后一个对象参数当 meta，
          // 字符串进 splat 后根本不会出现在 console/文件 transport 里（实测
          // `log.warn('m','a','b',1)` 三个标识符全部消失）。只记标识符与判定结果，
          // **不记文件内容**。
          log.warn('ilink: 文件投递被守卫拒绝', {
            fileName,
            path: String(filePath),
            realPath: verdict.realPath || null,
            rule: verdict.rule,
            reason: verdict.reason,
          });
          await say(msg, _rejectReason(fileName, verdict));
          continue;
        }

        const st = await fs.promises.stat(verdict.realPath);
        if (st.size > defaults.ILINK_MAX_FILE_SIZE_BYTES) {
          const limitMb = Math.round(defaults.ILINK_MAX_FILE_SIZE_BYTES / (1024 * 1024));
          const sizeMb = (st.size / (1024 * 1024)).toFixed(1);
          await say(
            msg,
            `文件「${fileName}」太大(${sizeMb}MB,超过上限 ${limitMb}MB),暂不能直接发送。` +
              `你可以到这个路径自取:${filePath}`
          );
          continue;
        }

        const buf = await fs.promises.readFile(verdict.realPath);
        const isImage = isImageFile(fileName);
        const sendRes = isImage
          ? await channel.sendImage(channelId, buf, { threadId, fileName })
          : await channel.sendFile(channelId, buf, { threadId, fileName, fileSize: st.size });

        if (!sendRes || sendRes.ok === false) {
          const reason = (sendRes && sendRes.error) || '未知原因';
          log.warn(`ilink: 文件发送失败(${fileName}):${reason}`);
          await say(msg, `文件「${fileName}」发送失败。你可以到这个路径自取:${filePath}`);
        }
      } catch (err) {
        const reason = (err && err.message) || String(err);
        log.warn(`ilink: 文件投递出错(${fileName}):${reason}`);
        await say(msg, `文件「${fileName}」发送出错。你可以到这个路径自取:${filePath}`).catch(
          () => {}
        );
      }
    }
  } catch (err) {
    // 整体兼底:_deliverFiles 绝不能抛错影响后续文本回复。
    log.warn(`ilink: 文件投递环节异常(已忽略):${(err && err.message) || err}`);
  }
}

module.exports = { deliverFiles };

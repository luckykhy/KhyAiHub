const fs = require('fs');
const path = require('path');

const { BaseTool } = require('../_baseTool');

/**
 * `static risk = 'safe'` 与 `isReadOnly(){return true}` 是**刻意保留**的，别顺手改成 false。
 *
 * 对工具自身而言声明准确：execute 只做 existsSync + statSync，然后回一个路径，
 * 没有任何对外副作用 —— 文件**不**由本工具发出。把「对外投递」变成现实的是微信
 * 投递层（ilinkFileDelivery），授权与路径闸门都在那边：闸门放在**出站点**，
 * 因为那才是副作用真实发生的地方（ilinkFileDelivery 是全仓唯一的投递实现）。
 *
 * 为什么不能改成 false（实测，会掉进一个收不回来的坑）：
 *   isReadOnly=false → intentSchema.js 的动作正则 /(read|glob|grep|list|stat|cat|view|search|get|ls)/
 *   对 'senduserfile' 一个都不匹配 → action=UNKNOWN → resourceClassifier 判 L2；
 *   isExemptible 对 L2 恒 false，permissionCache 不免审，syscallGateway 默认开。
 *   结果不是「多一道确认」，是「确认了也不拦」—— 而 ilink 上 L2 的 typed 确认本就是空转。
 */
class SendUserFileTool extends BaseTool {
  static toolName = 'SendUserFile';
  static category = 'filesystem';
  static risk = 'safe';
  static aliases = ['send_file'];
  static searchHint = 'send file to user download share';
  static shouldDefer = true;

  isReadOnly() {
    return true;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return `Present a file to the user for download or viewing.
Use when the user needs to receive a generated file.
When running on the WeChat (ilink) channel, the file returned by this tool is automatically sent to the user, so once you have located the target file, calling this tool with its file_path is enough to complete the action of "sending the file to the user".`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
        description: { type: 'string', description: 'Description of the file' },
      },
      required: ['file_path'],
    };
  }

  async execute(params) {
    if (!fs.existsSync(params.file_path)) {
      return { error: `File not found: ${params.file_path}` };
    }
    const stat = fs.statSync(params.file_path);
    return {
      success: true,
      file: params.file_path,
      name: path.basename(params.file_path),
      size: stat.size,
      description: params.description || path.basename(params.file_path),
    };
  }
}

module.exports = SendUserFileTool;

const { defineTool } = require('./_baseTool');

/**
 * Human-readable degradation when the khyquant app is absent.
 *
 * `cli/handlers/data` is a re-export shell over quantApp.loadModule(...) and
 * resolves to `null` when khyquant — an INDEPENDENT project that connects to
 * Khy OS, not a built-in part of it — is neither installed nor registered.
 * Destructuring `null` throws a bare TypeError, so report the real cause.
 *
 * @returns {string} message for the { success: false, error } shape
 */
function quantAppMissingMessage() {
  let regFile = '数据目录下的 quant-app.json';
  try {
    const path = require('path');
    const { getDataHome } = require('../utils/dataHome');
    regFile = path.join(getDataHome(), 'quant-app.json');
  } catch {
    /* dataHome unavailable — keep the generic hint */
  }
  return (
    '量化应用 khyquant 未安装或未注册，无法查询行情。' +
    'khyquant 是独立项目，连接 Khy OS 使用，并不是 Khy OS 的内置部分。' +
    '下一步（任选其一）：设置环境变量 KHY_QUANT_APP_DIR=<khyquant 项目目录>，' +
    `或在 ${regFile} 写入 {"dir":"<khyquant 项目目录>"}，然后重试。`
  );
}

module.exports = defineTool({
  name: 'quote',
  description:
    'Fetch the real-time market quote (price, change, volume) for a single stock symbol. ' +
    'Use it for current-price questions; use dataFetch for historical series and search to resolve a name to a symbol first.',
  category: 'data',
  risk: 'safe',
  searchHint: 'stock realtime price market ticker 股票 实时行情 报价 现价',
  isReadOnly: true,
  isConcurrencySafe: true,
  inputSchema: {
    symbol: {
      type: 'string',
      required: true,
      description: 'Exchange-prefixed stock symbol, e.g. "sh600519" or "sz000001".',
      example: 'sh600519',
    },
  },
  async execute(params, context) {
    try {
      const dataHandlers = require('../cli/handlers/data');
      if (!dataHandlers || typeof dataHandlers.handleQuote !== 'function') {
        return { success: false, error: quantAppMissingMessage() };
      }
      const result = await dataHandlers.handleQuote(params.symbol);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});

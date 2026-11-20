'use strict';

/**
 * 页脚/横幅该显示哪个「模型」——只回答一件事：Auto 意图有没有被 getActiveAdapter()
 * 解析出的具体通道覆盖掉。
 *
 * 背景：`GATEWAY_PREFERRED_ADAPTER=auto` 是用户显式选的「自动选型」，但
 * getActiveAdapter() 是**状态展示**函数：它会按 lastVerified / 默认可用通道解析出一个
 * 具体 adapter（auto 不是真实通道，不能拿去生成）。调用方若直接取 `activeModel`，
 * 页脚就把「Auto」显示成上一次成功的某个模型 —— 用户下次启动看到的是另一个模型名，
 * 以为选择被改掉了，实际偏好仍是 auto。
 *
 * 纯叶子：零 IO、确定性、绝不抛。Auto 判定不在这里重做 —— 由调用方用
 * autoModelSelect.isAutoSelection()（唯一真源）算好 `autoIntent` 传进来，本叶子只做
 * 「意图优先于解析结果」的取舍。
 *
 * @param {{activeModel?: string, preferredModel?: string, autoIntent?: boolean}} [input]
 * @returns {string} 'auto' 或具体模型名；全空时仍是 'auto'（与历史兜底一致）
 */
function resolveFooterModel(input = {}) {
  if (input && input.autoIntent === true) {
    return 'auto';
  }
  const active = typeof input?.activeModel === 'string' ? input.activeModel.trim() : '';
  if (active) {
    return active;
  }
  const preferred = typeof input?.preferredModel === 'string' ? input.preferredModel.trim() : '';
  return preferred || 'auto';
}

module.exports = { resolveFooterModel };

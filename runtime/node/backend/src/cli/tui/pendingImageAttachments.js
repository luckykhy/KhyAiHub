'use strict';

// Pure helpers for staged TUI image attachments. UI ids are deliberately kept
// out of the gateway payload; they only make per-item deletion deterministic.
// 同理 name / size 也只是**显示**字段（chip 行要写出「哪一份」），
// toPayload 只挑 base64 + mimeType，载荷与改动前逐字节一致。

const attachmentFormat = require('../attachmentFormat');

function appendAttachment(list, image, id) {
  const source = Array.isArray(list) ? list : [];
  if (!image || typeof image.base64 !== 'string' || !image.base64) {
    return source;
  }
  const safeId = String(id || '').trim();
  if (!safeId || source.some((item) => item && item.id === safeId)) {
    return source;
  }
  const item = {
    id: safeId,
    base64: image.base64,
    mimeType: image.mimeType || 'image/png',
  };
  // 剪贴板位图没有文件名（拿到的是像素，不是路径），此时 name 缺省，由 toDisplay 兜底。
  const name = String(image.name || '').trim();
  if (name) {
    item.name = name;
  }
  const size = Number(image.sizeBytes);
  if (Number.isFinite(size) && size > 0) {
    item.size = size;
  }
  return [...source, item];
}

function removeAttachment(list, id) {
  if (!Array.isArray(list) || !id) {
    return Array.isArray(list) ? list : [];
  }
  const index = list.findIndex((item) => item && item.id === id);
  if (index === -1) {
    return list;
  }
  return [...list.slice(0, index), ...list.slice(index + 1)];
}

function removeLastAttachment(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return Array.isArray(list) ? list : [];
  }
  return list.slice(0, -1);
}

function labels(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((item, index) => ({ id: item && item.id, label: `图${index + 1}` }));
}

function toPayload(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .filter((item) => item && typeof item.base64 === 'string' && item.base64)
    .map(({ base64, mimeType }) => ({ base64, mimeType: mimeType || 'image/png' }));
}

/**
 * 显示面投影：chip 行（AttachmentChips）与提交回显消费的**只读**描述。
 *
 * 与 labels() 的分工：labels() 是「图N」序号（删除提示用，行为不变）；本函数给出
 * 「名字 + 桶 + 字节数」，让 chip 能写出 `[IMG] shot.png`。没有名字时退回 `图N`，
 * 与 labels 同一套序号，避免同一份附件在两个面上叫两个名字。
 *
 * 归一化口径住在 cli/attachmentFormat.toDisplay（inline 路径图与暂存项同一套），
 * 这里只是转发 —— 不再各算一遍。
 *
 * @param {Array<object>} list
 * @returns {Array<{name:string, format:string, size:number}>}
 */
function toDisplay(list) {
  return attachmentFormat.toDisplay(list);
}

module.exports = {
  appendAttachment,
  removeAttachment,
  removeLastAttachment,
  labels,
  toPayload,
  toDisplay,
};

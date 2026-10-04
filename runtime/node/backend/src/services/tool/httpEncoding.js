'use strict';

// [AI-弱模型·照抄] 本文件是**纯叶子**：零 IO（不碰文件系统 / 网络 / 子进程）、确定性
//   （同输入同输出）、绝不抛、可单测。zlib 是纯 CPU 变换，不是 IO。
//
// httpEncoding —— 「出站请求显式不协商压缩 + 响应万一被压缩也能正确解」的单一真源。
//
// ── 为什么显式要 identity ───────────────────────────────────────────────
// 本仓抓页/抓搜索结果此前**完全不发 Accept-Encoding**。按 RFC 7231 §5.3.4，不发该头等于
// “任何内容编码都可接受”，服务器因而**可以合法**回 gzip/br —— 而全仓 tools/ 下**没有任何
// 解压代码**（只有 proxyConfigService 自己的探针解压）。也就是说：只要某个源站无条件压缩，
// 我们就会把二进制当 HTML 解析，产出乱码或空正文（实测搜索里出现的
// “no results parsed from response” 正属这一形态）。
//
// 显式声明 `Accept-Encoding: identity` 把这条不确定性关掉：不协商压缩 → 不需要解压分支
// → 不引入解压依赖（本叶子只用 Node 内建 zlib）。但**光声明不够**：服务端可以不理会它，
// 所以 decodeBody 作为兜底仍然存在 —— 让「对方偏要压缩」退化成一次正确的解压，而不是乱码。
//
// 调用方约定：headers 里**已有的** accept-encoding（大小写任意）不被覆盖 —— 运维/用户显式
// 声明的意图优先于本默认值。

const zlib = require('node:zlib');

/** 我们要的编码：不压缩。 */
const IDENTITY = 'identity';

/** 会被本叶子解开的编码（归一化后的 token）。 */
const DECODABLE = Object.freeze(new Set(['gzip', 'x-gzip', 'deflate', 'br', 'zlib']));

/**
 * 给请求头补上 `Accept-Encoding: identity`。**不覆盖**调用方已声明的值。
 * 返回新对象（不修改入参）。绝不抛。
 *
 * @param {object} [headers]
 * @returns {object}
 */
function withIdentityAcceptEncoding(headers) {
  try {
    const src = headers && typeof headers === 'object' ? headers : {};
    const out = {};
    let declared = false;
    for (const [k, v] of Object.entries(src)) {
      out[k] = v;
      if (String(k).toLowerCase() === 'accept-encoding') {
        declared = true;
      }
    }
    if (!declared) {
      out['Accept-Encoding'] = IDENTITY;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 归一化 Content-Encoding 头：多段（`gzip, br`）取最后一段 —— 按 RFC，编码按声明顺序
 * 依次施加，故解码要逆序；本仓只处理单段，多段时取最后一段并在解码链上如实放弃。
 * @param {string} [contentEncoding]
 * @returns {string} 小写 token，无编码 → ''
 */
function normalizeEncoding(contentEncoding) {
  const raw = String(contentEncoding == null ? '' : contentEncoding)
    .trim()
    .toLowerCase();
  if (!raw || raw === IDENTITY) {
    return '';
  }
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/** 该 Content-Encoding 是否表示“体被压缩过、需要解”。纯函数。 */
function isCompressed(contentEncoding) {
  return DECODABLE.has(normalizeEncoding(contentEncoding));
}

/**
 * 按 Content-Encoding 解开响应体。**绝不抛**：
 *   - 无编码 / identity / 不认识的编码 → 原样返回（不认识时宁可原样交回，也绝不丢数据）；
 *   - 认识但解压失败 → 原样返回（服务端把已解压内容错标 gzip 是常见现实）；
 *   - deflate → 先 inflateSync，失败再试 inflateRawSync（有的服务端发裸 deflate）。
 *
 * @param {Buffer|Uint8Array|string} body
 * @param {string} [contentEncoding] 原始 Content-Encoding 头
 * @returns {Buffer} 解压后（或原样）的 Buffer
 */
function decodeBody(body, contentEncoding) {
  let buf;
  try {
    buf = Buffer.isBuffer(body) ? body : Buffer.from(body == null ? '' : body);
  } catch {
    return Buffer.alloc(0);
  }
  const enc = normalizeEncoding(contentEncoding);
  if (!DECODABLE.has(enc) || buf.length === 0) {
    return buf;
  }
  try {
    if (enc === 'gzip' || enc === 'x-gzip') {
      return zlib.gunzipSync(buf);
    }
    if (enc === 'br') {
      return zlib.brotliDecompressSync(buf);
    }
    // deflate / zlib：先按 zlib 包装解，失败再按裸 deflate 解。
    try {
      return zlib.inflateSync(buf);
    } catch {
      return zlib.inflateRawSync(buf);
    }
  } catch {
    return buf; // 解不开 → 原样返回，绝不丢数据、绝不抛
  }
}

module.exports = {
  IDENTITY,
  DECODABLE,
  withIdentityAcceptEncoding,
  normalizeEncoding,
  isCompressed,
  decodeBody,
};

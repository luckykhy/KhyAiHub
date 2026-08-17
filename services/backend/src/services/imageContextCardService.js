'use strict';

/**
 * imageContextCardService.js — 「图片说明书」IO 编排（[DESIGN-ARCH-163] D1）。
 *
 * 在网关归一 chokepoint 被调用：为每张已归一的图落临时文件、跑本地 OCR
 * （ocrSnippetService，带缓存），经纯叶子 imageContextCard 装配说明书，
 * 追加到 prompt 之后（用户主诉在前，说明卡在后的既有 _appendOcr* 同族位置）。
 *
 * fail-soft 铁律：任何一步失败都返回原 prompt，绝不抛、绝不阻断生成链路。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const envFlagEnabled = require('../utils/envFlagEnabled');

// 与 aiGateway.extractImageOcrDetails 的 maxImages 口径一致：最多 3 张出卡。
const MAX_CARDS = 3;
// 单图本地 OCR 的短 I/O 上限（防挂死的 I/O，非任务硬 kill，RUNTIME-003 合法例外）。
const OCR_TIMEOUT_MS = 5000;
// ── D6 文件卡口径 ──
const MAX_FILE_CARDS = 3;
const FILE_EXCERPT_CHARS = 4000;
const FILE_MAX_BYTES = 20 * 1024 * 1024;
// 单次提取子进程（pdftotext/python）的短 I/O 上限，同 RUNTIME-003 合法例外。
const FILE_TIMEOUT_MS = 8000;

/** D6 文件卡门控：KHY_FILE_CARDS 默认开；关 → 只出图卡，逐字节回到 D1.1 行为。 */
function fileCardsEnabled(env = process.env) {
  return envFlagEnabled(env.KHY_FILE_CARDS, true);
}

function _fileTimeoutMs(env) {
  const raw = Number(env.KHY_FILE_CARD_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1000 && raw <= 15000 ? raw : FILE_TIMEOUT_MS;
}

function _excerptChars(env) {
  const raw = Number(env.KHY_FILE_CARD_EXCERPT_CHARS);
  return Number.isFinite(raw) && raw >= 500 && raw <= 20000 ? raw : FILE_EXCERPT_CHARS;
}

// 路径比对归一：`\` 与 `/`、大小写（win32 视角）不再造成图/文双卡重复。
function _normPath(p) {
  return String(p || '')
    .replace(/\//g, '\\')
    .toLowerCase();
}

/**
 * 按格式路由提取单个文件的正文。任何失败 → 引用卡 + 诚实 failNote（RUNTIME-002.2：
 * 是什么问题 + 用户能做什么），绝不抛。
 */
async function _extractOneFile(refPath, env) {
  const out = { source: refPath, kind: 'other', sizeBytes: undefined, text: '', truncated: false, engine: '', failNote: '' };
  try {
    const resolved = path.resolve(String(refPath).trim());
    let stat = null;
    try {
      stat = fs.statSync(resolved);
    } catch {
      out.failNote = '文件不存在或不可读；确认路径后重试，或让模型用 read 工具再试';
      return out;
    }
    if (!stat.isFile()) {
      out.failNote = '路径不是文件';
      return out;
    }
    out.sizeBytes = stat.size;
    let kind = 'other';
    try {
      kind = require('./aiUploadStore').classifyKind('', resolved);
    } catch {
      /* fail-soft: 'other' → 引用卡 */
    }
    out.kind = kind;

    if (stat.size > FILE_MAX_BYTES) {
      out.failNote = `超过 ${FILE_MAX_BYTES / 1024 / 1024}MB 提取上限，仅登记引用`;
      return out;
    }

    const cap = _excerptChars(env);
    if (kind === 'text' || kind === 'code') {
      const raw = fs.readFileSync(resolved, 'utf8');
      out.engine = '直读';
      out.text = raw.slice(0, cap);
      out.truncated = raw.length > cap;
      return out;
    }
    if (kind === 'document' && /\.pdf$/i.test(resolved)) {
      const svc = require('./documentSnippetService');
      const r = await svc.extractDocumentSnippetAsync(resolved, 'application/pdf', {
        timeoutMs: _fileTimeoutMs(env),
      });
      if (r && r.success && String(r.text || '').trim()) {
        out.engine = `pdf:${r.engine || 'snippet'}`;
        out.text = String(r.text).trim().slice(0, cap);
        out.truncated = String(r.text).trim().length > cap;
      } else {
        out.failNote = `${(r && r.error) || '提取失败'}；可安装 pdftotext（poppler）或让模型用 read 工具读取`;
      }
      return out;
    }
    if (kind === 'document' && /\.docx$/i.test(resolved)) {
      const tmpOut = path.join(os.tmpdir(), `khy-docx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
      try {
        const convert = require('../cli/handlers/convert');
        const r = await convert.runConvert({ input: resolved, to: 'txt', output: tmpOut });
        const produced = (r && r.output) || tmpOut;
        if (r && r.success && fs.existsSync(produced)) {
          const raw = fs.readFileSync(produced, 'utf8');
          out.engine = 'docx:docHelper';
          out.text = raw.trim().slice(0, cap);
          out.truncated = raw.trim().length > cap;
        } else {
          out.failNote = 'docx 提取失败（缺 Python/docHelper）；可运行 khy doctor 检查，或让模型用 read 工具兜底';
        }
      } finally {
        try {
          fs.unlinkSync(tmpOut);
        } catch {
          /* ignore */
        }
      }
      return out;
    }
    out.failNote = '该格式暂无正文提取通道，仅登记引用';
    return out;
  } catch (e) {
    out.failNote = `提取异常: ${String((e && e.message) || e).slice(0, 120)}`;
    return out;
  }
}

/**
 * 从 prompt 原文扫文档/文本路径（D1.1 刻意不剥离的路径正是这里的联系来源），
 * 与图片 label 去重后逐格式提取，最多 MAX_FILE_CARDS 张。
 */
async function _collectFileCards(prompt, images, env) {
  const cards = [];
  let total = 0;
  try {
    const fileLeaf = require('../cli/repl/inlineFileRefs');
    const { extractAllInlineImageIntents } = require('../cli/repl/imageIntent');
    const imagePaths = new Set();
    for (const img of images) {
      if (img && img.label) {
        imagePaths.add(_normPath(img.label));
      }
    }
    try {
      for (const e of extractAllInlineImageIntents(prompt || '')) {
        imagePaths.add(_normPath(e.filePath));
      }
    } catch {
      /* 图片扫描失败不影响文件面 */
    }
    const refs = fileLeaf.extractAllFileReferences(prompt || '').filter((r) => !imagePaths.has(_normPath(r.filePath)));
    total = refs.length;
    for (const ref of refs.slice(0, MAX_FILE_CARDS)) {
      const card = await _extractOneFile(ref.filePath, env);
      card.index = cards.length + 1;
      cards.push(card);
    }
  } catch {
    return { cards: [], total };
  }
  return { cards, total };
}

function _ocrTimeoutMs(env) {
  const raw = Number(env.KHY_IMAGE_CARD_OCR_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 800 && raw <= 30000 ? raw : OCR_TIMEOUT_MS;
}

/**
 * 为单张归一图生成说明书数据（含 OCR）。异常 → 仅出「无转录」卡字段。
 */
async function _describeOne(leaf, imageService, ocrService, img, env) {
  let tmpFile = null;
  try {
    const buf = Buffer.from(String(img.base64 || ''), 'base64');
    if (!buf || buf.length === 0) {
      return null;
    }
    const dims = leaf.readImageDimensions(buf);
    const format = imageService.detectFormat(buf);
    let ocrText = '';
    let ocrConfidence;
    try {
      tmpFile = imageService.saveBase64ToTemp(img.base64, img.mimeType || 'image/png');
      if (tmpFile) {
        const r = await ocrService.extractImageOcrSnippetAsync(tmpFile, img.mimeType || 'image/png', {
          timeoutMs: _ocrTimeoutMs(env),
        });
        if (r && r.success) {
          ocrText = String(r.text || '');
          ocrConfidence = Number.isFinite(Number(r.confidence)) ? Number(r.confidence) : undefined;
        }
      }
    } catch {
      /* OCR 不可用 → 卡内如实标注「未获取」 */
    }
    return {
      source: img.label || img.source || '剪贴板/内联附件',
      sizeBytes: buf.length,
      width: dims ? dims.width : undefined,
      height: dims ? dims.height : undefined,
      format,
      mimeType: img.mimeType,
      scene: leaf.classifyScene({ ocrText }),
      ocrText,
      ocrConfidence,
      downscaledFrom: img.downscaledFrom,
    };
  } catch {
    return null;
  } finally {
    if (tmpFile) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 主入口：门控开时装配本回合附件说明书——图卡（options.images）+ 文件卡
 * （prompt 原文里的 pdf/docx/md/txt/… 路径，D6），追加到 prompt 之后。
 * 任何不满足/失败 → 逐字节返回原 prompt。
 * @param {string} prompt
 * @param {{images?: Array}} options
 * @param {object} [env]
 * @returns {Promise<string>}
 */
async function attachContextCard(prompt, options = {}, env = process.env) {
  try {
    const leaf = require('./imageContextCard');
    if (!leaf.cardEnabled(env)) {
      return prompt;
    }
    const images = Array.isArray(options.images) ? options.images : [];
    // index 锚定归一数组真实下标 → 「图i」与模型收到的第 i 个图片块永不错位。
    const usable = images
      .map((img, idx) => ({ img, idx }))
      .filter((e) => e.img && typeof e.img === 'object' && typeof e.img.base64 === 'string' && e.img.base64.length >= 64)
      .slice(0, MAX_CARDS);
    const cards = [];
    if (usable.length > 0) {
      const imageService = require('./imageService');
      const ocrService = require('./ocrSnippetService');
      for (const { img, idx } of usable) {
        const card = await _describeOne(leaf, imageService, ocrService, img, env);
        if (card) {
          cards.push({ ...card, index: idx + 1 });
        }
      }
    }
    const { cards: fileCards, total: fileTotal } = fileCardsEnabled(env)
      ? await _collectFileCards(prompt, images, env)
      : { cards: [], total: 0 };
    if (cards.length === 0 && fileCards.length === 0) {
      return prompt;
    }
    const text = leaf.buildContextCard(cards, { turnTotal: images.length, fileCards, fileTotal });
    if (!text) {
      return prompt;
    }
    return `${prompt || ''}\n\n${text}`;
  } catch {
    return prompt;
  }
}

module.exports = { attachContextCard, MAX_CARDS, MAX_FILE_CARDS, fileCardsEnabled, _ocrTimeoutMs, _fileTimeoutMs, _excerptChars };

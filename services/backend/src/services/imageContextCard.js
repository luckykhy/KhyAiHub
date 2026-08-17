'use strict';

/**
 * imageContextCard.js — 「图片说明书」纯叶子（[DESIGN-ARCH-163] D1）。
 *
 * 图文混输双轨契约的理解层：图片送网关前，把图的信息用文字钉死——
 * 来源 / 尺寸 / 格式 / 场景判定 / OCR 转录 / 待确认项——不让模型去「猜」。
 * 本文件是**纯**的：零 IO、零环境读取（门控由调用方传值）、绝不抛。
 * IO 编排在 imageContextCardService.js。
 *
 * 场景判据为确定性关键词启发式（指南 §2.2.1 模板 A/B/C），不猜即 unknown，
 * unknown 不出【待确认】以免噪音。
 */

const envFlagEnabled = require('../utils/envFlagEnabled');
// 纯叶 × 纯叶：三段式引导的行渲染复用 D7 叶子（无 IO，门控由编排层决定挂不挂 guide）。
const { guideLines } = require('./unsupportedGuide');

/** 门控：KHY_IMAGE_CONTEXT_CARD，默认开；显式 falsy → 调用方逐字节回退旧行为。 */
function cardEnabled(env = process.env) {
  return envFlagEnabled(env.KHY_IMAGE_CONTEXT_CARD, true);
}

/**
 * 从图像字节头解析宽高（PNG/GIF/JPEG/WebP）。解析不出 → null（不猜）。
 * @param {Buffer} buf
 * @returns {{width:number,height:number}|null}
 */
function readImageDimensions(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 10) {
      return null;
    }
    // PNG: IHDR 宽高在大端 16..23
    if (buf.readUInt32BE(0) === 0x89504e47) {
      if (buf.length < 24) {
        return null;
      }
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // GIF: 逻辑屏幕描述符在小端 6..9
    if (buf.toString('ascii', 0, 3) === 'GIF') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    // JPEG: 扫 SOF0..SOF15（跳过 C4），高在段内 +5、宽 +7（大端）
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buf[i + 1];
        const isSof =
          marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
      return null;
    }
    // WebP: RIFF....WEBP，按 FourCC 分支（各子格式最长需 30 字节头）
    if (
      buf.length >= 30 &&
      buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP'
    ) {
      const fourCC = buf.toString('ascii', 12, 16);
      if (fourCC === 'VP8 ') {
        return {
          width: buf.readUInt16LE(26) & 0x3fff,
          height: buf.readUInt16LE(28) & 0x3fff,
        };
      }
      if (fourCC === 'VP8L') {
        const b = buf.readUInt32LE(17);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (fourCC === 'VP8X') {
        return {
          width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
          height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

const SCENES = ['error-screenshot', 'ui-design', 'document', 'diagram', 'unknown'];

// 判据顺序即优先级：报错（强特征）> 流程图 > UI 稿 > 文档。
const SCENE_PATTERNS = [
  {
    scene: 'error-screenshot',
    test: (t) =>
      /(error|exception|traceback|panic|fatal|failed|npm err|at\s+\S+\s*\(?.*\.(js|ts|py|go):\d+)/i.test(
        t
      ) || /错误|异常|堆栈|报错|失败/.test(t),
  },
  { scene: 'diagram', test: (t) => /-->|==>|→|graph\s+TD|flowchart|sequenceDiagram/i.test(t) },
  {
    scene: 'ui-design',
    test: (t) => (/#[0-9a-f]{6}\b/i.test(t) && /\d+\s*px/i.test(t)) || /padding|margin|font-size|border-radius/i.test(t),
  },
  {
    scene: 'document',
    test: (t) =>
      /需求|PRD|验收|功能说明/.test(t) ||
      ((t.match(/^\s*(?:\d+(?:\.\d+)*[.、)]|[一二三四五六七八九十]+[、.])/gm) || []).length >= 3),
  },
];

/**
 * 场景判定：确定性关键词启发式。信号不足 → 'unknown'（不猜）。
 * @param {{ocrText?: string}} input
 * @returns {string} SCENES 之一
 */
function classifyScene(input = {}) {
  const t = String(input.ocrText || '');
  if (!t.trim()) {
    return 'unknown';
  }
  for (const { scene, test } of SCENE_PATTERNS) {
    try {
      if (test(t)) {
        return scene;
      }
    } catch {
      /* 单条判据异常不阻断其余判定 */
    }
  }
  return 'unknown';
}

const SCENE_LABELS = {
  'error-screenshot': '报错截图',
  'ui-design': 'UI 设计稿',
  document: '文档截图',
  diagram: '流程图/架构图',
  unknown: '未判定',
};

const SCENE_QUESTIONS = {
  'error-screenshot':
    '图中关键行若有截断请以文本补齐；请补充复现命令、运行环境与最近变更（模型看不到图外的事实）。',
  'ui-design': '精确色值与间距请以文字/设计 Token 提供（像素级估色与估距不可靠，宁可给出也不要让模型猜）。',
  document: '表格结构与编号列表易识别错乱，关键条目请以文字逐条转录；手写批注务必单独列出。',
  diagram: '箭头方向与节点层级最易误判，请对照原图确认关系，或直接提供 Mermaid/PlantUML 文本（双轨制）。',
};

// OCR 置信度低于此值 → 提示人工核对错字高危项（变量名/路径/版本号/数字）。
const LOW_CONFIDENCE = 60;

/**
 * 长图判定（指南策略三）：高 > 2000px 或高 > 2×宽 → 建议按区域拆分。
 * @returns {string|null}
 */
function tallImageSuggestion(dim = {}) {
  const w = Number(dim.width) || 0;
  const h = Number(dim.height) || 0;
  if (!w || !h) {
    return null;
  }
  if (h > 2000 || h > 2 * w) {
    return '长图信息密度过高易看漏，建议按区域拆成 2-3 张分别提交。';
  }
  return null;
}

function _formatLabel(image = {}) {
  const fmt = String(image.format || image.mimeType || '').replace(/^image\//, '').toUpperCase();
  return fmt || '未知格式';
}

/**
 * 装配单图说明书段。字段缺省如实写「未知」，不猜测。
 * @param {object} image {index,total,source,sizeBytes,width,height,format,mimeType,
 *                        ocrText,ocrConfidence,downscaledFrom}
 * @returns {string}
 */
function buildImageCard(image = {}) {
  const total = Number(image.total) || 1;
  const index = Number(image.index) || 1;
  const lines = [];
  lines.push(`【图片说明书 ${index}/${total}】`);
  if (image.source) {
    lines.push(`- 来源: ${image.source}`);
  }
  const dims =
    image.width && image.height ? `${image.width}x${image.height}px` : '尺寸未知';
  const size = image.sizeBytes ? `${(image.sizeBytes / 1024).toFixed(0)}KB` : '大小未知';
  lines.push(`- 格式: ${_formatLabel(image)} · ${dims} · ${size}`);
  if (image.downscaledFrom && image.downscaledFrom.sizeBytes) {
    const from = image.downscaledFrom;
    const fromDims = from.width && from.height ? `${from.width}x${from.height}→` : '';
    lines.push(
      `- 预处理: 已由 ${(from.sizeBytes / 1024 / 1024).toFixed(1)}MB 自动压缩至 ${(
        image.sizeBytes / 1024 / 1024
      ).toFixed(1)}MB（${fromDims}${image.width}x${image.height}）`
    );
  }
  const scene = SCENE_LABELS[image.scene] ? image.scene : 'unknown';
  lines.push(`- 场景判定: ${SCENE_LABELS[scene]}`);

  const ocrText = String(image.ocrText || '').trim();
  if (ocrText) {
    const conf = Number(image.ocrConfidence);
    const confStr = Number.isFinite(conf) ? `（本地 OCR 置信度 ${Math.round(conf)}%）` : '';
    lines.push(`【OCR 转录】${confStr}`);
    lines.push(ocrText);
    if (Number.isFinite(conf) && conf < LOW_CONFIDENCE) {
      lines.push('⚠ 置信度低：变量名/API 路径/版本号/数字请人工核对后再采信。');
    }
  } else {
    lines.push('【OCR 转录】未获取（本地 OCR 不可用，或图中无可识别文字）。');
  }

  const tall = tallImageSuggestion(image);
  if (tall) {
    lines.push(`【建议】${tall}`);
  }
  const q = SCENE_QUESTIONS[scene];
  if (q) {
    lines.push(`【待确认】${q}`);
  }
  return lines.join('\n');
}

/** kind → 中文类型标签（与 aiUploadStore.classifyKind 的口径对齐）。 */
const KIND_LABELS = {
  image: '图片',
  document: '文档',
  text: '文本',
  code: '代码',
  archive: '归档',
  audio: '音频',
  video: '视频',
  other: '文件',
};

/**
 * 装配单个文件说明书段（[DESIGN-ARCH-163] D6）。摘录/失败如实标注，绝不臆断。
 * @param {object} file {index,total,source,kind,sizeBytes,engine,text,truncated,failNote}
 * @returns {string}
 */
function buildFileCard(file = {}) {
  const total = Number(file.total) || 1;
  const index = Number(file.index) || 1;
  const lines = [];
  lines.push(`【文件说明书 ${index}/${total}】`);
  if (file.source) {
    lines.push(`- 来源: ${file.source}`);
  }
  const size =
    Number.isFinite(Number(file.sizeBytes)) && file.sizeBytes > 0
      ? `${(file.sizeBytes / 1024).toFixed(1)}KB`
      : '大小未知';
  lines.push(`- 类型: ${KIND_LABELS[file.kind] || '文件'} · ${size}`);

  const text = String(file.text || '').trim();
  // D7 三段式引导（门控关 → 编排层不挂 guide 字段，卡片逐字节回退 D6 文案）。
  const guide = Array.isArray(file.guideLines) ? file.guideLines : guideLines(file.guide);
  if (text) {
    const trunc = file.truncated ? `（截断，前 ${text.length} 字）` : '';
    lines.push(`- 提取: ${file.engine || '直读'}${trunc}`);
    lines.push('【正文摘录】');
    lines.push(text);
    lines.push('【待确认】以上仅为摘录；需要完整内容请对该路径使用 read 工具，勿凭摘录臆断后文。');
    lines.push(...guide);
  } else {
    lines.push(`- 提取: 未提取${file.failNote ? `（${file.failNote}）` : ''}`);
    if (guide.length > 0) {
      lines.push(...guide);
    } else {
      lines.push('【待确认】正文未获取；涉及其内容的需求先与用户确认或用 read 工具读文件。');
    }
  }
  return lines.join('\n');
}

/**
 * 装配多图/多文件说明书（[DESIGN-ARCH-163] D1/D1.1/D6 的统一出口）。
 *
 * 关联契约（一次输入混排 文字+多图+多路径文档 时「怎么一起处理、怎么形成联系」的答案）：
 *  - 图卡 index **锚定 options.images 真实下标**（+1），与适配器发图顺序一致，
 *    「图i」= 模型收到的第 i 个图片块，永不错位；
 *  - 附件总数 > 1 时先给【附件对照】表（图i=来源；文件j=路径）+ 指代约定；
 *  - 出卡数 < 附件总数（超上限 / 非 base64 图）时如实注明差额，不假装全都有卡。
 *
 * @param {object[]} images 各图卡数据，index 为发送序（1 基）
 * @param {{turnTotal?: number, fileCards?: object[]}} [meta] 图片总数 + 文件卡列表
 * @returns {string}
 */
function buildContextCard(images = [], meta = {}) {
  const list = Array.isArray(images) ? images.filter(Boolean) : [];
  const files = Array.isArray(meta && meta.fileCards) ? meta.fileCards.filter(Boolean) : [];
  if (list.length === 0 && files.length === 0) {
    return '';
  }
  const imageTotal = Math.max(Number(meta && meta.turnTotal) || list.length, list.length);
  const fileTotal = Math.max(Number(meta && meta.fileTotal) || files.length, files.length);
  // D7-V2 抽帧：注入图轨的帧没有独立图卡，但必须在对照表占位（图i=发送序同源）。
  const frameRefs = Array.isArray(meta && meta.frameRefs)
    ? meta.frameRefs.filter((fr) => fr && Number.isFinite(Number(fr.imgIndex)) && fr.label)
    : [];
  const attachTotal = imageTotal + fileTotal;
  const shown = list.length + files.length + frameRefs.length;
  const parts = [];
  if (attachTotal > 1) {
    const mapping = [
      ...list.map((img, i) => `图${Number(img.index) || i + 1}=${img.source || '未知来源'}`),
      ...frameRefs.map((fr) => `图${Number(fr.imgIndex)}=${fr.label}`),
      ...files.map((f, i) => `文件${Number(f.index) || i + 1}=${f.source || '未知路径'}`),
    ].join('；');
    parts.push(
      `【附件对照 ${shown}/${attachTotal}】本回合共 ${attachTotal} 个附件（图与文件分开编号），图片编号与图片块发送顺序一致：${mapping}`
    );
    parts.push('指代约定：用户提到「图i」「文件j」或上表路径时按编号对应；跨附件比较须逐项引用编号，歧义先问勿猜。');
    if (attachTotal > shown) {
      parts.push(
        `（另有 ${attachTotal - shown} 个附件未出说明书：超出单轮出卡上限或为非 base64 引用。）`
      );
    }
  }
  if (list.length > 0) {
    parts.push(
      list
        .map((img, i) => buildImageCard({ ...img, index: Number(img.index) || i + 1, total: imageTotal }))
        .join('\n\n')
    );
  }
  if (files.length > 0) {
    parts.push(
      files
        .map((f, i) => buildFileCard({ ...f, index: Number(f.index) || i + 1, total: files.length }))
        .join('\n\n')
    );
  }
  return parts.join('\n');
}

module.exports = {
  cardEnabled,
  readImageDimensions,
  classifyScene,
  SCENES,
  SCENE_LABELS,
  KIND_LABELS,
  LOW_CONFIDENCE,
  tallImageSuggestion,
  buildImageCard,
  buildFileCard,
  buildContextCard,
};

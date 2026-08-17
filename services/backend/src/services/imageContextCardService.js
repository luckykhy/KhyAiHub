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
const ug = require('./unsupportedGuide');

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

// ── D7 确定性提取（[DESIGN-ARCH-163] D7）：清单 / 元数据 / 文本轨 / 抽帧 ──
// 零新依赖：python zipfile/tarfile（清单）、ffprobe（容器元数据）、ffmpeg（转码/抽帧）。
// 探测全部 fail-soft：工具缺席即当不存在，走 unsupportedGuide 的诚实引导分支。
const ARCHIVE_MAX_ENTRIES = 40;
const ZIP_LISTING_RE = /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/i;
// 文件扩展名 → 可自动摘录的同名文本轨（audio 捞 .lrc，video 捞 .srt/.vtt）。
const TRACK_EXT_BY_FILE_EXT = {
  mp3: ['.lrc'],
  wav: ['.lrc'],
  flac: ['.lrc'],
  m4a: ['.lrc'],
  ogg: ['.lrc'],
  aac: ['.lrc'],
  mp4: ['.srt', '.vtt'],
  mkv: ['.srt', '.vtt'],
  mov: ['.srt', '.vtt'],
  avi: ['.srt', '.vtt'],
  webm: ['.srt', '.vtt'],
  wmv: ['.srt', '.vtt'],
  mpeg: ['.srt', '.vtt'],
  mpg: ['.srt', '.vtt'],
};

// 工具路径缓存 + 测试替身缝（同 _imageTranscode 的 _resetFfmpegCache 家族）。
let _toolsCache; // undefined = 未缓存；{python, ffmpeg, ffprobe}
let _toolsOverride = null;
let _runnerOverride = null;

function _resolveTools() {
  if (_toolsOverride) {
    return _toolsOverride;
  }
  if (_toolsCache) {
    return _toolsCache;
  }
  try {
    const { searchExecutable } = require('../tools/platformUtils');
    _toolsCache = {
      python: searchExecutable('python3') || searchExecutable('python') || null,
      ffmpeg: searchExecutable('ffmpeg') || null,
      ffprobe: searchExecutable('ffprobe') || null,
    };
  } catch {
    _toolsCache = { python: null, ffmpeg: null, ffprobe: null };
  }
  return _toolsCache;
}

function _setD7ToolsForTest(tools) {
  _toolsOverride = tools;
}

function _setD7RunnerForTest(fn) {
  _runnerOverride = fn;
}

function _resetD7ForTest() {
  _toolsCache = undefined;
  _toolsOverride = null;
  _runnerOverride = null;
}

// 短生命周期子进程 I/O 超时（防挂死 I/O，RUNTIME-003 合法例外；钳 ≤10s）。
async function _runTool(cmd, args, timeoutMs) {
  if (_runnerOverride) {
    return _runnerOverride(cmd, args, timeoutMs);
  }
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const r = await promisify(execFile)(cmd, args, {
    timeout: Math.max(1000, Math.min(10_000, Number(timeoutMs) || FILE_TIMEOUT_MS)),
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  return { stdout: String((r && r.stdout) || ''), stderr: String((r && r.stderr) || '') };
}

const _PY_ZIP_SRC = [
  'import sys, json, zipfile, tarfile',
  'p, n = sys.argv[1], int(sys.argv[2])',
  'out = {"entries": [], "total": 0, "encrypted": False, "error": ""}',
  'try:',
  '    if zipfile.is_zipfile(p):',
  '        z = zipfile.ZipFile(p)',
  '        names = z.namelist()',
  '        out["total"] = len(names)',
  '        out["entries"] = names[:n]',
  '        out["encrypted"] = any(getattr(i, "flag_bits", 0) & 1 for i in z.infolist())',
  '    else:',
  '        t = tarfile.open(p)',
  '        names = t.getnames()',
  '        out["total"] = len(names)',
  '        out["entries"] = names[:n]',
  '        t.close()',
  'except Exception as e:',
  '    out["error"] = str(e)',
  'print(json.dumps(out, ensure_ascii=False))',
].join('\n');

/** python zipfile/tarfile 清单 → {ok, entries, total, encrypted} | {ok:false}。 */
async function _listArchive(resolved, env) {
  const tools = _resolveTools();
  if (!tools.python) {
    return { ok: false, reason: 'no-python' };
  }
  try {
    const r = await _runTool(tools.python, ['-c', _PY_ZIP_SRC, resolved, String(ARCHIVE_MAX_ENTRIES)], _fileTimeoutMs(env));
    const j = JSON.parse(String(r.stdout || '').trim().split('\n').pop() || '{}');
    if (j.error || !Array.isArray(j.entries)) {
      return { ok: false, reason: String(j.error || 'listing failed').slice(0, 120) };
    }
    return { ok: true, entries: j.entries.slice(0, ARCHIVE_MAX_ENTRIES), total: Number(j.total) || j.entries.length, encrypted: !!j.encrypted };
  } catch {
    return { ok: false, reason: 'listing-exec-failed' };
  }
}

function _parseProbeJson(stdout) {
  try {
    const j = JSON.parse(String(stdout || '{}'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/** ffprobe 容器/流元数据（失败 → null，调用方走诚实引导分支）。 */
async function _probeMedia(resolved, env) {
  const tools = _resolveTools();
  if (!tools.ffprobe) {
    return null;
  }
  try {
    const r = await _runTool(
      tools.ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', resolved],
      _fileTimeoutMs(env)
    );
    return _parseProbeJson(r.stdout);
  } catch {
    return null;
  }
}

function _fmtDur(sec) {
  const s = Math.round(Number(sec) || 0);
  if (!s) return '';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m < 60 ? `${m}m${r ? ` ${r}s` : ''}` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function _fpsOf(str) {
  const m = /^(\d+)\/(\d+)$/.exec(String(str || ''));
  if (!m) return Number(str) || 0;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return b > 0 ? Math.round((a / b) * 100) / 100 : 0;
}

// classifyKind 的 mime 口径对「prompt 里的裸路径」无效（无 mime → 恒 other），
// D7 分支前按扩展名兜一层本地 kind；仅在本服务内使用，不动上传管线口径。
const _IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif)$/i;
// 不在模型直收白名单的位图（D7 转码入图轨只对这些；png/jpg 路径提及维持引用面）。
const _BITMAP_REF_RE = /\.(bmp|tiff?|heic|heif)$/i;
const _ARCHIVE_EXT_RE = /\.(zip|tar|gz|tgz|bz2|xz|7z|rar)$/i;
const _AUDIO_EXT_RE = /\.(mp3|wav|flac|m4a|ogg|aac)$/i;
const _VIDEO_EXT_RE = /\.(mp4|mkv|mov|avi|webm|wmv|mpe?g)$/i;

function _kindByExt(filePath) {
  const p = String(filePath || '');
  if (_IMAGE_EXT_RE.test(p)) return 'image';
  if (_ARCHIVE_EXT_RE.test(p)) return 'archive';
  if (_AUDIO_EXT_RE.test(p)) return 'audio';
  if (_VIDEO_EXT_RE.test(p)) return 'video';
  return null;
}

/** 同目录同名文本轨（.lrc/.srt/.vtt）→ {ext, text} | null。 */
function _readSiblingTrack(resolved, env) {
  try {
    const exts = TRACK_EXT_BY_FILE_EXT[String(path.extname(resolved).slice(1)).toLowerCase()] || [];
    const base = resolved.slice(0, Math.max(0, resolved.length - path.extname(resolved).length));
    for (const e of exts) {
      const p = base + e;
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        if (raw && raw.trim()) {
          return { ext: e, text: raw.trim().slice(0, _excerptChars(env)) };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** BMP 文件头宽高（不猜 TIFF——头解析复杂，宁缺毋滥）。 */
function _bitmapDims(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 26) return null;
    if (buf.toString('ascii', 0, 2) === 'BM') {
      const w = buf.readInt32LE(18);
      const h = Math.abs(buf.readInt32LE(22));
      if (w > 0 && h > 0) return { width: w, height: h, bpp: buf.readUInt16LE(28) };
    }
    return null;
  } catch {
    return null;
  }
}

function _mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function _rmDir(dir) {
  if (dir) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function _imgEntryFromFile(outPath, label) {
  const buf = fs.readFileSync(outPath);
  if (!buf || buf.length === 0) return null;
  const base64 = buf.toString('base64');
  const mimeType = 'image/jpeg';
  return { base64, mimeType, dataUrl: `data:${mimeType};base64,${base64}`, label };
}

/** 位图引用 → ffmpeg 转 jpeg 入图轨（失败 → null，卡内如实声明未转码）。 */
async function _transcodeRefToImage(resolved, label, env) {
  const tools = _resolveTools();
  if (!tools.ffmpeg) return null;
  let dir = null;
  try {
    dir = _mkTmpDir('khy-d7-xcode-');
    const outPath = path.join(dir, 'out.jpg');
    await _runTool(
      tools.ffmpeg,
      ['-y', '-v', 'error', '-i', resolved, '-frames:v', '1', '-vf', `scale='min(2048,iw)':'min(2048,ih)':force_original_aspect_ratio=decrease`, '-f', 'image2', outPath],
      _fileTimeoutMs(env)
    );
    if (!fs.existsSync(outPath)) return null;
    return _imgEntryFromFile(outPath, label);
  } catch {
    return null;
  } finally {
    _rmDir(dir);
  }
}

/**
 * 视频均匀抽帧（V2）→ [{base64,mimeType,dataUrl,label}]。
 * duration 未知/ffmpeg 缺席/命令失败 → []（卡内走诚实引导，不硬猜时间点）。
 */
async function _extractFrames(resolved, count, duration, labelPrefix, env) {
  const tools = _resolveTools();
  if (!tools.ffmpeg || !(count > 0) || !(duration > 0)) {
    return [];
  }
  let dir = null;
  try {
    dir = _mkTmpDir('khy-d7-frames-');
    const fps = Math.max(0.01, count / duration);
    const pattern = path.join(dir, 'frame_%03d.jpg');
    await _runTool(
      tools.ffmpeg,
      ['-y', '-v', 'error', '-i', resolved, '-vf', `fps=${fps.toFixed(4)},scale='min(1280,iw)':-2`, '-frames:v', String(count), '-vsync', 'vfr', '-q:v', '3', pattern],
      _fileTimeoutMs(env)
    );
    const files = fs.readdirSync(dir).filter((f) => /^frame_\d+\.jpg$/.test(f)).sort();
    const out = [];
    for (const f of files) {
      const entry = _imgEntryFromFile(path.join(dir, f), `${labelPrefix}·帧${out.length + 1}/${count}`);
      if (entry) out.push(entry);
    }
    return out;
  } catch {
    return [];
  } finally {
    _rmDir(dir);
  }
}

// 路径比对归一：`\` 与 `/`、大小写（win32 视角）不再造成图/文双卡重复。
function _normPath(p) {
  return String(p || '')
    .replace(/\//g, '\\')
    .toLowerCase();
}

/**
 * 按格式路由提取单个文件的正文（D6 文本/文档轨 + D7 清单/元数据/文本轨/抽帧轨）。
 * 任何失败 → 引用卡 + 诚实 failNote/三段式引导（RUNTIME-002.2），绝不抛。
 * @param {string} refPath
 * @param {object} env
 * @param {{images?:Array, frameRefs?:Array, visionVerdict?:string|null,
 *          guideOn?:boolean, cardIndex?:number}} [ctx] D7 编排上下文
 */
async function _extractOneFile(refPath, env, ctx = {}) {
  const out = { source: refPath, kind: 'other', sizeBytes: undefined, text: '', truncated: false, engine: '', failNote: '', guide: null };
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
    if (kind === 'other') {
      kind = _kindByExt(resolved) || 'other';
    }
    out.kind = kind;

    if (stat.size > FILE_MAX_BYTES) {
      out.failNote = `超过 ${FILE_MAX_BYTES / 1024 / 1024}MB 提取上限，仅登记引用`;
      return out;
    }

    // D7 上下文缺省：无图轨可注入 / 无视觉 verdict / 引导关（逐字节回退 D6）。
    const guideOn = ctx.guideOn === true;
    const images = Array.isArray(ctx.images) ? ctx.images : [];
    const frameRefs = Array.isArray(ctx.frameRefs) ? ctx.frameRefs : [];
    const cardIndex = Number(ctx.cardIndex) || 1;
    const tools = _resolveTools();
    const baseFacts = {
      ffmpeg: !!(tools.ffmpeg || tools.ffprobe),
      python: !!tools.python,
      visionVerdict: ctx.visionVerdict === undefined ? null : ctx.visionVerdict,
    };
    const attachGuide = (kindG, extra) => {
      if (!guideOn) return null;
      const g = ug.makeGuide({ kind: kindG, ext: path.extname(resolved).toLowerCase(), failNote: out.failNote, facts: { ...baseFacts, ...extra } });
      return g;
    };

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
        out.guide = attachGuide('other');
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
          out.guide = attachGuide('other');
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

    // ── D7 位图引用（bmp/tiff…）：文件头尺寸 + ffmpeg 在场转码入图轨；不猜像素内容 ──
    // 门控关 → 整分支跳过，逐字节回退 D6「该格式暂无正文提取通道」。
    if (guideOn && kind === 'image') {
      const base = path.basename(resolved);
      let dims = null;
      try {
        dims = _bitmapDims(fs.readFileSync(resolved));
      } catch {
        /* 读失败 → 无尺寸，引导仍出 */
      }
      let transcodeDone = false;
      if (tools.ffmpeg && _BITMAP_REF_RE.test(resolved)) {
        const img = await _transcodeRefToImage(resolved, base, env);
        if (img) {
          images.push(img);
          frameRefs.push({ imgIndex: images.length, label: base });
          transcodeDone = true;
        }
      }
      if (dims) {
        out.engine = '文件头';
        out.text = `位图文件头解析: ${dims.width}x${dims.height}${dims.bpp ? ` · ${dims.bpp}bpp` : ''}`;
      }
      out.guide = attachGuide('bitmap', { dimsKnown: !!dims, transcodeDone });
      if (!out.text && !out.guide) {
        out.failNote = '位图无本地提取通道，仅登记引用';
      }
      return out;
    }

    // ── D7 压缩包：python zipfile/tarfile 目录清单（前 N + 总数 + 加密标志）──
    if (guideOn && kind === 'archive') {
      if (ZIP_LISTING_RE.test(resolved) && tools.python) {
        const r = await _listArchive(resolved, env);
        if (r && r.ok) {
          const head = `目录清单（前 ${r.entries.length}/${r.total} 条${r.encrypted ? '，检测到加密条目' : '，未见加密条目'}）:`;
          out.engine = 'py:zipfile/tarfile';
          out.text = [head, ...r.entries].join('\n');
          out.truncated = r.total > r.entries.length;
          out.guide = attachGuide('archive', { listingOk: true, encrypted: r.encrypted });
          return out;
        }
        out.failNote = `压缩清单读取失败（${r && r.reason ? r.reason : '未知原因'}），仅登记引用`;
      } else {
        out.failNote = '该压缩格式无本地清单通道（rar/7z 等或缺 python），仅登记引用';
      }
      out.guide = attachGuide('archive', { listingOk: false });
      return out;
    }

    // ── D7 音频：ffprobe 元数据 + .lrc/内嵌歌词文本轨；旋律永远如实声明未转录 ──
    if (guideOn && kind === 'audio') {
      const probe = await _probeMedia(resolved, env);
      const fmt = (probe && probe.format) || {};
      const tags = fmt.tags || {};
      const aStream = ((probe && probe.streams) || []).find((s) => s.codec_type === 'audio') || {};
      const dur = Number(fmt.duration) || 0;
      const meta = [];
      if (dur) meta.push(`时长 ${_fmtDur(dur)}`);
      if (aStream.sample_rate) meta.push(`采样率 ${aStream.sample_rate}Hz`);
      if (aStream.channels) meta.push(`声道 ${aStream.channels}`);
      if (Number(fmt.bit_rate)) meta.push(`比特率 ${Math.round(Number(fmt.bit_rate) / 1000)}kbps`);
      if (aStream.codec_name) meta.push(`编码 ${aStream.codec_name}`);
      for (const k of ['title', 'artist', 'album']) {
        if (tags[k]) meta.push(`${k}: ${tags[k]}`);
      }
      const embeddedLyrics = String(tags.LYRICS || tags.lyrics || '').trim();
      const sib = _readSiblingTrack(resolved, env);
      const lyrics = sib ? sib.text : embeddedLyrics;
      const partsText = [];
      if (meta.length) partsText.push(`容器元数据: ${meta.join(' · ')}`);
      if (lyrics) {
        partsText.push(`以下歌词摘录来自${sib ? `同名 ${sib.ext} 文本轨` : '内嵌歌词标签'}，不是听写结果：`);
        partsText.push(lyrics);
      }
      const full = partsText.join('\n');
      out.engine = probe ? `ffprobe${lyrics ? '+文本轨' : ''}` : '';
      out.text = full.slice(0, cap);
      out.truncated = full.length > cap;
      if (!probe) {
        out.failNote = '本机无 ffprobe：音频元数据未读取';
      }
      out.guide = attachGuide('audio', { duration: dur, lyricsFound: !!lyrics });
      return out;
    }

    // ── D7 视频：V1 probe 元数据 + 同名字幕文本轨；V2 ffmpeg 抽帧注入图轨 ──
    if (guideOn && kind === 'video') {
      const probe = await _probeMedia(resolved, env);
      const fmt = (probe && probe.format) || {};
      const streams = (probe && probe.streams) || [];
      const vStream = streams.find((s) => s.codec_type === 'video') || {};
      const dur = Number(fmt.duration) || 0;
      const meta = [];
      if (dur) meta.push(`时长 ${_fmtDur(dur)}`);
      if (vStream.width && vStream.height) meta.push(`分辨率 ${vStream.width}x${vStream.height}`);
      const fps = _fpsOf(vStream.r_frame_rate);
      if (fps) meta.push(`帧率 ${fps}`);
      if (vStream.codec_name) meta.push(`视频编码 ${vStream.codec_name}`);
      meta.push(streams.some((s) => s.codec_type === 'audio') ? '含音轨(未转录)' : '无音轨');
      const embeddedSub = streams.some((s) => s.codec_type === 'subtitle');
      const sib = _readSiblingTrack(resolved, env);
      const partsText = [];
      if (meta.length) partsText.push(`容器元数据: ${meta.join(' · ')}`);
      if (sib) {
        partsText.push(`以下摘录来自同名 ${sib.ext} 字幕文本，非画面内容（证据等级不同）：`);
        partsText.push(sib.text);
      } else if (embeddedSub) {
        partsText.push('检测到内嵌字幕流（本回合未提取）。');
      }
      // V2 抽帧：门控开 + ffmpeg 在场 + 帧数 >0 + 未达单轮图上限。
      const facts = { hasSubtitleTrack: !!sib || embeddedSub, duration: dur, framesDone: 0, framesSkippedByCap: false };
      if (guideOn && tools.ffmpeg) {
        const want = ug.frameCount(env);
        if (want > 0) {
          if (images.length >= MAX_CARDS) {
            facts.framesSkippedByCap = true;
          } else {
            const frames = await _extractFrames(resolved, want, dur, `文件${cardIndex}`, env);
            for (const fr of frames) {
              images.push(fr);
              frameRefs.push({ imgIndex: images.length, label: fr.label });
            }
            facts.framesDone = frames.length;
            if (frames.length > 0) {
              partsText.push(`已抽帧 ${frames.length}/${want} 张作为图片附于本消息（${frames.map((f) => f.label).join('、')}）。`);
            }
          }
        }
      }
      const full = partsText.join('\n');
      out.engine = probe ? 'ffprobe' : '';
      out.text = full.slice(0, cap);
      out.truncated = full.length > cap;
      if (!probe) {
        out.failNote = '本机无 ffprobe：视频元数据未读取';
      }
      out.guide = attachGuide('video', facts);
      return out;
    }

    out.failNote = '该格式暂无正文提取通道，仅登记引用';
    out.guide = attachGuide('other');
    return out;
  } catch (e) {
    out.failNote = `提取异常: ${String((e && e.message) || e).slice(0, 120)}`;
    return out;
  }
}

/**
 * 从 prompt 原文扫文档/文本路径（D1.1 刻意不剥离的路径正是这里的联系来源），
 * 与图片 label 去重后逐格式提取，最多 MAX_FILE_CARDS 张。
 * ctx 携带 D7 编排面：images 图轨（抽帧/转码注入）、frameRefs 对照占位、
 * visionVerdict（D4 台账）、guideOn（三段式引导门控）。
 */
async function _collectFileCards(prompt, ctx, env) {
  const cards = [];
  let total = 0;
  try {
    const images = Array.isArray(ctx.images) ? ctx.images : [];
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
    // D7：引导门控开 → 追加媒体/归档扩展面（zip/mp3/mp4/bmp…路径才可被发现）；关 → D6 集。
    const refs = fileLeaf
      .extractAllFileReferences(prompt || '', ctx.guideOn === true ? fileLeaf.D7_MEDIA_EXT_SET : undefined)
      .filter((r) => !imagePaths.has(_normPath(r.filePath)));
    total = refs.length;
    for (const ref of refs.slice(0, MAX_FILE_CARDS)) {
      const cardIndex = cards.length + 1;
      const card = await _extractOneFile(ref.filePath, env, { ...ctx, cardIndex });
      card.index = cardIndex;
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
    // D7 编排面：引导门控 + D4 视觉 verdict（当前首选通道，缺 → 未实测文案）。
    const guideOn = ug.guideEnabled(env);
    let visionVerdict = null;
    if (guideOn) {
      try {
        const key = options && (options.adapter || options.adapterKey || (options.route && options.route.adapter));
        if (key) {
          visionVerdict = require('./visionCapabilityStore').getAdapterVerdict(key, env);
        }
      } catch {
        /* fail-soft: verdict 未知 → 引导走「未实测」分支 */
      }
    }
    const frameRefs = [];
    const { cards: fileCards, total: fileTotal } = fileCardsEnabled(env)
      ? await _collectFileCards(prompt, { images, frameRefs, visionVerdict, guideOn }, env)
      : { cards: [], total: 0 };
    if (cards.length === 0 && fileCards.length === 0) {
      return prompt;
    }
    // 抽帧/转码注入后 images.length 已含帧 → turnTotal 与「图i=发送序」保持同源。
    const text = leaf.buildContextCard(cards, { turnTotal: images.length, fileCards, fileTotal, frameRefs });
    if (!text) {
      return prompt;
    }
    return `${prompt || ''}\n\n${text}`;
  } catch {
    return prompt;
  }
}

module.exports = {
  attachContextCard,
  MAX_CARDS,
  MAX_FILE_CARDS,
  fileCardsEnabled,
  _ocrTimeoutMs,
  _fileTimeoutMs,
  _excerptChars,
  // D7 seams & helpers (test-facing, same family as _resetFfmpegCache)
  _resolveTools,
  _setD7ToolsForTest,
  _setD7RunnerForTest,
  _resetD7ForTest,
  _listArchive,
  _probeMedia,
  _bitmapDims,
  _extractFrames,
  _readSiblingTrack,
};

'use strict';

/**
 * unsupportedGuide.js — D7「声明 + 原因 + 引导」三段式纯叶子（[DESIGN-ARCH-163] D7）。
 *
 * D6 引用卡只说「仅登记引用」——诚实但没给路。本叶子把「无通道」分支升级为三段式:
 * ①声明没读到什么 ②为什么 ③按当前环境真实可用性生成的可行动作,并钉进卡尾
 * 【行为约定】,让模型转述而非编造。
 *
 * 纯叶子:零 IO、零 require 环境探测（工具可用性/视觉 verdict 由编排层传入 facts）、
 * 绝不抛。门控关 → 编排层根本不装配 guide 字段,卡片逐字节回退 D6 文案。
 *
 * 引导三态（design §D7.2）:
 *   - 本地可做:事实里已做的降级提取（清单/元数据/字幕轨/抽帧）,卡内注明引擎;
 *   - 配置可得:给正门命令（khy gateway config / khy doctor / env 调帧数）;
 *   - 有通道未实测:接 D4 探针台账的 visionVerdict 生成文案。
 */

const envFlagEnabled = require('../utils/envFlagEnabled');

/** 门控：KHY_HONEST_UNSUPPORTED_GUIDE，默认开；falsy → 编排层不装配 guide。 */
function guideEnabled(env = process.env) {
  return envFlagEnabled(env.KHY_HONEST_UNSUPPORTED_GUIDE, true);
}

const DEFAULT_FRAMES = 3;
const MAX_FRAMES = 8;

/** 抽帧数：KHY_VIDEO_THUMB_FRAMES，默认 3，钳 1–8；显式 ≤0 → 0（禁用抽帧）。 */
function frameCount(env = process.env) {
  const raw = env && env.KHY_VIDEO_THUMB_FRAMES;
  if (raw == null || String(raw).trim() === '') {
    return DEFAULT_FRAMES;
  }
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n)) {
    return DEFAULT_FRAMES;
  }
  if (n <= 0) {
    return 0;
  }
  return Math.min(MAX_FRAMES, n);
}

const CONTRACT =
  '【行为约定】本附件正文未经通道完整读取。用户问及此附件时：①先声明未读到的部分；' +
  '②只从本卡「可行动作」中给具体建议；③禁止编造画面/旋律/歌词/包内文件内容。';

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function _fmtDuration(sec) {
  const s = Math.round(_num(sec));
  if (!s) {
    return '';
  }
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) {
    return `${m}m${r ? ` ${r}s` : ''}`;
  }
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * 视觉通道三态文案（D4 台账 verdict 注入，保持本叶子纯函数）。
 * @param {'supported'|'unsupported'|null|undefined} verdict
 */
function _visionAction(verdict) {
  if (verdict === 'supported') {
    return '当前首选通道已实测支持识图：把图作为附件（粘贴/选择）随消息发送即可获得视觉描述。';
  }
  if (verdict === 'unsupported') {
    return '当前首选通道已实测不收图：可用 khy gateway config 换配视觉通道，或将内容转为文字。';
  }
  return '识图通道未实测：可用 khy gateway config 配置视觉通道，探针会自动判定并记录。';
}

/**
 * 按 kind × facts 生成三段式引导数据。
 * @param {object} input {kind:'bitmap'|'archive'|'audio'|'video'|'other',
 *   ext?: string, failNote?: string,
 *   facts?: {ffmpeg, python, visionVerdict, framesDone, framesSkippedByCap,
 *            listingOk, encrypted, hasSubtitleTrack, duration, transcodeDone}}
 * @returns {null|{declaration:string, reason:string, actions:string[]}}
 */
function makeGuide(input = {}) {
  try {
    const kind = String(input.kind || 'other');
    const f = input.facts || {};
    const guide = _byKind(kind, f, input);
    if (!guide) {
      return null;
    }
    if (!Array.isArray(guide.actions)) {
      guide.actions = [];
    }
    if (f.visionVerdict !== undefined && (kind === 'bitmap' || kind === 'video')) {
      const v = _visionAction(f.visionVerdict);
      if (!guide.actions.includes(v)) {
        guide.actions.push(v);
      }
    }
    return guide;
  } catch {
    return null;
  }
}

function _byKind(kind, f, input) {
  switch (kind) {
    case 'bitmap': {
      if (f.transcodeDone) {
        return {
          declaration: '已本地转码为标准图随本消息发送（见上方图轨），未经该位图原格式的视觉理解。',
          reason: `位图(${String(input.ext || 'bmp/tiff')})不在模型直收白名单，发送前需转码。`,
          actions: ['原格式无需处理：直接提问图中内容即可；若图轨未收到该图请重新粘贴/拖入。'],
        };
      }
      const decl = f.dimsKnown
        ? '只做文件头解析（尺寸/字节数见上），未做视觉理解，正文内容未读取。'
        : '未读取图片内容（该路径以文本引用出现，未进入图片附件通道）。';
      const actions = ['把该图片粘贴/拖入输入框作为附件发送：网关附件通道会自动转码为模型可收格式。'];
      if (!f.ffmpeg) {
        actions.push('本机未探测到 ffmpeg：运行 khy doctor 检查安装，装好后位图引用可自动转码入图轨。');
      }
      return {
        declaration: decl,
        reason: 'BMP/TIFF 等位图不在模型直收白名单；文本引用路径不走附件通道的自动转码。',
        actions,
      };
    }
    case 'archive': {
      if (f.listingOk) {
        const actions = ['需要读包内文件时：点名条目并展开后按路径重发（说明书不旁路解包权限）。'];
        if (f.encrypted) {
          actions.push('检测到加密条目：无口令通道，请先自行解压再发目标文件。');
        }
        return {
          declaration: '包内文件未展开：以上仅为目录清单，条目内容均未读取。',
          reason: '解包并逐文件识别超出附件说明书职责；本回合只做本地确定性清单登记。',
          actions,
        };
      }
      const reason = !f.python
        ? '本机未探测到 python（zipfile/tarfile 清单通道不可用）。'
        : '该压缩格式（rar/7z 等）无纯标准库解法，或文件损坏/加密无法列出清单。';
      return {
        declaration: '未能读取压缩包目录清单，包内内容未读取。',
        reason,
        actions: [
          '运行 khy doctor 检查 Python 后重试；或解压后把需要读的文件按路径重发。',
        ],
      };
    }
    case 'audio': {
      const actions = [];
      if (f.lyricsFound) {
        actions.push('以下歌词摘录来自 .lrc/内嵌文本轨，不是听写结果；无文本轨时请把歌词以文字随消息发送。');
      } else {
        actions.push('提供歌词：随消息粘贴歌词文本，或附带同名 .lrc 文件（会被自动摘录）。');
      }
      if (!f.ffmpeg) {
        actions.push('本机未探测到 ffmpeg：运行 khy doctor 检查安装，装好后自动补时长/采样率等元数据。');
      } else {
        actions.push('旋律/人声转写通道属 T2 规划；当前可先用 khy gateway config 关注音频能力通道。');
      }
      return {
        declaration: `旋律与人声内容未转录${_num(f.duration) ? `（时长约 ${_fmtDuration(f.duration)}）` : ''}：无音频理解通道，仅读取了容器元数据${f.lyricsFound ? '与文本轨' : ''}。`,
        reason: '当前模型通道不收音频输入；本地可确定提取的只有容器元数据与歌词文本轨。',
        actions,
      };
    }
    case 'video': {
      let declaration;
      if (f.framesDone > 0) {
        declaration = `画面以 ${f.framesDone} 帧抽样进入本消息图轨（非连续视频）；音轨未转录。`;
      } else if (f.framesSkippedByCap) {
        declaration = '已达单轮图上限，本回合未抽帧：画面内容未读取；音轨未转录。';
      } else if (!f.ffmpeg) {
        declaration = '画面与音轨均未读取：本机无 ffmpeg，仅登记容器元数据。';
      } else {
        declaration = '画面内容未采样（抽帧未成功或被禁用）；音轨未转录。';
      }
      const actions = [];
      if (f.hasSubtitleTrack) {
        actions.push('以下字幕摘录来自同名/内嵌文本轨，摘录≠看懂画面；两者证据等级不同。');
      } else {
        actions.push('提供同名 .srt/.vtt 字幕文件可自动摘录——字幕是理解视频最可靠的低成本通道。');
      }
      if (f.ffmpeg && f.framesDone === 0 && !f.framesSkippedByCap) {
        actions.push('可用 KHY_VIDEO_THUMB_FRAMES=n 调整抽帧数（默认 3，最多 8；0 关闭）。');
      }
      if (!f.ffmpeg) {
        actions.push('运行 khy doctor 检查安装 ffmpeg；装好后视频将自动抽帧入图轨并走既有识图链。');
      }
      return {
        declaration,
        reason: '模型无视频输入通道；本方案用本地 ffmpeg 把视频降为可理解的帧图 + 字幕文本。',
        actions,
      };
    }
    default: {
      const actions = [
        '让模型对该路径直接使用 read 工具（文本类格式最可靠）。',
        '或把关键内容以文字直接粘贴进消息（涉及画面/版面时改用图片附件而非路径）。',
      ];
      return {
        declaration: `正文未读取${input.failNote ? `（${String(input.failNote).slice(0, 80)}）` : ''}。`,
        reason: '该格式无确定性正文提取通道，仅登记引用。',
        actions,
      };
    }
  }
}

/**
 * 渲染三段式为卡片行。guide 为空 → 空数组（调用方拼接零痕迹）。
 * @param {{declaration?:string, reason?:string, actions?:string[]}|null} guide
 * @returns {string[]}
 */
function guideLines(guide) {
  const lines = [];
  try {
    if (!guide || typeof guide !== 'object') {
      return [];
    }
    if (guide.declaration) {
      lines.push(`【声明】${guide.declaration}`);
    }
    if (guide.reason) {
      lines.push(`【原因】${guide.reason}`);
    }
    const actions = Array.isArray(guide.actions) ? guide.actions.filter(Boolean) : [];
    if (actions.length > 0) {
      lines.push('【可行动作】');
      const marks = ['①', '②', '③', '④', '⑤'];
      actions.slice(0, 5).forEach((a, i) => {
        lines.push(`  ${marks[i] || '·'} ${a}`);
      });
    }
    lines.push(CONTRACT);
  } catch {
    return [];
  }
  return lines;
}

module.exports = {
  guideEnabled,
  frameCount,
  makeGuide,
  guideLines,
  CONTRACT,
  DEFAULT_FRAMES,
  MAX_FRAMES,
};

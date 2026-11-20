// [DESIGN-ARCH-163] D9 —— attachmentView 纯函数单测（表驱动）。
import { describe, it, expect } from 'vitest';
import {
  THUMBS_KEY,
  readThumbsFlag,
  isImageAttachment,
  attachmentBadge,
  downloadFileName,
  attachmentFormat,
  FILE_FORMATS,
} from '@/utils/attachmentView';

function fakeStorage(map) {
  return { getItem: (k) => (k in map ? map[k] : null) };
}

describe('readThumbsFlag（门控）', () => {
  it('无该键 / 其他值 → 默认开', () => {
    expect(readThumbsFlag(fakeStorage({}))).toBe(true);
    expect(readThumbsFlag(fakeStorage({ [THUMBS_KEY]: '1' }))).toBe(true);
    expect(readThumbsFlag(fakeStorage({ [THUMBS_KEY]: 'off' }))).toBe(true);
  });
  it("显式 '0' → 关（回退旧观感）", () => {
    expect(readThumbsFlag(fakeStorage({ [THUMBS_KEY]: '0' }))).toBe(false);
  });
  it('storage 缺失或抛错（隐私模式）→ fail-soft 按默认开', () => {
    expect(readThumbsFlag(null)).toBe(true);
    expect(readThumbsFlag(undefined)).toBe(true);
    expect(
      readThumbsFlag({
        getItem() {
          throw new Error('SecurityError');
        },
      })
    ).toBe(true);
  });
});

describe('isImageAttachment', () => {
  it('仅 kind === image 为真；null/其他 kind 为假', () => {
    expect(isImageAttachment({ kind: 'image' })).toBe(true);
    expect(isImageAttachment({ kind: 'video' })).toBe(false);
    expect(isImageAttachment({ kind: 'document' })).toBe(false);
    expect(isImageAttachment(null)).toBe(false);
    expect(isImageAttachment({})).toBe(false);
  });
});

describe('attachmentBadge（后端解析状态徽标）', () => {
  it('transcript / extracted 单独与组合', () => {
    expect(attachmentBadge({ transcript: '字幕…' })).toBe('已转写');
    expect(attachmentBadge({ extracted: true })).toBe('已提取正文');
    expect(attachmentBadge({ transcript: 'x', extracted: 1 })).toBe('已转写 · 已提取正文');
  });
  it('两者皆空 / 缺失 → 空串（不渲染徽标）', () => {
    expect(attachmentBadge({})).toBe('');
    expect(attachmentBadge({ transcript: '', extracted: false })).toBe('');
    expect(attachmentBadge(null)).toBe('');
  });
});

describe('downloadFileName', () => {
  it('正常文件名原样返回（含空白裁剪）', () => {
    expect(downloadFileName({ name: '报告.pdf' })).toBe('报告.pdf');
    expect(downloadFileName({ name: '  a.md  ' })).toBe('a.md');
  });
  it("'blob'/无名 → 用 id 兜底可读名", () => {
    expect(downloadFileName({ name: 'blob', id: 'ab12' })).toBe('attachment-ab12');
    expect(downloadFileName({ name: 'BLOB', id: 'ab12' })).toBe('attachment-ab12');
    expect(downloadFileName({ name: '', id: 'x1' })).toBe('attachment-x1');
    expect(downloadFileName({})).toBe('attachment-file');
  });
});

// 附件格式细分：同一批代表扩展名在桌面端 attachmentKind.test.mjs 里也有断言，
// 两端口径必须一致（两个 app 各自构建，表只能各存一份，靠测试对齐）。
describe('attachmentFormat（显示细分，不参与处理链路）', () => {
  it('用户点名的格式各归其桶', () => {
    const cases = [
      ['report.pdf', 'pdf'],
      ['demo.mp4', 'video'],
      ['合同.docx', 'doc'],
      ['notes.txt', 'text'],
      ['screenshot.png', 'image'],
      ['photo.jpg', 'image'],
      ['budget.xlsx', 'sheet'],
      ['pitch.pptx', 'slide'],
      ['voice.mp3', 'audio'],
      ['src.zip', 'archive'],
      ['Composer.tsx', 'code'],
      ['README.md', 'md'],
    ];
    for (const [name, format] of cases) {
      expect(attachmentFormat({ name, kind: 'other' })).toBe(format);
    }
  });

  it('md 与 txt 分开（同是 text kind，但不是同一种东西）', () => {
    expect(attachmentFormat({ name: 'README.md', kind: 'text' })).toBe('md');
    expect(attachmentFormat({ name: 'notes.txt', kind: 'text' })).toBe('text');
  });

  it('扩展名大小写不敏感', () => {
    expect(attachmentFormat({ name: 'REPORT.PDF', kind: 'document' })).toBe('pdf');
    expect(attachmentFormat({ name: 'Clip.MP4', kind: 'video' })).toBe('video');
  });

  it('没有扩展名时按后端 kind 兜底', () => {
    expect(attachmentFormat({ name: 'blob', kind: 'document' })).toBe('doc');
    expect(attachmentFormat({ name: 'blob', kind: 'image' })).toBe('image');
    expect(attachmentFormat({ name: 'blob', kind: 'audio' })).toBe('audio');
    expect(attachmentFormat({ name: 'blob', kind: 'other' })).toBe('file');
    expect(attachmentFormat({ name: 'blob' })).toBe('file');
    expect(attachmentFormat(null)).toBe('file');
  });

  it('认不出的扩展名不瞎猜，回落到 kind', () => {
    expect(attachmentFormat({ name: 'firmware.bin', kind: 'document' })).toBe('doc');
    expect(attachmentFormat({ name: 'firmware.bin', kind: 'other' })).toBe('file');
    expect(attachmentFormat({ name: '.gitignore', kind: 'text' })).toBe('text');
  });

  it('FILE_FORMATS 清单与 12 个桶一致（FileTypeIcon 按它校验字形）', () => {
    expect(FILE_FORMATS).toEqual([
      'image', 'pdf', 'doc', 'sheet', 'slide', 'video',
      'audio', 'archive', 'code', 'md', 'text', 'file',
    ]);
  });
});

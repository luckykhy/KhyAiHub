// [DESIGN-ARCH-163] D9 —— attachmentView 纯函数单测（表驱动）。
import { describe, it, expect } from 'vitest';
import {
  THUMBS_KEY,
  readThumbsFlag,
  isImageAttachment,
  attachmentBadge,
  downloadFileName,
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

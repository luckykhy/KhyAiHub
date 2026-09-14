/**
 * D8.1 paste-attachment wiring contract ([DESIGN-ARCH-163]).
 *
 * The web chat composer used to silently drop pasted screenshots (the
 * "零图" bug): ChatInputBar had no paste handler at all. These tests pin the
 * fix at source level (same approach as interaction.wiring.test.js — the
 * views import Vue and `@/` aliases so mounting is not available):
 *
 *   1. ChatInputBar listens for paste, forwards non-file pastes untouched,
 *      and emits 'paste-attachments' with the clipboard File list otherwise;
 *   2. AIChat binds that event to a handler that reuses the SAME upload loop
 *      as the file picker (FormData 'file' → POST /api/ai/upload);
 *   3. the handler honors the localStorage kill switch
 *      'khy.webPasteAttachment' === '0' (fall back to legacy drop).
 *
 * Run: npx vitest run src/views/chatInputPaste.wiring.test.js
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');

const barSrc = readFileSync(join(srcRoot, 'views/components/ChatInputBar.vue'), 'utf8');
const chatSrc = readFileSync(join(srcRoot, 'views/AIChat.vue'), 'utf8');

function sliceFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let k = brace; k < src.length; k += 1) {
    if (src[k] === '{') depth += 1;
    else if (src[k] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, k + 1);
    }
  }
  return '';
}

describe('ChatInputBar: paste is intercepted only for clipboard files', () => {
  it('textarea binds @paste and declares the paste-attachments emit', () => {
    expect(barSrc).toMatch(/@paste="onComposerPaste"/);
    expect(barSrc).toMatch(/defineEmits\(\[[\s\S]*'paste-attachments',/);
  });

  it('onComposerPaste: skips while loading; text-only paste keeps native behavior', () => {
    const fn = sliceFn(barSrc, 'onComposerPaste');
    expect(fn, 'onComposerPaste must exist').toBeTruthy();
    expect(fn).toMatch(/if \(props\.loading\) return;/);
    // files list is read from clipboardData and an EMPTY list must return
    // BEFORE any preventDefault — otherwise plain text paste breaks.
    const filesIdx = fn.search(/clipboardData\?\.files/);
    const emptyReturnIdx = fn.search(/if \(!files\.length\) return;/);
    const preventIdx = fn.indexOf('event.preventDefault()');
    expect(filesIdx).toBeGreaterThanOrEqual(0);
    expect(emptyReturnIdx).toBeGreaterThan(filesIdx);
    expect(preventIdx).toBeGreaterThan(emptyReturnIdx);
  });

  it('emits the File array to the parent', () => {
    const fn = sliceFn(barSrc, 'onComposerPaste');
    expect(fn).toMatch(/emit\('paste-attachments',\s*files\)/);
  });
});

describe('AIChat: pasted files reuse the existing /api/ai/upload pipeline', () => {
  it('template binds paste-attachments to onPasteAttachments', () => {
    expect(chatSrc).toMatch(/@paste-attachments="onPasteAttachments"/);
  });

  it('kill switch: localStorage khy.webPasteAttachment === "0" disables the feature', () => {
    const fn = sliceFn(chatSrc, 'onPasteAttachments');
    expect(fn, 'onPasteAttachments must exist').toBeTruthy();
    expect(fn).toMatch(/localStorage\.getItem\('khy\.webPasteAttachment'\)\s*===\s*'0'\)\s*return/);
  });

  it('picker and paste share ONE upload loop hitting /api/ai/upload with field "file"', () => {
    const picker = sliceFn(chatSrc, 'onFilesSelected');
    const paste = sliceFn(chatSrc, 'onPasteAttachments');
    const loop = sliceFn(chatSrc, 'uploadAttachmentFiles');
    expect(picker).toMatch(/await uploadAttachmentFiles\(files\)/);
    expect(paste).toMatch(/await uploadAttachmentFiles\(list\)/);
    expect(loop).toMatch(/form\.append\('file', file\)/);
    expect(loop).toMatch(/resolveApiUrl\('\/api\/ai\/upload'\)/);
    expect(loop).toMatch(/method:\s*'POST'/);
    // Success path still registers attachments by id, failures stay per-file.
    expect(loop).toMatch(/if \(att && att\.id\) pendingAttachments\.value\.push\(att\)/);
    expect(loop).toMatch(/上传失败/);
  });
});

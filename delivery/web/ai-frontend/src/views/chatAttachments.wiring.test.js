/**
 * D9 attachment echo wiring contract — [DESIGN-ARCH-163] §D9.
 *
 * Root fact (reproduced live, see .khy/feedback/d9-attachment-echo-2026-09-27/):
 * GET /api/ai/upload/:id authenticates ONLY via Authorization/X-API-Key headers,
 * so a bare <img src="/api/ai/upload/x"> or <a href> navigation always 401s.
 * The echo UI must therefore fetch through authedFetch → blob → objectURL,
 * and the sentinel defect this test locks is "never put att.url into a raw
 * src/href navigation attribute again".
 *
 * Source-level assertions (no @vue/test-utils in this app, same convention as
 * chatInputPaste.wiring.test.js / nav.wiring.test.js):
 *   1. MessageAttachment.vue imports authedFetch, uses silent:true, creates &
 *      revokes object URLs with a bounded cache; never binds att.url raw.
 *   2. AIChat.vue gates all new chrome behind attachmentThumbs (localStorage
 *      'khy.attachmentThumbs' === '0' → old markup, byte-identical DOM).
 *   3. The legacy <a target=_blank> bubble block survives under v-else.
 *   4. Local input thumbs are revoked on remove/send/new-conversation and are
 *      stripped from the persisted message snapshot (no blob: URLs in history).
 *   5. Failed uploads leave a retryable trace only while the gate is on.
 *
 * Run: node_modules/.bin/vitest run src/views/chatAttachments.wiring.test.js
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');

const viewSrc = readFileSync(join(srcRoot, 'views/AIChat.vue'), 'utf8');
const compSrc = readFileSync(join(srcRoot, 'views/components/MessageAttachment.vue'), 'utf8');
const utilSrc = readFileSync(join(srcRoot, 'utils/attachmentView.js'), 'utf8');

function sliceFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return '';
  let i = src.indexOf('{', start);
  let depth = 0;
  for (let k = i; k < src.length; k += 1) {
    if (src[k] === '{') depth += 1;
    else if (src[k] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, k + 1);
    }
  }
  return '';
}

describe('D9 MessageAttachment.vue: blob 认证通道，禁裸 URL 导航', () => {
  it('imports authedFetch + attachmentView helpers', () => {
    expect(compSrc).toMatch(/import\s*\{\s*authedFetch\s*\}\s*from\s*'@\/api\/authedFetch'/);
    expect(compSrc).toMatch(/from\s*'@\/utils\/attachmentView'/);
  });
  it('附件拉取走 authedFetch(..., { silent: true })，失败不触发整页登出', () => {
    expect(compSrc).toMatch(/authedFetch\(\s*resolveApiUrl\(key\)\s*,\s*\{\s*silent:\s*true\s*\}\s*\)/);
  });
  it('blob → objectURL，并有封顶回收（create 与 revoke 配对存在）', () => {
    expect(compSrc).toMatch(/URL\.createObjectURL\(await res\.blob\(\)\)/);
    expect(compSrc).toMatch(/URL\.revokeObjectURL\(/);
    expect(compSrc).toMatch(/MAX_CACHED\s*=\s*64/);
  });
  it('失败不缓存：null 结果从缓存剔除，下次可重试', () => {
    expect(compSrc).toMatch(/if\s*\(!u\)\s*_blobCache\.delete\(key\)/);
  });
  it('红线：att.url 只能出现在 authedFetch 通道里，禁止裸 :src=/:href= 导航', () => {
    expect(compSrc).not.toMatch(/:src="[^"]*att\.url/);
    expect(compSrc).not.toMatch(/:href="[^"]*att\.url/);
  });
  it('过期/拉取失败 → 灰置「附件已不可用」而非空白或死链', () => {
    expect(compSrc).toContain('附件已不可用');
    expect(compSrc).toMatch(/chat-attachment-expired/);
  });
});

describe('D9 attachmentView.js: 门控键与默认语义', () => {
  it("门控键为 'khy.attachmentThumbs'，仅显式 '0' 关闭", () => {
    expect(utilSrc).toMatch(/THUMBS_KEY\s*=\s*'khy\.attachmentThumbs'/);
    expect(utilSrc).toMatch(/getItem\(THUMBS_KEY\)\s*===\s*'0'/);
  });
  it('storage 抛错 fail-soft → 默认开', () => {
    expect(sliceFn(utilSrc, 'readThumbsFlag')).toMatch(/catch\s*\{\s*return true/);
  });
});

describe('D9 AIChat.vue: 输出区接线', () => {
  it('门控求值一次：const attachmentThumbs = readThumbsFlag(localStorage)', () => {
    expect(viewSrc).toMatch(/const attachmentThumbs = readThumbsFlag\(localStorage\)/);
  });
  it('门控开 → MessageAttachment 渲染 msg.attachments', () => {
    expect(viewSrc).toMatch(/<template v-if="attachmentThumbs">\s*<MessageAttachment v-for="att in msg\.attachments"/);
  });
  it('门控关 → 旧 <a target=_blank> chip block 原样保留（v-else，逐字节现状）', () => {
    const elseIdx = viewSrc.indexOf('<template v-else>');
    expect(elseIdx).toBeGreaterThan(-1);
    const legacy = viewSrc.slice(elseIdx, elseIdx + 900);
    expect(legacy).toMatch(/<a\s+v-for="att in msg\.attachments"[\s\S]*?:href="resolveApiUrl\(att\.url\)"[\s\S]*?target="_blank"/);
  });
});

describe('D9 AIChat.vue: 输入区缩略图 / 徽标 / 快照净化', () => {
  it('图片上传成功后建本地 objectURL 缩略图，且只挂第一个描述符', () => {
    const fn = sliceFn(viewSrc, 'uploadAttachmentFiles');
    expect(fn).toMatch(/URL\.createObjectURL\(file\)/);
    expect(fn).toMatch(/startsWith\('image\/'\)/);
    // 挂载后立即置空，防两个 chip 共享同一 URL 被提前 revoke
    expect(fn).toMatch(/pendingAttachments\.value\.push\(\{ \.\.\.att, thumbUrl \}\);\s*thumbUrl = ''/);
  });
  it('removeAttachment 回收 thumbUrl', () => {
    expect(sliceFn(viewSrc, 'removeAttachment')).toMatch(/revokeObjectURL\(att\.thumbUrl\)/);
  });
  it('sendMessage：持久化快照剥离并回收 thumbUrl（历史里不留 blob: 死链）', () => {
    const fn = sliceFn(viewSrc, 'sendMessage');
    expect(fn).toMatch(/revokeObjectURL\(a\.thumbUrl\)/);
    expect(fn).toMatch(/const \{ thumbUrl, \.\.\.rest \} = a/);
  });
  it('newConversation 清空前回收所有本地缩略图', () => {
    const fn = sliceFn(viewSrc, 'newConversation');
    expect(fn).toMatch(/revokeObjectURL\(a\.thumbUrl\)/);
  });
  it('pending chip 的 thumb/badge 全部挂 attachmentThumbs 条件（关 = 不渲染）', () => {
    expect(viewSrc).toMatch(/v-if="attachmentThumbs && att\.thumbUrl"/);
    expect(viewSrc).toMatch(/v-if="attachmentThumbs && attachmentBadge\(att\)"/);
  });
});

describe('D9 AIChat.vue: 上传失败留痕（仅门控开时记录）', () => {
  it('两个失败分支（非 2xx 与异常）都在门控开时 push failedUploads', () => {
    const fn = sliceFn(viewSrc, 'uploadAttachmentFiles');
    const pushes = fn.match(/if \(attachmentThumbs\) failedUploads\.value\.push\(\{ name: file\.name, file, reason \}\)/g) || [];
    expect(pushes.length).toBe(2);
  });
  it('重试走回同一条上传管线（复用 uploadAttachmentFiles），忽略只移除记录', () => {
    const retry = sliceFn(viewSrc, 'retryFailedUpload');
    expect(retry).toMatch(/failedUploads\.value\.splice\(index, 1\)/);
    expect(retry).toMatch(/uploadAttachmentFiles\(\[entry\.file\]\)/);
    expect(sliceFn(viewSrc, 'dismissFailedUpload')).toMatch(/failedUploads\.value\.splice\(index, 1\)/);
  });
  it('失败 chip 渲染重试/忽略按钮，容器 v-if 含 failedUploads.length', () => {
    expect(viewSrc).toMatch(/v-if="pendingAttachments\.length \|\| uploadingCount \|\| failedUploads\.length"/);
    expect(viewSrc).toMatch(/@click="retryFailedUpload\(fi\)"/);
    expect(viewSrc).toMatch(/@click="dismissFailedUpload\(fi\)"/);
  });
});

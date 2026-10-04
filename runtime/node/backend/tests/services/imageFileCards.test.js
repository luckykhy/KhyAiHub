'use strict';

/**
 * [DESIGN-ARCH-163] D6 多格式附件说明书（pdf/docx/md/txt/csv…）的确定性测试（node:test）。
 *
 * 锁定:
 *  ① extractAllFileReferences: 文档/文本扩展集、引号带空格、图片扩展名**不**落入本集合;
 *  ② buildFileCard: 摘录分支(截断+引擎+read 工具指引) / 未提取分支(诚实 failNote);
 *  ③ buildContextCard 混合附件: 【附件对照】同时列 图i 与 文件j,分开编号;
 *  ④ attachContextCard 端到端: 无图纯文本消息中的 .md 路径 → 直读摘录卡;
 *     不存在的路径 → 诚实「文件不存在」;KHY_FILE_CARDS=0 → prompt 逐字节不变;
 *  ⑤ 图/文去重: 图片 label 与文件路径同物 → 只出图卡不出文件卡。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractAllFileReferences } = require('../../src/cli/repl/inlineFileRefs');
const leaf = require('../../src/services/imageContextCard');
const svc = require('../../src/services/imageContextCardService');

// ── ① 文件路径扫描 ─────────────────────────────────────────────────────────
test('extractAllFileReferences: md/pdf/csv 命中,按出现序', () => {
  const r = extractAllFileReferences('对照 /data/spec.md 和 D:\\doc\\plan.pdf 以及 C:/d/x.csv');
  assert.deepStrictEqual(
    r.map((e) => e.filePath),
    ['/data/spec.md', 'D:\\doc\\plan.pdf', 'C:/d/x.csv']
  );
});

test('extractAllFileReferences: 图片扩展名不落文件集(两扫描器集合不相交)', () => {
  const r = extractAllFileReferences('看 C:\\shots\\a.png 和 C:\\docs\\b.md');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].filePath, 'C:\\docs\\b.md');
});

test('extractAllFileReferences: 引号含空格路径可捕获', () => {
  const r = extractAllFileReferences('读 "C:\\my docs\\spec 2.md" 谢谢');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].filePath, 'C:\\my docs\\spec 2.md');
});

// ── ② buildFileCard ───────────────────────────────────────────────────────
test('buildFileCard: 摘录分支含引擎/截断/read 指引', () => {
  const out = leaf.buildFileCard({
    index: 1,
    total: 2,
    source: '/data/spec.md',
    kind: 'text',
    sizeBytes: 2048,
    engine: '直读',
    text: '前 4000 字内容',
    truncated: true,
  });
  assert.match(out, /【文件说明书 1\/2】/);
  assert.match(out, /- 类型: 文本 · 2\.0KB/);
  assert.match(out, /- 提取: 直读（截断，前 \d+ 字）/);
  assert.match(out, /【正文摘录】/);
  assert.match(out, /read 工具/);
});

test('buildFileCard: 未提取分支诚实标 failNote,不假装有正文', () => {
  const out = leaf.buildFileCard({
    index: 2,
    total: 2,
    source: '/data/old.doc',
    kind: 'document',
    sizeBytes: 100,
    failNote: '该格式暂无正文提取通道，仅登记引用',
  });
  assert.match(out, /- 提取: 未提取（该格式暂无正文提取通道，仅登记引用）/);
  assert.ok(!out.includes('【正文摘录】'));
});

// ── ③ 混合附件对照表 ───────────────────────────────────────────────────────
test('buildContextCard: 图+文件混合出统一【附件对照】,分开编号', () => {
  const out = leaf.buildContextCard(
    [{ source: 'C:\\s\\a.png', sizeBytes: 2048, width: 10, height: 10, format: 'png', index: 1 }],
    {
      turnTotal: 1,
      fileCards: [{ index: 1, source: '/data/spec.md', kind: 'text', sizeBytes: 100, text: 'x'.repeat(700), truncated: false }],
      fileTotal: 1,
    }
  );
  assert.match(out, /【附件对照 2\/2】/);
  assert.ok(out.includes('图1=C:\\s\\a.png；文件1=\/data\/spec.md'));
  assert.match(out, /指代约定：用户提到「图i」「文件j」/);
  assert.match(out, /【图片说明书 1\/1】/);
  assert.match(out, /【文件说明书 1\/1】/);
});

// ── ④⑤ attachContextCard 端到端 ───────────────────────────────────────────
function tmpFile(name, content) {
  const dir = path.join(os.tmpdir(), 'khy-filecard-test');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

test('attachContextCard: 无图纯文本消息中的 .md 路径 → 直读摘录卡', async () => {
  const p = tmpFile('d6spec.md', '# 退款流程\n条件1: 已发货\n条件2: 7天内');
  const out = await svc.attachContextCard(`按 ${p} 实现校验逻辑`, {}, {});
  assert.notStrictEqual(out, `按 ${p} 实现校验逻辑`, '应追加卡片');
  assert.match(out, /【文件说明书 1\/1】/);
  assert.ok(out.includes('条件1: 已发货'), '正文摘录应进入 prompt');
});

test('attachContextCard: 不存在的路径 → 诚实「文件不存在」卡', async () => {
  const out = await svc.attachContextCard('看 /no/such/dir/ghost.md', {}, {});
  assert.match(out, /- 提取: 未提取（文件不存在或不可读/);
});

test('attachContextCard: KHY_FILE_CARDS=0 → prompt 逐字节不变', async () => {
  const p = tmpFile('d6off.md', '内容');
  const prompt = `读 ${p}`;
  const out = await svc.attachContextCard(prompt, {}, { KHY_FILE_CARDS: '0' });
  assert.strictEqual(out, prompt);
});

test('attachContextCard: 图片 label 与文件路径同物 → 去重不出文件卡(键归一化生效)', async () => {
  const p = tmpFile('d6dup.md', 'dup body');
  const b64 = Buffer.concat([
    (() => {
      const b = Buffer.alloc(33);
      b.writeUInt32BE(0x89504e47, 0);
      b.write('IHDR', 12, 'ascii');
      b.writeUInt32BE(10, 16);
      b.writeUInt32BE(10, 20);
      return b;
    })(),
    Buffer.alloc(64),
  ]).toString('base64');
  const out = await svc.attachContextCard(`比较 ${p}`, { images: [{ base64: b64, mimeType: 'image/png', label: p }] }, {});
  assert.ok(!out.includes('【文件说明书'), 'label 命中同一归一化路径 → 文件面跳过');
});

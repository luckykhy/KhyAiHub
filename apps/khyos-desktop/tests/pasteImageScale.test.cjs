'use strict';

// pasteImageScale.test.cjs — 粘贴图片必须先缩放再 base64
//
// 2026-11-04 用户点名：剪贴板里的整屏截图原样 base64 送进 IPC，既撑大载荷，
// 也超出视觉模型的长边上限。约定是「长边压到 1568 → 重编码 JPEG → 再 base64」，
// 并且落盘文件名必须带扩展名（否则附件预览按扩展名判 MIME 会判成“不是图片”）。
//
// 断言走源码扫描（与 composerInputFrame 同款）：这几条是「不许退回旧形态」的
// 约定，代码改回原样 base64 时测试即红。

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const projectRoot = join(__dirname, '..');
const read = (...parts) => {
  const file = join(projectRoot, ...parts);
  return existsSync(file) ? readFileSync(file, 'utf-8') : '';
};

const imagePasteSrc = read('src', 'renderer', 'components', 'composer', 'imagePaste.ts');
const composerSrc = read('src', 'renderer', 'components', 'composer', 'Composer.tsx');
const mainSrc = read('src', 'main', 'index.ts');

test('P1: 缩放模块存在，长边上限与重编码链路齐全', () => {
  assert.ok(imagePasteSrc, '应存在 composer/imagePaste.ts');
  assert.match(imagePasteSrc, /PASTE_IMAGE_MAX_EDGE\s*=\s*1568/, '长边上限应是 1568（视觉模型推荐的输入上限）');
  assert.match(imagePasteSrc, /createImageBitmap\(/, '应走浏览器解码拿真实宽高，而不是猜');
  assert.match(imagePasteSrc, /imageSmoothingQuality\s*=\s*'high'/, '缩小必须用高质量插值，否则文字截图会糊');
  assert.match(imagePasteSrc, /ctx\.drawImage\(bitmap, 0, 0, width, height\)/, '应按缩放后的尺寸重绘');
  assert.match(imagePasteSrc, /'image\/jpeg'/, '重编码目标是 JPEG（视觉通道与预览都认）');
  assert.match(imagePasteSrc, /export async function preparePastedImage/, '对外入口应是 preparePastedImage');
});

test('P1: 小图原样返回，GIF 不做有损重编码', () => {
  assert.match(
    imagePasteSrc,
    /longest <= PASTE_IMAGE_MAX_EDGE && file\.size <= PASTE_IMAGE_MAX_BYTES/,
    '已经够小的图不应二次有损压缩'
  );
  assert.match(
    imagePasteSrc,
    /sourceMime === 'image\/gif'/,
    'GIF 必须跳过重编码：canvas 只会留下第一帧'
  );
});

test('P1: 落盘文件名带扩展名，避免预览按错 MIME 解码', () => {
  assert.match(imagePasteSrc, /fileNameWithExt\(file\.name, 'image\/jpeg'\)/, 'JPEG 输出应换成 .jpg/.jpeg 扩展名');
  assert.match(imagePasteSrc, /EXT_BY_MIME/, '扩展名映射应覆盖常见图片格式');
});

test('P2: Composer 粘贴走缩放模块，不再直接 readAsDataURL 原图', () => {
  assert.match(composerSrc, /import \{ preparePastedImage \} from '\.\/imagePaste'/, 'Composer 应引入 preparePastedImage');
  assert.match(composerSrc, /await preparePastedImage\(file\)/, '粘贴循环应先缩放再 base64');
  assert.doesNotMatch(composerSrc, /function fileToBase64/, '旧的裸 base64 函数应已删除');
  assert.doesNotMatch(composerSrc, /readAsDataURL/, 'Composer 不应再自己读原始文件');
});

test('P3: 主进程对粘贴载荷有上限，超限给可执行的替代做法', () => {
  const handler = mainSrc.match(/ipcMain\.handle\('fs:saveClipboardFile'[\s\S]*?\n  \}\)/);
  assert.ok(handler, '应能找到 fs:saveClipboardFile 的处理函数');
  assert.match(handler[0], /CLIPBOARD_MAX_BYTES\s*=\s*32 \* 1024 \* 1024/, '应有 32 MB 上限');
  assert.match(handler[0], /base64\.length >/, '应在解码前先按 base64 长度拦截');
  assert.match(handler[0], /添加附件/, '超限错误应给出替代入口，而不是只说失败');
});

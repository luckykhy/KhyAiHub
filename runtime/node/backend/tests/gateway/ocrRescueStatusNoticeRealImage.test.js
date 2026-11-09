'use strict';

/**
 * ocrRescueStatusNoticeRealImage.test.js — 用**真实文字图 + 真实 tesseract** 核验 OPS-MAN-127 的
 * 「post-failure 救援网 OCR-成功 ⟹ 确定性发一条实时状态告知已降级到 OCR」不变量,直击本轮目标
 * 「Khy 降级到 OCR,要能无感明显告知用户用了 OCR 但正确识别图片」的**实时进度层**。
 *
 * 链路:gpt-4o → keep(图保留到主级联)→ 运行时某适配器 404/model_not_found 拒图 → shouldOcrRescue
 * 提升 _visionFallback → 救援网退回本地**真实** OCR。喂一张含文字真图(PIL 渲 'INVOICE 1234'),真
 * tesseract 读出文字 → 救援网 OCR 成功分支既注入 prompt 又(OPS-127)emitStatus 告知已降级到 OCR。
 * 经 options.onChunk 收集 {type:'status'} 断言:
 *   修复点:门开(默认) → 实时状态出现「已降级用本地 OCR 成功提取」且 prompt 含真读出的 /INVOICE/;
 *   门关:KHY_OCR_RESCUE_STATUS=off → 逐字节回退(救援网成功状态不出现,OCR 文本照旧注入)。
 *
 * 缺 tesseract/eng 字库/Pillow,或本机 tesseract 未能从该图读出目标词 → skip(不误判红)。
 *
 * harness 统一自 `_ocrGatewayHarness`(参数化工厂),各文件不再各自复制。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const genLeaf = require(BE + '/src/services/gateway/aiGatewayGenerateMethod');
const h = require('./_ocrGatewayHarness');

const env = h.envSandbox(['KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL', 'KHY_VISION_INTERMEDIATE_MESSAGE', 'KHY_VISION_OCR_FALLBACK', 'KHY_OCR_RESCUE_STATUS']);
const runner = h.makeRunner({ prompt: '请描述图片中的关键信息', model: 'gpt-4o', tag: 'real-rescuestatus' });
const _RESCUE_RE = /已降级用本地 OCR 成功提取/;
const fx = h.makeRealOcrFixture({ prefix: 'khy-ocr-rescuestatus-' });
const life = h.makeRealOcrLifecycle({ env, genLeaf, fx });

describe('真实文字图 + 真 tesseract 读出 + 救援网 OCR 成功 → 确定性实时状态告知(OPS-MAN-127)', () => {
  before(life.beforeAll);
  after(life.afterAll);

  test('修复点:真文字图 + 真 tesseract 读出 + 状态门开 → 实时状态出现「已降级用本地 OCR」且 prompt 含 INVOICE', async (t) => {
    if (fx.skipped) { t.skip('缺 tesseract/eng 字库/Pillow'); return; }
    if (!fx.reads()) { t.skip('本机 tesseract 未从该图读出 INVOICE,无法制造 OCR-成功场景'); return; }

    delete process.env.KHY_OCR_RESCUE_STATUS; // 默认开
    const rec = h.makeRecordingAdapter({ content: '发票编号是 1234' });
    h.wireCascade(h.makeRejectAdapter(), rec);
    const { res, statuses } = await runner.runCapture({ images: fx.images() });
    assert.equal(res.success, true);
    assert.match(rec.finalPrompt || '', /INVOICE/i, '真实链路:真 tesseract 读出的文字进入 prompt(准确识别)');
    assert.ok(statuses.some((s) => _RESCUE_RE.test(s)), `修复:救援网 OCR 成功当场发实时状态;实收=${JSON.stringify(statuses)}`);
  });

  test('门关(KHY_OCR_RESCUE_STATUS=off) → 逐字节回退(救援网成功状态不出现,OCR 文本照旧注入)', async (t) => {
    if (fx.skipped) { t.skip('缺 tesseract/eng 字库/Pillow'); return; }
    if (!fx.reads()) { t.skip('本机 tesseract 未从该图读出 INVOICE'); return; }

    process.env.KHY_OCR_RESCUE_STATUS = 'off';
    const rec = h.makeRecordingAdapter({ content: '发票编号是 1234' });
    h.wireCascade(h.makeRejectAdapter(), rec);
    const { res, statuses } = await runner.runCapture({ images: fx.images() });
    assert.equal(res.success, true);
    assert.match(rec.finalPrompt || '', /INVOICE/i, '门关:OCR 文字照旧读出并注入(能力不受影响)');
    assert.ok(!statuses.some((s) => _RESCUE_RE.test(s)), `门关:历史静默,救援网成功状态不出现;实收=${JSON.stringify(statuses)}`);
  });
});

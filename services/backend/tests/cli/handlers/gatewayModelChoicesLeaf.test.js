'use strict';
/**
 * Leaf-contract test for gatewayModelChoices.js (extracted from cli/handlers/gateway.js).
 *
 * Proves: (1) the leaf exports the model-selection handlers + the DI setter as functions; (2) the
 * host re-imports every handler by the SAME name so the classic-CLI selector AND the Ink TUI
 * ModelPicker (both consume buildGatewayModelChoices) keep a byte-identical contract; (3)
 * setGatewayModelChoicesDeps is a guarded, idempotent, non-throwing DI setter that wires the 24
 * function callbacks plus the shared STRICT_OPERATIONAL_ADAPTERS value (function guards ignore
 * non-functions; the Set value is wired when truthy).
 *
 * The leaf performs IO (multi-second adapter probes, interactive prompts, .env persistence, terminal
 * output) so it does NOT self-declare as a pure zero-IO leaf; the assertions below stay on the
 * deterministic surface (export shape, contract identity, setter guard) and never invoke an IO handler.
 *
 * [DESIGN-ARCH-167] §12-Q12 追加：经典 REPL `/model` 与 TUI `ModelPicker` 共用
 * `cli/modelChoiceGrouping` 的同一套分组/分层语义。这部分的判据全部落在**纯函数**上
 * （`buildClassicInquirerChoices` / `buildClassicNumericLines` / `resolveNumericPick`）——
 * 真起 inquirer 才能验的东西不该只能靠手测。
 */
const LEAF = '../../../src/cli/handlers/gatewayModelChoices';
const HOST = '../../../src/cli/handlers/gateway';
const HANDLERS = [
  'buildGatewayModelChoices',
  'applyGatewayModelSelection',
  'handleGatewaySelectModel',
  'buildVendorModelChoices',
  'handleModelSwitchByVendor',
];

describe('Gateway Model Choices Leaf', () => {
  test('leaf exports the model-selection handlers + setter as functions', () => {
      const leaf = require(LEAF);
      for (const n of [...HANDLERS, 'setGatewayModelChoicesDeps']) {
        expect(typeof leaf[n]).toBe('function', `missing ${n}`);
      }
  });

  test('host re-imports the handlers by the same names (contract intact for CLI + TUI ModelPicker)', () => {
      const host = require(HOST);
      for (const n of HANDLERS) {
        expect(typeof host[n]).toBe('function', `host missing ${n}`);
      }
  });

  test('setGatewayModelChoicesDeps is a guarded, idempotent, non-throwing DI setter', () => {
      const { setGatewayModelChoicesDeps } = require(LEAF);
      expect(() => setGatewayModelChoicesDeps()).not.toThrow();
      expect(() => setGatewayModelChoicesDeps({})).not.toThrow();
      // Non-function deps ignored; falsy STRICT ignored.
      expect(() => setGatewayModelChoicesDeps({ promptWithReplGuard: 1, isAdapterOperational: null, STRICT_OPERATIONAL_ADAPTERS: null })).not.toThrow();
      // Idempotent re-injection across the full 24-fn surface + the shared Set value.
      const fakeDeps = { STRICT_OPERATIONAL_ADAPTERS: new Set(['codex']) };
      for (const n of ['promptWithReplGuard', '_getDeepProbeCache', '_setDeepProbeCache', '_getAdapterProbeTimeoutMs',
        '_getAdapterModelListTimeoutMs', 'shouldTreatGenerationFailureAsWarning', '_compactReasonText',
        '_isTimeoutLikeReason', '_isTransientProbeLikeReason', '_classifyHiddenReason', '_shouldRetryProbeByDebounce',
        '_formatModelSourceTag', '_formatConnectionTag', '_formatUpstreamTag', '_formatVisionTag',
        '_resolvePreferredAdapterIssue', '_filterModelsByReliability', 'maybeAutoSyncSwitchCenterForGateway',
        'getTokenInfoForSelection', 'askLine', 'recoverGatewayPromptInput', 'withTimeout', 'isAdapterOperational',
        'persistGatewayPreference']) {
        fakeDeps[n] = () => undefined;
      }
      expect(() => setGatewayModelChoicesDeps(fakeDeps)).not.toThrow();
      expect(() => setGatewayModelChoicesDeps(fakeDeps)).not.toThrow();
  });

  /**
   * [DESIGN-ARCH-167] §11「另一个表面」：经典 REPL `/model` 过去把 `c.name` **平铺**给
   * inquirer，真数据实测 94% 的行重复 `(执行:…)`、宽度中位 91 列（80 列终端下每行折 2 行）。
   * 现在它和 TUI 共用 `cli/modelChoiceGrouping` 同一套分组/分层 —— 这组断言钉住：
   * ① 组边界真的插了 Separator；② 模型行真的只用 primary + 次信息；
   * ③ 数字兜底的**编号与显示序一致**（归并后不能按原始下标取）。
   * 真起 inquirer 才能验的东西不该只能靠手测 ⇒ `inquirer`/`chalk` 由参数注入。
   */
  describe('classic /model 列表：分组 + 分层（与 TUI 同一套语义）', () => {
    // 与真数据同构：`name` 里同时夹着供应商前缀与状态/执行方（改前的病征），
    // 而 `secondary` 只留**行级**信息、`groupMeta` 是被上移的**组级**三件套。
    const at = (g, i, extra) => Object.assign({
      name: `${g} / ${g}-${i}  [可用] (执行:svc/api)`,
      group: g,
      primary: `${g}-${i}`,
      secondary: '[未证实·内置]',
      groupMeta: '[可用] (执行:svc/api)',
      value: { adapter: 'api', model: `${g}-${i}` },
      disabled: false,
    }, extra || {});
    // A 被 B 隔开 ⇒ 归并（stableGroupOrder）真的会改变顺序
    const CHOICES = [at('A', 0), at('A', 1), at('B', 0), at('B', 1), at('B', 2), at('A', 2)];
    const DISPLAY = ['A-0', 'A-1', 'A-2', 'B-0', 'B-1', 'B-2'];

    // 最小 Separator 替身：只记 line，便于断言
    class FakeSeparator {
      constructor(line) {
        this.line = line;
        this.type = 'separator';
      }
    }
    const inquirerStub = { Separator: FakeSeparator };
    const chalkStub = {
      dim: (s) => `\u001b[2m${s}\u001b[22m`,
      white: (s) => `\u001b[37m${s}\u001b[39m`,
    };

    test('前提：夹具真的被重排（否则「编号一致」恒真）', () => {
      const grouping = require('../../../src/cli/modelChoiceGrouping');
      const shown = grouping.stableGroupOrder(CHOICES).map((c) => c.value.model);
      expect(shown).toEqual(DISPLAY);
      expect(shown).not.toEqual(CHOICES.map((c) => c.value.model));
    });

    test('inquirer choices：组边界是 Separator，模型行只放 primary + 次信息', () => {
      const { buildClassicInquirerChoices } = require(LEAF);
      const built = buildClassicInquirerChoices(CHOICES, inquirerStub, chalkStub);
      const seps = built.filter((c) => c.type === 'separator');
      const models = built.filter((c) => c.type !== 'separator');
      // A(3) 与 B(3) 两组 ⇒ 2 条分隔；单条组不画（这里没有单条组）
      expect(seps.map((s) => s.line.replace(/\u001b\[\d+m/g, ''))).toEqual([
        '── A · 3 个 ── [可用] (执行:svc/api)',
        '── B · 3 个 ── [可用] (执行:svc/api)',
      ]);
      // 顺序：标题 → 该组模型 → 标题 → 该组模型（分隔不能挤到末尾）
      expect(built.map((c) => (c.type === 'separator' ? 'S' : c.value.model))).toEqual([
        'S', 'A-0', 'A-1', 'A-2', 'S', 'B-0', 'B-1', 'B-2',
      ]);
      expect(models.map((c) => c.value.model)).toEqual(DISPLAY);
      // 模型行的 label 必须是分层后的两段，而不是原样照搬 c.name
      // （`c.name` 里带着 `A / ` 前缀与状态标签 —— 那正是「划分不清楚」的本体）
      for (const m of models) {
        const plain = m.name.replace(/\u001b\[\d+m/g, '');
        expect(plain).not.toContain('A / ');
        expect(plain).toMatch(/^[AB]-\d\s+\[未证实·内置\]$/);
      }
      // 选中值没被改动（value 直通，契约不变）
      expect(models[0].value).toEqual({ adapter: 'api', model: 'A-0' });
      expect(models[0].disabled).toBe(false);
    });

    test('数字兜底：编号只给模型行，且 `models[n-1]` 就是屏幕上第 n 行', () => {
      const { buildClassicNumericLines } = require(LEAF);
      const { lines, models } = buildClassicNumericLines(CHOICES, chalkStub);
      const plain = lines.map((l) => l.replace(/\u001b\[\d+m/g, ''));
      expect(plain).toEqual([
        '  ── A · 3 个 ── [可用] (执行:svc/api)',
        '  1. A-0  [未证实·内置]',
        '  2. A-1  [未证实·内置]',
        '  3. A-2  [未证实·内置]',
        '  ── B · 3 个 ── [可用] (执行:svc/api)',
        '  4. B-0  [未证实·内置]',
        '  5. B-1  [未证实·内置]',
        '  6. B-2  [未证实·内置]',
      ]);
      // 编号 → choice 的映射必须按**显示序**给（归并后原始下标是 A-0,A-1,B-0,B-1,B-2,A-2）
      expect(models.map((c) => c.value.model)).toEqual(DISPLAY);
      expect(models[2].value.model).toBe('A-2'); // 输入 3 必须是屏幕上第 3 行，不是 B-0
    });

    test('单条组不画分隔、孤儿段的组级信息回落到行内（不静默丢失）', () => {
      const { buildClassicInquirerChoices } = require(LEAF);
      const onlyOne = [at('A', 0), at('A', 1), at('X', 0), at('X', 1)];
      const built = buildClassicInquirerChoices(onlyOne, inquirerStub, chalkStub);
      // 两组都 >=2 ⇒ 都画；把 X 减到 1 条后应只剩 A 的分隔
      const oneSolo = [at('A', 0), at('A', 1), at('Solo', 0)];
      const built2 = buildClassicInquirerChoices(oneSolo, inquirerStub, chalkStub);
      expect(built.filter((c) => c.type === 'separator').length).toBe(2);
      expect(built2.filter((c) => c.type === 'separator').length).toBe(1);
      const solo = built2.find((c) => c.type !== 'separator' && c.value.model === 'Solo-0');
      // 没画标题 ⇒ groupMeta 必须出现在行内，否则该段的三件套整个消失
      expect(solo.name.replace(/\u001b\[\d+m/g, '')).toContain('(执行:svc/api)');
    });

    /**
     * ★ 这一组补的是**最后一个未覆盖的链接**：`buildClassicNumericLines` 给出了 `models`
     * （显示序），但真正把它接回模型的是 handler 里那一行 `picked = numeric.models[idx - 1]`。
     * 它原先内联在两处、零覆盖 —— 改回 `modelChoices[idx - 1]` 不会有任何断言变红，
     * 而症状恰好是本方案的主题：「屏幕上写 3.」与「按 3 选中」脱节。
     * 现已抽成纯函数 `resolveNumericPick`，判据挂在它身上。
     */
    test('数字兜底：输入编号 → 选中的是**显示序**那一条（不是原始下标）', () => {
      const { buildClassicNumericLines, resolveNumericPick } = require(LEAF);
      const numeric = buildClassicNumericLines(CHOICES, chalkStub);
      const plain = numeric.lines.map((l) => l.replace(/\u001b\[\d+m/g, ''));
      // 输入序 = A-0,A-1,**B-0**,B-1,B-2,A-2 ⇒ 原始下标第 3 个是 B-0
      // 显示序 = A-0,A-1,**A-2**,B-0,B-1,B-2 ⇒ 显示序第 3 个是 A-2
      expect(resolveNumericPick(numeric, '3').choice.value.model).toBe('A-2');
      expect(resolveNumericPick(numeric, '3').choice.value.model).not.toBe('B-0');
      // 屏幕自证：写着「3.」的那一行必须含 A-2（判据不只在内存里，也在上屏文本上）
      const line3 = plain.find((l) => /^\s+3\./.test(l));
      expect(line3).toContain('A-2');
      // 全量对齐：每一个编号 n ⇒ `resolveNumericPick(n)` 给出的 choice 就是第 n 个模型行
      const numbered = plain.filter((l) => /^\s+\d+\./.test(l));
      expect(numbered).toHaveLength(numeric.models.length);
      numbered.forEach((l, i) => {
        const n = Number(l.match(/^\s+(\d+)\./)[1]);
        expect(n).toBe(i + 1);
        expect(resolveNumericPick(numeric, String(n)).choice.value.model).toBe(
          numeric.models[i].value.model
        );
        expect(l).toContain(numeric.models[i].value.model);
      });
    });

    test('数字兜底：取消 / 越界 / 不可选 三条边界各自可辨（不混淆成同一种失败）', () => {
      const { buildClassicNumericLines, resolveNumericPick } = require(LEAF);
      const numeric = buildClassicNumericLines(CHOICES, chalkStub);
      // 取消：空输入 / 0 / 非数字（parseInt → NaN）
      for (const raw of ['0', '', '   ', null, undefined, 'abc']) {
        expect(resolveNumericPick(numeric, raw)).toEqual({ ok: false, reason: 'cancel' });
      }
      // 越界：正数超范围，以及负号开头（parseInt 得 -1，不是 0 ⇒ 不归到 cancel）
      expect(resolveNumericPick(numeric, '7')).toEqual({ ok: false, reason: 'out-of-range' });
      expect(resolveNumericPick(numeric, '-1')).toEqual({ ok: false, reason: 'out-of-range' });
      // 不可选：编号有效但该行 disabled ⇒ 必须与「越界」区分开（给用户的提示不同）
      const withDisabled = [at('A', 0, { disabled: true }), at('A', 1), at('B', 0), at('B', 1)];
      const nd = buildClassicNumericLines(withDisabled, chalkStub);
      expect(nd.models[0].disabled).toBe(true);
      expect(resolveNumericPick(nd, '1')).toEqual({ ok: false, reason: 'disabled' });
      expect(resolveNumericPick(nd, '2').ok).toBe(true);
      expect(resolveNumericPick(nd, '2').choice.value.model).toBe('A-1');
      // 空列表不该抛（handler 在 `empty` 分支才走到这里，但纯函数要 fail-soft）
      expect(resolveNumericPick({ models: [] }, '1')).toEqual({ ok: false, reason: 'out-of-range' });
      expect(resolveNumericPick(null, '1')).toEqual({ ok: false, reason: 'out-of-range' });
    });
  });

});


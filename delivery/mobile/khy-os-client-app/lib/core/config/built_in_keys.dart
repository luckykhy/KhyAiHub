// khy-canary: Khy-20261101-067-6F88WVEV
/// Built-in provider registry. The credential byte-arrays are EMPTY in the
/// repository (sanitized 2026-09-27: no keys, not even XOR-obfuscated ones, live
/// in git history). On a developer machine, regenerate the arrays locally:
///
///   python scripts/gen_keys.py    # reads ~/.khyquant/built-in-keys.json
///
/// then paste the output over the empty arrays WITHOUT committing it. The XOR
/// scheme below still guards the packaged APK (scripts/check_builtin_keys.py);
/// with empty arrays every built-in provider degrades to "no credential".
///
/// XOR key: 0xA3, 0x5F, 0xC2, 0x1B (4-byte rotation)
/// Decode:  s[i] = bytes[i] ^ KEY[i % 4]
///
/// ── 端点与钥匙同一套规矩 ────────────────────────────────────────────────
///
/// 两个「不希望端点明文出现在 APK 里」的内置提供商（khy-os 网关、opencode free）
/// 用 `_epXxx` 字节数组携带端点，仓库内同样保持空数组：
///
///   python scripts/gen_keys.py    # 同时生成钥匙与端点数组，一起贴回
///
/// 为什么端点也要藏：这些端点是「这个包连着哪」的答案。明文写在 APK 里，
/// 任何一次 `strings app.apk` 都能把它列出来——等于把自建网关的位置和免费档
/// 入口一起递给任何拿到安装包的人。R2 只强制密钥，但同一条理由适用于端点：
/// 该随包分发的只有混淆形态。
///
/// 数组为空时对应提供商显示「端点未配置」且不生效——与钥匙为空时显示
/// 「无内置密钥」是同一条降级路径，不会出现一个能选中却连不上的选项。

library;

class BuiltInKeys {
  static const _k0 = 0xA3, _k1 = 0x5F, _k2 = 0xC2, _k3 = 0x1B;
  static List<int> get _xorKey => [_k0, _k1, _k2, _k3];

  static String _decode(List<int> bytes) {
    final key = _xorKey;
    final sb = StringBuffer();
    for (var i = 0; i < bytes.length; i++) {
      sb.writeCharCode(bytes[i] ^ key[i % 4]);
    }
    return sb.toString();
  }

  // ── Encoded keys ──

  static const List<int> _supxh = [
    // 钥匙已迁出仓库（2026-09-27 消毒）：本机运行 python scripts/gen_keys.py
    // 从 ~/.khyquant/built-in-keys.json 生成后贴回；仓库内保持空数组。
  ];

  static const List<int> _commandcode = [
    // 钥匙已迁出仓库（2026-09-27 消毒）：本机运行 python scripts/gen_keys.py
    // 从 ~/.khyquant/built-in-keys.json 生成后贴回；仓库内保持空数组。
  ];

  static const List<int> _glm = [
    // 钥匙已迁出仓库（2026-09-27 消毒）：本机运行 python scripts/gen_keys.py
    // 从 ~/.khyquant/built-in-keys.json 生成后贴回；仓库内保持空数组。
  ];

  static const List<int> _opencodego = [
    // 钥匙已迁出仓库（2026-09-27 消毒）：本机运行 python scripts/gen_keys.py
    // 从 ~/.khyquant/built-in-keys.json 生成后贴回；仓库内保持空数组。
  ];

  static const List<int> _sensenova = [
    // 钥匙已迁出仓库（2026-09-27 消毒）：本机运行 python scripts/gen_keys.py
    // 从 ~/.khyquant/built-in-keys.json 生成后贴回；仓库内保持空数组。
  ];

  static const List<int> _agnes = [
    // 钥匙已迁出仓库（2026-09-27 消毒）：本机运行 python scripts/gen_keys.py
    // 从 ~/.khyquant/built-in-keys.json 生成后贴回；仓库内保持空数组。
  ];

  static const List<int> _stepfun = [
    // 钥匙已迁出仓库（2026-09-27 消毒）：本机运行 python scripts/gen_keys.py
    // 从 ~/.khyquant/built-in-keys.json 生成后贴回；仓库内保持空数组。
  ];

  // ── Encoded endpoints ──
  //
  // 与钥匙同一套 XOR、同一套本地生成流程。命名前缀 `_ep` 把两类数组分开，
  // 免得 gen_keys.py 的校验把端点当成钥匙报「只存在于 Dart」。
  //
  // 两个空数组在仓库里是**正常状态**，不是遗漏：端点值和钥匙一样不入库。
  // 本机跑 `python scripts/gen_keys.py` 会连同钥匙一起生成，贴回后生效。

  /// khy-os 自建网关的端点。用户只填 Key，端点由包携带。
  static const List<int> _epKhyosGw = [
    // 端点未入库。本机生成后贴回；仓库内保持空数组。
  ];

  /// opencode 免费档的端点。无需 Key（keyField = -2 → 'public'）。
  static const List<int> _epOpencodeFree = [
    // 端点未入库。本机生成后贴回；仓库内保持空数组。
  ];

  // ── Provider registry (complete model lists from opencode) ──

  static const Map<String, _KeyEntry> _registry = {
    'SupXH': _KeyEntry(
      baseUrl: 'https://speed44.toter.me/v1',
      keyField: 0,
      defaultModel: 'claude-sonnet-4-5',
      models: [
        'claude-sonnet-4-5', 'claude-opus-4-5',
        'gemini-3-flash', 'gemini-2.5-pro', 'gemini-3.1-pro',
      ],
    ),
    'Command Code': _KeyEntry(
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      keyField: 1,
      defaultModel: 'claude-sonnet-5',
      models: [
        // Claude
        'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-opus-5', 'claude-opus-4-8',
        'claude-fable-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001',
        'claude-opus-4-7',
        // GPT
        'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5',
        'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex',
        // DeepSeek
        'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash',
        'deepseek/deepseek-v4-flash-fast', 'deepseek/deepseek-v4-flash-vision-exp',
        // Kimi
        'moonshotai/Kimi-K3', 'moonshotai/Kimi-K2.5', 'moonshotai/Kimi-K2.6',
        'moonshotai/Kimi-K2.7-Code', 'moonshotai/Kimi-K2.7-Code-Highspeed',
        // GLM
        'zai-org/GLM-5.3', 'zai-org/GLM-5.2', 'zai-org/GLM-5',
        'zai-org/GLM-5.1', 'zai-org/GLM-5.2-Fast', 'z-ai/glm-5.3-flash',
        // MiniMax
        'MiniMaxAI/MiniMax-M3', 'MiniMaxAI/MiniMax-M2.5', 'MiniMaxAI/MiniMax-M2.7',
        'minimax/minimax-m3-free',
        // Xiaomi
        'xiaomi/mimo-v2.5-pro', 'xiaomi/mimo-v2.5',
        // Qwen
        'Qwen/Qwen3.8-Max', 'Qwen/Qwen3.7-Max', 'Qwen/Qwen3.7-Plus',
        'Qwen/Qwen3.7-Flash', 'Qwen/Qwen3.6-Max-Preview', 'Qwen/Qwen3.6-Plus',
        'Qwen/Qwen3.8-27B', 'Qwen/Qwen3.8-Flash', 'Qwen/Qwen3.8-Max-0902',
        // Google
        'google/gemini-3.7-flash', 'google/gemini-3.1-flash-lite',
        'google/gemini-3.5-flash', 'google/gemini-3.5-flash-lite',
        'google/gemini-3.6-flash', 'google/gemini-3.8-flash',
        // xAI
        'xai/grok-4.5', 'xai/grok-4.6',
        // Meituan
        'meituan/LongCat-2.0:free',
        // Poolside
        'poolside/laguna-s-2.1-free',
        // Others
        'inclusionai/ling-3.0-flash-sante:free',
        'meta/muse-spark-1.1', 'meta/muse-spark-1.2',
        'meta/muse-spark-1.2-contributor', 'meta/muse-spark-1.3',
        'meta/muse-spark-1.3-contributor',
        'nvidia/nemotron-3-ultra-550b-a55b',
        'sakana/fugu-ultra',
        'stepfun/Step-3.5-Flash', 'stepfun/Step-3.7-Flash',
        'tencent/hy3-paid', 'tencent/hy4-preview',
        'thinkingmachines/inkling', 'thinkingmachines/inkling-small',
      ],
    ),
    '智谱 GLM': _KeyEntry(
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      keyField: 2,
      defaultModel: 'glm-5.3',
      models: ['glm-5.3', 'glm-5.3-flash'],
    ),
    'OpenCode Go': _KeyEntry(
      baseUrl: 'https://opencode.ai/zen/go/v1',
      keyField: 3,
      defaultModel: 'deepseek-v4-pro',
      models: [
        'grok-4.5', 'gpt-5.6-luna', 'glm-5.3', 'glm-5.2', 'glm-5.1',
        'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6',
        'mimo-v2.5', 'mimo-v2.5-pro',
        'minimax-m3', 'minimax-m2.7', 'minimax-m2.5',
        'qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus',
        'deepseek-v4-pro', 'deepseek-v4-flash', 'hy3', 'ox-alpha-free',
      ],
    ),
    'OpenRouter': _KeyEntry(
      baseUrl: 'https://openrouter.ai/api/v1',
      keyField: -1,
      defaultModel: 'z-ai/glm-5.2:free',
      models: [
        'z-ai/glm-5.2:free', 'cohere/north-mini-code:free',
        'nvidia/nemotron-3-ultra-550b-a55b:free',
        'nvidia/nemotron-3.5-lightning:free',
        'nvidia/nemotron-3-super-120b-a12b:free',
        'nvidia/nemotron-3-nano-30b-a3b:free',
        'nvidia/nemotron-nano-9b-v2:free',
        'thinkingmachines/inkling:free',
        'thinkingmachines/inkling-small:free',
        'poolside/laguna-s-2.1:free', 'poolside/laguna-xs-2.1:free',
        'google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free',
        'dots-studio/dots-3-note-preview:free',
        'minimax/minimax-m3:free',
        'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
        'nvidia/nemotron-3.5-content-safety:free',
        'liquid/lfm-2.5-2.6b:free',
        'openai/gpt-oss-20b:free',
      ],
    ),
    'Sense Nova': _KeyEntry(
      baseUrl: 'https://token.sensenova.cn/v1',
      keyField: 4,
      defaultModel: 'sensenova-6.7-flash-lite',
      models: ['sensenova-6.7-flash-lite'],
    ),
    'Agnes': _KeyEntry(
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      keyField: 5,
      defaultModel: 'agnes-2.5-flash',
      models: [
        'agnes-2.0-flash', 'agnes-2.5-flash', 'agnes-2.5-pro-alpha',
        'agnes-2.5-pro-beta', 'agnes-2.5-pro', 'agnes-3.0-flash',
        'agnes-image-2.0-flash', 'agnes-image-2.1-flash', 'agnes-image-2.5-flash',
        'agnes-video-v2.0', 'agnes-video-2.5', 'agnes-video-2.5-flash',
      ],
    ),
    'StepFun': _KeyEntry(
      baseUrl: 'https://api.stepfun.com/step_plan/v1',
      keyField: 6,
      defaultModel: 'step-3.7-flash',
      models: ['step-3.7-flash'],
    ),
    'OpenCode Zen': _KeyEntry(
      baseUrl: 'https://opencode.ai/zen/v1',
      keyField: -2,
      defaultModel: 'default',
      models: [
        'default', 'big-pickle', 'ling-3.0-flash-fin-free',
        'mimo-v2.5-free',
        'muse-spark-1.2-contributor-free',
        'muse-spark-1.3-contributor-free',
        'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free',
      ],
    ),

    // ── 端点隐藏的两个提供商 ──
    //
    // baseUrl 留空、端点走 endpointBytes。数组为空（仓库内的正常状态）时
    // endpointConfigured 为 false，界面显示「端点未配置」，选中也不生效——
    // 与钥匙为空时「无内置密钥」是同一条降级路径。

    /// khy-os 自建网关。
    ///
    /// 为什么值得单列一项：它和上面 8 个的区别是「这个包默认连自家网关」。
    /// 端点藏起来，用户只填 Key——填错 Key 会得到 401，填错端点则要查半天
    /// 为什么请求发去了别处。
    ///
    /// 模型列表按你网关实际提供的改；端点未配置时这一项整体不生效，
    /// 所以这里列什么都不会造成一次错误的请求。
    'khy-os 网关': _KeyEntry(
      baseUrl: '',
      endpointBytes: _epKhyosGw,
      keyField: -1,
      defaultModel: 'default',
      models: ['default'],
    ),

    /// opencode 免费档。
    ///
    /// 与上面已有的 'OpenCode Zen' 是两项：那一项的端点是明文的旧值，
    /// 且 opencode 自己的源码（packages/core/src/plugin/provider/opencode.ts）
    /// 显示免费档是经 Console OAuth 下发的，并没有一个可抄的静态免费端点。
    /// 所以这里的端点同样由本机填，不猜。
    'opencode free': _KeyEntry(
      baseUrl: '',
      endpointBytes: _epOpencodeFree,
      keyField: -2,
      defaultModel: 'default',
      models: ['default'],
    ),
  };

  static const _publicKey = 'public';

  static String _getKeyFor(int keyField) {
    switch (keyField) {
      case 0: return _decode(_supxh);
      case 1: return _decode(_commandcode);
      case 2: return _decode(_glm);
      case 3: return _decode(_opencodego);
      case 4: return _decode(_sensenova);
      case 5: return _decode(_agnes);
      case 6: return _decode(_stepfun);
      default: return '';
    }
  }

  /// 一个提供商真正生效的端点。
  ///
  /// 优先用编码数组解出来的值；数组为空（仓库内的正常状态，或本机还没生成）
  /// 就退回 baseUrl 字面量。所以老 8 项行为一字不变，新 2 项在本地填好前
  /// 返回空串。
  static String _resolveUrl(_KeyEntry e) {
    if (e.endpointBytes.isNotEmpty) return _decode(e.endpointBytes);
    return e.baseUrl;
  }

  static Map<String, BuiltInProvider> get providers {
    final out = <String, BuiltInProvider>{};
    for (final entry in _registry.entries) {
      final key = entry.value.keyField >= 0
          ? _getKeyFor(entry.value.keyField)
          : (entry.value.keyField == -2 ? _publicKey : '');
      final url = _resolveUrl(entry.value);
      out[entry.key] = BuiltInProvider(
        baseUrl: url,
        // 端点为空 = 这一项还没在本机配置。界面据此说「端点未配置」，
        // 而不是给出一个能选中却连不上的选项。
        endpointConfigured: url.isNotEmpty,
        apiKey: key,
        defaultModel: entry.value.defaultModel,
        models: entry.value.models,
      );
    }
    return out;
  }

  static BuiltInProvider? get(String name) => providers[name];

  /// 默认供应商：agnes。
  ///
  /// 为什么不是"第一个有内置 key 的"：R2 禁止明文 key 进 bundle，所以
  /// `hasKey` 对任何内置供应商都是 false——原来那个循环永远不命中，实际返回
  /// 的是注册表第一项（SupXH），一个谁都没选过的供应商。这个 getter 于是
  /// 悄悄地说了一句谎。
  ///
  /// 改为显式指名 agnes（用户 2026-10 明确要求"不要默认智谱，默认 agnes"）。
  /// 注意它目前是惰性的：唯一调用方 `AppConfigData.effective` 先用 `hasKey`
  /// 把关，而没有任何内置供应商带 key，所以这个默认值暂时不改变行为。但一旦
  /// 将来有供应商经 env 注入 key，这里选谁就是真的了——所以现在就选对。
  static BuiltInProvider get defaultProvider {
    final agnes = providers['Agnes'];
    if (agnes != null) return agnes;
    return providers.values.first;
  }

  static String? matchBaseUrl(String baseUrl) {
    if (baseUrl.isEmpty) return null;
    for (final entry in _registry.entries) {
      // 跳过端点未配置的项：它们的解析结果是空串，拿空串来比会把
      // 「config.baseUrl 也是空」误判成命中。
      final url = _resolveUrl(entry.value);
      if (url.isNotEmpty && url == baseUrl) return entry.key;
    }
    return null;
  }

  static bool hasBuiltInKey(String baseUrl) {
    final name = matchBaseUrl(baseUrl);
    if (name == null) return false;
    final p = _registry[name];
    if (p == null) return false;
    return p.keyField >= 0 && _getKeyFor(p.keyField).isNotEmpty;
  }

  static String getBuiltInKey(String baseUrl) {
    final name = matchBaseUrl(baseUrl);
    if (name == null) return '';
    final p = _registry[name];
    if (p == null || p.keyField < 0) return '';
    return _getKeyFor(p.keyField);
  }

  /// 内置 provider 作为密钥池默认条目的种子（provider 标识用 baseUrl，与
  /// KeyPool.pick 的入参同一套）。
  ///
  /// 桌面 apiKeyPool._getBuiltinProviderKeys() 把真有内置 key 的 provider
  /// 并入池中；手机侧同一语义收口在这里，XOR 方案不动。priority 0 = 回退档：
  /// 用户自备 key 是 10，与 AppConfig.effectiveApiKey「用户 key 恒盖过内置」
  /// 同序——否则老安装迁移后 pick() 会在两把 key 间轮换，而迁移前的请求从来
  /// 只用用户那一把（灌种子的一方据此只在没有自备 key 时才灌）。
  ///
  /// 没有内置 key 的项返回 null：'public' 免费档、端点未配置项、khy-os 网关
  /// 这种要用户自备 Key 的，与桌面「只有真有 key 才并入」一致。
  static BuiltInKeySeed? builtInPoolEntry(String baseUrl) {
    final name = matchBaseUrl(baseUrl);
    if (name == null) return null;
    final entry = _registry[name];
    if (entry == null || entry.keyField < 0) return null;
    final key = _getKeyFor(entry.keyField);
    if (key.isEmpty || key == _publicKey) return null;
    return BuiltInKeySeed(
      provider: baseUrl,
      key: key,
      endpoint: _resolveUrl(entry),
    );
  }
}

class _KeyEntry {
  final String baseUrl;
  final int keyField;
  final String defaultModel;
  final List<String> models;

  /// 编码后的端点。空 = 用 baseUrl 字面量（老 8 项），非空 = 端点藏起来（新 2 项）。
  final List<int> endpointBytes;

  const _KeyEntry({
    required this.baseUrl,
    required this.keyField,
    required this.defaultModel,
    required this.models,
    this.endpointBytes = const [],
  });
}

class BuiltInProvider {
  final String baseUrl;
  final String apiKey;
  final String defaultModel;
  final List<String> models;

  /// 端点是否已配置。false = 这个包没带上端点（本机还没跑生成器），
  /// 选中它也发不出请求——界面必须说清，不能给一个能点却连不上的选项。
  final bool endpointConfigured;

  const BuiltInProvider({
    required this.baseUrl,
    required this.apiKey,
    required this.defaultModel,
    required this.models,
    this.endpointConfigured = true,
  });

  bool get hasKey => apiKey.isNotEmpty && apiKey != 'public';

  /// 这一项现在能不能用：端点得在，钥匙要么内置要么用户自备。
  bool get usable => endpointConfigured;
}

/// 内置 key 入池的种子。priority 0 是回退档，低于用户自备 key 的 10。
class BuiltInKeySeed {
  final String provider;
  final String key;
  final String endpoint;
  final int priority;
  final String label;

  const BuiltInKeySeed({
    required this.provider,
    required this.key,
    required this.endpoint,
    this.priority = 0,
    this.label = 'built-in',
  });
}

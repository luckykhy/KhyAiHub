// khy-canary: Khy-20261101-068-TYFD6SE2
/// 第三方服务的默认端点——单一真源。
///
/// 为什么单独一个文件：这些是**别家文档写明的默认值**，不是本机路径。
/// Ollama 的 11434、各家的 `/v1` 后缀，换任何一台机器都一样。把它们散落在
/// 适配器和 UI 填充逻辑里，就会出现「适配器用一个值、快捷 chip 填另一个值」
/// 而这种漂移没有任何症状——只是用户的请求静默发去了别处。
///
/// 与 scripts/ci/check-agent-rules.js 的关系：本文件是 Rule 1（no-hardcoded-endpoint）
/// 的既定豁免对象，理由与 `constants/serviceDefaults.js` 完全相同——一个只负责
/// 「当真源」的文件，不该被自己守护的规则判成违规。豁免只给这一个文件：
/// 别处再出现字面量照样红。
///
/// 要加新的默认端点，加在这里，然后让消费方引用常量。不要在消费方里写字面量。
library;

/// Ollama 的默认 base URL。
///
/// 端口 11434 是 Ollama 文档写明的默认值（`OLLAMA_HOST` 未设时）。
/// 用户自建实例改了端口，就在这里改一处，或在 UI 里直接填。
const String kDefaultOllamaBaseUrl = 'http://localhost:11434';

/// Ollama 的默认模型名。
const String kDefaultOllamaModel = 'llama3.2';

/// OpenAI 兼容层的路径后缀。
///
/// 独立成常量是因为它要被**拼**而不是被抄：Ollama 的 OpenAI shim 挂在
/// `/v1` 下，而视觉模型的默认端点是从上面的裸端口组合出来的。写成
/// `'$kDefaultOllamaBaseUrl/v1'` 一样能跑，但下一次有人改裸端口时，那个
/// 后缀就成了第二处需要想起来的地方——而这个文件的全部意义就是不存在
/// 第二处。
const String kOpenAiCompatSuffix = '/v1';

/// 视觉子模型的默认端点：本机 Ollama 的 OpenAI 兼容层。
///
/// 为什么默认落在本机。视觉模型要看的是屏幕——屏幕上可能有验证码、聊天
/// 内容、账号信息。把它发去一个云端端点，等于把这些东西送出门，而用户从
/// 未同意过这件事。所以默认值是回环，用户想改成别的端点可以自己改，但
/// 默认值不替他们做这个决定。
///
/// 与 {@link kDefaultOllamaBaseUrl} 的关系：不是两个字面量，是组合。改端口
/// 只改上面那一行。
///
/// 已知局限（如实记录，不是 TODO）：Android 10+ 给 Termux 独立的网络命名
/// 空间，所以这个地址在装了 Termux Ollama 的设备上**可能根本连不通**——
/// App 里的 `localhost` 是 App 自己的回环。能否连上要在真机上量，量完之前
/// 不要把这个默认值描述成"已验证可用"。
const String kDefaultOllamaVisionBaseUrl =
    '$kDefaultOllamaBaseUrl$kOpenAiCompatSuffix';

/// 视觉子模型的默认模型名。
///
/// 默认值，不是要求。任何 OpenAI 兼容的视觉端点都能用——包括用户已经付了
/// 费的云端多模态模型。选它的理由是坐标归一化到 0-1000 的约定与该模型
/// 一致，换模型时若坐标空间不同，换算那一步会看不出来地错。
const String kDefaultVisionModel = 'gelab-zero-4b';

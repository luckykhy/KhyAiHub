'use strict';

/**
 * atomicCapabilityRegistry.js — 原子能力注册表的**生成器**（单一真源 → 机读清单）。
 *
 * ## 为什么是「生成器」而不是「手维护的 JSON」
 *
 * 原子能力分散在 6 个暴露面、300+ 个工具名里。手维护一张清单，下一次有人
 * 加个工具，清单就漂了；漂了的清单比没有清单更危险——它会让「我查过登记表，
 * 没有重复」变成一句假话。
 *
 * 所以本文件的分工是：
 *   - **能力语义（哪几个工具名其实是同一个原子能力）** 是人工判断，写在
 *     `ATOMIC_GROUPS` 里——这是需要人拍板的部分，机器猜不了；
 *   - **能力清单本身** 由本生成器从 6 个暴露面**实时抽取**并归一，输出
 *     `docs/10_规范/registry/ATOMIC-CAPABILITIES.json`。
 *
 * 人只维护「语义分组」，工具名的进出由生成器兜住。两边都漏不掉。
 *
 * ## 分层口径（L1/L2/L3）
 *
 * 沿用 `[DESIGN-LAY-005]` 的 L 层语义，但**只用于标注 canonical 所在层**，
 * 不表示「同一个工具在几层各有一份」。同一个原子能力可以出现在多个暴露面
 * （例如「读文件」在 PC 后端、手机 Dart、原生 Java 都有），那是**同一能力的
 * 多个接入点**，不是重复实现——重复实现的判据见 `DUPLICATE_GROUPS`。
 *
 * ## 反重复实现的判据
 *
 * 一个原子能力**被实现了两次**，当且仅当：同一语义分组下，两个暴露面各自
 * 带**自己的参数契约**（不是别名转调）。纯别名（一个面只是转调另一个面的
 * 名字）不算重复。本文件用 `DUPLICATE_GROUPS` 显式登记已知的存量重复——
 * 按本轮裁决（只登记不改动），它们记为 `status: "duplicate-logged"`，
 * 守卫只警告不拦截；未来收敛时把 status 改掉即可。
 *
 * 契约：纯函数、确定性、绝不抛。
 *
 * @module scripts/lib/atomicCapabilityRegistry
 */

const { extractAllSurfaces } = require('./atomicCapabilitySurfaces');
const { resolveCanonicalMap } = require('./resolveCanonical');

/**
 * 能力语义分组：把 6 个暴露面的工具名归一到一组「同一个原子能力」。
 *
 * 每组字段：
 *   - `id`        原子能力稳定标识（kebab-case，跨层复用时引用它）
 *   - `summary`   一句话能力说明（面向人）
 *   - `layer`     canonical 所在层（L1 原子 / L2 服务 / L3 前端）
 *   - `canonical` 该能力的**唯一实现真源**路径（仓内相对路径）
 *   - `members`   各暴露面上暴露这个能力的工具名
 *                 `{ backend: [...], 'phone-bridge': [...], ... }`
 *   - `note`      语义说明 / 为什么这样归组
 */
const ATOMIC_GROUPS = [
  // ── 文件系统 ──────────────────────────────────────────────────────────
  {
    id: 'fs.read',
    summary: '读取文件内容',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/FileReadTool/index.js',
    members: {
      backend: ['readFile', 'Read'],
      'phone-bridge': ['phone_read'],
      'phone-native': ['read'],
      'mobile-dart': ['read_file'],
      'amoo-policy': ['read'],
    },
    note: '后端 `Read`/`readFile` 是同语义两份工具名（PascalCase 与 camelCase 各一套），'
      + '按「只登记不改动」记为存量重复待裁决；手机侧 `phone_read`/`read`/`read_file` 是同一能力的三端接入点。',
  },
  {
    id: 'fs.write',
    summary: '写入文件内容',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/FileWriteTool/index.js',
    members: {
      backend: ['writeFile', 'Write'],
      'phone-bridge': ['phone_write'],
      'phone-native': ['write'],
      'mobile-dart': ['write_file'],
      'amoo-policy': ['write'],
    },
    note: '后端 `Write`/`writeFile` 成对重复；参数契约不同（`file_path` vs `path`），属真正的双实现。',
  },
  {
    id: 'fs.edit',
    summary: '对已有文件做局部修改',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/FileEditTool/index.js',
    members: {
      backend: ['editFile', 'Edit', 'MultiEdit', 'apply_patch'],
      'mobile-dart': ['edit_file'],
    },
    note: '后端四份（`Edit`/`editFile`/`MultiEdit`/`apply_patch`）实为三种改法（整写/多段/补丁），'
      + '本表按「同属编辑能力域」归组，具体手段在各自工具描述里。',
  },
  {
    id: 'fs.list',
    summary: '列出目录内容',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/ListDirTool/index.js',
    members: {
      backend: ['ListDir'],
      'phone-bridge': ['phone_ls'],
      'phone-native': ['ls'],
      'mobile-dart': ['list_files'],
      'amoo-policy': ['ls'],
    },
    note: '五面全部命中——这是「原子能力被反复实现」的最清晰样本：同一个「列目录」'
      + '在 PC 后端、桥目录、原生、Dart、amoo 策略各有一份自己的契约。'
      + '**注意**：amoo bridge 面的 `phone_ls` 不在此组——它同名但语义更窄，'
      + '见 `fs.list-restricted`。',
  },
  {
    id: 'fs.list-restricted',
    summary: '列出目录内容（受限白名单目录）',
    layer: 'L1',
    canonical: 'delivery/extension/bridges/khy-amoon-bridge/lib/phone-tools.js',
    members: {
      'amoo-bridge': ['phone_ls'],
    },
    note: '**与 `fs.list` 同名异义，故单列一组。** amoo bridge 面的 `phone_ls` 是'
      + '**受限只读**：仅允许 /sdcard/khy-amoon-bridge、Download、Documents、Pictures、DCIM '
      + '及 /sdcard 顶层，设备 realpath 复检，拒绝 `..` 与符号链接逃逸，'
      + '契约明写「不是任意 ls」（contracts.js）。'
      + '它是 `PHONE_RESTRICTED_TOOLS` 之一（phone-tools.js:58）——**刻意更窄**。'
      + '与 `exec.shell-restricted` 同理：把受限面并进普通能力组，'
      + '会让「复用」变成「放宽目录范围」，那是降级不是复用。',
  },
  {
    id: 'fs.glob',
    summary: '按名模式匹配文件',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/GlobTool/index.js',
    members: {
      backend: ['glob', 'Glob'],
      'mobile-dart': ['find_files'],
    },
    note: '后端 `Glob`/`glob` 成对重复；Dart `find_files` 是同名能力的手机侧实现。',
  },
  {
    id: 'fs.grep',
    summary: '按内容正则检索文件',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/GrepTool/index.js',
    members: {
      backend: ['grep', 'Grep'],
      'mobile-dart': ['grep_files'],
    },
    note: '后端 `Grep`/`grep` 成对重复。',
  },
  {
    id: 'fs.mkdir',
    summary: '创建目录',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/FileWriteTool/index.js',
    members: {
      'phone-bridge': ['phone_mkdir'],
      'phone-native': ['mkdir'],
      'mobile-dart': ['create_dir'],
      'amoo-policy': ['mkdir'],
    },
    note: '后端无独立工具（走 writeFile 的目录语义），故后端面缺席——**不是遗漏，是后端确实没有这个动作**。',
  },
  {
    id: 'fs.stat',
    summary: '读取文件元信息',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/FileReadTool/index.js',
    members: {
      'phone-bridge': ['phone_stat'],
      'phone-native': ['stat'],
      'amoo-policy': ['stat'],
    },
    note: '后端无独立工具面（stat 信息随 read 返回）。',
  },
  {
    id: 'fs.move',
    summary: '移动/重命名文件',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/FileWriteTool/index.js',
    members: {
      'phone-bridge': ['phone_mv'],
      'phone-native': ['mv'],
      'amoo-policy': ['mv'],
    },
    note: '手机三面（桥/原生/Dart 缺）——Dart 侧无 mv 工具，是能力缺口而非重复。',
  },
  {
    id: 'fs.copy',
    summary: '复制文件',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/FileWriteTool/index.js',
    members: {
      'phone-bridge': ['phone_cp'],
      'phone-native': ['cp'],
      'amoo-policy': ['cp'],
    },
    note: '与 `fs.move` 同理，Dart 侧缺 cp。',
  },
  {
    id: 'fs.delete',
    summary: '删除文件或目录',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/FileWriteTool/index.js',
    members: {
      'phone-bridge': ['phone_rm'],
      'phone-native': ['rm'],
      'amoo-policy': ['rm'],
    },
    note: '后端无独立工具面。',
  },
  {
    id: 'fs.zip',
    summary: '把手机目录/文件打包成 zip 或解包',
    layer: 'L1',
    canonical: 'delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/Tools.java',
    members: {
      'phone-bridge': ['phone_zip', 'phone_unzip'],
      'phone-native': ['zip', 'unzip'],
    },
    note: 'PC 侧 `phoneBridgeCatalog.js:283/:305` 只是**描述符**（bridgeName↔khyName 映射与参数说明），'
      + '实现在手机原生 `Tools.java`（`zip()` :2603、`unzip()` :2677，走 `java.util.zip`，'
      + '不依赖 Android shell 里并不存在的 zip 二进制——phoneBridgeCatalog.js:281-282 记着这次实测，'
      + '当年 Amoo 误判「没装」的就是这两个）。'
      + '**zip 计入带出数据预算**：它自己不往设备外发一个字节，但把「读 200 个小文件」换成'
      + '「读 1 个 zip」，同一批数据后者一次 read 就全拿走——不记账，逐文件读会被额度挡住、'
      + '打个包再读就绕过去了（Tools.java:1580-1591 的政策门，zip 与 ls/read/exec/cp 并列）。',
  },
  {
    id: 'fs.send-to-user',
    summary: '把文件发给用户',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/SendUserFileTool/index.js',
    members: {
      backend: ['SendUserFile'],
    },
    note: '后端独有。',
  },

  // ── 执行 ──────────────────────────────────────────────────────────────
  {
    id: 'exec.shell',
    summary: '执行 shell 命令',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/bash.js',
    members: {
      backend: ['bash', 'shellCommand', 'cmd', 'PowerShell', 'powershell', 'PhoneBridge'],
      'phone-bridge': ['phone_exec'],
      'phone-native': ['exec'],
      'mobile-dart': ['exec_shell', 'exec_shell_elevated'],
      'amoo-policy': ['exec'],
    },
    note: '**最严重的一组**。后端同时存在 `bash`/`shellCommand`/`cmd` 与 `PowerShell`/`powershell` '
      + '五份执行工具；手机侧 `exec_shell`/`exec_shell_elevated` 又自带一套白名单，'
      + '与原生 `LoopModes` 的危险命令判定重复且更弱（见 DESIGN-ARCH-193 §6.1）。'
      + '后端 `PhoneBridge` 是**聚合面**（把桥上多个工具收进一个工具），不是新实现。'
      + '**注意**：amoo bridge 面的 `phone_exec` 不在此组——它同名但语义更窄，'
      + '见 `exec.shell-restricted`。',
  },
  {
    id: 'exec.shell-restricted',
    summary: '只读诊断命令（固定白名单，不接受任意 shell 字符串）',
    layer: 'L1',
    canonical: 'delivery/extension/bridges/khy-amoon-bridge/lib/phone-tools.js',
    members: {
      'amoo-bridge': ['phone_exec'],
    },
    note: '**与 `exec.shell` 同名异义，故单列一组。** amoo bridge 面的 `phone_exec` '
      + '是**只读诊断白名单**（op 枚举：echo / getprop / wm_size / pm_list / dumpsys_battery），'
      + '契约明写「绝不接受任意 shell 字符串；管道、重定向、;、$()、反引号、换行和未知 op 一律拒绝。'
      + '不是手机 shell」（contracts.js:448-451）。'
      + '它是 `PHONE_RESTRICTED_TOOLS` 之一（phone-tools.js:58）——**刻意更窄**，不是重复实现。'
      + '故不与 `exec.shell` 归组：把它们当同一能力，会让「复用」变成「放宽到任意 shell」，'
      + '那是降级不是复用。',
  },
  {
    id: 'exec.code',
    summary: '执行代码片段',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/CodeInterpreterTool/index.js',
    members: {
      backend: ['executeCode', 'CodeInterpreter', 'REPL'],
    },
    note: '后端内部三份代码执行入口。',
  },
  {
    id: 'exec.background',
    summary: '后台任务与其输出',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/BashOutputTool/index.js',
    members: {
      backend: ['BashOutput', 'BackgroundAgentOutput'],
    },
    note: '后台执行与后台输出是同一能力的两个半边。',
  },
  {
    id: 'exec.kill',
    summary: '终止运行中的进程',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/KillShellTool/index.js',
    members: {
      backend: ['KillShell'],
    },
    note: '后端独有。',
  },
  {
    id: 'exec.terminal-capture',
    summary: '采集终端画面',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/TerminalCaptureTool/index.js',
    members: {
      backend: ['TerminalCapture'],
    },
    note: '后端独有。',
  },

  // ── 网络 ──────────────────────────────────────────────────────────────
  {
    id: 'sys.goal',
    summary: '设置与查看持续目标',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/GoalTool/index.js',
    members: {
      backend: ['GoalTool'],
    },
    note: '后端独有。',
  },
  {
    id: 'net.http',
    summary: '发起 HTTP/HTTPS 请求',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/HttpRequestTool/index.js',
    members: {
      backend: ['httpRequest', 'WebFetch', 'VaultHttpFetch'],
      'mobile-dart': ['http_request', 'web_fetch'],
    },
    note: '后端三份（`httpRequest` 裸请求 / `WebFetch` 转 markdown / `VaultHttpFetch` 走凭据库）'
      + '参数契约各异，属同能力域多实现；Dart 侧 `http_request` 与 `web_fetch` 亦为两份。',
  },
  {
    id: 'net.web-search',
    summary: '搜索公开网络',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/WebSearchTool/index.js',
    members: {
      backend: ['WebSearch', 'webSearch', 'NewsSearch', 'news', 'SearchExtended', 'search'],
      'mobile-dart': ['web_search'],
    },
    note: '后端六份搜索入口，是全仓最拥挤的一组。',
  },
  {
    id: 'net.browser',
    summary: '驱动真实浏览器',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/WebBrowserTool/index.js',
    members: {
      backend: ['WebBrowser'],
    },
    note: '后端独有（走浏览器而非裸 HTTP）。',
  },
  {
    id: 'net.firecrawl',
    summary: '抓取网页并转结构化内容',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/FirecrawlTool/index.js',
    members: {
      backend: ['Firecrawl'],
    },
    note: '后端独有；与 `net.http` 的差异是「抓取+解析」而非「取回」。',
  },

  // ── 手机 / 设备 ───────────────────────────────────────────────────────
  {
    id: 'device.ping',
    summary: '探活',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/services/domain/network/phone/phoneBridgeCatalog.js',
    members: {
      'phone-bridge': ['phone_ping'],
      'phone-native': ['ping'],
      'amoo-bridge': ['ping'],
      'amoo-policy': ['ping'],
    },
    note: '四份，全是最便宜的那次调用——却是全仓重叠度最高的能力名。',
  },
  {
    id: 'device.info',
    summary: '读取设备信息',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/services/domain/network/phone/phoneBridgeCatalog.js',
    members: {
      'phone-bridge': ['phone_info'],
      'phone-native': ['info'],
      'mobile-dart': ['device_info'],
      'amoo-policy': ['info'],
    },
    note: '四份。amoo bridge 面的 `phone_info` 不在此组——它是只读受限变体，'
      + '见 `device.info-readonly`。',
  },
  {
    id: 'device.info-readonly',
    summary: '读取设备信息（只读受限面）',
    layer: 'L1',
    canonical: 'delivery/extension/bridges/khy-amoon-bridge/lib/phone-tools.js',
    members: {
      'amoo-bridge': ['phone_info'],
    },
    note: '**与 `device.info` 同名异义，故单列一组。** amoo bridge 面的 `phone_info` '
      + '契约明写「只读：serial/model/brand/sdk/release/屏幕分辨率/电量/亮屏/锁屏/唤醒状态。'
      + '不执行命令、不修改设备」。它是 `PHONE_RESTRICTED_TOOLS` 之一——**刻意更窄**。',
  },
  {
    id: 'device.app-list',
    summary: '列出已安装应用',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/services/domain/network/phone/phoneBridgeCatalog.js',
    members: {
      backend: ['DeviceApps'],
      'phone-bridge': ['phone_list_apps'],
      'phone-native': ['list_apps'],
      'mobile-dart': ['search_apps'],
      'amoo-policy': ['list_apps'],
    },
    note: '五份。后端 `DeviceApps` 是 PC 侧读桌面应用，手机侧读安卓应用集——'
      + '**同语义不同目标**，复用时须区分目标平台，不可直接顶替。'
      + 'amoo bridge 面的 `phone_app_list` 不在此组——它是只读受限变体，'
      + '见 `device.app-list-readonly`。',
  },
  {
    id: 'device.app-list-readonly',
    summary: '列出已安装应用（只读受限面）',
    layer: 'L1',
    canonical: 'delivery/extension/bridges/khy-amoon-bridge/lib/phone-tools.js',
    members: {
      'amoo-bridge': ['phone_app_list'],
    },
    note: '**与 `device.app-list` 同名异义，故单列一组。** amoo bridge 面的 `phone_app_list` '
      + '契约明写「只读：pm list packages（可按子串过滤）+ 当前前台 package/activity。'
      + '不能启动/停止应用」——它**刻意不带**启动能力。',
  },
  {
    id: 'device.launch-app',
    summary: '启动应用',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/services/domain/network/phone/phoneBridgeCatalog.js',
    members: {
      backend: ['open_app'],
      'phone-bridge': ['phone_start_app'],
      'phone-native': ['start_app'],
      'mobile-dart': ['open_app'],
      'amoo-policy': ['start_app'],
    },
    note: '后端 `open_app` 开的是本机应用，手机侧开的是安卓应用。',
  },
  {
    id: 'device.open-url',
    summary: '打开 URL',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/services/domain/network/phone/phoneBridgeCatalog.js',
    members: {
      'phone-bridge': ['phone_open_url'],
      'phone-native': ['open_url'],
      'mobile-dart': ['open_url'],
      'amoo-policy': ['open_url'],
    },
    note: '后端无独立面。',
  },
  {
    id: 'device.clipboard',
    summary: '读写剪贴板',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/services/domain/network/phone/phoneBridgeCatalog.js',
    members: {
      'phone-bridge': ['phone_clipboard'],
      'phone-native': ['clipboard'],
      'mobile-dart': ['read_clipboard', 'write_clipboard'],
      'amoo-policy': ['clipboard'],
    },
    note: '手机侧原生是 `get/set` 双 op 一个工具，Dart 侧拆成读/写两个工具——'
      + '**同一能力两种切分粒度**，正是二级能力难复用的典型原因。',
  },
  {
    id: 'device.share',
    summary: '分享文本到其他应用',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/services/domain/network/phone/phoneBridgeCatalog.js',
    members: {
      'phone-bridge': ['phone_share_text'],
      'phone-native': ['share_text'],
      'amoo-policy': ['share_text'],
    },
    note: '',
  },
  {
    id: 'device.toast',
    summary: '弹出系统通知',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/services/domain/network/phone/phoneBridgeCatalog.js',
    members: {
      'phone-bridge': ['phone_toast', 'phone_notify'],
      'phone-native': ['toast', 'notify'],
      'amoo-policy': ['toast', 'notify'],
    },
    note: '原生把 toast 与 notify 拆成两个工具，桥侧把两个合到一个 `phone_toast`——'
      + '**暴露面粒度不一致**，登记时必须两个都记，否则去重会漏。',
  },
  {
    id: 'device.battery',
    summary: '读取电量',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/services/domain/network/phone/phoneBridgeCatalog.js',
    members: {
      'phone-bridge': ['phone_battery'],
      'phone-native': ['battery'],
      'amoo-policy': ['battery'],
    },
    note: '',
  },
  {
    id: 'device.volume',
    summary: '调节音量',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/services/domain/network/phone/phoneBridgeCatalog.js',
    members: {
      'phone-bridge': ['phone_volume'],
      'phone-native': ['volume'],
      'amoo-policy': ['volume'],
    },
    note: '',
  },
  {
    id: 'device.brightness',
    summary: '调节屏幕亮度',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/services/domain/network/phone/phoneBridgeCatalog.js',
    members: {
      'phone-bridge': ['phone_brightness'],
      'phone-native': 'brightness',
      'amoo-policy': ['brightness'],
    },
    note: '',
  },
  {
    id: 'device.vibrate',
    summary: '触发振动',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/services/domain/network/phone/phoneBridgeCatalog.js',
    members: {
      'phone-bridge': ['phone_vibrate'],
      'phone-native': ['vibrate'],
      'amoo-policy': ['vibrate'],
    },
    note: '',
  },
  {
    id: 'device.ui-dump',
    summary: '读取屏幕上的可交互元素树',
    layer: 'L1',
    canonical: 'delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/Tools.java',
    members: {
      'phone-bridge': ['ui_dump'],
      'phone-native': ['ui_dump'],
      'mobile-dart': ['a11y_dump_ui'],
    },
    note: '无障碍能力只存在于手机侧；后端无对应面。'
      + '**注意**：`phone-bridge` 面的 `ui_dump` 在 lite 构建里**答 unknown tool**（DESIGN-ARCH-193 E9）。'
      + 'amoo bridge 面的 `phone_ui_dump` 不在此组——它走 adb uiautomator（只读受限），'
      + '见 `device.ui-dump-readonly`。',
  },
  {
    id: 'device.ui-dump-readonly',
    summary: '读取屏幕元素树（adb 只读受限面）',
    layer: 'L1',
    canonical: 'delivery/extension/bridges/khy-amoon-bridge/lib/phone-tools.js',
    members: {
      'amoo-bridge': ['phone_ui_dump'],
    },
    note: '**与 `device.ui-dump` 同名异义，故单列一组。** amoo bridge 面走 '
      + '`uiautomator dump` 后解析可见节点（text/rid/class/bounds），'
      + '最多 500 节点、1MB，且「不区分聊天角色」——'
      + '与手机侧无障碍服务那套是**不同取得手段**，不是同一实现的两份。',
  },
  {
    id: 'device.ui-tap',
    summary: '点击屏幕元素',
    layer: 'L1',
    canonical: 'delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/Tools.java',
    members: {
      'phone-bridge': ['ui_tap', 'ui_click'],
      'phone-native': ['ui_tap', 'ui_click'],
      'mobile-dart': ['a11y_tap', 'a11y_find_and_click', 'a11y_list_clickable'],
    },
    note: '原生 `ui_tap`/`ui_click` 两份；Dart 侧 `a11y_tap`/`a11y_find_and_click` 两份，'
      + '`a11y_list_clickable` 是同能力的「只列不点」变体。',
  },
  {
    id: 'device.ui-type',
    summary: '向输入框写入文本',
    layer: 'L1',
    canonical: 'delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/Tools.java',
    members: {
      'phone-bridge': ['ui_type'],
      'phone-native': ['ui_type'],
      'mobile-dart': ['a11y_type_text'],
    },
    note: '',
  },
  {
    id: 'device.ui-gesture',
    summary: '滑动、长按与系统导航',
    layer: 'L1',
    canonical: 'delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/Tools.java',
    members: {
      'phone-bridge': ['ui_swipe', 'ui_longpress', 'ui_back', 'ui_home', 'ui_recents'],
      'phone-native': ['ui_swipe', 'ui_longpress', 'ui_back', 'ui_home', 'ui_recents'],
      'mobile-dart': ['a11y_global_action'],
    },
    note: '',
  },
  {
    id: 'device.screenshot',
    summary: '截屏',
    layer: 'L1',
    canonical: 'delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/Tools.java',
    members: {
      'phone-bridge': ['shot', 'shot_b64'],
      'phone-native': ['shot', 'shot_b64'],
      'mobile-dart': ['capture_screen'],
    },
    note: '`shot_b64` 的 base64 结果**必须按字段豁免**截断上限——'
      + '否则截出来的 JPEG 是坏的（phoneBridgeCatalog.js:36-53 已记此坑）。'
      + 'amoo bridge 面的 `phone_screenshot` 不在此组——它走 adb screencap 落盘，'
      + '见 `device.screenshot-readonly`。',
  },
  {
    id: 'device.screenshot-readonly',
    summary: '截屏（adb 落盘受限面）',
    layer: 'L1',
    canonical: 'delivery/extension/bridges/khy-amoon-bridge/lib/phone-tools.js',
    members: {
      'amoo-bridge': ['phone_screenshot'],
    },
    note: '**与 `device.screenshot` 同名异义，故单列一组。** amoo bridge 面走 '
      + '`adb exec-out screencap`，默认落盘 24h 并返回 path/sha256，'
      + '只有 inline=true 且 base64 未超上限时才内联返回——'
      + '**不内联就拿不到图**，与手机侧直接返回 b64 的形态不同。',
  },
  {
    id: 'device.location',
    summary: '读取地理位置',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/GetLocationTool/index.js',
    members: {
      backend: ['GetLocation'],
    },
    note: '后端独有（读本机位置）。',
  },
  {
    id: 'device.install-apk',
    summary: '安装 APK / 配置提权环境',
    layer: 'L1',
    canonical: 'delivery/mobile/khy-os-client-app/lib/core/tools/builtin_tools.dart',
    members: {
      'mobile-dart': ['install_apk', 'install_shizuku', 'shizuku_status'],
    },
    note: 'Dart 侧独有。',
  },
  {
    id: 'device.analysis',
    summary: '分析当前屏幕内容',
    layer: 'L1',
    canonical: 'delivery/mobile/khy-os-client-app/lib/core/tools/builtin_tools.dart',
    members: {
      'mobile-dart': ['analyze_screen'],
    },
    note: 'Dart 侧独有。',
  },
  {
    id: 'device.dart-swipe',
    summary: 'Dart 侧无障碍滑动手势',
    layer: 'L1',
    canonical: 'delivery/mobile/khy-os-client-app/lib/core/tools/builtin_tools.dart',
    members: {
      'mobile-dart': ['a11y_swipe'],
    },
    note: '**不并进 `device.ui-gesture`**：后者是桥面+原生面的 `ui_swipe`/`ui_longpress`/'
      + '`ui_back`/`ui_home`/`ui_recents` 与 Dart `a11y_global_action`，参数形状不同；'
      + '本工具是两点坐标滑动（x1/y1/x2/y2/durationMs），是另一个动作。'
      + '它是**后补实现**：builtin_tools.dart:227-230 自承「聊天界面系统提示广告 `a11y_swipe` 已久'
      + '而工具不存在」——提示里点名、注册表里没有，每次调用必失败，而模型无从得知、只会重试。'
      + '登记在此是防下一个人再把它当广告位。',
  },
  {
    id: 'bridge.tool-catalog',
    summary: '桥自述都有什么工具',
    layer: 'L1',
    canonical: 'delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/Tools.java',
    members: {
      'phone-bridge': ['phone_tools'],
      'phone-native': ['tools'],
    },
    note: '实现是 `Tools.java` 的 `tools` dispatch（:1621-1628，返回 count + 分组目录），'
      + '目录内容来自 CATALOG（:292，紧凑索引，答「有什么」）与 ROUTING（:390，按需富指令，'
      + '答「什么时候用哪个、用错会怎样」）——两表为何分开见 Tools.java:362-374。'
      + '**自述面 ≠ 状态面**：目录面照旧全量（回答「这个桥有什么」），状态面报可用集'
      + '（回答「此刻调得动哪些」，Tools.java:1861-1868）。2026-10-26 那次「Amoo 自报做不了 '
      + 'GUI 自动化」的误判，正是因为调用方只看了状态就下能力结论。'
      + 'PhoneBridgeTool 里「调桥的 22 个工具」的文案漂移归 W5，不归本表。',
  },
  {
    id: 'credential.delivery',
    summary: '凭据投递四件套',
    layer: 'L1',
    canonical: 'delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/Tools.java',
    members: {
      'phone-native': ['secret_code', 'secret_put', 'secret_list', 'secret_del'],
    },
    note: 'dispatch 在 Tools.java:1724-1727，实现 `secretCode`/`secretPut`/`secretList`/`secretDel`'
      + '（:2507-2601），目录分组「凭据投递」在 :312-315。**无 PC 调用面**——'
      + 'phoneBridgeCatalog 的 32 项里没有它们（本日实测 BRIDGE_TOOLS=32）。'
      + 'SelfDesc 刻意把这四个排除在给 Amoo 的自描述外：凭据投递要人在手机旁确认，云端助手做不到，'
      + '所以「助手不知道它们存在」是**设计目的而不是漏登记**——ToolsAvailabilityTest.java:217-219 '
      + '同时钉住反向一面（它们确实没出现在自描述里）。',
  },
  {
    id: 'app.adou-signin',
    summary: '调用 khy 的 a豆助手',
    layer: 'L1',
    canonical: 'delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/Tools.java',
    members: {
      'phone-native': ['adou_signin'],
    },
    note: '实现 `adouSignin` 在 Tools.java:2014-2049：主通道是 ContentProvider.call，'
      + '广播只作兜底（StepOS 拦「后台应用给第三方 App 发广播」，:2017-2019 记了实测）。'
      + '**无 PC 调用面**——phoneBridgeCatalog 的 32 项里没有它（本日实测 BRIDGE_TOOLS=32，'
      + '方案报告 :160 同记此事实）。ADOU_PKG 与 AMOO_PKG 同命名空间不同包，'
      + '包名一律写显式全名、不按 `com.amoo.` 前缀匹配，否则会连带圈进别的应用'
      + '（Tools.java:1870-1872）。它依赖 `com.amoo.adousignin`，未装时返回 not_installed'
      + '（:2029-2033）——检测不到就是不可用，不伪造在线。',
  },

  // ── amoo 协作 ─────────────────────────────────────────────────────────
  {
    id: 'mobile.notes',
    summary: '检索本地笔记',
    layer: 'L1',
    canonical: 'delivery/mobile/khy-os-client-app/lib/core/tools/builtin_tools.dart',
    members: {
      'mobile-dart': ['search_notes'],
    },
    note: 'Dart 侧独有。',
  },
  {
    id: 'mobile.calc',
    summary: '计算数学表达式',
    layer: 'L1',
    canonical: 'delivery/mobile/khy-os-client-app/lib/core/tools/builtin_tools.dart',
    members: {
      'mobile-dart': ['calculator'],
    },
    note: 'Dart 侧独有。',
  },
  {
    id: 'amoo.dispatch',
    summary: 'PC 侧驱动：在 amoo 聊天界面输入任务、发送并轮询答复',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/services/domain/network/amoo/amooDispatchRunner.js',
    members: {
      backend: ['AmooBridge'],
    },
    note: '**与 `amoo.ask` 是两条不同的链，故意分开登记**（[DESIGN-ARCH-194] §3.3：PC 侧 '
      + '`amooBridgePolicy.BRIDGE_TOOLS` 22 项 vs `phoneBridgeCatalog.BRIDGE_TOOLS` 32 项，'
      + '两份几乎相同的契约并存）。本条是 **PC 驱动派发**：读屏与点击全走 PC 侧 adb'
      + '（amooDispatchRunner.js:13-16），后端 `AmooBridge` 工具的 `send` 经 '
      + '`stack.runner.dispatchTask()` 到达这里（AmooBridgeTool/index.js:124）。'
      + '`AmooBridge` 是聚合面（status/plan/send/client 四个 action 收编整条 PC 驱动链），'
      + '不是 amoo 工具的新实现。'
      + '**纪律：桌面秘书面板不得出现 `dispatchTask` / `dispatchPlan` / runner 的任何调用**'
      + '（本日实跑 `git grep` 于 apps/khyos-desktop/src 零命中，须保持）——'
      + '面板要走 `amoo.ask` 的手机桥反代；PC 驱动派发只服务 AI 工具面，'
      + '它要求 amoo 在前台，天生不能无人值守。',
  },
  {
    id: 'amoo.ask',
    summary: '手机侧反代：把问题交给手机上的 amoo 并轮询结果（异步）',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/services/domain/network/phone/phoneBridgeClient.js',
    members: {
      'phone-bridge': ['phone_amoo_ask', 'phone_amoo_result'],
      'phone-native': ['amoo_ask', 'amoo_result'],
    },
    note: '**与 `amoo.dispatch` 分开登记**：本条是**手机侧反代**——`phone_amoo_ask` 只启动、'
      + '结果用 `phone_amoo_result` 轮询（异步是必须的：桥 socket 超时 20s，而 amoo 一想约 6 分钟，'
      + '阻塞调用会在答案出现前被切断，phoneBridgeCatalog.js:612-613）。'
      + 'canonical 指 PC 侧实际消费面 `phoneBridgeClient.js`（PhoneBridgeTool/index.js:179 经 '
      + '`client.call()` 出栈），**不再是 `amooBridgeClient.js`**——后者属于 PC 驱动派发链，'
      + '拿它当反代的 canonical，正是在替重复实现打掩护。'
      + '`amoo_ask`/`amoo_result` 属「整组可关」的助手协同能力：Amoo 没装时桥把它们报为 withheld，'
      + 'PC 侧据此三态判可用，不据此说 Amoo 装没装（phoneBridgeCatalog.js:711-722）。'
      + '`khy_ask`/`amoon_send` 两个错组成员已拆去 `khyos.ask` 与 `amoo.mailbox`。',
  },
  {
    id: 'amoo.stop',
    summary: '立即中止进行中的 amoo 反代任务、释放单飞锁',
    layer: 'L1',
    canonical: 'delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/AmooLoop.java',
    members: {
      'phone-bridge': ['phone_amoo_stop'],
      'phone-native': ['amoo_stop'],
    },
    note: '**唯一能即时清掉 `askRunning` 单飞锁的入口**：无线调试掉线留下的孤儿 ask 会把后续'
      + '所有 ask 永久堵死（worker 卡在无界无障碍 IPC 里，finally 永远到不了），'
      + '`amoo_result` 轮询超过 1800s 才自愈释放（AmooLoop.java:445-488），那是被动等待；'
      + '`stopAsk()` 是主动、即时的那一个（AmooLoop.java:490-512，清锁并 interrupt worker；'
      + 'dispatch 在 Tools.java:1781-1792，注释明写「桥侧此前没有任何工具能调到 stopAsk」）。'
      + '桌面「中止」按钮消费它（W1/W3；本日实跑桌面侧尚无调用点，是待接线状态）。'
      + '与拆分后的 `amoo.ask` 并列：一个发起、一个中止——少了它，「停止」只能靠超时假装。',
  },
  {
    id: 'khyos.ask',
    summary: '向本机 KhyOS 提一次性问题',
    layer: 'L1',
    canonical: 'delivery/extension/bridges/khy-amoon-bridge/lib/bridge-tools.js',
    members: {
      'amoo-bridge': ['khy_ask'],
    },
    note: '**从 `amoo.ask` 拆出**：它挂在 amoon 桥上，但契约 `side` 是 khyos——'
      + '「让本机 KhyOS 回答一个问题」（contracts.js:343-346），与 amoo 无关。'
      + '并进 amoo.ask 会让下一个人以为「问本机」也是 amoo 链路的一环，'
      + '从而去扩展 amoo 客户端——那正是造第三份实现的门。'
      + '实现是桥侧 runner：spawn 本机 `node khy.js`，带哨兵工具白名单/系统提示/深度护栏'
      + '（contracts.js:917、:931；handler 在 bridge-tools.js:260-318）。'
      + '手机侧默认关闭（KHY_AMOON_PHONE_ASK=1，开启后强制 max_turns=1、空 cwd、'
      + '禁用一切工具，contracts.js:551-553），file scope 永不可达（contracts.js:937）——'
      + '这些门是能力语义的一部分，不是可选项。',
  },
  {
    id: 'stepneo.cloud-ask',
    summary: '经 StepOS 云网关向本机手机上的 agent 发一轮任务',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/StepneoCloudTool/index.js',
    members: {
      backend: ['StepneoCloud'],
    },
    note: '与 `amoo.ask` 是**不同的云**：本条走 StepOS 云网关（step-5-preview），'
      + '模型在云端、工具经手机桥作用在用户自己的手机上；`amoo.ask` 走的是第三方 amoo 应用。'
      + '两者不可互相顶替，故不并入同一能力。',
  },
  {
    id: 'amoo.memory',
    summary: '读取 amoo 记忆',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/services/domain/network/amoo/amooBridgeClient.js',
    members: {
      'phone-bridge': ['phone_amoo_memory'],
      'phone-native': ['amoo_memory'],
    },
    note: '',
  },
  {
    id: 'amoo.loop',
    summary: '驱动 amoo 的多步循环',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/services/domain/network/amoo/amooDispatchRunner.js',
    members: {
      'phone-bridge': ['phone_loop_start', 'phone_loop_stop', 'phone_loop_status'],
      'phone-native': ['loop_start', 'loop_stop', 'loop_status'],
    },
    note: '',
  },
  {
    id: 'amoo.mailbox',
    summary: '经文件信箱与 amoo 异步通信',
    layer: 'L1',
    canonical: 'delivery/extension/bridges/khy-amoon-bridge/lib/mailbox.js',
    members: {
      'amoo-bridge': ['amoon_send', 'amoon_inbox', 'mailbox_status'],
    },
    note: '**`amoon_send` 从 `amoo.ask` 拆到本组**：它是**投递**不是问答——先写本地 spool、'
      + '再 push 到手机 outbox（tmp+mv），`mode=intent` 只报告分享 intent 已发出，'
      + '任何模式下 `verified` 恒为 false，ack 前不承诺送达（contracts.js:476-479）。'
      + '并进「取回结果」的能力，等于把「投递」伪装成「问答」——而投递不等于送达，'
      + '回执可被伪造，这是本表最不能含糊的一条边界。'
      + 'canonical 保持 `mailbox.js`：投递与回执共用同一套信箱存储'
      + '（spoolOutbound/recordReply/index/gc，contracts.js:924），不是两份实现。',
  },
  {
    id: 'amoo.bridge-status',
    summary: '查询桥自身状态',
    layer: 'L1',
    canonical: 'delivery/extension/bridges/khy-amoon-bridge/lib/contracts.js',
    members: {
      'amoo-bridge': ['bridge_status'],
    },
    note: '',
  },

  // ── 记忆 / 技能 / 上下文 ─────────────────────────────────────────────
  {
    id: 'memory.store',
    summary: '写入长期记忆',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/services/memoryService.js',
    members: {
      backend: ['SaveMemory', 'SaveInstruction'],
    },
    note: '',
  },
  {
    id: 'memory.recall',
    summary: '召回记忆',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/services/memoryService.js',
    members: {
      backend: ['LocalMemoryRecall', 'session_recall'],
    },
    note: '',
  },
  {
    id: 'skill.discover',
    summary: '发现可用技能',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/DiscoverSkillsTool/index.js',
    members: {
      backend: ['DiscoverSkills', 'Skill'],
      'mobile-dart': ['execute_skill'],
    },
    note: '',
  },
  {
    id: 'ctx.inspect',
    summary: '检视当前上下文占用',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/CtxInspectTool/index.js',
    members: {
      backend: ['CtxInspect', 'SessionInsights'],
    },
    note: '',
  },
  {
    id: 'ctx.plan',
    summary: '进入/退出计划模式并重试',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/EnterPlanModeTool/index.js',
    members: {
      backend: ['EnterPlanMode', 'ExitPlanMode', 'PlanRetry', 'PlanTool'],
    },
    note: '',
  },

  // ── 任务 / 编排 ───────────────────────────────────────────────────────
  {
    id: 'task.manage',
    summary: '任务条目的增删查改',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/TaskCreateTool/index.js',
    members: {
      backend: ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskDelete', 'TodoWrite',
        'TaskOutput', 'TaskStop'],
    },
    note: '后端 Task 系列与 `TodoWrite` 是同一能力域的两套（任务 vs 待办）；'
      + '`TaskOutput`/`TaskStop` 是后台任务的读与停，与 `exec.background` 相邻但不同层。',
  },
  {
    id: 'agent.dispatch',
    summary: '派发子代理/子任务',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/AgentTool/index.js',
    members: {
      backend: ['Agent', 'MeshPeer', 'RemoteTrigger', 'Brief'],
    },
    note: '',
  },
  {
    id: 'agent.team',
    summary: '团队成员的建立与撤销',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/TeamCreateTool/index.js',
    members: {
      backend: ['TeamCreate', 'TeamDelete'],
    },
    note: '',
  },
  {
    id: 'agent.message',
    summary: '在代理之间投递消息',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/SendMessageTool/index.js',
    members: {
      backend: ['SendMessage'],
    },
    note: '',
  },
  {
    id: 'workflow.run',
    summary: '运行预定义工作流',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/WorkflowTool/index.js',
    members: {
      backend: ['Workflow', 'RPA', 'A2A'],
    },
    note: '',
  },

  // ── Git ───────────────────────────────────────────────────────────────
  {
    id: 'git.read',
    summary: '读取仓库状态与历史',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/GitTool/index.js',
    members: {
      backend: ['gitStatus', 'gitLog', 'gitDiff', 'gitBlame'],
    },
    note: '后端 git 工具散在 `src/tools/` 下多个文件，`GitTool/index.js` 为目录真源。',
  },
  {
    id: 'git.write',
    summary: '写入仓库（提交/推送）',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/GitTool/index.js',
    members: {
      backend: ['gitCommit', 'gitPush', 'gitClone'],
    },
    note: '',
  },
  {
    id: 'git.search',
    summary: '在仓库历史里检索',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/GitTool/index.js',
    members: {
      backend: ['forgeCodeSearch', 'forgeSearch', 'forgeCommits', 'forgeRecon'],
    },
    note: '',
  },
  {
    id: 'git.sandbox',
    summary: '进入/退出工作树',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/EnterWorktreeTool/index.js',
    members: {
      backend: ['EnterWorktree', 'ExitWorktree'],
    },
    note: '',
  },
  {
    id: 'git.audit',
    summary: '仓库健康巡检',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/RepoAuditTool/index.js',
    members: {
      backend: ['repoAudit'],
    },
    note: '',
  },

  // ── 模型 / AI ─────────────────────────────────────────────────────────
  {
    id: 'model.list',
    summary: '列出可用模型',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/services/tool/toolCallingBuiltins.js',
    members: {
      backend: ['list_models', 'ModelRouter'],
    },
    note: '`list_models` 是**遗留内置**（在 `services/tool/toolCallingBuiltins.js`，不在 `src/tools/` 目录形态内），'
      + '故 canonical 不在工具目录里——这正是「同一能力两种物理形态」的样本。',
  },
  {
    id: 'model.manage',
    summary: '导入/导出/下载模型',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/ImportModelTool/index.js',
    members: {
      backend: ['download_model', 'import_model', 'export_ollama_model', 'importExternalAppModels'],
    },
    note: '',
  },
  {
    id: 'model.provider',
    summary: '配置模型供应商',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/ConfigureModelProviderTool/index.js',
    members: {
      backend: ['configureModelProvider', 'configureExternalApp'],
    },
    note: '',
  },
  {
    id: 'model.generate',
    summary: '调用模型生成',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/services/gateway/aiGateway.js',
    members: {
      backend: ['ResponsesAPI', 'GoogleGenAI', 'Assistants'],
    },
    note: '同名族工具（含大小写变体 `Assistant`/`Assistants`）。',
  },
  {
    id: 'ai.embedding',
    summary: '向量化',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/EmbeddingExtendedTool/index.js',
    members: {
      backend: ['EmbeddingExtended'],
    },
    note: '',
  },
  {
    id: 'ai.rerank',
    summary: '重排检索结果',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/RerankTool/index.js',
    members: {
      backend: ['Rerank'],
    },
    note: '',
  },
  {
    id: 'ai.image',
    summary: '图像生成与编辑',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/ImageGenExtendedTool/index.js',
    members: {
      backend: ['ImageGenExtended', 'image_generate', 'image_edit'],
    },
    note: '',
  },
  {
    id: 'ai.vision',
    summary: '图像理解与识别',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/RecognizeImageTool/index.js',
    members: {
      backend: ['RecognizeImage', 'image_detect', 'imageOcr', 'OCRExtended'],
    },
    note: '',
  },
  {
    id: 'ai.video',
    summary: '视频生成与分析',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/VideoGenExtendedTool/index.js',
    members: {
      backend: ['VideoGenExtended', 'video_generate', 'video_analyze'],
    },
    note: '',
  },
  {
    id: 'ai.audio',
    summary: '语音转写与合成',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/STTExtendedTool/index.js',
    members: {
      backend: ['STTExtended', 'TTSExtended'],
    },
    note: '',
  },
  {
    id: 'ai.doc',
    summary: '文档解析与渲染',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/InspectDocumentTool/index.js',
    members: {
      backend: ['inspectDocument', 'renderDocument', 'createDocument', 'convertFile', 'pdfToWord'],
    },
    note: '',
  },
  {
    id: 'ai.codebase',
    summary: '代码库理解与巡检',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/CodebaseMapTool/index.js',
    members: {
      backend: ['CodebaseMap', 'LSP', 'analyzeBinary', 'coverage_report', 'lint_code'],
    },
    note: '',
  },
  {
    id: 'ai.self-knowledge',
    summary: '自知识与线索回捞',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/services/clueVault.js',
    members: {
      backend: ['RtkGain', 'UpstreamStudy'],
    },
    note: '',
  },
  {
    id: 'ai.security',
    summary: '安全扫描',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/SecurityScanTool/index.js',
    members: {
      backend: ['security_scan'],
    },
    note: '',
  },
  {
    id: 'ai.review',
    summary: '产物评审',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/ReviewArtifactTool/index.js',
    members: {
      backend: ['ReviewArtifact', 'verify_artifact', 'VerifyPlanExecution'],
    },
    note: '',
  },

  // ── 向量 / 存储 ───────────────────────────────────────────────────────
  {
    id: 'store.vector',
    summary: '向量库读写',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/VectorStoreTool/index.js',
    members: {
      backend: ['VectorStore'],
    },
    note: '',
  },
  {
    id: 'store.files',
    summary: '文件库读写',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/FilesAPITool/index.js',
    members: {
      backend: ['FilesAPI'],
    },
    note: '',
  },

  // ── MCP ───────────────────────────────────────────────────────────────
  {
    id: 'mcp.call',
    summary: '调用 MCP 服务器工具',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/MCPTool/index.js',
    members: {
      backend: ['MCPTool'],
    },
    note: '',
  },
  {
    id: 'mcp.resources',
    summary: '读取 MCP 资源',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/ListMcpResourcesTool/index.js',
    members: {
      backend: ['ListMcpResources', 'ReadMcpResource'],
    },
    note: '',
  },
  {
    id: 'mcp.auth',
    summary: 'MCP 授权',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/McpAuthTool/index.js',
    members: {
      backend: ['McpAuth'],
    },
    note: '',
  },

  // ── 配置 / 系统 ───────────────────────────────────────────────────────
  {
    id: 'config.read-write',
    summary: '读写运行时配置',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/ConfigTool/index.js',
    members: {
      backend: ['Config', 'Configure'],
    },
    note: '',
  },
  {
    id: 'cron.manage',
    summary: '定时任务增删查',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/ScheduleCronTool/index.js',
    members: {
      backend: ['ScheduleCron', 'CronList', 'CronDelete'],
    },
    note: '',
  },
  {
    id: 'sys.disk',
    summary: '磁盘分析与清理',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/DiskAnalyzeTool/index.js',
    members: {
      backend: ['DiskAnalyze', 'DiskCleanup'],
    },
    note: '',
  },
  {
    id: 'sys.upgrade',
    summary: '自升级与版本操作',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/KhyUpdateTool/index.js',
    members: {
      backend: ['khyUpdate', 'khyos'],
    },
    note: '',
  },
  {
    id: 'sys.plugin',
    summary: '插件热重载',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/PluginHotReloadTool/index.js',
    members: {
      backend: ['PluginHotReload'],
    },
    note: '',
  },
  {
    id: 'sys.process',
    summary: '进程监控与关停',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/MonitorTool/index.js',
    members: {
      backend: ['Monitor', 'shutdown'],
    },
    note: '',
  },
  {
    id: 'sys.desktop',
    summary: '桌面端控制',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/DesktopControlTool/index.js',
    members: {
      backend: ['DesktopControl', 'ComputerUse'],
    },
    note: '',
  },
  {
    id: 'sys.clipboard-snapshot',
    summary: '截取剪贴板画面',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/SnipTool/index.js',
    members: {
      backend: ['Snip'],
    },
    note: '',
  },
  {
    id: 'sys.records',
    summary: '记录进度与结构化输出',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/RecordProgressTool/index.js',
    members: {
      backend: ['RecordProgress', 'StructuredOutput', 'SyntheticOutput'],
    },
    note: '',
  },
  {
    id: 'sys.guidance',
    summary: '给模型的引导类提示',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/CommentGuidanceTool/index.js',
    members: {
      backend: ['CommentGuidance', 'WeakModelGuidance'],
    },
    note: '',
  },
  {
    id: 'sys.self',
    summary: '自检与身份',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/KhySelfTool/index.js',
    members: {
      backend: ['KhySelf', 'adoptRole', 'taste', 'agentAssets'],
    },
    note: '',
  },
  {
    id: 'sys.tool-discovery',
    summary: '按需发现工具',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/ToolRecommendTool/index.js',
    members: {
      backend: ['toolSearch', 'ToolRecommend', 'registrySearch'],
    },
    note: '',
  },
  {
    id: 'sys.skill-create',
    summary: '动态创建工具',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/CreateToolTool/index.js',
    members: {
      backend: ['createTool'],
    },
    note: '',
  },
  {
    id: 'sys.evals',
    summary: '评测与训练',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/EvalsTool/index.js',
    members: {
      backend: ['Evals', 'FineTuning'],
    },
    note: '',
  },
  {
    id: 'sys.realtime',
    summary: '实时通道',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/RealtimeTool/index.js',
    members: {
      backend: ['Realtime'],
    },
    note: '',
  },
  {
    id: 'sys.push',
    summary: '推送通知',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/PushNotifyTool/index.js',
    members: {
      backend: ['PushNotify'],
    },
    note: '',
  },
  {
    id: 'sys.project',
    summary: '项目蓝图与模板',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/ProjectBlueprintTool/index.js',
    members: {
      backend: ['ProjectBlueprint', 'projectTemplate'],
    },
    note: '',
  },
  {
    id: 'sys.optimize',
    summary: '配置优化与变更提案',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/OptimizeConfigTool/index.js',
    members: {
      backend: ['optimizeConfig', 'optimize_config', 'propose_code_change'],
    },
    note: '`optimizeConfig`/`optimize_config` 大小写双份，是最典型的「复制粘贴式新增」。',
  },
  {
    id: 'sys.build',
    summary: '构建与部署工程',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/BuildProjectTool/index.js',
    members: {
      backend: ['build_project', 'deploy', 'scaffoldFiles', 'manageDeps', 'compile_file'],
    },
    note: '',
  },
  {
    id: 'sys.test',
    summary: '运行测试',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/RunTestsTool/index.js',
    members: {
      backend: ['run_tests'],
    },
    note: '',
  },
  {
    id: 'sys.query',
    summary: '数据查询与取数',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/DatabaseQueryTool/index.js',
    members: {
      backend: ['databaseQuery', 'dataFetch', 'quote', 'explore'],
    },
    note: '',
  },
  {
    id: 'sys.backtest',
    summary: '回测',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/BacktestTool/index.js',
    members: {
      backend: ['backtest'],
    },
    note: '',
  },
  {
    id: 'sys.strategy',
    summary: '策略清单',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/StrategyListTool/index.js',
    members: {
      backend: ['strategyList'],
    },
    note: '',
  },
  {
    id: 'sys.reverse',
    summary: '逆向工程',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/ReverseEngineerTool/index.js',
    members: {
      backend: ['reverse_engineer'],
    },
    note: '',
  },
  {
    id: 'sys.rewrite',
    summary: '文本改写',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/WeipuRewriteTool/index.js',
    members: {
      backend: ['WeipuRewrite'],
    },
    note: '',
  },
  {
    id: 'sys.image-to-web',
    summary: '图片转网页',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/Image2WebTool/index.js',
    members: {
      backend: ['image2web'],
    },
    note: '',
  },
  {
    id: 'sys.replace-location',
    summary: '按位置替换文档内容',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/ReplaceAtLocationTool/index.js',
    members: {
      backend: ['replaceAtLocation'],
    },
    note: '',
  },
  {
    id: 'sys.doc-title',
    summary: '设置文档标题样式',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/DocTitleStyleTool/index.js',
    members: {
      backend: ['docTitleStyle'],
    },
    note: '',
  },
  {
    id: 'sys.artifact',
    summary: '产物读写',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/ArtifactTool/index.js',
    members: {
      backend: ['Artifact'],
    },
    note: '',
  },
  {
    id: 'sys.unpack',
    summary: '解包',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/UnpackTool/index.js',
    members: {
      backend: ['unpack'],
    },
    note: '',
  },
  {
    id: 'sys.batch',
    summary: '批量执行',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/BatchTool/index.js',
    members: {
      backend: ['Batch'],
    },
    note: '',
  },
  {
    id: 'sys.ask-user',
    summary: '向用户提问',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/AskUserQuestionTool/index.js',
    members: {
      backend: ['AskUserQuestion'],
    },
    note: '',
  },
  {
    id: 'sys.sleep',
    summary: '等待',
    layer: 'L1',
    canonical: 'runtime/node/backend/src/tools/SleepTool/index.js',
    members: {
      backend: ['Sleep'],
    },
    note: '',
  },
];

/**
 * 已知存量重复登记：同一语义分组下，两面各自带**自己的参数契约**。
 *
 * 按本轮裁决「只登记不改动」，这些组在清单里标 `duplicate-logged`，
 * 守卫只警告不拦截。收敛时把本表对应条目的 status 改为 `active` 即可。
 *
 * 判据来源（实测，见设计文档 §证据）：
 *   - `fs.read` / `fs.write` / `fs.glob` / `fs.grep`：后端 PascalCase 与 camelCase 各一套，
 *     参数名不同（如 `file_path` vs `path`），是两套独立契约而非别名。
 *   - `exec.shell`：后端五份执行工具 + 手机侧两套白名单。
 *   - `net.web-search`：后端六份搜索入口。
 *   - `net.http`：后端三份 HTTP 工具。
 */
const DUPLICATE_GROUPS = {
  'fs.read': '后端 `Read`/`readFile` 两份独立参数契约（`file_path` vs `path`）',
  'fs.write': '后端 `Write`/`writeFile` 两份独立参数契约',
  'fs.glob': '后端 `Glob`/`glob` 两份独立参数契约',
  'fs.grep': '后端 `Grep`/`grep` 两份独立参数契约',
  'exec.shell': '后端 `bash`/`shellCommand`/`cmd`/`PowerShell`/`powershell` 五份 + 手机侧两套白名单',
  'net.http': '后端 `httpRequest`/`WebFetch`/`VaultHttpFetch` 三份',
  'net.web-search': '后端 `WebSearch`/`webSearch`/`NewsSearch`/`news`/`SearchExtended`/`search` 六份',
  'sys.optimize': '后端 `optimizeConfig`/`optimize_config` 大小写双份',
  'device.ui-tap': '原生 `ui_tap`/`ui_click` 与 Dart `a11y_tap`/`a11y_find_and_click` 各两份',
};

/**
 * 已登记的**接口分歧**（与 DUPLICATE_GROUPS 分开登记，因为判据不同）。
 *
 * 分歧 ≠ 重复实现。重复是「同一动作写了两套实现」；分歧是「同一个动作，
 * 各暴露面对参数的必填性/类型要求不一致」。后者更隐蔽：它不体现为两个文件，
 * 而是同一个能力名在不同端**行为不同**——二级能力照抄某一面的调用方式，
 * 在另一面会被拒。
 *
 * ## 判据：只比「同一动作」跨面的差异
 *
 * 两条不算分歧的情形（否则会把正确改错）：
 *   1. **同一面内的不同工具名** —— `gitBlame` 要 `file`、`gitLog` 不要，
 *      那是两个不同动作，参数本就该不同。
 *   2. **同名但语义刻意不同的受限面** —— amoo bridge 的 `phone_exec`（只读诊断
 *      白名单）与 phone-bridge 的 `phone_exec`（任意 shell），见 §受限面分组。
 *
 * ## 2026-10-25 收敛结果
 *
 * 原先 12 组登记，实测后**收敛到 0 组真冲突**：
 *   - 5 组真跨端冲突已**改代码修掉**（详见设计文档 §3.7）：
 *     amoo-policy 的 `write.text`（原生只认 `content`）、`volume.value`
 *     （原生只认 `level`）、`start_app` 漏 action/extras/uri；
 *     `ls.path`/`clipboard.op`/`notify.title`/`notify.text` 必填性与原生默认值冲突。
 *   - 7 组同面不同工具经判据修正后不再算分歧。
 *   - 余下 3 组（`fs.write` / `fs.list` / `device.clipboard`）是**目标平台差异**，
 *     不是契约冲突：PC 写的是本机文件、手机写的是 /sdcard；Dart 的 `list_files`
 *     列的是应用工作目录而非手机目录；Dart 侧把剪贴板拆成读/写两工具。
 *     强行统一会改变一端的真实语义，故按「目标平台差异」登记。
 */
const DIVERGENT_GROUPS = {
  'fs.write': '【目标平台差异】`content`：后端 `Write`/`writeFile` 与 Dart `write_file` 必填，'
    + '手机侧 `phone_write` 可选（原生 `a.optString("content","")` 有默认空串，'
    + '写空文件在手机侧合法）。PC 写本机文件系统、手机写 /sdcard，'
    + '是不同目标的两个动作，不应统一必填性。',
  'fs.list': '【目标平台差异】`path`：Dart `list_files` 必填，其余面可选。'
    + 'Dart 的 `list_files` 列的是**应用工作目录**（`FileService.listFiles`），'
    + '手机侧 `ls` 列的是 /sdcard（原生 `a.optString("path","/sdcard")`），'
    + '后端 `ListDir` 列的是 cwd——三者目标本就不同，默认值自然不同。',
  'device.clipboard': '【切分粒度差异】`text`：Dart `write_clipboard` 必填，'
    + '其余面可选。Dart 侧把剪贴板拆成 `read_clipboard`/`write_clipboard` 两个工具，'
    + '写工具天然只需 text；其余面是单一 `clipboard` 工具配 `op` 判别（get 时不需要 text）。'
    + '粒度不同导致同一参数在两处的必填性不同，不是契约冲突。',
};

/**
 * 把分组展开成「原子能力 → 暴露面工具名」的完整清单。
 *
 * canonical 的解析顺序：
 *   1. 分组里显式写了 `canonical` 且该路径在磁盘上存在 → 直接用；
 *   2. 否则用 `resolveCanonicalMap` 从该组任一成员名反查真实定义文件；
 *   3. 都拿不到 → canonical 记为 null（守卫会报错，不静默放过）。
 *
 * 第 2 步是本轮的关键：118 个能力里有 30 个人工猜的路径是错的，
 * 改为实测反查后全部对齐真实文件。
 *
 * @returns {Array<object>}
 */
/**
 * 合并一个原子能力在各暴露面的接口契约，得到**能力级接口**。
 *
 * 「列出接口」要能回答一个问题：**我要复用这个能力，参数怎么传？**
 * 但同一个能力在不同面的参数未必一致（如 fs.read：后端 `Read` 用 `file_path`、
 * `readFile` 用 `path`；手机桥用 `path`）。所以接口不能只给一份——
 * 必须给出「参数并集」+「各面的实际契约」+「分歧点」。
 *
 * 输出形状：
 *   - `params`        参数并集（跨面去重后的规范名与类型）
 *   - `requiredIn`    哪些面要求该参数必填
 *   - `perSurface`    每个面每个工具名的实际契约（供逐字段比对）
 *   - `divergent`     分歧参数名（有面必填有面可选 / 类型不一致）
 *
 * @param {object} surfacesMap  surfaceId → { contracts: { toolName: contract } }
 * @param {object} surfaces     surfaceId → [toolName]
 * @returns {object}
 */
function buildInterface(surfacesMap, surfaces) {
  const union = new Map();     // paramName → { name, types:Set, requiredBy:Set, presentBy:Set }
  const perSurface = {};

  for (const [surfaceId, toolNames] of Object.entries(surfaces)) {
    const contracts = (surfacesMap[surfaceId] || {}).contracts || {};
    for (const toolName of toolNames) {
      const contract = contracts[toolName];
      if (!contract) continue;
      const params = (contract.params || []).map((p) => ({
        name: p.name,
        type: p.type || 'unknown',
        required: Boolean(p.required),
        constraints: p.constraints || {},
      }));
      perSurface[surfaceId] = perSurface[surfaceId] || {};
      perSurface[surfaceId][toolName] = {
        params,
        risk: contract.risk || '',
        summary: contract.summary || '',
      };
      for (const param of params) {
        if (!union.has(param.name)) {
          union.set(param.name, {
            name: param.name,
            types: new Set(),
            requiredBy: new Set(),
            presentBy: new Set(),
            typedBy: new Set(),
          });
        }
        const entry = union.get(param.name);
        entry.types.add(param.type);
        const site = `${surfaceId}/${toolName}`;
        entry.presentBy.add(site);
        if (param.required) entry.requiredBy.add(site);
        // 只有**声明了结构化类型**的契约才参与类型比较。
        // 原生 Java 面没有 schema（只有参数名，类型恒为 unknown），
        // 把它算进来会让每个含手机侧的能力都误报「类型不一致」——
        // 缺元数据不等于契约冲突。
        if (param.type && param.type !== 'unknown') entry.typedBy.add(site);
      }
    }
  }

  const params = [...union.values()]
    .map((entry) => {
      // 类型只取有类型声明的契约；一个都没有就是「无类型元数据」
      const typedTypes = [...entry.types].filter((t) => t !== 'unknown');
      return {
        name: entry.name,
        type: typedTypes.length === 0
          ? 'unknown'
          : (new Set(typedTypes).size === 1 ? typedTypes[0] : [...new Set(typedTypes)].join('|')),
        required: entry.requiredBy.size > 0,
        requiredIn: [...entry.requiredBy].sort(),
        presentIn: [...entry.presentBy].sort(),
        typedIn: [...entry.typedBy].sort(),
        untyped: entry.typedBy.size === 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // 分歧判定。三类，严重度递减：
  //   1. `incompatible` —— 类型**不兼容**（如 string vs number）：照抄必崩。
  //   2. `required-mismatch` —— 必填性不一致（有面必填、有面选填）：照抄可能被拒。
  //   3. `numeric-widening` —— number vs integer：数值族内放宽，照抄不会崩，仅提示。
  // 无类型元数据的面（原生 Java）不参与——缺元数据不是契约冲突。
  //
  // 【只比跨面】这是本判据最关键的一条。同一面内的多个工具名是**不同操作**
  // （`gitBlame` 要 `file`、`gitLog` 不要——那是两个不同动作，本来就该不同），
  // 把它们算成分歧会逼着人给 `gitLog` 也加个必填 `file`，那是把正确改错。
  // 真正要收敛的是**跨面**：同一个动作在 PC 后端与手机侧被复用时，
  // 照抄 A 面的调用形状到 B 面会不会被拒。
  const NUMERIC = new Set(['number', 'integer']);
  const isNumeric = (types) => types.every((t) => NUMERIC.has(t));

  const divergent = [];
  const divergenceDetail = {};
  for (const param of params) {
    if (param.typedIn.length < 2) continue;
    const typedTypes = [...new Set(param.type.split('|'))];
    const typedRequired = param.requiredIn.filter((site) => param.typedIn.includes(site));

    let kind = null;
    if (typedTypes.length > 1 && !isNumeric(typedTypes)) {
      kind = 'incompatible';
    } else if (typedRequired.length > 0 && typedRequired.length < param.typedIn.length) {
      // 必填性不一致只在**跨面**时才算分歧。
      // 同一面内：不同工具名 = 不同操作，参数本就该不同（`gitBlame` 要 `file`、
      // `gitLog` 不要——这是正确设计，不是缺陷）。
      // 跨面：同一个动作在两端被复用，照抄一面的调用形状到另一面会被拒。
      const requiredSurfaces = new Set(typedRequired.map((s) => s.split('/')[0]));
      const allSurfaces = new Set(param.typedIn.map((s) => s.split('/')[0]));
      const crossSurface = requiredSurfaces.size > 0
        && allSurfaces.size > requiredSurfaces.size;
      if (crossSurface) kind = 'required-mismatch';
    } else if (typedTypes.length > 1) {
      kind = 'numeric-widening';
    }
    if (!kind) continue;
    divergent.push(param.name);
    divergenceDetail[param.name] = {
      kind,
      types: typedTypes,
      requiredIn: typedRequired,
      optionalIn: param.typedIn.filter((site) => !typedRequired.includes(site)),
    };
  }

  return {
    paramCount: params.length,
    params,
    perSurface,
    divergent,
    divergenceDetail,
    // 严重分歧（照抄必崩或可能被拒）——守卫据此拦截；numeric-widening 仅提示
    severeDivergent: divergent.filter((n) => divergenceDetail[n].kind !== 'numeric-widening'),
  };
}

/**
 * 把分组展开成「原子能力 → 暴露面工具名」的完整清单。
 *
 * canonical 的解析顺序：
 *   1. 分组里显式写了 `canonical` 且该路径在磁盘上存在 → 直接用；
 *   2. 否则用 `resolveCanonicalMap` 从该组任一成员名反查真实定义文件；
 *   3. 都拿不到 → canonical 记为 null（守卫会报错，不静默放过）。
 *
 * 第 2 步是本轮的关键：118 个能力里有 30 个人工猜的路径是错的，
 * 改为实测反查后全部对齐真实文件。
 *
 * @returns {Array<object>}
 */
function buildAtomicCapabilities() {
  const { map } = resolveCanonicalMap();
  const { surfaces: surfaceList } = extractAllSurfaces();
  const surfacesMap = {};
  for (const surface of surfaceList) {
    surfacesMap[surface.id] = { contracts: surface.contracts || {} };
  }
  const exists = (rel) => {
    if (!rel) return false;
    try {
      return require('fs').existsSync(require('path').join(
        require('path').resolve(__dirname, '..', '..'), rel,
      ));
    } catch {
      return false;
    }
  };

  return ATOMIC_GROUPS.map((group) => {
    const surfaces = {};
    for (const [surface, names] of Object.entries(group.members || {})) {
      const list = Array.isArray(names) ? names : [names];
      if (list.length) surfaces[surface] = list.slice().sort();
    }

    // 解析 canonical：显式路径优先（需存在），否则实测反查。
    let canonical = group.canonical || null;
    let canonicalSource = 'declared';
    if (!exists(canonical)) {
      const probe = [];
      for (const names of Object.values(surfaces)) {
        for (const name of names) probe.push(name);
      }
      let found = null;
      for (const name of probe) {
        if (map.has(name)) {
          found = map.get(name);
          break;
        }
      }
      canonical = found;
      canonicalSource = found ? 'resolved' : 'unresolved';
    }

    const duplicateNote = DUPLICATE_GROUPS[group.id] || '';
    const divergenceNote = DIVERGENT_GROUPS[group.id] || '';
    const iface = buildInterface(surfacesMap, surfaces);
    return {
      id: group.id,
      summary: group.summary,
      layer: group.layer,
      canonical,
      canonicalSource,
      status: duplicateNote ? 'duplicate-logged' : 'active',
      divergenceStatus: divergenceNote ? 'divergence-logged' : 'active',
      divergenceNote,
      surfaces,
      memberCount: Object.values(surfaces).reduce((sum, list) => sum + list.length, 0),
      interface: iface,
      note: [
        group.note || '',
        duplicateNote ? `【存量重复】${duplicateNote}` : '',
        divergenceNote ? `【接口分歧】${divergenceNote}` : '',
      ]
        .filter(Boolean)
        .join(' '),
    };
  });
}

/**
 * 生成完整注册表文档（含元信息与覆盖统计）。
 * @returns {object}
 */
function buildRegistryDocument() {
  const { surfaces } = extractAllSurfaces();
  const capabilities = buildAtomicCapabilities();

  // 覆盖统计：每个暴露面的工具名，有多少被登记进某个原子能力。
  const registered = new Map();
  for (const cap of capabilities) {
    for (const [surface, names] of Object.entries(cap.surfaces)) {
      if (!registered.has(surface)) registered.set(surface, new Set());
      for (const name of names) registered.get(surface).add(name);
    }
  }

  const surfaceCoverage = surfaces.map((surface) => {
    const known = registered.get(surface.id) || new Set();
    const orphans = surface.names.filter((name) => !known.has(name));
    return {
      id: surface.id,
      label: surface.label,
      entry: surface.entry,
      available: surface.available,
      exposed: surface.names.length,
      registered: surface.names.length - orphans.length,
      orphanCount: orphans.length,
      orphans: orphans.sort(),
    };
  });

  const totalExposed = surfaceCoverage.reduce((sum, s) => sum + s.exposed, 0);
  const totalRegistered = surfaceCoverage.reduce((sum, s) => sum + s.registered, 0);
  const totalOrphans = surfaceCoverage.reduce((sum, s) => sum + s.orphanCount, 0);

  return {
    meta: {
      version: '1.0.0',
      updated: '2026-10-30',
      purpose:
        'khy-os 原子能力总清单：把 6 个暴露面（后端工具注册表 / PC 侧手机桥目录 / '
        + 'Android 原生 / 手机 Dart / amoon bridge 契约 / amoo 桥策略）上暴露的 '
        + `${totalExposed} 个工具名，归一到 ${capabilities.length} 个原子能力，`
        + '并为每个原子能力登记唯一 canonical 实现。二级能力、三级能力'
        + '直接复用这里的 canonical，不得再各自实现一份。',
      generator: 'scripts/lib/atomicCapabilityRegistry.js',
      extractor: 'scripts/lib/atomicCapabilitySurfaces.js',
      guard: 'scripts/ci/check-atomic-capabilities.js',
      ssot:
        'docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-194] 原子能力聚合与接口目录.md',
      layering:
        'L1/L2/L3 沿用 [DESIGN-LAY-005] 的层语义，仅标注 canonical 所在层；'
        + '同一原子能力出现在多个暴露面属「同一能力的多个接入点」，不算重复实现。',
      duplicatePolicy:
        '按本轮裁决「只登记不改动」：已知存量重复记为 status=duplicate-logged，'
        + '守卫只警告不拦截；收敛时改 status 即可。',
      notes: [
        '本文件是**生成物**。人工维护的部分是 scripts/lib/atomicCapabilityRegistry.js 里的'
        + 'ATOMIC_GROUPS（能力语义分组），工具名的进出由生成器从代码实时抽取兜住。',
        '不要手改本文件——改 ATOMIC_GROUPS 后重跑生成器。',
      ],
    },
    surfaces: surfaceCoverage,
    capabilities,
    coverage: {
      totalExposed,
      totalRegistered,
      totalOrphans,
      complete: totalOrphans === 0,
    },
  };
}

module.exports = {
  ATOMIC_GROUPS,
  DUPLICATE_GROUPS,
  DIVERGENT_GROUPS,
  buildAtomicCapabilities,
  buildRegistryDocument,
};

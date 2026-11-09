'use strict';

/**
 * phoneBridgeCatalog.js — pure leaf (zero IO, deterministic, never throws).
 *
 * Translated contract of the StepBridge HTTP API that actually runs on the
 * phone. Two facts drive every entry here and both were measured on the
 * installed artifact, not read from its README:
 *
 *   1. The shipped APK is the "lite" build: 22 tools, ZERO UI tools, and no
 *      accessibility service declared in its manifest. Its README advertises
 *      31+ tools plus ui_dump/ui_tap/shot_b64 and port 8898 — that table is
 *      fiction for this artifact.
 *   2. The port is 8896 and the mailbox dir is /sdcard/bridge-amoobridge.
 *      8898 and /sdcard/bridge belong to the unreleased full build.
 *
 * So the catalog is split in two: BRIDGE_TOOLS (what the lite build answers
 * today) and UI_TOOLS (what the full build would answer, kept only so the
 * capability gap is reported honestly instead of as a confusing "unknown
 * tool"). The khy-os facing names carry the phone_ prefix; the bridge-side
 * names and the five shell_exec/file_read/... aliases stay in `aliases`.
 */

const ACCESS_READ = 'read';
const ACCESS_ACTUATE = 'actuate';

// Result bodies from the bridge are echoed straight back into the model's
// context. exec caps out at 1MB on the phone side; the catalog caps again here
// so one call can never flood a turn.
const DEFAULT_RESULT_CAP_CHARS = 8000;
const LARGE_RESULT_CAP_CHARS = 20000;

// Per-FIELD exemptions to the caps above, for the two result bodies whose size
// IS the payload.
//
// WHY this exists as a field-level table rather than a per-tool cap. The UI
// branch of classifyBridgeCall (phoneBridgePolicy.js) returns an object with no
// resultCapChars at all, so `classified.resultCapChars` is undefined there and
// truncateBridgeResultText falls back to DEFAULT_RESULT_CAP_CHARS — which
// silently shreds a screenshot's base64 to its first 8000 characters. A GUI
// agent that receives a truncated JPEG gets a corrupt image and no error, which
// is the worst possible failure mode: it looks like a bad model, not a bad
// pipeline. shot_b64's b64 measures 40-70k characters at the default
// maxw=480/quality=60, so it was being cut on every single call.
//
// The exemption is deliberately per FIELD, not per tool. Raising the whole tool
// would also un-cap `orig_w`, `bytes`, `scale` and friends — fields that are a
// handful of characters and gain nothing from the headroom while losing the
// guarantee that one tool cannot flood a turn.
const UI_TOOL_RESULT_FIELD_CAPS = Object.freeze({
  shot_b64: Object.freeze({ b64: 400000 }),
  ui_dump: Object.freeze({ xml: 400000 }),
});

/**
 * The result cap for one field of one UI tool, or null to use the tool's own
 * cap. Exported so phoneBridgeClient can ask per field instead of guessing,
 * and so a test can assert the exemption is field-level rather than tool-level.
 */
function uiToolResultFieldCap(toolName, fieldName) {
  const perTool = UI_TOOL_RESULT_FIELD_CAPS[toolName];
  if (!perTool) {
    return null;
  }
  const cap = perTool[fieldName];
  return Number.isFinite(cap) && cap > 0 ? cap : null;
}

const BRIDGE_TOOLS = Object.freeze([
  {
    bridgeName: 'ping',
    khyName: 'phone_ping',
    aliases: [],
    access: ACCESS_READ,
    requiresAccessibility: false,
    args: {},
    summary: '探活：确认手机桥服务在监听并返回服务器时间戳',
    note: '最便宜的连通性检查。失败先看服务是否被系统杀掉，而不是先怪网络。',
    resultCapChars: 512,
  },
  {
    bridgeName: 'info',
    khyName: 'phone_info',
    aliases: ['phone_sys_info'],
    access: ACCESS_READ,
    requiresAccessibility: false,
    args: {},
    summary: '读取手机型号、品牌、SDK、Android 版本与桥的构建号',
    note: 'ver 来自 versionName，lite 包恒为 "1.0"，不能用来区分构建；ui 字段才是 UI 能力的真伪。',
    resultCapChars: 1024,
  },
  {
    bridgeName: 'exec',
    khyName: 'phone_exec',
    aliases: ['phone_shell_exec'],
    access: ACCESS_ACTUATE,
    requiresAccessibility: false,
    args: {
      cmd: {
        type: 'string',
        required: true,
        maxLength: 4000,
        description: '要执行的 shell 命令，经 /system/bin/sh -c 运行（必填）。示例：getprop ro.product.model',
      },
      timeout: {
        type: 'integer',
        minimum: 1,
        maximum: 120,
        description: '超时秒数，默认 20，上限 120（可选）。注意：对持续占用 stdout 不输出的命令无效，例如 sleep 300 会永久卡住。',
      },
    },
    summary: '以 shell 特权（uid 2000）在手机上执行 shell 命令；未投放 sidecar 时退回应用自身 uid',
    note: '提权三级：优先 shell sidecar（adb 投放、uid 2000，见 delivery/mobile/khy-os-client-app/scripts/provision-shell-sidecar.ps1），其次 Shizuku，最后退回 App 自身 uid——结果里的 via 字段标明实际走了哪条，别假设。input / screencap / dumpsys / su / pm 在 App uid 下一律权限拒绝，走了 sidecar 或 Shizuku 就能真跑；LoopModes 在所有模式（含 bypass）仍然拦这些，所以提权不放宽判定、只放大爆炸半径。重启后 sidecar 会消失（无 root 无法常驻），需重跑那个脚本，overlay 的「提权」行会把这件事说出来。',
    resultCapChars: LARGE_RESULT_CAP_CHARS,
  },
  {
    bridgeName: 'ls',
    khyName: 'phone_ls',
    aliases: ['phone_file_list'],
    access: ACCESS_READ,
    requiresAccessibility: false,
    args: {
      path: {
        type: 'string',
        description: '要列出的目录，默认 /sdcard（可选）。示例：/sdcard/Download',
      },
    },
    summary: '列出手机某个目录下的条目（名称、是否目录、大小、修改时间）',
    note: '上限 2000 条。需要「所有文件访问」授权，否则返回失败而不是部分结果。',
    resultCapChars: LARGE_RESULT_CAP_CHARS,
  },
  {
    bridgeName: 'read',
    khyName: 'phone_read',
    aliases: ['phone_file_read'],
    access: ACCESS_READ,
    requiresAccessibility: false,
    args: {
      path: {
        type: 'string',
        required: true,
        description: '要读取的文件绝对路径（必填）。示例：/sdcard/bridge-amoobridge/status.json',
      },
      max: {
        type: 'integer',
        minimum: 1,
        description: '最多读取的字节数，默认 256KB，硬上限 4MB（可选）。',
      },
    },
    summary: '读取手机上的文本文件，按 UTF-8 解码后返回',
    note: '二进制文件会被 UTF-8 解码搅成乱码；读目录会抛错。不要把大文件读进来——JSON 转义后体积会翻几倍。',
    resultCapChars: LARGE_RESULT_CAP_CHARS,
  },
  {
    bridgeName: 'write',
    khyName: 'phone_write',
    aliases: ['phone_file_write'],
    access: ACCESS_ACTUATE,
    requiresAccessibility: false,
    args: {
      path: {
        type: 'string',
        required: true,
        description: '目标文件绝对路径，父目录会自动创建（必填）。示例：/sdcard/khy/note.txt',
      },
      content: {
        type: 'string',
        description: '要写入的 UTF-8 文本，默认为空串（可选）。',
      },
      append: {
        type: 'boolean',
        description: '为 true 时追加而不是覆盖，默认 false（可选）。',
      },
    },
    summary: '把文本写入手机上的文件',
    note: '返回的 bytes 是写入后的文件总大小，不是本次写入的字节数。',
    resultCapChars: 512,
  },
  {
    bridgeName: 'mkdir',
    khyName: 'phone_mkdir',
    access: ACCESS_ACTUATE,
    aliases: [],
    requiresAccessibility: false,
    args: {
      path: {
        type: 'string',
        required: true,
        description: '要创建的目录绝对路径（必填）。示例：/sdcard/khy/works',
      },
    },
    summary: '在手机上递归创建目录',
    note: '目录已存在也算成功。',
    resultCapChars: 512,
  },
  {
    bridgeName: 'rm',
    khyName: 'phone_rm',
    aliases: [],
    access: ACCESS_ACTUATE,
    requiresAccessibility: false,
    dangerous: true,
    args: {
      path: {
        type: 'string',
        required: true,
        description: '要删除的文件或目录绝对路径（必填）。示例：/sdcard/khy/tmp.txt',
      },
      recursive: {
        type: 'boolean',
        description: '是否递归删除，默认 true（可选）。默认即整树删除，删单个文件也要显式传 false 才安全。',
      },
    },
    summary: '删除手机上的文件或目录',
    note: 'recursive 默认为 true：只传 path 会连锅端掉整棵目录树。这是本目录里最容易误伤的一条。',
    resultCapChars: 512,
  },
  {
    bridgeName: 'mv',
    khyName: 'phone_mv',
    aliases: [],
    access: ACCESS_ACTUATE,
    requiresAccessibility: false,
    args: {
      path: {
        type: 'string',
        required: true,
        description: '源文件绝对路径（必填）。',
      },
      dest: {
        type: 'string',
        required: true,
        description: '目标路径（必填）。示例：/sdcard/khy/renamed.txt',
      },
    },
    summary: '移动或重命名手机上的文件',
    note: '底层是 File.renameTo，跨卷/跨文件系统会直接失败，不会退回复制。',
    resultCapChars: 512,
  },
  {
    bridgeName: 'cp',
    khyName: 'phone_cp',
    aliases: [],
    access: ACCESS_ACTUATE,
    requiresAccessibility: false,
    args: {
      path: {
        type: 'string',
        required: true,
        description: '源文件或目录绝对路径（必填）。',
      },
      dest: {
        type: 'string',
        required: true,
        description: '目标路径，父目录会自动创建（必填）。',
      },
    },
    summary: '复制手机上的文件或目录（递归）',
    note: '大目录复制没有进度回报，调用方只能等。',
    resultCapChars: 512,
  },
  {
    bridgeName: 'stat',
    khyName: 'phone_stat',
    aliases: [],
    access: ACCESS_READ,
    requiresAccessibility: false,
    args: {
      path: {
        type: 'string',
        required: true,
        description: '要查询的路径（必填）。示例：/sdcard/Download',
      },
    },
    summary: '查询手机路径是否存在、是文件还是目录、大小与修改时间',
    note: '比 ls 轻，适合先探再动。',
    resultCapChars: 1024,
  },
  {
    // 安卓侧 2026-10-26 加的三个，一直没同步到这边——所以 PC 侧此前根本调不到。
    // 本机实测过：zip/unzip 走 java.util.zip，不依赖任何外部命令（Android 的
    // shell 里没有 zip 二进制，这是 Amoo 误判「没装」的那两个）。
    bridgeName: 'zip',
    khyName: 'phone_zip',
    aliases: [],
    access: ACCESS_ACTUATE,
    requiresAccessibility: false,
    args: {
      path: {
        type: 'string',
        required: true,
        description: '要打包的文件或目录绝对路径（必填）。示例：/sdcard/khy/workspace',
      },
      out: {
        type: 'string',
        required: true,
        description: '产出的 zip 绝对路径（必填）。示例：/sdcard/khy/out.zip',
      },
    },
    summary: '把手机上的目录或文件打成 zip',
    note: '用系统自带 zip 库实现，不需要外部命令。会计入本轮导出预算——它把「读 200 个小文件」换成「读 1 个 zip」，不记账就绕过了额度。缺 out 会直接报错，不会静默写到别处。',
    resultCapChars: 512,
  },
  {
    bridgeName: 'unzip',
    khyName: 'phone_unzip',
    aliases: [],
    access: ACCESS_ACTUATE,
    requiresAccessibility: false,
    args: {
      path: {
        type: 'string',
        required: true,
        description: '要解开的 zip 绝对路径（必填）。示例：/sdcard/khy/out.zip',
      },
      dest: {
        type: 'string',
        required: true,
        description: '解到哪个目录（必填）。示例：/sdcard/khy/restored',
      },
    },
    summary: '把手机上的 zip 解开到指定目录',
    note: '保留目录层级。会拒绝条目名越出目标目录的压缩包（Zip Slip）——压缩包可能来自别人，这个检查不是可选项。',
    resultCapChars: 512,
  },
  {
    bridgeName: 'tools',
    khyName: 'phone_tools',
    aliases: [],
    access: ACCESS_READ,
    requiresAccessibility: false,
    args: {},
    summary: '列出桥的全部工具，按组给出每个工具的一句话用途',
    note: '能力目录。此前调用方只知道「有 N 个工具」而不知道有哪些、分别能干什么，只能猜——而猜的方向永远是低估。不确定某件事能不能做时先问这个。',
    resultCapChars: 4096,
  },
  {
    bridgeName: 'start_app',
    khyName: 'phone_start_app',
    aliases: [],
    access: ACCESS_ACTUATE,
    requiresAccessibility: false,
    args: {
      package: {
        type: 'string',
        required: true,
        description: '应用包名（必填）。示例：com.khyos.khy_os_client',
      },
      component: {
        type: 'string',
        description: '可选的 "包名/类名"，类名可以只写 .ShortName（可选）。',
      },
      extras: {
        type: 'object',
        description: '可选的附加参数对象，值会被强制转成字符串（可选）。',
      },
      action: {
        type: 'string',
        description: '可选的 Intent action（可选）。',
      },
      uri: {
        type: 'string',
        description: '可选的 Intent data URI（可选）。',
      },
    },
    summary: '按包名启动手机上的应用',
    note: '没有可启动的 LAUNCHER 入口时报 no launch intent。这条是操作 Amoo 界面的前提，但启动之后的事本构建做不了。',
    resultCapChars: 512,
  },
  {
    bridgeName: 'open_url',
    khyName: 'phone_open_url',
    aliases: [],
    access: ACCESS_ACTUATE,
    requiresAccessibility: false,
    args: {
      url: {
        type: 'string',
        required: true,
        maxLength: 2000,
        description: '要打开的 http/https 链接（必填）。示例：https://example.com',
      },
    },
    summary: '在手机上用默认浏览器打开一个链接',
    note: '没有能处理该 scheme 的应用时返回失败。',
    resultCapChars: 512,
  },
  {
    bridgeName: 'share_text',
    khyName: 'phone_share_text',
    aliases: [],
    access: ACCESS_ACTUATE,
    requiresAccessibility: false,
    args: {
      text: {
        type: 'string',
        required: true,
        maxLength: 8000,
        description: '要分享的文本（必填）。',
      },
      title: {
        type: 'string',
        description: '分享面板标题，默认「分享」（可选）。',
      },
    },
    summary: '拉起手机系统分享面板分享一段文本',
    note: '只是弹面板，不保证用户真的点完。',
    resultCapChars: 512,
  },
  {
    bridgeName: 'clipboard',
    khyName: 'phone_clipboard',
    aliases: [],
    access: ACCESS_READ,
    requiresAccessibility: false,
    accessDependsOnOp: true,
    args: {
      op: {
        type: 'string',
        enum: ['get', 'set'],
        description: 'get 读取剪贴板（默认）或 set 写入剪贴板（可选）。set 会被当作写操作要求确认。',
      },
      text: {
        type: 'string',
        description: 'op 为 set 时要写入的文本（可选）。',
      },
    },
    summary: '读取或写入手机剪贴板',
    note: 'Android 10+ 上后台应用通常读不到剪贴板，get 会返回空串——空串不等于「剪贴板是空的」。',
    resultCapChars: 4096,
  },
  {
    bridgeName: 'toast',
    khyName: 'phone_toast',
    aliases: [],
    access: ACCESS_ACTUATE,
    requiresAccessibility: false,
    args: {
      text: {
        type: 'string',
        required: true,
        maxLength: 2000,
        description: '要弹出的提示文本（必填）。示例：khy-os 已连接',
      },
    },
    summary: '在手机上弹一条 toast',
    note: '函数在 toast 真正显示前就返回了，成功只代表「已投递」。',
    resultCapChars: 256,
  },
  {
    bridgeName: 'notify',
    khyName: 'phone_notify',
    aliases: [],
    access: ACCESS_ACTUATE,
    requiresAccessibility: false,
    args: {
      title: {
        type: 'string',
        description: '通知标题，默认 StepBridge（可选）。',
      },
      text: {
        type: 'string',
        description: '通知正文（可选）。',
      },
    },
    summary: '在手机通知栏发一条通知',
    note: '通知 id 取当前时间戳对 100000 取模，连发会互相覆盖。',
    resultCapChars: 256,
  },
  {
    bridgeName: 'list_apps',
    khyName: 'phone_list_apps',
    aliases: [],
    access: ACCESS_READ,
    requiresAccessibility: false,
    args: {},
    summary: '列出手机上已安装应用的包名与显示名',
    note: '上限 800 条，按显示名排序。',
    resultCapChars: LARGE_RESULT_CAP_CHARS,
  },
  {
    bridgeName: 'battery',
    khyName: 'phone_battery',
    aliases: [],
    access: ACCESS_READ,
    requiresAccessibility: false,
    args: {},
    summary: '读取手机电量百分比、充电状态与电池温度',
    note: '温度单位是摄氏度。',
    resultCapChars: 512,
  },
  {
    bridgeName: 'volume',
    khyName: 'phone_volume',
    aliases: [],
    access: ACCESS_READ,
    requiresAccessibility: false,
    accessDependsOnOp: true,
    args: {
      level: {
        type: 'integer',
        minimum: 0,
        description: '要设置的媒体音量档位，不传则只读取当前值（可选）。传值即写操作，会要求确认。',
      },
    },
    summary: '读取或设置手机媒体音量（STREAM_MUSIC）',
    note: '只能动媒体音量，碰不到铃声与闹钟。',
    resultCapChars: 256,
  },
  {
    bridgeName: 'brightness',
    khyName: 'phone_brightness',
    aliases: [],
    access: ACCESS_READ,
    requiresAccessibility: false,
    accessDependsOnOp: true,
    args: {
      value: {
        type: 'integer',
        minimum: 0,
        maximum: 255,
        description: '要设置的屏幕亮度 0-255，不传则只读取当前值（可选）。传值即写操作，会要求确认。',
      },
    },
    summary: '读取或设置手机屏幕亮度',
    note: '需要「修改系统设置」授权，否则返回中文权限错误。自动亮度开启时设置可能被系统覆盖。',
    resultCapChars: 256,
  },
  {
    bridgeName: 'vibrate',
    khyName: 'phone_vibrate',
    aliases: [],
    access: ACCESS_ACTUATE,
    requiresAccessibility: false,
    args: {
      ms: {
        type: 'integer',
        minimum: 1,
        maximum: 60000,
        description: '震动时长毫秒，默认 200（可选）。',
      },
    },
    summary: '让手机震动一段时间',
    note: 'fire-and-forget。',
    resultCapChars: 256,
  },
  {
    bridgeName: 'loop_start',
    khyName: 'phone_loop_start',
    aliases: [],
    access: ACCESS_ACTUATE,
    requiresAccessibility: true,
    optional: 'amoo',
    args: {
      mode: {
        type: 'string',
        enum: ['bypass', 'plan', 'edit', 'default'],
        description: '本地执行的闸门模式。缺省 bypass。plan=一条不执行先送审；edit=逐条改；default=高危要确认。安全底（递归 rm / 破坏性 exec）在任何模式下都仍会拦。',
      },
      max_rounds: { type: 'integer', minimum: 1, description: '循环轮数上限，默认 30（可选）。' },
      deadline_ms: { type: 'integer', minimum: 1000, description: '整个循环的墙钟上限毫秒，默认 10800000（可选）。' },
      poll_ms: { type: 'integer', minimum: 250, description: '轮询基础间隔毫秒，默认 3000，会线性退避封顶 30000（可选）。' },
    },
    summary: '启动 Amoo 本地拦截循环（无 PC 闭环）',
    note: '循环读 Amoo 聊天里的 ```khy-exec 围栏、在手机本地执行、把结果写回 Amoo 输入框。进程被杀后不会自动恢复——这是故意的，避免重复执行云端已认为执行过的命令。',
    resultCapChars: 512,
  },
  {
    bridgeName: 'loop_stop',
    khyName: 'phone_loop_stop',
    aliases: [],
    access: ACCESS_ACTUATE,
    requiresAccessibility: true,
    optional: 'amoo',
    args: {},
    summary: '停止 Amoo 本地拦截循环',
    note: '当前命令跑完后退出，不会打断半条命令。',
    resultCapChars: 256,
  },
  {
    bridgeName: 'loop_status',
    khyName: 'phone_loop_status',
    aliases: [],
    access: ACCESS_READ,
    requiresAccessibility: false,
    optional: 'amoo',
    args: {},
    summary: '读取 Amoo 本地拦截循环的状态',
    note: '返回 running / mode / 最近一条进展说明。',
    resultCapChars: 1024,
  },
  {
    bridgeName: 'amoo_ask',
    khyName: 'phone_amoo_ask',
    aliases: [],
    access: ACCESS_ACTUATE,
    requiresAccessibility: true,
    optional: 'amoo',
    args: {
      prompt: {
        type: 'string',
        maxLength: 20000,
        description: '要问 Amoo 的问题。会原样写进 Amoo 的输入框并发送。',
      },
      timeout_ms: {
        type: 'integer',
        minimum: 15000,
        maximum: 1800000,
        description: '等待回复的墙钟上限毫秒，默认 420000（7 分钟）。本机 Amoo 一想约 6 分钟，别调太低。',
      },
    },
    summary: '反代：把 Amoo 当模型用（异步）',
    note: '异步是必须的——桥的 socket 超时 20s，而 Amoo 一想约 6 分钟，阻塞调用会在答案出现前被切断。本工具只启动，结果用 amoo_result 轮询。同时只能有一个任务。',
    resultCapChars: 512,
  },
  {
    bridgeName: 'amoo_result',
    khyName: 'phone_amoo_result',
    aliases: [],
    access: ACCESS_READ,
    requiresAccessibility: false,
    optional: 'amoo',
    args: {},
    summary: '轮询 amoo_ask 的结果',
    note: 'state=running / done / failed。done 时 reply 是 Amoo 最新气泡的原文——未解析、未摘要、未校验。超过 20000 字会被截断（完整文本只在设备上），所以别用本工具拉长文。',
    resultCapChars: 20000,
  },
  {
    bridgeName: 'amoo_memory',
    khyName: 'phone_amoo_memory',
    aliases: [],
    access: ACCESS_READ,
    requiresAccessibility: false,
    optional: 'amoo',
    accessDependsOnOp: true,
    args: {
      op: {
        type: 'string',
        enum: ['get', 'set'],
        description: 'get 读当前共享记忆（含每条确信度与来源）；set 写一条。',
      },
      id: { type: 'string', maxLength: 128, description: 'op=set 时的稳定键，同 id 会覆盖。' },
      text: { type: 'string', maxLength: 4000, description: 'op=set 时的内容，一行。' },
      verified: {
        type: 'boolean',
        description: 'op=set 时是否标为已核实。默认 false——手工设置不该冒充满测量结果。',
      },
      provenance: { type: 'string', maxLength: 64, description: 'op=set 时记录来源。' },
    },
    summary: '读写 khy-os 与 Amoo 的共享记忆',
    note: 'Amoo 的执行环境在云端、/sdcard 对它不存在，所以共享介质是对话流本身：循环启动时注入，命令验证通过时自动写入 verified 条目。文件在 /sdcard/bridge-amoobridge/amoo_memory.json。json 与 injection 字段超过 20000 字会被截断。',
    resultCapChars: 20000,
  },
  {
    // 与桥侧新工具 amoo_stop 对齐：唯一能清掉 askRunning 单飞锁的即时中止入口。
    // 无线调试掉线留下的孤儿 ask 会把后续所有 ask 永久堵死（单飞锁不释放），
    // amoo_result 轮询超过最大预算（1800s）会自愈回 orphaned_ask 并释放锁，
    // 但那是被动等待；amoo_stop 是主动、即时的那一个。
    bridgeName: 'amoo_stop',
    khyName: 'phone_amoo_stop',
    aliases: [],
    access: ACCESS_ACTUATE,
    requiresAccessibility: false,
    optional: 'amoo',
    args: {},
    summary: '立即中止正在进行的 Amoo 反代任务（amoo_ask）',
    note: '释放 amoo_ask 的单飞锁，让后续 ask 能重新开始。没有正在跑的任务时也返回成功（幂等）。掉线堵死锁时用这个，不用等 amoo_result 的 1800s 自愈。',
    resultCapChars: 256,
  },
]);

// The UI surface of the build that ships inside the khy-os phone app
// (Tools.NAMES). Unlike the old standalone StepBridge lite build — which
// declared no accessibility service at all and answered `unknown tool` for
// every ui_* name — the merged app DOES register one:
// app/src/main/AndroidManifest.xml declares the <service> with
// BIND_ACCESSIBILITY_SERVICE, and the tool routes go through KhyUi into
// KhyAccessibilityService. Availability is still decided at runtime by the
// bridge's own `ui` field (ping / status), which is why the list lives here
// rather than being folded into BRIDGE_TOOLS.
const UI_TOOLS = Object.freeze([
  'ui_dump',
  'ui_tap',
  'ui_click',
  'ui_swipe',
  'ui_longpress',
  'ui_type',
  'ui_back',
  'ui_home',
  'ui_recents',
  'shot',
  'shot_b64',
]);

// v2.3.0 起 UI 工具的准入分级：桥在 /status 与 ping 里回报的 ui 字段是唯一
// 判据（lite 包恒 false；v2 包装了无障碍并授权后 true）。读类免确认，执行类
// 高危确认——与 BRIDGE_TOOLS 的 access 语义同一套。放 catalog 是因为工具
// 清单与分级同属「工具真相」，policy 只消费。
const UI_TOOL_ACCESS = Object.freeze({
  ui_dump: ACCESS_READ, shot: ACCESS_READ, shot_b64: ACCESS_READ,
  ui_tap: ACCESS_ACTUATE, ui_click: ACCESS_ACTUATE, ui_swipe: ACCESS_ACTUATE,
  ui_longpress: ACCESS_ACTUATE, ui_type: ACCESS_ACTUATE,
  ui_back: ACCESS_ACTUATE, ui_home: ACCESS_ACTUATE, ui_recents: ACCESS_ACTUATE,
});

const ACCESSIBILITY_GAP_REASON =
  '当前桥未报告 UI 能力（/status 的 ui 字段为 false 或读不到）。'
  + '在手机上打开 khy-os App 并启用其中的无障碍服务（KhyAccessibilityService），'
  + '然后用 khy phone status 确认 ui=true。';

// 助手协同（Amoo 反代）工具组：optional==='amoo' 的那一批。它们是「整组可关」的
// 能力——Amoo 没装时桥把它们报为 withheld，PC 侧据此判可用性（见 phoneBridgeClient
// 的 assistantAvailable 三态），模型工具面也可整组不广告（STEPNEO_INCLUDE_ASSISTANT_RELAY
// 默认关）。从 BRIDGE_TOOLS 派生而非另列一份，避免两处清单漂移。
const ASSISTANT_RELAY_TOOL_NAMES = Object.freeze(
  BRIDGE_TOOLS.filter((tool) => tool.optional === 'amoo').map((tool) => tool.bridgeName)
);

const ASSISTANT_GAP_REASON =
  '这组助手协同工具（Amoo 反代）需要手机上已安装并启用 Amoo（com.stepos.ailauncher）。'
  + '只有在桥把这些工具报为 withheld 时，PC 侧才判定「不可用」；桥没报到时判「未知」，'
  + '不据此说 Amoo 装没装。装好 Amoo 后用 khy phone tools 复查这组是否回到可调列表。';

const ALIAS_TARGETS = Object.freeze({
  shell_exec: 'exec',
  file_read: 'read',
  file_write: 'write',
  file_list: 'ls',
  sys_info: 'info',
});

function _asArray(value) {
  return Array.isArray(value) ? value.slice() : [];
}

function getPhoneBridgeTools() {
  return BRIDGE_TOOLS.map((tool) => ({ ...tool, args: { ...tool.args } }));
}

function getPhoneBridgeUiTools() {
  return _asArray(UI_TOOLS);
}

/** 助手协同（Amoo 反代）工具组的副本；optional==='amoo' 的那一批。 */
function getPhoneBridgeAssistantRelayTools() {
  return BRIDGE_TOOLS.filter((tool) => tool.optional === 'amoo').map((tool) => ({
    ...tool,
    args: { ...tool.args },
  }));
}

function isPhoneBridgeToolName(name) {
  return findPhoneBridgeTool(name) !== null;
}

function findPhoneBridgeTool(name) {
  const key = typeof name === 'string' ? name.trim() : '';
  if (!key) {
    return null;
  }
  for (const tool of BRIDGE_TOOLS) {
    if (tool.bridgeName === key || tool.khyName === key || tool.aliases.includes(key)) {
      return tool;
    }
  }
  const aliasTarget = ALIAS_TARGETS[key];
  if (aliasTarget) {
    return findPhoneBridgeTool(aliasTarget);
  }
  return null;
}

function resolveBridgeToolName(name) {
  const hit = findPhoneBridgeTool(name);
  return hit ? hit.bridgeName : null;
}

function isPhoneBridgeUiToolName(name) {
  const key = typeof name === 'string' ? name.trim() : '';
  return UI_TOOLS.includes(key);
}

/**
 * Per-tool risk tier, judged from the args alone so it stays assertable with
 * no phone attached. Tools whose access flips with an argument (clipboard
 * get/set, volume/brightness with or without a value) are resolved by
 * phoneBridgePolicy, which owns that lookup.
 */
function getPhoneBridgeToolAccess(name, args = {}) {
  const hit = findPhoneBridgeTool(name);
  if (!hit) {
    return null;
  }
  if (!hit.accessDependsOnOp) {
    return hit.access;
  }
  return _accessForOpDependentTool(hit, args);
}

function _accessForOpDependentTool(tool, args) {
  const params = args && typeof args === 'object' ? args : {};
  if (tool.bridgeName === 'clipboard') {
    return String(params.op || 'get').trim().toLowerCase() === 'set'
      ? ACCESS_ACTUATE
      : ACCESS_READ;
  }
  // volume / brightness: a present value means "set".
  const hasValue = Object.prototype.hasOwnProperty.call(params, 'level')
    || Object.prototype.hasOwnProperty.call(params, 'value');
  return hasValue ? ACCESS_ACTUATE : ACCESS_READ;
}

function getResultCapChars(name) {
  const hit = findPhoneBridgeTool(name);
  return hit ? hit.resultCapChars : DEFAULT_RESULT_CAP_CHARS;
}

function truncateBridgeResultText(text, capChars) {
  const input = typeof text === 'string' ? text : String(text ?? '');
  const cap = Number.isFinite(capChars) && capChars > 0 ? capChars : DEFAULT_RESULT_CAP_CHARS;
  if (input.length <= cap) {
    return { text: input, truncated: false };
  }
  return {
    text: `${input.slice(0, cap)}\n...[已截断，原长度 ${input.length} 字符]`,
    truncated: true,
  };
}

function _buildDefinitionDescription(tool) {
  return [
    tool.summary,
    tool.access === ACCESS_ACTUATE ? '（写操作，需确认后执行）' : '（只读）',
    tool.requiresAccessibility ? '（需要无障碍权限，当前构建未提供）' : '',
    tool.note ? `注意：${tool.note}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * The khy-os facing definition for one bridge tool: the phone_ prefixed name,
 * the JSON Schema translated from the bridge contract, and the honest boundary.
 * `name` is what a model would call; `bridgeName` is what goes on the wire.
 */
function toKhyToolDefinition(tool) {
  const properties = {};
  const required = [];
  for (const [argName, spec] of Object.entries(tool.args || {})) {
    const property = {
      type: spec.type,
      description: spec.description || '',
    };
    if (spec.enum) {
      property.enum = spec.enum.slice();
    }
    if (Number.isFinite(spec.minimum)) {
      property.minimum = spec.minimum;
    }
    if (Number.isFinite(spec.maximum)) {
      property.maximum = spec.maximum;
    }
    if (Number.isFinite(spec.maxLength)) {
      property.maxLength = spec.maxLength;
    }
    properties[argName] = property;
    if (spec.required) {
      required.push(argName);
    }
  }

  return {
    name: tool.khyName,
    bridgeName: tool.bridgeName,
    aliases: tool.aliases.slice(),
    description: _buildDefinitionDescription(tool),
    category: 'system',
    risk: tool.dangerous ? 'critical' : tool.access === ACCESS_ACTUATE ? 'high' : 'medium',
    requiresAccessibility: tool.requiresAccessibility === true,
    inputSchema: {
      type: 'object',
      properties,
      required,
    },
  };
}

function listKhyToolDefinitions() {
  return BRIDGE_TOOLS.map((tool) => toKhyToolDefinition(tool));
}

module.exports = {
  ACCESS_READ,
  ACCESS_ACTUATE,
  DEFAULT_RESULT_CAP_CHARS,
  LARGE_RESULT_CAP_CHARS,
  BRIDGE_TOOLS,
  UI_TOOLS,
  UI_TOOL_ACCESS,
  ALIAS_TARGETS,
  ACCESSIBILITY_GAP_REASON,
  ASSISTANT_RELAY_TOOL_NAMES,
  ASSISTANT_GAP_REASON,
  getPhoneBridgeTools,
  getPhoneBridgeUiTools,
  getPhoneBridgeAssistantRelayTools,
  findPhoneBridgeTool,
  isPhoneBridgeToolName,
  isPhoneBridgeUiToolName,
  resolveBridgeToolName,
  getPhoneBridgeToolAccess,
  getResultCapChars,
  truncateBridgeResultText,
  uiToolResultFieldCap,
  UI_TOOL_RESULT_FIELD_CAPS,
  toKhyToolDefinition,
  listKhyToolDefinitions,
};

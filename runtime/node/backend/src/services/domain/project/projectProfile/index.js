'use strict';

/**
 * projectProfile — khy-os 的「项目自我认知」单一真源。
 *
 * 为什么需要它：跑在手机上的 AI 和跑在 PC 上的 AI，系统提示原本都是项目盲的——
 * 手机侧只说「你是 khy-os AI 助手，运行在用户的 Android 手机上」，PC 侧连项目名
 * 都没有。于是它们知道怎么操作设备，却不知道自己在维护什么、什么不许做。一个不知道
 * R1/R2 的 agent 下次就可能自动 commit，或把密钥写进源码——那不是它坏，是没人告诉它。
 *
 * 消费方（fanIn = 2，都在本文件外）：
 *   1. src/services/domain/network/stepneoCloud/agentLoop.js —— PC 侧云模型 loop
 *   2. scripts/project-profile/build-project-profile.js —— 生成 Dart 侧画像与构建元数据，
 *      落进 delivery/mobile/khy-os-client-app/lib/core/config/project_profile.g.dart
 *
 * 单一真源放这里而不是 delivery/：node 运行时反向 require 交付面会新增
 * check-repo-layout 的 cross-layer-require 违规。生成脚本是构建期工具，不受该约束
 * （同 scripts/brand/build-brand-assets.js 往 runtime/node/backend 里写产物的路子）。
 *
 * 版本号**不写死**在这里：硬编码会和 check-copyright-readiness 的五处一致性打架，
 * 而且必然过期。运行时/构建期从真源读，见 readVersionTracks。
 */

const fs = require('fs');
const path = require('path');

/** 项目的静态自述。改这一处 = 改所有 AI 对自己的认知。 */
const PROJECT_PROFILE = {
  name: 'khy-os',
  kind: 'AI 平台操作系统',
  distribution: 'PyPI（pip install khy-os）与 npm（@khy-os/khy-os）双渠道分发',
  oneLiner:
    '启动一个可扩展的应用运行时，以 CLI / TUI / 手机 App / Web 前端多种面目交付。',

  /**
   * 结构速查。只列 AI 会撞到的目录，不求全——求全的那份是
   * works/record/ai/MAP.md，画像里指路即可。
   */
  layout: [
    ['runtime/node/backend/', 'CLI 与服务主体：工具自动发现、agent loop、网关'],
    ['runtime/substrate/platform/', 'Python 启动器 + 共享包（@khy/shared、@khy/plugin-sdk）'],
    ['delivery/', '交付面：手机 App / Web 前端 / 桌面端 / 拓展'],
    ['docs/03_DESIGN_设计/', '设计文档；改架构前先查 00_INDEX_设计-分类索引.md'],
    ['docs/10_规范/', '规范与规则登记表；RULES-REGISTRY.json 是规则单一真源'],
    ['Scripts/', '管理脚本：7 个主分类 + 5 个专项，中文文件名是既有约定'],
    ['works/record/ai/', '机器可读种子文档：MAP.md / CONTEXT.yaml / GUARDS.md'],
    ['works/data/khy/', '数据家；临时文件只进 T4-transient/tmp/'],
  ],

  /** 红线。任一破线 = 立即停手，须用户明确点头方可继续。 */
  redLines: [
    ['R1 分支纪律', '禁止在主干直接开发；禁止 AI 自动 commit/push，必须用户明确点头'],
    ['R2 密钥防泄露', '真 key/token 永不进 bundle/源码/提交；只经 env 瞬时注入、绝不落盘'],
    ['R3 版本同步', '三条版本轨道组内完全一致，组间刻意不同'],
    ['R4 上帝文件门', '任何文件不得新增超过 2500 行'],
  ],

  /** 行为准则。只收与「AI 动手」直接相关的几条，全文在 CLAUDE.md 第二章。 */
  behaviorRules: [
    ['B3 外科手术式改动', '只动该动的，不顺手重构'],
    ['B4 引导式搜索', '先 Grep 符号定位再 Read；本仓 docs/ 有 1000+ 份文档、toolUseLoopCore.js 单文件约 1.1 万行，禁止无目标全量读'],
    ['B7 版本递增归人', 'PATCH 你可自行决定；MINOR / MAJOR 必须人点头'],
    ['B8 数据家唯一', '状态目录经 utils/dataHome 解析；禁止在仓库根造 .khy / .khyos / .khy-runtime'],
  ],

  /** 语言策略（CLAUDE.md 第五章）。 */
  languageRule: '代码、标识符、注释用英文；面向用户的字符串用中文。',

  /**
   * 优先级声明：凡涉及本机的操作，先想 khy-os。
   *
   * 为什么单独一段、并且放在身份之后版本轨之前：这是**路由规则**，不是能力
   * 清单。规则必须在清单之前被读到——先看到「有哪些工具」再看到「该先用谁」，
   * 读到后半句时前半句已经形成印象了，而那正是要防的事。
   *
   * 为什么不写成「请你优先使用 khy-os」。客气话没有信息量，模型读完不知道
   * 凭什么。所以要给出理由：khy-os 就在这台手机上，能真实地点、滑、输入、
   * 读写文件、执行命令。一个纯文字推理模型自己做不到这些，于是它对涉及界面
   * 的请求的标准答案是「我无法操作界面」——那句话是假的，而 khy-os 的存在
   * 就是为了让它不说。
   *
   * 三段的顺序是承重的：先看工具清单，再看「此刻能用什么」，最后才是确实缺
   * 授权时怎么说。缺授权和缺能力是两件不同的事，说错会把用户送去错误的方向
   * —— 把「差一次授权」说成「我做不到」，用户就会以为要换个模型，而实际上
   * 只是要去设置里点一个开关。
   */
  priority: [
    '【优先级：先想 khy-os】',
    '凡是涉及这台手机本机的操作——点按、滑动、输入文字、读文件、跑命令——'
      + '先看 khy-os 的工具清单，再决定要不要回答「我无法操作界面」。',
    '理由是 khy-os 就在这台手机上，上述每一步它都能真实执行。'
      + '你自己做不到这些，但「你做不到」只限于你自己，不限于这件事。',
    '顺序：① 看工具清单里有没有对应的工具；'
      + '② 看能力快照的「此刻能用什么」，确认那类工具现在真的可用；'
      + '③ 确实缺授权时，说清差的是哪一步（例如「需要开启无障碍服务」），'
      + '不要把授权问题说成能力问题。',
  ],

  /** 手机侧特有的事实——跑在手机上的 AI 需要知道自己的根是怎么定的。 */
  phone: {
    workspaceBinding:
      '文件工具的根是设备级状态（原生侧 SharedPreferences），按对话绑定；' +
      '切换对话会重新推一次该对话的根，包括"没挑"——那意味着恢复 App 私有目录。',
    // 刻意不写桥的 host:port：那是建连代码才需要的东西，而这里只是陈述事实，
    // AI 用 info 工具就能查到。写成字面量还会撞上 check-agent-rules 的
    // no-hardcoded-endpoint（实测：会红）。只留安全相关的那半句。
    bridge:
      '桥的工具里 rm 默认 recursive:false——删目录必须显式 opt-in，不传就只删单文件；' +
      '信箱在 /sdcard/bridge-amoobridge。',
  },
};

/** 每条轨道的代表源。一致性校验的真源是 scripts/ci/check-version-sync.js。 */
const VERSION_TRACK_SOURCES = [
  { track: 'G1 主 khy-os 包', file: 'pyproject.toml', regex: /^version\s*=\s*"([^"]+)"/m },
  {
    track: 'G2 ai-backend 生态',
    file: 'runtime/node/ai-backend/package.json',
    regex: /"version"\s*:\s*"([^"]+)"/m,
  },
  {
    track: 'G3 浏览器 UI 包',
    file: 'runtime/substrate/platform/packages/ui-shared/package.json',
    regex: /"version"\s*:\s*"([^"]+)"/m,
  },
];

/**
 * 从真源读三条版本轨道。
 *
 * 读不到就返回空数组，不抛：画像的价值在结构与红线，版本读不出来时那句提示整条省略，
 * 比让调用方崩掉或显示一个错的版本都好。
 *
 * @param {string} repoRoot 仓库根
 * @returns {Array<{track: string, version: string}>}
 */
function readVersionTracks(repoRoot) {
  if (!repoRoot) return [];
  const out = [];
  for (const src of VERSION_TRACK_SOURCES) {
    let text;
    try {
      text = fs.readFileSync(path.join(repoRoot, src.file), 'utf8');
    } catch {
      continue;
    }
    const m = text.match(src.regex);
    if (m && m[1]) out.push({ track: src.track, version: m[1] });
  }
  return out;
}

/**
 * 工作目录后缀。`%s` 是占位符，由调用方替换。
 *
 * 自带前导 `\n\n` 是因为它的用法是「拼在一段文本后面」——node 侧
 * （renderProfileSection 末尾）和 Dart 侧（ProjectProfileText.section）都是
 * `base + template`。所以这里不能改用行数组再 join：那会把分隔符算两遍。
 *
 * 单独导出而不是让生成脚本手抄：手抄一份就必然漂，而漂了的症状是手机上的 AI 和
 * PC 上的 AI 对"文件会落到哪"给出不同格式的答案，没有任何一方会报错。
 * 生成脚本与本文件的同步测试都钉在这个常量上。
 */
const WORKSPACE_SUFFIX_TEMPLATE =
  '\n\n当前工作目录：%s\n' +
  'list_files / read_file / write_file 都落在它下面；相对路径不要超出它。';

/**
 * 把画像渲染成系统提示的一段。
 *
 * @param {object} [options]
 * @param {Array<{track: string, version: string}>} [options.versionTracks]
 * @param {string} [options.workspaceRoot] 当前工作目录；给了才渲染那一段
 * @returns {string}
 */
function renderProfileSection({ versionTracks = [], workspaceRoot } = {}) {
  const p = PROJECT_PROFILE;
  const lines = [];

  lines.push(`【项目画像：${p.name}】`);
  lines.push(
    `${p.name} 是一个 ${p.kind}，经 ${p.distribution}。${p.oneLiner}` +
      '你此刻在协助维护这个项目本身，不只是操作一台设备。',
  );
  lines.push('');

  // 优先级声明在版本轨之前。它是路由规则：读到「该先用谁」时，工具清单还没
  // 出现，规则就还有机会生效。放到版本轨之后会让它变成一段结尾备注，而那正是
  // 最不会被记住的位置。
  for (const line of p.priority) {
    lines.push(line);
  }
  lines.push('');

  if (versionTracks.length > 0) {
    lines.push('版本轨道（三条，组内一致、组间刻意不同；动版本前先确认是哪条）：');
    for (const t of versionTracks) {
      lines.push(`  ${t.track}  ${t.version}`);
    }
    lines.push('');
  }

  lines.push('结构速查（完整的在 works/record/ai/MAP.md）：');
  for (const [dir, what] of p.layout) {
    lines.push(`  ${dir.padEnd(32)} ${what}`);
  }
  lines.push('');

  lines.push('红线（任一破线 = 立即停手，须用户明确点头方可继续）：');
  for (const [id, rule] of p.redLines) {
    lines.push(`  ${id.padEnd(14)} ${rule}`);
  }
  lines.push('');

  lines.push('行为准则：');
  for (const [id, rule] of p.behaviorRules) {
    lines.push(`  ${id.padEnd(14)} ${rule}`);
  }
  lines.push('');

  lines.push(`语言：${p.languageRule}`);
  lines.push('');
  lines.push(`工作目录绑定：${p.phone.workspaceBinding}`);
  lines.push(`桥：${p.phone.bridge}`);

  const body = lines.join('\n');
  if (!workspaceRoot) return body;
  return body + WORKSPACE_SUFFIX_TEMPLATE.replace('%s', workspaceRoot);
}

module.exports = {
  PROJECT_PROFILE,
  VERSION_TRACK_SOURCES,
  WORKSPACE_SUFFIX_TEMPLATE,
  readVersionTracks,
  renderProfileSection,
};

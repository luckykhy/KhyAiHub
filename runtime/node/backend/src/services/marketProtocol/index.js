'use strict';

/**
 * marketProtocol — cross-ecosystem plugin descriptor translation (khy-market/1).
 *
 * Every upstream ecosystem names the same things differently: Claude Code
 * calls it a plugin with commands/agents, OpenClaw ships `openclaw.plugin.json`
 * with contracts.tools, the StepFun marketplace calls an asset a skill or a
 * plugin by number. KhyOS has exactly three install surfaces (skill / mcp /
 * extension) plus "none". This module is the only place that decides which
 * surface a foreign descriptor lands on, so the catalog, the desktop pane and
 * future importers cannot drift into three different answers.
 *
 * The output is descriptive, never an installer: `install.khyos` is the command
 * a human runs after the terminal gates approve it. Nothing here writes files
 * or downloads archives.
 */

const PROTOCOL_ID = 'khy-market/1';

const KINDS = Object.freeze([
  'skill',
  'plugin',
  'agent',
  'mcp',
  'trigger',
  'connector',
  'experience',
  'unknown',
]);

const MARKETS = Object.freeze(['skill', 'mcp', 'extension', 'none']);
// `covered` is not a weaker `blocked`: the capability question is answered by a
// KhyOS-native feature, so importing the package would be duplicate work. The
// catalog used to file those under `blocked` and every native duplicate looked
// like an unresolved compatibility failure.
const COMPAT_VALUES = Object.freeze(['direct', 'adapter-needed', 'covered', 'blocked']);

// Blockers are structural facts, not prose. `resolution` says who can clear it:
// a missing KhyOS surface cannot be "fixed" by an adapter; a human ruling can.
const BLOCKERS = Object.freeze({
  'unsupported-surface': {
    category: 'surface',
    resolution: 'not-supported',
    note: 'KhyOS 没有该形态的运行时落点（触发器/通信器/知识集合等宿主级能力）。',
  },
  'license-c': {
    category: 'license',
    resolution: 'human-approval',
    note: '上游是 C 档许可证（GPL/LGPL/AGPL 等），禁止进入任何入仓目录。',
  },
  'license-unknown': {
    category: 'license',
    resolution: 'human-approval',
    note: '许可证未知或专有：只能本机态安装或作 reference，不得 vendored 进仓。',
  },
  'no-importable-capability': {
    category: 'shape',
    resolution: 'adapter-required',
    note: '描述符未声明工具、技能、MCP 或命令，导入后没有可执行内容。',
  },
  'user-decision': {
    category: 'policy',
    resolution: 'human-approval',
    note: '结构性阻塞不明确，需人按上游说明逐条裁决后才能解除。',
  },
  'covered-by-native': {
    category: 'native',
    resolution: 'use-native',
    note: 'KhyOS 已有等效原生能力，无需导入该制品；保留条目只为对照上游功能。',
  },
  'not-an-artifact': {
    category: 'shape',
    resolution: 'not-supported',
    note: '上游是宿主/索引/服务本体，不是可安装制品。',
  },
});

const C_LICENSE_RE = /^(?:A?GPL|LGPL|EUPL|OSL|MPL)(?:[-.]|$)/i;
const A_LICENSE_RE = /^(?:MIT|Apache-2\.0|BSD(?:-[23]-Clause)?|ISC|Unlicense|0BSD|CC0-1\.0)$/i;

// Domain categories answer "what is this for", independent of the install
// surface (skill / mcp / extension) and of the source tab. Only Open VSX ships
// a category field; every other source gets a deterministic keyword read of
// its own name/description so one source can still be split into office, dev,
// data … without inventing per-entry hand labels.
const CATEGORY_LABELS = Object.freeze({
  office: '办公效率',
  dev: '开发工具',
  data: '数据与分析',
  web: '搜索与浏览',
  design: '设计媒体',
  comm: '沟通协作',
  ops: '系统运维',
  security: '安全合规',
  ai: 'AI 与模型',
  other: '其他',
});

// Open VSX categories are the marketplace's own enum; `Other` is deliberately
// absent so it falls through to the keyword read instead of pinning `other`.
const VSCODE_CATEGORY_KEYS = Object.freeze({
  'programming languages': 'dev',
  snippets: 'dev',
  linters: 'dev',
  debuggers: 'dev',
  formatters: 'dev',
  testing: 'dev',
  'scm providers': 'dev',
  'extension packs': 'dev',
  keymaps: 'dev',
  themes: 'design',
  icons: 'design',
  fonts: 'design',
  'data science': 'data',
  notebooks: 'data',
  visualization: 'data',
  'machine learning': 'ai',
  ai: 'ai',
  chat: 'ai',
  web: 'web',
  education: 'other',
  'language packs': 'other',
});

// Ordered most-specific first: `data` outranks `dev` because a GitHub data
// server is more useful under 数据 than under 开发; `security` and `office`
// outrank both for the same reason.
const CATEGORY_RULES = Object.freeze([
  { key: 'security', re: /\b(security|secure|auth|oauth|jwt|secret|vault|vulnerab|pentest|cve|sast|compliance|privacy|encrypt|red.?team)\b|安全|认证|密钥|漏洞|合规|红队|渗透|攻防/ },
  { key: 'office', re: /\b(office|word|excel|powerpoint|ppt|pdf|notion|obsidian|calendar|todo|task|meeting|documents?|docs?|markdown|notes?|email|mail|spreadsheet|kanban)\b|办公|文档|表格|笔记|日历|邮件|待办/ },
  { key: 'comm', re: /\b(chat|slack|discord|telegram|wechat|wecom|message|messaging|notification|sms|mailbox|inbox)\b|聊天|消息|通知|协作|群组/ },
  { key: 'design', re: /\b(design|image|photo|video|audio|figma|icon|font|theme|svg|ui|ux|screenshot|diagram|color)\b|设计|图像|图片|视频|音频|图标|字体|主题|配色/ },
  { key: 'data', re: /\b(data|database|sql|postgres|mysql|sqlite|mongodb|redis|analytics|chart|csv|etl|warehouse|metrics?|statistics|dataset)\b|数据|数据库|分析|图表|统计/ },
  { key: 'ops', re: /\b(docker|kubernetes|k8s|devops|deploy|cloud|aws|azure|gcp|server|ssh|nginx|monitor|logging|infra|terraform|ansible|systemd)\b|部署|运维|服务器|监控|日志|云端/ },
  { key: 'web', re: /\b(search|browser|crawl|scrape|http|web|url|fetch|rss|seo|website)\b|搜索|浏览|爬虫|网页|抓取/ },
  { key: 'ai', re: /\b(llm|gpt|openai|anthropic|claude|gemini|model|prompt|embedding|rag|fine-?tun|neural|machine learning|inference)\b|大模型|模型|智能体|推理|向量/ },
  { key: 'dev', re: /\b(code|coding|git|github|gitlab|debug|lint|test|build|compiler|language|snippet|refactor|api|sdk|ide|vscode|typescript|javascript|python|rust|golang|kotlin|swift|terminal|shell)\b|代码|开发|编程|调试|编译|命令行/ },
]);

const OPENCLAW_ASSET_TYPES = Object.freeze({
  1: 'experience',
  2: 'skill',
  3: 'plugin',
  4: 'trigger',
  5: 'connector',
  6: 'agent',
});

// The StepFun marketplace's local names differ from its catalog enum
// (channel ↔ CONNECTOR, experience ↔ KNOWLEDGE_COLLECTION).
const OPENCLAW_LOCAL_TYPES = Object.freeze({
  experience: 'experience',
  skill: 'skill',
  plugin: 'plugin',
  trigger: 'trigger',
  channel: 'connector',
  connector: 'connector',
  agent: 'agent',
});

// Which KhyOS surface each OpenClaw asset type can reach. `adapter-needed`
// means the archive/manifest must be exported or rewritten first; nothing here
// pretends a foreign package drops straight into a KhyOS root untouched.
const STEPFUN_ROUTES = Object.freeze({
  skill: { market: 'skill', compat: 'adapter-needed', adapter: 'openclawmp-archive' },
  plugin: { market: 'extension', compat: 'adapter-needed', adapter: 'openclaw-manifest' },
  agent: { market: 'skill', compat: 'adapter-needed', adapter: 'agent-bundle' },
  experience: { market: 'none', compat: 'blocked', blocker: 'unsupported-surface' },
  trigger: { market: 'none', compat: 'blocked', blocker: 'unsupported-surface' },
  connector: { market: 'none', compat: 'blocked', blocker: 'unsupported-surface' },
});

function _str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function _list(value) {
  return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined) : [];
}

/**
 * Resolve one domain category. `category` is the upstream's own field when it
 * has one (Open VSX `categories`); otherwise the text read is deterministic and
 * reported as `derived` so the UI can say where the label came from.
 */
function categoryOf(fields) {
  const input = fields && typeof fields === 'object' ? fields : {};
  const raw = input.category;
  const upstream = (Array.isArray(raw) ? raw : String(raw || '').split(','))
    .map((item) => _str(item))
    .filter(Boolean);
  for (const label of upstream) {
    const mapped = VSCODE_CATEGORY_KEYS[label.toLowerCase()];
    if (mapped) return { key: mapped, label: CATEGORY_LABELS[mapped], source: 'upstream' };
  }
  const haystack = [input.name, input.what, input.description, input.upstreamUrl]
    .map(_str)
    .join(' ')
    .toLowerCase();
  if (haystack.trim()) {
    for (const rule of CATEGORY_RULES) {
      if (rule.re.test(haystack)) {
        return { key: rule.key, label: CATEGORY_LABELS[rule.key], source: 'derived' };
      }
    }
  }
  return { key: 'other', label: CATEGORY_LABELS.other, source: 'default' };
}

function normalizeKind(value) {
  const kind = _str(value).toLowerCase();
  if (kind === 'channel' || kind === 'connector') return 'connector';
  if (kind === 'knowledge' || kind === 'knowledge_collection' || kind === 'experience') {
    return 'experience';
  }
  if (kind === 'extension' || kind === 'openclaw-plugin') return 'plugin';
  if (kind === 'command' || kind === 'commands' || kind === 'hook' || kind === 'hooks') {
    return 'plugin';
  }
  return KINDS.includes(kind) ? kind : 'unknown';
}

function normalizeCompat(value, market) {
  const compat = _str(value).toLowerCase();
  if (COMPAT_VALUES.includes(compat)) return compat;
  return market === 'none' ? 'blocked' : 'adapter-needed';
}

function blocker(code, detail) {
  const known = BLOCKERS[code] || BLOCKERS['user-decision'];
  return {
    code: BLOCKERS[code] ? code : 'user-decision',
    category: known.category,
    resolution: known.resolution,
    note: detail ? `${known.note} ${detail}` : known.note,
  };
}

function licenseBlocker(license) {
  const value = _str(license);
  if (!value || value === 'unknown' || value === 'NOASSERTION' || value === 'Proprietary') {
    return blocker('license-unknown', `上游标注：${value || '未标注'}。`);
  }
  if (C_LICENSE_RE.test(value)) {
    return blocker('license-c', `上游标注：${value}。`);
  }
  return null;
}

function isALicense(license) {
  return A_LICENSE_RE.test(_str(license));
}

function commandForCatalog(entry, market, compat, adapter) {
  const explicit = _str(entry.khyCommand);
  if (explicit) return explicit;
  if (compat !== 'direct' && compat !== 'adapter-needed') return undefined;
  const url = _str(entry.upstreamUrl);
  if (!url) return undefined;
  const sub = _str(entry.skillSubdir);
  if (market === 'skill') {
    // A repo can ship a portable skill under skills/<name>/ even when its
    // plugin surface is unsupported; `--skill` is the CLI's documented way to
    // pick that subdirectory instead of guessing the first one.
    if (adapter === 'skill-add' && sub) return `khy skill add ${url} --skill ${sub}`;
    if (compat === 'direct') return `khy skill add ${url}`;
    return undefined;
  }
  if (compat === 'direct' && market === 'extension') return `khy ext install ${url}`;
  return undefined;
}

function _tokenize(text) {
  const out = [];
  let cur = '';
  let quote = '';
  let quoted = false;
  for (const ch of String(text || '')) {
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur || quoted) out.push(cur);
      cur = '';
      quoted = false;
      continue;
    }
    cur += ch;
  }
  if (cur || quoted) out.push(cur);
  return out;
}

/**
 * Turn a catalog `khy …` install command into a structured spec the install
 * service can execute without re-parsing prose. Only the two surfaces KhyOS
 * can actually install are recognised; anything else stays command-only.
 */
function parseKhyCommand(command) {
  const tokens = _tokenize(command);
  if (tokens.length < 4 || tokens[0].toLowerCase() !== 'khy') return null;
  const group = tokens[1].toLowerCase();
  const verb = tokens[2].toLowerCase();
  if (group === 'skill' && verb === 'add') {
    const source = tokens[3];
    if (!source) return null;
    let skill = '';
    for (let i = 4; i < tokens.length; i += 1) {
      if (tokens[i] === '--skill') {
        skill = tokens[i + 1] || '';
        break;
      }
      if (tokens[i].startsWith('--skill=')) {
        skill = tokens[i].slice('--skill='.length);
        break;
      }
    }
    return { mode: 'skill', source, skills: skill ? [skill] : [] };
  }
  if (group === 'mcp' && verb === 'add') {
    const name = tokens[3];
    if (!name) return null;
    // khy's own parser drops the `--` separator before the command; the shared
    // builder expects the post-separator slice, so drop it here too.
    let rest = tokens.slice(4);
    const sep = rest.indexOf('--');
    if (sep >= 0) rest = rest.slice(sep + 1);
    let built;
    try {
      // One parser for CLI and marketplace: the written config is exactly what
      // `khy mcp add` itself would write.
      built = require('../domain/messaging/mcp/mcpAddSpec.js').buildServerConfig({ name, rest });
    } catch {
      return null;
    }
    if (!built || !built.ok) return null;
    return { mode: 'mcp', name: built.name, scope: built.scope, config: built.config };
  }
  return null;
}

function catalogBlocker(entry, canonical) {
  const declared = _str(entry.blocker);
  if (declared && BLOCKERS[declared]) {
    return blocker(declared, _str(entry.blockerNote) || _str(entry.compatNote).slice(0, 160));
  }
  const license = licenseBlocker(entry.license);
  if (license) return license;
  const kind = canonical.kind;
  if (
    canonical.route.market === 'none' ||
    kind === 'agent' ||
    kind === 'trigger' ||
    kind === 'connector' ||
    kind === 'experience'
  ) {
    return blocker('unsupported-surface');
  }
  return blocker('user-decision', _str(entry.compatNote).slice(0, 160));
}

/**
 * Translate one `delivery/market` catalog entry into the unified descriptor.
 * Catalog entries are already surveyed decisions; this keeps them readable by
 * the same router that handles live ecosystems instead of a second dialect.
 */
function fromCatalogEntry(entry, eco) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const kind = normalizeKind(source.type || source.kind);
  const compat = normalizeCompat(source.compat, _str(source.khyosMarket));
  const market = compat === 'covered'
    ? 'none'
    : MARKETS.includes(_str(source.khyosMarket)) ? _str(source.khyosMarket) : 'none';
  const adapter = _str(source.adapter) || (compat === 'direct' ? 'native' : null);
  const name = _str(source.name) || '未命名条目';
  const khyosCommand = commandForCatalog(source, market, compat, adapter);
  const canonical = {
    protocol: PROTOCOL_ID,
    id: `${_str(eco) || 'unknown'}:${name}`,
    name,
    displayName: name,
    description: _str(source.what),
    version: '',
    author: null,
    tags: [],
    source: {
      eco: _str(eco) || 'unknown',
      url: _str(source.upstreamUrl),
      assetId: '',
      kind: 'catalog',
      license: _str(source.license) || 'unknown',
    },
    kind,
    capabilities: [],
    route: {
      market,
      compat,
      adapter: compat === 'direct' || compat === 'adapter-needed' ? adapter : null,
      reason: _str(source.compatNote) || _str(source.targetPath),
    },
    install: {
      upstream: _str(source.command) || undefined,
      khyos: khyosCommand,
      note: _str(source.targetPath),
      spec: parseKhyCommand(khyosCommand),
    },
    permissions: {},
  };
  if (compat === 'blocked') {
    canonical.blocker = catalogBlocker(source, canonical);
  } else if (compat === 'covered') {
    canonical.blocker = blocker('covered-by-native', _str(source.blockerNote));
  }
  return canonical;
}

// ClawHub files a lot of skill packages under the trigger/connector buckets; the
// real artifact is whatever `longDescription` links to. The source path is
// authoritative (`skills/<owner>/<name>`), so route by it instead of the bucket.
const SKILL_SOURCE_RE =
  /(https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/tree\/[A-Za-z0-9._/-]+\/(skills\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/?(?=[\s)]|$)/;

function openClawSkillSource(text) {
  const match = SKILL_SOURCE_RE.exec(String(text || ''));
  if (!match) return null;
  return { repoUrl: match[1], subdir: match[2] };
}

function stepfunInstall(kind, assetId) {
  const localType = kind === 'connector' ? 'channel' : kind;
  const upstream = assetId ? `openclawmp install ${localType}/${assetId}` : undefined;
  if (!assetId) return { upstream: undefined, khyos: undefined, note: '缺少 assetId，无法生成安装命令。' };
  if (kind === 'skill') {
    return {
      upstream,
      khyos: 'khy skill import <解压后的技能目录>',
      note: '先取归档并解压；目录含 SKILL.md 后交给 khy skill import。',
    };
  }
  if (kind === 'plugin') {
    return {
      upstream,
      khyos: 'khy ext install <解压后的插件目录>',
      note: '按 khy-market/1 把 openclaw.plugin.json 翻译成 khy.extension.json 后安装。',
    };
  }
  if (kind === 'agent') {
    return {
      upstream,
      khyos: 'khy skill import <改写后的 SKILL.md 目录>',
      note: 'Agent 指令需改写为 SKILL.md 后按技能导入。',
    };
  }
  return { upstream, khyos: undefined, note: 'KhyOS 无对应安装面。' };
}

/**
 * Translate one StepFun/OpenClaw marketplace asset (CatalogService.SearchAssets
 * shape) into the unified descriptor. `baseUrl` is injected so the caller owns
 * endpoint policy; tests pass a fixture URL and never touch the network.
 */
function fromOpenClawAsset(asset, options) {
  const source = asset && typeof asset === 'object' ? asset : {};
  const opts = options || {};
  const eco = _str(opts.eco) || 'stepfun-openclaw';
  const baseUrl = _str(opts.baseUrl).replace(/\/+$/, '');
  const assetId = _str(source.assetId);
  const upstreamKind = OPENCLAW_ASSET_TYPES[Number(source.assetType)] || 'unknown';
  const skillSource = openClawSkillSource(source.longDescription) || openClawSkillSource(source.description);
  // `artifactSkillDir` comes from an archive probe: the listing has no Source
  // link, but the downloaded package itself carries a SKILL.md directory.
  const artifactSkillDir = _str(opts.artifactSkillDir);
  const kind = skillSource || artifactSkillDir ? 'skill' : upstreamKind;
  const route = skillSource
    ? { market: 'skill', compat: 'adapter-needed', adapter: 'skill-extract' }
    : artifactSkillDir
      ? { market: 'skill', compat: 'adapter-needed', adapter: 'openclawmp-archive' }
      : STEPFUN_ROUTES[upstreamKind] || {
          market: 'none',
          compat: 'blocked',
          blocker: 'unsupported-surface',
        };
  const name = _str(source.name) || _str(source.displayName) || assetId || '未命名资产';
  const author = source.author && typeof source.author === 'object' ? source.author : {};
  const install = stepfunInstall(upstreamKind, assetId);
  if (skillSource) {
    install.khyos = `khy skill add ${skillSource.repoUrl} --skill ${skillSource.subdir}`;
    install.note = `Source 指向 ${skillSource.subdir}：按技能子目录抽取，不依赖上游 ${upstreamKind} 类目的宿主能力。`;
    install.spec = { mode: 'skill', source: skillSource.repoUrl, skills: [skillSource.subdir] };
  } else if (artifactSkillDir) {
    install.khyos = 'khy skill import <解压后的技能目录>';
    install.note = `归档内 ${artifactSkillDir} 含 SKILL.md：取归档解压后交给 khy skill import。`;
  }
  const reason = skillSource
    ? `${name} 在阶跃市场登记为 ${upstreamKind}，但 Source 指向 ${skillSource.repoUrl} 的 ${skillSource.subdir}，实际是可抽取的 SKILL.md 技能目录；按技能接入。`
    : artifactSkillDir
      ? `${name} 在阶跃市场登记为 ${upstreamKind}；归档探测到 ${artifactSkillDir} 含 SKILL.md，按技能导入，不依赖上游 ${upstreamKind} 类目的宿主能力。`
      : stepfunReason(upstreamKind, name);
  const canonical = {
    protocol: PROTOCOL_ID,
    id: `${eco}:${assetId || name}`,
    name,
    displayName: _str(source.displayName) || name,
    description: _str(source.longDescription) || _str(source.description),
    version: _str(source.latestSemver),
    author: {
      name: _str(author.displayName),
      id: _str(author.userId),
      avatarUrl: _str(author.avatarUrl),
    },
    tags: _list(source.tags)
      .map((tag) => (tag && typeof tag === 'object' ? _str(tag.displayName) : _str(tag)))
      .filter(Boolean),
    source: {
      eco,
      url: assetId && baseUrl ? `${baseUrl}/asset/${encodeURIComponent(assetId)}` : baseUrl,
      assetId,
      kind: 'openclawmp',
      license: 'unknown',
      category: _str(source.category),
      downloads: _str(source.downloadCount),
      stars: _str(source.totalStars),
    },
    kind,
    capabilities: [{ type: kind }],
    route: {
      market: route.market,
      compat: route.compat,
      adapter: route.adapter || null,
      reason,
    },
    install,
    permissions: {},
  };
  if (route.blocker) {
    canonical.blocker = blocker(route.blocker);
  } else if (route.market !== 'none') {
    // Packages are not inspected at listing time; unknown licence is a real
    // gate, not a placeholder, so it must surface on the descriptor itself.
    canonical.blocker = licenseBlocker('unknown');
  }
  return canonical;
}

function stepfunReason(kind, name) {
  if (kind === 'skill') {
    return `${name} 是 OpenClaw 技能资产：归档解压出 SKILL.md 目录后，用 khy skill import 接入；站内安装命令只写 OpenClaw 自己的目录。`;
  }
  if (kind === 'plugin') {
    return `${name} 是 OpenClaw 插件资产：openclaw.plugin.json 已能被 KhyOS 拓展发现链读取，但工具声明与 hooks 需按 khy-market/1 翻译后才可激活。`;
  }
  if (kind === 'agent') {
    return `${name} 是 Agent 资产：KhyOS 没有 Agent 市场，需把指令与技能改写为 SKILL.md 后按技能导入。`;
  }
  if (kind === 'experience') {
    return `${name} 是经验/知识集合：KhyOS 没有知识集合安装面。`;
  }
  if (kind === 'trigger') {
    return `${name} 是触发器：KhyOS 无触发器宿主面；对应能力走 hooks/commands。`;
  }
  if (kind === 'connector') {
    return `${name} 是通信器：KhyOS 无外部通信器通道面。`;
  }
  return `${name} 的资产类型不在 khy-market/1 映射表内。`;
}

/**
 * Translate one Open VSX extension (registry detail JSON + the package.json
 * inside its VSIX) into the unified descriptor. VSIX is host-bound, so the
 * honest routes are the declared MCP provider and the command surface that can
 * be rewritten; themes/grammars are data, not installable capability.
 */
function fromVsCodeExtension(detail, manifest, options) {
  const source = detail && typeof detail === 'object' ? detail : {};
  const pkg = manifest && typeof manifest === 'object' ? manifest : null;
  const opts = options || {};
  const eco = _str(opts.eco) || 'vscode';
  const baseUrl = _str(opts.baseUrl).replace(/\/+$/, '');
  const namespace = _str(source.namespace);
  const name = _str(source.name);
  const id = `${namespace}.${name}`.replace(/^\./, '');
  const displayName = _str(source.displayName) || _str(pkg && pkg.displayName) || id;
  const license = _str(source.license) || _str(pkg && pkg.license) || 'unknown';
  const files = source.files && typeof source.files === 'object' ? source.files : {};
  const publishedBy =
    source.publishedBy && typeof source.publishedBy === 'object' ? source.publishedBy : {};
  const contributes =
    pkg && pkg.contributes && typeof pkg.contributes === 'object' ? pkg.contributes : null;
  const categories = _list(source.categories).map((item) => _str(item)).filter(Boolean);
  const tags = _list(source.tags).map((item) => _str(item)).filter(Boolean);

  let kind = 'plugin';
  let route;
  let reason;
  if (!pkg) {
    route = { market: 'none', compat: 'blocked', blocker: 'user-decision' };
    reason = `${displayName} 的 package.json 清单未能读取，无法判定它能否落到技能 / MCP / 拓展面；按待裁决阻塞登记。`;
  } else if (Array.isArray(contributes && contributes.mcpServerDefinitionProviders)
    && contributes.mcpServerDefinitionProviders.length > 0) {
    kind = 'mcp';
    route = { market: 'mcp', compat: 'adapter-needed', adapter: 'vscode-mcp-provider' };
    reason = `${displayName} 通过 VS Code API 注册 MCP 服务器（mcpServerDefinitionProviders）：VSIX 不能在 KhyOS 里当服务器进程运行，需按扩展文档取得实际启动命令后 khy mcp add。`;
  } else if (contributes && (contributes.chatParticipants || contributes.chatAgents || contributes.languageModelTools)) {
    route = { market: 'extension', compat: 'adapter-needed', adapter: 'vscode-host-api' };
    reason = `${displayName} 的聊天参与者 / 语言模型工具依赖 vscode 宿主 API；需按 khy.extension.json 重写工具入口后才可激活。`;
  } else if (_str(pkg.main)) {
    route = { market: 'extension', compat: 'adapter-needed', adapter: 'vscode-host-api' };
    reason = `${displayName} 是 VS Code 宿主扩展（main=${_str(pkg.main)}）；命令与工具需按 khy.extension.json 重写后接入。`;
  } else {
    const dataOnly = Boolean(
      contributes && (contributes.themes || contributes.grammars || contributes.snippets || contributes.languages)
    );
    route = {
      market: 'none',
      compat: 'blocked',
      blocker: dataOnly ? 'not-an-artifact' : 'user-decision',
    };
    reason = dataOnly
      ? `${displayName} 只含主题 / 语法 / 片段等声明数据，没有可执行能力。`
      : `${displayName} 的清单未声明主入口、MCP 或工具，导入后没有可执行内容。`;
  }

  const licenseBlock = licenseBlocker(license);
  if (licenseBlock && licenseBlock.code === 'license-c') {
    route = { market: 'none', compat: 'blocked', blocker: 'license-c' };
    reason = `${reason} 上游许可证 ${license} 属 C 档，禁止进入入仓目录。`;
  }

  const canonical = {
    protocol: PROTOCOL_ID,
    id: `${eco}:${id}`,
    name: id,
    displayName,
    description: _str(source.description),
    version: _str(source.version),
    author: {
      name: _str(publishedBy.fullName) || _str(publishedBy.loginName) || namespace,
      id: namespace,
      avatarUrl: _str(files.icon) || _str(publishedBy.avatarUrl),
    },
    tags: [...categories, ...tags],
    source: {
      eco,
      url:
        namespace && name && baseUrl
          ? `${baseUrl}/extension/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`
          : baseUrl,
      assetId: id,
      kind: 'vsix',
      license,
      category: categories.join(','),
      downloads: source.downloadCount === undefined ? '' : String(source.downloadCount),
    },
    kind,
    capabilities: [],
    route: { ...route, adapter: route.adapter || null, reason },
    install: {
      upstream: namespace && name ? `code --install-extension ${id}` : undefined,
      khyos: undefined,
      note: 'VSIX 安装到 VS Code；KhyOS 只接其中声明的 MCP / 可重写命令面。',
    },
    permissions: {},
  };
  if (route.compat === 'blocked') {
    canonical.blocker = route.blocker === 'license-c' ? licenseBlock : blocker(route.blocker);
  } else if (licenseBlock) {
    canonical.blocker = licenseBlock;
  }
  return canonical;
}

function _shellJoin(tokens) {
  return tokens
    .map((token) => (/[\s"']/.test(token) ? `"${token.replace(/"/g, '\\"')}"` : token))
    .join(' ');
}

function _khyServerName(registryName) {
  const raw = _str(registryName) || 'mcp';
  let base = raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!base) base = 'mcp';
  if (base.length > 64) {
    // Keep the tail readable, but never exceed khy's ^[A-Za-z0-9_-]{1,64}$ rule.
    const suffix = require('node:crypto').createHash('sha1').update(raw).digest('hex').slice(0, 6);
    base = `${base.slice(0, 57)}-${suffix}`;
  }
  return base;
}

function _argTokens(list) {
  const out = [];
  for (const arg of _list(list)) {
    if (!arg || typeof arg !== 'object') continue;
    const type = _str(arg.type) || 'positional';
    const value = _str(arg.value);
    const name = _str(arg.name);
    if (type === 'named' && name) {
      out.push(`--${name}`);
      if (value) out.push(value);
    } else if (value) {
      out.push(value);
    }
  }
  return out;
}

const _LOCAL_RUNTIMES = new Set([
  'npx', 'npm', 'pnpm', 'yarn', 'bunx', 'uvx', 'uv', 'node', 'python', 'python3', 'deno', 'docker', 'sh', 'bash', 'cmd',
]);

function _packageCommand(pkg) {
  const registryType = _str(pkg.registryType).toLowerCase();
  const identifier = _str(pkg.identifier);
  if (!identifier) return null;
  const hint = _str(pkg.runtimeHint).toLowerCase();
  const runtimeArgs = _argTokens(pkg.runtimeArguments);
  const pkgArgs = _argTokens(pkg.packageArguments);
  let command;
  let args;
  if (registryType === 'npm') {
    command = _LOCAL_RUNTIMES.has(hint) ? hint : 'npx';
    args = runtimeArgs.slice();
    if (command === 'npx' && !args.includes('-y')) args.push('-y');
    args.push(identifier, ...pkgArgs);
  } else if (registryType === 'pypi') {
    command = hint === 'uv' ? 'uv' : 'uvx';
    args = [...runtimeArgs, identifier, ...pkgArgs];
  } else if (registryType === 'oci') {
    command = 'docker';
    args = runtimeArgs.some((token) => token === 'run')
      ? [...runtimeArgs]
      : [...runtimeArgs, 'run', '-i', '--rm'];
    args.push(identifier, ...pkgArgs);
  } else {
    return null;
  }
  return { command, args };
}

/**
 * Translate one official MCP Registry `servers[]` row into the unified
 * descriptor. The registry publishes how to launch the server (npm/pypi/oci
 * package or a streamable-http/sse endpoint), so unlike a plugin catalog these
 * entries can be written into mcp.json without a human rewriting a command.
 */
function fromMcpRegistryServer(row, options) {
  const source = row && typeof row === 'object' ? row : {};
  const server = source.server && typeof source.server === 'object' ? source.server : source;
  const meta = source._meta && typeof source._meta === 'object' ? source._meta : {};
  const official =
    (meta['io.modelcontextprotocol.registry/official'] && typeof meta['io.modelcontextprotocol.registry/official'] === 'object'
      ? meta['io.modelcontextprotocol.registry/official']
      : null) ||
    (meta.official && typeof meta.official === 'object' ? meta.official : {});
  const opts = options || {};
  const eco = _str(opts.eco) || 'mcp-registry';
  const baseUrl = _str(opts.baseUrl).replace(/\/+$/, '');
  const registryName = _str(server.name) || 'mcp';
  const name = _khyServerName(registryName);
  const displayName = _str(server.title) || registryName.split('/').pop() || registryName;
  const repositoryUrl = _str(server.repository && server.repository.url);
  const websiteUrl = _str(server.websiteUrl);
  const requires = { env: [], headers: [] };
  const providedEnv = opts.env && typeof opts.env === 'object' ? opts.env : {};

  let config = null;
  let transportNote = '';
  const packages = _list(server.packages);
  for (const pkg of packages) {
    const built = _packageCommand(pkg && typeof pkg === 'object' ? pkg : {});
    if (!built) continue;
    config = { type: 'stdio', command: built.command };
    if (built.args.length) config.args = built.args;
    for (const entry of _list(pkg.environmentVariables)) {
      const envName = _str(entry && entry.name);
      if (!envName) continue;
      if (providedEnv[envName] !== undefined) {
        config.env = { ...(config.env || {}), [envName]: String(providedEnv[envName]) };
      } else {
        requires.env.push({
          name: envName,
          description: _str(entry && entry.description),
          required: entry && entry.isRequired !== false,
          secret: Boolean(entry && entry.isSecret),
        });
      }
    }
    transportNote = `stdio（${_str(pkg.registryType)} 包 ${_str(pkg.identifier)}）`;
    break;
  }

  if (!config) {
    for (const remote of _list(server.remotes)) {
      const type = _str(remote && remote.type).toLowerCase();
      const transport = type === 'streamable-http' || type === 'http' ? 'http' : type === 'sse' ? 'sse' : '';
      const url = _str(remote && remote.url);
      if (!transport || !/^https?:\/\//i.test(url)) continue;
      config = { type: transport, url };
      const headers = {};
      for (const header of _list(remote.headers)) {
        const headerName = _str(header && header.name);
        if (!headerName) continue;
        const value = _str(header && header.value);
        if (value && !/\{[^}]+\}/.test(value)) headers[headerName] = value;
        else {
          requires.headers.push({
            name: headerName,
            description: _str(header && header.description),
            required: header && header.isRequired !== false,
            secret: Boolean(header && header.isSecret),
          });
        }
      }
      if (Object.keys(headers).length) config.headers = headers;
      transportNote = `${transport} 端点`;
      break;
    }
  }

  const status = _str(official.status);
  const blockedByStatus = status && status !== 'active';
  const installable = Boolean(config) && !blockedByStatus;
  const khyCommand = config
    ? config.type === 'stdio'
      ? `khy mcp add ${name} -- ${_shellJoin([config.command, ...(config.args || [])])}`
      : `khy mcp add ${name} --transport ${config.type} --url ${config.url}`
    : undefined;
  const requiredKeys = [...requires.env, ...requires.headers].filter((item) => item.required).map((item) => item.name);
  const reason = blockedByStatus
    ? `${displayName} 在官方 MCP Registry 的状态是 ${status}，不提供安装。`
    : !config
      ? `${displayName} 的登记信息里没有 KhyOS 能直接启动的包或端点（可能只登记了不受支持的 registryType）。`
      : `官方 MCP Registry 提供了 ${transportNote}；写入用户级 mcp.json 后按原样启动。${
          requiredKeys.length ? `安装前还需填写：${requiredKeys.join('、')}。` : ''
        }`;

  const canonical = {
    protocol: PROTOCOL_ID,
    id: `${eco}:${registryName}`,
    name,
    displayName,
    description: _str(server.description),
    version: _str(server.version),
    author: {
      name: registryName.split('/')[0] || '',
      id: registryName,
      avatarUrl: '',
    },
    tags: [],
    source: {
      eco,
      url: repositoryUrl || websiteUrl,
      assetId: registryName,
      kind: 'mcp-registry',
      license: 'unknown',
      category: _str(server.repository && server.repository.subfolder),
      downloads: '',
      registryUrl: baseUrl ? `${baseUrl}/v0/servers` : '',
      publishedAt: _str(official.publishedAt),
      updatedAt: _str(official.updatedAt),
    },
    kind: 'mcp',
    capabilities: [
      ...packages.map((pkg) => ({
        type: 'package',
        name: _str(pkg && pkg.identifier),
        registryType: _str(pkg && pkg.registryType),
      })),
      ..._list(server.remotes).map((remote) => ({ type: 'remote', name: _str(remote && remote.type) })),
    ],
    route: {
      market: installable ? 'mcp' : 'none',
      compat: installable ? 'direct' : 'blocked',
      adapter: installable ? 'mcp-config' : null,
      reason,
    },
    install: {
      upstream: undefined,
      khyos: installable ? khyCommand : undefined,
      note: installable
        ? '写入用户级 mcp.json；安装后出现在「MCP 服务器」页，下次会话自动连接。'
        : '没有可直接执行的启动规格。',
      spec: installable ? { mode: 'mcp', name, scope: 'user', config } : undefined,
      requires,
    },
    permissions: {},
  };
  if (!installable) {
    canonical.blocker = blockedByStatus ? blocker('user-decision', reason) : blocker('unsupported-surface', reason);
  }
  return canonical;
}

function _cleanRel(value) {
  return _str(value).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function _kimiLicense(pkg) {
  const value = _str(pkg && pkg.license);
  return value || 'unknown';
}

/**
 * Translate one Kimi Code plugin (marketplace entry + its kimi.plugin.json)
 * into the unified descriptor. Kimi plugins carry skills, agents, commands and
 * hooks; only the skill roots are portable as-is.
 */
function fromKimiPlugin(plugin, manifest, options) {
  const entry = plugin && typeof plugin === 'object' ? plugin : {};
  const pkg = manifest && typeof manifest === 'object' ? manifest : null;
  const opts = options || {};
  const eco = _str(opts.eco) || 'kimi-code';
  const marketplaceUrl = _str(opts.marketplaceUrl);
  const repoUrl = _str(opts.repoUrl);
  const subdir = _cleanRel(opts.subdir);
  const id = _str(entry.id) || _str(pkg && pkg.name) || 'kimi-plugin';
  const iface = pkg && pkg.interface && typeof pkg.interface === 'object' ? pkg.interface : {};
  const displayName = _str(entry.displayName) || _str(iface.displayName) || _str(pkg && pkg.name) || id;
  const description = _str(iface.shortDescription) || _str(pkg && pkg.description);
  const skills = (Array.isArray(pkg && pkg.skills) ? pkg.skills : pkg && pkg.skills ? [pkg.skills] : [])
    .map(_cleanRel)
    .filter(Boolean);
  const license = _kimiLicense(pkg);
  const sourceUrl = _str(entry.source);

  let kind = 'plugin';
  let route;
  let reason;
  let khyCommand;
  let installSpec;
  if (!pkg) {
    route = { market: 'none', compat: 'blocked', blocker: 'user-decision' };
    reason = `${displayName} 的 kimi.plugin.json 未能读取，无法判定它能落到哪个安装面；按待裁决阻塞登记。`;
  } else if (skills.length > 0) {
    kind = 'skill';
    route = { market: 'skill', compat: 'adapter-needed', adapter: 'kimi-skill-extract' };
    const first = skills[0];
    khyCommand = repoUrl ? `khy skill add ${repoUrl} --skill ${first}` : undefined;
    installSpec = repoUrl ? { mode: 'skill', source: repoUrl, skills: skills.slice() } : undefined;
    reason = `${displayName} 的 kimi.plugin.json 声明了 ${skills.length} 个技能目录；按目录逐个抽取 SKILL.md 后接入（命令示例为 ${first}）。`;
  } else if (pkg.mcpServers && typeof pkg.mcpServers === 'object') {
    kind = 'mcp';
    route = { market: 'mcp', compat: 'adapter-needed', adapter: 'mcp-config' };
    reason = `${displayName} 声明了 MCP 服务器；需展开成 khy mcp add 的服务器定义后接入。`;
  } else if (Array.isArray(pkg.agents) && pkg.agents.length > 0) {
    kind = 'agent';
    route = { market: 'none', compat: 'blocked', blocker: 'unsupported-surface' };
    reason = `${displayName} 只提供 Kimi 子代理；KhyOS 没有对等的 Agent 市场，需改写为 SKILL.md 后按技能导入。`;
  } else {
    route = { market: 'none', compat: 'blocked', blocker: 'unsupported-surface' };
    reason = `${displayName} 只声明命令 / hooks / 系统提示注入，KhyOS 没有对应的 Kimi 宿主面。`;
  }

  const licenseBlock = licenseBlocker(license);
  if (licenseBlock && licenseBlock.code === 'license-c') {
    route = { market: 'none', compat: 'blocked', blocker: 'license-c' };
    khyCommand = undefined;
    installSpec = undefined;
    reason = `${reason} 上游许可证 ${license} 属 C 档，禁止进入入仓目录。`;
  }

  const canonical = {
    protocol: PROTOCOL_ID,
    id: `${eco}:${id}`,
    name: id,
    displayName,
    description,
    version: _str(pkg && pkg.version),
    author: {
      name: _str(pkg && pkg.author && pkg.author.name) || '',
      id: '',
      avatarUrl: '',
    },
    tags: _list(pkg && pkg.keywords).map((item) => _str(item)).filter(Boolean),
    source: {
      eco,
      url: sourceUrl || marketplaceUrl,
      assetId: id,
      kind: 'kimi-plugin',
      license,
      category: subdir,
      downloads: '',
    },
    kind,
    capabilities: skills.map((dir) => ({ type: 'skill', name: dir })),
    route: { ...route, adapter: route.adapter || null, reason },
    install: {
      upstream: sourceUrl ? `kimi plugin install ${sourceUrl}` : undefined,
      khyos: khyCommand,
      note: repoUrl ? `插件仓库 ${repoUrl}${subdir ? `（子目录 ${subdir}）` : ''}` : '来源未解析为仓库 URL。',
      spec: installSpec,
    },
    permissions: {},
  };
  if (route.compat === 'blocked') {
    canonical.blocker = route.blocker === 'license-c' ? licenseBlock : blocker(route.blocker);
  } else if (licenseBlock) {
    canonical.blocker = licenseBlock;
  }
  return canonical;
}

function toCatalogEntry(canonical) {
  const route = canonical.route || {};
  const install = canonical.install || {};
  const category = categoryOf({
    name: canonical.displayName || canonical.name,
    what: canonical.description,
    upstreamUrl: canonical.source && canonical.source.url,
    category: canonical.source && canonical.source.category,
  });
  return {
    marketId: canonical.id || '',
    name: canonical.displayName || canonical.name,
    upstreamUrl: canonical.source && canonical.source.url,
    type: canonical.kind,
    category: category.key,
    categoryLabel: category.label,
    categorySource: category.source,
    khyosMarket: route.market,
    targetPath: install.note,
    compat: route.compat,
    compatNote: route.reason,
    license: (canonical.source && canonical.source.license) || 'unknown',
    relationship: 'upstream',
    agentScope: [canonical.source && canonical.source.eco].filter(Boolean),
    what: canonical.description,
    command: install.upstream,
    khyCommand: install.khyos,
    installSpec: install.spec || null,
    installRequires: install.requires || null,
    author: canonical.author && canonical.author.name,
    avatarUrl: canonical.author && canonical.author.avatarUrl,
    version: canonical.version,
    downloads: canonical.source && canonical.source.downloads,
    assetId: canonical.source && canonical.source.assetId,
    publishedAt: (canonical.source && canonical.source.publishedAt) || '',
    updatedAt: (canonical.source && canonical.source.updatedAt) || '',
    protocol: {
      id: PROTOCOL_ID,
      kind: canonical.kind,
      market: route.market,
      compat: route.compat,
      adapter: route.adapter || null,
      blocker: canonical.blocker || null,
    },
  };
}

/**
 * Attach protocol facts to an existing catalog entry without rewriting it:
 * the survey's own prose stays the display text, the protocol only adds the
 * machine-readable route/blocker next to it.
 */
function annotateEntry(entry, eco) {
  if (!entry || typeof entry !== 'object') return entry;
  try {
    const canonical = fromCatalogEntry(entry, eco);
    const category = entry.category && CATEGORY_LABELS[entry.category]
      ? {
          key: entry.category,
          label: CATEGORY_LABELS[entry.category],
          source: entry.categorySource || 'upstream',
        }
      : categoryOf(entry);
    return {
      ...entry,
      marketId: entry.marketId || canonical.id || '',
      category: category.key,
      categoryLabel: category.label,
      categorySource: category.source,
      installSpec: entry.installSpec || canonical.install.spec || null,
      installRequires: entry.installRequires || canonical.install.requires || null,
      protocol: {
        id: PROTOCOL_ID,
        kind: canonical.kind,
        market: canonical.route.market,
        compat: canonical.route.compat,
        adapter: canonical.route.adapter,
        blocker: canonical.blocker || null,
      },
    };
  } catch {
    return entry;
  }
}

function annotateEcosystems(ecosystems) {
  return _list(ecosystems).map((market) => {
    if (!market || typeof market !== 'object') return market;
    const eco = _str(market.eco);
    return {
      ...market,
      entries: _list(market.entries).map((entry) => annotateEntry(entry, eco)),
    };
  });
}

function tally(entries) {
  const result = { direct: 0, adapt: 0, covered: 0, blocked: 0 };
  for (const entry of _list(entries)) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.compat === 'direct') result.direct += 1;
    else if (entry.compat === 'adapter-needed') result.adapt += 1;
    else if (entry.compat === 'covered') result.covered += 1;
    else if (entry.compat === 'blocked') result.blocked += 1;
  }
  return result;
}

function _names(value) {
  return _list(value)
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') return _str(item.name) || _str(item.id);
      return '';
    })
    .filter(Boolean);
}

/**
 * Translate an `openclaw.plugin.json` + its package.json into the unified
 * descriptor and, when routable, a draft `khy.extension.json`. The draft never
 * invents tool schemas: OpenClaw contracts.tools are names, so KhyOS still
 * needs the runtime adapter before activation.
 */
function fromOpenClawManifest(input) {
  const manifest = input && input.manifest && typeof input.manifest === 'object' ? input.manifest : {};
  const pkg = input && input.packageJson && typeof input.packageJson === 'object' ? input.packageJson : {};
  const source = (input && input.source) || {};
  const eco = _str(source.eco) || 'openclaw';
  const id = _str(manifest.id) || _str(pkg.name) || 'openclaw-plugin';
  const tools = _names(manifest.contracts && manifest.contracts.tools);
  const skills = _names(manifest.skills);
  const skillDir = _str(manifest.agentSkillsDir);
  const mcpServers =
    manifest.mcpServers && typeof manifest.mcpServers === 'object' && !Array.isArray(manifest.mcpServers)
      ? Object.keys(manifest.mcpServers)
      : [];
  const providers = _names(manifest.providers);
  const channels = _names(manifest.channels);
  const cliBackends = _names(manifest.cliBackends);

  const capabilities = [
    ...tools.map((name) => ({ type: 'tool', name })),
    ...(skills.length ? skills : skillDir ? [skillDir] : []).map((name) => ({ type: 'skill', name })),
    ...mcpServers.map((name) => ({ type: 'mcp', name })),
    ...providers.map((name) => ({ type: 'provider', name })),
    ...channels.map((name) => ({ type: 'channel', name })),
    ...cliBackends.map((name) => ({ type: 'cli-backend', name })),
  ];

  let route;
  if (tools.length || mcpServers.length) {
    route = {
      market: tools.length ? 'extension' : 'mcp',
      compat: 'adapter-needed',
      adapter: tools.length ? 'openclaw-manifest' : 'mcp-config',
      reason: tools.length
        ? 'OpenClaw 只声明工具名（contracts.tools），无 KhyOS 需要的 inputSchema/风险位；翻译后仍需运行时实现。'
        : 'mcpServers 需展开为 khy mcp add 的服务器定义。',
    };
  } else if (skills.length || skillDir) {
    route = {
      market: 'skill',
      compat: 'adapter-needed',
      adapter: 'skill-extract',
      reason: '插件内技能根已知，但仍需从插件包中抽出 SKILL.md 目录后才可 khy skill import。',
    };
  } else if (providers.length || channels.length || cliBackends.length) {
    route = {
      market: 'none',
      compat: 'blocked',
      adapter: null,
      reason: '插件只提供模型供应商/通信通道/CLI 后端，KhyOS 无对应拓展面。',
    };
  } else {
    route = {
      market: 'none',
      compat: 'blocked',
      adapter: null,
      reason: 'manifest 未声明工具、技能或 MCP，导入后没有可执行内容。',
    };
  }

  const canonical = {
    protocol: PROTOCOL_ID,
    id: `${eco}:${id}`,
    name: id,
    displayName: _str(manifest.name) || _str(pkg.name) || id,
    description: _str(manifest.description) || _str(pkg.description),
    version: _str(manifest.version) || _str(pkg.version),
    author: null,
    tags: [],
    source: {
      eco,
      url: _str(source.url) || _str(pkg.repository && pkg.repository.url),
      assetId: '',
      kind: 'openclaw-manifest',
      license: _str(pkg.license) || 'unknown',
    },
    kind: 'plugin',
    capabilities,
    route,
    install: {
      upstream: undefined,
      khyos: route.market === 'skill' ? 'khy skill import <抽出的技能目录>' : undefined,
      note: _str(input && input.note),
    },
    permissions: {},
    khyManifest: route.market === 'extension' ? toKhyManifest(manifest, pkg, capabilities) : null,
  };

  if (route.compat === 'blocked') {
    canonical.blocker =
      providers.length || channels.length || cliBackends.length
        ? blocker('unsupported-surface')
        : blocker('no-importable-capability');
  } else {
    canonical.blocker = licenseBlocker(canonical.source.license);
  }
  return canonical;
}

function toKhyManifest(manifest, pkg, capabilities) {
  const id = _str(manifest.id) || _str(pkg.name) || 'openclaw-plugin';
  const skills = _names(manifest.skills);
  const skillDir = _str(manifest.agentSkillsDir);
  const mcp =
    manifest.mcpServers && typeof manifest.mcpServers === 'object' && !Array.isArray(manifest.mcpServers)
      ? manifest.mcpServers
      : null;
  return {
    id,
    name: _str(manifest.name) || _str(pkg.name) || id,
    displayName: _str(manifest.name) || _str(pkg.name) || id,
    version: _str(manifest.version) || _str(pkg.version) || '0.0.0',
    description: _str(manifest.description) || _str(pkg.description),
    kind: 'runtime',
    // OpenClaw keeps the entry in package.json; the manifest never names it.
    main: _str(manifest.main) || _str(manifest.entry) || _str(pkg.main) || 'index.js',
    skills: skills.length ? skills : skillDir ? [skillDir] : [],
    mcp,
    // Tool schemas are not in the manifest, so an empty list is the honest
    // draft; filling it with name-only stubs would let the gate activate tools
    // that cannot validate input.
    tools: [],
    provides: [],
    capabilities,
  };
}

module.exports = {
  PROTOCOL_ID,
  KINDS,
  MARKETS,
  COMPAT_VALUES,
  BLOCKERS,
  CATEGORY_LABELS,
  OPENCLAW_ASSET_TYPES,
  normalizeKind,
  normalizeCompat,
  categoryOf,
  blocker,
  licenseBlocker,
  isALicense,
  fromCatalogEntry,
  parseKhyCommand,
  fromOpenClawAsset,
  openClawSkillSource,
  fromVsCodeExtension,
  fromMcpRegistryServer,
  fromKimiPlugin,
  fromOpenClawManifest,
  toKhyManifest,
  toCatalogEntry,
  annotateEntry,
  annotateEcosystems,
  tally,
};

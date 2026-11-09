'use strict';

/**
 * ssotDataGuard — 数据事实「单一真源」判定的纯核心（零 IO、确定性、可单测）。
 *
 * ## 这条守卫治什么病
 *
 * 仓库里同一份数据被写在两个地方时，两处一开始相同；改了一处，另一处就成了
 * **矛盾**。这类漂移的特点是：没有任何一个文件是错的，只有**两个文件对同一件事
 * 说法不同**。所以守卫不能问「这个文件对不对」，只能问「这件事有几处声明」。
 *
 * 判据分三层，每层都只认「同一个标识符 + 同一个值」：
 *
 *   D1 影子副本（ssot-shadow-copy，warning）
 *      真源之外的文件里又写了一遍真源的值。值相同 → 此刻还没矛盾，但已经是两份
 *      真相，改一处必漂移。→ 归并回真源，或登记为「授权镜像」。
 *
 *   D2 值矛盾（ssot-value-contradiction，error）
 *      同一个标识符处出现了与真源不同的值。→ 已经不是漂移，是矛盾，必须当场归并。
 *
 *   D3 镜像失步（ssot-mirror-drift，error）
 *      已登记的**授权镜像**与真源值不再一致。镜像存在的理由是「物理上无法 import」
 *      （独立包、跨语言），不是「懒得 import」；既然必须存在，就得锁步。
 *
 * 外加两条完整性判据：
 *
 *   D4 整文件影子副本（ssot-source-shadow-copy，error）
 *      某份登记在册的真源文件，在仓内被**逐字节复制**到了第二个地方。
 *      字段级扫描看不见它（复制的文件路径不同、字段名也不同），只有内容指纹能看见。
 *
 *   D5 登记表完整性（ssot-source-missing / ssot-pointer-unresolved / ssot-mirror-missing，error）
 *      真源文件不存在、指针解析不出来、登记的镜像不存在 —— 判据本身失效时报错。
 *      **判据失效必须是红灯**：一个查不到真源的守卫，报「通过」等于假绿。
 *
 * ## 为什么不写死一份「真值表」
 *
 * 登记表 `docs/10_规范/registry/DATA-SSOT.json` 只登记**真源在哪、怎么取、谁是镜像**，
 * **不登记值本身**。值一律在运行时从真源文件里读 —— 登记表若也存一份值，它自己就
 * 成了第二真源，本守卫立刻失去意义（这正是它要治的病）。
 *
 * 纯核心不做 IO：文件枚举与读盘在 scripts/ci/check-ssot-data.js，本文件只做判定。
 */

const RULE_ID = 'LAYOUT-008';

/**
 * 事实的取值方式（登记表 ssot.kind / mirrors[].kind）。
 *
 * json-count 取的是「指针所指数组的长度」，配 declaredPointer 可判**真源自洽**：
 * 真源自己声明的计数与它实际拥有的条目数不一致 —— 这是一处连自家人都不认的矛盾。
 */
const VALUE_KINDS = new Set(['js-const', 'py-const', 'text-const', 'json-pointer', 'toml-key', 'json-count']);

/**
 * 值锚定补网的**区分度下限**：小于此值的数字不做值锚定。
 *
 * 实测：值 10（端口漂移窗口）走值锚定会捞出 242 条噪声（小整数在代码里
 * 太常见），值 9090 只有 4 条且其中 3 条是真影子。故门槛取 100 ——
 * 「端口级数字」才值得用值来找它的副本。
 */
const VALUE_ANCHOR_MIN = 100;

/**
 * 值锚定补网只扫**代码文件**：JSON 清单 / 文档里的数字多半是叙述，不是声明。
 */
const VALUE_ANCHOR_CODE_EXT = /\.(js|mjs|cjs|ts|tsx|vue|py|dart)$/;

/**
 * 该位置是否落在引号字符串里（按行内引号奇偶判定，转义引号不计）。
 *
 * 用来区分「代码里的裸字面量」与「字符串里的示例 / 记录」：
 * `const X = 9090` 是第二份声明；`'… [--port 9090] …'` 是帮助文本；
 * `'两条启动路径都绑定 9090 端口'` 是案例库里的历史记录 —— 三者长得一样，
 * 只有「在不在引号里」能分开。
 */
function insideStringLiteral(line, index) {
  let quote = null;
  for (let i = 0; i < index; i += 1) {
    const ch = line[i];
    if (ch === '\\') { i += 1; continue; }
    if (!quote) {
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    } else if (ch === quote) {
      quote = null;
    }
  }
  return quote !== null;
}

/** 行内「不在字符串里」的值出现位置。 */
function findBareValueOccurrences(line, numeric) {
  const re = new RegExp(`(^|[^0-9.])${numeric}([^0-9.]|$)`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(line)) !== null) {
    const idx = m.index + m[1].length;
    if (!insideStringLiteral(line, idx)) out.push(idx);
  }
  return out;
}

// ── 基础工具 ────────────────────────────────────────────────────────────────

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** FNV-1a 32 位哈希：确定性、零依赖，够做内容指纹（不是安全哈希，不用于防篡改）。 */
function fingerprint(text) {
  let hash = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** JSON 稳定序列化（键排序），让「内容相同但键序不同」的文件指纹一致。 */
function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

/** 解析为稳定串；不是合法 JSON 则返回 null（调用方按「非 JSON」处理）。 */
function canonicalJson(text) {
  try {
    return stableStringify(JSON.parse(String(text)));
  } catch {
    return null;
  }
}

/** 值归一：比较用。数字与字符串统一成去空白后的字符串。 */
function normalizeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return String(value);
  return String(value).trim();
}

/** JSON Pointer（RFC 6901）取值：'/meta/ruleCount'。 */
function resolveJsonPointer(root, pointer) {
  if (!pointer) return undefined;
  const parts = String(pointer).split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = root;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = Array.isArray(cur) ? cur[Number(part)] : cur[part];
  }
  return cur;
}

/**
 * 从表达式里取「默认��」字面量。
 *
 * 取值顺序不能想当然：`parseInt(process.env.X || '9090', 10)` 里有两个字面量，
 * '9090' 是端口、10 是 parseInt 的进制 —— 认错一个，这个事实的"真值"就是错的。
 * 规则：表达式里有 `||` 就取 `||` 之后的第一个字面量（那才是兜底默认值），
 * 没有 `||` 才取表达式里的第一个字面量。
 */
function extractDefaultLiteral(expr) {
  const s = String(expr || '');
  const bar = s.lastIndexOf('||');
  const tail = (bar >= 0 ? s.slice(bar + 2) : s).trim();

  const str = tail.match(/^['"]([^'"]*)['"]/);
  if (str) return { value: str[1], quoted: true };

  const num = tail.match(/^-?\d+(?:\.\d+)?/);
  if (num) return { value: Number(num[0]), quoted: false };

  // 表达式不是「字面量开头」时（如 String(25 * 1024 * 1024)），退回全串找第一个字面量。
  const anyStr = tail.match(/['"]([^'"]*)['"]/);
  if (anyStr) return { value: anyStr[1], quoted: true };
  const anyNum = tail.match(/\d+(?:\.\d+)?/);
  if (anyNum) return { value: Number(anyNum[0]), quoted: false };
  return null;
}

/** JS/TS：`const NAME = <expr>`（可带 export）。 */
function resolveJsConst(text, name) {
  const re = new RegExp(
    `(?:^|[\\s;{(])(?:export\\s+)?(?:const|let|var)\\s+${escapeRe(name)}\\s*=\\s*([^;\\n]+)`,
    'gm',
  );
  let match;
  let last = null;
  while ((match = re.exec(String(text))) !== null) {
    const literal = extractDefaultLiteral(match[1]);
    if (literal) {
      const line = String(text).slice(0, match.index).split('\n').length;
      last = { value: literal.value, line };
    }
  }
  return last;
}

/**
 * Python：`NAME = <expr>`。
 *
 * 与 JS 的差别在取值顺序：Python 侧常见 `os.environ.get('X', '8765')`，
 * 第一个字面量是**环境变量名**、第二个才是默认值 —— 故取最后一个字面量。
 */
function resolvePyConst(text, name) {
  const re = new RegExp(`^\\s*${escapeRe(name)}\\s*=\\s*(.+)$`, 'gm');
  let match;
  let last = null;
  while ((match = re.exec(String(text))) !== null) {
    const expr = match[1];
    const literals = [...expr.matchAll(/['"]([^'"]*)['"]|\b(\d+(?:\.\d+)?)\b/g)];
    if (literals.length === 0) continue;
    const picked = literals[literals.length - 1];
    const value = picked[1] !== undefined ? picked[1] : Number(picked[2]);
    const line = String(text).slice(0, match.index).split('\n').length;
    last = { value, line };
  }
  return last;
}

/** TOML：`key = value`（顶层或任意 [table] 下）。 */
function resolveTomlKey(text, key) {
  const re = new RegExp(`^\\s*(?:\\[.*\\]\\s*)?${escapeRe(key)}\\s*=\\s*(.+)$`, 'gm');
  let match;
  let last = null;
  while ((match = re.exec(String(text))) !== null) {
    const raw = match[1].trim().replace(/^["']|["']$/g, '');
    const line = String(text).slice(0, match.index).split('\n').length;
    last = { value: /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : raw, line };
  }
  return last;
}

/**
 * 通用文本常量：`NAME = '值'`（覆盖 Dart / JS / Python / TS）。
 *
 * 跨包镜像常常是另一种语言写的（如手机端 Dart 的
 * `const String kDefaultOllamaBaseUrl = 'http://localhost:11434';`），
 * `js-const` 的解析器认不出「const String NAME =」这种形状。
 */
function resolveTextConst(text, name) {
  const re = new RegExp(
    `(?:^|[\\s;{(])(?:static\\s+)?(?:const\\s+)?(?:final\\s+)?(?:var\\s+)?(?:String\\s+|str\\s+|String\\?\\s+)?${escapeRe(name)}\\s*=\\s*['"]([^'"]+)['"]`,
    'gm',
  );
  let match;
  let last = null;
  while ((match = re.exec(String(text))) !== null) {
    const line = String(text).slice(0, match.index).split('\n').length;
    last = { value: match[1], line };
  }
  return last;
}

/**
 * 按 kind 取值。返回 { value, line } 或 null。
 */
function resolveValue(text, kind, pointer) {
  switch (kind) {
    case 'js-const':
      return resolveJsConst(text, pointer);
    case 'py-const':
      return resolvePyConst(text, pointer);
    case 'text-const':
      return resolveTextConst(text, pointer);
    case 'toml-key':
      return resolveTomlKey(text, pointer);
    case 'json-pointer': {
      let obj;
      try {
        obj = JSON.parse(String(text));
      } catch {
        return null;
      }
      const value = resolveJsonPointer(obj, pointer);
      return value === undefined ? null : { value, line: 1 };
    }
    case 'json-count': {
      let obj;
      try {
        obj = JSON.parse(String(text));
      } catch {
        return null;
      }
      const arr = resolveJsonPointer(obj, pointer);
      if (!Array.isArray(arr)) return null;
      return { value: arr.length, line: 1 };
    }
    default:
      return null;
  }
}

/**
 * 镜像值与真值的可比性判定。
 *
 * 镜像常是「另一种表述的同一件事」：真源是数字端口 `11434`，镜像是一整条 URL
 * `'http://localhost:11434'`。两者字面不同、事实相同 —— 故当真值是数字时，
 * 取镜像字符串里的数字成分与之比对（真值命中其中之一即视为锁步）。
 */
function mirrorMatches(canonical, mirrorValue) {
  if (normalizeValue(canonical) === normalizeValue(mirrorValue)) return true;
  const canonicalNum = Number(canonical);
  if (!Number.isFinite(canonicalNum)) return false;
  const components = String(mirrorValue).match(/\d+/g) || [];
  return components.some((c) => Number(c) === canonicalNum);
}

/** 行是否注释（整行注释）。行尾注释不整段跳过 —— 那会把真影子放过。 */
function isCommentLine(line) {
  return /^\s*(\/\/|\*|\/\*|#)/.test(line);
}

/** 该行是否提到事实的任一标识符（词边界，避免 AI_MGMT_PORT 误命中 AI_MGMT_PORT_RETRY）。 */
function buildIdentifierMatcher(identifiers) {
  const list = (Array.isArray(identifiers) ? identifiers : [])
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => x.trim());
  if (list.length === 0) return null;
  const re = new RegExp(`(?<![A-Za-z0-9_])(${list.map(escapeRe).join('|')})(?![A-Za-z0-9_])`);
  return { re, names: list };
}

/**
 * 行内是否出现该字面量。
 *
 * ⚠ 数字必须按**边界**匹配，不能用子串匹配：真源值常是**数字字符串**
 * （`process.env.PORT || '3000'` 取出来是 `'3000'`），若按子串判，
 * `'13000'` / `'30000'` 全会被算成命中 —— 实测这就是 bundleArtifacts.js 里
 * 三行误报的成因。故数字字符串一律归一成数字再按边界比。
 */
function containsLiteral(line, value) {
  const asNumber = typeof value === 'number' ? value : (/^-?\d+(?:\.\d+)?$/.test(String(value).trim())
    ? Number(String(value).trim())
    : null);
  if (asNumber !== null && Number.isFinite(asNumber)) {
    return new RegExp(`(^|[^0-9.])${escapeRe(String(asNumber))}([^0-9.]|$)`).test(line);
  }
  return String(line).includes(String(value));
}

/**
 * 从「标识符处」抽出兜底字面量（用于矛盾判定）。
 *
 * 只认**直接**形态，宁可漏判也不误判：
 *   ① IDENT || '9090' / IDENT ?? 9090   —— 直接兜底
 *   ② const IDENT = '9090'               —— 直接赋值
 *   ③ { IDENT: 9090 }                    —— 对象属性
 *
 * 为什么这么窄：`Math.max(1, Number(X) || 1)` 里的 `1` 是**下限地板**、不是 X 的默认值；
 * `parseInt(process.env.X, 10) || 9090` 里的 `10` 是进制。这类形态一律不算矛盾 ——
 * 守卫一旦把地板当矛盾，维护者就会开始整体忽略它的输出，那比漏判更坏。
 * 宽松形态（标识符附近出现字面量）仍由「影子副本」判据兜住：值相同即提示归并。
 */
function extractAnchoredValue(line, identifier) {
  const id = escapeRe(identifier);
  const patterns = [
    // ① 直接兜底：IDENT || '9090' / IDENT ?? 9090
    { re: new RegExp(`${id}\\s*(?:\\|\\||\\?\\?)\\s*\\(?\\s*(['"])([^'"]+)\\1`), quoted: true },
    { re: new RegExp(`${id}\\s*(?:\\|\\||\\?\\?)\\s*\\(?\\s*(\\d+(?:\\.\\d+)?)`), quoted: false },
    // ② 直接赋值：const IDENT = 9090
    { re: new RegExp(`(?:const|let|var)\\s+${id}\\s*=\\s*(\\d+(?:\\.\\d+)?)`), quoted: false },
    // ③ 对象属性：行首或 { , 之后的 IDENT: 8897
    //    ⚠ 必须容许「行首」：多行对象字面量里属性常常另起一行，
    //    只认 [{,] 会漏掉 `BRIDGE_PORT: 8896,` 这种真实副本。
    { re: new RegExp(`(?:^|[{,])\\s*${id}\\s*:\\s*(\\d+(?:\\.\\d+)?)`, 'm'), quoted: false },
  ];
  for (const { re, quoted } of patterns) {
    const m = re.exec(line);
    if (!m) continue;
    if (quoted) {
      // 模板插值（`${X}`）不是字面量值：它取的是运行时才知道的东西，
      // 拿来跟真源比只会造出假矛盾（实测 init.js 的 `"${OLLAMA_HOST}"`）。
      if (m[2].includes('${')) continue;
      return m[2];
    }
    return Number(m[1]);
  }
  return null;
}

// ── 登记表形态校验 ──────────────────────────────────────────────────────────

/** 登记表本身的结构问题（缺字段、kind 非法等）。返回 findings。 */
function validateRegistry(registry) {
  const findings = [];
  const add = (id, message, detail) => findings.push({
    id, severity: 'error', rule: RULE_ID, file: 'docs/10_规范/registry/DATA-SSOT.json',
    message, detail: detail || '',
  });

  if (!registry || typeof registry !== 'object') {
    add('ssot-registry-invalid', '登记表不是合法对象。');
    return findings;
  }
  const sources = Array.isArray(registry.sources) ? registry.sources : [];
  const facts = Array.isArray(registry.facts) ? registry.facts : [];
  if (sources.length === 0) add('ssot-registry-empty', '登记表 sources 为空：整文件级影子副本无从判定。');
  if (facts.length === 0) add('ssot-registry-empty', '登记表 facts 为空：字段级矛盾无从判定。');

  const seenSource = new Set();
  for (const source of sources) {
    if (!source || typeof source.path !== 'string' || !source.path.trim()) {
      add('ssot-registry-invalid', '存在缺少 path 的 source 条目。');
      continue;
    }
    if (seenSource.has(source.path)) {
      add('ssot-registry-invalid', `source 路径重复登记：${source.path}`);
    }
    seenSource.add(source.path);
  }

  const seenFact = new Set();
  for (const fact of facts) {
    if (!fact || typeof fact.id !== 'string' || !fact.id.trim()) {
      add('ssot-registry-invalid', '存在缺少 id 的 fact 条目。');
      continue;
    }
    if (seenFact.has(fact.id)) {
      add('ssot-registry-invalid', `fact id 重复登记：${fact.id}`);
    }
    seenFact.add(fact.id);
    if (!fact.ssot || typeof fact.ssot.path !== 'string' || !fact.ssot.path.trim()) {
      add('ssot-registry-invalid', `事实 ${fact.id} 缺少 ssot.path。`);
      continue;
    }
    if (!VALUE_KINDS.has(fact.ssot.kind)) {
      add('ssot-registry-invalid', `事实 ${fact.id} 的 ssot.kind 非法：${fact.ssot.kind}（合法值 ${[...VALUE_KINDS].join('/')}）。`);
    }
    if (!fact.ssot.pointer) {
      add('ssot-registry-invalid', `事实 ${fact.id} 缺少 ssot.pointer（真源里取哪个值）。`);
    }
    const detect = fact.detect || {};
    const ids = Array.isArray(detect.identifiers) ? detect.identifiers : [];
    // json-count 事实判的是「真源自洽」，不靠标识符扫描 —— 它没有影子副本这一层。
    if (ids.length === 0 && fact.ssot && fact.ssot.kind !== 'json-count') {
      add('ssot-registry-invalid', `事实 ${fact.id} 缺少 detect.identifiers（无标识符则无从发现影子副本）。`);
    }
    for (const mirror of Array.isArray(fact.mirrors) ? fact.mirrors : []) {
      if (!mirror || typeof mirror.path !== 'string' || !mirror.path.trim()) {
        add('ssot-registry-invalid', `事实 ${fact.id} 存在缺少 path 的 mirror 条目。`);
        continue;
      }
      if (!VALUE_KINDS.has(mirror.kind)) {
        add('ssot-registry-invalid', `事实 ${fact.id} 的镜像 ${mirror.path} 的 kind 非法：${mirror.kind}。`);
      }
      if (!mirror.pointer) {
        add('ssot-registry-invalid', `事实 ${fact.id} 的镜像 ${mirror.path} 缺少 pointer。`);
      }
      if (!mirror.reason || !String(mirror.reason).trim()) {
        add('ssot-registry-invalid', `事实 ${fact.id} 的镜像 ${mirror.path} 缺少 reason（无理由的镜像 = 事实上的第二真源）。`);
      }
    }
  }
  return findings;
}

// ── 主判定 ──────────────────────────────────────────────────────────────────

/**
 * 主入口。
 *
 * @param {object} registry 解析后的 DATA-SSOT.json
 * @param {Array<{relPath: string, text: string}>} files 字段级扫描语料（已由调用方筛好）
 * @param {Array<{relPath: string, text: string}>} [fingerprintFiles] 内容指纹语料
 *        （只含需要做「整文件副本」比对的同类文件；缺省时复用 files）
 * @returns {{findings: Array, stats: object}}
 */
function assess({ registry, files, fingerprintFiles }) {
  const findings = validateRegistry(registry);
  const stats = {
    filesScanned: 0,
    fingerprintFilesScanned: 0,
    facts: 0,
    mirrors: 0,
    shadowCopies: 0,
    unanchoredLiterals: 0,
    contradictions: 0,
    mirrorDrifts: 0,
    sourceShadowCopies: 0,
    selfContradictions: 0,
  };

  const corpus = Array.isArray(files) ? files : [];
  const fpCorpus = Array.isArray(fingerprintFiles) ? fingerprintFiles : corpus;
  const byPath = new Map();
  for (const f of [...corpus, ...fpCorpus]) byPath.set(f.relPath, f);
  stats.filesScanned = corpus.length;
  stats.fingerprintFilesScanned = fpCorpus.length;

  const sources = Array.isArray(registry && registry.sources) ? registry.sources : [];
  const facts = Array.isArray(registry && registry.facts) ? registry.facts : [];

  // ── D4：整文件影子副本（内容指纹） ────────────────────────────────────
  // 只在「同类文件」之间比对：JSON 真源只与 .json 比，代码真源只与代码比。
  const sourceFingerprints = new Map(); // fingerprint -> [sourcePath]
  for (const source of sources) {
    const entry = byPath.get(source.path);
    if (!entry) {
      findings.push({
        id: 'ssot-source-missing', severity: 'error', rule: RULE_ID, file: source.path,
        message: '登记的真源文件不存在。',
        detail: '判据失效必须报红：一个查不到真源的守卫报「通过」等于假绿。',
      });
      continue;
    }
    const canon = canonicalJson(entry.text);
    const key = `${source.kind || 'text'}:${canon !== null ? fingerprint(canon) : fingerprint(normalizeText(entry.text))}`;
    if (!sourceFingerprints.has(key)) sourceFingerprints.set(key, []);
    sourceFingerprints.get(key).push({ path: source.path, kind: source.kind || 'text' });
  }
  for (const entry of fpCorpus) {
    const extKind = kindOfPath(entry.relPath);
    if (!extKind) continue;
    const canon = canonicalJson(entry.text);
    const key = `${extKind}:${canon !== null ? fingerprint(canon) : fingerprint(normalizeText(entry.text))}`;
    const owners = sourceFingerprints.get(key);
    if (!owners) continue;
    for (const owner of owners) {
      if (owner.path === entry.relPath) continue;
      if (owner.kind !== extKind) continue;
      findings.push({
        id: 'ssot-source-shadow-copy', severity: 'error', rule: RULE_ID, file: entry.relPath,
        message: `与真源 ${owner.path} 内容逐字节相同 —— 同一份数据在仓内出现了第二份。`,
        detail: '归并方向：删除本副本，或把它改成从真源读取（不要手工同步两份）。',
      });
      stats.sourceShadowCopies += 1;
    }
  }

  // ── D1/D2/D3：字段级事实 ────────────────────────────────────────────────
  for (const fact of facts) {
    if (!fact || !fact.ssot || !fact.ssot.path) continue;
    stats.facts += 1;
    const ssotEntry = byPath.get(fact.ssot.path);
    if (!ssotEntry) {
      findings.push({
        id: 'ssot-source-missing', severity: 'error', rule: RULE_ID, file: fact.ssot.path,
        message: `事实 ${fact.id} 的真源文件不存在。`,
        detail: '判据失效必须报红。',
      });
      continue;
    }
    const resolved = resolveValue(ssotEntry.text, fact.ssot.kind, fact.ssot.pointer);
    if (!resolved) {
      findings.push({
        id: 'ssot-pointer-unresolved', severity: 'error', rule: RULE_ID, file: fact.ssot.path,
        message: `事实 ${fact.id} 的真源取值失败：${fact.ssot.kind} / ${fact.ssot.pointer}。`,
        detail: '指针解析不出来 = 判据失效 = 必须报红，不能静默跳过。',
      });
      continue;
    }
    const canonical = normalizeValue(resolved.value);

    // D5b 真源自洽：真源自己声明的计数与它实际拥有的条目数不一致。
    // 这类矛盾连「自家人」都不认 —— 声明与事实同处一文件，最容易蒙混过关。
    if (fact.ssot.kind === 'json-count' && fact.ssot.declaredPointer) {
      const declared = resolveValue(ssotEntry.text, 'json-pointer', fact.ssot.declaredPointer);
      if (!declared) {
        findings.push({
          id: 'ssot-pointer-unresolved', severity: 'error', rule: RULE_ID, file: fact.ssot.path,
          message: `事实 ${fact.id} 的声明指针取值失败：${fact.ssot.declaredPointer}。`,
          detail: '声明指针取不到 = 无法判自洽 = 必须报红。',
        });
      } else if (normalizeValue(declared.value) !== canonical) {
        findings.push({
          id: 'ssot-self-contradiction', severity: 'error', rule: RULE_ID, file: fact.ssot.path,
          message: `真源自相矛盾：${fact.ssot.declaredPointer} 声明 ${normalizeValue(declared.value)}，实际条目数 ${canonical}。`,
          detail: '声明与事实同处一个文件 —— 改声明或改事实，别让两者并存。',
        });
        stats.selfContradictions += 1;
      }
    }

    // D3：授权镜像必须锁步
    const mirrorPaths = new Set();
    for (const mirror of Array.isArray(fact.mirrors) ? fact.mirrors : []) {
      stats.mirrors += 1;
      mirrorPaths.add(mirror.path);
      const mirrorEntry = byPath.get(mirror.path);
      if (!mirrorEntry) {
        findings.push({
          id: 'ssot-mirror-missing', severity: 'error', rule: RULE_ID, file: mirror.path,
          message: `事实 ${fact.id} 登记的授权镜像不存在。`,
          detail: '镜像登记是死指针：要么补上文件，要么撤掉镜像登记。',
        });
        continue;
      }
      const mirrorValue = resolveValue(mirrorEntry.text, mirror.kind, mirror.pointer);
      if (!mirrorValue) {
        findings.push({
          id: 'ssot-pointer-unresolved', severity: 'error', rule: RULE_ID, file: mirror.path,
          message: `事实 ${fact.id} 的镜像取值失败：${mirror.kind} / ${mirror.pointer}。`,
          detail: '镜像声明与磁盘不一致，无法判定是否失步。',
        });
        continue;
      }
      const mirrorNorm = normalizeValue(mirrorValue.value);
      if (!mirrorMatches(canonical, mirrorValue.value)) {
        findings.push({
          id: 'ssot-mirror-drift', severity: 'error', rule: RULE_ID, file: mirror.path,
          message: `授权镜像与真源失步：${fact.id} 真源 ${fact.ssot.path} 为 ${canonical}，镜像为 ${mirrorNorm}。`,
          detail: mirror.reason ? `镜像理由：${mirror.reason}` : '',
        });
        stats.mirrorDrifts += 1;
      }
    }

    // D1/D2：真源与镜像之外，任何一处再声明同一事实即判
    const detect = fact.detect || {};
    const matcher = buildIdentifierMatcher(detect.identifiers);
    if (!matcher) continue;
    const exclude = Array.isArray(detect.exclude) ? detect.exclude : [];
    // 事实级作用域：同一标识符在不同目录可能指不同的事（如 BRIDGE_PORT 与手机桥接端口），
    // 作用域写窄一点，比靠全局排除兜底更不容易误判。
    const detectPaths = Array.isArray(detect.paths) && detect.paths.length ? detect.paths : null;
    const excludedPaths = new Set([fact.ssot.path, ...mirrorPaths]);

    for (const entry of corpus) {
      if (excludedPaths.has(entry.relPath)) continue;
      if (detectPaths && !pathAllowed(entry.relPath, detectPaths)) continue;
      if (isExcluded(entry.relPath, exclude)) continue;
      // 预筛：整文件都不含任何标识符时，连行都不用拆（拆行是最贵的一步）。
      if (!matcher.names.some((name) => entry.text.includes(name))) continue;
      const lines = entry.text.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (isCommentLine(line)) continue;
        if (!matcher.re.test(line)) continue;

        // D2：矛盾 —— 同一标识符处的兜底值与真源不同
        for (const identifier of matcher.names) {
          const anchored = extractAnchoredValue(line, identifier);
          if (anchored === null) continue;
          const anchoredNorm = normalizeValue(anchored);
          if (anchoredNorm === canonical) continue;
          findings.push({
            id: 'ssot-value-contradiction', severity: 'error', rule: RULE_ID,
            file: entry.relPath, line: i + 1, fact: fact.id,
            message: `同一事实出现两个值：${fact.id} 真源为 ${canonical}，此处为 ${anchoredNorm}。`,
            detail: `真源：${fact.ssot.path}（${fact.ssot.pointer}）。归并方向：改此处从真源取值。`,
          });
          stats.contradictions += 1;
          break;
        }

        // D1：影子副本 —— 同一行又写了一遍真源的值
        if (!containsLiteral(line, resolved.value)) continue;
        findings.push({
          id: 'ssot-shadow-copy', severity: 'warning', rule: RULE_ID,
          file: entry.relPath, line: i + 1, fact: fact.id,
          message: `真源之外重复声明了同一事实的值（${canonical}）。`,
          detail: `真源：${fact.ssot.path}（${fact.ssot.pointer}）。归并方向：从真源取值，或登记为授权镜像并写明理由。`,
        });
        stats.shadowCopies += 1;
      }
    }

    // ── D1b 值锚定补网：别名可绕过标识符锚点 ────────────────────────────
    // 标识符锚点有一个结构性盲区：**新别名**（同一个事实换个变量名再写一遍）
    // 不在任何登记标识符集合里，字段级扫描看不见它 —— 实测
    // `ai-manage-daemon.js` 的 `DEFAULT_API_PORT = 9090` 就是这样一个漏网之鱼。
    // 补网用「值」兜一层，但**只认代码里的裸字面量**：
    //   `const X = 9090`            → 第二份声明，要抓
    //   `'… [--port 9090] …'`       → 帮助文本里的示例，是叙述
    //   `'两条路径都绑定 9090 端口'` → 案例库里的历史记录，是知识
    // 三者长得一样，只有「在不在引号里」能分开 —— 实测该口径在当前仓内
    // **0 条误报**，而字符串通吃口径会在 bugCases.js 里捞出 3 条历史记录。
    //
    // ⚠ 噪声控制是这层的生死线：**只有区分度够的值才启用**（默认 ≥ 100）。
    // 实测值 10（端口漂移窗口）能捞出 242 条噪声 —— 小整数没有区分度，
    // 值锚定对它完全无效。故此项按事实显式开启（detect.valueAnchor）。
    if (!detect.valueAnchor) continue;
    const numeric = Number(resolved.value);
    if (!Number.isFinite(numeric) || numeric < VALUE_ANCHOR_MIN) continue;

    for (const entry of corpus) {
      if (excludedPaths.has(entry.relPath)) continue;
      if (detectPaths && !pathAllowed(entry.relPath, detectPaths)) continue;
      if (isExcluded(entry.relPath, exclude)) continue;
      // 只扫代码文件：JSON 清单与文档里的数字多半是叙述（实测 khy.module.json 的
      // knownBoundaries 里写着实测到的 IP:端口，那是知识不是声明）。
      if (!VALUE_ANCHOR_CODE_EXT.test(entry.relPath)) continue;
      if (!entry.text.includes(String(numeric))) continue;
      const lines = entry.text.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (isCommentLine(line)) continue;
        if (findBareValueOccurrences(line, numeric).length === 0) continue;
        // 提到任一登记标识符的，已由 D1/D2 判过，不重复报。
        if (matcher.names.some((name) => line.includes(name))) continue;
        findings.push({
          id: 'ssot-unanchored-literal', severity: 'warning', rule: RULE_ID,
          file: entry.relPath, line: i + 1, fact: fact.id,
          message: `事实的值（${canonical}）以裸字面量出现在作用域内，但此处没有登记的标识符 —— 疑似未登记的别名副本。`,
          detail: `真源：${fact.ssot.path}（${fact.ssot.pointer}）。归并方向：改成从真源取值，或把该别名登记进 detect.identifiers（若它确属同一事实）。`,
        });
        stats.unanchoredLiterals += 1;
      }
    }
  }

  return { findings, stats };
}

// ── 辅助 ────────────────────────────────────────────────────────────────────

/** 文本归一（比内容指纹用）：去 BOM、统一换行、去行尾空白。 */
function normalizeText(text) {
  return String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n')
    .map((line) => line.replace(/[ \t]+$/, '')).join('\n');
}

/** 文件类别：json / code / text / other。用于内容指纹的同类比对。 */
function kindOfPath(relPath) {
  const p = String(relPath);
  if (p.endsWith('.json')) return 'json';
  if (/\.(js|mjs|cjs|ts|tsx|vue|py|dart)$/.test(p)) return 'code';
  if (/\.(md|txt|ya?ml|toml)$/.test(p)) return 'text';
  return 'other';
}

/** 事实级作用域：路径列表（目录前缀或精确路径）。 */
function pathAllowed(relPath, paths) {
  const p = String(relPath).replace(/\\/g, '/');
  return paths.some((entry) => {
    const e = String(entry).replace(/\\/g, '/');
    if (e.endsWith('/')) return p.startsWith(e);
    return p === e;
  });
}

/**
 * 事实级排除（glob 前缀 + 简单通配）。
 *
 * 支持三种形态：
 *   `dir` + `/**`    仓库根下的 dir 目录及其子目录
 *   `**` + `/dir`    任意层级的 dir 目录及其子目录（按**路径段**匹配，不是前缀）
 *   `**` + `/glob`   末段通配（如 `**` + `/*.test.js`）
 *
 * ⚠ 曾经把「`**` 开头的目录前缀」当成普通前缀处理（拿整串做 startsWith）—— 那永远
 * 不成立，于是「排除测试目录」这条规则形同虚设，测试里的假端口被当成了真矛盾。
 * 前缀通配必须落到**路径段**上匹配。
 */
function isExcluded(relPath, patterns) {
  const p = String(relPath).replace(/\\/g, '/');
  for (const raw of patterns) {
    const glob = String(raw).replace(/\\/g, '/');
    if (glob.endsWith('/**')) {
      const dir = glob.slice(0, -3);
      if (dir.startsWith('**/')) {
        const name = dir.slice(3);
        if (name && p.split('/').includes(name)) return true;
      } else if (p.startsWith(dir + '/')) {
        return true;
      }
      continue;
    }
    if (glob.includes('*')) {
      const body = glob.replace(/^\*\*\//, '');
      const re = new RegExp('(^|/)' + body.split('*').map(escapeRe).join('.*') + '$');
      if (re.test(p)) return true;
      continue;
    }
    if (p === glob || p.startsWith(glob + '/')) return true;
  }
  return false;
}

/**
 * 作用域可达性检查（判据失效 → 报红）。
 *
 * 一条事实的 `detect.paths` 若指向**不存在的路径**，它就永远扫不到任何东西，
 * 于是这条事实**永远 0 finding** —— 看起来「全绿」，实则根本没在看。
 * 这是比「没登记事实」更隐蔽的假绿：事实在册、判据在跑、结果恒为零。
 *
 * 与 `check-rules-registry.js` 的 `findDanglingRegistryPaths(rules, existsFn)` 同款做法：
 * 纯函数 + 注入 exists 回调，IO 留给调用方。
 *
 * @param {object} registry
 * @param {(relPath: string) => boolean} existsFn
 * @returns {Array} findings
 */
function validateScopes(registry, existsFn) {
  const ex = existsFn || (() => true);
  const findings = [];
  for (const fact of (registry && registry.facts) || []) {
    if (!fact || !fact.id) continue;
    const detect = fact.detect || {};
    const paths = Array.isArray(detect.paths) ? detect.paths : [];
    // 无作用域 = 不限定范围（如 json-count 自洽判据只判真源自身），不是失效。
    if (paths.length === 0) continue;
    const missing = paths.filter((p) => {
      const rel = String(p).replace(/\/$/, '');
      if (!rel) return false;
      return !ex(rel);
    });
    if (missing.length > 0) {
      findings.push({
        id: 'ssot-scope-missing', severity: 'error', rule: RULE_ID,
        file: 'docs/10_规范/registry/DATA-SSOT.json',
        message: `事实 ${fact.id} 的 detect.paths 指向不存在的路径：${missing.join('、')}`,
        detail: '作用域不存在 = 这条事实永远扫不到任何东西 = 静默失效（看起来全绿，实则没在看）。',
        fact: fact.id,
      });
    }
  }
  return findings;
}

module.exports = {
  RULE_ID,
  VALUE_KINDS,
  assess,
  validateRegistry,
  validateScopes,
  resolveValue,
  resolveJsonPointer,
  resolveJsConst,
  resolvePyConst,
  resolveTextConst,
  resolveTomlKey,
  mirrorMatches,
  extractDefaultLiteral,
  extractAnchoredValue,
  containsLiteral,
  buildIdentifierMatcher,
  isCommentLine,
  isExcluded,
  pathAllowed,
  kindOfPath,
  canonicalJson,
  stableStringify,
  fingerprint,
  normalizeText,
  normalizeValue,
};

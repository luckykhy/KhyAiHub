/**
 * uidref · JavaScript 参考实现（Node.js，零依赖）
 *
 * 从 SPEC.md 独立实现，**不是** Python 版的逐行翻译。
 * 目的是检验规范是否写得足够明确、可跨语言移植。
 *
 * 独立实现过程中撞上的规范歧义，全部记在 AMBIGUITIES 里并回报给规范。
 */

'use strict';

const crypto = require('crypto');

/* ------------------------------------------------------------------ *
 * 1. XML 解析（uiautomator 子集）
 *
 * 规范 §1 只说输入是 uiautomator dump，**没有规定 XML 解析的边界行为**：
 * 实体转义、CDATA、命名空间、注释、属性缺省值。这里按最小可用子集实现，
 * 并把撞到的歧义记录下来。
 * ------------------------------------------------------------------ */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescape(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X'
        ? parseInt(e.slice(2), 16)
        : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
  });
}

/**
 * 把 uiautomator XML 解析成节点树。
 * 返回 { attrs, children }；解析不了就抛错（规范要求鲁棒，但没说不抛错）。
 */
function parseXml(xml) {
  let i = 0;
  const n = xml.length;

  function skipPrologAndComments() {
    for (;;) {
      while (i < n && /\s/.test(xml[i])) i++;
      if (xml.startsWith('<?', i)) { i = xml.indexOf('?>', i); i = i < 0 ? n : i + 2; continue; }
      if (xml.startsWith('<!--', i)) { i = xml.indexOf('-->', i); i = i < 0 ? n : i + 3; continue; }
      if (xml.startsWith('<!', i)) { i = xml.indexOf('>', i); i = i < 0 ? n : i + 1; continue; }
      return;
    }
  }

  function parseAttrs() {
    const attrs = {};
    for (;;) {
      while (i < n && /\s/.test(xml[i])) i++;
      if (i >= n) return attrs;
      const ch = xml[i];
      if (ch === '/' || ch === '>') return attrs;
      const start = i;
      while (i < n && !/[\s=/>]/.test(xml[i])) i++;
      const name = xml.slice(start, i);
      while (i < n && /\s/.test(xml[i])) i++;
      if (xml[i] !== '=') { attrs[name] = ''; continue; }  // 无值属性（HTML 风格）
      i++;
      while (i < n && /\s/.test(xml[i])) i++;
      const q = xml[i];
      if (q !== '"' && q !== "'") {  // 未加引号的值
        const vs = i;
        while (i < n && !/[\s>]/.test(xml[i])) i++;
        attrs[name] = unescape(xml.slice(vs, i));
        continue;
      }
      i++;
      const vs = i;
      while (i < n && xml[i] !== q) i++;
      attrs[name] = unescape(xml.slice(vs, i));
      i++;  // 跳过收尾引号
    }
  }

  function parseElement() {
    if (xml[i] !== '<') return null;
    i++;
    const ns = i;
    while (i < n && !/[\s/>]/.test(xml[i])) i++;
    const tag = xml.slice(ns, i);
    const attrs = parseAttrs();
    while (i < n && /\s/.test(xml[i])) i++;

    let selfClosing = false;
    if (xml[i] === '/') { selfClosing = true; i++; }
    if (xml[i] === '>') i++;

    const node = { tag, attrs, children: [] };
    if (selfClosing) return node;

    for (;;) {
      while (i < n && /\s/.test(xml[i])) i++;
      if (i >= n) break;
      if (xml.startsWith('</', i)) {
        i = xml.indexOf('>', i);
        i = i < 0 ? n : i + 1;
        break;
      }
      if (xml[i] === '<') {
        const child = parseElement();
        if (child) node.children.push(child);
        else break;
      } else {
        // 文本节点：本实现只用元素属性，文本一律丢弃
        const ts = i;
        while (i < n && xml[i] !== '<') i++;
        node.children.push({ tag: '#text', attrs: {}, children: [], text: xml.slice(ts, i) });
      }
    }
    return node;
  }

  skipPrologAndComments();
  const root = parseElement();
  if (!root) throw new Error('空 XML：找不到根元素');
  return root;
}

/** 深度优先前序收集所有 <node> 元素。规范未规定标签名，按 uiautomator 惯例取 node。 */
function collectNodes(root) {
  const out = [];
  (function walk(el) {
    if (el.tag === 'node') out.push(el);
    for (const c of el.children) walk(c);
  })(root);
  return out;
}

/* ------------------------------------------------------------------ *
 * 2. 常量表（SPEC §3.1 / §4）
 * ------------------------------------------------------------------ */

/** SPEC §3.1：结构性 id。规范写了「等结构性容器名」——**这是个开口，未穷举**。 */
const STRUCTURAL_IDS = new Set([
  'content', 'content_parent', 'decor_content_parent', 'container',
  'root', 'main', 'frame', 'wrapper', 'contentPanel', 'customPanel',
  'parentPanel', 'android:id/content', 'android:id/list', 'android:id/empty',
]);

/** SPEC §4：类名后缀 → 角色。顺序无关（后缀互斥），用 Map 保可读性。 */
const ROLE_BY_SUFFIX = new Map(Object.entries({
  EditText: 'input',
  CheckBox: 'switch', Switch: 'switch', ToggleButton: 'switch', CompoundButton: 'switch',
  RadioButton: 'radio',
  SeekBar: 'slider',
  RecyclerView: 'list', ListView: 'list', AbsListView: 'list',
  GridView: 'grid',
  ScrollView: 'scroll', HorizontalScrollView: 'scroll',
  ViewPager: 'pager',
  TabWidget: 'tabs', TabLayout: 'tabs',
  Button: 'btn', ImageButton: 'btn', FloatingActionButton: 'btn',
  WebView: 'webview',
  ImageView: 'img',
  TextView: 'text',
}));

/* ------------------------------------------------------------------ *
 * 3. 规则实现
 * ------------------------------------------------------------------ */

const INHERIT_CAP = 4;    // SPEC §3.3 建议 4 段
const LABEL_CAP = 60;     // SPEC §6 建议 60 字符

function attr(node, name) {
  const v = node.attrs[name];
  return v === undefined ? '' : v;
}

function flag(node, name) {
  return attr(node, name) === 'true';
}

/** SPEC §2.2：四种可交互条件 */
function isActionable(node) {
  if (flag(node, 'clickable')) return true;
  if (flag(node, 'long-clickable')) return true;
  if (flag(node, 'scrollable')) return true;
  return simpleClass(node).endsWith('EditText');
}

function simpleClass(node) {
  const c = attr(node, 'class');
  const idx = c.lastIndexOf('.');
  return idx < 0 ? c : c.slice(idx + 1);
}

/** SPEC §5：bounds 半开区间；畸形/零面积跳过；负坐标允许 */
function parseBounds(s) {
  const m = /^\[(-?\d+),\s*(-?\d+)\]\[(-?\d+),\s*(-?\d+)\]$/.exec(s.trim());
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  if (x2 < x1 || y2 < y1) return null;
  return { x1, y1, x2, y2 };
}

/**
 * SPEC §5：中心点 = ((x1+x2)//2, (y1+y2)//2)。
 *
 * ⚠️ 跨语言陷阱：Python 的 `//` 向负无穷取整，JS 的 `|0` 与 `>>1` 向零取整。
 * 负坐标（SPEC §5 明确允许）下两者会差 1。这里必须用 Math.floor 才等价。
 */
function centerOf(b) {
  return { x: Math.floor((b.x1 + b.x2) / 2), y: Math.floor((b.y1 + b.y2) / 2) };
}

/** SPEC §3.1：结构性 id 对模型无语义 */
function isStructuralId(rid) {
  if (!rid) return true;
  return STRUCTURAL_IDS.has(rid) || STRUCTURAL_IDS.has(rid.slice(rid.lastIndexOf('/') + 1));
}

/** SPEC §3.3：子孙文本拼接，去重保序，上限 4 段 */
function descendantText(node, cap = INHERIT_CAP) {
  const seen = [];
  (function walk(el) {
    if (seen.length >= cap) return;
    for (const c of el.children) {
      if (seen.length >= cap) return;
      if (c.tag === 'node') {
        const t = (attr(c, 'text') || attr(c, 'content-desc')).trim();
        if (t && !seen.includes(t)) seen.push(t);
        walk(c);
      }
    }
  })(node);
  return seen.join(' · ');
}

/** SPEC §3：标签优先级 */
function labelOf(node) {
  for (const key of ['text', 'content-desc']) {
    const v = attr(node, key).trim();
    if (v) return v;
  }
  const rid = attr(node, 'resource-id').trim();
  if (rid && !isStructuralId(rid)) {
    return rid.slice(rid.lastIndexOf('/') + 1);
  }
  // SPEC §3.2：继承只对 clickable 生效；scrollable 容器不继承
  if (flag(node, 'clickable')) return descendantText(node);
  return '';
}

/** SPEC §4：角色推断 */
function roleOf(node) {
  const simple = simpleClass(node);
  for (const [suffix, role] of ROLE_BY_SUFFIX) {
    if (simple === suffix || simple.endsWith(suffix)) {
      if (role === 'box' && flag(node, 'clickable')) return 'item';
      return role;
    }
  }
  return flag(node, 'clickable') ? 'item' : 'box';
}

/* ------------------------------------------------------------------ *
 * 4. 主入口
 * ------------------------------------------------------------------ */

function parse(xml) {
  const root = parseXml(xml);
  const nodes = collectNodes(root);

  let packageName = '';
  let rotation = 0;
  const elements = [];

  for (const node of nodes) {
    if (!packageName) packageName = attr(node, 'package');
    if (!isActionable(node)) continue;
    const b = parseBounds(attr(node, 'bounds'));
    if (!b) continue;
    if (b.x2 - b.x1 <= 0 || b.y2 - b.y1 <= 0) continue;

    const cls = attr(node, 'class');
    elements.push({
      ref: '',                                   // 稍后统一编号
      role: roleOf(node),
      label: labelOf(node),
      bounds: [b.x1, b.y1, b.x2, b.y2],
      center: [centerOf(b).x, centerOf(b).y],
      clickable: flag(node, 'clickable'),
      long_clickable: flag(node, 'long-clickable'),
      scrollable: flag(node, 'scrollable'),
      editable: cls.slice(cls.lastIndexOf('.') + 1).endsWith('EditText'),
      checked: flag(node, 'checked'),
      disabled: attr(node, 'enabled') === 'false',
      password: flag(node, 'password'),
    });
  }

  const rot = parseInt(attr(root, 'rotation'), 10);
  if (Number.isFinite(rot)) rotation = rot;

  // SPEC §2.4 确定性：同 XML → 同 ref。前序文档序编号。
  elements.forEach((e, i) => { e.ref = `e${i + 1}`; });

  let width = 0, height = 0;
  for (const e of elements) { width = Math.max(width, e.bounds[2]); height = Math.max(height, e.bounds[3]); }

  const bytes = Buffer.byteLength(xml, 'utf8');
  return {
    snapshot_id: snapshotIdOf(packageName, rotation, xml),
    package: packageName,
    rotation,
    width,
    height,
    elements,
    _centerOf: centerOf,
    nodes_total: nodes.length,
    xml_bytes: bytes,
    digest: () => digest({ package: packageName, rotation, width, height, elements }),
    metrics: () => metrics({ package: packageName, rotation, width, height, elements, nodes_total: nodes.length, xml_bytes: bytes }),
    get: (ref) => elements.find((e) => e.ref === ref) || null,
    resolve: (ref) => {
      const e = elements.find((x) => x.ref === ref);
      if (!e) { const err = new Error(`stale ref ${ref}`); err.code = 'STALE_REF'; throw err; }
      return e;
    },
    [Symbol.iterator]: function* () { yield* elements; },
  };
}

/** SPEC §2.4：内容哈希。规范只要求"同一 XML 同一 id"，未规定算法。 */
function snapshotIdOf(pkg, rot, xml) {
  return 's' + crypto.createHash('sha256').update(`${pkg}|${rot}|${xml}`).digest('hex').slice(0, 12);
}

function flagSuffix(e) {
  const f = [];
  if (e.disabled) f.push('disabled');
  if (e.checked) f.push('checked');
  if (e.password) f.push('password');
  if (e.editable) f.push('editable');
  return f.length ? ` (${f.join(', ')})` : '';
}

function truncate(s, cap = LABEL_CAP) {
  return s.length <= cap ? s : s.slice(0, cap - 3) + '...';
}

/** SPEC §6：digest 文本 */
function digest(s) {
  const lines = [`[${s.snapshot_id}] ${s.package} ${s.width}x${s.height} rot=${s.rotation} elements=${s.elements.length}`];
  for (const e of s.elements) {
    const w = e.bounds[2] - e.bounds[0], h = e.bounds[3] - e.bounds[1];
    const label = e.label
      ? truncate(e.label)
      : `<${e.role} ${w}x${h}>`;           // SPEC §6：空标签用占位，不留空
    const b = `[${e.bounds[0]},${e.bounds[1]}][${e.bounds[2]},${e.bounds[3]}]`;
    lines.push(`  ${e.ref.padEnd(4)} ${e.role.padEnd(7)} ${label}${flagSuffix(e)}  ${b}`);
  }
  return lines.join('\n');
}

/** SPEC §7：量化指标 */
function metrics(s) {
  const d = digest(s);
  const labeled = s.elements.filter((e) => e.label).length;
  return {
    snapshot_id: s.snapshot_id,
    package: s.package,
    nodes_total: s.nodes_total,
    elements: s.elements.length,
    xml_bytes: s.xml_bytes,
    digest_bytes: Buffer.byteLength(d, 'utf8'),
    compression: d ? +(s.xml_bytes / Buffer.byteLength(d, 'utf8')).toFixed(2) : 0,
    est_tokens: Math.floor(Buffer.byteLength(d, 'utf8') / 4),
    labeled,
    label_coverage: s.elements.length ? +(labeled / s.elements.length).toFixed(4) : 0,
    disabled: s.elements.filter((e) => e.disabled).length,
    editable: s.elements.filter((e) => e.editable).length,
    scrollable: s.elements.filter((e) => e.scrollable).length,
  };
}

/* ------------------------------------------------------------------ *
 * 5. 独立实现中撞到的规范歧义（回报给规范修订）
 * ------------------------------------------------------------------ */

const AMBIGUITIES = [
  {
    id: 'A1',
    where: 'SPEC §5 中心点',
    issue: '规范写 `((x1+x2)//2, (y1+y2)//2)` 用了 Python 的 // 语法。'
         + 'JS 里 |0 与 >>1 向零取整，Math.floor 向负无穷取整。'
         + 'SPEC §5 又明确允许负坐标——两者在负半轴会差 1。',
    fix: '规范应写「向负无穷取整（floor）」，而不是借用 // 记法。',
  },
  {
    id: 'A2',
    where: 'SPEC §3.1 结构性 id',
    issue: '规范列举 8 个名字后写「等结构性容器名」，是开口。'
         + '不同实现会各自扩充集合，破坏确定性（SPEC §2.4）。',
    fix: '规范应给出穷举集合，或明确「实现可扩展，但黄金向量只认这 N 个」。',
  },
  {
    id: 'A3',
    where: 'SPEC §1 XML 解析',
    issue: '规范未定义输入 XML 的边界：实体转义、CDATA、注释、命名空间、'
         + '属性缺省值、标签名是否恒为 node。',
    fix: '规范应加一节「输入子集」，明确实现只需支持的 XML 形态。',
  },
  {
    id: 'A4',
    where: 'SPEC §2.2 ref 编号顺序',
    issue: '规范只说「确定性」，未明确编号顺序是前序文档序。'
         + '一个按 bounds 排序的实现同样确定，但 ref 会不同。',
    fix: '规范应明确「按前序深度优先文档序编号」。',
  },
  {
    id: 'A5',
    where: 'SPEC §3.3 继承的文本来源',
    issue: '规范说「子孙文本拼接」，未说是否包含 content-desc，'
         + '也未说是否跨代（隔代孙）。',
    fix: '规范应明确「text 与 content-desc 都算，跨代，去重保序，上限 4」。',
  },
];

module.exports = {
  parse, parseXml, collectNodes, digest, metrics,
  centerOf, parseBounds, isActionable, roleOf, labelOf, isStructuralId,
  descendantText, snapshotIdOf,
  STRUCTURAL_IDS, ROLE_BY_SUFFIX, INHERIT_CAP, LABEL_CAP, AMBIGUITIES,
};

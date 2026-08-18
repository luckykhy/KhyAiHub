/**
 * graphPatch.js — 纯叶子：运行时图补丁（**受限 DSL，绝不是 JS**）。
 * --------------------------------------------------------------------------
 * 真源：`[DESIGN-ARCH-141]` §5-D1「运行时自演化」。
 *
 * ## 它解决什么
 *
 * `workflowExecutor.runGraph()` 在启动时把 `graph.nodes` / `graph.connections`
 * 建成两个 `Map`，之后**只读** —— 于是「运行到一半按已发现的数据改变后续拓扑」
 * 做不到（G3「图启动即冻结」）。本叶子提供**受控的加法改写**，让那个 Map 可以被
 * 就地增补，从而让后续节点真的执行到新节点。
 *
 * ## 三条硬边界（对齐方案 §10 的裁决与 §6 的防呆铁律）
 *
 * 1. **数据补丁，不是代码**。算子只有 `addNode` / `connect` / `disconnect`，没有任何
 *    `eval` / `Function` / 表达式求值。`code` 节点已有的 `new Function` 信任边界
 *    **不适用于图改写** —— 图是引擎结构，改它等于改后续**所有**节点的执行权，量级不同。
 * 2. **删节点禁止，删边允许**（方案 §10-Q2，2026-09-24 收窄裁决）。
 *    原文禁的是「节点/边」；收窄依据：在飞 checkpoint 的 `pending_json.loopState`
 *    指向的是**节点**，删边不产生该类悬空。故 `removeNode` / `deleteNode` 一律被拒，
 *    而 `disconnect`（**只删边**）允许 —— 它也是解开「加法补丁只能落在尚无出边的位置」
 *    这个硬限制的唯一手段（见 §12.7 / §12.8）。
 * 3. **事务性**。先算候选图 → 强校验（端口 + 唯一 start / ≥1 end / 端点无非法边）
 *    → **通过才返回**。绝不出现「半改」状态；被拒时调用方拿到的图与调用前逐字段相同。
 *
 * ## 一条容易写错的判据
 *
 * 校验**只对「补丁新引入的错误」判失败**。原图本身若已带历史瑕疵（例如 start 有入边），
 * 那是存量问题、不该由补丁背锅 —— 否则一个合法补丁会因与它无关的旧瑕疵被拒。
 *
 * ## 补丁来源：`ops` 与 `onVar`（2026-09-24 裁决「两者都接受」）
 *
 * 补丁可以**静态写死**（`ops`），也可以**来自运行期变量**（`onVar`）——
 * 后者才是「运行时自演化」的入口：补丁在跑起来之前并不存在。
 *
 * 优先级：`onVar` 一旦声明（非空字符串）就**只认它**，解析失败**不回落**到
 * `ops` —— 回落等于静默降级：作者声明了运行期来源，引擎却跑了一份静态补丁，
 * 而日志上看不出区别。
 *
 * `vars[onVar]` 接受两种形态：**数组**（结构化来源，如 `http` 节点写入的 JSON
 * 响应）与**字符串**（AI 产出补丁的常见形态，按 `extractFirstJson` 容错解析，
 * 剥 ```json 围栏、容忍前后文）。解析结果必须是数组。
 *
 * ## 契约
 *
 * 零 IO、确定性、**绝不抛**（一律返回 `{ok:false, errors}`），可离线单测。
 * 两个依赖都是同样纯的零依赖叶子：`./workflowCliCore`（图校验）与
 * `./jsonExtract`（容错 JSON 抽取，供 `onVar` 用）。
 *
 * ⚠ **不在叶子里 require `nodeCatalog`** —— 沿用 `workflowCliCore.validateGraph` 的既有
 * 约定：端口词汇与已知类型集合由调用方**注入**（`ctx.portsFor` / `ctx.knownTypes`）。
 * 注入缺失时**一律拒绝**（fail-closed），绝不「拿不到类型集合就放行」。
 *
 * @pattern Value Object / Pure Function
 */
'use strict';

const { validateGraph } = require('./workflowCliCore');
const { extractFirstJson } = require('./jsonExtract');

/** 图规模上界：防 `graphPatch` 反复扇出把图撑爆（方案 §5-D1「上界」）。 */
const MAX_NODES = 200;

/** 单次 run 的图修订次数上界。 */
const MAX_REVISIONS = 50;

/**
 * 允许的算子。`disconnect` 是**边级**删除（Q2 收窄裁决后放开）；
 * 节点级删除见 `NODE_DELETE_OPS`，仍一律被拒。
 */
const ALLOWED_OPS = ['addNode', 'connect', 'disconnect'];

/**
 * 明确禁止的算子：**节点级**删除。被拒时给出可检索的理由。
 * ⚠ 边级删除（`disconnect`）**不在**此列 —— 见 `ALLOWED_OPS`。
 */
const NODE_DELETE_OPS = ['removeNode', 'deleteNode'];


function _str(v) {
  return v == null ? '' : String(v);
}

/**
 * 防御式取端口词汇。`portsFor` 由调用方**注入**，不能假设它一定不抛；
 * 契约是「绝不抛」，所以这里捕获一切异常。
 *
 * ⚠ 失败返回 **`null`**（而非空端口）—— 两者必须可区分：
 * 「空端口」会让调用方误报「补丁的端口非法」，把矛头指向补丁，
 * 而真因是**注入的能力不可用**。调用点据此报出不同的错误串。
 *
 * @param {Function|null} portsFor
 * @param {string} type
 * @returns {{inputs:string[], outputs:string[]}|null} null = 能力不可用
 */
function _portsFor(portsFor, type) {
  try {
    const p = portsFor(type);
    if (!p || typeof p !== 'object') {
      return null;
    }
    return {
      inputs: Array.isArray(p.inputs) ? p.inputs : [],
      outputs: Array.isArray(p.outputs) ? p.outputs : [],
    };
  } catch {
    return null;
  }
}

/**
 * 强校验一个 canonical 图，返回**错误串数组**（不抛）。
 * @param {{nodes:object[], connections:object[]}} graph
 * @returns {string[]}
 */
function _validate(graph, caps) {
  const res = validateGraph(graph, {
    portsFor: caps.portsFor,
    knownTypes: caps.knownTypes,
    strict: true,
  });
  return Array.isArray(res && res.errors) ? res.errors : [];
}

/**
 * 应用一个图补丁。**纯函数**：不改动传入的 `graph`。
 *
 * @param {{nodes?:object[], connections?:object[]}} graph  当前图（不被修改）
 * @param {Array<object>} ops  补丁算子数组
 * @param {{maxNodes?:number, portsFor?:Function, knownTypes?:Set<string>|string[]}} [ctx]
 *   `portsFor` / `knownTypes` **必须注入**（见「契约」）；缺失即拒绝。
 * @returns {{ok:true, errors:string[], applied:object[], graph:{nodes:object[],connections:object[]}}
 *          |{ok:false, errors:string[], applied:object[]}}
 */
function applyPatch(graph, ops, ctx = {}) {
  const applied = [];

  // 注入闸：拿不到端口/类型能力就一律拒绝 —— 绝不 fail-open。
  const caps = {
    portsFor: typeof ctx.portsFor === 'function' ? ctx.portsFor : null,
    knownTypes:
      ctx.knownTypes instanceof Set
        ? ctx.knownTypes
        : Array.isArray(ctx.knownTypes)
          ? new Set(ctx.knownTypes)
          : null,
  };
  if (!caps.portsFor || !caps.knownTypes) {
    return {
      ok: false,
      errors: ['graphPatch 缺少 portsFor / knownTypes 注入（拒绝，不得 fail-open）'],
      applied,
    };
  }

  const g = graph && typeof graph === 'object' ? graph : {};
  const nodes = (Array.isArray(g.nodes) ? g.nodes : []).slice();
  const connections = (Array.isArray(g.connections) ? g.connections : []).slice();

  const maxNodes =
    Number.isFinite(ctx.maxNodes) && ctx.maxNodes > 0 ? Math.floor(ctx.maxNodes) : MAX_NODES;

  if (!Array.isArray(ops)) {
    return { ok: false, errors: ['graphPatch.ops 必须是数组'], applied };
  }
  if (!ops.length) {
    return { ok: false, errors: ['graphPatch.ops 为空数组（没有任何改写意图）'], applied };
  }

  const errors = [];

  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i];
    const at = `ops[${i}]`;
    if (!op || typeof op !== 'object' || Array.isArray(op)) {
      errors.push(`${at} 不是对象`);
      continue;
    }
    const name = _str(op.op);

    if (NODE_DELETE_OPS.includes(name)) {
      errors.push(
        `${at} 算子 '${name}' 被拒：删除节点默认禁止（方案 §10-Q2）。` +
          '删边请用 disconnect（边级删除已放开）'
      );
      continue;
    }
    if (!ALLOWED_OPS.includes(name)) {
      errors.push(`${at} 未知算子 '${name}'（允许：${ALLOWED_OPS.join(', ')}）`);
      continue;
    }

    if (name === 'addNode') {
      const n = op.node;
      if (!n || typeof n !== 'object' || Array.isArray(n)) {
        errors.push(`${at} addNode 缺少 node 对象`);
        continue;
      }
      const id = _str(n.id);
      if (!id) {
        errors.push(`${at} addNode 的 node.id 不能为空`);
        continue;
      }
      if (nodes.some((x) => x && _str(x.id) === id)) {
        errors.push(`${at} 节点 id '${id}' 已存在（addNode 不覆盖既有节点）`);
        continue;
      }
      const type = _str(n.type);
      if (!caps.knownTypes.has(type)) {
        errors.push(`${at} 未知节点类型 '${type}'（未在 nodeCatalog 声明）`);
        continue;
      }
      if (nodes.length + 1 > maxNodes) {
        errors.push(`${at} 超出节点上限 ${maxNodes}（MAX_NODES）`);
        continue;
      }
      const node = { id, type };
      if (n.name != null) {
        node.name = _str(n.name);
      }
      node.data = n.data && typeof n.data === 'object' && !Array.isArray(n.data) ? n.data : {};
      nodes.push(node);
      applied.push({ op: name, id, type });
      continue;
    }

    if (name === 'disconnect') {
      // 边级删除（Q2 收窄裁决）。**只删边，不动节点** —— 故不产生
      // `pending_json.loopState` 指向已删节点的悬空。
      const dFrom = _str(op.from);
      const dFromPort = _str(op.fromPort) || 'default';
      const dTo = _str(op.to); // 可选：省略则删该 (from, fromPort) 的全部出边
      if (!dFrom) {
        errors.push(`${at} disconnect 需要 from`);
        continue;
      }
      const beforeLen = connections.length;
      for (let k = connections.length - 1; k >= 0; k -= 1) {
        const c = connections[k];
        if (!c || _str(c.from) !== dFrom) {
          continue;
        }
        if ((_str(c.fromPort) || 'default') !== dFromPort) {
          continue;
        }
        if (dTo && _str(c.to) !== dTo) {
          continue;
        }
        connections.splice(k, 1);
      }
      const removed = beforeLen - connections.length;
      if (!removed) {
        // fail-closed：删一条不存在的边，说明补丁作者的心智模型与实际图不符，
        // 静默放行会让后续 connect 落在错误的拓扑上。
        errors.push(
          `${at} disconnect 找不到匹配的边 (${dFrom}:${dFromPort}${dTo ? ' → ' + dTo : ''})（拒绝：与当前图不符）`
        );
        continue;
      }
      applied.push({ op: name, from: dFrom, fromPort: dFromPort, to: dTo || null, removed });
      continue;
    }

    // name === 'connect'
    const from = _str(op.from);
    const to = _str(op.to);
    const fromPort = _str(op.fromPort) || 'default';
    const toPort = _str(op.toPort) || 'input';
    if (!from || !to) {
      errors.push(`${at} connect 需要 from / to`);
      continue;
    }
    const src = nodes.find((x) => x && _str(x.id) === from);
    const dst = nodes.find((x) => x && _str(x.id) === to);
    if (!src) {
      errors.push(`${at} connect 的源节点 '${from}' 不存在（需在同一补丁内先 addNode）`);
      continue;
    }
    if (!dst) {
      errors.push(`${at} connect 的目标节点 '${to}' 不存在（需在同一补丁内先 addNode）`);
      continue;
    }
    const srcPorts = _portsFor(caps.portsFor, src.type);
    if (!srcPorts) {
      errors.push(
        `${at} 注入的 portsFor 对类型 '${src.type}' 不可用（能力异常，拒绝；节点 ${from}）`
      );
      continue;
    }
    if (!srcPorts.outputs.includes(fromPort)) {
      errors.push(`${at} 非法源端口 '${fromPort}' on ${src.type}（节点 ${from}）`);
      continue;
    }
    const dstPorts = _portsFor(caps.portsFor, dst.type);
    if (!dstPorts) {
      errors.push(
        `${at} 注入的 portsFor 对类型 '${dst.type}' 不可用（能力异常，拒绝；节点 ${to}）`
      );
      continue;
    }
    if (!dstPorts.inputs.includes(toPort)) {
      errors.push(`${at} 非法目标端口 '${toPort}' on ${dst.type}（节点 ${to}）`);
      continue;
    }
    const dup = connections.some(
      (c) => c && _str(c.from) === from && (_str(c.fromPort) || 'default') === fromPort && _str(c.to) === to
    );
    if (dup) {
      errors.push(`${at} 重复连接 ${from}:${fromPort} → ${to}`);
      continue;
    }
    connections.push({ from, fromPort, to, toPort });
    applied.push({ op: name, from, fromPort, to, toPort });
  }

  if (errors.length) {
    return { ok: false, errors, applied };
  }

  // 事务性校验：只对「补丁新引入」的错误判失败（不替原图的历史瑕疵背锅）。
  const candidate = { nodes, connections };
  const before = new Set(_validate({ nodes: g.nodes || [], connections: g.connections || [] }, caps));
  const after = _validate(candidate, caps);
  const introduced = after.filter((e) => !before.has(e));
  if (introduced.length) {
    return { ok: false, errors: introduced, applied };
  }

  return { ok: true, errors: [], applied, graph: candidate };
}

/** 供错误串使用的中文类型名（避免把 JS 的 'object'/'number' 直接抛给用户）。 */
function _jsonType(v) {
  if (v === null) {
    return 'null';
  }
  if (Array.isArray(v)) {
    return '数组';
  }
  if (typeof v === 'object') {
    return '对象';
  }
  if (typeof v === 'string') {
    return '字符串';
  }
  if (typeof v === 'number') {
    return '数字';
  }
  if (typeof v === 'boolean') {
    return '布尔';
  }
  return typeof v;
}

/**
 * 解析 `graphPatch` 的**补丁来源**。纯函数，**绝不抛**。
 *
 * 判据见文件头「补丁来源」一节。要点：
 * - `onVar` 为非空字符串 ⇒ 只认变量，解析失败**不回落**到 `ops`（回落 = 静默降级）。
 * - `onVar` 缺失 / `''` / 纯空白 ⇒ 视为**未指定**（沿用本执行器既有约定：
 *   `d.outputVar` 等字段一律以 falsy 表示「没填」，前端空文本框正是 `''`）。
 * - `onVar` 是其它类型（数字/对象/数组/布尔）⇒ 拒绝：字段被写了但不可用，
 *   静默忽略会让作者以为运行期来源生效了。
 *
 * ⚠ **每条成因给独立措辞**。同一个拒绝点有 5 种成因（无变量袋 / 变量不存在 /
 * 不是合法 JSON / 解析出非数组 / 类型不对），若都报同一句，调用方会去查错方向 ——
 * 与 §12.7 判据二「fail-closed ≠ 错误报对」是同一条。
 *
 * @param {{ops?:*, onVar?:*, vars?:*}} [input]
 * @returns {{ok:true, ops:object[], source:string, errors:string[]}
 *          |{ok:false, ops:null, source:string, errors:string[]}}
 *          `source` = `'ops'` 或 `'onVar:<变量名>`，供审计记录补丁出处。
 */
function resolvePatchOps(input = {}) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const onVarRaw = src.onVar;
  const vars = src.vars;
  const ops = src.ops;

  // 非字符串但**被写了值** ⇒ 声明畸形，拒绝（不能静默当没写）。
  if (onVarRaw != null && typeof onVarRaw !== 'string') {
    return {
      ok: false,
      ops: null,
      source: 'onVar',
      errors: [
        `graphPatch.onVar 必须是变量名字符串（收到 ${_jsonType(onVarRaw)}）`,
      ],
    };
  }

  const name = typeof onVarRaw === 'string' ? onVarRaw.trim() : '';

  // 未声明运行期来源 ⇒ 用静态 ops。
  if (!name) {
    if (Array.isArray(ops)) {
      if (!ops.length) {
        return {
          ok: false,
          ops: null,
          source: 'ops',
          errors: ['graphPatch.ops 为空数组（没有任何改写意图）'],
        };
      }
      return { ok: true, ops, source: 'ops', errors: [] };
    }
    return {
      ok: false,
      ops: null,
      source: 'ops',
      errors: ['graphPatch 既没有 ops 数组，也没有 onVar 变量名（无法确定补丁来源）'],
    };
  }

  const source = `onVar:${name}`;
  const fail = (why) => ({
    ok: false,
    ops: null,
    source,
    errors: [`graphPatch.onVar 变量 '${name}' ${why}`],
  });

  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) {
    return fail('需要 vars 变量袋，但当前没有（onVar 只能从运行期变量取补丁）');
  }
  if (!(name in vars) || vars[name] === undefined) {
    return fail('不存在（变量袋里没有这个名字）');
  }

  const value = vars[name];

  if (Array.isArray(value)) {
    if (!value.length) {
      return fail('解析出空数组（没有任何改写意图）');
    }
    return { ok: true, ops: value, source, errors: [] };
  }

  if (typeof value === 'string') {
    const parsed = extractFirstJson(value);
    if (parsed === null) {
      return fail('是字符串但不是合法 JSON（容错解析后仍失败）');
    }
    if (!Array.isArray(parsed)) {
      return fail(`解析出的是${_jsonType(parsed)}，不是补丁数组`);
    }
    if (!parsed.length) {
      return fail('解析出空数组（没有任何改写意图）');
    }
    return { ok: true, ops: parsed, source, errors: [] };
  }

  return fail(`的值是${_jsonType(value)}，既不是数组也不是 JSON 文本`);
}

module.exports = {
  applyPatch,
  resolvePatchOps,
  ALLOWED_OPS,
  NODE_DELETE_OPS,
  MAX_NODES,
  MAX_REVISIONS,
};

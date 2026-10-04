/**
 * expandTemplate.js — 纯叶子：把「子图模板」按运行期数据内联 N 份并**串成链**。
 * --------------------------------------------------------------------------
 * 真源：`[DESIGN-ARCH-141]` §5-D1「运行时自演化」的 `expand` 节点（§12.9）。
 *
 * ## 它解决什么
 *
 * `graphPatch` 只能做**受限加法改写**（算子 `addNode` / `connect` / `disconnect`），
 * 改写意图必须由图的作者在补丁里逐条写死。而「按运行期拿到的数组决定要跑几份、
 * 每份用哪个元素」需要**批量、带数据绑定**的改写 —— 那是 `expand` 的职责。
 *
 * ## 模板的形态：**片段**（去 start/end）
 *
 * ⚠ 这是本叶子最容易被写错的地方，实测取证（2026-09-24）：
 *
 * 1. **不能原样内联**。任何可独立运行的 flow 都必然自带 `start` —— 原样内联一份就会
 *    撞上「图必须恰好有一个 start 节点」，被 `validateGraph(strict)` 拒（实测报
 *    `实际 2`）。
 * 2. **更不能连 `end` 一起内联**。执行器的 `case 'end'` 是 `return {status:'completed'}`
 *    —— 模板里的 `end` 会**终止整轮 run**，串行链断在第一份。
 *
 * 故模板被当作**片段**：只取**非 start/end** 的节点与它们之间的边。
 * - **片段入口** = 模板 `start` 的**唯一**后继（该后继的入端口沿用原边）；
 * - **片段出口** = 模板 `end` 的**唯一**前驱（其出端口沿用原边）。
 *
 * 模板必须是**单入口单出口**，否则一律 fail-closed（多入口/多出口没有唯一可接的
 * 位置，硬接会静默改变语义）。
 *
 * ## 串行链接线（裁决 2026-09-24：串行链）
 *
 * ```
 *   expand ──▶ copy0.entry ──…──▶ copy0.exit ──▶ copy1.entry ──…──▶ copyN-1.exit ──▶ 原后继 S
 * ```
 *
 * `N === 0` 时**不内联**：expand 直接退场，游标走它原来的后继（与 `loop` 的
 * `limit === 0 ⇒ loop-done` 同构）。
 *
 * ## 逐份变量绑定
 *
 * 每份副本的**入口节点**带上 `data.__bind = { var, value }`；执行器在主循环体顶部
 * 应用它（与 `loop` 的「进循环体前写 `vars[itemVar]`」同构，见 `workflowExecutor.js`
 * 的 `case 'loop'`）。用「挂在节点上」而不是「expand 里一次写完」，是因为所有副本
 * **共享同一个 `vars`**：只在 expand 里写一次，N 份看到的都会是最后一个元素。
 *
 * ## 契约
 *
 * 零 IO、确定性、**绝不抛**（一律返回 `{ok:false, errors}`），可离线单测。
 * 依赖只有同样纯的 `./workflowCliCore`。
 *
 * ⚠ **不在叶子里 require `nodeCatalog`** —— 沿用 `workflowCliCore.validateGraph` 的既有
 * 约定：端口词汇与已知类型集合由调用方**注入**（`ctx.portsFor` / `ctx.knownTypes`）。
 * 注入缺失时**一律拒绝**（fail-closed），绝不「拿不到类型集合就放行」。
 *
 * @pattern Value Object / Pure Function
 */
'use strict';

const { validateGraph } = require('./workflowCliCore');

/**
 * 图规模上界。与 `graphPatch.MAX_NODES` **同口径**（同一份引擎预算）：
 * 执行器会把同一个 `maxNodes` 传给两个叶子，故此默认值只在离线单测时生效。
 */
const MAX_NODES = 200;

/** 每份副本的入口节点上挂的绑定标记字段名。 */
const BIND_FIELD = '__bind';


function _str(v) {
  return v == null ? '' : String(v);
}

/** 副本 id 命名空间：`<expandId>__<index>__<origId>`。 */
function copyId(expandId, index, origId) {
  return `${expandId}__${index}__${origId}`;
}

/**
 * 防御式取端口词汇（与 `graphPatch._portsFor` 同构：失败返回 `null`，
 * 使「能力不可用」与「端口非法」在错误串上可区分）。
 * @returns {{inputs:string[], outputs:string[]}|null}
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
 * 从模板图里抽「片段」。
 * @param {object} tpl 模板图 `{ nodes, connections }`
 * @returns {{ok:true, nodes:object[], connections:object[], entry:string, entryToPort:string,
 *            exit:string, exitFromPort:string}
 *          |{ok:false, errors:string[]}}
 */
function extractFragment(tpl) {
  const errors = [];
  const nodes = Array.isArray(tpl && tpl.nodes) ? tpl.nodes : [];
  const conns = Array.isArray(tpl && tpl.connections) ? tpl.connections : [];

  const starts = nodes.filter((n) => n && n.type === 'start');
  const ends = nodes.filter((n) => n && n.type === 'end');

  if (starts.length !== 1) {
    errors.push(`模板必须恰好有一个 start 节点（实际 ${starts.length}）`);
  }
  if (ends.length !== 1) {
    errors.push(`模板必须恰好有一个 end 节点（实际 ${ends.length}）`);
  }
  if (errors.length) {
    return { ok: false, errors };
  }

  const startId = starts[0].id;
  const endId = ends[0].id;

  const outOfStart = conns.filter((c) => c && _str(c.from) === _str(startId));
  if (outOfStart.length !== 1) {
    errors.push(
      `模板必须**单入口**：start 的出边须恰好 1 条（实际 ${outOfStart.length}）——` +
        '多入口没有唯一可接的位置，硬接会静默改变语义'
    );
  }
  const inOfEnd = conns.filter((c) => c && _str(c.to) === _str(endId));
  if (inOfEnd.length !== 1) {
    errors.push(
      `模板必须**单出口**：end 的入边须恰好 1 条（实际 ${inOfEnd.length}）——` +
        '多出口没有唯一可接的位置，硬接会静默改变语义'
    );
  }
  if (errors.length) {
    return { ok: false, errors };
  }

  const entry = _str(outOfStart[0].to);
  const exit = _str(inOfEnd[0].from);
  const entryToPort = _str(outOfStart[0].toPort) || 'input';
  const exitFromPort = _str(inOfEnd[0].fromPort) || 'default';

  if (entry === _str(startId) || entry === _str(endId) || exit === _str(startId) || exit === _str(endId)) {
    errors.push('模板退化为「start 直连 end」或自环，没有可内联的片段');
    return { ok: false, errors };
  }

  // 片段 = 去掉 start/end 的节点，以及**不与 start/end 相连**的边。
  const fragNodes = nodes.filter((n) => n && n.type !== 'start' && n.type !== 'end');
  const fragConns = conns.filter(
    (c) => c && _str(c.from) !== _str(startId) && _str(c.from) !== _str(endId) &&
      _str(c.to) !== _str(startId) && _str(c.to) !== _str(endId)
  );

  if (!fragNodes.length) {
    errors.push('模板的片段为空（去掉 start/end 后没有任何节点）');
    return { ok: false, errors };
  }

  return {
    ok: true,
    nodes: fragNodes,
    connections: fragConns,
    entry,
    entryToPort,
    exit,
    exitFromPort,
  };
}

/**
 * 把模板内联 N 份并串成链。**纯函数**：不改动传入的 `graph` / `template`。
 *
 * @param {{nodes?:object[], connections?:object[]}} graph 主图（不被修改）
 * @param {object} opts
 * @param {string} opts.expandId    expand 节点的 id（用作副本命名空间）
 * @param {object} opts.template    模板图 `{ nodes, connections }`
 * @param {number} opts.instances   实例数 N（≥0 的整数）
 * @param {Array}  [opts.items]     逐份绑定的元素（长度须 === instances）
 * @param {string} [opts.itemVar]   每份绑定的变量名（默认 `item`）
 * @param {string|null} [opts.successor] expand 的原后继节点 id（可为 null）
 * @param {{maxNodes?:number, portsFor?:Function, knownTypes?:Set<string>|string[]}} [ctx]
 *   `portsFor` / `knownTypes` **必须注入**；缺失即拒绝。
 * @returns {{ok:true, graph:object, applied:object[], copies:number, entry:?string, exit:?string}
 *          |{ok:false, errors:string[]}}
 */
function expandGraph(graph, opts, ctx = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};

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
      errors: ['expand 缺少 portsFor / knownTypes 注入（拒绝，不得 fail-open）'],
    };
  }

  const g = graph && typeof graph === 'object' ? graph : {};
  const baseNodes = (Array.isArray(g.nodes) ? g.nodes : []).slice();
  const baseConns = (Array.isArray(g.connections) ? g.connections : []).slice();

  const expandId = _str(o.expandId);
  if (!expandId) {
    return { ok: false, errors: ['expand 需要 expandId（用于副本命名空间）'] };
  }

  const n = Number(o.instances);
  if (!Number.isInteger(n) || n < 0) {
    return { ok: false, errors: [`expand.instances 必须是 ≥0 的整数（实得 ${JSON.stringify(o.instances)}）`] };
  }

  const items = Array.isArray(o.items) ? o.items : [];
  if (items.length !== n) {
    return {
      ok: false,
      errors: [`expand.items 长度（${items.length}）必须等于 instances（${n}）`],
    };
  }

  const itemVar = _str(o.itemVar) || 'item';
  const successor = o.successor == null || o.successor === '' ? null : _str(o.successor);

  const maxNodes =
    Number.isFinite(ctx.maxNodes) && ctx.maxNodes > 0 ? Math.floor(ctx.maxNodes) : MAX_NODES;

  // N === 0：不内联，expand 退场（游标走它原来的后继）。与 loop 的 limit===0 同构。
  if (n === 0) {
    return { ok: true, graph: { nodes: baseNodes, connections: baseConns }, applied: [], copies: 0, entry: null, exit: null };
  }

  const frag = extractFragment(o.template);
  if (!frag.ok) {
    return { ok: false, errors: frag.errors };
  }

  // ── 规模上界（先算，避免白做工）────────────────────────────────────────
  const projected = baseNodes.length + frag.nodes.length * n;
  if (projected > maxNodes) {
    return {
      ok: false,
      errors: [
        `expand 会把图撑到 ${projected} 个节点，超出上限 ${maxNodes}` +
          `（每份 ${frag.nodes.length} × ${n} 份 + 现有 ${baseNodes.length}）`,
      ],
    };
  }

  // ── 生成 N 份副本 ─────────────────────────────────────────────────────
  const nodes = baseNodes.slice();
  const connections = baseConns.slice();
  const applied = [];

  // 先摘掉 expand 的原出边（它要被「expand -> copy0.entry」取代）。
  // 注意：只摘 expand:default 那一条，别的端口不动。
  const kept = [];
  let removedSuccessorEdge = 0;
  for (const c of connections) {
    const isSuccessorEdge =
      c && _str(c.from) === expandId && (_str(c.fromPort) || 'default') === 'default';
    if (isSuccessorEdge) {
      removedSuccessorEdge += 1;
      continue;
    }
    kept.push(c);
  }
  connections.length = 0;
  for (const c of kept) {
    connections.push(c);
  }
  if (successor && removedSuccessorEdge === 0) {
    return {
      ok: false,
      errors: [`expand 节点 ${expandId} 没有到后继 ${successor} 的 default 出边（图与调用方不一致）`],
    };
  }

  let prevExit = null; // { id, fromPort }
  for (let i = 0; i < n; i += 1) {
    for (const fn of frag.nodes) {
      const cp = { ...fn, id: copyId(expandId, i, fn.id) };
      if (_str(fn.id) === frag.entry) {
        cp.data = { ...(fn.data && typeof fn.data === 'object' ? fn.data : {}) };
        cp.data[BIND_FIELD] = { var: itemVar, value: items[i] };
      }
      nodes.push(cp);
    }
    for (const fc of frag.connections) {
      connections.push({
        ...fc,
        from: copyId(expandId, i, fc.from),
        to: copyId(expandId, i, fc.to),
      });
    }
    const entryCopyId = copyId(expandId, i, frag.entry);
    const exitCopyId = copyId(expandId, i, frag.exit);

    // 上一份的出口 -> 本份入口
    if (prevExit) {
      connections.push({
        from: prevExit.id,
        fromPort: prevExit.fromPort,
        to: entryCopyId,
        toPort: frag.entryToPort,
      });
    }
    prevExit = { id: exitCopyId, fromPort: frag.exitFromPort };

    applied.push({ instance: i, entry: entryCopyId, exit: exitCopyId, bound: items[i] });
  }

  // expand -> copy0.entry
  connections.push({
    from: expandId,
    fromPort: 'default',
    to: copyId(expandId, 0, frag.entry),
    toPort: frag.entryToPort,
  });
  // copyN-1.exit -> 原后继
  if (successor) {
    connections.push({
      from: prevExit.id,
      fromPort: prevExit.fromPort,
      to: successor,
      toPort: 'input',
    });
  }

  // ── 事务性校验：只对「本次内联新引入」的错误判失败 ─────────────────────
  const candidate = { nodes, connections };
  // 基线用**原始数组的切片**（baseNodes/baseConns 未被改动），避免非数组入参把基线算空。
  const before = new Set(_validate({ nodes: baseNodes, connections: baseConns }, caps));
  const after = _validate(candidate, caps);
  const introduced = after.filter((e) => !before.has(e));
  if (introduced.length) {
    return { ok: false, errors: introduced };
  }

  return {
    ok: true,
    graph: candidate,
    applied,
    copies: n,
    entry: copyId(expandId, 0, frag.entry),
    exit: prevExit.id,
  };
}

/** 强校验（不抛）：返回错误串数组。 */
function _validate(graph, caps) {
  const res = validateGraph(graph, {
    portsFor: caps.portsFor,
    knownTypes: caps.knownTypes,
    strict: true,
  });
  return Array.isArray(res && res.errors) ? res.errors : [];
}

module.exports = {
  expandGraph,
  extractFragment,
  copyId,
  MAX_NODES,
  BIND_FIELD,
};

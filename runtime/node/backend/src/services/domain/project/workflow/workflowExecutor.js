/**
 * Native workflow DAG interpreter (Phase 2).
 *
 * Executes a canvas graph ({ nodes, connections }) directly — the SAME JSON the
 * visual editor saves and the Markdown exporter reads. No code generation: this
 * is the runtime path.
 *
 * Control flow uses a SINGLE CURSOR rather than a topological sort, because the
 * graph legitimately contains cycles (loop back-edges). The cursor executes the
 * current node, then follows the output port the node selects (default /
 * branch-true|false / loop-body|done) to the next node, until it reaches an end
 * node or a dangling port. A MAX_STEPS guard bounds runaway loops.
 *
 * Node side effects (LLM calls, tool calls, sub-agents) are injected via
 * `primitives`, so the worker supplies the real backend infra and tests supply
 * mocks. This keeps the interpreter pure and unit-testable without booting the
 * agent engine.
 *
 * Expression evaluation (ifElse) is a CONSTRAINED comparator (`a OP b`), never
 * eval/Function — no arbitrary code execution from a stored graph.
 *
 * Node types are FAIL-CLOSED (rule TOOLING-011): an unrecognized `node.type`
 * throws instead of being silently skipped. The supported set is exactly the
 * `case` labels of the interpreter's switch, and must stay a superset of the
 * shared `nodeCatalog` — drift is caught by
 * `scripts/ci/check-workflow-node-parity.js`.
 *
 * @pattern Interpreter
 */
'use strict';

const { request: nativeRequest } = require('../../../../utils/nativeHttp');
const { applyPatch, resolvePatchOps, MAX_NODES, MAX_REVISIONS } = require('./graphPatch');
const { expandGraph } = require('./expandTemplate');

// The node catalog is only needed once a `graphPatch` node actually runs, so it
// is loaded lazily and memoized -- the executor keeps booting even if the shared
// package is absent. The catalog capabilities are INJECTED into the pure leaf
// (never required from inside it), matching workflowCliCore.validateGraph.
let _catalogCaps = null;
function catalogCaps() {
  if (!_catalogCaps) {
    const { portsFor, NODE_CATALOG } = require('@khy/shared/workflow/nodeCatalog');
    _catalogCaps = { portsFor, knownTypes: new Set(NODE_CATALOG.map((n) => n.type)) };
  }
  return _catalogCaps;
}

const MAX_STEPS = 1000;

// ── Pure helpers (exported for unit tests) ───────────────────────────────────

function getPath(obj, path) {
  if (!obj || !path) {
    return undefined;
  }
  return String(path)
    .split('.')
    .reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

// Replace {{ var.path }} occurrences in a template string.
function interpolate(tmpl, vars) {
  if (tmpl == null) {
    return '';
  }
  return String(tmpl).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
    const v = getPath(vars, k);
    if (v == null) {
      return '';
    }
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

// Best-effort extraction of textual output from heterogeneous primitive returns.
function extractText(res) {
  if (res == null) {
    return '';
  }
  if (typeof res === 'string') {
    return res;
  }
  if (typeof res === 'object') {
    const cand =
      res.text ?? res.content ?? res.finalResponse ?? res.output ?? res.result ?? res.message;
    if (cand != null) {
      return typeof cand === 'string' ? cand : JSON.stringify(cand);
    }
    if (res.data != null) {
      return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    }
    return JSON.stringify(res);
  }
  return String(res);
}

function truncate(text, max = 280) {
  const s = String(text == null ? '' : text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Resolve one ifElse operand token: {{var}}, bare var name, quoted string,
// number, or boolean literal.
function resolveOperand(tok, vars) {
  const t = String(tok).trim();
  const m = t.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
  if (m) {
    return getPath(vars, m[1]);
  }
  if (/^".*"$/.test(t) || /^'.*'$/.test(t)) {
    return t.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    return Number(t);
  }
  if (t === 'true') {
    return true;
  }
  if (t === 'false') {
    return false;
  }
  if (/^[\w.]+$/.test(t)) {
    const v = getPath(vars, t);
    if (v !== undefined) {
      return v;
    }
  }
  return t;
}

function compare(a, op, b) {
  const na = Number(a);
  const nb = Number(b);
  const numeric =
    a !== '' && b !== '' && a != null && b != null && !Number.isNaN(na) && !Number.isNaN(nb);
  switch (op) {
    case '==':
      return numeric ? na === nb : String(a) === String(b);
    case '!=':
      return numeric ? na !== nb : String(a) !== String(b);
    case '>':
      return numeric ? na > nb : String(a) > String(b);
    case '<':
      return numeric ? na < nb : String(a) < String(b);
    case '>=':
      return numeric ? na >= nb : String(a) >= String(b);
    case '<=':
      return numeric ? na <= nb : String(a) <= String(b);
    default:
      return false;
  }
}

// Evaluate an ifElse expression to a boolean. Supports "a OP b" and bare
// truthiness of a single value/var. NEVER executes arbitrary code.
function evalCondition(expr, vars) {
  const s = String(expr == null ? '' : expr).trim();
  if (!s) {
    return false;
  }
  const m = s.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (!m) {
    const v = resolveOperand(s, vars);
    return !!v && v !== 'false' && v !== '0';
  }
  return compare(resolveOperand(m[1], vars), m[2], resolveOperand(m[3], vars));
}

// Deep-resolve {{var}} references inside a tool/skill args object. A string that
// is EXACTLY "{{var}}" preserves the referenced value's type; otherwise the
// reference is interpolated into the string.
function resolveArgs(args, vars) {
  if (args == null) {
    return {};
  }
  if (typeof args === 'string') {
    const m = args.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
    if (m) {
      return getPath(vars, m[1]);
    }
    return interpolate(args, vars);
  }
  if (Array.isArray(args)) {
    return args.map((a) => resolveArgs(a, vars));
  }
  if (typeof args === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(args)) {
      out[k] = resolveArgs(v, vars);
    }
    return out;
  }
  return args;
}

// ── Default primitives (real backend infra, lazily required) ─────────────────

/**
 * Build the default side-effect primitives.
 * @param {object} [ctx]  optional execution context. `ctx.userId` is threaded
 *   into executeTool's traceContext so per-user, dynamic tools (Coze-compatible
 *   plugin tools, `plugin__<slug>__<op>`) resolve against the run owner's
 *   installed plugins + auth config.
 */
function defaultPrimitives(ctx = {}) {
  const userId = ctx && ctx.userId != null ? ctx.userId : null;
  return {
    async chat(prompt, opts = {}) {
      // Consume the cli/ai chat core via the inversion port (cli self-registers on
      // load) rather than reaching up into the CLI layer. Callers that need a
      // guaranteed chat in a non-CLI process should inject options.primitives.chat.
      const { getAiChat } = require('../../../aiChatPort');
      const fn = getAiChat();
      if (typeof fn !== 'function') {
        throw new Error('AI chat provider not registered (CLI not loaded; inject primitives.chat)');
      }
      return fn(prompt, opts);
    },
    async executeTool(name, params) {
      const { executeTool } = require('../../../toolCalling');
      return executeTool(name, params || {}, userId != null ? { userId } : {});
    },
    async executeSkill(name, params) {
      const skills = require('../../../../skills');
      return skills.executeSkill(name, params || {}, {});
    },
    async runSubAgent(spec) {
      // Best-effort: route through the Agent/Task tool; fall back to a plain
      // prompt if the tool surface differs.
      try {
        const AgentTool = require('../../../../tools/AgentTool');
        const tool = AgentTool.execute ? AgentTool : AgentTool.default || AgentTool.AgentTool;
        if (tool && typeof tool.execute === 'function') {
          return tool.execute(
            {
              subagent_type: 'general-purpose',
              description: spec.agentName || 'workflow sub-agent',
              prompt: spec.instructions || '',
            },
            {}
          );
        }
      } catch {
        /* fall through to chat */
      }
      return this.chat(spec.instructions || '', { model: spec.model });
    },
    async runCode(language, source, vars) {
      if (language === 'js') {
        // The graph is the user's own, authored on their authenticated backend —
        // same trust boundary as the Bash node. Scope a vars bag, no module access.
        //
        // SECURITY: new Function() is used here to execute user-authored workflow code.
        // This is intentional and runs within the user's authenticated backend context.
        // The code runs in "use strict" mode and only receives a vars bag, no module access.
        // This is equivalent to the Bash node's trust boundary.
        // eslint-disable-next-line no-new-func
        const fn = new Function('vars', `"use strict";\n${source}`);
        return fn(vars);
      }
      return this.executeTool('Bash', { command: source });
    },
    async http(req) {
      const hasBody = req.body !== undefined && req.body !== null;
      const isBuffer = Buffer.isBuffer(req.body);
      const body = !hasBody ? undefined :
        typeof req.body === 'string' || isBuffer ? req.body : JSON.stringify(req.body);
      const headers = { ...(req.headers || {}) };
      if (body !== undefined && typeof req.body === 'object' && !isBuffer) {
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      }
      const res = await nativeRequest(req.url, {
        method: req.method || 'GET',
        headers,
        body,
        timeoutMs: 30000,
      });
      return { status: res.status, data: res.data };
    },
    async loadFlow(templateId) {
      // `expand` 的模板来源（Q1 裁决：**只引用已存 flow**，不做内联模板、不做 AI 现生成）。
      // 惰性 require，与 computeGraphHash 的既有写法一致；加载失败即抛 —— 绝不返回
      // 半个模板让 expand 去猜（那会变成「静默少跑几份」）。
      const { load } = require('./flowRegistry');
      const res = load(templateId);
      if (!res || !res.ok) {
        const why = res && Array.isArray(res.errors) ? res.errors.join('; ') : '未知原因';
        throw new Error(`expand 的 templateId '${templateId}' 无法加载: ${why}`);
      }
      return res.flow;
    },
  };
}

// ── Interpreter ──────────────────────────────────────────────────────────────

function loopStateToObj(map) {
  const o = {};
  for (const [k, v] of map) {
    o[k] = v;
  }
  return o;
}

/**
 * Execute a graph natively.
 *
 * @param {object} graph  canonical { nodes, connections }
 * @param {object} [options]
 * @param {object} [options.primitives]  injectable side-effect fns (see defaults)
 * @param {object} [options.vars]        initial variable bag
 * @param {(entry)=>void} [options.onLog]  called after each node (live progress)
 * @param {number} [options.maxSteps]
 * @param {number} [options.quantum]  when > 0, preemptive time-slicing: after
 *   executing this many nodes in a segment, the interpreter yields control with a
 *   durable checkpoint { status:'paused', pause:{ kind:'quantum', nodeId, loopState } }
 *   pointing at the NEXT node to run. The worker re-queues and resumes it later,
 *   so a long workflow cannot monopolize the shared poller (ready-queue fairness).
 *   Yielding is transparent: resuming reproduces the exact same node sequence,
 *   final vars, and concatenated log as an uninterrupted run. 0 disables it.
 * @param {boolean} [options.pauseOnAsk]  when true, an askUserQuestion node halts
 *   the run and returns { status:'paused', pause } instead of auto-answering.
 * @param {object} [options.resume]  resume checkpoint { nodeId, answer, loopState }:
 *   start the cursor at `nodeId` (the parked askUserQuestion node), inject
 *   `answer`, and continue. Loop counters are restored from `loopState`.
 * @returns {Promise<{ status:'completed'|'paused', vars, log, pause? }>}
 */
async function runGraph(graph, options = {}) {
  const primitives = options.primitives || defaultPrimitives();
  const vars = { ...(options.vars || {}) };
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  const maxSteps = options.maxSteps || MAX_STEPS;
  // Quantum preemption: > 0 ⇒ yield after this many nodes in the current segment.
  const quantum = Number(options.quantum) > 0 ? Math.floor(Number(options.quantum)) : 0;
  const log = [];

  // Runtime self-evolution budgets (D1): a graphPatch node may add nodes and
  // accumulate revisions, but never without bound.
  const maxNodes =
    Number(options.maxNodes) > 0 ? Math.floor(Number(options.maxNodes)) : MAX_NODES;
  const maxRevisions =
    Number(options.maxRevisions) > 0 ? Math.floor(Number(options.maxRevisions)) : MAX_REVISIONS;
  let revisions = 0;

  const nodeList = Array.isArray(graph.nodes) ? graph.nodes : [];
  // LIVE graph view (D1 runtime self-evolution): `nodes` / `outEdges` /
  // `connections` are the very objects `nextNode()` closes over, so a
  // `graphPatch` node rewrites them IN PLACE and the cursor sees the change
  // immediately -- no reassignment, no re-entry, no second interpreter.
  const nodes = new Map(nodeList.map((n) => [n.id, n]));
  const connections = (Array.isArray(graph.connections) ? graph.connections : []).slice();
  const outEdges = new Map();
  for (const c of connections) {
    if (!outEdges.has(c.from)) {
      outEdges.set(c.from, []);
    }
    outEdges.get(c.from).push(c);
  }

  const nextNode = (nodeId, port) => {
    const edges = outEdges.get(nodeId) || [];
    const edge = edges.find((e) => (e.fromPort || 'default') === port);
    return edge ? nodes.get(edge.to) || null : null;
  };

  const start = nodeList.find((n) => n.type === 'start');
  if (!start) {
    throw new Error('graph has no start node');
  }

  // Resume from a durable checkpoint (cross-process human-in-the-loop OR quantum
  // preemption). A quantum resume ONLY repositions the cursor — the node it
  // points at must execute normally; only an answer (askUserQuestion) resume
  // injects a saved answer and skips its parked node. So resumeNodeId/
  // pendingAnswer stay null for a quantum resume.
  const resume = options.resume && options.resume.nodeId ? options.resume : null;
  const isQuantumResume = !!(resume && resume.kind === 'quantum');
  const loopState = new Map();
  if (resume && resume.loopState && typeof resume.loopState === 'object') {
    for (const [k, v] of Object.entries(resume.loopState)) {
      loopState.set(k, v);
    }
  }
  let resumeNodeId = resume && !isQuantumResume ? resume.nodeId : null;
  let pendingAnswer = resume && !isQuantumResume ? resume.answer : undefined;
  let cur = resume ? nodes.get(resume.nodeId) : start;
  if (resume && !cur) {
    throw new Error(`resume node ${resume.nodeId} not found in graph`);
  }
  let steps = 0;

  while (cur) {
    if (++steps > maxSteps) {
      throw new Error(`workflow exceeded ${maxSteps} steps (possible infinite loop)`);
    }
    const node = cur;
    const d = node.data || {};
    const entry = {
      nodeId: node.id,
      type: node.type,
      name: node.name || node.type,
      status: 'running',
    };
    let port = 'default';

    try {
      // 运行期变量绑定（`expand` 的逐份实例，§12.9）：与 loop「进循环体前写
      // vars[itemVar]」同构。放在 switch 之前 ⇒ 任何节点类型都能作为片段入口
      // 承接自己的元素。
      // ⚠ 必须**逐份**绑定：所有副本共享同一个 vars，若只在 expand 里写一次，
      // N 份看到的都会是最后一个元素（一类不会报错的静默失真）。
      if (d.__bind && typeof d.__bind === 'object' && d.__bind.var) {
        vars[String(d.__bind.var)] = d.__bind.value;
      }

      switch (node.type) {
        case 'start':
          break;

        case 'end':
          entry.status = 'succeeded';
          log.push(entry);
          onLog(entry);
          return { status: 'completed', vars, log };

        case 'prompt': {
          const text = interpolate(d.prompt, vars);
          const value = extractText(await primitives.chat(text, { model: d.model || undefined }));
          if (d.outputVar) {
            vars[d.outputVar] = value;
          }
          entry.summary = truncate(value);
          break;
        }

        case 'ifElse': {
          const ok = evalCondition(d.expression, vars);
          port = ok ? 'branch-true' : 'branch-false';
          entry.summary = `条件求值 => ${ok}`;
          break;
        }

        case 'loop': {
          const st = loopState.get(node.id) || { i: 0 };
          loopState.set(node.id, st);
          const forEach = d.mode === 'forEach';
          const items = forEach && Array.isArray(vars[d.itemsVar]) ? vars[d.itemsVar] : null;
          const limit = forEach ? (items ? items.length : 0) : Number(d.count || 0);
          if (st.i < limit) {
            if (forEach && items) {
              vars[d.itemVar || 'item'] = items[st.i];
            }
            st.i += 1;
            port = 'loop-body';
            entry.summary = `迭代 ${st.i}/${limit}`;
          } else {
            port = 'loop-done';
            entry.summary = `循环完成（共 ${st.i} 次）`;
            // Reset this loop's counter once it drains. A nested or otherwise
            // re-entered loop must restart from 0 on its next entry, not see the
            // stale terminal count (the single cursor keeps the Map alive across
            // the whole run). Only ACTIVE (mid-iteration) loops stay in the Map,
            // so a pause checkpoint snapshots exactly the loops still running.
            loopState.delete(node.id);
          }
          break;
        }

        case 'toolCall': {
          const value = extractText(
            await primitives.executeTool(d.tool, resolveArgs(d.args, vars))
          );
          if (d.outputVar) {
            vars[d.outputVar] = value;
          }
          entry.summary = truncate(value);
          break;
        }

        case 'skill': {
          const value = extractText(
            await primitives.executeSkill(d.skillName, resolveArgs(d.args, vars))
          );
          entry.summary = truncate(value);
          break;
        }

        case 'subAgent': {
          const value = extractText(
            await primitives.runSubAgent({
              agentName: d.agentName,
              instructions: interpolate(d.instructions, vars),
              model: d.model || undefined,
              tools: d.tools,
              maxTurns: d.maxTurns,
            })
          );
          if (d.outputVar) {
            vars[d.outputVar] = value;
          }
          entry.summary = truncate(value);
          break;
        }

        case 'code': {
          const source = interpolate(d.source, vars);
          const value = extractText(await primitives.runCode(d.language || 'bash', source, vars));
          if (d.outputVar) {
            vars[d.outputVar] = value;
          }
          entry.summary = truncate(value);
          break;
        }

        case 'http': {
          const res = await primitives.http({
            method: d.method || 'GET',
            url: interpolate(d.url, vars),
            headers: resolveArgs(d.headers, vars),
            body: d.body ? interpolate(d.body, vars) : undefined,
          });
          if (d.outputVar) {
            vars[d.outputVar] = res;
          }
          entry.summary = truncate(extractText(res));
          break;
        }

        case 'askUserQuestion': {
          // Human-in-the-loop. If we are resuming AT this node, inject the saved
          // answer and continue. Otherwise either pause (durable checkpoint) or,
          // when pausing is not requested, auto-answer with the first option.
          if (resumeNodeId === node.id) {
            const answer = pendingAnswer == null ? '' : pendingAnswer;
            if (d.answerVar) {
              vars[d.answerVar] = answer;
            }
            entry.status = 'succeeded';
            entry.summary = `已收到回答：${truncate(answer) || '(空)'}`;
            // Checkpoint consumed — clear so later asks pause normally.
            resumeNodeId = null;
            pendingAnswer = undefined;
            break;
          }
          if (options.pauseOnAsk) {
            entry.status = 'awaiting_input';
            entry.summary = '等待用户回答';
            log.push(entry);
            onLog(entry);
            return {
              status: 'paused',
              vars,
              log,
              pause: {
                nodeId: node.id,
                question: interpolate(d.question, vars),
                options: Array.isArray(d.options) ? d.options.slice() : [],
                answerVar: d.answerVar || 'answer',
                loopState: loopStateToObj(loopState),
              },
            };
          }
          const answer = (Array.isArray(d.options) && d.options[0]) || '';
          if (d.answerVar) {
            vars[d.answerVar] = answer;
          }
          entry.status = 'skipped';
          entry.summary = `人机交互占位，自动答：${answer || '(空)'}`;
          break;
        }

        case 'expand': {
          // 动态扇出（D1 / §12.9）：把 `templateId` 指向的**片段**按 `sourceVar` 的
          // 长度内联 N 份并串成链。模板被当作片段（去 start/end）—— 原样内联会撞上
          // 「恰好一个 start」校验，连 `end` 一起内联则会因 `case 'end'` 直接 return
          // 而**终止整轮 run**（两处均已实测取证，见 expandTemplate.js 的注释）。
          const sourceVarName = d.sourceVar == null ? '' : String(d.sourceVar);
          if (!sourceVarName) {
            throw new Error('expand 需要 sourceVar（决定实例数的集合变量名）');
          }
          const items = vars[sourceVarName];
          if (!Array.isArray(items)) {
            throw new Error(
              `expand 的 sourceVar '${sourceVarName}' 必须是数组（实得 ${items === undefined ? 'undefined' : typeof items}）`
            );
          }
          const templateId = d.templateId == null ? '' : String(d.templateId);
          if (!templateId) {
            throw new Error('expand 需要 templateId（引用已存 flow；Q1 裁决只支持已审阅的 flow）');
          }
          const tpl = await primitives.loadFlow(templateId);
          const liveGraph = { nodes: [...nodes.values()], connections };
          const succ = nextNode(node.id, 'default');
          const ex = expandGraph(
            liveGraph,
            {
              expandId: node.id,
              template: tpl,
              instances: items.length,
              items,
              itemVar: d.itemVar,
              successor: succ ? succ.id : null,
            },
            { maxNodes, ...catalogCaps() }
          );
          if (!ex.ok) {
            throw new Error(`expand refused: ${ex.errors.join('; ')}`);
          }
          if (revisions + 1 > maxRevisions) {
            throw new Error(`expand exceeded MAX_REVISIONS ${maxRevisions}`);
          }
          // Audit the pre-expansion graph BEFORE mutating anything.
          const { computeGraphHash } = require('./flowRegistry');
          const beforeHash = computeGraphHash(liveGraph);
          // Commit: in-place mutation of the live view (same shape as graphPatch).
          for (const n of ex.graph.nodes) {
            if (!nodes.has(n.id)) {
              nodes.set(n.id, n);
            }
          }
          connections.length = 0;
          for (const c of ex.graph.connections) {
            connections.push(c);
          }
          outEdges.clear();
          for (const c of connections) {
            if (!outEdges.has(c.from)) {
              outEdges.set(c.from, []);
            }
            outEdges.get(c.from).push(c);
          }
          revisions += 1;
          entry.expand = {
            templateId,
            sourceVar: sourceVarName,
            itemVar: d.itemVar || 'item',
            instances: ex.copies,
            entry: ex.entry,
            exit: ex.exit,
            beforeHash,
            afterHash: computeGraphHash(ex.graph),
          };
          entry.summary =
            ex.copies === 0
              ? '动态扇出 0 份（空集合，直接退场）'
              : `动态扇出 ${ex.copies} 份（template ${templateId}）`;
          break;
        }

        case 'graphPatch': {
          // Runtime self-evolution (rule TOOLING-011 / [DESIGN-ARCH-141] D1).
          // A RESTRICTED DATA PATCH -- never code. Allowed ops are
          // addNode / connect / disconnect; **node** deletion is refused
          // outright (ruling 10-Q2, narrowed 2026-09-24: nodes forbidden,
          // edges allowed). The pure leaf validates transactionally, so a
          // rejected patch leaves the live graph byte-identical.
          //
          // The patch is either authored statically (`ops`) or read from a
          // runtime variable (`onVar`, ruling Q8) -- the latter is what makes
          // this "runtime" self-evolution rather than an authored rewrite.
          const liveGraph = { nodes: [...nodes.values()], connections };
          const patchSource = resolvePatchOps({ ops: d.ops, onVar: d.onVar, vars });
          if (!patchSource.ok) {
            throw new Error(`graphPatch refused: ${patchSource.errors.join('; ')}`);
          }
          const patch = applyPatch(liveGraph, patchSource.ops, { maxNodes, ...catalogCaps() });
          if (!patch.ok) {
            throw new Error(`graphPatch refused: ${patch.errors.join('; ')}`);
          }
          if (revisions + 1 > maxRevisions) {
            throw new Error(`graphPatch exceeded MAX_REVISIONS ${maxRevisions}`);
          }
          // Audit the pre-patch graph BEFORE mutating anything.
          const { computeGraphHash } = require('./flowRegistry');
          const beforeHash = computeGraphHash(liveGraph);
          // Commit: in-place mutation of the live view.
          for (const n of patch.graph.nodes) {
            if (!nodes.has(n.id)) {
              nodes.set(n.id, n);
            }
          }
          connections.length = 0;
          for (const c of patch.graph.connections) {
            connections.push(c);
          }
          outEdges.clear();
          for (const c of connections) {
            if (!outEdges.has(c.from)) {
              outEdges.set(c.from, []);
            }
            outEdges.get(c.from).push(c);
          }
          revisions += 1;
          // Audit rides on the node log entry, which the worker persists as
          // log_json -- durable, and zero schema change.
          entry.revision = {
            seq: revisions,
            beforeHash,
            afterHash: computeGraphHash(patch.graph),
            // Patch provenance: 'ops' or 'onVar:<name>'. Without it a
            // runtime patch and an authored one look identical in the log.
            source: patchSource.source,
            ops: patch.applied,
          };
          entry.summary = `graph rewritten +${patch.applied.length} op(s) (rev ${revisions}/${maxRevisions})`;
          break;
        }
        default:
          // Fail-closed（规则 TOOLING-011 / [DESIGN-ARCH-141] F2）：未知节点类型必须抛错。
          // 旧行为是把它标成 `skipped` 后**继续走 default 端口** —— 那会让整图以
          // status:'completed' 收尾，而那个节点什么都没做，是本仓最危险的一类静默失真
          // （日志里只有一行「未知节点类型 … 已跳过」，没有任何一处报错）。
          // 节点类型必须先在 nodeCatalog 声明、并在本 switch 实现 handler；两边漂移由
          // scripts/ci/check-workflow-node-parity.js 在 commit 档拦下。
          throw new Error(
            `未知节点类型 '${node.type}'（节点 ${node.id}）：` +
              `请先在 nodeCatalog 声明并在执行器实现 handler`
          );
      }

      if (entry.status === 'running') {
        entry.status = 'succeeded';
      }
    } catch (err) {
      entry.status = 'failed';
      entry.error = err && err.message ? err.message : String(err);
      log.push(entry);
      onLog(entry);
      const wrapped = new Error(`节点 ${node.id} (${node.type}) 执行失败: ${entry.error}`);
      wrapped.vars = vars;
      wrapped.log = log;
      throw wrapped;
    }

    log.push(entry);
    onLog(entry);
    cur = nextNode(node.id, port);

    // Quantum preemption: after executing `quantum` nodes in this segment, yield
    // with a durable checkpoint so the worker can fairly interleave other queued
    // runs and resume this one later. Yield only when more work remains (cur set);
    // the checkpoint points at the NEXT node, which on resume runs normally (a
    // quantum resume neither skips nor injects — unlike an answer resume).
    if (quantum > 0 && cur && steps >= quantum) {
      return {
        status: 'paused',
        vars,
        log,
        pause: {
          kind: 'quantum',
          nodeId: cur.id,
          loopState: loopStateToObj(loopState),
        },
      };
    }
  }

  return { status: 'completed', vars, log };
}

module.exports = {
  runGraph,
  defaultPrimitives,
  MAX_STEPS,
  // pure helpers (unit-tested)
  interpolate,
  extractText,
  evalCondition,
  resolveArgs,
  getPath,
};

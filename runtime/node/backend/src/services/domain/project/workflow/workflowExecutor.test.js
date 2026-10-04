'use strict';
// Co-located unit test for ./workflowExecutor.js — batch B31 (D2 functional-unit conformance).
// runGraph is the single-cursor DAG interpreter. Every side effect is an INJECTED
// primitive, so tests never touch chat / toolCalling / skills / http / flowRegistry
// writes. The pure helper exports (interpolate / extractText / evalCondition /
// resolveArgs / getPath) are exercised directly. No sockets, no child processes.
// The only timers are inside quantum/ask/resume control flow which the interpreter
// returns from synchronously — nothing here sleeps or polls.
// Pure node:test; async tests await already-resolved stub promises (no setTimeout).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-wf-'));
process.env.KHY_APP_HOME = TMP_HOME;
process.env.KHY_DATA_HOME = TMP_HOME;
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;

const we = require('./workflowExecutor.js');

function makePrimitives(overrides = {}) {
  const calls = [];
  const base = {
    async chat(prompt) {
      calls.push(['chat', prompt]);
      return 'CHAT:' + prompt;
    },
    async executeTool(tool, args) {
      calls.push(['tool', tool, args]);
      return { text: 'TOOL:' + tool };
    },
    async executeSkill(name, args) {
      calls.push(['skill', name, args]);
      return 'SKILL:' + name;
    },
    async runSubAgent(spec) {
      calls.push(['sub', spec]);
      return 'SUB:' + (spec.agentName || '');
    },
    async runCode(lang, src) {
      calls.push(['code', lang, src]);
      return 'CODE:' + src;
    },
    async http(req) {
      calls.push(['http', req.url]);
      return { status: 200, data: 'HTTP:' + req.url };
    },
    async loadFlow(id) {
      calls.push(['flow', id]);
      throw new Error('loadFlow not needed in this test');
    },
    calls,
  };
  return { ...base, ...overrides };
}

function graph(nodes, connections) {
  return { nodes, connections };
}

// ── surface ───────────────────────────────────────────────────────────────────

test('exported surface is exactly the documented 8 keys', () => {
  assert.deepEqual(Object.keys(we).sort(), [
    'MAX_STEPS',
    'defaultPrimitives',
    'evalCondition',
    'extractText',
    'getPath',
    'interpolate',
    'resolveArgs',
    'runGraph',
  ]);
  assert.equal(we.MAX_STEPS, 1000);
});

// ── getPath ────────────────────────────────────────────────────────────────────

test('getPath walks dotted paths, returns undefined on any miss', () => {
  assert.equal(we.getPath({ a: { b: { c: 7 } } }, 'a.b.c'), 7);
  assert.equal(we.getPath({ a: [10, 20] }, 'a.1'), 20);
  assert.equal(we.getPath({ a: { b: 1 } }, 'a.x.y'), undefined);
  assert.equal(we.getPath(null, 'a'), undefined);
  assert.equal(we.getPath({ a: 1 }, ''), undefined);
});

// ── interpolate ────────────────────────────────────────────────────────────────

test('interpolate substitutes vars, JSON-encodes objects, keeps scalars', () => {
  assert.equal(we.interpolate('hi {{name}}', { name: 'bob' }), 'hi bob');
  assert.equal(we.interpolate('{{o}}', { o: { a: 1 } }), '{"a":1}');
  assert.equal(we.interpolate('{{n}}', { n: 5 }), '5');
  assert.equal(we.interpolate(null, {}), '');
  assert.equal(we.interpolate('no braces', {}), 'no braces');
});

test('B31-W5: interpolate silently blanks an unknown variable', () => {
  // interpolate.js:69-71 — getPath returns undefined for a missing var, and the
  // nullish branch yields ''. A typo in {{var}} therefore produces an EMPTY string
  // with no diagnostic, so the run continues on a blank value (silent corruption).
  assert.equal(we.interpolate('{{nope}}!', {}), '!');
});

// ── extractText ────────────────────────────────────────────────────────────────

test('extractText normalises heterogeneous primitive returns to a string', () => {
  assert.equal(we.extractText(null), '');
  assert.equal(we.extractText('raw'), 'raw');
  assert.equal(we.extractText(42), '42');
  assert.equal(we.extractText({ text: 't' }), 't');
  assert.equal(we.extractText({ content: { deep: 1 } }), '{"deep":1}');
  assert.equal(we.extractText({ data: 'd' }), 'd');
  assert.equal(we.extractText({ finalResponse: 'f' }), 'f');
  assert.equal(we.extractText({}), '{}'); // no texty field -> JSON of the object
});

// ── evalCondition / compare ──────────────────────────────────────────────────

test('evalCondition: numeric and string comparisons never execute code', () => {
  assert.equal(we.evalCondition('3 == 3', {}), true);
  assert.equal(we.evalCondition('3 != 4', {}), true);
  assert.equal(we.evalCondition('{{n}} > 5', { n: 10 }), true);
  assert.equal(we.evalCondition('"x" == "x"', {}), true);
  assert.equal(we.evalCondition('', {}), false);
  assert.equal(we.evalCondition('0', {}), false); // number 0 is falsy
  assert.equal(we.evalCondition('false', {}), false);
  assert.equal(we.evalCondition('hello', {}), true); // bare truthy string
});

test('B31-W5: evalCondition compares two missing variables as EQUAL', () => {
  // compare.js:139 — for two undefined operands, the numeric branch is skipped
  // (NaN guard) and the fallback String(a) === String(b) yields
  // 'undefined' === 'undefined' => true. A typo in BOTH sides of an ifElse silently
  // routes down the true branch.
  assert.equal(we.evalCondition('{{missingA}} == {{missingB}}', {}), true);
});

// ── resolveArgs ────────────────────────────────────────────────────────────────

test('resolveArgs: exact {{var}} preserves type; partial strings interpolate', () => {
  assert.deepEqual(we.resolveArgs(null, {}), {});
  assert.deepEqual(we.resolveArgs('{{x}}', { x: { a: 1 } }), { a: 1 }); // object kept
  assert.equal(we.resolveArgs('{{x}}', { x: 42 }), 42); // number kept
  assert.equal(we.resolveArgs('pre {{x}} post', { x: 2 }), 'pre 2 post');
  assert.deepEqual(we.resolveArgs({ k: '{{x}}', n: [1, '{{x}}'] }, { x: 9 }), { k: 9, n: [1, 9] });
  assert.equal(we.resolveArgs(5, {}), 5); // non-object scalar passthrough
});

// ── runGraph: control flow ───────────────────────────────────────────────────

test('runGraph: start->end completes with a two-entry log', async () => {
  const p = makePrimitives();
  const r = await we.runGraph(
    graph(
      [{ id: 's', type: 'start', data: {} }, { id: 'e', type: 'end', data: {} }],
      [{ from: 's', fromPort: 'default', to: 'e', toPort: 'input' }]
    ),
    { primitives: p }
  );
  assert.equal(r.status, 'completed');
  assert.deepEqual(r.log.map((l) => l.nodeId), ['s', 'e']);
  assert.equal(r.log[1].status, 'succeeded');
});

test('runGraph: throws when there is no start node', async () => {
  await assert.rejects(
    () => we.runGraph(graph([{ id: 'e', type: 'end', data: {} }], []), { primitives: makePrimitives() }),
    /graph has no start node/
  );
});

test('runGraph: prompt node calls chat and captures outputVar', async () => {
  const p = makePrimitives();
  const r = await we.runGraph(
    graph(
      [
        { id: 's', type: 'start', data: {} },
        { id: 'pr', type: 'prompt', data: { prompt: 'hi {{who}}', outputVar: 'out' } },
        { id: 'e', type: 'end', data: {} },
      ],
      [
        { from: 's', to: 'pr', toPort: 'input' },
        { from: 'pr', to: 'e', toPort: 'input' },
      ]
    ),
    { primitives: p, vars: { who: 'x' } }
  );
  assert.equal(r.vars.out, 'CHAT:hi x');
  assert.deepEqual(p.calls[0], ['chat', 'hi x']);
});

test('runGraph: toolCall node passes resolved args through executeTool', async () => {
  const p = makePrimitives();
  const r = await we.runGraph(
    graph(
      [
        { id: 's', type: 'start', data: {} },
        { id: 't', type: 'toolCall', data: { tool: 'Bash', args: { cmd: '{{c}}' }, outputVar: 'res' } },
        { id: 'e', type: 'end', data: {} },
      ],
      [{ from: 's', to: 't' }, { from: 't', to: 'e' }]
    ),
    { primitives: p, vars: { c: 'ls' } }
  );
  assert.equal(r.vars.res, 'TOOL:Bash');
  assert.deepEqual(p.calls[0], ['tool', 'Bash', { cmd: 'ls' }]);
});

test('runGraph: ifElse routes on the true port', async () => {
  const p = makePrimitives();
  const r = await we.runGraph(
    graph(
      [
        { id: 's', type: 'start', data: {} },
        { id: 'c', type: 'ifElse', data: { expression: '{{n}} > 5' } },
        { id: 'tEnd', type: 'end', data: {} },
        { id: 'fEnd', type: 'end', data: {} },
      ],
      [
        { from: 's', to: 'c' },
        { from: 'c', fromPort: 'branch-true', to: 'tEnd' },
        { from: 'c', fromPort: 'branch-false', to: 'fEnd' },
      ]
    ),
    { primitives: p, vars: { n: 10 } }
  );
  assert.deepEqual(r.log.map((l) => l.nodeId), ['s', 'c', 'tEnd']);
});

test('runGraph: loop (count mode) iterates the body then drains', async () => {
  const p = makePrimitives();
  let bodyHits = 0;
  p.executeTool = async () => {
    bodyHits += 1;
    return { text: 'x' };
  };
  const r = await we.runGraph(
    graph(
      [
        { id: 's', type: 'start', data: {} },
        { id: 'lp', type: 'loop', data: { mode: 'count', count: 3 } },
        { id: 'b', type: 'toolCall', data: { tool: 'tick' } },
        { id: 'e', type: 'end', data: {} },
      ],
      [
        { from: 's', to: 'lp' },
        { from: 'lp', fromPort: 'loop-body', to: 'b' },
        { from: 'b', to: 'lp' }, // back-edge
        { from: 'lp', fromPort: 'loop-done', to: 'e' },
      ]
    ),
    { primitives: p }
  );
  assert.equal(bodyHits, 3);
  assert.equal(r.status, 'completed');
});

test('runGraph: unknown node type is FAIL-CLOSED (throws, never silently skips)', async () => {
  const p = makePrimitives();
  await assert.rejects(
    () =>
      we.runGraph(
        graph(
          [
            { id: 's', type: 'start', data: {} },
            { id: 'x', type: 'teleport', data: {} },
            { id: 'e', type: 'end', data: {} },
          ],
          [{ from: 's', to: 'x' }, { from: 'x', to: 'e' }]
        ),
        { primitives: p }
      ),
    /未知节点类型 'teleport'/
  );
});

test('runGraph: MAX_STEPS guard bounds a runaway cycle', async () => {
  const p = makePrimitives();
  await assert.rejects(
    () =>
      we.runGraph(
        graph(
          [
            { id: 's', type: 'start', data: {} },
            { id: 'l', type: 'loop', data: { mode: 'count', count: 999999 } },
            { id: 'b', type: 'toolCall', data: { tool: 't' } },
            { id: 'e', type: 'end', data: {} },
          ],
          [
            { from: 's', to: 'l' },
            { from: 'l', fromPort: 'loop-body', to: 'b' },
            { from: 'b', to: 'l' },
            { from: 'l', fromPort: 'loop-done', to: 'e' },
          ]
        ),
        { primitives: p, maxSteps: 10 }
      ),
    /exceeded 10 steps/
  );
});

test('runGraph: expand node applies its per-copy __bind before executing', async () => {
  const p = makePrimitives();
  const r = await we.runGraph(
    graph(
      [
        { id: 's', type: 'start', data: {} },
        { id: 'n', type: 'toolCall', data: { __bind: { var: 'row', value: 5 }, tool: 'noop', outputVar: 'seen' } },
        { id: 'e', type: 'end', data: {} },
      ],
      [{ from: 's', to: 'n' }, { from: 'n', to: 'e' }]
    ),
    { primitives: p }
  );
  assert.equal(r.vars.row, 5); // __bind written before the switch (executor.js:413)
});

// ── runGraph: human-in-the-loop + quantum ─────────────────────────────────────

test('runGraph: askUserQuestion parks when pauseOnAsk and resumes with an answer', async () => {
  const p = makePrimitives();
  const g = graph(
    [
      { id: 's', type: 'start', data: {} },
      { id: 'ask', type: 'askUserQuestion', data: { question: 'ok?', options: ['yes', 'no'], answerVar: 'ans' } },
      { id: 'e', type: 'end', data: {} },
    ],
    [{ from: 's', to: 'ask' }, { from: 'ask', to: 'e' }]
  );
  const paused = await we.runGraph(g, { primitives: p, pauseOnAsk: true });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.pause.nodeId, 'ask');
  assert.deepEqual(paused.pause.options, ['yes', 'no']);
  const done = await we.runGraph(g, { primitives: p, pauseOnAsk: true, resume: { nodeId: 'ask', answer: 'yes' } });
  assert.equal(done.status, 'completed');
  assert.equal(done.vars.ans, 'yes');
});

test('runGraph: askUserQuestion auto-answers the first option when not parking', async () => {
  const p = makePrimitives();
  const r = await we.runGraph(
    graph(
      [
        { id: 's', type: 'start', data: {} },
        { id: 'ask', type: 'askUserQuestion', data: { options: ['first'], answerVar: 'a' } },
        { id: 'e', type: 'end', data: {} },
      ],
      [{ from: 's', to: 'ask' }, { from: 'ask', to: 'e' }]
    ),
    { primitives: p }
  );
  assert.equal(r.vars.a, 'first');
  assert.equal(r.log.find((l) => l.nodeId === 'ask').status, 'skipped');
});

test('runGraph: quantum preemption yields a durable checkpoint and resumes transparently', async () => {
  const p = makePrimitives();
  const nodes = [
    { id: 's', type: 'start', data: {} },
    { id: 'c1', type: 'ifElse', data: { expression: '1 == 1' } },
    { id: 'c2', type: 'ifElse', data: { expression: '1 == 1' } },
    { id: 'e', type: 'end', data: {} },
  ];
  const conns = [
    { from: 's', to: 'c1' },
    { from: 'c1', fromPort: 'branch-true', to: 'c2' },
    { from: 'c1', fromPort: 'branch-false', to: 'e' },
    { from: 'c2', fromPort: 'branch-true', to: 'e' },
    { from: 'c2', fromPort: 'branch-false', to: 'e' },
  ];
  const g = graph(nodes, conns);
  const seg1 = await we.runGraph(g, { primitives: p, quantum: 1 });
  assert.equal(seg1.status, 'paused');
  assert.equal(seg1.pause.kind, 'quantum');
  // Yield fires right AFTER the first node (start, steps=1 >= quantum), pointing at
  // the NEXT cursor position, which is c1.
  assert.equal(seg1.pause.nodeId, 'c1');
  // Resuming with a large quantum runs c1 -> c2 -> end transparently to completion.
  const fin = await we.runGraph(g, { primitives: p, quantum: 100, resume: { nodeId: 'c1', kind: 'quantum' } });
  assert.equal(fin.status, 'completed');
  assert.deepEqual(fin.log.map((l) => l.nodeId), ['c1', 'c2', 'e']);
});

// ── runGraph: graphPatch node (runtime self-evolution) ─────────────────────────

test('runGraph: a graphPatch node commits an addNode revision and keeps flowing to end', async () => {
  const p = makePrimitives();
  const r = await we.runGraph(
    graph(
      [
        { id: 's', type: 'start', data: {} },
        { id: 'gp', type: 'graphPatch', data: { ops: [{ op: 'addNode', node: { id: 'extra', type: 'prompt' } }] } },
        { id: 'e', type: 'end', data: {} },
      ],
      [{ from: 's', to: 'gp' }, { from: 'gp', to: 'e' }]
    ),
    { primitives: p }
  );
  assert.equal(r.status, 'completed');
  const rev = r.log.find((l) => l.nodeId === 'gp').revision;
  assert.equal(rev.seq, 1);
  assert.equal(rev.source, 'ops');
  assert.equal(rev.ops[0].op, 'addNode');
  assert.equal(typeof rev.beforeHash, 'string');
  assert.notEqual(rev.beforeHash, rev.afterHash);
});

test('runGraph: a rejected graphPatch (empty ops) fails the node, never half-applies', async () => {
  const p = makePrimitives();
  await assert.rejects(
    () =>
      we.runGraph(
        graph(
          [
            { id: 's', type: 'start', data: {} },
            { id: 'gp', type: 'graphPatch', data: { ops: [] } },
            { id: 'e', type: 'end', data: {} },
          ],
          [{ from: 's', to: 'gp' }, { from: 'gp', to: 'e' }]
        ),
        { primitives: p }
      ),
    /graphPatch refused/
  );
});

// ── runGraph: expand node validation (fail-closed before any loadFlow) ──────────

test('runGraph: expand node refuses a missing sourceVar / templateId without touching loadFlow', async () => {
  const p = makePrimitives();
  let flowTouched = 0;
  p.loadFlow = async () => {
    flowTouched += 1;
    throw new Error('unreachable');
  };
  await assert.rejects(
    () =>
      we.runGraph(
        graph(
          [
            { id: 's', type: 'start', data: {} },
            { id: 'ex', type: 'expand', data: {} },
            { id: 'e', type: 'end', data: {} },
          ],
          [{ from: 's', to: 'ex' }, { from: 'ex', to: 'e' }]
        ),
        { primitives: p }
      ),
    /expand 需要 sourceVar/
  );
  assert.equal(flowTouched, 0); // validation throws before loadFlow

  await assert.rejects(
    () =>
      we.runGraph(
        graph(
          [
            { id: 's', type: 'start', data: {} },
            { id: 'ex', type: 'expand', data: { sourceVar: 'list' } },
            { id: 'e', type: 'end', data: {} },
          ],
          [{ from: 's', to: 'ex' }, { from: 'ex', to: 'e' }]
        ),
        { primitives: p, vars: { list: [1, 2] } }
      ),
    /expand 需要 templateId/
  );

  await assert.rejects(
    () =>
      we.runGraph(
        graph(
          [
            { id: 's', type: 'start', data: {} },
            { id: 'ex', type: 'expand', data: { sourceVar: 'list', templateId: 'flow1' } },
            { id: 'e', type: 'end', data: {} },
          ],
          [{ from: 's', to: 'ex' }, { from: 'ex', to: 'e' }]
        ),
        { primitives: p, vars: { list: 'not-an-array' } }
      ),
    /必须是数组/
  );
});

// ── runGraph: node failure wraps vars + log for fail-soft reporting ─────────────

test('runGraph: a failing primitive wraps the error and still exposes vars/log', async () => {
  const p = makePrimitives();
  p.chat = async () => {
    throw new Error('llm down');
  };
  await assert.rejects(
    () =>
      we.runGraph(
        graph(
          [
            { id: 's', type: 'start', data: {} },
            { id: 'pr', type: 'prompt', data: { prompt: 'x', outputVar: 'o' } },
            { id: 'e', type: 'end', data: {} },
          ],
          [{ from: 's', to: 'pr' }, { from: 'pr', to: 'e' }]
        ),
        { primitives: p }
      ),
    (err) => {
      assert.match(err.message, /节点 pr \(prompt\) 执行失败: llm down/);
      assert.ok(Array.isArray(err.log));
      assert.equal(err.vars.constructor, Object);
      return true;
    }
  );
});

'use strict';

/**
 * check-agent-feedback-evidence-storage.test.js — 存证「读得到」与「不越权认领」。
 *
 * 触发这件事的实测事实（2026-10-08）：AGENTS.md 规则 5/6/7 把存证落在
 * `works/data/khy/feedback/<task-id>/`，而 `check-agent-feedback.js` 在被文档化的
 * 调用方式下（`--changed`，没有任何调用方传 `--evidence`）读的是
 * `works/data/khy/feedback/adhoc`。那个目录**不存在**；同级却有 346 个 task-id 目录、
 * 其中 231 个带 repro-before.txt。也就是说门一直在报「缺存证」，而存证就在隔壁——
 * 这些误报同时是 S1→S2 毕业要数的样本，等于让仪器的寻址错误进入毕业判据。
 *
 * 两条判据取向相反，必须同时钉住：
 *   ① 缺失时要点名「同级有同名存证、最新在哪」，否则下次还得猜；
 *   ② 绝不因为同级存在就改判为「齐了」——那会让任意一条历史样本替本次改动签字，
 *      把「门看不见」升级成「门恒绿」，比误报更糟。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const CHECKER = path.join(REPO, 'scripts', 'ci', 'check-agent-feedback.js');

// 一条「合格」的五问存证：每条回答 >40 字且带 source 出处。
const FIVE_Q = [
  '# 需求五问',
  '### Q1 谁用？',
  '唯一维护者本人，他在同一台机器上跑 khy 的自动选路；回答来自其原话而非推测。',
  'source: 「希望把 khyos 的 auto 模式拆成 auto、极致、性能、经济几个模式」',
  '### Q2 什么时候用？',
  '每次请求进入网关选路时读取当前档位，并据此决定能力下界与上界，不在别的入口生效。',
  'source: 「希望把 khyos 的 auto 模式拆成 auto、极致、性能、经济几个模式」',
  '### Q3 现在的替代做法是什么？',
  '现状只有一个 auto 档加手工钉渠道，降本与质量无法同时表达，因此必须新增档位而非沿用旧路径。',
  'source: 「智能路由怎么做」',
  '### Q4 成功长什么样？',
  '命令 npm run test:routing-185 全绿，且 khy gateway status 能显示本次档位与选中模型的原因行。',
  'source: 「先把现有结论整理成完整设计方案」',
  '### Q5 不做会怎样？',
  '不做则四档语义全部落在 auto 内部，降本与质量权衡无处表达，账单读数继续无法归因到档位。',
  'source: 「自我对抗式实现这个方案」',
].join('\n');

function _fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-evidence-'));
  const task = path.join(root, 'task-A');
  fs.mkdirSync(task, { recursive: true });
  fs.writeFileSync(path.join(task, 'requirement-5q.md'), FIVE_Q, 'utf8');
  return { root, task };
}

function _run(evidenceDir) {
  return execFileSync(
    process.execPath,
    [
      CHECKER,
      '--files=A:runtime/node/backend/src/services/gateway/routeDemand.js',
      '--say=帮我新增一个四档模式与智能路由方案',
      `--evidence=${evidenceDir}`,
    ],
    { cwd: REPO, encoding: 'utf8' }
  );
}

test('存证缺失时点名同级同名存证，但绝不据此改判为齐全', () => {
  const { root } = _fixture();
  const out = _run(path.join(root, 'adhoc')); // 该目录不存在，同级 task-A 里有合格存证

  assert.match(
    out,
    /build-without-questions/,
    `同级有存证也不许把本次 BUILD 判成齐全（那等于让历史样本替本次改动签字）:\n${out}`
  );
  assert.match(
    out,
    /同级另有 1 个 task-id 目录存在 requirement-5q\.md（最新：task-A）/,
    `缺存证时必须说出「它可能在别处」:\n${out}`
  );
  assert.match(out, /门默认读 .*adhoc.*，本次任务若已写存证请加 --evidence/, `没给出可执行的下一步:\n${out}`);
});

test('存证就在被指定的目录里时：判为齐全，且不得出现同级提示', () => {
  const { task } = _fixture();
  const out = _run(task);
  assert.match(out, /客户满意|无违规|Summary: 0 error\(s\), 0 warning/, `指对了目录仍报警:\n${out}`);
  assert.doesNotMatch(out, /同级另有/, `存证齐全时不该再多嘴:\n${out}`);
});

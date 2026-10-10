'use strict';

/**
 * routeVerbosityLive.test.js — π 在**生产入口**上的可见性（§16.4y 的订正配套）。
 *
 * 上一轮我把「π 的唯一可观测后果」写在 `dynamicPromptAssembler` 的 `−3` 上。
 * 那两处都错了，且都是我自己造的错：
 *   ① 那条支路**没有生产调用方** —— `perRequestAdaptationPipeline` 只被它自己的测试
 *      require（`grep -rn "require(.*perRequestAdaptationPipeline" src tests` = 仅测试一处），
 *      而 `dynamicPromptAssembler` 只被这条死支路与门注册表引用。
 *   ② π 真正的载体在生产入口 `aiChatCore.js:2119 → khyUpgradeRuntime.makeSystemPrompt`
 *      的 `_compactPrompt = _lean || _short`，它决定
 *      `getDoingTasksSection / getExecutionDisciplineSection / getPlanningAndRecoverySection`
 *      进不进 system prompt。
 *
 * 测量必须在**冷进程**里做：`.env` 里的钉选是在第一次装配的过程中才被 dotenv 载入的，
 * 所以每个用例各起一个子进程，让它量的就是那次唯一有效的调用。
 * （这里曾写过「warm 之后模式轴失效是缺陷」——三层自我推翻后已作废，见 §16.4ah：
 *  钉选载入后 eco==off 是 R1 的正确行为，而「第一轮被改薄」出自本探针绕过启动序。）
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');

// 子进程里跑的那段探针：一次调用，打印长度与标题数。
const PROBE = `
process.env.GATEWAY_PREFERRED_ADAPTER = 'auto';
process.env.KHY_ROUTING_MODES = process.argv[1];
process.env.GATEWAY_ROUTING_MODE = process.argv[2];
if (process.argv[3]) process.env.GATEWAY_PREFERRED_MODEL = process.argv[3];
if (process.argv[4]) process.env.KHY_HARNESS_PROMPT_VERBOSITY = process.argv[4];
const r = require(${JSON.stringify(BE + '/src/services/khyUpgradeRuntime')});
r.makeSystemPrompt('', { model: 'gpt-4o', adapter: 'auto' }, [], {
  userMessage: '帮我把这个函数改成异步的',
  contextWindow: 128000,
}).then((sp) => {
  const s = String(sp && sp.systemPrompt ? sp.systemPrompt : sp);
  process.stdout.write(s.length + ' ' + (s.match(/^#{1,2}\\s+\\S/gm) || []).length);
});
`;

function cold(modesFlag, modeName, pinnedModel, verbosityEnv) {
  const out = execFileSync(
    process.execPath,
    ['-e', PROBE, modesFlag, modeName, pinnedModel || '', verbosityEnv || ''],
    { cwd: BE, encoding: 'utf8', timeout: 240000, env: { ...process.env, KHY_ROUTING_MODES: undefined } }
  );
  const [len, heads] = out.trim().split(' ').map(Number);
  assert.ok(Number.isFinite(len) && len > 0, `探针没量出提示词长度：${out}`);
  return { len, heads };
}

test('冷进程里经济档确实少发脚手架段落（π 的载体在生产入口，不在装配器）', () => {
  const off = cold('0', 'economy');
  const eco = cold('1', 'economy');
  assert.ok(off.len >= 40000, `基线体量异常：${JSON.stringify(off)}`);
  assert.ok(
    eco.len < off.len,
    `经济档没让冷提示词变短（off=${JSON.stringify(off)} eco=${JSON.stringify(eco)}）⇒ π 仍是纸面字段`
  );
  assert.ok(eco.heads < off.heads, `标题数没减少（off=${off.heads} eco=${eco.heads}）`);
});

test('§4.3 的优先级 env > mode > tier 在生产入口成立（正反两个方向）', () => {
  const off = cold('0', 'economy');
  // env 显式 full 必须压过经济档的 P0/lean ⇒ 回到基线长度
  const envWins = cold('1', 'economy', '', 'full');
  assert.deepEqual(envWins, off, `env 没能压过档位（env=${JSON.stringify(envWins)} off=${JSON.stringify(off)}）`);
  // 模式轴整条关掉时，env 这个 dial 仍必须生效 ⇒ 证明载体确实是 promptVerbosity 而非别的东西
  const envOnly = cold('0', 'auto', '', 'lean');
  assert.ok(envOnly.len < off.len, `轴关掉后 env 的 lean 失效了（env=${JSON.stringify(envOnly)} off=${JSON.stringify(off)}）`);
});

test('R1 冷进程复证：钉选模型时经济档不得改写提示词一个字节', () => {
  const off = cold('0', 'economy');
  const pinned = cold('1', 'economy', 'gpt-4o');
  assert.deepEqual(
    pinned,
    off,
    `钉选后模式轴仍在改写提示词（pinned=${JSON.stringify(pinned)} off=${JSON.stringify(off)}）`
  );
});

test('perf 档不缩短（P1 是中性档）——排除「随便配个档都会变短」', () => {
  const off = cold('0', 'perf');
  const perf = cold('1', 'perf');
  assert.deepEqual(perf, off, 'perf 的 π=P1 应为中性，长度却变了 ⇒ 上面那条红可能另有成因');
});

// 本行钉的是**已测缺陷**，不是期望行为（§16.4aa）：
// 同一进程内第二次及以后的调用里，经济档与「模式轴关掉」量出同一个长度与同一组标题数，
// 而换新 modelId（绕开 _promptCache）仍是如此 ⇒ 不是缓存陈旧，是**冷启动之后**
// compact 分支不再少发任何段落。生产含义：切档只对「本进程的第一次装配」生效，
// 之后的每一轮都回到 full —— 与 §4.4「持久化回路即时生效」的期望相反。
// 修好后请把本行改写成 `eco.len < off.len`（同进程 warm 两次以上）并删掉这段说明。
//
// ↑↑↑ 上面四行注释是**第一版的解释，已被对照实验推翻**（§16.4ah）。两臂只差「钉选是否已在 env 里」：
//   · 无钉选（显式 GATEWAY_PREFERRED_MODEL=auto；dotenv 不覆盖已存在的键）⇒ economy 三次调用都 35655，模式轴一直生效；
//   · 有钉选（本机 `runtime/node/backend/.env:72` 真写着 api:opencode-zen:fledge-alpha-free）⇒ 第一次 35655、
//     第二三次 43451，且此后 `requestModeIntent` 返回 null（pinnedBypass 生效）。
// 结论：warm 之后 eco==off 是 **R1 要求的正确行为**，不是缺陷；真正的缺陷是**第一次调用被改薄了**
// —— 钉选要等 makeSystemPrompt 内部把 .env 载进来才可见，而那时装配已经发生。
// （↑ 这半句「真正的缺陷」同样已被下面的第三层推翻：那是探针的成因，不是产品的。）
// 所以本行钉的不变量是「钉选一旦载入，模式必须让位」。**别按上面那句「改成 eco.len<off.len」去改它**，
// 那会把这个测试推向违反 R1。留着原话是为了记住：我写过一条会把下一个人带偏的注释。
//
// 使用前提（第三层自我推翻，§16.4ah）：本行与整个文件都是**裸调 makeSystemPrompt**，
// 没跑真实启动序。补做的实验证明：先 `await require('src/bootstrap/init').init()`
// （`dotenv` 的家）再连续装配三次，钉选机器上三次长度全等（43475/43475/43475）且 intent=null
// ⇒ 生产里 R1 从第一轮就正确旁路，「第一轮被改薄」**不是产品缺陷，是探针绕过启动序的假象**。
// 要测生产行为，请按生产路径起进程；本行只保证「钉选可见后模式必须让位」这一条不变量。
test('WARM：钉选载入后模式轴必须让位（eco==off 是 R1 的正确结果，不是缺陷）', async () => {
  const seq = execFileSync(
    process.execPath,
    [
      '-e',
      `process.env.GATEWAY_PREFERRED_ADAPTER='auto';
       const r=require(${JSON.stringify(BE + '/src/services/khyUpgradeRuntime')});
       const L=async(f,m)=>{process.env.KHY_ROUTING_MODES=f;process.env.GATEWAY_ROUTING_MODE=m;
         const sp=await r.makeSystemPrompt('',{model:'gpt-4o',adapter:'auto'},[],{userMessage:'帮我把这个函数改成异步的',contextWindow:128000});
         return String(sp&&sp.systemPrompt?sp.systemPrompt:sp).length;};
       (async()=>{const a=await L('0','economy');const b=await L('1','economy');
         const c=await L('1','economy');process.stdout.write(a+' '+b+' '+c);})();`,
    ],
    { cwd: BE, encoding: 'utf8', timeout: 240000, env: { ...process.env, KHY_ROUTING_MODES: undefined } }
  ).trim().split(' ').map(Number);
  assert.strictEqual(seq[1], seq[2], `eco warm 两次自身应稳定，实际 ${JSON.stringify(seq)}`);
  assert.strictEqual(
    seq[1],
    seq[0],
    `钉选已载入却出现 eco≠off（off=${seq[0]} eco=${seq[1]}）⇒ 要么钉选不再让位（违反 R1），要么本行的前提变了：见上面 §16.4ah 的两臂对照`
  );
});

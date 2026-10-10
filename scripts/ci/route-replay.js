'use strict';

/**
 * route-replay — 路由记录离线重放（[DESIGN-ARCH-185] §6.3）。
 *
 * 只读：读 works/data/khy/ruleguard/auto-route.jsonl，按 turnId 把
 * select / failure / outcome 三类样本连成一轮，输出档位分布、实测成本、
 * 价格覆盖率、软失败数，以及**三条退化基线的反事实对照**（判据 A9/A10）。
 * 绝不重跑任何模型调用。
 *
 * 为什么必须存在：§10 的 S1→S2→S3 全部毕业判据都以这份记录流为唯一证据。
 * 工具一旦没人跑，所有判据自动变成不可执行 —— 而且不会有任何守卫变红
 * （vLLM semantic-router 的 evaluation.py 就是这个下场：文件在，CI 里没有）。
 * 所以本文件被 package.json 的 check:route-replay 引用，并被 check:wiring 看见。
 *
 * ⚠ 空样本绝不报绿：读到 0 条可 join 的轮次时，输出 GAP 并说明「判据不可执行」，
 *   而不是打印一堆 0% 然后 exit 0 装作体检通过。
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_LEDGER = path.join('works', 'data', 'khy', 'ruleguard', 'auto-route.jsonl');
const TIER_IDX = { T0: 0, T1: 1, T2: 2, T3: 3 };

// 升档阈值与触发器名册都取**档位卡**，不在这里抄数字或抄档名：抄了就有第二份真源，
// 卡改了而这里没改，报表会安静地按旧口径分类（§16.4aj 刚为同一形态修过一次硬编码档名）。
// 读不到就返回 null ⇒ 只报分布、不报「低于阈值」数，并在行里说实话。
function _card() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'runtime', 'node', 'backend', 'config', 'models', 'routing-modes.json'), 'utf8')
    );
  } catch {
    return null;
  }
}

function _marginThresholdOf(card) {
  const t = card && card.thresholds && card.thresholds.marginUpgrade;
  const v = t && typeof t === 'object' ? t.value : t;
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

function _marginThreshold() {
  return _marginThresholdOf(_card());
}

function _arg(name, dflt) {
  // `--name value` 与 `--name=value` 都必须生效：只认前者时 `--require-samples=20` 被静默忽略、
  // 回落到默认 0 ⇒ 阈值根本没设上，输出里连「未达标」那一行都不出现，rc 也照旧。
  // 文档 §21 给的就是 `=` 形态，所以那条「带阈值的毕业判据」此前从未真正生效过。
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq !== undefined) return eq.slice(`--${name}=`.length);
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const next = process.argv[i + 1];
  if (!next || next.startsWith('--')) return true;
  return next;
}

function _readLedger(file) {
  const rows = [];
  const bad = { unparsable: 0, noTurnId: 0, v0: 0 };
  try {
    if (!fs.existsSync(file)) return { rows, bad, missing: true };
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        bad.unparsable += 1;
        continue;
      }
      if (o.v === undefined) bad.v0 += 1;
      if (!o.turnId) bad.noTurnId += 1;
      rows.push(o);
    }
  } catch (e) {
    return { rows: [], bad: { ...bad, readError: e.message }, missing: true };
  }
  return { rows, bad, missing: false };
}

/** 按 (pid,turnId) 把事件拼成轮。无 turnId 的旧样本单独计数，不假装能连上。 */
function _joinTurns(rows) {
  const turns = new Map();
  let orphan = 0;
  for (const r of rows) {
    if (!r.turnId) {
      orphan += 1;
      continue;
    }
    const key = `${r.pid || 'na'}|${r.turnId}`;
    if (!turns.has(key)) turns.set(key, { turnId: r.turnId, pid: r.pid || null });
    const t = turns.get(key);
    if (r.ev === 'select') t.select = r;
    else if (r.ev === 'outcome') t.outcome = r;
    else if (r.ev === 'failure') (t.failures = t.failures || []).push(r);
  }
  return { turns: Array.from(turns.values()), orphan };
}

function _pct(n, d) {
  return d > 0 ? `${((100 * n) / d).toFixed(1)}%` : 'n/a';
}

function main() {
  const file = _arg('file', null)
    ? path.resolve(String(_arg('file', '')))
    : path.join(REPO_ROOT, DEFAULT_LEDGER);
  const asJson = process.argv.includes('--json');
  const requireSamples = Number(_arg('require-samples', 0)) || 0;

  const { rows, bad, missing } = _readLedger(file);
  const { turns, orphan } = _joinTurns(rows);

  const withSelect = turns.filter((t) => t.select);
  const withOutcome = turns.filter((t) => t.outcome);
  const joinable = turns.filter((t) => t.select && t.outcome);

  const report = {
    ledger: path.relative(REPO_ROOT, file).replace(/\\/g, '/'),
    missing,
    rows: rows.length,
    bad,
    orphanRowsNoTurnId: orphan,
    // 原始行按 ev 的构成。它存在的唯一理由是分母的解释权：真账本现在是
    // 24 行 **全部 ev=failure**（零 select），此时「可 join 0」和「能力门槛 0 次」
    // 说的是「这一类样本压根没写进来」，不是「写进来了但配不成对」。
    // 不给构成，读的人只能在两种完全不同的成因之间猜。
    evCensus: (() => {
      const c = {};
      for (const r of rows) c[r.ev || '(none)'] = (c[r.ev || '(none)'] || 0) + 1;
      return c;
    })(),
    turns: turns.length,
    withSelect: withSelect.length,
    withOutcome: withOutcome.length,
    joinable,
    byMode: {},
    tierDist: {},
    demandTierAgreement: { agree: 0, disagree: 0 },
    cost: { pricedTurns: 0, unknownPriceTurns: 0, usd: 0 },
    escalated: 0,
    softFail: 0,
    // §15-2 的读数侧：四道 pass 有没有真的看到执行状态。
    // unknown 单列出来，因为 `stateInputs` 是后加的字段 —— 老样本没有它，
    // 把「字段缺席」和「算过且确实只有主诉」混成一格，会让人以为覆盖度已知。
    stateCoverage: { withSignals: 0, queryOnly: 0, unknown: 0 },
    // §8-⑦ 的读数侧：能力门槛这一条到底有没有在真实流量上被触发过。
    // 与 stateCoverage 同一套纪律：`capability` 键**缺席**（老样本）不等于
    // `capability === null`（算过、本轮无能力要求）—— 混在一起会把「没测」读成「没触发」。
    capabilityCoverage: { required: 0, blocked: 0, dropped: 0, unknownKept: 0, noRequirement: 0, absentField: 0 },
    // §5.2 的 β 载体读数：档位声明了思考档，但唯一消费者只在 `reasoning_effort==='auto'`
    // 的请求上运行。`notCarried` 就是「这一档想要思考预算，而这条请求没有载体」的计数 ——
    // 它非零说明 β 目前是纸面 dial，不是一句「已生效」。
    betaCarrier: { declared: 0, carried: 0, notCarried: 0, absentField: 0 },
    // 失败观测此前是「join 结构里收起来了、但没有任何一行读它」（`t.failures` 零消费方）。
    // 两个数必须分开报：真账本 24 行 failure 全是接线前的 v0（无 turnId），
    // 只报总量像「失败很多」，只报可归属的像「零失败」，两个都不是事实。
    failures: { total: 0, attached: 0, byType: {} },
    // A5「同一任务连打 N 轮 ⇒ 跨档切换次数如实上报」此前**没有任何读数**，
    // 而 §11 的 A5 命令写的是 `--batch <20 条真实任务>` —— 本工具从来没有这个开关
    // （`grep -c batch route-replay.js` = 0）。粘滞是刻意不做的（卡内 stickyTier.enabled=false），
    // 所以这里**只报数、不做判据**：切换次数高不等于错，低也不等于对。
    switches: { sessions: 0, turns: 0, switches: 0, maxPerSession: 0 },
    // §5.5 的 lowMargin 升档触发器要的是「top1−top2 的差」，margin 早就写进样本行
    // （`autoModelRouting.js` 的投影里 `margin` 一直在），但**这份报表从不读它** ⇒
    // 写了等于没读，而 §14-D3（阈值 0.1 到底该是多少）唯一缺的就是它的分布。
    // 与 stateCoverage/capabilityCoverage 同一套纪律：字段**缺席**（老样本）≠ 值为 **null**
    // （算过但走的是离散排序，没有差值）—— 混成一格会把「没测」读成「测过且都不低」。
    margin: { present: 0, nullValue: 0, absentField: 0, low: 0, sum: 0 },
    marginThreshold: null,
    // §5.5 的四个触发器（`lowMargin`/`underRoutingSafety`/`verifyFailed`/`irreversibleWrite`）
    // 此前只有一个总数：`升档 N`。总数说不了话 —— 0 次到底是「条件没满足」
    // 还是「输入压根没有生产方」（§14-D9/D10），必须按**声明名册逐条**报命中。
    reasons: {},
    reasonFieldAbsent: 0,
    declaredTriggers: [],
    // 档位卡 `flag_rules._note` 自己写着：「calibration=uncalibrated：误报率未量，
    // route-replay 上线后第一件事就是量这个」。而本文件此前 `grep flags` **命中 0**
    // ——承诺在卡里，读数没人做。样本侧一直有 `demand.flags`（autoModelRouting.js:675），
    // 缺的只是消费方。这里补的是**相关性读数**（命中 flag 的轮 vs 没命中的轮），
    // 不是因果结论：flag 命中与任务难度混在一起，误报率的最终判定仍需人看。
    flags: { rowsWithFlags: 0, rowsWithout: 0, fieldAbsent: 0, byFlag: {} },
    flagSplit: { on: { n: 0, ok: 0, usd: 0, priced: 0 }, off: { n: 0, ok: 0, usd: 0, priced: 0 } },
    gaps: [],
  };

  const card = _card();
  report.marginThreshold = _marginThresholdOf(card);
  // 名册来自卡（逐档 escalateOn 去重），不是脚本里抄的四个名字。
  report.declaredTriggers = Array.from(
    new Set(
      Object.values((card && card.modes) || {}).flatMap((m) => (m && Array.isArray(m.escalateOn) ? m.escalateOn : []))
    )
  );

  if (missing || rows.length === 0) {
    report.gaps.push('账本不存在或为空：所有判据（A2/A5/A6/A9/A10）不可执行');
  } else if (joinable.length === 0) {
    report.gaps.push(
      `有 ${rows.length} 行样本但**零轮可 join**（select∧outcome 同时存在的轮次为 0）`
      + ' —— 成本/成功率类判据不可执行。若 select 全是 v0（无 turnId），说明 P3 接线后还没有新流量。'
    );
  }

  for (const t of joinable) {
    const s = t.select;
    const o = t.outcome;
    const mode = s.mode || 'unlabelled';
    report.byMode[mode] = report.byMode[mode] || { turns: 0, ok: 0, fail: 0, usd: 0, priced: 0, strong: 0, target: null, targetSeen: 0 };
    const m = report.byMode[mode];
    m.turns += 1;
    if (o.ok) m.ok += 1;
    else m.fail += 1;
    if (typeof o.costUSD === 'number') {
      m.usd += o.costUSD;
      m.priced += 1;
      report.cost.pricedTurns += 1;
      report.cost.usd += o.costUSD;
    } else {
      report.cost.unknownPriceTurns += 1;
    }
    // flag_rules 的「误报」在这里只有相关性可读：命中 flag 的轮 vs 没命中的轮，
    // 各自的 ok 率与均价。判定权仍在人（词表把「简单问答」升成重档，
    // 表现为 on 侧更贵而 ok 率不更高 —— 读数只负责让这件事看得见）。
    {
      const fl = s.demand && Array.isArray(s.demand.flags) ? s.demand.flags : null;
      if (fl !== null) {
        const b = fl.length ? report.flagSplit.on : report.flagSplit.off;
        b.n += 1;
        if (o.ok) b.ok += 1;
        if (typeof o.costUSD === 'number') { b.usd += o.costUSD; b.priced += 1; }
      }
    }

    const tier = (s.rec && s.rec.tier) || (o.picked && o.picked.tier) || null;
    if (tier) report.tierDist[tier] = (report.tierDist[tier] || 0) + 1;
    // §5.4：strongShare 是档卡里的**目标占比**（约多少轮次落在 T0/T1），实测占比只有从
    // 样本里数出来才算存在。两者的差是 λ 反解的输入 —— 没有实测这一半，目标只是愿望。
    // 必须排在 `tier` 定义之后：先前把它写在上面，`tier` 还在 TDZ 里就用了（自误，已挪）。
    if (tier === 'T0' || tier === 'T1') m.strong += 1;
    if (Number.isFinite(s.strongTarget)) {
      m.target = s.strongTarget;
      m.targetSeen += 1;
    }
    if (s.softFail) report.softFail += 1;
    if (s.escalatedFrom) report.escalated += 1;
    // §15-2 读数：这一轮的判断里到底有没有执行状态。字段缺席算 unknown（老样本），
    // 不与 queryOnly 混计 —— 否则「没测」会被读成「测过且只有主诉」。
    const si = s.demand && s.demand.stateInputs;
    if (si && typeof si === 'object' && typeof si.queryOnly === 'boolean') {
      if (si.queryOnly) report.stateCoverage.queryOnly += 1;
      else report.stateCoverage.withSignals += 1;
    } else {
      report.stateCoverage.unknown += 1;
    }
    // 反事实一致性：四道 pass 解出的 tier 与实际落到的 tier 是否一致
    if (s.demand && s.demand.tier && tier) {
      if (s.demand.tier === tier) report.demandTierAgreement.agree += 1;
      else report.demandTierAgreement.disagree += 1;
    }
  }

  // §8-⑦ 读数：能力门槛在**所有 select 行**上统计，不缩到可 join 子集 ——
  // 「这一轮有没有因为不识图而拒绝改道」与「这一轮有没有回写 outcome」是两件无关的事，
  // 用 joinable 当分母会让缺 outcome 的渠道看起来从没触发过。
  for (const r of rows) {
    if (r.ev !== 'select') continue;
    if (!Object.prototype.hasOwnProperty.call(r, 'capability')) {
      report.capabilityCoverage.absentField += 1;
      continue;
    }
    const cp = r.capability;
    if (!cp || !cp.required) {
      report.capabilityCoverage.noRequirement += 1;
      continue;
    }
    report.capabilityCoverage.required += 1;
    if (cp.blocked) report.capabilityCoverage.blocked += 1;
    if (Number.isFinite(cp.dropped)) report.capabilityCoverage.dropped += cp.dropped;
    if (Number.isFinite(cp.unknown)) report.capabilityCoverage.unknownKept += cp.unknown;
  }
  // β 载体单独一遍循环： capability 那趟对「无能力要求」的行 continue 掉了，
  // 把 β 挂在它后面就会系统性漏计大多数行（仪器可见性同一族的病）。
  for (const r of rows) {
    if (r.ev !== 'select') continue;
    const bt = r.beta;
    if (!Object.prototype.hasOwnProperty.call(r, 'beta')) {
      report.betaCarrier.absentField += 1;
    } else if (bt && bt.declared && bt.declared !== 'auto') {
      report.betaCarrier.declared += 1;
      if (bt.carried) report.betaCarrier.carried += 1;
      else report.betaCarrier.notCarried += 1;
    }
    // margin 三格分开（缺席 / 值为 null / 有差值），与 β 同一趟循环：
    // 它是 §5.5 lowMargin 与 §14-D3 阈值的**唯一**实测输入，此前写了没人读。
    if (!Object.prototype.hasOwnProperty.call(r, 'margin')) report.margin.absentField += 1;
    else if (r.margin === null || r.margin === undefined) report.margin.nullValue += 1;
    else if (Number.isFinite(r.margin)) {
      report.margin.present += 1;
      report.margin.sum += r.margin;
      if (report.marginThreshold !== null && r.margin < report.marginThreshold) report.margin.low += 1;
    }
    // 触发器命中逐条数：`escalateReason` 是 rank 写进样本的字符串（§5.5）。
    // 键缺席 = 老样本没这个字段（与「算过但本轮没升档」的 null 分开，同一套三格纪律）。
    if (!Object.prototype.hasOwnProperty.call(r, 'escalateReason')) report.reasonFieldAbsent += 1;
    else if (typeof r.escalateReason === 'string' && r.escalateReason) {
      report.reasons[r.escalateReason] = (report.reasons[r.escalateReason] || 0) + 1;
    }
    // flag_rules 命中：`demand` 整块缺席（pass 未接入 / 老样本）与「接入了但没命中任何 flag」
    // 必须分开——后者是词表漏判的证据，前者只是没测。
    if (!r.demand || typeof r.demand !== 'object') report.flags.fieldAbsent += 1;
    else if (Array.isArray(r.demand.flags) && r.demand.flags.length > 0) {
      report.flags.rowsWithFlags += 1;
      for (const f of r.demand.flags) {
        const key = String(f && typeof f === 'object' ? (f.flag || f.name || JSON.stringify(f)) : f);
        report.flags.byFlag[key] = (report.flags.byFlag[key] || 0) + 1;
      }
    } else report.flags.rowsWithout += 1;
  }

  for (const r of rows) {
    if (r.ev !== 'failure') continue;
    report.failures.total += 1;
    const t = String(r.errorType || '(none)');
    report.failures.byType[t] = (report.failures.byType[t] || 0) + 1;
  }
  for (const t of turns) {
    if (t.failures) report.failures.attached += t.failures.length;
  }

  // A5 跨档切换：按 (pid, sessionId) 分组、按 turnId 尾号排序，数相邻两轮 tier 变了几个次。
  // 单独一趟循环，且**不挂在 joinable 上**：切换与否与「这一轮有没有回写 outcome」无关，
  // 挂在可 join 子集会缺计大多数轮次（capability 那趟已经教过这个教训）。
  {
    const bySession = new Map();
    for (const r of rows) {
      if (r.ev !== 'select' || !r.turnId) continue;
      const parts = String(r.turnId).split(':');
      if (parts.length < 3) continue;
      const seq = Number(parts[parts.length - 1]);
      const sid = `${parts[0]}|${parts.slice(1, -1).join(':')}`;
      const tier = (r.rec && r.rec.tier) || null;
      if (!Number.isFinite(seq) || !tier) continue;
      if (!bySession.has(sid)) bySession.set(sid, []);
      bySession.get(sid).push({ seq, tier });
    }
    for (const [, list] of bySession) {
      list.sort((a, b) => a.seq - b.seq);
      report.switches.sessions += 1;
      report.switches.turns += list.length;
      let sw = 0;
      for (let i = 1; i < list.length; i++) if (list[i].tier !== list[i - 1].tier) sw += 1;
      report.switches.switches += sw;
      if (sw > report.switches.maxPerSession) report.switches.maxPerSession = sw;
    }
  }

  // ── A9/A10：退化基线反事实 ──────────────────────────────────────────────
  // 用同一批可 join 的轮次，问「若恒钉最强 / 恒钉最弱 / 恒钉中档，成本与成功率会怎样」。
  // 只有 priced 轮次参与成本比较：unknown 的成本是 null，把它当 0 会系统性高估省钱幅度。
  const baselines = {};
  if (joinable.length > 0) {
    const priced = joinable.filter((t) => typeof t.outcome.costUSD === 'number');
    const okRateOf = (list) => (list.length ? list.filter((t) => t.outcome.ok).length / list.length : null);
    const usdOf = (list) => list.reduce((a, t) => a + (t.outcome.costUSD || 0), 0);
    const tierOf = (t) => (t.select.rec && t.select.rec.tier) || null;
    const byTierIdx = (i) => priced.filter((t) => TIER_IDX[tierOf(t)] === i);
    const all = { n: priced.length, ok: okRateOf(priced), usd: usdOf(priced) };
    baselines.actual = all;
    for (const tier of ['T0', 'T1', 'T2', 'T3']) {
      const sub = byTierIdx(TIER_IDX[tier]);
      baselines[`pinned-${tier}`] = {
        n: sub.length,
        ok: okRateOf(sub),
        usd: usdOf(sub),
        note: sub.length === 0 ? '该档无样本，无法作为基线对照' : '',
      };
    }
    // rank0 = 恒最强、rank-last = 恒最弱：这两个是最容易被忘掉的对照
    const r0 = baselines['pinned-T0'];
    const rl = baselines['pinned-T3'];
    if (!r0.n || !rl.n) {
      report.gaps.push(
        'A9 退化基线不完整：rank0(恒 T0) 或 rank-last(恒 T3) 无样本，'
        + '「路由优于固定策略」这一命题目前不可证伪'
      );
    }
    if (all.n === 0) {
      report.gaps.push('A10 不可执行：可 join 轮次里没有任何 priced 轮（价格覆盖率 0）');
    }
  }
  report.baselines = baselines;

  if (report.cost.pricedTurns === 0 && joinable.length > 0) {
    report.gaps.push('成本轴全空：所有轮次的 priceState 都不可用，λ 依 §5.4 必须退出');
  }

  report.graduation = {
    s1Target: 200,
    observed: joinable.length,
    ready: joinable.length >= 200 && report.gaps.length === 0,
  };
  if (requireSamples > 0 && joinable.length < requireSamples) {
    report.gaps.push(`--require-samples=${requireSamples} 未达标（实际 ${joinable.length}）`);
  }

  if (asJson) {
    process.stdout.write(JSON.stringify({ ...report, joinable: undefined, turns: joinable }, null, 2) + '\n');
  } else {
    const lines = [];
    lines.push(`账本: ${report.ledger}${report.missing ? '  (不存在或为空)' : ''}`);
    lines.push(`行数 ${report.rows}｜无 turnId ${report.orphanRowsNoTurnId}｜坏行 ${report.bad.unparsable || 0}｜v0 旧格式 ${report.bad.v0 || 0}｜ev 构成 ${JSON.stringify(report.evCensus)}`);
    lines.push(`轮次 ${report.turns}｜有 select ${report.withSelect}｜有 outcome ${report.withOutcome}｜**可 join ${joinable.length}**`);
    lines.push(`档位分布: ${JSON.stringify(report.tierDist)}`);
    lines.push(`demand 与实际档位一致: ${report.demandTierAgreement.agree} / 不一致 ${report.demandTierAgreement.disagree}`);
    lines.push(`成本: priced 轮 ${report.cost.pricedTurns}, 价格不可知轮 ${report.cost.unknownPriceTurns}, 合计 ${report.cost.usd.toFixed(5)} USD`);
    lines.push(`软失败 ${report.softFail}｜升档 ${report.escalated}`);
    const sc = report.stateCoverage;
    const scTotal = sc.withSignals + sc.queryOnly + sc.unknown;
    lines.push(
      `执行状态覆盖（仅可 join 轮，分母 ${scTotal}）: 有执行状态 ${sc.withSignals}` +
      `｜只有主诉 ${sc.queryOnly}｜字段缺席 ${sc.unknown}`
    );
    // 与 A6/λ 退出同款纪律：拿不到数的时候不许报绿，报 GAP。
    if (scTotal > 0 && sc.unknown === scTotal) {
      report.gaps.push(
        `§15-2 不可判定：${scTotal} 行全都缺 stateInputs（P3 接线前写入的老样本或写手未落该字段）`
        + ' —— 「不做 query 级路由」这件事现在没有任何数据能证明或证伪'
      );
    } else if (scTotal > 0 && sc.withSignals === 0) {
      report.gaps.push(
        `§15-2 违反中：${scTotal} 行全部只有主诉 ⇒ 四道 pass 实际就是 query-only（§16.4p 的接缝断了）`
      );
    }
    for (const [mode, m] of Object.entries(report.byMode)) {
      const share = m.turns > 0 ? (m.strong / m.turns) : null;
      const targetNote = m.target === null
        ? '目标未设(auto 档如此)'
        : `目标 ${m.target.toFixed(2)}｜差 ${share === null ? 'n/a' : (share - m.target >= 0 ? '+' : '') + (share - m.target).toFixed(2)}`;
      lines.push(`  mode=${mode}: n=${m.turns} ok=${m.ok} fail=${m.fail} usd=${m.usd.toFixed(5)} priced=${m.priced}`
        + `｜强档占比 实测 ${share === null ? 'n/a' : share.toFixed(2)} ${targetNote}`);
    }
    const cc = report.capabilityCoverage;
    const selectTotal = cc.required + cc.noRequirement + cc.absentField;
    lines.push(
      `能力门槛（全部 select 行，分母 ${selectTotal}）: 有能力要求 ${cc.required}` +
      `｜其中报挡 ${cc.blocked}｜淘汰候选 ${cc.dropped}｜能力未知仍保留 ${cc.unknownKept}` +
      `｜本轮无要求 ${cc.noRequirement}｜字段缺席 ${cc.absentField}`
    );
    if (selectTotal > 0 && cc.absentField === selectTotal) {
      report.gaps.push(
        `§8-⑦ 不可判定：${selectTotal} 行 select 全无 capability 字段（写手未落或样本早于接线）`
        + ' —— 「带图请求不会被改道给不识图候选」这件事现在没有任何数据能证明或证伪'
      );
    }
    const sw = report.switches;
    lines.push(
      `跨档切换（A5，按会话分组，只报数不判定）: 会话 ${sw.sessions}｜轮次 ${sw.turns}` +
      `｜切换 ${sw.switches}｜单会话最多 ${sw.maxPerSession}` +
      (sw.turns > 0 ? `｜每轮切换率 ${(sw.switches / sw.turns).toFixed(3)}` : '')
    );
    const fl = report.failures;
    lines.push(
      `失败观测 ${fl.total} 行（可归属轮次 ${fl.attached}｜无 turnId ${fl.total - fl.attached}）` +
      `｜归因 ${JSON.stringify(fl.byType)}`
    );
    const bc = report.betaCarrier;
    lines.push(
      `β 载体（全部 select 行）: 档位声明具体思考档 ${bc.declared}｜请求带 reasoning_effort=auto ${bc.carried}` +
      `｜无载体 ${bc.notCarried}｜字段缺席 ${bc.absentField}`
    );
    if (bc.declared > 0 && bc.carried === 0) {
      // 这不是 GAP（判据仍可执行），是一句结论：β 在这些样本上从未落到过一次。
      lines.push(`  ⚠ 档位想要思考预算的 ${bc.declared} 行**全部没有载体** ⇒ §5.2 的 β 目前是纸面 dial`);
    }
    const mg = report.margin;
    const mgTotal = mg.present + mg.nullValue + mg.absentField;
    lines.push(
      `margin 分布（全部 select 行 ${mgTotal}）: 有差值 ${mg.present}` +
      (mg.present > 0 ? `｜均值 ${(mg.sum / mg.present).toFixed(4)}` : '') +
      `｜值为 null（离散排序，无差值）${mg.nullValue}` +
      `｜字段缺席 ${mg.absentField}` +
      (report.marginThreshold === null
        ? '｜阈值：档位卡读不到，只报分布不报「低于阈值」数'
        : `｜低于卡内 marginUpgrade=${report.marginThreshold} 的 ${mg.low} 轮`)
    );
    if (mg.present === 0 && mgTotal > 0) {
      // §5.5 的 lowMargin 触发器与 §14-D3 的阈值都需要同一个输入：那个差值。
      // 一条都没有 ⇒ 不是「升档没意义」，是这条链在样本里没有过输入。
      lines.push('  ⚠ margin 无一可用 ⇒ §5.5 低置信升档与 §14-D3 阈值在这些样本上**没有实测输入**');
    }
    const otherReasons = Object.keys(report.reasons).filter((k) => !report.declaredTriggers.includes(k));
    const totalHits = Object.values(report.reasons).reduce((a, b) => a + b, 0);
    lines.push(
      `升档触发器命中（名册来自档位卡 escalateOn，共 ${report.declaredTriggers.length} 个声明）: ` +
      (report.declaredTriggers.map((k) => `${k} ${report.reasons[k] || 0}`).join('｜') || '卡里没声明') +
      `｜名册外的原因 ${otherReasons.length ? JSON.stringify(otherReasons.map((k) => [k, report.reasons[k]])) : '无'}` +
      `｜原因字段缺席 ${report.reasonFieldAbsent}`
    );
    if (report.declaredTriggers.length > 0 && mgTotal > 0 && totalHits === 0) {
      // 这一行的价值在区分两种「0」：条件没满足 ≠ 输入没有生产方。
      // 后者是本方案的已知事实（§14-D9/D10：`options.verifyFailed` 与 `options.irreversible`
      // 全仓无写入方），但报表不该假设它 —— 零命中就点名「要么…要么」，让人去查。
      lines.push(
        `  ⚠ 卡里声明的 ${report.declaredTriggers.length} 个触发器在 ${mgTotal} 条 select 行上**零命中**` +
        ' ⇒ 要么条件从未满足，要么输入没有生产方（§14-D9/D10 记的是后者）'
      );
    }
    const fg = report.flags;
    const topFlags = Object.entries(fg.byFlag).sort((a, b) => b[1] - a[1]).slice(0, 6);
    lines.push(
      `flag_rules 命中（全部 select 行 ${fg.rowsWithFlags + fg.rowsWithout + fg.fieldAbsent}）: 命中 flag ${fg.rowsWithFlags}` +
        `｜pass 已接入但零命中 ${fg.rowsWithout}｜demand 块缺席 ${fg.fieldAbsent}` +
        (topFlags.length ? `｜Top ${topFlags.map(([k, n]) => k + '：' + n).join(`, `)}` : '')
    );
    if (fg.rowsWithFlags + fg.rowsWithout > 0 && fg.rowsWithFlags === 0) {
      lines.push(
        `  ⚠ flag_rules 在 ${fg.rowsWithFlags + fg.rowsWithout} 轮里零命中 ⇒ 词表对本仓真实负载可能在系统性漏判` +
          `（§14-D8 重写词表正是为此；零命中不等于「负载简单」）`
      );
    }
    const on = report.flagSplit.on, off = report.flagSplit.off;
    if (on.n + off.n > 0) {
      const rate = (b) => (b.n ? ((100 * b.ok) / b.n).toFixed(1) + '%' : 'n/a');
      const avg = (b) => (b.priced ? (b.usd / b.priced).toFixed(5) : 'n/a');
      lines.push(
        `flag 相关性对照（仅可 join 轮，不是因果）: 命中 n=${on.n} ok=${rate(on)} usd=${avg(on)}` +
          `｜未命中 n=${off.n} ok=${rate(off)} usd=${avg(off)}`
      );
    }

    if (Object.keys(report.baselines).length) {
      lines.push('退化基线对照（仅 priced 轮）:');
      for (const [k, v] of Object.entries(report.baselines)) {
        lines.push(`  ${k.padEnd(12)} n=${String(v.n).padStart(3)} ok=${v.ok === null ? 'n/a' : (100 * v.ok).toFixed(1) + '%'} usd=${v.usd.toFixed(5)}${v.note ? '  ← ' + v.note : ''}`);
      }
    }
    lines.push(`S1 毕业: ${report.graduation.observed}/${report.graduation.s1Target}${report.graduation.ready ? '  达标' : '  未达标'}`);
    if (report.gaps.length) {
      lines.push('GAP（判据不可执行项）:');
      for (const g of report.gaps) lines.push(`  - ${g}`);
    } else {
      lines.push('无 GAP');
    }
    process.stdout.write(lines.join('\n') + '\n');
  }

  // S1 观察者档：永不阻断（PROCESS-008 PP-3）。--strict 才把 GAP 当失败。
  const strict = process.argv.includes('--strict');
  if (strict && report.gaps.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    process.stdout.write(`route-replay 自身异常（不阻断）: ${e && e.message}\n`);
  }
}

module.exports = { main };

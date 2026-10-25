'use strict';

/**
 * confidenceCalibrationLedger.js — 「确信度校准」S1 观察样本台账(IO 壳;绝不抛、不阻断)。
 *
 * 分工:纯叶子 confidenceCalibration(判定 + 计数,零 IO)归它;本壳只做一件事 —— 把
 * **有 finding 的轮次**旁路落一份 JSONL,供 S1 观察期统计样本量与误报率(PROCESS-008:
 * S1/S2 只记录不阻断)。没有 finding 的轮次不落账(台账只存异常样本,不存全量流水)。
 *
 * 契约:
 *   - **绝不抛**:任何 IO / 参数异常都被吞掉,记录是尽力而为,不得影响主流程。
 *   - **不阻断**:调用方不依赖返回值做决策(返回值仅用于测试断言)。
 *   - **不上报敏感内容**(沿用 authzFailureLedger 的送别礼口径):只记命中**词表标签**、
 *     计数、阶段与「会话历史是否有工具活动」布尔;不记回复正文,不记用户消息,不记文件内容。
 *   - 落点:env KHY_CONFIDENCE_LEDGER_FILE 显式覆盖(测试注入用);否则
 *     <dataHome>/ruleguard/confidence-observations.jsonl(与 auto-route.jsonl 同档惯例;
 *     走 dataHome 解析器,落点只由 KHY_DATA_HOME 决定,与调用方 cwd 无关);dataHome
 *     不可用时回退 cwd 相对路径 works/data/khy/ruleguard/confidence-observations.jsonl。
 *
 * @module services/confidenceCalibrationLedger
 */

const fs = require('fs');
const path = require('path');

const LEDGER_REL = path.join('works', 'data', 'khy', 'ruleguard', 'confidence-observations.jsonl');
const MAX_ROWS_READ = 5000;

/** 解析台账绝对路径:env 覆盖 > dataHome > cwd 相对回退。绝不抛。 */
function _ledgerPath(env) {
  const e = env || process.env || {};
  const override = e.KHY_CONFIDENCE_LEDGER_FILE;
  if (override && typeof override === 'string') {
    return override;
  }
  try {
    const { getDataDir } = require('../utils/dataHome');
    if (typeof getDataDir === 'function') {
      return path.join(getDataDir('ruleguard'), 'confidence-observations.jsonl');
    }
  } catch {
    /* dataHome 不可用 → cwd 回退 */
  }
  return path.resolve(process.cwd(), LEDGER_REL);
}

/**
 * 追加一条观察记录(仅当报告有 finding)。**绝不抛。**
 * @param {object} report confidenceCalibration.observe 的返回值
 * @param {object} [opts] {env}
 * @returns {boolean} true = 已写入;false = 无 finding 或写入失败(已吞)
 */
function recordObservation(report, opts = {}) {
  try {
    if (!report || typeof report !== 'object') {
      return false;
    }
    const findings = Array.isArray(report.findings) ? report.findings : [];
    if (findings.length === 0) {
      return false;
    }
    const row = {
      ts: new Date().toISOString(),
      stage: String(report.stage || 'S1'),
      toolCalls: Number(report.toolCalls) || 0,
      replyChars: Number(report.replyChars) || 0,
      // 会话历史里是否已有工具活动(样本解读用:为 true 时只可能记 unbacked_certainty)。
      priorToolActivity: report.priorToolActivity === true,
      certaintyMarkers: (Array.isArray(report.certaintyMarkers) ? report.certaintyMarkers : [])
        .slice(0, 12)
        .map((x) => String(x)),
      verificationClaims: (Array.isArray(report.verificationClaims) ? report.verificationClaims : [])
        .slice(0, 8)
        .map((x) => String(x)),
      hedges: (Array.isArray(report.hedges) ? report.hedges : []).slice(0, 12).map((x) => String(x)),
      findings: findings.slice(0, 4).map((f) => ({
        kind: String((f && f.kind) || 'unknown'),
        evidence: (Array.isArray(f && f.evidence) ? f.evidence : []).slice(0, 6).map((x) => String(x)),
      })),
    };
    const target = _ledgerPath((opts && opts.env) || process.env);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, JSON.stringify(row) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取台账全部记录(供 S1 统计脚本与测试使用)。**绝不抛**,失败返回 []。
 * @param {object} [opts] {env, max}
 * @returns {object[]}
 */
function readObservations(opts = {}) {
  try {
    const target = _ledgerPath((opts && opts.env) || process.env);
    if (!fs.existsSync(target)) {
      return [];
    }
    const max = Number((opts && opts.max) || MAX_ROWS_READ) || MAX_ROWS_READ;
    return fs
      .readFileSync(target, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .slice(-max)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = { recordObservation, readObservations, LEDGER_REL };

/**
 * screendiff · JavaScript 参考实现（Apache-2.0）
 *
 * 与 Python 参考实现**独立编写**，用于验证 SPEC 的可移植性。
 * 实现依据是 SPEC.md 正文，不是 Python 代码的翻译。
 *
 * 用法：
 *   const { diff } = require('./screendiff.js');
 *   const cs = diff(prevElements, curElements);
 *   cs.to_dict();
 */
'use strict';

/** 参与 state_changed 判定的七个标志（SPEC §5） */
const STATE_FLAGS = ['clickable', 'long_clickable', 'scrollable',
                     'editable', 'checked', 'disabled', 'password'];

/** 变化类。顺序即契约枚举顺序。 */
const CHANGE_KINDS = ['moved', 'role_changed', 'label_changed', 'state_changed'];

/** 输入规整：接受 dict 或有属性的对象 */
function norm(e) {
  const b = Array.isArray(e.bounds)
    ? [e.bounds[0] | 0, e.bounds[1] | 0, e.bounds[2] | 0, e.bounds[3] | 0]
    : [e.bounds.x1 | 0, e.bounds.y1 | 0, e.bounds.x2 | 0, e.bounds.y2 | 0];
  const o = {
    ref: e.ref, role: e.role, label: e.label, bounds: b,
    class_name: e.class_name || '', resource_id: e.resource_id || '',
  };
  for (const f of STATE_FLAGS) o[f] = !!e[f];
  return o;
}

function elementsOf(x) {
  if (Array.isArray(x)) return x.map(norm);
  if (x && Array.isArray(x.elements)) return x.elements.map(norm);
  if (x && typeof x[Symbol.iterator] === 'function') return [...x].map(norm);
  throw new TypeError('输入须为数组或带 .elements 的对象');
}

function areaOf(e) {
  return Math.max(0, e.bounds[2] - e.bounds[0]) * Math.max(0, e.bounds[3] - e.bounds[1]);
}

/** SPEC §4.2：重叠率 = 交面积 / min(两者面积) */
function overlap(a, b) {
  const ix = Math.max(a.bounds[0], b.bounds[0]);
  const iy = Math.max(a.bounds[1], b.bounds[1]);
  const jx = Math.min(a.bounds[2], b.bounds[2]);
  const jy = Math.min(a.bounds[3], b.bounds[3]);
  const inter = Math.max(0, jx - ix) * Math.max(0, jy - iy);
  const d = Math.min(areaOf(a), areaOf(b));
  return d === 0 ? 0 : inter / d;
}

/** SPEC §4.1：min/max 面积比，纯几何 tier 的闸门 */
function sizeRatio(a, b) {
  const x = areaOf(a), y = areaOf(b);
  if (x === 0 || y === 0) return 0;
  return Math.min(x, y) / Math.max(x, y);
}

/** SPEC §4.1：分层打分。三个身份 tier 都要求字段非空。 */
function score(p, c) {
  if (p.resource_id && p.resource_id === c.resource_id) return 100;
  if (p.class_name && p.class_name === c.class_name && p.label && p.label === c.label) return 70;
  const ov = overlap(p, c);
  if (p.class_name && p.class_name === c.class_name && ov >= 0.5) return 50;
  if (p.label && p.label === c.label && ov >= 0.5) return 35;
  if (ov >= 0.8 && sizeRatio(p, c) >= 0.5) return 20;
  return 0;
}

class MatchedPair {
  constructor(prev, cur) { this.prev = prev; this.cur = cur; }

  get moved() { return boundsKey(this.prev) !== boundsKey(this.cur); }
  get role_changed() { return this.prev.role !== this.cur.role; }
  get label_changed() { return this.prev.label !== this.cur.label; }
  get state_changed() {
    return STATE_FLAGS.some(f => this.prev[f] !== this.cur[f]);
  }
  get changes() {
    return CHANGE_KINDS.filter(k => this[k]);
  }
  get unchanged() { return this.changes.length === 0; }
}

function boundsKey(e) {
  return e.bounds.join(',');
}

class ChangeSet {
  constructor(prev, cur, matched, added, removed) {
    this.prev_elements = prev; this.cur_elements = cur;
    this.matched = matched; this.added = added; this.removed = removed;
  }

  /** SPEC §5.1：语义判定，不等于 snapshot_id 相等 */
  get is_identical() {
    if (this.added.length || this.removed.length) return false;
    return this.matched.every(p => p.unchanged);
  }

  get counts() {
    return {
      matched: this.matched.length,
      added: this.added.length,
      removed: this.removed.length,
      moved: this.matched.filter(p => p.moved).length,
      state_changed: this.matched.filter(p => p.state_changed).length,
      label_changed: this.matched.filter(p => p.label_changed).length,
    };
  }

  /** SPEC §8.1：一致性契约 */
  to_dict() {
    const brief = e => ({ ref: e.ref, role: e.role, label: e.label });
    return {
      matched: this.matched.map(p => ({
        prev_ref: p.prev.ref, cur_ref: p.cur.ref, changes: p.changes,
      })),
      added: this.added.map(brief),
      removed: this.removed.map(brief),
      is_identical: this.is_identical,
      counts: this.counts,
    };
  }
}

/**
 * SPEC §4：跨快照元素匹配。
 * 排序键 (-score, prev_index, cur_index) 完全确定。
 */
function diff(prev, cur) {
  const P = elementsOf(prev), C = elementsOf(cur);

  const cands = [];
  for (let i = 0; i < P.length; i++) {
    for (let j = 0; j < C.length; j++) {
      const s = score(P[i], C[j]);
      if (s > 0) cands.push([-s, i, j]);
    }
  }
  cands.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);

  const usedP = new Set(), usedC = new Set();
  const pairs = [];
  for (const [, i, j] of cands) {
    if (usedP.has(i) || usedC.has(j)) continue;
    usedP.add(i); usedC.add(j);
    pairs.push([i, j, new MatchedPair(P[i], C[j])]);
  }
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const added = C.filter((_, j) => !usedC.has(j));
  const removed = P.filter((_, i) => !usedP.has(i));
  return new ChangeSet(P, C, pairs.map(t => t[2]), added, removed);
}

/** SPEC §6.1：effect */
function effectOf(cs, targetRef) {
  const base = { added_count: cs.added.length, removed_count: cs.removed.length };
  const prevRefs = new Set(cs.prev_elements.map(e => e.ref));
  if (!prevRefs.has(targetRef)) return mk('unknown_target', [], base, []);
  if (cs.removed.some(e => e.ref === targetRef)) return mk('target_gone', [], base, []);
  const pair = cs.matched.find(p => p.prev.ref === targetRef);
  if (!pair) return mk('unknown_target', [], base, []);
  const covering = cs.added.filter(e => overlap(pair.prev, e) >= 0.5);
  return mk(pair.unchanged ? 'target_unchanged' : 'target_changed',
            pair.changes, base, covering);
}

function mk(conclusion, changes, base, covering) {
  return {
    conclusion, changes,
    added_count: base.added_count, removed_count: base.removed_count,
    added_overlapping_target: covering,
  };
}

/** SPEC §6.2：stuck 检测 */
function isStuck(history, n) {
  if (n === undefined) n = 3;
  if (n < 2 || history.length < n) return false;
  return history.slice(-n).every(cs => cs.is_identical);
}

/** SPEC §6.3：加载态启发式（应该级） */
const LOADING_ROLES = new Set(['progress', 'scroll']);
const INTERACTIVE_ROLES = new Set(['btn', 'input', 'switch', 'item', 'radio', 'check', 'slider']);

function isLoading(cur) {
  const els = elementsOf(cur);
  if (els.length > 2) return false;
  const roles = new Set(els.map(e => e.role));
  if (![...roles].some(r => LOADING_ROLES.has(r))) return false;
  return ![...roles].some(r => INTERACTIVE_ROLES.has(r));
}

module.exports = {
  diff, effectOf, isStuck, isLoading,
  CHANGE_KINDS, STATE_FLAGS, MatchedPair, ChangeSet,
};

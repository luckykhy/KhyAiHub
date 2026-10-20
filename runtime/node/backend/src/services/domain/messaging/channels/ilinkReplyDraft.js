'use strict';

/**
 * ilinkReplyDraft — IlinkDispatcher 的「待批出站草稿」职责簇。
 *
 * 一轮 agent 跑完,回复与工具产出的文件**不再直接发出去**,而是登记成一条草稿,
 * 等这位发送者本人回一句「发」。落在人这一侧的原因是副作用真实发生在出站:
 * 私有回复被投进别人的会话、把本机文件发给错的人,都是发出去之后才发现。
 *
 * 为什么按发送者分桶而不是一条全局队列:草稿是**某个人的私有内容**,批准权必须
 * 跟着作者走。全局 FIFO 会让 peer B 的一个「发」取到 peer A 的草稿 —— 用审批消息的
 * 会话发出去就是跨 peer 外泄,用草稿里存的会话发出去就是 B 强行放行了 A 从未批准的内容。
 * 按 (accountId,userId) 分桶后,FIFO 只在**同一发送者内部**排,索引本身就完成了隔离
 * (与直发态按账号+发送者隔离是同一个原则)。
 *
 * 三条不变量:
 *   1. 过期**绝不自动发送**。没人看过的东西不替他发,只清条目并回执。
 *   2. 登记只登记,不等待 —— 等批准不许发生在 _runQuery 里(否则 typing 悬挂、
 *      串行队列停摆)。顺序与上限由本队列自己保证。
 *   3. 只在内存里。进程重启即失效是特性不是缺陷:重启后没人知道原来批过什么。
 *
 * @module services/channels/ilinkReplyDraft
 */

/**
 * @param {object} [opts]
 * @param {number} [opts.ttlMs] 草稿存活时长
 * @param {number} [opts.max] 每个发送者的积压上限
 */
class ReplyDraftQueue {
  constructor(opts = {}) {
    const ttl = Number(opts.ttlMs);
    const max = Number(opts.max);
    this._ttlMs = ttl > 0 ? ttl : 120000;
    this._max = max > 0 ? max : 3;
    /** @type {Map<string, Array<{msg:object,text:string,files:Array,preview:string,createdAt:number,expiresAt:number}>>} */
    this._byUser = new Map();
  }

  /**
   * 登记一条待批草稿。超出上限时丢**最旧**的一条(FIFO 语义),并把被丢的条目回给
   * 调用方去告知发送者 —— 静默丢弃会让人以为那条回复还在队列里。
   *
   * @param {string} userId 草稿作者
   * @param {{msg:object, text:string, files?:Array, preview:string}} draft
   * @returns {{draft:object, dropped:object|null}} dropped 为被挤掉的最旧草稿(没有则 null)
   */
  push(userId, draft) {
    const key = String(userId == null ? '' : userId);
    const now = Date.now();
    const entry = {
      msg: draft.msg,
      text: String(draft.text == null ? '' : draft.text),
      files: Array.isArray(draft.files) ? draft.files : [],
      preview: String(draft.preview == null ? '' : draft.preview),
      createdAt: now,
      expiresAt: now + this._ttlMs,
    };
    if (!this._byUser.has(key)) {
      this._byUser.set(key, []);
    }
    const list = this._byUser.get(key);
    list.push(entry);
    let dropped = null;
    while (list.length > this._max) {
      dropped = list.shift();
    }
    if (dropped) {
      this._pruneEmpty(key);
    }
    return { draft: entry, dropped };
  }

  /**
   * 取**该发送者**的待批草稿(队首优先)。
   * @param {string} userId
   * @returns {object|null}
   */
  pending(userId) {
    const list = this._byUser.get(String(userId == null ? '' : userId));
    return list && list.length ? list[0] : null;
  }

  /** 该发送者积压了几条(诊断面用)。 */
  pendingCount(userId) {
    const list = this._byUser.get(String(userId == null ? '' : userId));
    return list ? list.length : 0;
  }

  /**
   * 消费该发送者的队首草稿,返回它。
   * @param {string} userId
   * @returns {object|null}
   */
  resolve(userId) {
    const key = String(userId == null ? '' : userId);
    const list = this._byUser.get(key);
    if (!list || !list.length) {
      return null;
    }
    const head = list.shift();
    this._pruneEmpty(key);
    return head;
  }

  /**
   * 清掉已过期的草稿。**只清不送**。
   * @param {number} [now]
   * @returns {Array<object>} 本次被清掉的草稿(交给调用方逐条回执)
   */
  expire(now = Date.now()) {
    const expired = [];
    for (const [userId, list] of Array.from(this._byUser.entries())) {
      const kept = list.filter((d) => {
        if (d.expiresAt <= now) {
          expired.push(d);
          return false;
        }
        return true;
      });
      if (kept.length) {
        this._byUser.set(userId, kept);
      } else {
        this._byUser.delete(userId);
      }
    }
    return expired;
  }

  /**
   * 清掉**该发送者**的待批草稿(/clear、/reset、/new 走这里)。
   *
   * 不提供整表全清:按作者分桶是草稿隔离的全部依据,一个无参全清会让「/clear 只清自己」
   * 退化成「/clear 清掉所有人」——别人的草稿既收不到提示,内容也永久没了(复核员实测
   * uA 的 /clear 把 uB 的待批草稿清空)。账号切换也不需要全清:实例本就按 accountId 构造。
   *
   * @param {string} userId
   * @returns {number} 清掉几条 —— 调用方按实际条数回执,不为「可能没清掉」做保证
   */
  clear(userId) {
    const key = String(userId == null ? '' : userId);
    const list = this._byUser.get(key);
    const cleared = list ? list.length : 0;
    this._byUser.delete(key);
    return cleared;
  }

  /**
   * 诊断读数。owners 只给计数与 id,**不含任何草稿正文** —— 诊断面会被
   * /queue、/wx 渲染出来,那些正文是用户的私有内容。
   * @returns {{total:number, owners:string[]}}
   */
  stats() {
    const owners = [];
    let total = 0;
    for (const [userId, list] of this._byUser.entries()) {
      if (!list.length) {
        continue;
      }
      total += list.length;
      owners.push(userId);
    }
    return { total, owners };
  }

  _pruneEmpty(key) {
    const list = this._byUser.get(key);
    if (!list || !list.length) {
      this._byUser.delete(key);
    }
  }
}

module.exports = { ReplyDraftQueue };

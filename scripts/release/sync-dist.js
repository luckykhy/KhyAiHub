#!/usr/bin/env node
'use strict';

/**
 * sync-dist.js — 把本地提交追加进 KhyAiHub 分发仓历史。
 *
 * 背景：KhyAiHub 的历史是**curated** 的（baseline + 落账 + 逐笔实质提交），
 * 与本地 `chore/hygiene-20261010` 的原始历史是**两条不相干的线**——前者是我为公开
 * 可读性手工排的。所以不能直接 `git push`，必须把本地新提交作为**后代**追加上去，
 * 才能既保住 curated 历史、又让 mirror 的 fast-forward 推送继续成立。
 *
 * 本脚本做这件事：从 KhyAiHub 当前 main 出发，逐个应用本地提交的 diff，
 * 保持原消息与作者，产出一条新链。**不改写本地历史，也永不需要 force-push 第二次**
 * ——第二次起 KhyAiHub main 已是上次的链尖，追加仍是 fast-forward。
 *
 * 状态文件 `docs/10_规范/registry/DIST-SYNC.json` 记「上次同步到哪个本地提交」，
 * 下次从这里续。丢失该文件时用 `--base <本地commit>` 显式指定。
 *
 * 用法：
 *   node scripts/release/sync-dist.js status           # 看差多少
 *   node scripts/release/sync-dist.js push --dry-run   # 只说要追加什么
 *   node scripts/release/sync-dist.js push             # 建链并推 GitHub（Gitee 走 mirror）
 *   node scripts/release/sync-dist.js push --no-push   # 只建链不推（本地留分支可查）
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STATE_REL = 'docs/10_规范/registry/DIST-SYNC.json';
const DIST_REMOTE = 'khyaihub-ssh';
const DIST_BRANCH = 'main';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const noPush = args.includes('--no-push');
const command = args.find((a) => !a.startsWith('--'));

function git(argv, opts = {}) {
  return execFileSync('git', argv, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function gitQuiet(argv) {
  try { return git(argv).trim(); } catch (e) { return ''; }
}

function fail(msg) {
  console.error(`sync-dist: ${msg}`);
  process.exit(1);
}

/**
 * 邮箱映射：分发仓的提交一律改用 Gitee 匿名邮箱。
 *
 * 为什么必须映射：本地提交的作者邮箱是 2578974124@qq.com，而该邮箱在 Gitee 账号里
 * 被设为「隐藏」。Gitee 的 pre-receive 钩子会拒绝任何会把隐藏邮箱公开的推送：
 *     remote: Push will publish a hidden email ...
 *     remote: error: hook declined to update refs/heads/main
 * 这不是故障，是隐私设置在生效——所以顺着它，而不是去把邮箱改成公开。
 * 匿名邮箱同时避免个人邮箱被公开仓的爬虫抓到。
 *
 * 作者**姓名不变**（仍是孔浩原），只换邮箱这一个字段。
 * GitHub 侧不强制（它收 QQ 邮箱的提交），但两边共用一条链，只能取严。
 */
const EMAIL_MAP = {
  '2578974124@qq.com': '11599182+luckyhaoyunkhy@user.noreply.gitee.com',
};

function mapEmail(email) {
  return EMAIL_MAP[email] || email;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, STATE_REL), 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeState(s) {
  fs.writeFileSync(path.join(REPO_ROOT, STATE_REL), JSON.stringify(s, null, 2) + '\n');
}

/** 本地分支（内容真源）。 */
function localBranch() {
  return gitQuiet(['rev-parse', '--abbrev-ref', 'HEAD']) || 'HEAD';
}

/** KhyAiHub 远端 main 的 SHA（拉一次 refs，不拉对象）。 */
function distTip() {
  // --base-dist <sha>：显式指定链的起点，用于「已推上去的提交不被下游接受、必须重建」
  // 的场景（本次即 Gitee 隐藏邮箱钩子拒收，从最后一个 Gitee 收过的点重建）。
  const bd = args.indexOf('--base-dist');
  if (bd !== -1 && args[bd + 1] && !args[bd + 1].startsWith('--')) {
    return args[bd + 1];
  }
  const out = gitQuiet(['ls-remote', DIST_REMOTE, `refs/heads/${DIST_BRANCH}`]);
  if (!out) fail(`取不到远端 ${DIST_REMOTE} 的 ${DIST_BRANCH}——remote 未配置或无权限。`);
  return out.split(/\s+/)[0];
}

/** 上一个已同步的本地提交。 */
function lastSynced() {
  const baseIdx = args.indexOf('--base');
  if (baseIdx !== -1 && args[baseIdx + 1] && !args[baseIdx + 1].startsWith('--')) {
    return args[baseIdx + 1];
  }
  const st = readState();
  return st && st.lastSyncedLocalCommit ? st.lastSyncedLocalCommit : null;
}

function pendingCommits(from) {
  const range = from ? `${from}..HEAD` : 'HEAD';
  const out = gitQuiet(['log', '--reverse', '--format=%H', range]);
  return out ? out.split('\n').filter(Boolean) : [];
}

// ── status ─────────────────────────────────────────────────────────────────
function cmdStatus() {
  const branch = localBranch();
  const localHead = gitQuiet(['rev-parse', 'HEAD']);
  const remote = distTip();
  const from = lastSynced();
  const pending = pendingCommits(from);

  console.log(`内容真源（本地）: ${branch} @ ${localHead.slice(0, 9)}`);
  console.log(`分发仓 ${DIST_REMOTE}/${DIST_BRANCH}: ${remote.slice(0, 9)}`);
  console.log(`上次同步到        : ${from ? from.slice(0, 9) : '（无记录）'}`);
  console.log(`待追加            : ${pending.length} 笔`);
  if (pending.length) {
    const first = gitQuiet(['log', '-1', '--format=%h %s', pending[0]]);
    const last = gitQuiet(['log', '-1', '--format=%h %s', pending[pending.length - 1]]);
    console.log(`  最早: ${first}`);
    console.log(`  最晚: ${last}`);
  }
  if (!from) {
    console.log('');
    console.log('⚠ 没有同步记录。若 KhyAiHub 已有历史，用 --base <本地commit> 指明它的对应点。');
  }
}

// ── push ───────────────────────────────────────────────────────────────────
function cmdPush() {
  // --force 的确认串在**最开始**校验，不等到推送前。坏 flag 应该立刻失败，
  // 而不是让前面建链的活儿全白跑一遍才说「你 flag 打错了」。
  const forceArg = args.find((a) => a.startsWith('--force'));
  const forceVal = forceArg && forceArg.includes('=') ? forceArg.slice('--force='.length) : '';
  if (forceArg && forceVal !== 'REWRITE') {
    console.log('');
    console.log('⚠ --force 需要确认串：--force=REWRITE');
    console.log('  强推会重写分发仓历史，而 mirror 是 fast-forward——一旦 GitHub 被改写而 Gitee');
    console.log('  没有，镜像推送会被拒，得手工对齐两边。所以它不该是顺手就能加上的 flag。');
    console.log('  若确有必要（例如已推的提交不被下游接受、必须重建），请先想清三件事：');
    console.log('    ① 为什么必须改写  ② Gitee 侧怎么对齐  ③ 已在本笔提交信息里说明');
    process.exit(1);
  }

  const from = lastSynced();
  if (!from) {
    fail('没有上次同步记录，无法判断从哪续。首次同步请用 --base <本地commit> 显式指定基线。');
  }
  const pending = pendingCommits(from);
  if (pending.length === 0) {
    console.log('没有待追加的提交，分发仓已是最新。');
    return;
  }

  const remoteTip = distTip();
  console.log(`基线：分发仓 ${remoteTip.slice(0, 9)} ← 本地已同步点 ${from.slice(0, 9)}`);
  console.log(`待追加 ${pending.length} 笔：`);

  let parent = remoteTip;
  let count = 0;
  for (const c of pending) {
    // 用临时索引：从 parent 的树出发，应用这一笔的 diff
    const idx = path.join(require('os').tmpdir(), `khy-sync-${process.pid}-${count}.idx`);
    try { fs.unlinkSync(idx); } catch (e) { /* 首次不存在 */ }
    const env = { ...process.env, GIT_INDEX_FILE: idx };
    git(['read-tree', `${parent}^{tree}`], { env });

    const diff = gitQuiet(['diff', '--name-status', `${c}^`, c]);
    const lines = diff ? diff.split('\n').filter(Boolean) : [];
    for (const line of lines) {
      const [status, p1, p2] = line.split('\t');
      const target = status.startsWith('R') ? p2 : p1;
      if (status.startsWith('D')) {
        git(['update-index', '--force-remove', target], { env });
      } else {
        const blob = gitQuiet(['rev-parse', `${c}:${target}`]);
        if (!blob) continue;
        // --add 必须有：目标文件若不在 parent 树里（本笔新增），
        // 光 --cacheinfo 会报 "cannot add to the index - missing --add option"。
        git(['update-index', '--add', '--cacheinfo', `100644,${blob},${target}`], { env });
      }
    }
    const tree = git(['write-tree'], { env }).trim();
    try { fs.unlinkSync(idx); } catch (e) { /* 已由 write-tree 消费 */ }

    const msgFile = path.join(require('os').tmpdir(), `khy-sync-msg-${process.pid}-${count}.txt`);
    fs.writeFileSync(msgFile, git(['log', '-1', '--format=%B', c]));
    const author = gitQuiet(['log', '-1', '--format=%an%x00%ae%x00%aI', c]).split('\0');
    const committer = gitQuiet(['log', '-1', '--format=%cn%x00%ce%x00%cI', c]).split('\0');
    // 邮箱映射到 Gitee 匿名形式，否则推送被 Gitee 的隐藏邮箱钩子拒。
    author[1] = mapEmail(author[1]);
    committer[1] = mapEmail(committer[1]);

    const commitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: author[0], GIT_AUTHOR_EMAIL: author[1], GIT_AUTHOR_DATE: author[2],
      GIT_COMMITTER_NAME: committer[0], GIT_COMMITTER_EMAIL: committer[1], GIT_COMMITTER_DATE: committer[2],
    };
    const newCommit = git(['commit-tree', tree, '-p', parent, '-F', msgFile], { env: commitEnv }).trim();
    fs.unlinkSync(msgFile);

    console.log(`  ${gitQuiet(['log', '-1', '--format=%h', c])} → ${newCommit.slice(0, 9)}  ${gitQuiet(['log', '-1', '--format=%s', c]).slice(0, 52)}`);
    parent = newCommit;
    count++;
  }

  // 校验：链尖的树必须等于本地 HEAD 的树（否则同步漏了东西）
  const finalTree = gitQuiet(['rev-parse', `${parent}^{tree}`]);
  const localTree = gitQuiet(['rev-parse', `HEAD^{tree}`]);
  if (finalTree !== localTree) {
    fail(`链尖树 ${finalTree.slice(0, 9)} ≠ 本地 HEAD 树 ${localTree.slice(0, 9)}——同步不完整，未推送。`);
  }
  console.log(`✓ 链尖树与本地 HEAD 一致（${localTree.slice(0, 9)}）`);

  if (dryRun) {
    console.log('\n（--dry-run，未写入状态、未推送）');
    return;
  }

  if (!noPush) {
    console.log(`\n推送到 ${DIST_REMOTE}/${DIST_BRANCH} ...`);
    const pushEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    // 确认串已在函数开头校验过，这里只分档。默认用 --force-with-lease：
    // 万一远端被他人推进度过，它会拒绝而不是覆盖掉别人的提交。
    const pushArgs = forceVal === 'REWRITE'
      ? ['push', '--force', DIST_REMOTE, `${parent}:refs/heads/${DIST_BRANCH}`]
      : ['push', '--force-with-lease', DIST_REMOTE, `${parent}:refs/heads/${DIST_BRANCH}`];
    if (forceVal === 'REWRITE') {
      console.log('⚠ 强推（--force=REWRITE）：分发仓历史将被改写。');
    }
    git(pushArgs, { env: pushEnv, stdio: 'inherit' });
  }

  writeState({
    $note: '本地提交 → KhyAiHub 分发仓的同步点。由 scripts/release/sync-dist.js 维护，勿手改。',
    lastSyncedLocalCommit: pending[pending.length - 1],
    lastSyncedAt: new Date().toISOString(),
    distTip: parent,
    appended: count,
  });
  console.log(`\n完成：追加 ${count} 笔，同步点记录到 ${STATE_REL}`);
  console.log('Gitee 由 GitHub Actions 的 sync-gitee.yml 镜像接管，不要直接推 Gitee。');
}

switch (command) {
  case 'status': cmdStatus(); break;
  case 'push': cmdPush(); break;
  default:
    console.log('用法:');
    console.log('  node scripts/release/sync-dist.js status');
    console.log('  node scripts/release/sync-dist.js push [--dry-run] [--no-push] [--base <commit>]');
    process.exit(command ? 1 : 0);
}

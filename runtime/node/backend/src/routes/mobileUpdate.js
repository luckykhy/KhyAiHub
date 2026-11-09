'use strict';

/**
 * mobileUpdate.js — 手机端「版本与能力更新」的只读路由。
 *
 *   GET /version?current=<本机版本>&channel=stable|preview
 *
 * 为什么手机不自己查 GitHub / PyPI / npm：那三处是平台发布链的单一真源
 * （services/latestVersionResolver），由后端复用。手机直连会带来第三份探测实现、
 * 第三份凭据面（GitHub token / 代理），以及「后端说 1.6.3、手机说 1.6.4」这种
 * 无法归因的分叉——而分叉没有任何症状，只是用户的版本判断静默出错。手机只报
 * 自己的版本号，比较与归类在 Dart 侧做纯函数（update_check_service.dart）。
 *
 * 红线（与 latestVersionResolver 逐条对齐）：
 *   - 只读、绝不抛。任一源取不到 → 该源 { version: null, error: 原因 }。
 *   - 所有源都取不到 → indeterminate: true，调用方必须诚实说「查不到」，
 *     **绝不**把「查不到」显示成「已是最新」。
 *   - 渠道门控复用 updateChannelRouter.isChannelEnabled（KHY_SELF_UPDATE +
 *     KHY_UPDATE_ENABLE_*），不另立一套开关。
 *   - 端点 / 包名取自 constants/serviceDefaults 的 UPDATE，绝不取自请求参数。
 *
 * 轨道说明（如实记录，不是 TODO）：latestVersionResolver 按构造只取最高的
 * **非 prerelease** 正式版（probeGithub 跳过 draft / prerelease）。所以
 * `channel=preview` 会被规范化、回显、并写进 env 的 KHY_UPDATE_CHANNEL 供下游
 * 读取，但它**不会**改变本路由报出的上游版本——要让 preview 生效，需要给
 * resolver 本身加 prerelease 支持，那是改单一真源，不在本次范围内。手机端据此
 * 把「preview 轨道暂不改变探测结果」原样告诉用户（update_section.dart 的
 * `_trackNote` 读响应里的 releaseChannel），而不是假装它生效了。
 */

const express = require('express');
const router = express.Router();

const apiResponse = require('../utils/apiResponse');
const { UPDATE } = require('../constants/serviceDefaults');
const latestVersionResolver = require('../services/latestVersionResolver');
const updateChannelRouter = require('../services/updateChannelRouter');
const updateCoordinator = require('../services/updateCoordinator');
const versionService = require('../services/versionService');

const PROBE_FAILED_CODE = 'UPDATE_PROBE_FAILED';

/** 本机版本由客户端自报；只做长度截断，不解析、不当真源。 */
const MAX_CURRENT_LEN = 64;

function readCurrent(req) {
  const raw = String((req.query && req.query.current) || '').trim();
  return raw.length > MAX_CURRENT_LEN ? raw.slice(0, MAX_CURRENT_LEN) : raw;
}

/**
 * 发布页地址。只在配了更新源时给，没配就返回 null——手机端对 null 的文案是
 * 「没有可打开发布页的地址」，不是「打开失败」。
 *
 * 拼法沿用 services/domain/network/updateAdapters/portableAdapter.js:52,58：
 * 同一份 `KHY_UPDATE_GITHUB_REPOSITORY` / `UPDATE.GITHUB_REPOSITORY` 派生、同一
 * 个 `https://github.com/${repository}/releases` 形状、空仓库时同样走「未配置」
 * 分支（该仓已于 2026-10-10 删除，拼空串只会得到坏地址）。不在这里立第二个默认仓。
 */
function releasePageUrl(env) {
  const repository = env.KHY_UPDATE_GITHUB_REPOSITORY || UPDATE.GITHUB_REPOSITORY;
  if (!repository) return null;
  return `https://github.com/${repository}/releases`;
}

router.get('/version', async (req, res) => {
  const track = updateCoordinator.normalizeChannel(req.query && req.query.channel);
  const current = readCurrent(req);
  // 轨道随请求走，但只透传给下游（见文件头说明），不改 resolver 的取值。
  const env = { ...process.env, KHY_UPDATE_CHANNEL: track };

  let resolved;
  try {
    resolved = await latestVersionResolver.resolveLatestVersion({ env });
  } catch (error) {
    // resolveLatestVersion 的契约是「绝不抛」，走到这里说明契约被破坏了。
    // 如实报 502 并给出修复建议，不拿一个空结果冒充成功。
    return apiResponse.fail(
      res,
      PROBE_FAILED_CODE,
      `平台版本探测失败：${(error && error.message) || error}。`
        + '修复：在跑后端的机器上执行 khy update --check 看具体哪个源不通，再重试。',
      { status: 502, hint: '版本探测是后端代查，失败原因在后端侧可见' }
    );
  }

  // 第四个源（本地快照）不在 latestVersionResolver 的 SOURCES 里——它不是版本
  // 源，而是安装态自愈源。门控同样来自 updateChannelRouter，不另立开关。
  const localEnabled = updateChannelRouter.isChannelEnabled('local', env);

  // 后端自己的更新状态：让手机能区分「有新版本」和「有新版本且后端已就绪但还没
  // 重启」。这两件事对用户是两件事，混成一句就是谎。
  const platformState = updateCoordinator.readState();

  return apiResponse.success(res, {
    releaseChannel: track,
    // 客户端自报的本机版本，原样回显。判定在 Dart 侧做（纯函数），这里回显只是
    // 让手机能确认「后端比较的是我刚才报的那个版本」——缓存或串请求时这是唯一
    // 能看出来的地方。
    current: current || null,
    // 后端所在主机上正在运行的版本，**不参与**「有没有新版」的判定——手机端与
    // 平台是两条独立的版本线（pubspec 1.1.x vs 后端 1.2.x），拿它比会得到
    // 「你落后了」这种没有意义的结论。它只回答「这台后端跑的是什么」。
    backendRunningVersion: versionService.getCurrentVersion(),
    latest: resolved.latest,
    source: resolved.source,
    sourceLabel: resolved.sourceLabel,
    indeterminate: resolved.indeterminate,
    sources: resolved.sources,
    localSourceEnabled: localEnabled,
    releasePage: releasePageUrl(env),
    // 后端自己的更新状态原样透传（readState 的形状）：手机据此区分「发布链上有
    // 新版」和「新版已经就绪、后端在等自己重启」。这两件事对用户是两件事。
    platformUpdate: {
      state: platformState.state,
      channel: platformState.channel,
      pendingRestart: platformState.pendingRestart,
      checkedAt: platformState.checkedAt,
      targetVersion: (platformState.target && platformState.target.version) || null,
    },
  });
});

module.exports = router;

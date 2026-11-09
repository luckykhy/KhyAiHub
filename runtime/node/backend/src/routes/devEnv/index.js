'use strict';

/**
 * Express wrapper for the dev-environment inventory API ([DESIGN-ARCH-204]).
 *
 * The monolith mounts this router at /api/dev-env (one app.use line in
 * server.js, NO auth at the mount site) -- authMiddleware is applied HERE so
 * the gate cannot be bypassed by another mount of the same router. This mirrors
 * routes/clientApps; do NOT also add authMiddleware at the mount site (that
 * would double-authenticate).
 *
 * 盘点/安装/导入逻辑全部在 services/domain/network/dependency 门面（单一真源），
 * 路由只做信封与状态码映射：业务失败 409、客户端错 400、服务端错 500+code。
 * 长操作（scan/install/import）一律 job 化返 202，规避 HTTP 客户端默认超时。
 */

const express = require('express');

const { authMiddleware } = require('../../middleware/auth');
const dep = require('../../services/domain/network/dependency');
const jobs = require('../../services/domain/network/dependency/installJobs');

const router = express.Router();

router.use(authMiddleware);

// 错误码 → HTTP 状态码映射（clientApps 信封先例：{success, data|message, code}）。
function _fail(res, err, fallbackCode) {
  const code = err && err.code ? err.code : fallbackCode || 'DEV_ENV_ERROR';
  if (code === 'DEV_ENV_NO_INVENTORY') {
    return res.status(409).json({ success: false, message: err.message || '尚未盘点：请先运行扫描', code });
  }
  if (code === 'DEV_ENV_MANIFEST_INVALID' || code === 'DEV_ENV_UNKNOWN_DEP') {
    return res.status(400).json({ success: false, message: err.message || String(err), code });
  }
  return res.status(500).json({ success: false, message: (err && err.message) || String(err), code });
}

// GET /api/dev-env/catalog -- 盘点目录（语言→depId 元数据 + winget 可用性）。
router.get('/catalog', (req, res) => {
  try {
    const { searchExecutable } = dep.inventory.defaultDeps();
    const winget =
      process.platform === 'win32'
        ? (() => {
            const found = searchExecutable('winget');
            return found ? { present: true, detail: found } : { present: false, detail: 'winget 不在 PATH' };
          })()
        : { present: false, detail: '非 Windows 平台，winget 不适用' };
    res.json({
      success: true,
      data: {
        platform: process.platform,
        winget,
        toolchains: dep.devCatalog.map((e) => {
          const gate = e.kind === 'manual' ? dep.assertInstallable(e.depId) : null;
          return {
            depId: e.depId,
            language: e.language,
            label: e.label,
            kind: e.kind,
            aliases: e.aliases || [],
            versionable: dep.isVersionable(e.depId),
            versions: dep.supportedVersions(e.depId),
            docsUrl: (dep.getDependency(e.depId) || {}).docsUrl || null,
            // manual 条目带 installHint（registry curated 只读展示）——前端「复制
            // 安装命令」按钮的数据源，缺了它只能走兜底警告。
            installHint: gate ? gate.installHint || null : null,
            note: e.note || null,
          };
        }),
      },
    });
  } catch (err) {
    _fail(res, err);
  }
});

// POST /api/dev-env/scan -- 后台全量盘点（约 3-10s），job 化。
router.post('/scan', (req, res) => {
  try {
    const job = jobs.createJob('scan', async (report) => {
      report({ progress: '正在盘点开发环境（逐项探测与版本采集）' });
      const snapshot = await dep.scanInventory();
      const counts = dep.summarizeInventory(snapshot);
      return {
        ok: true,
        progress: `盘点完成：共 ${counts.total} 类，已装 ${counts.present} · 缺失 ${counts.missing} · 手动 ${counts.manual} · 信息 ${counts.informational}`,
        result: snapshot,
      };
    });
    res.status(202).json({ success: true, data: { jobId: job.jobId } });
  } catch (err) {
    _fail(res, err);
  }
});

// GET /api/dev-env/jobs/:jobId -- 轮询任务状态（kind 通用）。
router.get('/jobs/:jobId', (req, res) => {
  const view = jobs.getJobView(jobs.getJob(req.params.jobId));
  if (!view) {
    // 内存态任务表：进程重启即失（UI 如实显示，不假装可恢复）。
    return res.status(404).json({
      success: false,
      message: '任务不存在或已随进程重启清空：请重新发起扫描/安装/导入',
      code: 'DEV_ENV_JOB_NOT_FOUND',
    });
  }
  res.json({ success: true, data: view });
});

// GET /api/dev-env/inventory -- 读上次盘点快照，不触发探测。
router.get('/inventory', (req, res) => {
  try {
    const snapshot = dep.loadLatestSnapshot();
    if (!snapshot) {
      const err = new Error('尚未盘点：请先运行扫描');
      err.code = 'DEV_ENV_NO_INVENTORY';
      throw err;
    }
    res.json({ success: true, data: snapshot });
  } catch (err) {
    _fail(res, err);
  }
});

// POST /api/dev-env/install -- 单项安装（body: {depId, version?}），job 化。
router.post('/install', (req, res) => {
  try {
    const depId = String((req.body && req.body.depId) || '').trim();
    if (!depId) {
      return res.status(400).json({
        success: false,
        message: '缺少 depId：请求体应为 {"depId": "...", "version": "可选"}',
        code: 'DEV_ENV_UNKNOWN_DEP',
      });
    }
    // 存在性预检用 registry ∪ 盘点目录：html/css 是纯目录项（无 registry 条目），
    // 只按 registry 判会把 informational 误报成「未知依赖」（[DESIGN-ARCH-204] §6）。
    const known = dep.getDependency(depId) || dep.devCatalog.some((e) => e.depId === depId);
    if (!known) {
      return res.status(400).json({
        success: false,
        message: `未知依赖：${depId}（可选：${dep.devCatalog.map((e) => e.depId).join(', ')}）`,
        code: 'DEV_ENV_UNKNOWN_DEP',
      });
    }
    // 短路闸先于 buildInstallPlan：manual 条目在此拒绝，绝不构建执行计划。
    const gate = dep.assertInstallable(depId);
    if (!gate.ok) {
      const status = gate.code === 'DEV_ENV_UNKNOWN_DEP' ? 400 : 409;
      return res.status(status).json({
        success: false,
        message: gate.message,
        code: gate.code,
        data: { installHint: gate.installHint || null, note: gate.note || null },
      });
    }
    const version =
      req.body && req.body.version != null ? String(req.body.version).trim() || null : null;
    const job = jobs.createJob('install', async (report) => {
      report({ progress: `正在安装 ${depId}${version ? ' ' + version : ''}（第 1/1 项）` });
      const plan = dep.buildInstallPlan(depId, dep.defaultEnv(), { version });
      if (!plan) {
        return { ok: false, state: 'failed', progress: `安装未执行：${depId} 本平台无预置命令`, error: 'no-plan', command: null };
      }
      const run = await dep.runInstall(plan, { cwd: dep.defaultEnv().cwd });
      // 装后复验：必须真就绪才算成功（绝不「装了就当好」）。
      const after = dep.probe(depId);
      const ok = !!(run && run.ok) && after.present;
      // 终态 progress 随 result 返回（installJobs settle 时采纳覆写）。
      const progress = ok
        ? `安装完成并已校验就绪：${plan.label}${plan.version ? ' ' + plan.version : ''}`
        : run && run.ok
          ? `安装命令已执行，但 ${depId} 未探测到就绪：可能需重开终端刷新 PATH 后重扫`
          : `安装失败（${(run && run.error) || 'exit-nonzero'}）：${depId} 未就绪，可按提示手动重跑`;
      return {
        ok,
        state: ok ? 'succeeded' : 'failed',
        progress,
        depId,
        version: plan.version,
        requestedVersion: plan.requestedVersion,
        versionUnavailable: plan.versionUnavailable,
        command: plan.displayCommand,
        installOk: !!(run && run.ok),
        verified: after.present,
        error: run && !run.ok ? run.error || 'exit-nonzero' : null,
        hint: (run && run.hint) || null,
        probeDetail: after.detail || null,
      };
    });
    res.status(202).json({ success: true, data: { jobId: job.jobId } });
  } catch (err) {
    _fail(res, err);
  }
});

// POST /api/dev-env/export -- 以最近快照构建清单；服务端不落盘（返回 JSON 体）。
router.post('/export', (req, res) => {
  try {
    res.json({ success: true, data: dep.buildManifestFromLatest({ now: new Date() }) });
  } catch (err) {
    _fail(res, err);
  }
});

// POST /api/dev-env/import/preview -- 导入预览（永不执行安装）。
router.post('/import/preview', async (req, res) => {
  try {
    const manifest = req.body && req.body.manifest;
    const plan = await dep.previewImport(manifest, {});
    res.json({ success: true, data: plan });
  } catch (err) {
    _fail(res, err);
  }
});

// POST /api/dev-env/import/apply -- 导入执行（apply 内同样过 assertInstallable 闸）。
router.post('/import/apply', (req, res) => {
  try {
    const manifest = req.body && req.body.manifest;
    const job = jobs.createJob('import', async (report) => {
      const plan = await dep.applyImport(manifest, {
        onProgress: (info) => report({ progress: info.label }),
      });
      return {
        ok: plan.ok,
        state: plan.state,
        progress: `完成：成功 ${plan.succeeded} · 失败 ${plan.failed} · 跳过 ${plan.skipped.length}`,
        succeeded: plan.succeeded,
        failed: plan.failed,
        skipped: plan.skipped,
        results: plan.results,
      };
    });
    res.status(202).json({ success: true, data: { jobId: job.jobId } });
  } catch (err) {
    _fail(res, err);
  }
});

module.exports = router;

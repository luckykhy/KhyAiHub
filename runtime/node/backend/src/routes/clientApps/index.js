'use strict';

/**
 * Express wrapper for the client-app catalog + scan API.
 *
 * Design source: [DESIGN-ARCH-189]. S1 was read-only; **S2 adds the write path**
 * (/preview, /configure, /restore), so the RUNTIME-010 "read-only by execution
 * surface" argument no longer holds for this router -- it now holds for the
 * *scope* instead: /configure refuses apps whose managed files cannot be
 * backed up (see configure.js WRITE_BLOCKED), and a failed backup aborts
 * before a single byte is written.
 *
 * The monolith Express server (server.js) mounts this router at
 * /api/client-apps. Auth is admin-gated to match /api/cc-switch (ruling D5 = 1:
 * card switching rewrites each agent's live config, which is an admin-class
 * operation; no relaxed local-user criterion exists yet).
 *
 * Coverage is deliberately the ccSwitch-registered apps only (ruling D2 = 1).
 * Apps whose target file cannot be statically derived (coze: per-model paths)
 * or that have no managed file at all (command-code / ycode: env refs only)
 * are refused with an explicit reason rather than silently skipped.
 */

const express = require('express');

const { authMiddleware, adminMiddleware } = require('../../middleware/auth');

const router = express.Router();

router.use(authMiddleware);
router.use(adminMiddleware);

const { loadCatalog } = require('../../services/domain/config/clientApps/catalog.js');
const { scanAll } = require('../../services/domain/config/clientApps/scan.js');

// GET /api/client-apps/catalog -- the registry itself (single source of truth).
// Returns { apps, count, updated, version }. No filesystem probing happens here.
router.get('/catalog', (req, res) => {
  try {
    const catalog = loadCatalog();
    res.json({ success: true, data: catalog });
  } catch (err) {
    // CLIENT_APPS_CATALOG_MISSING / CLIENT_APPS_CATALOG_INVALID are operator
    // errors (someone edited catalog.json badly), not client errors -- surface
    // the message verbatim so `khy doctor` and the page can show the real cause.
    res.status(500).json({
      success: false,
      message: (err && err.message) || String(err),
      code: (err && err.code) || 'CLIENT_APPS_CATALOG_ERROR',
    });
  }
});

// POST /api/client-apps/scan -- probe this machine.
// Body: { apps?: string[] } to narrow to a subset of appIds; omit for all.
// Returns { gateway: { available, endpoint, reason }, apps: [...], count }.
// Tokens never cross the wire: scanAll() strips them by construction.
router.post('/scan', (req, res) => {
  try {
    const catalog = loadCatalog();
    const wanted = req.body && Array.isArray(req.body.apps) ? req.body.apps : null;
    const known = new Set(catalog.apps.map((a) => a.appId));
    const apps = wanted
      ? catalog.apps.filter((a) => wanted.includes(a.appId))
      : catalog.apps;

    // An unknown appId is a client mistake, not a silent empty result -- say so
    // rather than returning a shorter list that looks like a successful scan.
    const unknown = wanted ? wanted.filter((id) => !known.has(id)) : [];
    if (unknown.length) {
      return res.status(400).json({
        success: false,
        message: `未知的 appId：${unknown.join(', ')}`,
        code: 'CLIENT_APPS_UNKNOWN_APP_ID',
      });
    }

    res.json({ success: true, data: scanAll(apps) });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: (err && err.message) || String(err),
      code: (err && err.code) || 'CLIENT_APPS_SCAN_ERROR',
    });
  }
});

// POST /api/client-apps/preview -- 返回将要写入什么，不落盘。
// 「不静默」的一半：用户先看到 diff 再确认。
router.post('/preview', (req, res) => {
  try {
    const { appId, cardId } = req.body || {};
    if (!appId) {
      return res.status(400).json({ success: false, message: 'appId 必填', code: 'CLIENT_APPS_BAD_REQUEST' });
    }
    // 卡片真源在 ccSwitch；本端点只解析「该 app 会写哪些文件、用哪个 backupKey」，
    // 不碰卡片内容，故此处不取 card 也能给出有意义的预览。
    const { previewConfigure } = require('../../services/domain/config/clientApps/configure');
    const prev = previewConfigure({ appId, card: req.body.card || { id: cardId || null } });
    if (!prev.ok) {
      return res.status(409).json({ success: false, message: prev.reason, code: prev.code, data: prev });
    }
    res.json({ success: true, data: prev });
  } catch (err) {
    res.status(500).json({ success: false, message: (err && err.message) || String(err), code: (err && err.code) || 'CLIENT_APPS_PREVIEW_ERROR' });
  }
});

// POST /api/client-apps/configure -- 真实写入：备份 → 写 → 逐键回报。
// S2 起挂载。备份失败即在写之前中止，一个字节都不写。
router.post('/configure', async (req, res) => {
  try {
    const { appId, card, mode, cardId } = req.body || {};
    if (!appId || !card) {
      return res.status(400).json({ success: false, message: 'appId 与 card 必填', code: 'CLIENT_APPS_BAD_REQUEST' });
    }
    const { configureApp } = require('../../services/domain/config/clientApps/configure');
    const out = await configureApp({ appId, card, mode: mode || 'proxy', key: req.body.key, store: req.body.store });
    if (!out.ok) {
      // 409 而非 500：这是「本次没写成」的正常业务结果（被拒 / 备份失败 / 写失败），
      // 且 restored 里带了已回退的文件，前端要能展示。
      return res.status(409).json({ success: false, message: out.reason || out.error, data: out });
    }
    res.json({ success: true, data: out });
  } catch (err) {
    res.status(500).json({ success: false, message: (err && err.message) || String(err), code: (err && err.code) || 'CLIENT_APPS_CONFIGURE_ERROR' });
  }
});

// POST /api/client-apps/restore -- 恢复厂商配置（反向写）。
router.post('/restore', (req, res) => {
  try {
    const { appId, target } = req.body || {};
    if (!appId) {
      return res.status(400).json({ success: false, message: 'appId 必填', code: 'CLIENT_APPS_BAD_REQUEST' });
    }
    const { restoreApp } = require('../../services/domain/config/clientApps/configure');
    const out = restoreApp({ appId, target });
    if (!out.ok) {
      return res.status(409).json({ success: false, message: out.reason || out.error, data: out });
    }
    res.json({ success: true, data: out });
  } catch (err) {
    res.status(500).json({ success: false, message: (err && err.message) || String(err), code: (err && err.code) || 'CLIENT_APPS_RESTORE_ERROR' });
  }
});

module.exports = router;

const fs = require('fs');

const express = require('express');

const catalog = require('../services/downloadsCatalog');

const router = express.Router();

const PLATFORM_LABELS = {
  windows: 'Windows 安装包',
  android: 'Android 安装包',
};

function sendArtifact(res, artifact) {
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', artifact.size);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}`
  );

  const stream = fs.createReadStream(artifact.fullPath);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: '文件读取失败：产物在清单里有、读不出来，检查文件权限后重试' });
    } else {
      res.end();
    }
  });
  stream.pipe(res);
}

router.get('/list', (req, res) => {
  const data = catalog.listDownloads(process.env);
  // filePath 只在本机后端有意义（桌面端据此定位本地产物），不往外发。
  const strip = (item) => (item ? { fileName: item.fileName, size: item.size, updatedAt: item.updatedAt, url: item.url } : null);
  res.json({
    success: true,
    data: {
      web: data.web,
      windows: strip(data.windows),
      android: strip(data.android),
      fallback: data.fallback,
    },
  });
});

for (const platform of Object.keys(PLATFORM_LABELS)) {
  router.get(`/${platform}`, (req, res) => {
    const artifact = catalog.latestArtifact(platform);
    if (!artifact) {
      // 「不存在」与「读不出来」是两件事，分开说，并给出下一步。
      return res.status(404).json({
        success: false,
        message: `${PLATFORM_LABELS[platform]}不存在：产物目录里没有匹配文件。先构建该端（见 docs 的打包说明），或配置 KHY_DOWNLOAD_${platform.toUpperCase()}_DIR 指向已构建的产物目录。`,
      });
    }
    return sendArtifact(res, artifact);
  });
}

module.exports = router;

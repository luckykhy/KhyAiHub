'use strict';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function normalizeOrigin(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!/^https?:$/.test(url.protocol)) return '';
    return url.origin;
  } catch {
    return '';
  }
}

function parseConsumers() {
  const raw = String(process.env.KHYOS_SSO_CONSUMERS || '').trim();
  if (!raw) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((item) => item && typeof item.applicationId === 'string' && item.applicationId.trim())
    .map((item) => ({
      applicationId: item.applicationId.trim(),
      name: String(item.name || item.applicationId)
        .trim()
        .slice(0, 64),
      origins: Array.isArray(item.origins) ? item.origins.map(normalizeOrigin).filter(Boolean) : [],
      allowLoopback: item.allowLoopback !== false,
    }));
}

function findConsumer(applicationId) {
  const id = String(applicationId || '').trim();
  if (!id) return null;
  return parseConsumers().find((consumer) => consumer.applicationId === id) || null;
}

function normalizeReturnUrl(rawReturnUrl, consumer) {
  if (!consumer) return null;
  let url;
  try {
    url = new URL(String(rawReturnUrl || '').trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  if (url.username || url.password) return null;
  const hostname = url.hostname.toLowerCase();
  if (consumer.allowLoopback && LOOPBACK_HOSTS.has(hostname)) return url.toString();
  if (consumer.origins.includes(url.origin)) return url.toString();
  return null;
}

module.exports = { parseConsumers, findConsumer, normalizeReturnUrl };

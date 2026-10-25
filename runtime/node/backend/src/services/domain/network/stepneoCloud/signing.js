'use strict';

/**
 * stepneoCloud/signing.js — StepOS cloud gateway request signing (pure).
 *
 * The upstream at biz-gw.stepaos.com is not an open API: every request carries a
 * per-request HMAC over a fixed four-segment message. Nothing about the path,
 * body, token or device participates in it, so the signature is computed once
 * per request and the rest of the request is ordinary passthrough.
 *
 * Kept as a pure leaf with no IO so the whole risk surface is assertable with no
 * network and no credentials — same discipline as phone/phoneBridgePolicy.js.
 *
 *   sign = HMAC_SHA256(key = appSecret,
 *                      message = appId + nonce + timestamp + appSecret)
 *
 * Four segments concatenated with NO separator. Lowercase hex.
 */

const crypto = require('node:crypto');

/** appId used by the production gateway. The test twin is ai-engine-test. */
const PROD_APP_ID = 'ai-engine-prod';

/** Package name the gateway expects in zy-app-package. */
const PROD_APP_PACKAGE = 'com.stepos.aiengine';

/** Default gateway base. Overridable for the test twin (biz-gw-in.zyql.com). */
const DEFAULT_BASE_URL = 'https://biz-gw.stepaos.com/stepfun-proxy';

/**
 * Compute the zy-sign value.
 *
 * Exported separately from buildHeaders because the header builder needs a
 * nonce and timestamp it generates itself, and a caller that already has both
 * (a retry, a test) should not have to regenerate them to re-derive the sign.
 */
function computeSign({ appId, appSecret, nonce, timestamp }) {
  for (const [name, value] of Object.entries({ appId, appSecret, nonce, timestamp })) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`computeSign: ${name} must be a non-empty string`);
    }
  }
  return crypto
    .createHmac('sha256', appSecret)
    .update(appId + nonce + timestamp + appSecret)
    .digest('hex');
}

/**
 * Build the full header set for one upstream request.
 *
 * `now` and `createNonce`/`createTraceId` are injectable so tests are
 * deterministic; they default to the real thing. The server validates the
 * timestamp, so a badly-skewed clock fails here and not somewhere confusing.
 */
function buildHeaders({
  token,
  appId = PROD_APP_ID,
  appSecret,
  deviceId,
  sceneType = 'chat',
  appPackage = PROD_APP_PACKAGE,
  clientType = 'Android',
  traceId,
  nonce,
  timestamp,
  now = () => Date.now(),
  createNonce = () => crypto.randomUUID().replace(/-/g, ''),
  createTraceId = () => crypto.randomUUID().replace(/-/g, ''),
}) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('buildHeaders: token must be a non-empty string');
  }
  if (typeof appSecret !== 'string' || appSecret.length === 0) {
    // Deliberately not defaulted. A silently-wrong secret produces 401s that
    // look like an expired token, which sends people renewing the wrong thing.
    throw new TypeError('buildHeaders: appSecret must be a non-empty string');
  }
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    throw new TypeError('buildHeaders: deviceId must be a non-empty string');
  }

  const resolvedNonce = nonce || createNonce();
  const resolvedTimestamp = timestamp || String(now());

  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'zy-app-id': appId,
    'zy-app-package': appPackage,
    'zy-client-type': clientType,
    'zy-scene-type': sceneType,
    'zy-device-id': deviceId,
    'zy-nonce': resolvedNonce,
    'zy-timestamp': resolvedTimestamp,
    'zy-sign': computeSign({
      appId, appSecret, nonce: resolvedNonce, timestamp: resolvedTimestamp,
    }),
    'zy-trace-id': traceId || createTraceId(),
  };
}

module.exports = {
  PROD_APP_ID,
  PROD_APP_PACKAGE,
  DEFAULT_BASE_URL,
  computeSign,
  buildHeaders,
};

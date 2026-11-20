/**
 * Audit Log Middleware
 *
 * Access & Routing Layer (接入与路由层) - Step 2 of 5 in the middleware chain.
 * Logs write operations (POST/PUT/DELETE) to the audit_logs table
 * for security traceability. See thesis Chapter 4.2, Table 12.
 */
const { QueryTypes } = require('sequelize');

const { sequelize } = require('../config/database');
const logger = require('../utils/logger');


// Remove sensitive fields from logged body
//
// 此前只对**顶层**的固定字段名做替换，名单也跟实际入参名脱节：newPassword /
// currentPassword / confirmPassword / securityAnswer / sendKey / refreshToken
// 这些真正出现在请求体里的字段全部原样入库（明文密码与密保答案落到
// audit_logs 表）。现在改为**按键名递归脱敏**，名单与 routes 的入参名保持一致。
//
// 不做「高熵长串兜底替换」：那会把 commit sha、对象 ID、base64 内容一并抹掉，
// 审计日志会失去可追溯性。键名匹配足够精确，且新增敏感字段时由测试锁住名单。
const SENSITIVE_BODY_KEYS = new Set([
  // 口令类
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'newpassword',
  'currentpassword',
  'confirmpassword',
  'oldpassword',
  // 令牌类
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apitoken',
  'authorization',
  // 密钥类
  'secret',
  'clientsecret',
  'apikey',
  'api_key',
  'key',
  'credential',
  'credentials',
  'privatekey',
  'sessionkey',
  'signature',
  'sendkey',
  'securitykey',
  // 密保 / 二次验证
  'securityanswer',
  'otp',
  'totp',
  'mfa_code',
]);

function sanitizeValue(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = SENSITIVE_BODY_KEYS.has(String(key).toLowerCase()) ? '[REDACTED]' : sanitizeValue(val);
    }
    return out;
  }
  return value;
}

// Ensure audit_logs table exists
async function ensureAuditTable() {
  if (tableReady) {
    return;
  }
  try {
    const dialect = sequelize.getDialect?.() || 'sqlite';
    const isSQLite = dialect === 'sqlite';
    await sequelize.query(
      `CREATE TABLE IF NOT EXISTS audit_logs (` +
        `id ${isSQLite ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'SERIAL PRIMARY KEY'},` +
        `user_id INTEGER,` +
        `username VARCHAR(255),` +
        `method VARCHAR(10) NOT NULL,` +
        `path VARCHAR(512) NOT NULL,` +
        `body ${isSQLite ? 'TEXT' : 'JSONB'},` +
        `status_code INTEGER,` +
        `ip VARCHAR(45),` +
        `user_agent TEXT,` +
        `created_at ${isSQLite ? 'DATETIME DEFAULT CURRENT_TIMESTAMP' : 'TIMESTAMP WITH TIME ZONE DEFAULT NOW()'}` +
        `)`
    );
    tableReady = true;
  } catch (err) {
    logger.warn('Could not create audit_logs table (may already exist or DB not ready)', {
      error: err.message,
    });
  }
}

// Initialize table on first load
let tableReady = false;

function auditLog(req, res, next) {
  // Only audit mutating methods
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return next();
  }

  // Skip health checks and high-frequency endpoints
  if (req.originalUrl.includes('/health') || req.originalUrl.includes('/cache')) {
    return next();
  }

  const originalEnd = res.end;
  res.end = function (...args) {
    res.end = originalEnd;
    res.end(...args);

    // Fire-and-forget audit insert
    const record = {
      userId: req.user?.id || null,
      username: req.user?.username || null,
      method: req.method,
      path: req.originalUrl,
      body: sanitizeBody(req.body),
      statusCode: res.statusCode,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };

    insertAuditLog(record).catch((err) => {
      logger.warn('Audit log insert failed', { error: err.message });
    });
  };

  next();
}

async function insertAuditLog(record) {
  if (!tableReady) {
    await ensureAuditTable();
    tableReady = true;
  }

  await sequelize.query(
    `INSERT INTO audit_logs (user_id, username, method, path, body, status_code, ip, user_agent)
     VALUES (:userId, :username, :method, :path, :body, :statusCode, :ip, :userAgent)`,
    {
      replacements: {
        ...record,
        body: record.body ? JSON.stringify(record.body) : null,
      },
      type: QueryTypes.INSERT,
    }
  );
}

function sanitizeBody(body) {
  if (!body || typeof body !== 'object') {
    return null;
  }
  return sanitizeValue(body);
}

module.exports = auditLog;
// sanitizeBody 是纯函数，导出以便单测直接锁住脱敏契约（SEC-05）：
// 请求体里真正出现的字段名（newPassword / securityAnswer / sendKey…）与
// 嵌套结构都必须被脱敏。
module.exports.sanitizeBody = sanitizeBody;

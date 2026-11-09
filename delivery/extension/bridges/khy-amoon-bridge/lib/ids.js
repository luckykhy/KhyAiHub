'use strict';

/**
 * ids.js — the id vocabulary used by mailbox files, jobs and idempotency keys.
 * IDs are 8..64 chars of [A-Za-z0-9_-] (contracts.ID_RE).
 */

const crypto = require('crypto');

const C = require('./contracts');

/**
 * Generate a fresh id, optionally with a prefix. The result always satisfies
 * contracts.isValidId().
 *
 * @param {string} [prefix]
 * @returns {string}
 */
function newId(prefix = '') {
  const cleanPrefix = String(prefix || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  const random = crypto.randomBytes(16).toString('base64url');
  return `${cleanPrefix}${random}`.slice(0, 64);
}

/**
 * @param {unknown} id
 * @returns {boolean}
 */
function isValidId(id) {
  return C.isValidId(id);
}

module.exports = {
  newId,
  isValidId,
};

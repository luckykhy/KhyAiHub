'use strict';

/**
 * Contract path shim: protocol helpers live in lib/mailbox.js.
 */

const mailbox = require('../mailbox');

module.exports = {
  buildCommand: mailbox.buildCommand,
  parseCommand: mailbox.parseCommand,
  buildResult: mailbox.buildResult,
  parseExpiry: mailbox.parseExpiry,
  COMMAND_FILE_RE: mailbox.COMMAND_FILE_RE,
  RESULT_FILE_RE: mailbox.RESULT_FILE_RE,
  FILE_PRINCIPAL: mailbox.FILE_PRINCIPAL,
  FILE_SCOPE_TOOLS: mailbox.FILE_SCOPE_TOOLS,
};

'use strict';

/**
 * Contract path shim: poller lives in lib/mailbox.js.
 */

const mailbox = require('../mailbox');

module.exports = {
  createMailboxPoller: mailbox.createMailboxPoller || mailbox.createMailbox,
  createMailbox: mailbox.createMailbox,
};

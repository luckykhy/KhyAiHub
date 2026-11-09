'use strict';

/**
 * Contract path shim.
 *
 * The delivered HTTP front-end keeps routing inside lib/server.js#createServer
 * (a single http.createServer callback with /health,/status,/call). There is no
 * separate router object, so this adapter exists only to keep the frozen path
 * importable and to fail loudly instead of pretending routing is available.
 */

const C = require('../contracts');

function createRouter() {
  throw new C.BridgeError(
    'not_implemented',
    '路由内聚在 lib/server.js#createServer；lib/http/routes.js 没有独立 router，请使用 createServer()。'
  );
}

module.exports = { createRouter };

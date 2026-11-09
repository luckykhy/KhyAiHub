'use strict';

/**
 * Contract path shim: the HTTP server lives in lib/server.js.
 */

const server = require('../server');

module.exports = {
  createServer: server.createServer,
  createHttpServer: server.createServer,
  createRateLimiter: server.createRateLimiter,
  resolveConfig: server.resolveConfig,
  DEFAULT_HOST: server.DEFAULT_HOST,
};

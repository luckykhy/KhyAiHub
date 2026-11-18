'use strict';

// ./client 出口：浏览器/第三方 attached 只走这里；Node 宿主用 ./locator-host。
const { obtainCore } = require('./obtain-core');

module.exports = { obtainCore };

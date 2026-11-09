'use strict';

const C = require('../contracts');

module.exports = {
  getDescriptor: (name) => C.getTool(name),
  listDescriptors: (scope) => (scope ? C.listToolsForScope(scope) : C.TOOLS.slice()),
  TOOLS: C.TOOLS,
  PHASE2_TOOL_NAMES: C.PHASE2_TOOL_NAMES,
};

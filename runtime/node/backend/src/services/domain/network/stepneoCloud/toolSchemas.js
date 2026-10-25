'use strict';

/**
 * stepneoCloud/toolSchemas.js — turn the phone bridge's tool table into OpenAI
 * function-calling schemas (pure).
 *
 * WHY THIS IS A CONVERSION AND NOT A SECOND TABLE. The bridge already owns the
 * authoritative description of every device tool: arg types, bounds, which are
 * required, what each one does, and how large a result may be. Writing a second
 * schema table here would create exactly the drift this repo keeps warning
 * about — the model would be told about a `recursive` flag the bridge rejects,
 * or miss one it requires.
 *
 * So the conversion is mechanical and lossless in the directions that matter:
 * the model sees the same arg names, types, bounds and descriptions the bridge
 * will validate against.
 */

const { getPhoneBridgeTools, getPhoneBridgeUiTools, UI_TOOL_ACCESS } = require('../phone/phoneBridgeCatalog');

/**
 * Arg specs for the UI tools, transcribed from the bridge's own KhyUi dispatch.
 *
 * These live here rather than in the catalog because the catalog covers the
 * non-UI tools only — UI_TOOLS is a bare name list. Every name and bound below
 * was read off KhyUi.java, not guessed: a wrong name means the bridge silently
 * drops the arg and the model's tap lands nowhere.
 *
 * `ui_tap` takes x/y only (its neighbour longpress is where `ms` lives);
 * `ui_click`/`ui_type` address a node by id or by visible text; `ui_swipe` is
 * the only one with two points.
 */
const UI_TOOL_ARGS = {
  ui_dump: {
    max_nodes: { type: 'integer', minimum: 1, maximum: 5000, description: '最多返回多少个节点，默认 2000，上限 5000' },
  },
  ui_tap: {
    x: { type: 'integer', required: true, description: '横坐标（像素）' },
    y: { type: 'integer', required: true, description: '纵坐标（像素）' },
  },
  ui_click: {
    id: { type: 'string', description: '节点 resource-id，优先于 text' },
    text: { type: 'string', description: '节点可见文本，id 缺失时用它' },
  },
  ui_swipe: {
    x1: { type: 'integer', required: true, description: '起点横坐标' },
    y1: { type: 'integer', required: true, description: '起点纵坐标' },
    x2: { type: 'integer', required: true, description: '终点横坐标' },
    y2: { type: 'integer', required: true, description: '终点纵坐标' },
    ms: { type: 'integer', minimum: 1, description: '滑动耗时毫秒，默认 300' },
    text: { type: 'string', description: '备用：按可见文本滑动' },
  },
  ui_longpress: {
    x: { type: 'integer', required: true, description: '横坐标' },
    y: { type: 'integer', required: true, description: '纵坐标' },
    ms: { type: 'integer', minimum: 200, maximum: 10000, description: '按住毫秒，默认 700，范围 200–10000' },
  },
  ui_type: {
    id: { type: 'string', description: '输入框 resource-id' },
    text: { type: 'string', required: true, description: '要输入的文字' },
  },
  ui_back: {},
  ui_home: {},
  ui_recents: {},
  shot: {
    maxw: { type: 'integer', minimum: 64, description: '缩放后最大宽度，默认 480' },
    quality: { type: 'integer', minimum: 10, maximum: 100, description: 'JPEG 质量，默认 60' },
    path: { type: 'string', description: '保存路径；不给则只返回尺寸信息' },
  },
  shot_b64: {
    maxw: { type: 'integer', minimum: 64, description: '缩放后最大宽度，默认 480' },
    quality: { type: 'integer', minimum: 10, maximum: 100, description: 'JPEG 质量，默认 60' },
  },
};

const UI_TOOL_SUMMARY = {
  ui_dump: '读取当前界面节点树（含 resource-id 与文本），用于定位可点击目标',
  ui_tap: '在指定坐标点击',
  ui_click: '按 resource-id 或可见文本点击节点',
  ui_swipe: '从 (x1,y1) 滑动到 (x2,y2)',
  ui_longpress: '在指定坐标长按',
  ui_type: '往输入框输入文字',
  ui_back: '系统返回键',
  ui_home: '系统 Home 键',
  ui_recents: '系统多任务键',
  shot: '截屏并保存到路径（需 API 30+）',
  shot_b64: '截屏并以 base64 返回',
};

/**
 * Map a catalog arg spec onto a JSON-Schema property.
 *
 * The catalog already speaks a JSON-Schema dialect (type / required / minimum /
 * maximum / maxLength / description), so this is mostly a rename pass. The one
 * thing added is `additionalProperties: false`, because a model that invents an
 * arg gets it silently dropped by the bridge's validator — and a silently
 * dropped arg is how "I asked for recursive" becomes a no-op.
 */
function argSpecToJsonSchema(spec) {
  const schema = {
    type: spec.type,
    description: spec.description || '',
  };
  if (spec.minimum !== undefined) schema.minimum = spec.minimum;
  if (spec.maximum !== undefined) schema.maximum = spec.maximum;
  if (spec.maxLength !== undefined) schema.maxLength = spec.maxLength;
  if (spec.enum) schema.enum = spec.enum;
  if (spec.default !== undefined) schema.default = spec.default;
  return schema;
}

/** One catalog entry -> one OpenAI function schema. */
function toolToFunctionSchema(tool) {
  const properties = {};
  const required = [];
  for (const [argName, spec] of Object.entries(tool.args || {})) {
    properties[argName] = argSpecToJsonSchema(spec);
    if (spec.required) required.push(argName);
  }

  // The confirm flag is part of the bridge's contract, not an invention of this
  // layer: planBridgeCall() refuses to execute an actuating tool without it.
  // Without it in the schema the model cannot express approval at all.
  if (tool.access === 'actuate') {
    properties.confirm = {
      type: 'boolean',
      description: '显式确认执行。这个工具会改变手机状态，必须传 confirm:true 才会真正执行；'
        + '不传则只会返回将要执行的内容，不会动手机。',
    };
  }

  return {
    type: 'function',
    function: {
      name: tool.khyName || tool.bridgeName,
      description: [tool.summary, tool.note].filter(Boolean).join('\n\n'),
      parameters: {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
      },
    },
  };
}

/**
 * The full tool list handed to the model.
 *
 * UI tools are included only when the bridge reports the accessibility service
 * is up. Advertising a tool the bridge will refuse is worse than omitting it:
 * the model burns a round trip discovering the refusal, and the refusal reads
 * as "the capability does not exist".
 *
 * @param {{includeUi?: boolean}} [opts]
 * @returns {Array<{type:'function', function: object}>}
 */
function buildToolSchemas({ includeUi = true } = {}) {
  const schemas = getPhoneBridgeTools().map(toolToFunctionSchema);
  if (includeUi) {
    // getPhoneBridgeUiTools() is a NAME list, not objects — the catalog keeps
    // UI_TOOLS as strings and carries the access level in UI_TOOL_ACCESS. The
    // arg specs come from UI_TOOL_ARGS above.
    for (const name of getPhoneBridgeUiTools()) {
      schemas.push(toolToFunctionSchema({
        bridgeName: name,
        khyName: name,
        access: UI_TOOL_ACCESS[name] === 'actuate' ? 'actuate' : 'read',
        args: UI_TOOL_ARGS[name] || {},
        summary: UI_TOOL_SUMMARY[name] || `手机界面操作：${name}`,
        note: '需要无障碍服务已开启，否则桥会直接拒绝。',
      }));
    }
  }
  return schemas;
}

/**
 * Reverse map: a schema name back to the bridge tool name.
 *
 * The model only ever sees khyName (phone_exec, ...), but the bridge is called
 * by bridgeName (exec, ...). Aliases exist for exactly this reason and the
 * catalog already resolves them; this wrapper keeps the lookup in one place so
 * the agent loop does not reach into the catalog itself.
 */
function createToolNameResolver() {
  const byKhyName = new Map();
  for (const tool of getPhoneBridgeTools()) {
    byKhyName.set(tool.khyName || tool.bridgeName, tool.bridgeName);
    for (const alias of tool.aliases || []) {
      byKhyName.set(alias, tool.bridgeName);
    }
  }
  // UI tools are their own bridge names — there is no khyName/bridgeName split.
  for (const name of getPhoneBridgeUiTools()) {
    byKhyName.set(name, name);
  }
  return {
    /** @returns {string|null} the bridge name, or null if unknown */
    resolve(name) {
      return byKhyName.get(name) || null;
    },
    has(name) {
      return byKhyName.has(name);
    },
  };
}

module.exports = {
  argSpecToJsonSchema,
  toolToFunctionSchema,
  buildToolSchemas,
  createToolNameResolver,
};

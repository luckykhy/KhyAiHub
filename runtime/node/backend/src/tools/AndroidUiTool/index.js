'use strict';

/**
 * AndroidUiTool — drive the Android screen by element ref
 * (dump -> digest -> act -> re-check).
 *
 * No accessibility service and no APK on the phone: everything goes through adb's
 * uiautomator dump and input commands. Element refs, the compact digest and the
 * post-action change detection come from the vendored android-agent-kit
 * (uidref / screendiff); the logic lives in
 * services/domain/network/phone/androidRef/. This file only holds the gate,
 * schema and delegation.
 *
 * Safety: write actions return a plan unless params.confirm === true; text input
 * only sends numeric keyevent codes (never `adb shell input text` — that is a
 * device-shell injection surface).
 *
 * Gate KHY_ANDROID_UI_TOOL (parent KHY_PHONE_BRIDGE, declared in flagRegistry).
 * Off -> this module exports a benign non-tool object, discovery skips it.
 */

const { BaseTool } = require('../_baseTool');

function _gateEnabled(env = process.env) {
  try {
    return require('../../utils/flagRegistry').isFlagEnabled('KHY_ANDROID_UI_TOOL', env);
  } catch {
    const raw = env && env.KHY_ANDROID_UI_TOOL;
    if (raw === undefined || raw === null) {
      return true;
    }
    return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
  }
}

const ACTIONS = ['snapshot', 'tap', 'longpress', 'swipe', 'back', 'home', 'recents', 'type'];

class AndroidUiTool extends BaseTool {
  static toolName = 'AndroidUi';
  static category = 'system';
  static risk = 'high'; // the phone screen changes; the approval layer gates on this on top of confirm
  static aliases = ['android_ui', '安卓界面', '手机界面', 'android_gui'];
  static searchHint = 'drive the Android screen by element ref（按 ref 点按/滑动/输入手机界面并复检效果）';
  static shouldDefer = true;
  static maxResultSizeChars = 20000;

  isReadOnly() {
    return false;
  }

  isConcurrencySafe() {
    return false;
  }

  isDestructive(input) {
    const action = (input && input.action) || 'snapshot';
    return action !== 'snapshot';
  }

  prompt() {
    return `- Drive the user's OWN Android screen over adb by element ref: snapshot/tap/longpress/swipe/back/home/recents/type
- Use for: reading the screen as a compact digest (ref e14, label, bounds) and acting on a ref; each write is re-checked
- Do NOT use for: the PC (DesktopControl), files/shell (PhoneBridge), or CJK text
- Workflow: snapshot first, then pick a ref; coordinates resolved server-side, never guessed
- WRITE actions need confirm:true, else you get only the plan. type takes lowercase ASCII only
- Inconclusive re-check returns effective:null, not "no effect"; do not retry blindly`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description:
            'What to do. "snapshot" reads the screen; the rest act on it. Default "snapshot". Example: "tap".',
        },
        ref: {
          type: 'string',
          description:
            'Element ref from the latest snapshot digest, e.g. "e14". Required for tap/longpress/swipe/type; ignored by back/home/recents.',
        },
        text: {
          type: 'string',
          maxLength: 80,
          description:
            'For action "type": lowercase ASCII text, max 80 chars. Uppercase, CJK, quotes, backtick, $ and newlines are refused. Example: "hello 123".',
        },
        direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          description: 'For action "swipe": swipe direction starting at the element center. Example: "up".',
        },
        distance: {
          type: 'integer',
          minimum: 100,
          maximum: 1500,
          description:
            'For action "swipe": swipe distance in device pixels (default: 300, range 100-1500). Example: 600.',
        },
        confirm: {
          type: 'boolean',
          description:
            'Must be true to actually run a WRITE action. Without it only the plan is returned. Example: true.',
        },
      },
      required: [],
    };
  }

  getActivityDescription(input) {
    const action = (input && input.action) || 'snapshot';
    const ref = input && input.ref ? ` ${input.ref}` : '';
    return `Android 界面:${action}${ref}`;
  }

  async execute(params = {}, _context) {
    const action = (params && params.action) || 'snapshot';
    if (!ACTIONS.includes(action)) {
      return { success: false, error: `未知 action:${action}；可用：${ACTIONS.join(' / ')}` };
    }
    try {
      const refService = require('../../services/domain/network/phone/androidRef');
      const client = refService.getAndroidRef(process.env);
      return await client.run({
        action,
        ref: params && params.ref,
        text: params && params.text,
        direction: params && params.direction,
        distance: params && params.distance,
        confirm: params && params.confirm === true,
      });
    } catch (err) {
      return {
        success: false,
        error: `AndroidUi 执行失败：${(err && err.message) || String(err)}`,
        hint: '先跑一次 action:"snapshot" 确认手机在线、adb 可用；仍失败就用 khy phone status 看桥状态。',
      };
    }
  }
}

if (!_gateEnabled(process.env)) {
  module.exports = { _khyAndroidUiDisabled: true };
} else {
  module.exports = new AndroidUiTool();
  module.exports.AndroidUiTool = AndroidUiTool;
}

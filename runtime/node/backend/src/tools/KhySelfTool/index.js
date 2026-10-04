const { BaseTool } = require('../_baseTool');

/**
 * KhySelfTool — agent 的自省工具:按需查询「我有哪些功能 + 我装在哪 + 我的源码在哪 +
 * 我有哪些边界/能力域 + 我的已知问题」。
 *
 * goal「khy 要清楚知道自己有什么功能、装在哪里,不要调用自身功能找不到、搜索自身文件
 * 也找不到,让 khyos 的自知更加清晰」的**主动查询面**。系统提示已推送截断的自知概览
 * (selfProfile.formatForSystemPrompt),本工具补**可查询**面。
 *
 * 分面由 selfProfile.SELF_FACETS 单一真源派生(见 [DESIGN-ARCH-153])——本工具**不再**
 * 手维护自己的 action 枚举,否则就会像修前那样与 `/self`(CLI 人类面)分叉:
 * 彼时两面并集 8 个分面、交集只有 location。
 *
 * 分面(每个都可用其别名调用):
 *   identity            名称/版本/定位/性格              (whoami, id)
 *   capabilities        能力域                            (capability, cap, features)
 *   boundaries          能力边界(含不支持的清单)          (boundary, limits, limitations)
 *   runtime             平台/Node/Python/cwd/通道/推理     (env, environment, status)
 *   location            安装根/自身源码/dataHome/安装类型  (where, install, khy_where)
 *   commands            命令目录(可用 query 过滤)          (command, cmd, catalog)
 *   self_audit          自审报告(已知问题+严重度+现状)      (audit, issues)
 *   self_audit_verify   自审证据逐项运行时核验              (audit_verify, evidence)
 *   all(默认)           location + commands + self_audit 概览 + 可用分面清单
 *
 * 只读、并发安全、绝不抛(内部失败 → success:false + error,不影响会话)。
 */
class KhySelfTool extends BaseTool {
  static toolName = 'KhySelf';
  static category = 'system';
  static risk = 'safe';
  static aliases = ['khy_self', 'self_info', 'whoami_khy', 'khy_where', 'self_locate'];
  static searchHint =
    'khy self introspection what commands do I have where am I installed find my own source files install location command catalog capabilities boundaries runtime self audit';

  isReadOnly() {
    return true;
  }
  isConcurrencySafe() {
    return true;
  }

  /** 分面 SSOT(单一真源,惰性取;取不到 → null,由调用方诚实降级)。 */
  _selfProfile() {
    try {
      const sp = require('../../services/selfProfile');
      return sp && Array.isArray(sp.SELF_FACETS) ? sp : null;
    } catch {
      return null;
    }
  }

  /** 静态兜底分面表:仅在 selfProfile 不可解析时使用,保证 schema 仍可构造。 */
  static _FALLBACK_FACETS = [
    'identity',
    'capabilities',
    'boundaries',
    'runtime',
    'location',
    'commands',
    'self_audit',
    'self_audit_verify',
  ];

  static _facetKeys() {
    try {
      const sp = require('../../services/selfProfile');
      if (sp && Array.isArray(sp.SELF_FACETS) && sp.SELF_FACETS.length > 0) {
        return sp.SELF_FACETS.map((f) => f.key);
      }
    } catch {
      /* fall through to static list */
    }
    return KhySelfTool._FALLBACK_FACETS.slice();
  }

  prompt() {
    const facets = KhySelfTool._facetKeys().join(' | ');
    return `Introspect khy itself — what it can do, where it is installed, and what its known limits are.

Use this when you need to:
- Find which slash/router commands exist before invoking one (don't guess names).
- Search khy's own command catalog by keyword (e.g. "gateway", "model").
- Learn the ABSOLUTE path to khy's own source dir so you can Grep/Glob/Read your own code
  (those tools accept absolute paths outside the user's working directory).
- Report where khy is installed (install root, data home, install kind: npm/pip/dev).
- Answer "what are khy's capabilities / boundaries / runtime" from ground truth instead of guessing.
- Answer "what are khy's biggest problems / your limitations" from the self-audit SSOT, and
  INDEPENDENTLY verify it against the live filesystem with "self_audit_verify".

action (one of): ${facets} | "all" (default = location + commands + self_audit overview).
Aliases are accepted (where/install → location, cap/features → capabilities, audit → self_audit,
evidence/verify → self_audit_verify, whoami → identity, env/status → runtime, cmd/catalog → commands).

Returns structured data under "facet" ({ok, facet, data, reason?}); the legacy top-level keys
(location / commands / selfAudit / selfAuditVerify) are still populated for the four original
actions. Do not confuse khy's own source dir with the user's project cwd.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...KhySelfTool._facetKeys(), 'all'],
          description: 'What to introspect. Default "all". Aliases accepted.',
        },
        query: {
          type: 'string',
          description:
            'When action is "commands": filter by keyword across command name/label/description.',
        },
      },
    };
  }

  /** 既有顶层键的兼容映射(四个原 action 的返回形状不回归)。 */
  static _LEGACY_KEY = {
    location: 'location',
    commands: 'commands',
    self_audit: 'selfAudit',
    self_audit_verify: 'selfAuditVerify',
  };

  /** 把分面 envelope 转成对外 error 文案(保持既有措辞契约,只补上具体原因)。 */
  _errorFor(facet, reason) {
    if (facet === 'self_audit_verify') {
      return `khy self-audit verification unavailable (${reason})`;
    }
    if (facet === 'self_audit') {
      return `khy self-audit unavailable (${reason})`;
    }
    return `KhySelf introspect '${facet}' unavailable (${reason})`;
  }

  async execute(params = {}) {
    const facets = this._selfProfile();
    const fallback = KhySelfTool._FALLBACK_FACETS;

    // action 归一:显式 'all' → all;别名/规范名 → 其 canonical key;未知 → 默认 all。
    let requested = null;
    if (params && typeof params.action === 'string' && params.action.trim()) {
      const raw = params.action.trim();
      if (raw.toLowerCase() === 'all') {
        requested = 'all';
      } else if (facets && typeof facets.resolveFacetKey === 'function') {
        requested = facets.resolveFacetKey(raw);
      } else if (fallback.includes(raw.toLowerCase())) {
        requested = raw.toLowerCase();
      }
    }
    const action = requested || 'all';

    // selfProfile 不可解析 → 诚实上报,不伪造。
    if (!facets || typeof facets.getSelfFacet !== 'function') {
      return {
        success: false,
        action,
        error:
          'khy self-introspection unavailable (selfProfile.getSelfFacet not resolvable in this context).',
      };
    }

    const takeFacet = (key) => facets.getSelfFacet(key, { query: params.query });

    try {
      // ── all:概览(location + commands + self_audit) + 可用分面清单 ──────────
      if (action === 'all') {
        const result = { success: true, action: 'all' };
        const loc = takeFacet('location');
        if (loc.ok) {
          result.location = loc.data;
          result.location.hint = loc.data.selfSrcDir
            ? `To read/search khy's own code, pass this ABSOLUTE path to Grep/Glob/Read: ${loc.data.selfSrcDir}`
            : 'Self source dir unresolved.';
        }
        const cmds = takeFacet('commands');
        if (cmds.ok) {
          result.commands = cmds.data;
        }
        const audit = takeFacet('self_audit');
        if (audit.ok) {
          result.selfAudit = audit.data;
        }
        // 分面清单:让模型知道还有哪些面可查(否则它只能猜 action 名)。
        result.facets = facets.SELF_FACETS.map((f) => ({
          key: f.key,
          aliases: f.aliases,
          summary: f.summary,
        }));
        if (result.location === undefined && result.commands === undefined) {
          return {
            success: false,
            action: 'all',
            error:
              'khy self-introspection unavailable (selfProfile/commandCatalog not resolvable in this context).',
          };
        }
        return result;
      }

      // ── 单分面 ────────────────────────────────────────────────────────────
      const env = takeFacet(action);
      const result = {
        success: env.ok,
        action,
        facet: env,
      };
      if (!env.ok) {
        result.error = this._errorFor(action, env.reason);
        return result;
      }
      // 既有顶层键:四个原 action 的返回形状逐字节保留(消费方与既有测试不回归)。
      const legacyKey = KhySelfTool._LEGACY_KEY[action];
      if (legacyKey) {
        result[legacyKey] = env.data;
      }
      // location 的 Read/Grep 指引是既有契约的一部分。
      if (action === 'location' && result.location) {
        result.location.hint = result.location.selfSrcDir
          ? `To read/search khy's own code, pass this ABSOLUTE path to Grep/Glob/Read: ${result.location.selfSrcDir}`
          : 'Self source dir unresolved.';
      }
      return result;
    } catch (err) {
      return {
        success: false,
        action,
        error: `KhySelf introspection failed: ${err && err.message ? err.message : String(err)}`,
      };
    }
  }
}

module.exports = KhySelfTool;
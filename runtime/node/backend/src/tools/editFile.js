/**
 * Edit File — precise string replacement tool.
 *
 * Instead of overwriting entire files (which destroys unrelated code),
 * this tool finds a unique substring and replaces it.  If the substring
 * is not unique the call fails — the caller must supply more context.
 *
 * Modelled after Claude Code's Edit tool.
 */
const fs = require('fs');
const path = require('path');

const { defineTool } = require('./_baseTool');
let _fileHistory;
try {
  _fileHistory = require('../services/fileHistoryService');
} catch {
  _fileHistory = null;
}

// Read-before-edit enforcement: reject edits to files the agent has not read
// in this session, and reject edits to files modified externally since last
// read. Prevents blind edits that clobber content the agent never saw.
// Infrastructure lives in _readTracker.js (markRead/hasRead/isStale); this
// is the consumption point. Gate KHY_ENFORCE_READ_BEFORE_EDIT (default on).
let _readTracker;
try {
  _readTracker = require('./_readTracker');
} catch {
  _readTracker = null;
}

function _isReadBeforeEditEnabled() {
  const v = String(process.env.KHY_ENFORCE_READ_BEFORE_EDIT || 'true')
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

function _checkReadBeforeEdit(absPath) {
  if (!_isReadBeforeEditEnabled() || !_readTracker) {
    return { ok: true };
  }
  if (typeof _readTracker.hasRead === 'function' && !_readTracker.hasRead(absPath)) {
    return {
      ok: false,
      error: `文件未读取：请先用 readFile 读取 ${path.basename(absPath)} 后再编辑（防盲改）`,
    };
  }
  if (typeof _readTracker.isStale === 'function' && _readTracker.isStale(absPath)) {
    return {
      ok: false,
      error: `文件已过期：${path.basename(absPath)} 自上次读取后已被修改，请重新读取后再编辑`,
    };
  }
  return { ok: true };
}

/**
 * Record a pre-edit snapshot into the current turn's rollback manifest
 * (DESIGN-ARCH-096 §2-A). Fail-soft: returns silently when no active turn is
 * known (feature off / headless / no context), and never throws. The canonical
 * per-file `fileHistoryService` snapshot is taken separately; this only adds
 * the turn-grouping layer.
 */
function _recordTurnMutation(context, absPath, preContent, reason) {
  const turnId = context && context.traceContext && context.traceContext.turnId;
  if (!turnId) {
    return; // no active turn → graceful no-op
  }
  try {
    require('../services/turnCheckpointService').recordMutatedFile(turnId, absPath, {
      reason,
      content: preContent,
    });
  } catch {
    /* non-critical: turn recording must never break the write */
  }
}

module.exports = defineTool({
  name: 'editFile',
  description:
    'Replace an exact substring in an existing file (precise in-place edit). ' +
    'Use it to modify existing files without touching unrelated content; use writeFile only for new files or full rewrites. ' +
    'Constraints: old_string must match the file text EXACTLY (including whitespace) and be unique unless replace_all is true; the call fails otherwise — add more surrounding context to disambiguate. ' +
    // 「先红后绿」diff 显示规则(对齐 FileEditTool.prompt() 与 cli/diffRenderer.js):
    // 空/新文件 → 只 +绿;修改 → 先全部 -红、后全部 +绿,不词级配对;文字总结按同序重述。
    'When describing the edit, render the diff in this exact order: empty/new file → green `+` lines only; existing file edited → red `-` lines FIRST (all of them), then green `+` lines (all of them), never paired side-by-side, no word-level highlighting.',
  category: 'filesystem',
  risk: 'medium',
  isReadOnly: false,
  isConcurrencySafe: false,

  aliases: ['edit_file', 'edit', 'replace'],
  searchHint: 'edit modify replace text in file',

  inputSchema: {
    file_path: {
      type: 'string',
      required: true,
      description:
        'Path to the file to edit, relative to CWD or absolute, e.g. "src/app.js". The file must already exist.',
      example: 'src/app.js',
    },
    old_string: {
      type: 'string',
      required: true,
      description:
        'The exact text to find, matched byte-for-byte including whitespace/indentation. Must be unique in the file unless replace_all is true.',
    },
    new_string: {
      type: 'string',
      required: true,
      description: 'The replacement text. Must differ from old_string.',
    },
    replace_all: {
      type: 'boolean',
      required: false,
      description:
        'Replace ALL occurrences of old_string instead of requiring uniqueness (default: false).',
      example: true,
    },
  },

  getActivityDescription(input) {
    const file = input.file_path ? path.basename(input.file_path) : 'file';
    return `编辑文件：${file}`;
  },

  getToolUseSummary(input) {
    if (!input.file_path) {
      return null;
    }
    const short = input.old_string ? input.old_string.slice(0, 40).replace(/\n/g, '\\n') : '';
    return `编辑 ${path.basename(input.file_path)}：\"${short}\"`;
  },

  async execute(params, context) {
    const { file_path, old_string, new_string, replace_all } = params;

    if (old_string === new_string) {
      return {
        success: false,
        error: 'old_string and new_string are identical — nothing to change.',
      };
    }

    try {
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      let rawPath = file_path;
      if (rawPath.startsWith('~')) {
        rawPath = path.join(require('os').homedir(), rawPath.slice(1));
      }
      try {
        rawPath = require('./_userDirs').normalizeDesktopPath(rawPath);
      } catch {
        /* ignore */
      }

      // [SAFE] editFile had NO path-confinement check at all: an Agent-supplied
      // absolute path ("/etc/passwd"), `..` traversal ("../../../../etc/shadow"),
      // ~-escape, or Windows UNC path would be read, snapshotted, and rewritten
      // directly — an arbitrary file read/write primitive outside the sandbox
      // (Agent privilege escalation / NTLM-leak via UNC). Gate the resolved path
      // through the same confinement (and UNC) validators used by writeFile, on
      // the post-~-expansion path, before any fs access. Writes under the project
      // or the user's home/Desktop/Documents/Downloads still pass unchanged.
      {
        const { validateNotUNCPath, validateNoPathTraversal } = require('./inputValidators');
        const uncCheck = validateNotUNCPath(rawPath);
        if (!uncCheck.valid) {
          return { success: false, error: uncCheck.message };
        }
        const confineCheck = validateNoPathTraversal(rawPath);
        if (!confineCheck.valid) {
          return { success: false, error: confineCheck.message };
        }
      }

      const absPath = path.resolve(cwd, rawPath);

      if (!fs.existsSync(absPath)) {
        return { success: false, error: `File not found: ${absPath}` };
      }

      // Read-before-edit gate: reject edits to unread or stale files (A3).
      // S1 observer stage: the check runs but does not block when
      // KHY_ENFORCE_READ_BEFORE_EDIT_STAGE=observe; only logs the interception.
      const readCheck = _checkReadBeforeEdit(absPath);
      if (!readCheck.ok) {
        const stage = String(process.env.KHY_ENFORCE_READ_BEFORE_EDIT_STAGE || 'S1')
          .trim()
          .toUpperCase();
        if (stage === 'S1' || stage === 'OBSERVE' || stage === 'OBSERVER') {
          // S1: record-only, do not block — fall through to the edit
          try {
            console.warn(`[read-before-edit] S1 observe: ${readCheck.error} (not blocking)`);
          } catch {
            /* best-effort */
          }
        } else {
          return { success: false, error: readCheck.error };
        }
      }

      // 读前防卡死统一前检(FIFO/设备/Windows 保留名/阻塞伪文件)—— 必须在 readFileSync 触碰字节之前。
      try {
        const stat = fs.statSync(absPath);
        const { classifyPreReadHang } = require('./filePreReadHangGuard');
        const hang = classifyPreReadHang({ absPath, stat, env: process.env });
        if (hang && hang.blocked) {
          return { success: false, error: hang.error, blockedRead: hang.kind };
        }
      } catch {
        /* stat/判定失败 → 回退历史行为 */
      }

      const original = fs.readFileSync(absPath, 'utf-8');

      // Take snapshot before modification
      if (_fileHistory) {
        try {
          _fileHistory.takeSnapshot(absPath, { reason: 'editFile', content: original });
        } catch {
          /* non-critical */
        }
      }
      _recordTurnMutation(context, absPath, original, 'editFile');

      // Count occurrences
      let count = 0;
      let idx = -1;
      while ((idx = original.indexOf(old_string, idx + 1)) !== -1) {
        count++;
      }

      if (count === 0) {
        // Provide helpful context: show first 5 lines around where they might be looking
        const preview = original.split('\n').slice(0, 10).join('\n');
        return {
          success: false,
          error: `old_string not found in ${path.basename(absPath)}.  Ensure the text matches exactly (including whitespace and indentation).`,
          preview: preview.length > 500 ? preview.slice(0, 500) + '...' : preview,
        };
      }

      if (count > 1 && !replace_all) {
        return {
          success: false,
          error: `old_string appears ${count} times in the file.  Provide more surrounding context to make it unique, or set replace_all: true to replace all occurrences.`,
          occurrences: count,
        };
      }

      // Perform replacement
      let updated;
      if (replace_all) {
        updated = original.split(old_string).join(new_string);
      } else {
        // Replace first (and only) occurrence
        const pos = original.indexOf(old_string);
        updated = original.slice(0, pos) + new_string + original.slice(pos + old_string.length);
      }

      fs.writeFileSync(absPath, updated, 'utf-8');

      const replacements = replace_all ? count : 1;
      return {
        success: true,
        file: absPath,
        replacements,
        message: `Replaced ${replacements} occurrence${replacements > 1 ? 's' : ''} in ${path.basename(absPath)}`,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});

/**
 * MultiEdit — batch atomic edits across multiple files in one call.
 *
 * Reduces round-trips when an agent needs to make several coordinated edits
 * (e.g. rename a function + update all call sites + fix imports). Each file
 * is locked, read, snapshotted, and edited atomically — if any single edit
 * fails within a file, that file is rolled back to its pre-edit state and
 * the error is reported; other files are still attempted.
 *
 * Modelled after Claude Code's MultiEdit tool. Follows the same diff
 * rendering convention as editFile: red `-` lines first, then green `+`
 * lines, never side-by-side.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { defineTool } = require('./_baseTool');
const { validateNotUNCPath, validateNoPathTraversal } = require('./inputValidators');
const fileLock = require('./_fileLock');

let _fileHistory;
try {
  _fileHistory = require('../services/fileHistoryService');
} catch {
  _fileHistory = null;
}

let _readTracker;
try {
  _readTracker = require('./_readTracker');
} catch {
  _readTracker = null;
}

/**
 * Resolve and validate a file path the same way editFile does: expand ~,
 * normalize desktop paths, reject UNC/traversal, then resolve against CWD.
 * @param {string} rawPath
 * @returns {{ valid: boolean, error?: string, absPath?: string }}
 */
function _resolvePath(rawPath) {
  let p = rawPath;
  if (p.startsWith('~')) {
    p = path.join(require('os').homedir(), p.slice(1));
  }
  try {
    p = require('./_userDirs').normalizeDesktopPath(p);
  } catch {
    /* ignore */
  }
  const uncCheck = validateNotUNCPath(p);
  if (!uncCheck.valid) {
    return { valid: false, error: uncCheck.message };
  }
  const confineCheck = validateNoPathTraversal(p);
  if (!confineCheck.valid) {
    return { valid: false, error: confineCheck.message };
  }
  const cwd = process.env.KHYQUANT_CWD || process.cwd();
  return { valid: true, absPath: path.resolve(cwd, p) };
}

/**
 * Check read-before-edit gate (shared with editFile A3 enforcement).
 * @param {string} absPath
 * @returns {{ ok: boolean, error?: string }}
 */
function _checkReadBeforeEdit(absPath) {
  const enabled = !['0', 'false', 'off', 'no'].includes(
    String(process.env.KHY_ENFORCE_READ_BEFORE_EDIT || 'true')
      .trim()
      .toLowerCase()
  );
  if (!enabled || !_readTracker) {
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
 * Record a pre-edit snapshot into the current turn's rollback manifest.
 * Fail-soft: no-op when no active turn is known.
 */
function _recordTurnMutation(context, absPath, preContent, reason) {
  const turnId = context && context.traceContext && context.traceContext.turnId;
  if (!turnId) {
    return;
  }
  try {
    require('../services/turnCheckpointService').recordMutatedFile(turnId, absPath, {
      reason,
      content: preContent,
    });
  } catch {
    /* non-critical */
  }
}

/**
 * Apply a single old→new replacement to a content string.
 * @param {string} content
 * @param {string} oldStr
 * @param {string} newStr
 * @param {boolean} replaceAll
 * @returns {{ ok: boolean, updated?: string, replacements?: number, error?: string }}
 */
function _applyOneEdit(content, oldStr, newStr, replaceAll) {
  if (oldStr === newStr) {
    return { ok: false, error: 'old_string and new_string are identical — nothing to change.' };
  }
  let count = 0;
  let idx = -1;
  while ((idx = content.indexOf(oldStr, idx + 1)) !== -1) {
    count++;
  }
  if (count === 0) {
    return { ok: false, error: 'old_string not found. Ensure the text matches exactly (including whitespace and indentation).' };
  }
  if (count > 1 && !replaceAll) {
    return { ok: false, error: `old_string appears ${count} times. Provide more context to make it unique, or set replace_all: true.`, occurrences: count };
  }
  let updated;
  if (replaceAll) {
    updated = content.split(oldStr).join(newStr);
  } else {
    const pos = content.indexOf(oldStr);
    updated = content.slice(0, pos) + newStr + content.slice(pos + oldStr.length);
  }
  return { ok: true, updated, replacements: replaceAll ? count : 1 };
}

/**
 * Group edits by resolved file path so all edits to the same file are
 * applied in one locked read-modify-write cycle.
 * @param {Array} edits
 * @returns {Map<string, Array>} path → edits[]
 */
function _groupByFile(edits) {
  const groups = new Map();
  for (const edit of edits) {
    const resolved = _resolvePath(edit.file_path);
    if (!resolved.valid) {
      // Collect under a synthetic key so the error surfaces per-edit
      const key = `__invalid__:${edit.file_path}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push({ ...edit, _resolveError: resolved.error });
      continue;
    }
    if (!groups.has(resolved.absPath)) {
      groups.set(resolved.absPath, []);
    }
    groups.get(resolved.absPath).push(edit);
  }
  return groups;
}

module.exports = defineTool({
  name: 'MultiEdit',
  description:
    'Apply multiple precise string replacements across one or more files in a single atomic call. ' +
    'Use it when you need to make several coordinated edits at once (e.g. rename + update call sites + fix imports). ' +
    'Each file is edited atomically: if any edit within a file fails, that file is rolled back. ' +
    'Constraints: each old_string must match the file text EXACTLY and be unique unless replace_all is true. ' +
    'Use editFile for single edits; use MultiEdit only when you have 2+ edits to make in one round.',
  category: 'filesystem',
  risk: 'medium',
  isReadOnly: false,
  isConcurrencySafe: true,

  aliases: ['multiEdit', 'multi_edit', 'multiedit'],
  searchHint: 'batch edit multiple files atomic replace',

  inputSchema: {
    edits: {
      type: 'array',
      required: true,
      description:
        'Array of edit objects. Each has: file_path (string, required), old_string (string, required, must match exactly), new_string (string, required, must differ from old_string), replace_all (boolean, optional, default false). Example: [{file_path:"src/a.js",old_string:"foo()",new_string:"bar()"}]',
      example: [{ file_path: 'src/a.js', old_string: 'foo()', new_string: 'bar()' }],
    },
  },

  getActivityDescription(input) {
    const n = Array.isArray(input.edits) ? input.edits.length : 0;
    const files = new Set((input.edits || []).map((e) => e.file_path));
    return `批量编辑 ${n} 处 · ${files.size} 个文件`;
  },

  getToolUseSummary(input) {
    if (!Array.isArray(input.edits) || input.edits.length === 0) {
      return null;
    }
    const files = [...new Set(input.edits.map((e) => path.basename(e.file_path || '')))];
    return `MultiEdit ${input.edits.length} 处 · ${files.join(', ')}`;
  },

  async execute(params, context) {
    const edits = Array.isArray(params.edits) ? params.edits : [];
    if (edits.length === 0) {
      return { success: false, error: 'edits array is empty — nothing to change.' };
    }

    const groups = _groupByFile(edits);
    const results = [];
    let totalReplacements = 0;
    let failedCount = 0;

    for (const [absPath, fileEdits] of groups) {
      // Invalid path group — surface errors without touching the filesystem
      if (absPath.startsWith('__invalid__:')) {
        for (const e of fileEdits) {
          results.push({
            file: e.file_path,
            success: false,
            error: e._resolveError || 'invalid path',
          });
          failedCount++;
        }
        continue;
      }

      // read-before-edit gate
      const readCheck = _checkReadBeforeEdit(absPath);
      if (!readCheck.ok) {
        results.push({ file: absPath, success: false, error: readCheck.error });
        failedCount++;
        continue;
      }

      // acquire exclusive lock for this file
      let lockHandle = null;
      try {
        lockHandle = await fileLock.acquire(absPath, {
          mode: 'exclusive',
          toolName: 'MultiEdit',
        });
      } catch (lockErr) {
        results.push({
          file: absPath,
          success: false,
          error: `acquire lock failed: ${lockErr.message}`,
        });
        failedCount++;
        continue;
      }

      try {
        if (!fs.existsSync(absPath)) {
          results.push({ file: absPath, success: false, error: `File not found: ${absPath}` });
          failedCount++;
          continue;
        }

        // pre-read hang guard
        try {
          const stat = fs.statSync(absPath);
          const { classifyPreReadHang } = require('./filePreReadHangGuard');
          const hang = classifyPreReadHang({ absPath, stat, env: process.env });
          if (hang && hang.blocked) {
            results.push({
              file: absPath,
              success: false,
              error: hang.error,
              blockedRead: hang.kind,
            });
            failedCount++;
            continue;
          }
        } catch {
          /* stat/判定失败 → 回退历史行为 */
        }

        const original = fs.readFileSync(absPath, 'utf-8');

        // snapshot before modification
        if (_fileHistory) {
          try {
            _fileHistory.takeSnapshot(absPath, { reason: 'MultiEdit', content: original });
          } catch {
            /* non-critical */
          }
        }
        _recordTurnMutation(context, absPath, original, 'MultiEdit');

        // apply edits sequentially; abort this file on first failure
        let working = original;
        let fileReplacements = 0;
        let fileFailed = false;
        let fileError = null;

        for (const edit of fileEdits) {
          const r = _applyOneEdit(
            working,
            String(edit.old_string),
            String(edit.new_string),
            !!edit.replace_all
          );
          if (!r.ok) {
            fileFailed = true;
            fileError = r.error;
            break;
          }
          working = r.updated;
          fileReplacements += r.replacements;
        }

        if (fileFailed) {
          // atomic rollback: don't write — original content is untouched on disk
          results.push({
            file: absPath,
            success: false,
            error: fileError,
            replacementsApplied: 0,
          });
          failedCount++;
          continue;
        }

        fs.writeFileSync(absPath, working, 'utf-8');
        totalReplacements += fileReplacements;
        results.push({
          file: absPath,
          success: true,
          replacements: fileReplacements,
          edits: fileEdits.length,
        });
      } catch (err) {
        results.push({ file: absPath, success: false, error: err.message });
        failedCount++;
      } finally {
        if (lockHandle) {
          try {
            lockHandle.release();
          } catch {
            /* best-effort */
          }
        }
      }
    }

    const successCount = results.filter((r) => r.success).length;
    return {
      success: failedCount === 0,
      filesTotal: groups.size,
      filesSucceeded: successCount,
      filesFailed: failedCount,
      totalReplacements,
      results,
      message:
        failedCount === 0
          ? `MultiEdit 完成：${totalReplacements} 处替换 · ${successCount} 个文件全部成功`
          : `MultiEdit 部分完成：${totalReplacements} 处替换 · ${successCount} 成功 · ${failedCount} 失败`,
    };
  },
});

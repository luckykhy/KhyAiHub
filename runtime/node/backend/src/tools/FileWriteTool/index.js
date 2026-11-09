/**
 * FileWriteTool — file creation/overwrite tool, aligned with Claude Code's Write tool.
 *
 * Completely replaces the contents of a file or creates a new one.
 * Prefer the Edit tool for modifying existing files.
 */
// [AI-弱模型·照抄] 高危写工具:改已有文件优先用 Edit 而非整体覆盖(覆盖易丢内容)。prompt() 末尾的
// this.weakModelToolNote() 注入别删;改本工具照 weakModelGuidance 'tool-description' 位点(参数按 schema)。
const fs = require('fs');
const path = require('path');

const { BaseTool } = require('../_baseTool');

class FileWriteTool extends BaseTool {
  static toolName = 'Write';
  static category = 'filesystem';
  static risk = 'high';
  static aliases = ['writeFile', 'write_file', 'create_file'];
  static searchHint = 'write create file overwrite';
  static alwaysLoad = true;
  static maxResultSizeChars = 1000;

  isReadOnly() {
    return false;
  }

  isDestructive(input) {
    if (!input?.file_path) {
      return false;
    }
    try {
      // 破坏性判定必须看**真正要写的那个路径**。execute 里会展开 %VAR% / ~ 再写，
      // 而这里原来直接 resolve 原始串：`%OUTSIDE%\important.conf` 这种写法解析出来
      // 根本不存在，于是被判成「非破坏性」，覆盖既有文件不被拦——判定口径与落点不一致，
      // 等于这道闸形同虚设。两处必须用同一套展开（resolveToolPath 是共享单一真源）。
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      const resolved = require('../../utils/resolveToolPath')(input.file_path, cwd);
      return fs.existsSync(resolved);
    } catch {
      return false;
    }
  }

  isConcurrencySafe() {
    return false;
  }

  prompt() {
    return (
      `Writes a file to the local filesystem.

Usage:
- The file_path must be an absolute path.
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.
- Prefer the Edit tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.
- For new files, write complete UTF-8 content. Do not leave partial snippets, placeholder TODO blocks, or half-finished scaffolds unless explicitly requested.
- Before overwriting an existing file, make sure a complete rewrite is actually intended. If a targeted change is enough, use Edit instead.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.` +
      this.weakModelToolNote()
    );
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute path to the file to write (must be absolute, not relative)',
        },
        content: {
          type: 'string',
          description: 'The content to write to the file',
        },
      },
      required: ['file_path', 'content'],
    };
  }

  /**
   * 工具调用管线闸门（execute 之前跑）：UNC + 越界路径。
   *
   * fail-closed：这里原来有 `catch { return { valid: true } }` —— 校验器一旦拿不到
   * （模块路径变了、初始化异常）就直接**放行**，等于把一道安全闸变成摆设。改成
   * 不吞异常：拿不到就让调用失败，绝不静默放行。
   */
  async validateInput(params) {
    const {
      validateNotUNCPath,
      validateNoPathTraversal,
      composeValidations,
    } = require('../inputValidators');
    return composeValidations(
      validateNotUNCPath(params.file_path),
      validateNoPathTraversal(params.file_path)
    );
  }

  getActivityDescription(input) {
    return `写入文件：${input.file_path || 'file'}`;
  }

  getToolUseSummary(input) {
    if (!input.file_path) {
      return null;
    }
    return `写入 ${path.basename(input.file_path)}`;
  }

  async execute(params, context) {
    try {
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      let rawPath = params.file_path;

      if (process.platform === 'win32') {
        rawPath = rawPath.replace(/%([^%]+)%/g, (_, key) => process.env[key] || `%${key}%`);
      } else {
        rawPath = rawPath.replace(/\$\{?(\w+)\}?/g, (_, key) => process.env[key] || '');
      }
      if (rawPath.startsWith('~')) {
        rawPath = path.join(require('os').homedir(), rawPath.slice(1));
      }

      const filePath = path.resolve(cwd, rawPath);

      // [SAFE] 第二层围栏：validateInput() 只看过**原始** file_path，而上面把
      // %VAR% / ~ 展开成绝对路径后，真正的落点才显形（`%USERPROFILE%\..\..\system32\x`
      // 这类串能通过闸门里的原始串检查）。这一层必须在任何 fs 访问之前。
      // 范式同 createDocument.js。
      {
        const { validateNotUNCPath, validateNoPathTraversal, composeValidations } =
          require('../inputValidators');
        const confineCheck = composeValidations(
          validateNotUNCPath(filePath),
          validateNoPathTraversal(filePath)
        );
        if (!confineCheck.valid) {
          return { success: false, error: confineCheck.message };
        }
      }

      // CC 硬约束: 已存在的文件必须先读后写
      if (fs.existsSync(filePath)) {
        try {
          const { hasRead } = require('../_readTracker');
          if (!hasRead(filePath)) {
            return {
              success: false,
              error: `File exists but was not read in this session. Use the Read tool first to read "${filePath}" before overwriting it.`,
            };
          }
        } catch {
          /* _readTracker not available — skip check */
        }
      }

      const dir = path.dirname(filePath);

      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Pre-write snapshot for /rollback recovery (existing files only)
      if (fs.existsSync(filePath)) {
        try {
          const fh = require('../../services/fileHistoryService');
          fh.takeSnapshot(filePath, { reason: 'FileWriteTool' });
        } catch {
          /* non-critical */
        }
        // Turn-grouped rollback manifest (DESIGN-ARCH-096 §2-A), existing files only.
        try {
          const _turnId = context && context.traceContext && context.traceContext.turnId;
          if (_turnId) {
            require('../../services/turnCheckpointService').recordMutatedFile(_turnId, filePath, {
              reason: 'FileWriteTool',
            });
          }
        } catch {
          /* non-critical */
        }
      }

      // Pre-write diagnostics baseline (CC beforeFileEdited 口径,门控 KHY_POST_EDIT_DIAGNOSTICS)。
      // 新文件此刻尚不存在 → 服务登记空基线,写后所有语法错都算「新增」(RISK 2)。
      try {
        require('../../services/postEditDiagnostics').captureBaseline(filePath, cwd);
      } catch {
        /* diagnostics baseline is best-effort; never blocks the write */
      }

      fs.writeFileSync(filePath, params.content, 'utf-8');
      const bytes = Buffer.byteLength(params.content, 'utf-8');

      // 写完刷新 readState：刚写进去的内容就是「当前内容」。不刷新的话，下一次 Edit
      // 会因为「文件已变（stale）」或「本轮没读过」把用户自己刚写的文件拦住，
      // 而用户明明刚写过它（新建的文件更糟：它压根没被读过，必然被 Edit 顶回来）。
      try {
        require('../_readTracker').markRead(filePath);
      } catch {
        /* tracker 不可用 → 跳过（best-effort，不影响写入本身） */
      }

      const result = { success: true, path: filePath, bytes };
      // LSP 诊断自动注入：写入后收集编译错误
      try {
        const { serviceRegistry } = require('../../services/serviceRegistry');
        const lsp = serviceRegistry?.get?.('lspClient');
        if (lsp && lsp.initialized) {
          const diags = lsp.getDiagnostics(filePath);
          if (Array.isArray(diags) && diags.length > 0) {
            const errors = diags.filter((d) => d.severity === 1 || d.severity === 2);
            if (errors.length > 0) {
              result._lspDiagnostics = errors.slice(0, 15).map((d) => ({
                line: (d.range?.start?.line ?? 0) + 1,
                character: (d.range?.start?.character ?? 0) + 1,
                severity: d.severity === 1 ? 'error' : 'warning',
                message: d.message || '',
                source: d.source || '',
              }));
            }
          }
        }
      } catch {
        /* LSP not available — skip */
      }
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

module.exports = new FileWriteTool();
module.exports.FileWriteTool = FileWriteTool;

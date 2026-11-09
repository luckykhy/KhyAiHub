/**
 * FileEditTool — exact string replacement editing, aligned with Claude Code's Edit tool.
 *
 * Performs precise substring replacement in files. The old_string must be
 * unique in the file (unless replace_all is true) to prevent ambiguous edits.
 *
 * When exact match fails, a fuzzy fallback attempts to find the best match by:
 * 1. Stripping leading/trailing whitespace from each line
 * 2. Collapsing internal whitespace differences
 * 3. Ignoring trailing commas / semicolons
 * 4. Tab/Space normalization
 * 5. Blank line folding
 * This lets local models (which often retype code from memory) succeed on
 * semantically-identical edits without sacrificing safety.
 */
// [AI-弱模型·照抄] 高危写工具:先 Read 再 Edit,old_string 逐字照抄读到的原文(别猜,否则死循环撞
// "no match")。prompt() 末尾的 this.weakModelToolNote() 注入别删。改本工具照 weakModelGuidance 的
// 'tool-description' 位点(参数严格按 schema、一次一步),示范见 GrepTool。
const fs = require('fs');
const path = require('path');

// ── LSP diagnostics auto-inject ────────────────────────────────────
const _collectLspDiagnostics = require('../../utils/collectLspDiagnostics');
const { BaseTool } = require('../_baseTool');

// ── Fuzzy matching helpers ───────────────────────────────────────────

/**
 * Normalize a string for fuzzy comparison: collapse whitespace, strip
 * trailing punctuation, lowercase. Used only for *matching*, never for
 * the actual replacement.
 */
function _normalize(s) {
  return String(s)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/[;,]+\s*$/gm, '')
    .trim();
}

// Strip a Read-style per-line number gutter ("42\t", "42: ", "42····").
// Used only by the deterministic gutter-strip fallback below, never by the
// fuzzy normalizer. The separator is deliberately strict — tab, ": ", or 2+
// spaces — so an arithmetic line like "2 + 3" (digit + single space) is left
// intact and cannot be silently rewritten into "+ 3".
function _stripLineGutter(s) {
  return String(s)
    .split('\n')
    .map((line) => line.replace(/^\s*\d+(?:\t|: {1}|\s{2,})/, ''))
    .join('\n');
}

/**
 * Simple Levenshtein distance (character-level). Only used on short
 * normalized strings (<2000 chars) so O(n*m) is acceptable.
 *
 * NOTE (Batch B1 — Levenshtein convergence): one of three Levenshtein
 * implementations in services/backend. NOT merged into a shared leaf; the
 * three are byte-divergent variants of the same algorithm:
 *   - cli/router.js `_levenshtein`: single rolling-row DP, no `a === b` fast
 *     path and no length cap.
 *   - tools/ccValidationError.js `levenshteinDistance`: string-coercing,
 *     two-row swap DP.
 * The `> 2000` length-cap short-circuit below is intentionally local to this
 * variant and must NOT be propagated to the others.
 */
function _levenshtein(a, b) {
  if (a === b) {
    return 0;
  }
  const la = a.length,
    lb = b.length;
  if (la === 0) {
    return lb;
  }
  if (lb === 0) {
    return la;
  }
  // Limit to avoid expensive computation on large strings
  if (la > 2000 || lb > 2000) {
    return Math.abs(la - lb);
  }
  let prev = Array.from({ length: lb + 1 }, (_, i) => i);
  for (let i = 1; i <= la; i++) {
    const curr = [i];
    for (let j = 1; j <= lb; j++) {
      curr[j] =
        a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return prev[lb];
}

/**
 * Try to find the best fuzzy match for `needle` in `haystack`.
 * Returns { match, start, end, similarity } or null.
 *
 * Strategy: slide a window of ±20% needle-line-count over haystack lines,
 * compute normalized Levenshtein similarity, accept if ≥ 0.80.
 */
function _fuzzyFind(haystack, needle) {
  const hLines = haystack.split('\n');
  const nLines = needle.split('\n');
  const nNorm = _normalize(needle);
  if (!nNorm) {
    return null;
  }

  // 候选必须与 needle **行对齐**：首行被 needle 覆盖、末行被 needle 覆盖、行数一致。
  //
  // 为什么：相似度是在「整行窗口」上算的，替换区间(start/end)也由行边界算出，
  // 与 needle 在行内的偏移无关。needle 只是长行的一段时照样整行替换 —— 模型从没提过的
  // 行首/行尾内容被一起删掉，而工具回 success:true（静默毁内容，最难归因的故障形态）。
  // 对齐之后，行边界算出的区间才与 needle 的覆盖区间一致。
  const _coverKey = (line) => String(line == null ? '' : line).replace(/\s+/g, '');
  const _needleFirstKey = _coverKey(nLines[0]);
  const _needleLastKey = _coverKey(nLines[nLines.length - 1]);
  // 候选行被 needle 覆盖 = needle 的该行以候选行的内容开头（needle 可以更长）。
  const _coveredBy = (candidateLine, needleKey) => {
    const c = _coverKey(candidateLine);
    return c.length > 0 && needleKey.startsWith(c);
  };

  const windowMin = Math.max(1, Math.floor(nLines.length * 0.8));
  const windowMax = Math.ceil(nLines.length * 1.2);
  const AMBIGUITY_THRESHOLD = 0.7; // Y-code pattern: flag multi-candidate ambiguity

  let best = null;
  const candidates = []; // Track all high-similarity candidates for ambiguity detection

  for (
    let winSize = nLines.length;
    winSize >= windowMin && winSize <= windowMax;
    winSize += winSize <= nLines.length ? -1 : 1
  ) {
    for (let i = 0; i <= hLines.length - winSize; i++) {
      const winLines = hLines.slice(i, i + winSize);
      // 行数一致 + 首行/末行被 needle 覆盖 —— 不满足就不是候选（见上方注释）。
      if (winSize !== nLines.length) {
        continue;
      }
      if (!_coveredBy(winLines[0], _needleFirstKey)) {
        continue;
      }
      if (!_coveredBy(winLines[winLines.length - 1], _needleLastKey)) {
        continue;
      }
      const candidate = winLines.join('\n');
      const cNorm = _normalize(candidate);
      if (!cNorm) {
        continue;
      }

      const dist = _levenshtein(nNorm, cNorm);
      const maxLen = Math.max(nNorm.length, cNorm.length);
      const sim = maxLen > 0 ? 1 - dist / maxLen : 1;

      if (sim >= AMBIGUITY_THRESHOLD) {
        const startLine = i;
        const endLine = i + winSize;
        const before = hLines.slice(0, startLine).join('\n');
        const start = startLine === 0 ? 0 : before.length + 1;
        const matchStr = hLines.slice(startLine, endLine).join('\n');
        const entry = {
          match: matchStr,
          start,
          end: start + matchStr.length,
          similarity: sim,
          startLine: startLine + 1,
          endLine: endLine,
        };
        candidates.push(entry);
        if (!best || sim > best.similarity) {
          best = entry;
        }
      }
    }
    if (best && best.similarity >= 0.95) {
      break;
    }
  }

  // Y-code multi-candidate ambiguity check: refuse replacement if multiple
  // high-similarity candidates exist, forcing the LLM to provide more context.
  if (candidates.length >= 2) {
    const highScore = candidates.filter((c) => c.similarity >= AMBIGUITY_THRESHOLD);
    if (highScore.length >= 2) {
      return {
        ambiguous: true,
        candidates: highScore.slice(0, 5).map((c) => ({
          lines: `${c.startLine}-${c.endLine}`,
          similarity: Math.round(c.similarity * 100),
          preview: c.match.length > 120 ? c.match.slice(0, 120) + '...' : c.match,
        })),
      };
    }
  }

  return best;
}

// ── Tool definition ──────────────────────────────────────────────────

class FileEditTool extends BaseTool {
  static toolName = 'Edit';
  static category = 'filesystem';
  static risk = 'medium';
  static aliases = ['editFile', 'edit_file', 'replace'];
  static searchHint = 'edit modify replace text in file';
  static alwaysLoad = true;

  isReadOnly() {
    return false;
  }
  isConcurrencySafe() {
    return false;
  }

  prompt() {
    return (
      `Performs exact string replacements in files.

Usage:
- You must use the Read tool at least once before editing a file. This tool will error if you attempt an edit without reading the file.
- The file_path must be an absolute path.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + tab. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Choose the smallest sufficient edit. Prefer changing the narrowest region that satisfies the task instead of rewriting broader blocks or whole files.
- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string.
- Copy old_string verbatim from the Read result. Preserve whitespace, indentation, and line breaks exactly.
- Prefer one focused replacement per call. If you need to change multiple unrelated regions, do multiple Edit calls instead of one oversized replacement.
- Use replace_all for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
- Only add comments where the logic isn't self-evident. Don't add docstrings, comments, or type annotations to code you didn't change.
- Don't add features, refactor code, or make "improvements" beyond what was asked.
- Do not combine a requested fix with unrelated cleanup or cosmetic rewrites unless the task cannot be completed safely without them.`
      + "\n\nWhen describing the edit back to the user, render the diff in this exact order: empty/new file \u2192 only green + lines; existing file edited \u2192 list all red - lines FIRST, then all green + lines; never pair them side-by-side and skip word-level highlighting. The runtime renderer in cli/diffRenderer.js and ToolLines.js follows the same order, so any prose summary you write should mirror it (e.g. \"removed N lines, then added M lines\")."
      + "\n\nThe tool may answer a near-miss with a FUZZY fallback: when old_string does not match exactly, it can replace the closest similar block instead, and the result then carries `fuzzyMatch: true` (with `similarity` and `matchedText`). A fuzzy replacement can land on a DIFFERENT region than you intended — so when you see `fuzzyMatch: true`, read the `matchedText` back and confirm the replaced region is the one you meant. If it is not, re-read the file and retry with more surrounding context."
      + this.weakModelToolNote()
    );
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute path to the file to modify',
        },
        old_string: {
          type: 'string',
          minLength: 1,
          description:
            'The text to replace (must be unique in the file unless replace_all is true; must not be empty)',
        },
        new_string: {
          type: 'string',
          description: 'The text to replace it with (must be different from old_string)',
        },
        replace_all: {
          type: 'boolean',
          description: 'Replace all occurrences of old_string (default false)',
        },
        dry_run: {
          type: 'boolean',
          description: 'Preview the edit without writing to disk (default false)',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
    };
  }

  getActivityDescription(input) {
    const file = input.file_path ? path.basename(input.file_path) : 'file';
    return `编辑文件：${file}`;
  }

  getToolUseSummary(input) {
    if (!input.file_path) {
      return null;
    }
    const short = input.old_string ? input.old_string.slice(0, 40).replace(/\n/g, '\\n') : '';
    return `编辑 ${path.basename(input.file_path)}：\"${short}\"`;
  }

  /**
   * 工具调用管线闸门（execute 之前跑）：拦原始 file_path 的 UNC 与越界路径。
   *
   * Edit 是模型实际会调的 alwaysLoad 高危写工具，却一直没有这道校验：
   * 绝对路径能改到项目外的文件、`../` 相对路径同理、Windows UNC 路径还会真的发起
   * SMB 连接（NTLM 外泄）。同批的 Write 早就有这两道校验，这里补齐。
   *
   * fail-closed：校验器拿不到就判**拒绝**，绝不 `catch { return { valid: true } }` ——
   * 那个逃生舱正是「校验失败即放行」。
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

  async execute(params, context) {
    const { file_path, old_string, new_string, replace_all, dry_run } = params;

    if (old_string === new_string) {
      return {
        success: false,
        error: 'old_string and new_string are identical — nothing to change.',
      };
    }

    // 空 old_string 必须拒绝：原来 indexOf('') 恒为 0 → count=1 → 走精确替换路径，
    // 而 split('').join(new_string) 会把 new_string 插进**每一个字符之间**
    // （文件被撑成碎片）。replace_all 下更明显。这不是「没找到」，是明确的输入错误。
    if (typeof old_string !== 'string' || old_string.length === 0) {
      return {
        success: false,
        error:
          'old_string must not be empty — provide the exact text to replace ' +
          '(copy it verbatim from the Read tool output).',
      };
    }

    // new_string 若还带着 Read 输出的行号栏（"42\t"），写进去就是把 gutter 存进文件。
    // old_string 的 gutter 由下面的确定性剥离路径处理（gutterStrip），new_string 没有
    // 对应的剥离路径——只能拒绝，否则文件里会长出 "2\tconst b = 222;" 这种行。
    if (typeof new_string === 'string' && _stripLineGutter(new_string) !== new_string) {
      return {
        success: false,
        error:
          'new_string still carries a Read-style line-number gutter (e.g. "42\\t"). ' +
          'Strip the line-number prefix from new_string before editing.',
      };
    }

    try {
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      let rawPath = file_path;
      if (rawPath.startsWith('~')) {
        rawPath = path.join(require('os').homedir(), rawPath.slice(1));
      }
      const absPath = path.resolve(cwd, rawPath);

      // [SAFE] 第二层围栏：validateInput() 只看过**原始** file_path，而上面把 ~
      // 展开成绝对路径后真正的落点才显形（`~`/`%VAR%` 都能在闸门通过后注入越界路径）。
      // 这一层必须在**任何 fs 访问之前**——否则 UNC 路径会被真的喂给 fs（发起 SMB
      // 连接），越界文件也会先被 existsSync 探到。范式同 createDocument.js。
      {
        const { validateNotUNCPath, validateNoPathTraversal, composeValidations } =
          require('../inputValidators');
        const confineCheck = composeValidations(
          validateNotUNCPath(absPath),
          validateNoPathTraversal(absPath)
        );
        if (!confineCheck.valid) {
          return { success: false, error: confineCheck.message };
        }
      }

      if (!fs.existsSync(absPath)) {
        return { success: false, error: `File not found: ${absPath}` };
      }

      // ── 时间戳防覆盖守护（对标 CC readFileState）──────────────────
      const tracker = require('../_readTracker');
      if (!tracker.hasRead(absPath)) {
        return {
          success: false,
          error:
            'You must Read this file before editing it. Use the Read tool first to see the current content.',
        };
      }
      const staleCheck = tracker.isStale(absPath);
      if (staleCheck.stale) {
        return { success: false, error: staleCheck.reason };
      }

      const original = fs.readFileSync(absPath, 'utf-8');

      // Pre-edit snapshot for /rollback recovery
      try {
        const fh = require('../../services/fileHistoryService');
        fh.takeSnapshot(absPath, { reason: 'FileEditTool', content: original });
      } catch {
        /* non-critical */
      }
      // Turn-grouped rollback manifest (DESIGN-ARCH-096 §2-A) — fail-soft no-op
      // when no active turn id reaches this tool via context.traceContext.turnId.
      try {
        const _turnId = context && context.traceContext && context.traceContext.turnId;
        if (_turnId) {
          require('../../services/turnCheckpointService').recordMutatedFile(_turnId, absPath, {
            reason: 'FileEditTool',
            content: original,
          });
        }
      } catch {
        /* non-critical */
      }

      // Pre-edit diagnostics baseline (CC beforeFileEdited 口径,门控 KHY_POST_EDIT_DIAGNOSTICS)。
      // 在写盘前(此刻磁盘仍是编辑前内容)给文件的语法诊断打基线,编辑后由 toolUseLoop 求「新增」。
      try {
        require('../../services/postEditDiagnostics').captureBaseline(absPath, cwd);
      } catch {
        /* diagnostics baseline is best-effort; never blocks the edit */
      }

      // Count NON-OVERLAPPING occurrences — this must match the split().join()
      // replace below, which is non-overlapping. Stepping the cursor by 1 counted
      // OVERLAPPING matches, so a self-overlapping needle (e.g. "--" in "------",
      // "\n\n" across a blank-line run) reported more occurrences than were actually
      // replaced, and mis-reported "appears N times" when refusing a non-unique edit.
      // Step by old_string.length so `count` equals original.split(old_string).length-1.
      let count = 0;
      let idx = original.indexOf(old_string);
      while (idx !== -1) {
        count++;
        if (old_string.length === 0) {
          break;
        } // guard against empty-string infinite loop
        idx = original.indexOf(old_string, idx + old_string.length);
      }

      // ── Exact match path ───────────────────────────────────────────
      if (count > 0) {
        if (count > 1 && !replace_all) {
          return {
            success: false,
            error: `old_string appears ${count} times in the file. Provide more surrounding context to make it unique, or set replace_all: true to replace all occurrences.`,
            occurrences: count,
          };
        }

        let updated;
        if (replace_all) {
          updated = original.split(old_string).join(new_string);
        } else {
          const pos = original.indexOf(old_string);
          updated = original.slice(0, pos) + new_string + original.slice(pos + old_string.length);
        }

        const replacements = replace_all ? count : 1;
        if (dry_run) {
          return {
            success: true,
            file: absPath,
            replacements,
            dryRun: true,
            message: `[dry-run] Would replace ${replacements} occurrence${replacements > 1 ? 's' : ''} in ${path.basename(absPath)}`,
          };
        }
        fs.writeFileSync(absPath, updated, 'utf-8');
        // 刷新 readState 时间戳 — 防止连续编辑触发误报
        tracker.markRead(absPath);
        const result = {
          success: true,
          file: absPath,
          replacements,
          message: `Replaced ${replacements} occurrence${replacements > 1 ? 's' : ''} in ${path.basename(absPath)}`,
        };
        const diags = _collectLspDiagnostics(absPath);
        if (diags) {
          result._lspDiagnostics = diags;
        }
        return result;
      }

      // ── Deterministic gutter-strip fallback (G-AA #69) ─────────────
      // A weak model often pastes old_string copied from Read output, which is
      // prefixed with a per-line "42\t" (or "42: " / "42····") gutter the file
      // itself lacks. A short single-line paste also never reaches the fuzzy tier
      // (isFuzzyCandidate excludes lines ≤20 chars with no newline), so it would
      // hard-fail "not found" despite matching a real line verbatim. Strip the
      // gutter and re-anchor deterministically. Only fires after exact match has
      // already failed and only writes on a UNIQUE post-strip match.
      if (!replace_all) {
        const stripped = _stripLineGutter(old_string);
        if (stripped && stripped !== old_string) {
          let gCount = 0;
          let gIdx = original.indexOf(stripped);
          while (gIdx !== -1) {
            gCount++;
            gIdx = original.indexOf(stripped, gIdx + stripped.length);
          }
          if (gCount === 1) {
            const pos = original.indexOf(stripped);
            const updated =
              original.slice(0, pos) + new_string + original.slice(pos + stripped.length);
            if (dry_run) {
              return {
                success: true,
                file: absPath,
                replacements: 1,
                dryRun: true,
                gutterStrip: true,
                message: `[dry-run] Would replace in ${path.basename(absPath)} after stripping a Read-style line-number gutter from old_string`,
              };
            }
            fs.writeFileSync(absPath, updated, 'utf-8');
            tracker.markRead(absPath);
            const gutterResult = {
              success: true,
              file: absPath,
              replacements: 1,
              gutterStrip: true,
              message: `Replaced 1 occurrence in ${path.basename(absPath)} (old_string carried a Read-style line-number gutter; matched after stripping it). Matched text: "${stripped.length > 80 ? stripped.slice(0, 80) + '...' : stripped}"`,
            };
            const gDiags = _collectLspDiagnostics(absPath);
            if (gDiags) {
              gutterResult._lspDiagnostics = gDiags;
            }
            return gutterResult;
          }
          if (gCount > 1) {
            return {
              success: false,
              error: `去掉行号栏后，old_string 在 ${path.basename(absPath)} 中出现 ${gCount} 次，无法唯一定位。请用 Read 工具查看后提供更精确的 old_string（含更多上下文）。`,
              occurrences: gCount,
            };
          }
          // gCount === 0 → fall through to fuzzy / not-found as before
        }
      }

      // ── Fuzzy match fallback ───────────────────────────────────────
      // Only attempt fuzzy match when:
      //  - old_string is multi-line OR long enough to be meaningful (>20 chars)
      //  - replace_all is not set (fuzzy + replace_all is too risky)
      const isFuzzyCandidate =
        !replace_all && (old_string.includes('\n') || old_string.length > 20);
      if (isFuzzyCandidate) {
        const fuzzy = _fuzzyFind(original, old_string);
        // Multi-candidate ambiguity check (Y-code pattern): refuse replacement
        // when multiple high-similarity blocks exist, forcing LLM to disambiguate.
        if (fuzzy && fuzzy.ambiguous && fuzzy.candidates && fuzzy.candidates.length >= 2) {
          const locations = fuzzy.candidates
            .map((c) => `  第 ${c.lines} 行（相似度 ${c.similarity}%）：${c.preview}`)
            .join('\n');
          return {
            success: false,
            error: `在 ${path.basename(absPath)} 中找到 ${fuzzy.candidates.length} 个高相似度代码段，无法确定唯一替换位置：\n${locations}\n请使用 Read 工具查看完整内容后提供更精确的 old_string（包含更多上下文或唯一标识）。`,
          };
        }
        if (fuzzy && fuzzy.similarity >= 0.8) {
          // 模糊回退必须**整行覆盖**：needle 只是某一行的一部分时，按匹配到的整块替换
          // 会把行首/行尾的其余代码一起吃掉（静默毁内容，最难归因的故障形态）。
          // 判据：匹配区间的两端必须落在行边界上（行首 / 行尾之后）。
          const _before = original.slice(0, fuzzy.start);
          const _after = original.slice(fuzzy.end);
          const _startsAtLineStart = _before.length === 0 || _before.endsWith('\n');
          const _endsAtLineEnd = _after.length === 0 || _after.startsWith('\n');
          if (!_startsAtLineStart || !_endsAtLineEnd) {
            return {
              success: false,
              error:
                `old_string 在 ${path.basename(absPath)} 里只匹配到某一行的一部分 ` +
                `(${Math.round(fuzzy.similarity * 100)}% 相似)，按整行替换会连带吃掉这行的其余代码。` +
                '请提供覆盖完整行的 old_string（含更多上下文或唯一标识）后重试。',
              similarity: Math.round(fuzzy.similarity * 100),
            };
          }
          const updated = original.slice(0, fuzzy.start) + new_string + original.slice(fuzzy.end);
          const pct = Math.round(fuzzy.similarity * 100);
          if (dry_run) {
            return {
              success: true,
              file: absPath,
              replacements: 1,
              dryRun: true,
              fuzzyMatch: true,
              similarity: pct,
              matchedText:
                fuzzy.match.length > 200 ? fuzzy.match.slice(0, 200) + '...' : fuzzy.match,
              message: `[dry-run] Would fuzzy-replace in ${path.basename(absPath)} (${pct}% similarity)`,
            };
          }
          fs.writeFileSync(absPath, updated, 'utf-8');
          tracker.markRead(absPath);
          const fuzzyResult = {
            success: true,
            file: absPath,
            replacements: 1,
            fuzzyMatch: true,
            similarity: pct,
            matchedText: fuzzy.match.length > 200 ? fuzzy.match.slice(0, 200) + '...' : fuzzy.match,
            message: `Fuzzy-matched and replaced in ${path.basename(absPath)} (${pct}% similarity). Matched text: "${fuzzy.match.length > 80 ? fuzzy.match.slice(0, 80) + '...' : fuzzy.match}"`,
          };
          const diags = _collectLspDiagnostics(absPath);
          if (diags) {
            fuzzyResult._lspDiagnostics = diags;
          }
          return fuzzyResult;
        }
      }

      // ── No match at all ────────────────────────────────────────────
      const preview = original.split('\n').slice(0, 10).join('\n');
      return {
        success: false,
        error: `old_string not found in ${path.basename(absPath)}. Ensure the text matches exactly (including whitespace and indentation). Use Read tool to see the current file content.`,
        preview: preview.length > 500 ? preview.slice(0, 500) + '...' : preview,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

module.exports = new FileEditTool();
module.exports.FileEditTool = FileEditTool;

'use strict';

/**
 * Canonical agent constraints — the single source of truth for the execution
 * loop AND the prohibitions that bound it.
 *
 * Two companion blocks:
 * - EXECUTION_DISCIPLINE: the positive loop (plan → minimal slice → verify →
 *   refine) that shapes how good work flows.
 * - HARD_PROHIBITIONS: the red lines that stop the specific detours this project
 *   has actually hit.
 *
 * Design philosophy: prohibitions matter more than positive guidance — a
 * guideline describes what good looks like, a prohibition stops a known detour —
 * so when the two conflict, the prohibition wins. But the loop still has to
 * exist: without it the agent has no shape, only walls.
 *
 * These blocks are INJECTED (never copy-pasted) into built-in agent system
 * prompts, so each rule lives in exactly one place. Do not duplicate any line
 * below into an individual agent prompt — reference the constant instead.
 */

/**
 * The positive execution loop for any agent that changes code. Ordered on
 * purpose: plan before touching, ship the smallest convincing slice, prove it
 * with evidence, and only then broaden. Inject alongside HARD_PROHIBITIONS into
 * code-writing agents; read-only agents do not run this loop.
 */
const EXECUTION_DISCIPLINE = `=== EXECUTION DISCIPLINE (the loop to follow) ===
1. Plan first. Before non-trivial work, state the goal, the smallest sufficient scope, and the acceptance condition you will verify against. For work spanning multiple files, shared interfaces, or architecture, map it (or use the Plan agent) before editing. If a requirement is ambiguous but low-risk, state one concrete assumption and proceed; if it touches architecture, shared state, or safety, stop and ask.
2. Execute the minimal slice. Read a file's current contents before editing so your change fits what is already there. Implement the narrowest convincing change that meets the acceptance condition — a single file, function, or targeted edit — and get it working before broadening.
3. Verify with evidence. After changes, run focused verification — build, tests, linters, or a reproduction — not code inspection alone. A broken build or a failing test means the task is not done. For non-trivial work, hand the result to the verification agent.
4. Refine only then. Once the minimal slice passes, extend to the remaining cases the acceptance condition requires, and stop there. Leave no TODO placeholders or half-finished paths.`;

/**
 * Universal red lines for any agent that can modify code or run commands.
 *
 * Derived from the project's mandatory engineering rules (see AGENTS.md) and the
 * recorded failure modes this project has hit before. Kept crisp and scannable —
 * this is a checklist, not prose. Inject only into agents that actually write
 * code or run state-changing commands; read-only agents get the read-only block
 * instead, to avoid prompt noise that does not apply to them.
 */
const HARD_PROHIBITIONS = `=== HARD PROHIBITIONS (these override any guideline above) ===
- NEVER narrate an action instead of performing it. If a tool can do the thing, call the tool. Do not write "I would run…" or describe a command you never execute — text is not work.
- NEVER expand the task. Do only what was asked; do not bundle unrelated refactors, renames, cleanup, or "while I'm here" polish. Stop the moment the acceptance condition is met.
- NEVER retry the same failing step. After 2-3 adjusted attempts on one blocker, change strategy or stop and report what you tried, the failure, your best cause hypothesis, and the next option.
- NEVER paper over a symptom. Fix the root cause; if a fix creates a new failure, re-analyze before stacking another patch.
- NEVER claim success you did not verify. On timeout, partial completion, or failure, state plainly what was done and what remains — never imply the task succeeded.
- NEVER hardcode an IP address, port, or absolute filesystem path in source. Read endpoints from env, shared runtime config, or service discovery; literal defaults belong only in serviceDefaults.js or .env templates.
- NEVER emit a bare status such as "处理中" / "Loading" / "Connecting…". Every user-visible status line must name the Action, Target, and measurable Progress.
- NEVER hard-kill a long-running task on a fixed wall-clock while it is still making progress. Use an idle/sliding timeout and reset it on each productive event.
- NEVER create a file — especially *.md or README — unless it is required to finish the task; when you must, state why in one line. Prefer editing an existing file.
- NEVER grow a file into a "god file". A single source file must hold ONE cohesive responsibility; when it would cross the project's size ceiling or start mixing unrelated concerns (routing + persistence + rendering in one file), split it by responsibility into focused modules instead of piling on. Bias to small, single-purpose files from the first write — do not defer the split to "later".
- NEVER recreate functionality that already exists. Before adding a new module, file, helper, or component, search the project for one that already does the job; if it exists, EXTEND or import it. Do not ship parallel near-duplicate implementations (e.g. utils2.js, a second auth layer, copy-pasted helpers under new names) — one capability lives in exactly one place.
- NEVER copy an external pattern verbatim. Map every borrowed idea onto this project's actual backend capability before adopting it.
- NEVER hand-write document presentation code to typeset a file — no LaTeX (\\textbf, \\vspace, \\newpage), no docx/WordprocessingML XML (w:rPr, w:sz), no HTML/CSS style tags, no RTF control words. To produce a formatted Word/paper, call renderDocument with SEMANTIC content only (Markdown or the document AST) plus a style template (default | gbt7714 | ieee); fonts, sizes, margins, spacing, and page breaks are the template's job, applied deterministically. Force a page break with a [[newpage]] line or a {"type":"pagebreak"} block, never with blank lines.
- NEVER delete a file while organizing a directory. "Organize / tidy / reorganize / 整理" means move, group, rename, or nest files only — it is a reversible, content-preserving operation. If you judge a file truly should be removed, STOP and ask the user for explicit confirmation; never delete on your own initiative as part of tidying.
- NEVER move a file without rewiring every reference to its old path. When organizing relocates a file, first find what points at the old location — environment variables, .env entries, config files, scripts, import/require paths — then update each one to the new path in the same change, so nothing breaks after the move. A move that leaves a dangling reference is an incomplete move.
- NEVER render user-facing display text — results, progress/steps, status, reports, lists, tables — from the model's free prose. Every such surface must be rendered from the STRUCTURED data the tool/system actually returned (result.success, exitCode, counts, paths, typed fields), never from text the model wrote. Do not treat a model's narration of an action as evidence it happened: a tool step is authoritative only when it comes from a real tool_use/tool_result event, not from prose that mentions a tool. Parsing model text into a structured shape is allowed ONLY as a labeled fallback when no native structured channel exists, and the parsed result — not the raw prose — is what gets rendered.`;

/**
 * Read-only prohibition block shared by the Explore and Plan agents. Previously
 * these two agents duplicated this block almost verbatim; it now lives here so a
 * change applies to both at once.
 *
 * @param {object} opts
 * @param {string} opts.task - task kind woven into the header, e.g. "exploration" / "planning"
 * @param {string} opts.role - the EXCLUSIVELY-… sentence describing the agent's job
 * @returns {string}
 */
function readOnlyProhibitions({ task, role }) {
  return `=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY ${task} task. You are STRICTLY PROHIBITED from:
- Creating new files (no Write, touch, or file creation of any kind)
- Modifying existing files (no Edit operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Your role is EXCLUSIVELY to ${role}. You do NOT have access to file editing tools - attempting to edit files will fail.`;
}

/**
 * Sub-agent execution scope — the "layered thinking" rule.
 *
 * A sub-agent runs in its OWN context window (it cannot see the parent
 * conversation) and is a hands-on EXECUTOR, not a strategist. The main agent
 * owns the thinking: it decomposes the overall goal, makes architectural and
 * cross-cutting decisions, and synthesizes results. A sub-agent must NOT redo
 * that strategy — it executes the self-contained chunk it was handed.
 *
 * It MAY break only its OWN assigned chunk into concrete steps and, when a piece
 * is genuinely independent, delegate it to a further sub-agent — but only within
 * the hard nesting cap (the depth ceiling enforced by AgentTool), and never by
 * re-planning the overall goal or expanding scope.
 *
 * Injected (never copy-pasted) into every spawned sub-agent's system prompt via
 * AgentTool.buildSubagentSystemPrompt, so this rule lives in exactly one place.
 */
const SUBAGENT_EXECUTION_SCOPE = `=== SUB-AGENT EXECUTION SCOPE (you are an executor, not the strategist) ===
- You run in your OWN isolated context and cannot see the parent conversation. The prompt you received already contains everything you need — treat it as the complete, self-contained brief.
- The MAIN agent owns the thinking. Overall goal decomposition, architecture, and cross-cutting decisions are NOT yours to redo or second-guess. Do not re-plan the whole task or expand its scope.
- Execute the assigned chunk to completion: do the work, verify it, and report the result. Hands on the work, not on the strategy.
- You MAY split only YOUR assigned chunk into concrete steps. If one step is genuinely independent and worth parallelizing, you may delegate it to a further sub-agent — but stay within the nesting limit; if spawning is refused because the depth ceiling is reached, complete that step directly instead.
- Keep your reasoning local and minimal: enough to carry out the assigned work, not a fresh strategic analysis of the overall goal.`;

/**
 * Sub-agent common floor — the reporting discipline every spawned sub-agent
 * keeps, regardless of role.
 *
 * The scope block above says WHAT a sub-agent is (executor, isolated context);
 * it does not say how its report must behave. The evidence/closing discipline
 * lives in EXECUTION_DISCIPLINE and HARD_PROHIBITIONS, but those only reach a
 * sub-agent when an agent DEFINITION embeds them (the built-in defs compose
 * their own prompts). A spawned agent with no matching definition — the default
 * roleless call path, or a schema-documented role with no built-in (reviewer,
 * coder, codex, …) — enters its loop with a one-line role hint and no floor at
 * all. The seam in AgentTool.buildSubagentSystemPrompt injects this block
 * exactly there, and skips it when the role prompt already carries the two
 * canonical blocks, so no sentence is ever said twice.
 *
 * Deliberately NOT here: an enumerated tool list. The sub-agent's real tool
 * surface is computed per spawn (buildSubagentDenylist + the depth ceiling);
 * a second copy in prose would be a parallel source of truth. The floor states
 * the behaviour instead: never invent or fake a tool call.
 *
 * Injected (never copy-pasted) via AgentTool.buildSubagentSystemPrompt;
 * gated by KHY_SUBAGENT_COMMON_FLOOR (default on) at the seam.
 */
const SUBAGENT_COMMON_FLOOR = `=== SUB-AGENT COMMON FLOOR (reporting discipline you keep whatever your role) ===
- Report only what you verified. A result is backed by a check you actually ran (a read, a search, a command) — anything else is stated as unverified, never as fact.
- Failures stay failures. If a step errored, was skipped, or was never attempted, say so in plain words; do not describe a fix you did not make or a check you did not run.
- Use only the tools you were actually given. Never name or "call" a tool that is not in your surface; if a call is refused or missing, do the work another way or report the refusal — never pretend it succeeded.
- Close with a self-contained final reply: what was done, what was verified, what remains. The parent sees only this text, not your steps.`;

// Gate for the floor. Default-on; 0/false/off/no → applyCommonFloor passes the
// prompt through untouched. Reads only the supplied env object (pure, same
// idiom as subAgentResultFooter.isEnabled).
function _floorEnabled(env) {
  const e = env || {};
  const raw = e.KHY_SUBAGENT_COMMON_FLOOR == null ? '' : e.KHY_SUBAGENT_COMMON_FLOOR;
  const v = String(raw).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * Apply the common floor to a spawned agent's prompt — the ONE place the
 * gate + idempotence policy lives. Both injection seams call this:
 * AgentTool.buildSubagentSystemPrompt (standalone sub-agents) and the
 * coordinator worker path (workerAgent.buildWorkerPrompt); a second copy of
 * the policy would drift exactly the way the mode↔profile vocabularies did.
 *
 * @param {string} prompt - the agent's own role/system prompt
 * @param {object} [env] - injectable env (defaults to process.env), pure for tests
 * @returns {string} the prompt with the floor prepended, or untouched when
 *   already carrying the canonical blocks / the floor itself, gated off, or
 *   not a string
 */
function applyCommonFloor(prompt, env = process.env) {
  const text = typeof prompt === 'string' ? prompt : '';
  // An empty prompt has nothing to floor — prepending would only leave a
  // dangling separator behind.
  if (!text || !SUBAGENT_COMMON_FLOOR || !_floorEnabled(env)) {
    return text;
  }
  // Idempotent both ways: the built-in agent defs compose EXECUTION_DISCIPLINE
  // / HARD_PROHIBITIONS into their own prompts (a second copy is noise), and a
  // prompt that already carries the floor must not gain another.
  if (
    text.includes(SUBAGENT_COMMON_FLOOR) ||
    text.includes(EXECUTION_DISCIPLINE) ||
    text.includes(HARD_PROHIBITIONS)
  ) {
    return text;
  }
  return `${SUBAGENT_COMMON_FLOOR}\n\n${text}`;
}

// Cap for the withheld-tools notice — an anomalous huge denylist must not
// balloon the prompt; the tail folds into a count (same idiom as
// subAgentResultFooter's warning block).
const _TOOL_SURFACE_NOTICE_MAX = 20;

/**
 * Build the withheld-tools notice for a spawned agent's system prompt — the
 * VIEW of the mechanism's output (AgentTool.buildSubagentDenylist result), so
 * the model learns which tools were withheld instead of discovering it through
 * a refused call. Text lives here next to the floor line it concretises
 * ("use only the tools you were actually given"). Same gate as the floor
 * family (KHY_SUBAGENT_COMMON_FLOOR): off → '' and the whole family falls back
 * byte-identically.
 * @param {string[]|null} [deniedTools] - the mechanism's denylist output
 * @param {object} [env] - injectable env (defaults to process.env), pure for tests
 * @returns {string} '' when there is nothing to declare, the gate is off, or
 *   the input is not a non-empty array
 */
function buildToolSurfaceNotice(deniedTools, env = process.env) {
  if (!Array.isArray(deniedTools) || deniedTools.length === 0 || !_floorEnabled(env)) {
    return '';
  }
  const names = Array.from(new Set(deniedTools.filter((n) => typeof n === 'string' && n)));
  if (names.length === 0) {
    return '';
  }
  const shown = names.slice(0, _TOOL_SURFACE_NOTICE_MAX);
  const tail =
    names.length > shown.length ? `（另有 ${names.length - shown.length} 项未展开）` : '';
  return `Tools NOT available to you (a refused call means the tool was withheld, not that it failed — do the work another way or report it): ${shown.join(', ')}${tail}`;
}

module.exports = {
  EXECUTION_DISCIPLINE,
  HARD_PROHIBITIONS,
  readOnlyProhibitions,
  SUBAGENT_EXECUTION_SCOPE,
  SUBAGENT_COMMON_FLOOR,
  applyCommonFloor,
  buildToolSurfaceNotice,
};

'use strict';

/**
 * _writeToolNames.js — 文件改动类工具白名单的单一真源（零依赖纯叶子）。
 *
 * 这份归一化（小写、去空白/_/-）工具名集合此前被三处手抄，且已实际漂移：
 * replace_at_location 是注册在案的文本文件编辑工具（src/tools/replaceAtLocation.js，
 * file_path + word/replacement 参数），采集侧（services/tool/toolUseLoopHelpers 的
 * _WRITE_TOOL_NAMES）补登它时，回放档（domain/trajectory/trajectoryReplay/
 * tierRegistry 的 FILE_TOOLS）与文件锁（tools/_fileLock.js 的 WRITE_TOOL_NAMES）
 * 都漏了——前者把该工具的回合错分出 FILE 档，后者让多实例并发编辑绕过
 * 读-改-写锁（正是本锁要防的数据竞争）。三处消费方现全部从本叶子派生，
 * 本文件是唯一允许维护成员清单的地方。
 *
 * 刻意排除（建模不成立，非遗漏，勿"补全"）：
 *   - applypatch / scaffoldfiles：补丁/脚手架可能横跨多个文件，单路径 before
 *     快照建不了模；采集与锁各自落到它们自己的输出（见各自模块注释）。
 *   - createdocument / imageedit：产物是二进制（docx/图片），_safeReadForDiff
 *     对二进制本就返回 null，采集必然为空。
 *   - proposecodechange：经 git 分支落盘（人工评审流），不改工作区文件。
 */

const WRITE_TOOL_NAMES = Object.freeze(
  new Set([
    'writefile',
    'write',
    'filewrite',
    'filewritetool',
    'createfile',
    'editfile',
    'edit',
    'fileedit',
    'fileedittool',
    'multiedit',
    'multiedittool',
    'notebookedit',
    'notebookedittool',
    'fileop',
    'fileoperation',
    'replaceatlocation',
  ])
);

module.exports = { WRITE_TOOL_NAMES };

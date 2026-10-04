const sessions = new Map();
let nextId = 1;
let ptyMod = null;
// 并发上限：侧栏终端标签是唯一消费方，正常 1-2 个；上限只防泄漏，不是功能。
const MAX_SESSIONS = 8;
async function loadPty() {
    if (!ptyMod)
        ptyMod = await import('@lydell/node-pty');
    return ptyMod;
}
export async function ptyCreate(opts, sender) {
    if (sessions.size >= MAX_SESSIONS) {
        return { ok: false, error: `PTY session limit reached (${MAX_SESSIONS})` };
    }
    let mod;
    try {
        mod = await loadPty();
    }
    catch (err) {
        return { ok: false, error: `pty module unavailable: ${err?.message || String(err)}` };
    }
    // shell 选择：ComSpec 在 Windows 上必有；KHY_DESKTOP_SHELL 留给用户显式覆盖。
    const file = process.env.KHY_DESKTOP_SHELL || process.env.ComSpec || 'cmd.exe';
    const cols = Math.max(2, Math.floor(opts?.cols ?? 80));
    const rows = Math.max(2, Math.floor(opts?.rows ?? 24));
    const cwd = opts?.cwd || process.cwd();
    try {
        const pty = mod.spawn(file, [], {
            name: 'xterm-256color',
            cols,
            rows,
            cwd,
            env: { ...process.env },
        });
        const id = `pty-${nextId++}`;
        sessions.set(id, { pty, sender });
        pty.onData((data) => {
            if (sender.isDestroyed()) {
                try {
                    pty.kill();
                }
                catch { /* already gone */ }
                sessions.delete(id);
                return;
            }
            sender.send('pty:data', { id, data });
        });
        pty.onExit(({ exitCode }) => {
            sessions.delete(id);
            if (!sender.isDestroyed())
                sender.send('pty:exit', { id, code: exitCode });
        });
        return { ok: true, id, pid: pty.pid };
    }
    catch (err) {
        return { ok: false, error: `pty spawn failed: ${err?.message || String(err)}` };
    }
}
export function ptyWrite(id, data) {
    const s = sessions.get(id);
    if (!s)
        return;
    try {
        s.pty.write(String(data ?? ''));
    }
    catch { /* dead pty: exit event will clean up */ }
}
export function ptyResize(id, cols, rows) {
    const s = sessions.get(id);
    if (!s)
        return;
    try {
        s.pty.resize(Math.max(2, Math.floor(cols)), Math.max(2, Math.floor(rows)));
    }
    catch { /* dead pty */ }
}
export function ptyKill(id) {
    const s = sessions.get(id);
    if (!s)
        return;
    sessions.delete(id);
    try {
        s.pty.kill();
    }
    catch { /* already gone */ }
}
// will-quit 清理：PTY 子进程（shell）不随父进程自退，必须显式杀。
export function disposeAllPtys() {
    for (const [, s] of sessions) {
        try {
            s.pty.kill();
        }
        catch { /* already gone */ }
    }
    sessions.clear();
}

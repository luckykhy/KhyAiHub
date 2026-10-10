import { contextBridge, ipcRenderer } from 'electron';
// Phase 0b: 暴露首批 20 个高频 RPC 方法（stub 实现）
const api = {
    // 窗口控制
    minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
    maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
    closeWindow: () => ipcRenderer.invoke('window:close'),
    // F11 / F12：菜单项已随 src/main/menu.ts 退役（[DESIGN-ARCH-125] §5.2 step 4）
    toggleFullScreen: () => ipcRenderer.invoke('window:toggleFullScreen'),
    toggleDevTools: () => ipcRenderer.invoke('devtools:toggle'),
    // 设置读写
    getSettings: () => ipcRenderer.invoke('settings:get'),
    setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
    // 数据存储路径变更（复制数据 + 写指针，见 main settings:setDataPath）
    setDataPath: (newPath) => ipcRenderer.invoke('settings:setDataPath', newPath),
    // 主题
    getTheme: () => ipcRenderer.invoke('theme:get'),
    setTheme: (mode) => ipcRenderer.invoke('theme:set', mode),
    onThemeChanged: (cb) => {
        const listener = (_e, mode) => cb(mode);
        ipcRenderer.on('theme:changed', listener);
        return () => ipcRenderer.removeListener('theme:changed', listener);
    },
    // 界面缩放（main 侧 setZoomFactor + 持久化，返回实际生效值）
    setZoomFactor: (factor) => ipcRenderer.invoke('zoom:set', factor),
    // 文件系统
    openDirectoryPicker: () => ipcRenderer.invoke('fs:openDirectory'),
    // 附件/图片选择（Composer 添加上下文 → 添加附件 / 上传图片）：真实路径数组
    selectFiles: (filters) => ipcRenderer.invoke('fs:selectFiles', filters),
    readFile: (path) => ipcRenderer.invoke('fs:readFile', path),
    writeFile: (path, content) => ipcRenderer.invoke('fs:writeFile', path, content),
    // ── 代码查看（codeViewer.*）：四态只读预览 + workspace 文件索引 ──
    codeViewerRead: (filePath) => ipcRenderer.invoke('codeViewer:read', filePath),
    workspaceListFiles: (query) => ipcRenderer.invoke('workspace:listFiles', query || ''),
    // 工作区文件树（侧栏 fileTree 视图）：单目录懒加载
    workspaceReadTree: (dirPath, query) => ipcRenderer.invoke('workspace:readTree', dirPath || '', query || ''),
    // AI 网关
    aiSend: (payload) => ipcRenderer.invoke('ai:send', payload),
    aiStream: (payload) => ipcRenderer.invoke('ai:stream', payload),
    // host 流式回调（main → host aiGateway onChunk）
    onAiChunk: (cb) => {
        const listener = (_e, data) => cb(data);
        ipcRenderer.on('ai:chunk', listener);
        return () => ipcRenderer.removeListener('ai:chunk', listener);
    },
    onAiResult: (cb) => {
        const listener = (_e, data) => cb(data);
        ipcRenderer.on('ai:result', listener);
        return () => ipcRenderer.removeListener('ai:result', listener);
    },
    // 工具循环事件（main ← host runToolUseLoop 的循环级回调）。与 ai.chunk 分开：
    // chunk 是内层 LLM 的文本/思考流，这两条是工具派发与结果，缺了它们
    // 界面只能看到文字，看不到 agent 真的在读写文件。
    onAiToolCall: (cb) => {
        const listener = (_e, data) => cb(data);
        ipcRenderer.on('ai:toolCall', listener);
        return () => ipcRenderer.removeListener('ai:toolCall', listener);
    },
    onAiToolResult: (cb) => {
        const listener = (_e, data) => cb(data);
        ipcRenderer.on('ai:toolResult', listener);
        return () => ipcRenderer.removeListener('ai:toolResult', listener);
    },
    // 人在环（P1）：agent 请求审批 / 提问（toolUseLoop 的 onControlRequest）。
    // request 统一为 { subtype:'can_use_tool', tool_name, input }；应答按
    // { behavior:'allow' | 'allow-always' | 'deny' } 三态（提问另带 updatedInput.answers）。
    onAiControlRequest: (cb) => {
        const listener = (_e, data) => cb(data);
        ipcRenderer.on('ai:controlRequest', listener);
        return () => ipcRenderer.removeListener('ai:controlRequest', listener);
    },
    aiControlResponse: (payload) => ipcRenderer.invoke('ai:controlResponse', payload),
    aiAbort: () => ipcRenderer.invoke('ai:abort'),
    // ── 窗口菜单动作（L 区自绘下拉） ──
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    openPath: (dir) => ipcRenderer.invoke('app:openPath', dir),
    // 在编辑器中打开（编辑器取 settings.desktopEditor / KHY_EDITOR）
    openInEditor: (target) => ipcRenderer.invoke('app:openInEditor', target),
    // 进程监视器数据（窗口菜单 → 进程监视器）
    processInfo: () => ipcRenderer.invoke('app:processInfo'),
    getBrandingLinks: () => ipcRenderer.invoke('app:brandingLinks'),
    // 会话
    createSession: (workspacePath) => ipcRenderer.invoke('session:create', workspacePath),
    listSessions: (limit) => ipcRenderer.invoke('session:list', limit),
    // 会话真实消息流（点侧栏任务 / 重载会话）
    loadSession: (sessionId) => ipcRenderer.invoke('session:messages', sessionId),
    // ── 自动化（定时任务）：store 落盘 + 调度 tick + host ai.generate 执行 ──
    automationsList: () => ipcRenderer.invoke('automation:list'),
    automationsCreate: (input) => ipcRenderer.invoke('automation:create', input),
    automationsUpdate: (id, patch) => ipcRenderer.invoke('automation:update', id, patch),
    automationsDelete: (id) => ipcRenderer.invoke('automation:delete', id),
    automationsRunNow: (id) => ipcRenderer.invoke('automation:runNow', id),
    // ── 插件设置页：pluginStore registry（已安装/发现两 tab 的正门通道）──
    pluginsList: () => ipcRenderer.invoke('plugin:list'),
    pluginsInstall: (input) => ipcRenderer.invoke('plugin:install', input),
    pluginsSetEnabled: (id, enabled) => ipcRenderer.invoke('plugin:setEnabled', id, enabled),
    pluginsUninstall: (id) => ipcRenderer.invoke('plugin:uninstall', id),
    pluginsCheckUpdates: () => ipcRenderer.invoke('plugin:checkUpdates'),
    // ── MCP 设置页：mcpStore 落盘（用户自建服务器）+ plugin:list 宿主区（只读派生）──
    mcpList: () => ipcRenderer.invoke('mcp:list'),
    mcpCreate: (input) => ipcRenderer.invoke('mcp:create', input),
    mcpSetEnabled: (id, enabled) => ipcRenderer.invoke('mcp:setEnabled', id, enabled),
    mcpDelete: (id) => ipcRenderer.invoke('mcp:delete', id),
    mcpImport: (rows) => ipcRenderer.invoke('mcp:import', rows),
    // ── Agent 扩展条目（命令/钩子/技能/子智能体/记忆）— agentItemStore 正门 ──
    agentList: (kind) => ipcRenderer.invoke('agent:list', kind),
    agentCreate: (kind, input) => ipcRenderer.invoke('agent:create', kind, input),
    agentSetEnabled: (kind, id, enabled) => ipcRenderer.invoke('agent:setEnabled', kind, id, enabled),
    agentDelete: (kind, id) => ipcRenderer.invoke('agent:delete', kind, id),
    agentImport: (kind, rows) => ipcRenderer.invoke('agent:import', kind, rows),
    // ── 索引库页 — indexStore（磁盘扫描统计）──
    indexList: () => ipcRenderer.invoke('index:list'),
    indexCreate: (input) => ipcRenderer.invoke('index:create', input),
    indexRebuild: (id) => ipcRenderer.invoke('index:rebuild', id),
    indexSetEnabled: (id, enabled) => ipcRenderer.invoke('index:setEnabled', id, enabled),
    indexDelete: (id) => ipcRenderer.invoke('index:delete', id),
    // ── 外部 Agent 迁移（引导弹窗数据迁移向导，D5/s-8）+ 数据根路径只读 ──
    migrationScan: () => ipcRenderer.invoke('migration:scan'),
    migrationImport: (sourceId) => ipcRenderer.invoke('migration:import', sourceId),
    getDataHome: () => ipcRenderer.invoke('app:dataHome'),
    // ── 审查面板：只读 Git 状态（main 侧 git status --porcelain -z --branch）──
    gitStatus: () => ipcRenderer.invoke('git:status'),
    // Token 用量（后端 tokenUsageService 真源，经 host 桥 CH-2）
    getTokenUsage: () => ipcRenderer.invoke('token:usage'),
    // 用量历史：近 N 日曲线 + 按模型分桶（使用统计页，ZC-ALIGN-001 P13）
    getUsageHistory: (days) => ipcRenderer.invoke('usage:history', days),
    // 上下文窗口估算（estimateTokens 真源启发式 + KHY_CONTEXT_WINDOW 上限，P3-5/P3-6）
    estimateContextSize: (text) => ipcRenderer.invoke('context:size', text),
    // 模型/provider 列表（providerPresets 真源，P3-7；adapterKey 传入时叠加
    // 该 adapter 的运行时动态模型，P3-7③）
    listModels: (adapterKey) => ipcRenderer.invoke('models:list', adapterKey),
    // 运行中后台任务计数（P3-6①：host 在途 ai.generate 集合，Composer 按钮数据源）
    backgroundStatus: () => ipcRenderer.invoke('background:status'),
    // 电脑控制安全闸生效状态（host env 实读，ZC-ALIGN-002 I11）
    desktopGateGet: () => ipcRenderer.invoke('desktopGate:get'),
    // ── 真终端 PTY（[DESIGN-ARCH-176] A3）：通道名与 main/index.ts 的 pty:* handle 配对（D6）──
    ptyCreate: (opts) => ipcRenderer.invoke('pty:create', opts || {}),
    ptyWrite: (id, data) => ipcRenderer.invoke('pty:write', id, data),
    ptyResize: (id, cols, rows) => ipcRenderer.invoke('pty:resize', id, cols, rows),
    ptyKill: (id) => ipcRenderer.invoke('pty:kill', id),
    // main → renderer 数据流（ptyHost 在 create 时的 sender 上 send）
    onPtyData: (cb) => {
        const listener = (_e, payload) => cb(payload);
        ipcRenderer.on('pty:data', listener);
        return () => ipcRenderer.removeListener('pty:data', listener);
    },
    onPtyExit: (cb) => {
        const listener = (_e, payload) => cb(payload);
        ipcRenderer.on('pty:exit', listener);
        return () => ipcRenderer.removeListener('pty:exit', listener);
    },
    // 平台信息
    getPlatform: () => process.platform,
    // 版本
    getVersion: () => ipcRenderer.invoke('app:version'),
    // 工作区根目录（main 进程 cwd）
    getWorkspacePath: () => ipcRenderer.invoke('app:workspacePath'),
    // 工作空间选择（[DESIGN-ARCH-125]）：list = 当前根 + 最近打开候选集；
    // open = 带路径直接切（最近打开），不带路径弹系统目录框（打开其他文件夹…）。
    // 切换成功后由渲染层广播 khy:workspace-changed，各消费者按既有约定重新发现根。
    workspaceList: () => ipcRenderer.invoke('workspace:list'),
    workspaceOpen: (target) => ipcRenderer.invoke('workspace:open', target || ''),
    // ── 密钥与端点管理 (DESIGN-ARCH-091 §6, P1) ──
    // 入口①（§5.1）：主窗窗口菜单 / Ctrl+Shift+K 打开独立管理窗口
    openKeyManagerWindow: () => ipcRenderer.invoke('keymanager:openWindow'),
    // keys
    keysList: () => ipcRenderer.invoke('keys:list'),
    keysAdd: (input) => ipcRenderer.invoke('keys:add', input),
    keysUpdate: (provider, keyId, patch) => ipcRenderer.invoke('keys:update', provider, keyId, patch),
    keysRemove: (provider, keyId) => ipcRenderer.invoke('keys:remove', provider, keyId),
    keysToggle: (provider, keyId, enabled) => ipcRenderer.invoke('keys:toggle', provider, keyId, enabled),
    keysReveal: (provider, keyId) => ipcRenderer.invoke('keys:reveal', provider, keyId),
    keysImport: () => ipcRenderer.invoke('keys:import'),
    // providers (custom metadata)
    providersList: () => ipcRenderer.invoke('providers:list'),
    providersAdd: (p) => ipcRenderer.invoke('providers:add', p),
    providersRemove: (id) => ipcRenderer.invoke('providers:remove', id),
    // endpoints / models
    endpointsPresets: () => ipcRenderer.invoke('endpoints:presets'),
    endpointsValidate: (input) => ipcRenderer.invoke('endpoints:validate', input),
    modelsFetch: (input) => ipcRenderer.invoke('models:fetch', input),
    // cards (credential-free)
    cardsList: () => ipcRenderer.invoke('cards:list'),
    cardsAdd: (input) => ipcRenderer.invoke('cards:add', input),
    cardsUpdate: (cardId, patch) => ipcRenderer.invoke('cards:update', cardId, patch),
    cardsRemove: (cardId) => ipcRenderer.invoke('cards:remove', cardId),
    // agents (Mode B 一键激活)
    agentsMatrix: () => ipcRenderer.invoke('agents:matrix'),
    agentsApply: (input) => ipcRenderer.invoke('agents:apply', input),
    agentsRevert: (app) => ipcRenderer.invoke('agents:revert', app),
    // proxy
    proxyStatus: () => ipcRenderer.invoke('proxy:status'),
    proxyStart: () => ipcRenderer.invoke('proxy:start'),
    // health / audit
    healthProbe: (input) => ipcRenderer.invoke('health:probe', input || {}),
    healthAuditList: (limit) => ipcRenderer.invoke('health:audit-list', limit),
    healthAuditExport: (dest) => ipcRenderer.invoke('health:audit-export', dest)
};
contextBridge.exposeInMainWorld('__KHYOS__', api);

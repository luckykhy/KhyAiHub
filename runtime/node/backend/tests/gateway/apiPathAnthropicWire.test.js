'use strict';

/**
 * apiPathAnthropicWire.test.js — 「任意 OpenAI 线模型经 khy 网关在 Claude Code 里用」
 * 这条链路的**出线形状**锁定（multiFreeService.callOpenAI，即 api 适配器的上游）。
 *
 * 背景（勘察一登记的 7 个缺口里落在本文件的 4 个）：
 *   ① Anthropic 工具回合历史整条丢失：proxyServer 把 canonical.messages 扁平化成
 *      structuredMessages（content 变纯文本、toolCalls/toolResults 拆到顶层），
 *      callOpenAI 又只吃 structuredMessages → hasAnthropicToolBlocks 恒 false →
 *      convertMessagesAnthropicToOpenAI 不跑 → 上游只看到空 content + 未知字段。
 *   ② tool_choice 丢失：canonical.toolChoice 到了 generateResponse 就被丢掉，
 *      Claude Code 的 forced tool_use 到不了 OpenAI 上游。
 *   ③ thinking 丢失：callOpenAI 从不读 reasoning_content，reasoning-only 回复
 *      表现为「空回复」。
 *   ④ 流式 usage 失真：api 路径只发 {type:'cost'}，而 proxyServer 的 Anthropic
 *      SSE 重组只认 {type:'token_usage'} → message_delta.usage 恒 0/chunk 计数。
 *
 * 测法：起一个真的 127.0.0.1 HTTP 服务器（零 mock 框架、零网络出口），把 provider
 * 的 baseUrl 指过去，直接调 callOpenAI，断言**服务器实际收到的请求体**与
 * **onChunk 实际发出的 chunk 序列**。这比 mock 掉 postWithDeadConnRetry 更接近
 * 生产：序列化、SSE 分行、流式/非流式分叉全都走真实代码。
 */
const http = require('http');

const MultiFreeService = require('../../src/services/multiFreeService');

/** 起一个一次性服务器，返回 { port, requests, close }。 */
function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        /* keep null */
      }
      requests.push({ url: req.url, method: req.method, body: parsed, raw: body });
      handler(req, res, parsed);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        requests,
        close: () =>
          new Promise((done) => {
            // nativeHttp 用模块级 keep-alive agent，空闲 socket 会被 server.close() 挂住；
            // 先显式断开再关，避免 finally 里的 close 永不回调。
            if (typeof server.closeAllConnections === 'function') {
              server.closeAllConnections();
            }
            server.close(() => done());
          }),
      });
    });
  });
}

function sseRes(res, lines) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const line of lines) {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  }
  res.end();
}

function jsonRes(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function makeProvider(port, overrides = {}) {
  return {
    key: 'openai',
    name: 'TestOpenAI',
    apiKey: 'test-key',
    baseUrl: `http://127.0.0.1:${port}`,
    model: 'gpt-4o-mini',
    enabled: true,
    priority: 0,
    supportsVision: false,
    ...overrides,
  };
}

// Claude Code 经 /v1/messages 入站后 proxyServer 会产出的两种消息源：
//   rawMessages        —— body.messages 原样（content 数组里带 tool_use/tool_result）
//   structuredMessages —— canonical.messages 扁平化（content 变纯文本）
const RAW_WITH_TOOL_TURN = [
  { role: 'user', content: '读一下 README' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: '好，我来读。' },
      { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: 'README.md' } },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_01', content: '# KhyOS\nhello' },
    ],
  },
];

const FLAT_STRUCTURED = [
  { role: 'user', content: '读一下 README' },
  {
    role: 'assistant',
    content: '好，我来读。',
    toolCalls: [{ id: 'toolu_01', name: 'Read', arguments: { file_path: 'README.md' } }],
  },
  { role: 'user', content: '', toolResults: [{ toolCallId: 'toolu_01', content: '# KhyOS\nhello' }] },
];

const ANTHROPIC_TOOLS = [
  { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } },
];

describe('api 路径（callOpenAI）Anthropic 出线形状', () => {
  // 首个用例含 jest worker 的模块图冷启动（multiFreeService 的 require 家族），
  // 远大于默认 5s；这里显式放宽，避免把冷启动误判成挂死。
  jest.setTimeout(60_000);

  let svc;
  beforeEach(() => {
    svc = new MultiFreeService();
  });

  test('rawMessages 里的 tool_use/tool_result 变成 OpenAI 的 tool_calls + role:tool', async () => {
    const srv = await startServer((req, res) => jsonRes(res, {
      choices: [{ message: { role: 'assistant', content: '读完了' }, finish_reason: 'stop' }],
    }));
    try {
      await svc.callOpenAI(makeProvider(srv.port), 'ignored', {
        model: 'gpt-4o-mini',
        rawMessages: RAW_WITH_TOOL_TURN,
        structuredMessages: FLAT_STRUCTURED,
        tools: ANTHROPIC_TOOLS,
      });

      expect(srv.requests).toHaveLength(1);
      const messages = srv.requests[0].body.messages;
      // 1) assistant 回合带 tool_calls
      const assistant = messages.find((m) => m.role === 'assistant');
      expect(assistant.tool_calls).toEqual([
        {
          id: 'toolu_01',
          type: 'function',
          function: { name: 'Read', arguments: JSON.stringify({ file_path: 'README.md' }) },
        },
      ]);
      // 2) tool_result 变成 role:'tool' 且带上 tool_use_id
      const toolMsg = messages.find((m) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg.tool_call_id).toBe('toolu_01');
      expect(toolMsg.content).toContain('KhyOS');
      // 3) 工具结果不再是空 content（扁平化路径下的症状）
      const emptyUser = messages.filter((m) => m.role === 'user' && m.content === '');
      expect(emptyUser).toHaveLength(0);
    } finally {
      await srv.close();
    }
  });

  test('rawMessages 优先于 structuredMessages（最高保真源），无 rawMessages 时逐字节走老路', async () => {
    const srv = await startServer((req, res) => jsonRes(res, {
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }));
    try {
      // A) 两者都在 → 用 rawMessages
      await svc.callOpenAI(makeProvider(srv.port), 'PROMPT-SHOULD-NOT-BE-USED', {
        model: 'gpt-4o-mini',
        rawMessages: RAW_WITH_TOOL_TURN,
        structuredMessages: FLAT_STRUCTURED,
      });
      expect(srv.requests[0].body.messages.some((m) => m.role === 'tool')).toBe(true);
      expect(srv.requests[0].body.messages.some((m) => m.role === 'user' && m.content === 'PROMPT-SHOULD-NOT-BE-USED')).toBe(false);

      // B) 只有 structuredMessages → 老路径（prompt 作为唯一 user 消息的兜底不触发）
      await svc.callOpenAI(makeProvider(srv.port), 'plain prompt', {
        model: 'gpt-4o-mini',
        structuredMessages: FLAT_STRUCTURED,
      });
      const flat = srv.requests[1].body.messages;
      expect(flat.some((m) => m.role === 'tool')).toBe(false);
      // 首位那条 system 是既有的 [Model Identity] 注入（与本次改动无关），
      // 断言时把它排除掉，只比对话本体。
      expect(flat.filter((m) => m.role !== 'system').map((m) => m.role)).toEqual(['user', 'assistant', 'user']);

      // C) 两个源都没有 → prompt 兜底（原行为）。首位 system 是既有的
      // [Model Identity] 注入，与本次改动无关，故只断言 user 消息。
      await svc.callOpenAI(makeProvider(srv.port), 'plain prompt', { model: 'gpt-4o-mini' });
      expect(srv.requests[2].body.messages.filter((m) => m.role !== 'system')).toEqual([
        { role: 'user', content: 'plain prompt' },
      ]);
    } finally {
      await srv.close();
    }
  });

  test('rawMessages 里的 role:system 消息被顶上系统提示槽，不重复也不丢失', async () => {
    const srv = await startServer((req, res) => jsonRes(res, {
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }));
    try {
      await svc.callOpenAI(makeProvider(srv.port), 'hi', {
        model: 'gpt-4o-mini',
        system: 'OUTER SYSTEM',
        rawMessages: [
          { role: 'system', content: 'INNER SYSTEM' },
          { role: 'user', content: 'hi' },
        ],
      });
      const messages = srv.requests[0].body.messages;
      const systemMsgs = messages.filter((m) => m.role === 'system');
      expect(systemMsgs).toHaveLength(1);
      expect(systemMsgs[0].content).toContain('OUTER SYSTEM');
      expect(systemMsgs[0].content).toContain('INNER SYSTEM');

      // 没有 opts.system 时，rawMessages 里的 system 也不能静默消失
      // （尾部会追加既有的 [Model Identity] 注入，故用 contains）
      await svc.callOpenAI(makeProvider(srv.port), 'hi', {
        model: 'gpt-4o-mini',
        rawMessages: [
          { role: 'system', content: 'ONLY INNER' },
          { role: 'user', content: 'hi' },
        ],
      });
      const only = srv.requests[1].body.messages.filter((m) => m.role === 'system');
      expect(only).toHaveLength(1);
      expect(only[0].content).toContain('ONLY INNER');
    } finally {
      await srv.close();
    }
  });

  test('rawMessages 里的 Anthropic 图片块转成 OpenAI vision 块（不原样上线挨 400）', async () => {
    const srv = await startServer((req, res) => jsonRes(res, {
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }));
    try {
      await svc.callOpenAI(makeProvider(srv.port), '看图', {
        model: 'gpt-4o-mini',
        rawMessages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '这是什么' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
            ],
          },
        ],
      });
      const user = srv.requests[0].body.messages.find((m) => m.role === 'user');
      expect(Array.isArray(user.content)).toBe(true);
      const img = user.content.find((b) => b.type === 'image_url');
      expect(img).toBeDefined();
      expect(img.image_url.url).toMatch(/^data:image\/png;base64,/);
      // 原样的 Anthropic 块不许残留
      expect(user.content.some((b) => b.type === 'image')).toBe(false);
    } finally {
      await srv.close();
    }
  });

  test('tool_choice 随 tools 一起上线；没有 tools 时不带（免得严格端点 400）', async () => {
    const srv = await startServer((req, res) => jsonRes(res, {
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }));
    try {
      await svc.callOpenAI(makeProvider(srv.port), 'hi', {
        model: 'gpt-4o-mini',
        tools: ANTHROPIC_TOOLS,
        toolChoice: { type: 'function', function: { name: 'Read' } },
      });
      expect(srv.requests[0].body.tool_choice).toEqual({ type: 'function', function: { name: 'Read' } });
      expect(srv.requests[0].body.tools).toHaveLength(1);

      // 有 tool_choice 但 tools 被剥（此处模拟：不传 tools）→ 不写 tool_choice
      await svc.callOpenAI(makeProvider(srv.port), 'hi', {
        model: 'gpt-4o-mini',
        toolChoice: 'required',
      });
      expect('tool_choice' in srv.requests[1].body).toBe(false);

      // 'auto' / 'required' 串原样透传
      await svc.callOpenAI(makeProvider(srv.port), 'hi', {
        model: 'gpt-4o-mini',
        tools: ANTHROPIC_TOOLS,
        toolChoice: 'auto',
      });
      expect(srv.requests[2].body.tool_choice).toBe('auto');
    } finally {
      await srv.close();
    }
  });

  test('流式 reasoning_content → thinking chunk + 返回值；不混进正文', async () => {
    const srv = await startServer((req, res) => sseRes(res, [
      { choices: [{ delta: { reasoning_content: '让我想一下' } }] },
      { choices: [{ delta: { content: '答案是 42' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } },
    ]));
    try {
      const chunks = [];
      const result = await svc.callOpenAI(makeProvider(srv.port), 'hi', {
        model: 'gpt-4o-mini',
        onChunk: (c) => chunks.push(c),
      });

      expect(result.content).toBe('答案是 42');
      expect(result.thinking).toBe('让我想一下');
      const thinkingChunks = chunks.filter((c) => c.type === 'thinking');
      expect(thinkingChunks.map((c) => c.text).join('')).toBe('让我想一下');
      const textChunks = chunks.filter((c) => c.type === 'text');
      expect(textChunks.map((c) => c.text).join('')).toBe('答案是 42');
    } finally {
      await srv.close();
    }
  });

  test('非流式 reasoning_content 也被带回（不再表现为空回复）', async () => {
    const srv = await startServer((req, res) => jsonRes(res, {
      choices: [{
        message: { role: 'assistant', content: '', reasoning_content: '只有思考' },
        finish_reason: 'stop',
      }],
    }));
    try {
      const result = await svc.callOpenAI(makeProvider(srv.port), 'hi', { model: 'gpt-4o-mini' });
      expect(result.content).toBe('');
      expect(result.thinking).toBe('只有思考');
    } finally {
      await srv.close();
    }
  });

  test('流式 usage 同时发 cost 与 token_usage（proxyServer 的 Anthropic 重组只认后者）', async () => {
    const srv = await startServer((req, res) => sseRes(res, [
      { choices: [{ delta: { content: 'hi' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } },
    ]));
    try {
      const chunks = [];
      const result = await svc.callOpenAI(makeProvider(srv.port), 'hi', {
        model: 'gpt-4o-mini',
        onChunk: (c) => chunks.push(c),
      });

      // 老消费者不变
      const cost = chunks.filter((c) => c.type === 'cost');
      expect(cost).toHaveLength(1);
      expect(cost[0].cost).toEqual({ inputTokens: 11, outputTokens: 5, totalTokens: 16 });

      // 新：token_usage 与 _cwStreamParser 发的那种逐字同形
      const usage = chunks.filter((c) => c.type === 'token_usage');
      expect(usage).toHaveLength(1);
      expect(usage[0].inputTokens).toBe(11);
      expect(usage[0].outputTokens).toBe(5);
      expect(usage[0].totalTokens).toBe(16);

      expect(result.tokenUsage).toEqual({ inputTokens: 11, outputTokens: 5, totalTokens: 16 });
    } finally {
      await srv.close();
    }
  });

  test('缓存计费字段随 token_usage 一起带回（cache_read / cache_creation）', async () => {
    const srv = await startServer((req, res) => sseRes(res, [
      { choices: [{ delta: { content: 'hi' } }] },
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 } },
    ]));
    try {
      const chunks = [];
      await svc.callOpenAI(makeProvider(srv.port), 'hi', {
        model: 'gpt-4o-mini',
        onChunk: (c) => chunks.push(c),
      });
      const usage = chunks.find((c) => c.type === 'token_usage');
      expect(usage.cacheReadInputTokens).toBe(7);
      expect(usage.cacheWriteInputTokens).toBe(3);
    } finally {
      await srv.close();
    }
  });

  test('端到端：apiAdapter.generate → generateResponse → callOpenAI 把 rawMessages/tool_choice 带到线上', async () => {
    // 这一条守的是「转发链」本身：proxyServer 把 rawMessages/tool_choice 写进
    // generateOptions，网关原样透给 api 适配器，api 适配器再透给 multiFreeService。
    // 三层里任何一层把新字段漏掉，Claude Code 的工具回合就会静默断掉。
    const srv = await startServer((req, res) => jsonRes(res, {
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }));
    try {
      const adapter = require('../../src/services/gateway/adapters/apiAdapter');
      const result = await adapter.generate('ignored', {
        // 三段式：api:<pool>:<model>（卡片/自定义池的形态）
        model: 'api:cc_switch_c_e2e:gpt-4o-mini',
        apiKey: 'pool-key',
        apiEndpoint: `http://127.0.0.1:${srv.port}/v1`,
        rawMessages: RAW_WITH_TOOL_TURN,
        tools: ANTHROPIC_TOOLS,
        toolChoice: { type: 'function', function: { name: 'Read' } },
      });

      expect(result.success).toBe(true);
      expect(srv.requests).toHaveLength(1);
      const body = srv.requests[0].body;
      // 1) 模型 id 是裸 id（池段已被剥掉当 poolKey）
      expect(body.model).toBe('gpt-4o-mini');
      // 2) 工具回合历史在线上
      expect(body.messages.some((m) => m.role === 'tool')).toBe(true);
      expect(body.messages.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))).toBe(true);
      // 3) tool_choice 在线上
      expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'Read' } });
      // 4) 用的是池注入的 key/endpoint（Authorization 头由 nativeHttp 发出，这里验证端点命中）
      expect(srv.requests[0].url).toBe('/v1/chat/completions');
    } finally {
      await srv.close();
    }
  });
});

'use strict';

/**
 * multiFreeService zen headers — Zen endpoint injects free-gate fingerprint
 * headers and forces stream:true even without an onChunk callback.
 *
 * Uses the same multiFreeService.httpClient override pattern as streamUsage tests.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const MultiFreeService = require('../../src/services/multiFreeService');
const { ZEN_BASE_URL, _reset } = require('../../src/services/zenGatekeeper');
const retired = require('../../src/services/zenRetiredModels');
const axios = MultiFreeService.httpClient;

function sseStream(lines) {
  return Readable.from(lines.map((l) => l + '\n\n'));
}

describe('MultiFreeService Zen free gate', () => {
  let origPost;
  let sandbox;
  beforeAll(() => {
    origPost = axios.post;
  });
  afterAll(() => {
    axios.post = origPost;
  });

  beforeEach(() => {
    _reset();
    delete process.env.OPENCODE_CLIENT;
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-svc-'));
    process.env.KHY_ZEN_RETIRED_FILE = path.join(sandbox, 'zen_retired_models.json');
    retired._reset();
  });

  afterEach(() => {
    delete process.env.KHY_ZEN_RETIRED_FILE;
    retired._reset();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  test('injects opencode fingerprint headers and forces stream=true', async () => {
    let captured = { url: null, body: null, headers: null };
    axios.post = async (url, body, config) => {
      captured = { url, body, headers: config && config.headers };
      return {
        data: sseStream([
          'data: {"choices":[{"delta":{"content":"hi"}}]}',
          'data: [DONE]',
        ]),
      };
    };

    const svc = new MultiFreeService();
    // No onChunk — Zen must still force the streaming path for the free gate.
    const provider = {
      name: 'opencode-zen',
      apiKey: 'public',
      baseUrl: ZEN_BASE_URL.replace(/\/v1$/, ''),
      model: 'mimo-v2.6-flash-free',
    };
    const res = await svc.callOpenAI(provider, 'hello', {});

    expect(captured.url).toContain('/v1/chat/completions');
    expect(captured.body.stream).toBe(true);
    expect(captured.headers['User-Agent']).toMatch(/^opencode\//);
    expect(captured.headers['x-opencode-session']).toMatch(/^ses_/);
    expect(captured.headers['x-opencode-client']).toBe('cli');
    expect(captured.headers.Authorization).toBe('Bearer public');
    // Free-tier body gate: tools[] must contain both bash and read (mitm-captured).
    const toolNames = (captured.body.tools || []).map((t) => t.function && t.function.name);
    expect(toolNames).toEqual(expect.arrayContaining(['bash', 'read']));
    expect(captured.body.tool_choice).toBe('none');
    expect(res.content).toBe('hi');
  });

  test('non-Zen endpoints do not get the fingerprint headers', async () => {
    let captured = { headers: null };
    axios.post = async (url, body, config) => {
      captured = { headers: config && config.headers };
      return {
        data: sseStream(['data: [DONE]']),
      };
    };

    const svc = new MultiFreeService();
    const provider = {
      name: 'other',
      apiKey: 'sk-x',
      baseUrl: 'https://example.com',
      model: 'm',
    };
    await svc.callOpenAI(provider, 'hello', { onChunk() {} });

    expect(captured.headers['x-opencode-session']).toBeUndefined();
    expect(captured.headers.Authorization).toBe('Bearer sk-x');
  });

  // 接线层回归：recordFromUpstreamError 只返回判据，真正的落盘在 markRetired。
  // 这组断言守的正是「分类器被调用但结果被丢弃」这一形态 —— 单测分类器永远发现不了。
  describe('retirement feedback wiring', () => {
    function zenProvider() {
      return {
        name: 'opencode-zen',
        apiKey: 'public',
        baseUrl: ZEN_BASE_URL,
        model: 'brand-new-free',
      };
    }

    test('410 ModelDeprecated marks the model retired', async () => {
      const err = new Error('boom');
      err.response = {
        status: 410,
        data: { error: { type: 'ModelDeprecated', message: 'Model brand-new-free has been deprecated.' } },
      };
      axios.post = async () => {
        throw err;
      };

      const svc = new MultiFreeService();
      await expect(
        svc.callOpenAI(zenProvider(), 'hi', { onChunk() {} })
      ).rejects.toBeDefined();

      expect(retired.isRetired('brand-new-free')).toBe(true);
    });

    test('403 quota error does NOT retire the model', async () => {
      const err = new Error('boom');
      err.response = {
        status: 403,
        data: { error: { type: 'FreeTierError', message: "OpenCode's free tier can only be used from within OpenCode" } },
      };
      axios.post = async () => {
        throw err;
      };

      const svc = new MultiFreeService();
      await expect(
        svc.callOpenAI(zenProvider(), 'hi', { onChunk() {} })
      ).rejects.toBeDefined();

      // 403 与「模型下线」无关：配额耗尽时长得一模一样，误记会把好模型永久藏起来。
      expect(retired.isRetired('brand-new-free')).toBe(false);
    });

    test('a retired model disappears from the next list', async () => {
      const err = new Error('boom');
      err.response = {
        status: 401,
        data: { error: { type: 'ModelError', message: 'Model brand-new-free is not supported' } },
      };
      axios.post = async () => {
        throw err;
      };

      const svc = new MultiFreeService();
      await expect(
        svc.callOpenAI(zenProvider(), 'hi', { onChunk() {} })
      ).rejects.toBeDefined();

      const { filterFreeZenModels } = require('../../src/services/zenGatekeeper');
      expect(filterFreeZenModels(['brand-new-free', 'space-bunny-free'])).toEqual([
        'space-bunny-free',
      ]);
    });
  });
});

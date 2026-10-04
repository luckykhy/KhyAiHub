'use strict';

/**
 * r66 contract test — /moa must forward its prompt verbatim.
 *
 * Ground truth this pins (measured in .khy/feedback/hci-r66-moa-prompt-eaten):
 * unquoted flags never reach the handler (parseInput consumes them into
 * `options`), so any flag-shaped text inside the handler input is quoted user
 * content. The former generic `/--\w+\s+\S+/g` strip silently shredded such
 * content ("比较 --models a 与 b 哪个好" → "比较  与 b 哪个好").
 */

const path = require('path');

const HANDLER = path.join(__dirname, '../../src/cli/handlers/moa.js');
const MOA_SERVICE = path.join(__dirname, '../../src/services/moaService.js');
const AI_GATEWAY = path.join(__dirname, '../../src/services/gateway/aiGateway.js');

let capturedParams;
let serviceAvailable;

function freshHandleMoa() {
  // Re-require the handler with stubs so runMoa never touches the network.
  jest.isolateModules(() => {
    jest.doMock(MOA_SERVICE, () => ({
      runMoa: jest.fn(async (params) => {
        capturedParams = params;
        return {
          ok: true,
          references: [
            { model: 'm1', content: 'alpha' },
            { model: 'm2', content: 'beta' },
          ],
          aggregatorModel: 'm1',
          finalAnswer: 'STUB-ANSWER',
        };
      }),
    }));
    jest.doMock(AI_GATEWAY, () => ({
      listModels: () => [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
    }));
    const identity = (s) => String(s);
    const chalkStub = new Proxy(identity, {
      get: () => chalkStub,
      apply: (_t, _thisArg, args) => args.map(String).join(' '),
    });
    const { handleMoa } = require(HANDLER);
    const svc = require(MOA_SERVICE);
    serviceAvailable = svc;
    handleMoa.__chalk = chalkStub;
    module.exports.__pending = { handleMoa, chalkStub };
  });
}

beforeEach(() => {
  capturedParams = null;
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function callHandler(input, options = {}) {
  freshHandleMoa();
  const { handleMoa, chalkStub } = module.exports.__pending;
  await handleMoa(input, { chalk: chalkStub, options });
  return capturedParams;
}

describe('r66: /moa prompt verbatim contract', () => {
  test('T0 non-vacuity: plain prompt reaches runMoa untouched', async () => {
    const params = await callHandler('解释一下 MoA');
    expect(serviceAvailable).toBeTruthy();
    expect(params).not.toBeNull();
    expect(params.prompt).toBe('解释一下 MoA');
  });

  test('T1 quoted flag-like content is preserved verbatim', async () => {
    // This exact string is what dispatch forwards for /moa "比较 --models a 与 b 哪个好";
    // before r66 the handler mangled it to "比较  与 b 哪个好".
    const params = await callHandler('比较 --models a 与 b 哪个好');
    expect(params.prompt).toBe('比较 --models a 与 b 哪个好');
  });

  test('T1b multi-kebab flag-like text preserved', async () => {
    const params = await callHandler('分析 --user alice 与 --top 10 的排名');
    expect(params.prompt).toBe('分析 --user alice 与 --top 10 的排名');
  });

  test('T2 own flags still flow through options, prompt stays clean', async () => {
    // parseInput consumed the flags before the handler; the removed regex must
    // not be needed to keep them out of the prompt.
    const params = await callHandler('问题', {
      models: 'gpt-4,claude',
      aggregator: 'gpt-4',
      timeout: '60',
    });
    expect(params.prompt).toBe('问题');
    expect(params.models).toEqual(['gpt-4', 'claude']);
    expect(params.aggregatorModel).toBe('gpt-4');
    expect(params.timeoutMs).toBe(60000);
  });

  test('T3 empty prompt keeps its guard: runMoa not called', async () => {
    const params = await callHandler('   ');
    expect(params).toBeNull();
    const printed = console.log.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(printed).toMatch(/请提供一个问题/);
  });
});

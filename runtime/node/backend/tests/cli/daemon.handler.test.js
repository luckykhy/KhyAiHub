'use strict';

jest.mock('../../src/services/daemonManager', () => ({
  daemonStart: jest.fn(),
  daemonStop: jest.fn(),
  daemonStatus: jest.fn(),
  daemonRestart: jest.fn(),
  getLogPath: jest.fn(),
}));

jest.mock('../../src/services/sessionPersistence', () => ({
  listPersistedSessions: jest.fn(() => []),
}));

const dm = require('../../src/services/daemonManager');
const { handleDaemon } = require('../../src/cli/handlers/daemon');

function createChalk() {
  const fn = (value) => value;
  fn.green = fn;
  fn.yellow = fn;
  fn.red = fn;
  fn.dim = fn;
  fn.bold = fn;
  fn.cyan = fn;
  return fn;
}

describe('daemon handler', () => {
  const chalk = createChalk();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    console.log.mockRestore();
  });

  test('start prints the actual runtime port when the requested port is occupied', async () => {
    dm.daemonStart.mockReturnValue({ pid: 4321, port: 9090 });
    dm.daemonStatus.mockResolvedValue({
      running: true,
      pid: 4321,
      port: 9093,
      uptime: 1200,
      health: { status: 'ok' },
    });
    dm.getLogPath.mockReturnValue('/tmp/khy-daemon.log');

    await handleDaemon('start', { chalk, options: { port: '9090' } });

    expect(console.log).toHaveBeenNthCalledWith(
      1,
      '  守护进程已启动（PID 4321，端口 9093；请求的 9090 已被占用，自动改用空闲端口）'
    );
    expect(console.log).toHaveBeenNthCalledWith(2, '  日志: /tmp/khy-daemon.log');
  });

  test('restart prints the actual runtime port when the requested port is occupied', async () => {
    dm.daemonRestart.mockReturnValue({ pid: 5321, port: 9090 });
    dm.daemonStatus.mockResolvedValue({
      running: true,
      pid: 5321,
      port: 9094,
      uptime: 800,
      health: { status: 'ok' },
    });

    await handleDaemon('restart', { chalk, options: { port: '9090' } });

    expect(console.log).toHaveBeenCalledWith(
      '  守护进程已重启（PID 5321，端口 9094；请求的 9090 已被占用，自动改用空闲端口）'
    );
  });
});

'use strict';

const deferredAuth = require('../../src/cli/deferredAuth');

// KHY_DEFER_AUTH 的判据是「推迟不授予任何新权力」：pending 期间只放行界面操作，
// 落地失败则一条也不放行。这些断言就是那条边界的可执行版本。
describe('deferredAuth', () => {
  beforeEach(() => deferredAuth.reset());
  afterAll(() => deferredAuth.reset());

  describe('isEnabled', () => {
    test('defaults to off when the env var is absent', () => {
      expect(deferredAuth.isEnabled({}, { interactive: true })).toBe(false);
    });

    test('is on only for interactive, non-one-shot runs', () => {
      const env = { KHY_DEFER_AUTH: '1' };
      expect(deferredAuth.isEnabled(env, { interactive: true })).toBe(true);
      expect(deferredAuth.isEnabled(env, { interactive: true, oneShot: true })).toBe(false);
      expect(deferredAuth.isEnabled(env, { interactive: false })).toBe(false);
    });

    test('accepts the same on-writings as the rest of the CLI', () => {
      for (const v of ['1', 'true', 'on', 'yes', ' TRUE ']) {
        expect(deferredAuth.isEnabled({ KHY_DEFER_AUTH: v }, { interactive: true })).toBe(true);
      }
      for (const v of ['0', 'false', 'off', 'no', '']) {
        expect(deferredAuth.isEnabled({ KHY_DEFER_AUTH: v }, { interactive: true })).toBe(false);
      }
    });
  });

  describe('pending window', () => {
    test('is not pending until an auth is attached', () => {
      expect(deferredAuth.isPending()).toBe(false);
      expect(deferredAuth.state()).toBe(deferredAuth.OK);
    });

    test('allows only interface commands while pending', () => {
      deferredAuth.attach(new Promise(() => {})); // never settles
      expect(deferredAuth.isPending()).toBe(true);
      for (const cmd of ['help', 'exit', 'quit', 'clear', 'HELP']) {
        expect(deferredAuth.isAllowedCommand(cmd)).toBe(true);
      }
      // Everything that reads config, calls a provider, or executes a tool.
      for (const cmd of ['status', 'model', 'theme', 'ai', 'os', 'resume', '']) {
        expect(deferredAuth.isAllowedCommand(cmd)).toBe(false);
      }
    });
  });

  describe('settling', () => {
    test('goes ok and lets callers through on success', async () => {
      deferredAuth.attach(Promise.resolve(true));
      await expect(deferredAuth.whenSettled()).resolves.toBe(true);
      expect(deferredAuth.state()).toBe(deferredAuth.OK);
      expect(deferredAuth.isFailed()).toBe(false);
    });

    test('goes failed on a rejected login and blocks callers', async () => {
      deferredAuth.attach(Promise.reject(new Error('network down')));
      await expect(deferredAuth.whenSettled()).resolves.toBe(false);
      expect(deferredAuth.state()).toBe(deferredAuth.FAILED);
      expect(deferredAuth.isFailed()).toBe(true);
    });

    test('a non-boolean truthy result does not grant access', async () => {
      deferredAuth.attach(Promise.resolve('yes'));
      await expect(deferredAuth.whenSettled()).resolves.toBe(false);
      expect(deferredAuth.state()).toBe(deferredAuth.FAILED);
    });

    test('whenSettled is an immediate pass when nothing was attached', async () => {
      await expect(deferredAuth.whenSettled()).resolves.toBe(true);
    });
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { devEnvApi } from './devEnv.js';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('./request', () => ({
  default: { get: (...args) => mockGet(...args), post: (...args) => mockPost(...args) },
}));

// 钉住前端↔后端契约：端点路径、silent 旗标（页面自带降级 UI 的那些读调用）、
// 信封透传（.then(r=>r.data)）。路径漂移会把「前端 404」误诊成「后端没实现」。
describe('devEnvApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('catalog hits /api/dev-env/catalog silently and passes the envelope through', async () => {
    const envelope = { success: true, data: { platform: 'win32', toolchains: [] } };
    mockGet.mockResolvedValueOnce({ data: envelope });
    await expect(devEnvApi.catalog()).resolves.toBe(envelope);
    expect(mockGet).toHaveBeenCalledWith('/api/dev-env/catalog', { silent: true });
  });

  it('inventory hits /api/dev-env/inventory silently (409 尚未盘点由页面承接)', async () => {
    const envelope = { success: true, data: { scannedAt: '2026-11-07', entries: [] } };
    mockGet.mockResolvedValueOnce({ data: envelope });
    await expect(devEnvApi.inventory()).resolves.toBe(envelope);
    expect(mockGet).toHaveBeenCalledWith('/api/dev-env/inventory', { silent: true });
  });

  it('scan POSTs an empty body to /api/dev-env/scan', async () => {
    const envelope = { success: true, data: { jobId: 'envjob_scan_1' } };
    mockPost.mockResolvedValueOnce({ data: envelope });
    await expect(devEnvApi.scan()).resolves.toBe(envelope);
    expect(mockPost).toHaveBeenCalledWith('/api/dev-env/scan', {});
  });

  it('job URL-encodes the jobId and is silent (轮询失败由自身计数承接)', async () => {
    mockGet.mockResolvedValueOnce({ data: { success: true, data: { state: 'running' } } });
    await devEnvApi.job('envjob_scan_1');
    expect(mockGet).toHaveBeenCalledWith('/api/dev-env/jobs/envjob_scan_1', { silent: true });
  });

  it('job rejects an empty jobId instead of hitting /jobs/', async () => {
    await expect(devEnvApi.job('  ')).rejects.toThrow('jobId 不能为空');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('install omits version when absent so the backend default applies', async () => {
    mockPost.mockResolvedValueOnce({ data: { success: true, data: { jobId: 'j1' } } });
    await devEnvApi.install('openjdk');
    expect(mockPost).toHaveBeenCalledWith('/api/dev-env/install', { depId: 'openjdk' });
  });

  it('install sends the version only when the user picked one', async () => {
    mockPost.mockResolvedValueOnce({ data: { success: true, data: { jobId: 'j2' } } });
    await devEnvApi.install('openjdk', '17');
    expect(mockPost).toHaveBeenCalledWith('/api/dev-env/install', { depId: 'openjdk', version: '17' });
  });

  it('export POSTs an empty body silently (服务端不落盘，409 引导先扫描)', async () => {
    mockPost.mockResolvedValueOnce({ data: { success: true, data: { kind: 'khy-dev-env-manifest' } } });
    await devEnvApi.export();
    expect(mockPost).toHaveBeenCalledWith('/api/dev-env/export', {}, { silent: true });
  });

  it('importPreview / importApply wrap the manifest in { manifest }', async () => {
    const manifest = { kind: 'khy-dev-env-manifest', entries: [] };
    mockPost.mockResolvedValue({ data: { success: true, data: {} } });
    await devEnvApi.importPreview(manifest);
    await devEnvApi.importApply(manifest);
    expect(mockPost).toHaveBeenNthCalledWith(1, '/api/dev-env/import/preview', { manifest });
    expect(mockPost).toHaveBeenNthCalledWith(2, '/api/dev-env/import/apply', { manifest });
  });
});

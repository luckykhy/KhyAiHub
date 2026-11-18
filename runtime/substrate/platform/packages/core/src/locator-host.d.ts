import { CoreHandle, CorePaths } from './contracts';

export interface ObtainCoreNodeOptions {
  mode?: 'auto' | 'embedded' | 'attached';
  endpoint?: string;
  token?: string;
  locator?: {
    coreId: string;
    protocolVersion: number;
    pid: number;
    endpoint: string;
    token?: string;
    epoch: number;
    coreVersion: string;
    heartbeatAt?: number;
  };
  env?: Record<string, string | undefined>;
  required?: string[];
  terminalId: string;
  clientVersion: string;
  enginesKhy?: string;
  /** 宿主传入的 embedded 实现：路径字符串或已加载模块（electron-vite 场景）。 */
  bundledEntry?: string | { createCoreServer: (options: unknown) => unknown };
  entry?: string | { createCoreServer: (options: unknown) => unknown };
  allowSpawn?: boolean;
  bindHost?: string;
  paths?: CorePaths;
  nodeModulesCwd?: string;
  lockOptions?: { staleConfirmMs?: number };
  onWarning?: (message: string) => void;
  onTakenOver?: (err: Error) => void;
  fetchImpl?: typeof fetch;
}

export interface CoreLockRecord {
  coreId: string;
  pid: number;
  port: number;
  host: string;
  tokenHash: string;
  protocolVersion: number;
  coreVersion: string;
  epoch: number;
  startedAt: number;
  heartbeatAt: number;
}

export declare function obtainCoreNode(opts: ObtainCoreNodeOptions): Promise<CoreHandle>;
export declare function readLocatorFile(dataHome: string): Record<string, unknown> | null;
export declare function writeLocatorFile(dataHome: string, record: Record<string, unknown>): boolean;
export declare function acquireLock(
  dataHome: string,
  self: CoreLockRecord,
  options?: { staleConfirmMs?: number },
): Promise<CoreLockRecord>;
export declare function heartbeatLock(dataHome: string, self: CoreLockRecord): void;
export declare function releaseLock(dataHome: string, self: CoreLockRecord): boolean;
export declare function isAlive(pid: number): boolean;
export declare function resolveEmbedded(options?: {
  entry?: unknown;
  bundledEntry?: unknown;
  nodeModulesCwd?: string;
}): { module: { createCoreServer: (options: unknown) => unknown }; source: 'explicit' | 'bundled' | 'node-modules' };
export declare const HEARTBEAT_MS: number;
export declare const STALE_AFTER_MS: number;
export declare const STALE_CONFIRM_MS: number;

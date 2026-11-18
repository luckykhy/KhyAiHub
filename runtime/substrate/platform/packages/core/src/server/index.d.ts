export declare const CORE_PROTOCOL_VERSION: number;

export interface CreateCoreServerOptions {
  dataHome: string | null;
  bindHost?: string;
  lock?: {
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
  };
}

export interface CoreServer {
  coreId: string | null;
  protocolVersion: number;
  start(): Promise<void>;
  close(): Promise<void>;
}

export declare function createCoreServer(options: CreateCoreServerOptions): CoreServer;

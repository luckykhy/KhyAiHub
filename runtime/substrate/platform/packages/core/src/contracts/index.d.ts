import { CoreEnvValues } from './core-env';

// 手写类型（无编译步骤）。方法面逐条来自 [DESIGN-ARCH-220] §3.1–§3.4；
// 幂等语义见设计稿 §3.3，违反幂等清单的实现一律打回。
export type CoreMode = 'embedded' | 'attached';

export interface CoreVersion {
  core: string;
  protocol: number;
  enginesKhy: string;
}

export interface GenerateRequest {
  prompt: string;
  options?: Record<string, unknown>;
}

export interface StreamChunk {
  delta: string;
}

export interface CallCtx {
  requestId?: string;
  terminalId?: string;
}

export interface GatewayStatus {
  [key: string]: unknown;
}

export interface ModelCatalog {
  [key: string]: unknown;
}

export interface StreamResult {
  [key: string]: unknown;
}

export interface GenerateResult {
  text: string;
  [key: string]: unknown;
}

export interface CoreEvent {
  id: string;
  seq: number;
  ts: number;
  type: string;
  payload?: unknown;
  terminalId?: string;
}

export interface EventFilter {
  type?: string;
  terminalId?: string;
}

export interface Subscription {
  readonly subscriberId: string;
  ack(seq: number): void;
  unsubscribe(): void;
}

export type Unsubscribe = () => void;

export type DataTier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4';

export interface DataRef {
  tier: DataTier;
  name: string;
}

export type DataRefPrefix = string;

export interface DataRefInfo {
  ref: DataRef;
  version: string;
  size?: number;
}

export interface SessionMeta {
  id: string;
  title?: string;
  cwd: string;
  terminalId: string;
  createdAt: number;
}

export interface SessionMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  clientMsgId: string;
  ts?: number;
}

export interface SessionHit {
  sessionId: string;
  snippet: string;
}

export interface SessionGroup {
  id: string;
  title?: string;
}

export interface Capability {
  id: string;
  version: string;
  state: 'available' | 'degraded' | 'missing';
  requiredBy?: string[];
  reason?: string;
}

export interface PluginInfo {
  namespace: string;
  version: string;
  state: 'enabled' | 'disabled' | 'error';
  reason?: string;
}

export interface CorePaths {
  dataHome: string;
  [key: string]: string;
}

export interface CoreGateway {
  generate(req: GenerateRequest, ctx?: CallCtx): Promise<GenerateResult>;
  stream(req: GenerateRequest, onChunk: (c: StreamChunk) => void, ctx?: CallCtx): Promise<StreamResult>;
  abort(requestId: string): Promise<boolean>;
  status(): Promise<GatewayStatus>;
  models(): Promise<ModelCatalog>;
  onStatus(cb: (s: GatewayStatus) => void): Unsubscribe;
}

export interface CoreEvents {
  publish(e: Omit<CoreEvent, 'seq' | 'ts'>): Promise<CoreEvent>;
  subscribe(filter: EventFilter, handler: (e: CoreEvent) => void): Subscription;
  replay(filter: { since: number } & EventFilter): Promise<CoreEvent[]>;
}

export interface CoreStorage {
  read(ref: DataRef): Promise<Uint8Array | null>;
  write(ref: DataRef, data: Uint8Array, opts?: { ifVersion?: string }): Promise<{ version: string }>;
  list(prefix: DataRefPrefix): Promise<DataRefInfo[]>;
  watch(prefix: DataRefPrefix, cb: () => void): Unsubscribe;
}

export interface CoreSession {
  create(opts: { cwd: string; title?: string; terminalId: string }): Promise<SessionMeta>;
  list(filter?: { limit?: number; since?: number }): Promise<SessionMeta[]>;
  messages(sessionId: string): Promise<SessionMessage[]>;
  append(
    sessionId: string,
    msg: SessionMessage,
    ctx: { clientMsgId: string },
  ): Promise<{ seq: number; deduped: boolean }>;
  rename(sessionId: string, title: string): Promise<void>;
  remove(sessionId: string): Promise<void>;
  search(query: string, opts?: { limit?: number }): Promise<SessionHit[]>;
  groups(): Promise<SessionGroup[]>;
  setGroup(sessionId: string, groupId: string): Promise<void>;
}

export interface CoreCapabilities {
  list(): Promise<Capability[]>;
  has(id: string): Promise<boolean>;
  get(id: string): Promise<Capability | null>;
  onChange(cb: (c: Capability) => void): Unsubscribe;
}

export interface CorePlugins {
  list(): Promise<PluginInfo[]>;
  enable(namespace: string): Promise<PluginInfo>;
  disable(namespace: string): Promise<void>;
  status(namespace: string): Promise<PluginInfo | null>;
  onChange(cb: (i: PluginInfo) => void): Unsubscribe;
}

export type CoreErrorCode =
  | 'CORE_UNAVAILABLE'
  | 'CORE_LOCKED'
  | 'CORE_TAKEN_OVER'
  | 'CORE_PROTOCOL_MISMATCH'
  | 'CORE_VERSION_MISMATCH'
  | 'CORE_AUTH_FAILED'
  | 'CORE_INVALID_ARGUMENT'
  | 'CORE_INTERNAL'
  | 'CORE_LOCATOR_FAILED'
  | 'CAPABILITY_UNAVAILABLE'
  | 'CORE_STORAGE_CONFLICT'
  | 'CORE_SESSION_NOT_FOUND'
  | 'CORE_EVENT_GAP';

export declare class CoreError extends Error {
  code: CoreErrorCode;
  retryable: boolean;
  details?: Record<string, unknown>;
  constructor(code: CoreErrorCode, message?: string, options?: { retryable?: boolean; details?: Record<string, unknown> });
}

export interface CoreHandle {
  readonly mode: CoreMode;
  readonly coreId: string;
  readonly epoch: number;
  readonly version: CoreVersion;
  readonly gateway: CoreGateway;
  readonly events: CoreEvents;
  readonly storage: CoreStorage;
  readonly session: CoreSession;
  readonly capabilities: CoreCapabilities;
  readonly plugins: CorePlugins;
  readonly paths: CorePaths;
  close(): Promise<void>;
}

export interface ObtainCoreOptions {
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
}

export declare function obtainCore(opts: ObtainCoreOptions): Promise<CoreHandle>;
export declare function readCoreEnv(env?: Record<string, string | undefined>): CoreEnvValues;
export { CORE_ENV_KEYS, CORE_MODE_VALUES, DEFAULT_BIND_HOST } from './core-env';
export { CORE_ERROR_CODES, CoreError, formatCoreError } from './errors';
export { CORE_PROTOCOL_VERSION } from './health';

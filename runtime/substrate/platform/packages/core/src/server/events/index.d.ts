export { EventBusHandle, EventLogHandle } from './eventLog';
export declare function createEventLog(options?: {
  bus?: unknown;
  getEventsDir?: () => string;
}): EventLogHandle;

export interface EventBusHandle {
  emit(channel: string, event: unknown): boolean;
  on(channel: string, handler: (event: unknown) => void): unknown;
  off(channel: string, handler: (event: unknown) => void): unknown;
  setMaxListeners(n: number): void;
}

export interface EventLogHandle {
  append(event: Record<string, unknown>): Record<string, unknown>;
  read(filter?: Record<string, unknown>): Record<string, unknown>[];
  replay(filter?: Record<string, unknown>, onEvent?: (e: Record<string, unknown>) => void): Record<string, unknown>[];
  snapshot(taskId: string, state: unknown, opts?: Record<string, unknown>): Record<string, unknown>;
  getEventsDir(): string | null;
  bus: EventBusHandle;
  CHANNEL: { ALL: string };
  subscribe(channel: string, handler: (event: unknown) => void): () => void;
  subscribeAll(handler: (event: unknown) => void): () => void;
  publish(event: Record<string, unknown>): Record<string, unknown>;
}

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

export type ActionJson = null | boolean | number | string | readonly ActionJson[] | { readonly [key: string]: ActionJson };

export interface SecurityAuditInput {
  subject: string;
  action: string;
  object: string;
  decision: string;
  reason: string;
  ticket_id: string | null;
  terminal_id?: string;
  task_id?: string;
  [key: string]: ActionJson | undefined;
}

export interface SecurityAuditRecord extends SecurityAuditInput {
  time: number;
  seq: number;
  prev_hash: string | null;
  hash: string;
}

export interface SecurityAudit {
  append(input: SecurityAuditInput): SecurityAuditRecord;
  query(filter?: { terminal_id?: string; task_id?: string; limit?: number }): SecurityAuditRecord[];
  close(): void;
  readonly poisoned: boolean;
  readonly filePath: string;
}

export declare function createSecurityAudit(options: { filePath: string; now?: () => number }): SecurityAudit;

export interface ActionContext {
  readonly terminal_id: string;
  readonly task_id: string;
  readonly action: string;
  readonly scope: ActionJson;
  readonly payload: ActionJson;
}

export interface ActionTicket {
  readonly ticket_id: string;
  readonly issuer: string;
  readonly terminal_id: string;
  readonly task_id: string;
  readonly action: string;
  readonly scope: ActionJson;
  readonly payload_digest: string;
  readonly expires_at: number;
}

export interface ActionEnvelope {
  from: string;
  task_id: string;
  action: string;
  payload: ActionJson;
  ticket: ActionTicket;
}

export interface ActionReceipt {
  readonly task_id: string;
  readonly status: 'ok' | 'denied' | 'failed' | 'need_human' | 'need_split';
  readonly summary: string;
  readonly result_ref: string | null;
  readonly violations: readonly string[];
}

export interface SecurityNotification {
  readonly event: 'security.intercept';
  readonly terminal_id: string;
  readonly audit_seq: number;
  readonly reason: string;
}

export interface MatrixTerminal {
  readonly terminal_id: string;
  readonly role: 'developer' | 'container' | 'client';
  readonly state: 'active' | 'frozen' | 'unregistered';
  readonly tools: readonly string[];
  readonly denied_tools: readonly string[];
  readonly data_scope: readonly string[];
  readonly allowed_commands: readonly string[];
  readonly max_tokens_per_task: number;
  readonly daily_budget: number;
  readonly app_capabilities: Readonly<Record<string, { readonly status: 'available' | 'missing'; readonly evidence: string }>>;
}

export interface PermissionMatrix {
  readonly version: 'v1.3-khyos';
  readonly revision: number;
  readonly shared_scope: readonly string[];
  readonly high_risk_actions: readonly string[];
  readonly budget_policy: { readonly unit: 'input_output_tokens'; readonly reset: 'UTC' };
  readonly app_sources: readonly { readonly path: string; readonly sha256: string }[];
  readonly terminals: readonly MatrixTerminal[];
}

export interface ExecutionFacts {
  readonly scope_enforced: true;
  readonly targets: readonly string[];
  readonly risk: 'normal' | 'high';
  readonly usage: {
    readonly task_tokens: number;
    readonly day_tokens: number;
    readonly reserved_task_tokens: number;
    readonly reserved_day_tokens: number;
    readonly input_tokens: number;
    readonly max_output_tokens: number;
  };
  readonly command?: { readonly executable: string; readonly argv: readonly string[]; readonly shell: false };
  readonly app_source?: { readonly path: string; readonly sha256: string };
}

export interface MatrixDecision {
  readonly allowed: boolean;
  readonly status: 'ok' | 'denied' | 'failed' | 'need_human' | 'need_split';
  readonly reason: string;
}

export declare function createMatrixPolicy(matrix: PermissionMatrix | null, options?: { protectedPaths?: readonly string[] }): {
  readonly matrix: PermissionMatrix | null;
  check(context: ActionContext, executionFacts: ExecutionFacts): MatrixDecision;
};

export interface ActionAuthority {
  readonly issuer: string;
  issue(input: ActionContext): ActionTicket;
  registerTerminal(terminalId: string, actions: Record<string, (payload: ActionJson, context: ActionContext) => unknown>): {
    execute(request: ActionEnvelope): Promise<ActionReceipt>;
  };
  unregisterTerminal(terminalId: string): void;
  freeze(terminalId: string, reason: string): void;
  endTask(terminalId: string, taskId: string): void;
  invalidateTickets(reason: string): void;
}

export interface MatrixProposal {
  readonly challenge_id: string;
  readonly digest: string;
  readonly matrix: PermissionMatrix;
}

export interface MatrixConfirmation {
  challenge_id: string;
  digest: string;
  decision: string;
}

export interface MatrixStore {
  readonly matrix: PermissionMatrix | null;
  readonly revision: number;
  load(): PermissionMatrix | null;
  propose(principal: object, matrix: PermissionMatrix): Promise<MatrixProposal>;
  confirm(principal: object, response: MatrixConfirmation): Promise<PermissionMatrix>;
  check(context: ActionContext, facts: ExecutionFacts): MatrixDecision;
  close(): void;
}

export declare function createMatrixStore(options: {
  filePath: string;
  audit: SecurityAudit;
  administrator: object;
  invalidateTickets: (reason: string) => void;
  onViolation: (principal: object, event: { readonly event: 'forge_admin'; readonly audit_seq: number; readonly reason: string }) => void | Promise<void>;
  protectedPaths?: readonly string[];
}): MatrixStore;

export declare function createActionAuthority(options: {
  audit: SecurityAudit;
  authorize: (context: ActionContext) => { allowed: boolean; reason?: string };
  notify: (event: SecurityNotification) => void | Promise<void>;
  now?: () => number;
}): ActionAuthority;

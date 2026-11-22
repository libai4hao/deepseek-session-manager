export type LinkKind = 'session' | 'share' | 'foreign' | 'bad';

export interface ParsedLink {
  raw: string;
  kind: LinkKind;
  id?: string;
  reason?: string;
}

export interface SessionMeta {
  id: string;
  title: string;
  pinned: boolean;
  /** unix seconds, may contain decimals */
  updatedAt: number;
  seqId?: number;
}

export interface ChatFragment {
  type: string;
  content: string;
}

export interface ChatMessage {
  messageId: number;
  role: string;
  insertedAt: number;
  fragments: ChatFragment[];
}

export interface ApiResult<T = unknown> {
  http: number;
  code: number;
  bizCode?: number;
  bizMsg?: string;
  data?: T;
  detail?: unknown;
  raw?: unknown;
}

export type ApiErrorKind =
  | 'ok'
  | 'auth'
  | 'schema'
  | 'rate'
  | 'forbidden'
  | 'business'
  | 'server';

export interface Transport {
  get<T = unknown>(path: string): Promise<ApiResult<T>>;
  post<T = unknown>(path: string, body: unknown): Promise<ApiResult<T>>;
}

export type GuardCode =
  | 'NOT_FOUND'
  | 'NOT_OWNED'
  | 'PINNED_PROTECTED'
  | 'TITLE_MISMATCH';

export type DeleteShape = 'single' | 'array';

export type ExecStatus = 'deleted' | 'noop' | 'failed' | 'aborted' | 'skipped';

export interface ExecResult {
  id: string;
  status: ExecStatus;
  attempts: number;
  ms: number;
  reason?: string;
}

export interface ExecOptions {
  intervalMs: number;
  batchSize: number;
  batchPauseMs: number;
  retries: number;
  shape: DeleteShape | 'auto';
  dryRun?: boolean;
  backoff?: number[];
  forbiddenCooldownMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ExecHooks {
  onStart?(id: string, index: number, total: number): void;
  onResult?(result: ExecResult): void;
  onShapeDetected?(shape: DeleteShape): void;
}

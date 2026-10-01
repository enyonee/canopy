// Core shapes shared across the runtime. Loose on purpose (see tsconfig.json:
// strict/strictNullChecks/noImplicitAny are all off) — this is a checked
// sketch of the graph's shape, not a rewrite in TypeScript. It exists so a
// change to one module's expectations of another shows up as a type error
// instead of a runtime one three files away.

/** The whole app.json document. Every top-level key is optional except `app` and `data`. */
export interface Graph {
  app: string;
  task?: string;
  note?: string;
  theme?: { background?: string; accent?: string };
  home?: string;
  data: Record<string, Record<string, string>>;
  seed?: Record<string, Array<Record<string, any>>>;
  identity?: { entity: string; defaults?: Record<string, any> };
  roles?: RolesSpec;
  views?: 'auto';
  override?: Record<string, any>;
  lists?: any[];
  dashboards?: any[];
  pages?: any[];
  actions?: ActionSpec[];
  events?: EventSpec[];
  states?: Record<string, StatesSpec>;
  connectors?: Record<string, ConnectorSpec>;
  rules?: Record<string, RuleSpec[]>;
  allowDestructive?: boolean;
  plugins?: string[];
  [key: string]: any;
}

export interface RolesSpec {
  entity: string;
  login: string;
  password: string;
  role: string;
  register?: string;
  anonymous?: string;
  can?: Record<string, '*' | Record<string, any>>;
}

export interface ActionSpec {
  name: string;
  in?: string | null;
  title?: string;
  by?: string[];
  after?: string;
  confirm?: string;
  do: StepSpec[];
  [key: string]: any;
}

export interface EventSpec { on?: string; inbound?: string; do: StepSpec[] }

export interface StatesSpec {
  field: string;
  transitions: Array<{
    name: string; from?: string | string[]; to: string; title?: string;
    fields?: string[]; by?: string[]; confirm?: string; after?: string; do?: StepSpec[];
  }>;
}

export interface ConnectorSpec { kind: string; [key: string]: any }
export interface RuleSpec { check?: string; unique?: string; message?: string }

/** One step of an action/event/transition's `do` list: `{ block, ...params }`. */
export interface StepSpec {
  block: string;
  entity?: string;
  from?: string;
  field?: string;
  via?: string;
  set?: Record<string, any>;
  values?: Record<string, any>;
  where?: Record<string, any>;
  into?: string;
  connector?: string;
  do?: StepSpec[];
  [key: string]: any;
}

/** A parsed field declaration (spec.mjs's parseField), one per data/field entry. */
export interface Field {
  name: string;
  kind: string;
  options: string[] | null;
  target: string | null;
  required: boolean;
  optional: boolean;
  def: string | null;
  derive: any;
  source: string | null;
  type: FieldType;
}

/** A registry.fields[kind] entry — see docs/FORMAT.md's «Plugins» section for the contract. */
export interface FieldType {
  sql: string;
  exprKind: string;
  numeric?: boolean;
  temporal?: boolean;
  secret?: boolean;
  derivable?: boolean;
  structural?: boolean;
  upload?: boolean;
  def: (f: Field) => any;
  coerce: (raw: any) => any;
  validate: (v: any, f: Field, store?: any) => string | null;
  toExpr?: (v: any) => any;
  fromExpr?: (v: any) => any;
  format: (v: any, f: Field, ctx: any) => string;
  input: ((f: Field, v: any, ctx: any) => string) | null;
}

/** A registry.blocks[name] entry — the step catalog (docs/FORMAT.md's block table). */
export interface BlockType {
  summary: string;
  effects: string[];
  requires: string[];
  connector?: string;
  check?: (step: StepSpec, h: any) => void;
  exposes?: (step: StepSpec) => Record<string, string>;
  nested?: (step: StepSpec) => Array<{ steps: StepSpec[]; path: string; adds: Record<string, string> }>;
  run: (ctx: BlockCtx) => any;
}

/** What a block's run() receives — one step, inside the caller's transaction. */
export interface BlockCtx {
  store: any;
  graph: Graph;
  entity: string | null;
  id: string | number | null;
  values: Record<string, any>;
  step: StepSpec;
  user: any;
  registry: Registry;
  resolve: (obj: any) => any;
  trace: (event: Record<string, any>) => void;
  text: (s: string) => string;
  run: (steps: StepSpec[], extra: Record<string, any>) => any;
  fireCreated: (entity: string, id: number, values: Record<string, any>) => void;
}

/** A registry.transports[kind] entry — one per connector kind. */
export interface TransportType {
  summary: string;
  /** The modes this kind may run in (the first is the default); absent means live only. */
  modes?: Array<'sandbox' | 'live'>;
  validate: (connector: ConnectorSpec) => Array<[string, string, string?]>;
  deliver: (row: any, connector: ConnectorSpec, opts: any) => Promise<{ status: string; code?: number | null; error?: string | null; response?: string; result?: string; drift?: number; retryAfter?: string }>;
}

/** A schema of the connector-descriptor subset (runtime/connectors/schema.mjs). */
export interface SchemaNode {
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';
  properties?: Record<string, SchemaNode>; required?: string[]; additionalProperties?: boolean; items?: SchemaNode;
  enum?: any[]; format?: 'email' | 'date-time' | 'uri'; minLength?: number; maxLength?: number; pattern?: string;
  minimum?: number; maximum?: number; default?: any; title?: string; description?: string; message?: string; hint?: string;
}

/** One operation of a descriptor: the input it takes, the request it makes, the answer it must give. */
export interface OperationSpec {
  summary?: string; idempotent: boolean; input: SchemaNode;
  request: { method?: string; url: string; headers?: Record<string, any>; body?: any };
  output?: SchemaNode; result?: Record<string, string>;
}

/** A connector descriptor (docs/CONNECTORS.md): data, checked by runtime/connectors/descriptor.mjs. */
export interface ConnectorDescriptor {
  descriptor: 1; name: string; title?: string; version?: string; base?: string; config?: SchemaNode;
  timeoutMs?: number; legacy?: string; operations: Record<string, OperationSpec>;
  retry?: Partial<RetryPolicy>; breaker?: Partial<BreakerPolicy>; idempotency?: { header: string };
  /** The modes a connector of this kind may run in, the first is the default (runtime/deploy.mjs). */
  modes?: Array<'sandbox' | 'live'>;
  /** Per operation, the ordered rules that answer in sandbox mode (runtime/connectors/sandbox.mjs). */
  sandbox?: { operations: Record<string, Array<{ when?: Record<string, any>; status?: number; headers?: Record<string, string>; body?: any }>> };
  /** How the provider's webhooks are authenticated and read (runtime/connectors/inbound.mjs). */
  inbound?: InboundSpec;
}

/** The `inbound` block of a descriptor: `type` is a `$.path` into the body or `{ header }`, `eventId` a `$.path` into the signed body. */
export interface InboundSpec {
  signature: { scheme: 'stripe' | 'slack' | 'hmac' | 'basic'; header?: string; algo?: 'sha256' | 'sha1'; encoding?: 'hex' | 'base64'; prefix?: string; signed?: 'raw' | 'ts.raw'; timestampHeader?: string };
  secret: string; toleranceS?: number;
  eventId: string; type: string | { header: string };
  events: Record<string, { schema: SchemaNode; map?: Record<string, string> }>;
}

/** The retry policy of a descriptor (runtime/connectors/backoff.mjs DEFAULT_RETRY). */
export interface RetryPolicy { max: number; baseMs: number; capMs: number; jitter: number }
/** The circuit breaker policy of a descriptor (DEFAULT_BREAKER); probeLeaseMs is the outbox lease. */
export interface BreakerPolicy { threshold: number; cooldownMs: number; maxCooldownMs: number; probeLeaseMs: number }
/** One breaker row: closed, open until `openUntil`, or half (one probe claimed at `probeClaimedAt`). */
export interface BreakerState { state: 'closed' | 'open' | 'half'; failures: number; openUntil: number; cooldownMs: number; probeClaimedAt: number }
/** The one injectable clock of the delivery path (runtime/clock.mjs). */
export interface Clock { now(): number; setTimer(fn: () => any, ms: number): any; clear(handle: any): void }

/** A registry.functions[name] entry — a scalar expression function. */
export interface FunctionType {
  arity: number | [number, number];
  kind: (argKinds: string[]) => string;
  run: (args: any[]) => any;
}

/** A registry.widgets[name] entry — a client widget (docs/FORMAT.md's «Widgets» section). */
export interface WidgetType {
  summary: string;
  client: string;
  props?: string[];
  check?: (node: Record<string, any>, h: any) => void;
}

export interface Registry {
  fields: Record<string, FieldType>;
  blocks: Record<string, BlockType>;
  transports: Record<string, TransportType>;
  functions: Record<string, FunctionType>;
  widgets: Record<string, WidgetType>;
  descriptors: Record<string, ConnectorDescriptor>;
  plugins: string[];
}

/** The per-request object every route module receives — built once in routes/context.mjs. */
export interface RequestContext {
  req: any; res: any; url: URL; parts: string[]; flash: string; wantsCsv: boolean; wantsJSON: boolean;
  graph: Graph; store: any; perms: any; sess: any; registry: Registry; interp: any;
  trace: (event: Record<string, any>) => void; filesDir: string; fetchImpl?: typeof fetch;
  user: any; role: string | null; vc: ViewContext; ownWhere: (entity: string, op?: string) => Record<string, any>;
  deny: (message?: string) => void;
  send: (code: number, html: string) => void; redirect: (to: string) => void;
  ok: (to: string, msg?: string) => void; sendCsv: (name: string, header: string[], lines: any[][]) => void;
  exportRows: (name: string, entity: string, rows: any[], cols: string[], labels: Record<string, any>) => void;
  sendJson: (code: number, data: any) => void; answer: (code: number, html: string, json: any) => void;
  body: () => Promise<Record<string, any>>; resolveTop: (obj: any) => any;
  paged: (entity: string, opts: Record<string, any>, ov: any) => { rows: any[]; total: number; page: number; pages: number };
  sortOf: (entity: string, ov: any) => { field: string; dir: 'asc' | 'desc' } | null;
  safeNext: (to: any) => string;
}

/** What render.mjs's view functions need to know about who is looking. */
export interface ViewContext {
  user: any; role: string | null;
  can: (entity: string, op: string, row?: any) => boolean;
  canSee: (item: { roles?: string[] }) => boolean;
  ownField: (entity: string) => string | null;
  ownWhere: (entity: string, op?: string) => Record<string, any>;
  ownOk: (entity: string, row: any, op?: string) => boolean;
  isAdmin?: boolean;
  outbox?: boolean;
  enabled?: boolean;
}

// buildAggCache's (runtime/store/hydrate.mjs) return shape: `groups` holds a
// raw-child-rows-by-parent-id map per (child, via) pair — the pre-item-1
// fallback; `scalars` holds an already-finalized value per parent id per
// SQL-compiled aggregate (runtime/store/aggsql.mjs's aggKey).
type AggCache = { groups: Map<string, Map<string, any[]>>; scalars: Map<string, Map<string, any>>; clock: Date };

/** Every place the store's SQL text depends on the engine (runtime/driver/dialects.mjs). Pure text hooks. */
export interface Dialect {
  name: 'sqlite' | 'postgres';
  quote(id: string): string;
  /** The n-th (1-based) positional placeholder: `?` or `$n`. */
  ph(n: number): string;
  /** `count` placeholders from the `from`-th on, comma-joined. */
  phs(count: number, from?: number): string;
  idType: string;
  returning: string;
  colType(sql: string): string;
  boolInt(cond: string): string;
  like(col: string, ph: string): string;
  lowerEq(col: string, ph: string): string;
  likeArg(v: any): string;
  escapeLike(v: any): string;
  bucket(col: string, unit: 'day' | 'month' | 'year'): string;
  collate(expr: string): string;
  order(col: string, dir: 'ASC' | 'DESC', opts?: { text?: boolean; tie?: boolean }): string;
  named(name: string, index: number): string;
  args(names: string[], named: Record<string, any>, vals: any[]): any[];
  insert(table: string, cols: string[]): string;
  upsert(table: string, cols: string[], key?: string): string;
  createTable(table: string, cols: Array<[string, string]>, opts?: { ifNotExists?: boolean; serial?: boolean }): string;
  addColumn(table: string, col: string, type: string): string;
  createIndex(name: string, table: string, cols: string[]): string;
  dropIndex(name: string): string;
  tablesSql(): { sql: string; params: any[] };
  columnsSql(table: string): { sql: string; params: any[] };
  indexesSql(table: string, prefix?: string): { sql: string; params: any[] };
  indexName(table: string, cols: string[]): string;
}

/** What a Store talks to (runtime/driver/sqlite.mjs is the only implementation). Every
 * result "may be awaited" by contract; today's driver is synchronous and nothing awaits. */
export interface Driver {
  dialect: Dialect;
  /** Called with the SQL text (and the call's options) of every statement the driver executes; tests count queries with it. */
  onQuery: ((sql: string, opts?: { cache?: boolean }) => void) | null;
  /** SQLite-only diagnostic: the prepared-statement LRU, oldest first. */
  cache: Map<string, any>;
  all(sql: string, params?: any[], opts?: { cache?: boolean }): any[];
  get(sql: string, params?: any[], opts?: { cache?: boolean }): any;
  run(sql: string, params?: any[], opts?: { cache?: boolean }): { changes: number; lastId: number };
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  close(): void;
  tables(): string[];
  columns(table: string): Array<{ name: string; type: string }>;
  indexes(table: string, prefix?: string): string[];
  createTable(table: string, cols: Array<[string, string]>, opts?: { ifNotExists?: boolean; serial?: boolean }): void;
  addColumn(table: string, name: string, type: string): void;
  createIndex(name: string, table: string, cols: string[]): void;
  dropIndex(name: string): void;
}

// store/query.mjs, store/hydrate.mjs, store/state.mjs and store/rules.mjs
// attach these to Store.prototype at runtime (`Object.assign(Store.prototype,
// query, hydrate, state, rules)` in store.mjs) — declared here, once, instead
// of on the class itself, purely for the type checker; there is no other
// copy of this list.
declare module './store.mjs' {
  interface Store {
    clauses(entity: string, where: Record<string, any>): { clauses: string[]; vals: any[]; later: [string, any][] };
    listRaw(entity: string, opts?: Record<string, any>): any[];
    labelOf(entity: string, id: any): string;
    listRawPage(entity: string, opts: Record<string, any>, limit: number, offset: number): any[];
    listRawIn(entity: string, via: string, ids: any[]): any[];
    countRaw(entity: string, opts?: Record<string, any>): number;
    list(entity: string, opts?: Record<string, any>): any[];
    listPage(entity: string, opts?: Record<string, any>, page?: { page?: number; pageSize?: number }): { rows: any[]; total: number; page: number; pages: number };
    buildAggCache(entity: string, ids: any[], cache?: AggCache, seen?: Set<string>): AggCache;
    aggValue(entity: string, row: any, node: any, cache: AggCache | null, clock?: Date): any;
    hydratePage(entity: string, rows: any[]): any[];
    aggregate(entity: string, opts?: Record<string, any>): any[];
    aggregateInMemory(entity: string, opts: Record<string, any>): any[];
    enqueue(row: { kind: string; connector: string; target: string; payload: any; op?: string | null }): number;
    outbox(where?: Record<string, any>): any[];
    outboxDue(now: number, leaseMs: number): any[];
    outboxNextDue(now: number): number | null;
    outboxDefer(id: any, at: number): void;
    outboxMark(id: any, from: string, patch: Record<string, any>): boolean;
    breakerGet(connector: string, mode: string): BreakerState & { connector: string; mode: string };
    breakers(): Array<BreakerState & { connector: string; mode: string }>;
    breakerRecord(connector: string, mode: string, event: 'failure' | 'success', now: number, cfg?: Partial<BreakerPolicy>): { before: BreakerState; after: BreakerState };
    breakerClaim(connector: string, mode: string, now: number, cfg?: Partial<BreakerPolicy>): boolean;
    inboundSeen(connector: string, eventId: string): boolean;
    inboundAdd(connector: string, eventId: string, receivedAt: number): void;
    inboundPrune(before: number): number;
    outboxClaim(id: any, now: number, leaseMs: number): boolean;
    outboxGet(id: any): any;
    outboxUpdate(id: any, patch: Record<string, any>): void;
    outboxFinish(id: any, claimedAt: number, patch: Record<string, any>): boolean;
    sessionSet(sid: string, userId: number): string;
    sessionUser(sid: string): number | null;
    sessionEnd(sid: string): void;
    checkRules(entity: string, values: Record<string, any>, existing?: any): string[];
    migrateIndexes(entity: string): void;
    migrateOutbox(): void;
    migrateInbound(): void;
  }
}

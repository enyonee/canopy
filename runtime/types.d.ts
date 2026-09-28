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

export interface EventSpec { on: string; do: StepSpec[] }

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
  resolve: (obj: any) => any;
  text: (s: string) => string;
  run: (steps: StepSpec[], extra: Record<string, any>) => any;
  fireCreated: (entity: string, id: number, values: Record<string, any>) => void;
}

/** A registry.transports[kind] entry — one per connector kind. */
export interface TransportType {
  summary: string;
  validate: (connector: ConnectorSpec) => Array<[string, string, string?]>;
  deliver: (row: any, connector: ConnectorSpec, opts: any) => Promise<{ status: string; code?: number | null; error?: string | null }>;
}

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
    enqueue(row: { kind: string; connector: string; target: string; payload: any }): number;
    outbox(where?: Record<string, any>): any[];
    outboxDue(now: number, leaseMs: number): any[];
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
  }
}

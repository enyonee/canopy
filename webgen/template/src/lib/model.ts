// The shape of src/gen/app.ts: what webgen read out of app.json. The screens only ever read this model;
// none of them names an entity, a field or a role of a particular app.

export type Bound = { op: '>=' | '>' | '<=' | '<'; value: number; message: string };

export type Field = {
  name: string; label: string; kind: string; type: string;
  required: boolean; derived: boolean; secret: boolean; default: string | null;
  options: readonly string[] | null; target: string | null; bounds: readonly Bound[]; unique: boolean;
};

export type Transition = {
  name: string; title: string; from: readonly string[] | null; to: string; fields: readonly string[];
  by: readonly string[] | null; after: string | null; destructive: boolean;
};

export type Action = { name: string; title: string; by: readonly string[] | null; after: string | null; fields: readonly string[] };

export type ListSpec = {
  title: string; intro: string | null; hidden: boolean; create: boolean; createTitle: string;
  columns: readonly string[]; search: readonly string[];
  filters: readonly { name: string; field: string; range: boolean }[];
  sort: { field: string; dir: string } | null; pageSize: number; rowActions: readonly string[];
  labels: Readonly<Record<string, readonly string[]>>;
};

export type Related = {
  entity: string; via: string; title: string; columns: readonly string[] | null;
  form: readonly string[] | false | null; submit: string; rowActions: readonly string[];
};

export type Entity = {
  name: string; label: string; plural: string; labelField: string | null;
  fields: readonly Field[];
  states: { field: string; transitions: readonly Transition[] } | null;
  actions: readonly Action[];
  list: ListSpec;
  form: {
    title: string | null; intro: string | null; submit: string | null; fields: readonly string[];
    byRole: Readonly<Record<string, readonly string[]>>; fill: readonly string[]; after: string | null; afterEdit: string | null;
  };
  detail: {
    fields: readonly string[]; actions: readonly string[]; labels: Readonly<Record<string, readonly string[]>>;
    private: Readonly<Record<string, string>>; related: readonly Related[];
  };
};

export type SavedList = {
  id: string; entity: string; title: string; roles: readonly string[] | null; hidden: boolean; intro: string | null;
  columns: readonly string[]; rowActions: readonly string[]; create: boolean; search: readonly string[];
  sort: { field: string; dir: string } | null; createTitle: string;
};

export type Group = { field: string; kind: string; target: string | null; options: readonly string[] | null; unit: string | null };

export type Dashboard = {
  id: string; title: string; intro: string | null; roles: readonly string[] | null; refresh: number | null; period: boolean;
  cards: readonly { title: string; entity: string; fn: string; money: boolean }[];
  tables: readonly { title: string; entity: string; groupTitle: string | null; group: Group | null; metrics: readonly { as: string; title: string; money: boolean }[] }[];
  charts: readonly { title: string; entity: string; type: string; group: Group | null; money: boolean }[];
};

export type Section = { list?: string; limit?: number; form?: string; text?: string };

export type Page = {
  id: string; title: string; heading: string; body: readonly string[];
  links: readonly { label: string; href: string }[]; actions: readonly string[]; roles: readonly string[] | null;
  sections: readonly Section[];
};

export type Grant = readonly string[] | { own?: string | readonly string[]; can?: readonly string[]; all?: readonly string[] };

export type Roles = {
  entity: string; login: string; loginLabel: string; password: string; roleField: string; names: readonly string[];
  register: string | null; anonymous: string | null; admins: readonly string[]; registerFields: readonly string[];
  can: Readonly<Record<string, '*' | Readonly<Record<string, Grant>>>>;
};

export type NavItem = { kind: 'entity' | 'list' | 'dashboard' | 'page'; to: string; title: string; icon: string; entity: string | null; roles: readonly string[] | null };

export type AppModel = {
  name: string; title: string; note: string | null; home: string | null;
  theme: { background: string | null; accent: string | null };
  roles: Roles | null;
  entities: Readonly<Record<string, Entity>>;
  lists: readonly SavedList[]; dashboards: readonly Dashboard[]; pages: readonly Page[];
  search: { entities: readonly string[]; title: string } | null;
  nav: readonly NavItem[];
  globalActions: readonly Action[];
};

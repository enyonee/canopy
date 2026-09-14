// The checker on the v2 nodes: every error names its path, and most carry a way out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../runtime/validate.mjs';

const base = {
  app: 'v', data: {
    User: { email: 'text!', password: 'password!', role: 'enum[admin,sales]=sales', name: 'text' },
    Lead: { title: 'text!', owner: 'ref:User', value: 'money=0', status: 'enum[new,won,lost]=new', createdAt: 'time=now', when: 'date', done: 'bool=false' },
    Note: { lead: 'ref:Lead!', body: 'text', n: 'int=1' },
  },
  connectors: { hook: { kind: 'http', url: 'http://x.test/h' }, mail: { kind: 'mail' } },
  states: { Lead: { field: 'status', transitions: [{ name: 'win', from: ['new'], to: 'won' }, { name: 'lose', from: ['new'], to: 'lost' }] } },
  actions: [{ name: 'act', in: 'Lead', do: [{ block: 'db.update', set: { title: 'x' } }] }, { name: 'glob', do: [{ block: 'db.createRow', entity: 'Lead', values: { title: 'y' } }] }],
};
const roles = { entity: 'User', login: 'email', password: 'password', role: 'role', can: { admin: '*' } };
const errs = (extra) => validate({ ...base, ...extra });
const at = (extra, path) => errs(extra).find((e) => e.path === path) || {};
const paths = (extra) => errs(extra).map((e) => e.path);

test('the base graph is valid, and unknown top-level nodes are named with a suggestion', () => {
  assert.deepEqual(errs({}), []);
  assert.match(at({ rolez: {} }, '/rolez').hint, /did you mean: roles/);
  assert.match(at({ zzzz: {} }, '/zzzz').hint, /nodes are: app, task/);
});

test('field specs: money, date, file, password, derived and their errors', () => {
  assert.deepEqual(errs({ data: { ...base.data, X: { a: 'money=1.5', b: 'date=today', c: 'file', d: 'password', e: 'money := a * 2', f: 'text := concat(c, "!")', g: 'int := len(f)' } } }), []);
  assert.match(at({ data: { X: { a: 'money := ' } } }, '/data/X/a').message, /":=" needs an expression/);
  assert.match(at({ data: { X: { a: 'ref:X := 1' } } }, '/data/X/a').message, /a ref field cannot be derived/);
  assert.match(at({ data: { X: { a: 'int! := 1' } } }, '/data/X/a').message, /takes no default and no ! or \? marker/);
  assert.match(at({ data: { X: { a: 'int=1 := 1' } } }, '/data/X/a').message, /takes no default/);
  assert.match(at({ data: { X: { a: 'enum[a,b]=c' } } }, '/data/X/a').message, /default "c" is not one of a, b/);
  assert.match(at({ data: { X: { a: 'int := 1 +' } } }, '/data/X/a').message, /unexpected end of expression/);
});

test('derived expressions are checked against their entity: kinds, names, hops, aggregates and cycles', () => {
  const D = (spec) => ({ data: { ...base.data, Lead: { ...base.data.Lead, ...spec } } });
  assert.deepEqual(errs(D({ notes: 'int := count(Note)', big: 'bool := value > 100', who: 'text := owner.name', age: 'int := days(today, createdAt)' })), []);
  assert.match(at(D({ x: 'int := title' }), '/data/Lead/x').message, /derived int field gets a text expression/);
  assert.match(at(D({ x: 'int := value' }), '/data/Lead/x').hint, /declare it as "money := …"/);
  assert.match(at(D({ x: 'int := ghost' }), '/data/Lead/x').message, /Lead has no field "ghost"/);
  assert.match(at(D({ x: 'int := titel' }), '/data/Lead/x').message, /did you mean: title/);
  assert.match(at(D({ x: 'int := title.len' }), '/data/Lead/x').message, /Lead\.title is text, cannot read \.len of it/);
  assert.match(at(D({ x: 'int := owner.ghost' }), '/data/Lead/x').message, /User has no field "ghost"/);
  assert.match(at(D({ x: 'int := count(Ghost)' }), '/data/Lead/x').message, /unknown entity "Ghost" in aggregate/);
  assert.match(at(D({ x: 'int := count(User)' }), '/data/Lead/x').message, /User has no reference to Lead; add a "ref:Lead" field to User/);
  assert.match(at(D({ x: 'int := count(Note.body)' }), '/data/Lead/x').message, /Note\.body is not a reference to Lead/);
  assert.match(at(D({ x: 'int := sum(Note: body)' }), '/data/Lead/x').message, /sum\(Note: …\) needs a number, got text/);
  const two = { data: { ...base.data, Pair: { a: 'ref:Lead', b: 'ref:Lead' }, Lead: { ...base.data.Lead, p: 'int := count(Pair)', q: 'int := count(Pair.a)' } } };
  assert.match(at(two, '/data/Lead/p').message, /Pair references Lead through a and b; name one: Pair\.a/);
  assert.equal(at(two, '/data/Lead/q').message, undefined);
  const alone = (data) => validate({ app: 'x', data });
  const cycle = { data: { A: { x: 'int := y + 1', y: 'int := x + 1' } } };
  assert.match(alone(cycle.data).find((e) => e.path === '/data/A/x').message, /derived fields depend on each other: A\.x → A\.y → A\.x/);
  const hop = { data: { A: { b: 'ref:B', x: 'int := b.y' }, B: { a: 'ref:A', y: 'int := a.x' } } };
  assert.match(alone(hop.data).find((e) => /depend on each other/.test(e.message)).message, /A\.x → B\.y → A\.x/);
  const viaAgg = { data: { A: { x: 'int := sum(B: y)' }, B: { a: 'ref:A', y: 'int := a.x' } } };
  assert.match(alone(viaAgg.data).find((e) => /depend on each other/.test(e.message)).message, /A\.x → B\.y → A\.x/);
  assert.deepEqual(alone({ A: { b: 'ref:B', x: 'int := b.y' }, B: { y: 'int := 1', z: 'int := y' } }), [], 'dependencies without a cycle are fine');
  assert.deepEqual(alone({ Place: { name: 'text', rating: 'int := avg(Review: rating)' }, Review: { place: 'ref:Place', rating: 'int' } }), [], 'a child field with the same name is not the outer field');
  assert.match(alone({ Place: { rating: 'int := avg(Review: score) + rating' }, Review: { place: 'ref:Place', score: 'int' } })[0].message, /depend on each other: Place\.rating → Place\.rating/);
});

test('roles: the user entity, its fields, register, anonymous, the matrix, own, and identity conflicts', () => {
  assert.deepEqual(errs({ roles: { ...roles, register: 'sales', anonymous: 'guest', can: { admin: '*', sales: { Lead: { own: 'owner', can: ['view', 'go:win', 'do:act'] }, '*': ['view', 'do:glob'] }, guest: { Lead: ['view'] } } } }), []);
  assert.match(at({ roles: { ...roles, entity: 'Ghost' } }, '/roles/entity').message, /unknown entity/);
  assert.match(at({ roles: { ...roles, login: undefined } }, '/roles/login').message, /roles need "login"/);
  assert.match(at({ roles: { ...roles, login: 'password' } }, '/roles/login').message, /"password" is password; login must be text/);
  assert.match(at({ roles: { ...roles, password: 'email' } }, '/roles/password').message, /must be a secret/);
  assert.match(at({ roles: { ...roles, role: 'name' } }, '/roles/role').message, /must be enum/);
  assert.match(at({ roles: { ...roles, role: 'ghost' } }, '/roles/role').message, /does not exist/);
  assert.match(at({ roles: { ...roles, register: 'boss' } }, '/roles/register').message, /"boss" is not a role/);
  assert.match(at({ roles: { ...roles, anonymous: 'sales' } }, '/roles/anonymous').message, /"sales" is a signed-in role/);
  assert.match(at({ roles: { ...roles, can: undefined } }, '/roles/can').message, /roles need "can"/);
  assert.match(at({ roles: { ...roles, can: { boss: '*' } } }, '/roles/can/boss').message, /"boss" is not a role/);
  assert.match(at({ roles: { ...roles, can: { admin: ['x'] } } }, '/roles/can/admin').message, /a role is "\*" or an object/);
  assert.match(at({ roles: { ...roles, can: { admin: { Lead: 'view' } } } }, '/roles/can/admin/Lead').message, /operations must be an array/);
  assert.match(at({ roles: { ...roles, can: { admin: { Ghost: ['view'] } } } }, '/roles/can/admin/Ghost').message, /unknown entity/);
  assert.match(at({ roles: { ...roles, can: { admin: { Lead: ['fly'] } } } }, '/roles/can/admin/Lead/0').hint, /transitions of Lead: win, lose; actions: act, glob/);
  assert.match(at({ roles: { ...roles, can: { admin: { Lead: ['go:fly'] } } } }, '/roles/can/admin/Lead/0').message, /unknown operation "go:fly"/);
  assert.match(at({ roles: { ...roles, can: { admin: { Lead: ['do:fly'] } } } }, '/roles/can/admin/Lead/0').message, /unknown operation "do:fly"/);
  assert.match(at({ roles: { ...roles, can: { admin: { Lead: [5] } } } }, '/roles/can/admin/Lead/0').message, /operation must be a string/);
  assert.equal(at({ roles: { ...roles, can: { admin: { '*': ['go:anything', 'do:anything', 'go:*'] } } } }, '/roles/can/admin/*/0').message, undefined, 'on "*" any name is allowed');
  assert.match(at({ roles: { ...roles, can: { admin: { Lead: { own: 'title', can: ['view'] } } } } }, '/roles/can/admin/Lead/own').message, /must be a "ref:User" field/);
  assert.match(at({ roles: { ...roles, can: { admin: { Lead: { own: 'ghost', can: ['view'] } } } } }, '/roles/can/admin/Lead/own').message, /does not exist/);
  assert.match(at({ roles: { ...roles, can: { admin: { '*': { own: 'owner', can: ['view'] } } } } }, '/roles/can/admin/*/own').message, /needs a concrete entity/);
  assert.match(at({ roles: { ...roles, can: { admin: { Lead: { own: 'owner', can: ['zap'] } } } } }, '/roles/can/admin/Lead/can/0').message, /unknown operation "zap"/);
  assert.match(at({ roles, identity: { entity: 'User' } }, '/roles').message, /roles and identity cannot both/);
  assert.match(at({ lists: [{ id: 'l', entity: 'Lead', roles: ['admin'] }] }, '/lists/0/roles').message, /no \/roles declared/);
  assert.match(at({ roles, lists: [{ id: 'l', entity: 'Lead', roles: ['boss'] }] }, '/lists/0/roles/0').message, /"boss" is not a role/);
  assert.match(at({ roles, pages: [{ id: 'p', title: 'P', roles: ['boss'] }] }, '/pages/0/roles/0').message, /not a role/);
  assert.match(at({ roles, dashboards: [{ id: 'd', title: 'D', roles: ['boss'] }] }, '/dashboards/0/roles/0').message, /not a role/);
});

test('states: the field, its default, transitions, reachability, "by" and "fields"', () => {
  const S = (lead) => ({ states: { Lead: lead } });
  assert.match(at(S({}), '/states/Lead/field').message, /states need "field"/);
  assert.match(at(S({ field: 'ghost' }), '/states/Lead/field').message, /does not exist/);
  assert.match(at(S({ field: 'title' }), '/states/Lead/field').message, /"title" is text; a status field must be an enum with a default/);
  assert.match(at({ data: { ...base.data, Lead: { ...base.data.Lead, status: 'enum[a,b]' } }, ...S({ field: 'status', transitions: [] }) }, '/states/Lead/field').hint, /enum\[a,b\]=a/);
  assert.match(at({ states: { Ghost: { field: 'x' } } }, '/states/Ghost').message, /unknown entity/);
  const T = (transitions) => S({ field: 'status', transitions });
  assert.match(at(T([{ to: 'won' }]), '/states/Lead/transitions/0/name').message, /transition needs a name/);
  assert.match(at(T([{ name: 'a', to: 'won' }, { name: 'a', to: 'lost' }]), '/states/Lead/transitions/1/name').message, /declared twice/);
  assert.match(at(T([{ name: 'a', to: 'gone' }]), '/states/Lead/transitions/0/to').hint, /statuses: new, won, lost/);
  assert.match(at(T([{ name: 'a', from: ['gone'], to: 'won' }]), '/states/Lead/transitions/0/from/0').message, /"gone" is not a status/);
  assert.match(at(T([{ name: 'a', from: 'gone', to: 'won' }]), '/states/Lead/transitions/0/from/0').message, /not a status/);
  assert.match(at(T([{ name: 'a', to: 'won', by: ['admin'] }]), '/states/Lead/transitions/0/by').message, /no \/roles declared/);
  assert.match(at({ roles, ...T([{ name: 'a', to: 'won', by: ['boss'] }]) }, '/states/Lead/transitions/0/by/0').message, /"boss" is not a role/);
  assert.match(at(T([{ name: 'a', to: 'won', fields: ['ghost'] }]), '/states/Lead/transitions/0/fields').message, /does not exist/);
  assert.match(at(T([{ name: 'a', to: 'won', do: [{ block: 'nope' }] }]), '/states/Lead/transitions/0/do/0/block').message, /unknown block/);
  assert.match(at(T([{ name: 'a', from: ['new'], to: 'won' }]), '/states/Lead/transitions').message, /no transition leads to: lost/);
  assert.equal(at(T([{ name: 'a', from: '*', to: 'won' }, { name: 'b', to: 'lost' }]), '/states/Lead/transitions').message, undefined, '"*" and no "from" mean every status');
  assert.match(at(T([{ name: 'a', from: ['lost'], to: 'won' }, { name: 'b', from: ['won'], to: 'lost' }]), '/states/Lead/transitions').message, /no transition leads to: won, lost/, 'reachability starts at the default');
});

test('connectors, rules and events', () => {
  assert.match(at({ connectors: { x: 5 } }, '/connectors/x').message, /must be an object/);
  assert.match(at({ connectors: { x: { kind: 'fax' } } }, '/connectors/x/kind').hint, /kinds: http, mail/);
  assert.match(at({ connectors: { x: { kind: 'http', url: 'ftp://x' } } }, '/connectors/x/url').message, /needs "url" starting with http/);
  assert.match(at({ connectors: { x: { kind: 'http', url: 'https://x', method: 'DELETE' } } }, '/connectors/x/method').message, /unsupported method/);
  assert.match(at({ rules: { Ghost: [] } }, '/rules/Ghost').message, /unknown entity/);
  assert.match(at({ rules: { Lead: {} } }, '/rules/Lead').hint, /"check": "qty > 0"/);
  assert.match(at({ rules: { Lead: [{ unique: 'ghost' }] } }, '/rules/Lead/0/unique').message, /does not exist/);
  assert.match(at({ rules: { Lead: [{ nope: 1 }] } }, '/rules/Lead/0').message, /a rule is \{"check"/);
  assert.match(at({ rules: { Lead: [{ check: 'value', message: 'm' }] } }, '/rules/Lead/0/check').message, /a check must be a condition; this expression is money/);
  assert.match(at({ rules: { Lead: [{ check: 'value > 0' }] } }, '/rules/Lead/0/message').message, /needs a "message"/);
  assert.match(at({ rules: { Lead: [{ check: 'ghost > 0', message: 'm' }] } }, '/rules/Lead/0/check').message, /Lead has no field "ghost"/);
  assert.deepEqual(errs({ rules: { Lead: [{ check: 'value >= 0 and done', message: 'm' }, { unique: 'title' }] } }), []);
  assert.match(at({ events: [{ on: 'Lead.exploded', do: [] }] }, '/events/0/on').hint, /<Entity>\.created, <Entity>\.updated, <Entity>\.deleted/);
  assert.match(at({ events: [{ on: 'Ghost.deleted', do: [] }] }, '/events/0/on').message, /unknown entity/);
  assert.deepEqual(errs({ events: [{ on: 'Lead.deleted', do: [{ block: 'http.send', connector: 'hook', body: { t: '@row.title' } }] }] }), []);
});

test('steps: references, expressions, connectors, adjust, each and ensure', () => {
  const A = (steps, extra = {}) => ({ actions: [{ name: 'a', in: 'Lead', do: steps, ...extra }] });
  const G = (steps) => ({ actions: [{ name: 'g', do: steps }] });
  assert.deepEqual(errs(A([
    { block: 'db.adjust', field: 'value', by: '= -value / 2' },
    { block: 'db.ensure', entity: 'Note', where: { lead: '@row.id' }, values: { body: '= concat(row.title, "!")' } },
    { block: 'db.each', from: 'Note', where: { lead: '@row.id' }, do: [{ block: 'db.adjust', entity: 'Note', id: '@each.id', field: 'n', by: '= each.n + found.n' }] },
    { block: 'random.pick', from: 'Note' },
    { block: 'db.createRow', entity: 'Note', values: { lead: '@row.id', body: '@picked.body', n: '= count(Note)' } },
    { block: 'http.send', connector: 'hook', body: { who: '@me', when: '@now', day: '@today', made: '@created', d: '@delivery', v: '@values.x', t: '@row.owner.name' } },
    { block: 'mail.send', connector: 'mail', to: '@row.owner.email', subject: 's' },
  ])), []);
  assert.match(at(A([{ block: 'db.update', set: { title: '@ghost.x' } }]), '/actions/0/do/0/set/title').hint, /available here: @row\.<field>, @me/);
  assert.match(at(A([{ block: 'db.update', set: { title: '@me.email' } }]), '/actions/0/do/0/set/title').hint, /declare \/roles or \/identity/);
  assert.match(at(A([{ block: 'db.update', set: { title: '= me.email' } }]), '/actions/0/do/0/set/title').message, /"me" has no fields here/);
  assert.equal(at({ roles, ...A([{ block: 'db.update', set: { title: '@me.email', value: '= len(me.name)' } }]) }, '/actions/0/do/0/set/title').message, undefined);
  assert.match(at({ roles, ...A([{ block: 'db.update', set: { title: '@me.ghost' } }]) }, '/actions/0/do/0/set/title').message, /bad reference "@me\.ghost": User has no field "ghost"/);
  assert.match(at({ roles, ...A([{ block: 'db.update', set: { title: '= me.ghost' } }]) }, '/actions/0/do/0/set/title').message, /User has no field "ghost"/);
  assert.match(at(A([{ block: 'db.update', set: { title: '@row.ghost' } }]), '/actions/0/do/0/set/title').message, /bad reference "@row\.ghost": Lead has no field "ghost"/);
  assert.match(at(A([{ block: 'db.update', set: { title: '= ghost' } }]), '/actions/0/do/0/set/title').message, /bad expression: Lead has no field "ghost"/);
  assert.match(at(A([{ block: 'db.update', set: { title: '= each.n' } }]), '/actions/0/do/0/set/title').message, /Lead has no field "each"/);
  assert.match(at(G([{ block: 'db.createRow', entity: 'Note', values: { body: '= title' } }]), '/actions/0/do/0/values/body').message, /unknown name "title"; available here: me, now, today/);
  assert.match(at(G([{ block: 'db.createRow', entity: 'Note', values: { n: '= count(Note)' } }]), '/actions/0/do/0/values/n').message, /no current row here to aggregate Note against/);
  assert.match(at(A([{ block: 'db.update', set: { title: '= found.n' } }]), '/actions/0/do/0/set/title').message, /Lead has no field "found"/, 'found exists only after db.ensure');
  assert.match(at(A([{ block: 'db.update', set: { title: '= row.owner.name + 1' } }]), '/actions/0/do/0/set/title').message, /"\+" needs numbers, got text/);
  assert.match(at(A([{ block: 'db.update', set: { done: '@values.done', title: ['= 1 +'] } }]), '/actions/0/do/0/set/title/0').message, /bad expression/);
  assert.match(at(A([{ block: 'db.adjust', field: 'title', by: 1 }]), '/actions/0/do/0/field').message, /db\.adjust needs a numeric field; Lead\.title is text/);
  assert.match(at(A([{ block: 'db.adjust', entity: 'Note', field: 'n', by: 1 }]), '/actions/0/do/0/id').message, /needs "id"/);
  assert.match(at(A([{ block: 'db.adjust', field: 'value', by: '= ghost' }]), '/actions/0/do/0/by').message, /bad expression/);
  assert.match(at(A([{ block: 'http.send', connector: 'nope', body: {} }]), '/actions/0/do/0/connector').hint, /declared: hook, mail/);
  assert.match(at(A([{ block: 'http.send', connector: 'mail', body: {} }]), '/actions/0/do/0/connector').message, /connector "mail" is mail, http\.send needs http/);
  assert.match(at({ connectors: undefined, ...A([{ block: 'mail.send', connector: 'x', to: 'a', subject: 's' }]) }, '/actions/0/do/0/connector').hint, /\(none; add \/connectors\)/);
  assert.match(at(A([{ block: 'db.each', from: 'Note', where: { ghost: 1 }, do: [] }]), '/actions/0/do/0/where/ghost').message, /does not exist/);
  assert.match(at(A([{ block: 'db.each', from: 'Note', where: { n: { between: [1, 2] } }, do: [] }]), '/actions/0/do/0/where/n/between').hint, /comparisons: gte, lte/);
  assert.match(at(A([{ block: 'db.ensure', entity: 'Note', where: { ghost: 1 } }]), '/actions/0/do/0/where/ghost').message, /does not exist/);
  assert.match(at(A([{ block: 'db.each', from: 'Note', do: [{ block: 'db.update', set: { title: '= each.ghost' } }] }]), '/actions/0/do/0/do/0/set/title').message, /Note has no field "ghost"/);
  assert.equal(at(A([{ block: 'db.update', set: { value: '= sum(Note: n)' } }]), '/actions/0/do/0/set/value').message, undefined);
  assert.match(at(A([{ block: 'db.update', set: { value: '= sum(Note.body: n)' } }]), '/actions/0/do/0/set/value').message, /Note\.body is not a reference to Lead/);
  assert.match(at({ actions: [{ name: 'a', in: 'Lead', by: ['x'], do: [{ block: 'db.delete' }] }] }, '/actions/0/by').message ?? '', /^$/, '"by" on an action is not checked against roles without /roles');
});

test('views: id columns, range filters, go: row actions, detail actions, related row actions, period and units', () => {
  assert.deepEqual(errs({ override: { 'Lead.list': { columns: ['id', 'title'], filters: [{ field: 'when', range: true }, { field: 'value', range: true }, { field: 'done' }], rowActions: ['view', 'go:win', 'act'] },
    'Lead.detail': { actions: ['act'], fields: ['title', 'value'], related: [{ entity: 'Note', via: 'lead', columns: ['id', 'body'], rowActions: ['edit', 'delete', 'view'] }] } } }), []);
  assert.match(at({ override: { 'Lead.list': { filters: [{ field: 'title', range: true }] } } }, '/override/Lead.list/filters/0').message, /a range filter needs a date, time, int or money field; "title" is text/);
  assert.match(at({ override: { 'Lead.list': { filters: [{ field: 'title' }] } } }, '/override/Lead.list/filters/0').hint, /ref, enum and bool/);
  assert.match(at({ override: { 'Lead.list': { rowActions: ['go:fly'] } } }, '/override/Lead.list/rowActions/0').hint, /declared in \/states\/Lead: win, lose/);
  assert.match(at({ override: { 'Lead.list': { rowActions: ['fly'] } } }, '/override/Lead.list/rowActions/0').hint, /go:<transition>/);
  assert.match(at({ override: { 'Lead.detail': { actions: ['fly'] } } }, '/override/Lead.detail/actions/0').message, /unknown action "fly"/);
  assert.match(at({ override: { 'User.list': { columns: ['password'] } } }, '/override/User.list/columns').message, /"password" is a password and is never shown/);
  assert.match(at({ override: { 'User.detail': { fields: ['password'] } } }, '/override/User.detail/fields').message, /never shown/);
  assert.match(at({ lists: [{ id: 'u', entity: 'User', columns: ['password'] }] }, '/lists/0/columns').message, /never shown/);
  assert.match(at({ override: { 'Lead.detail': { related: [{ entity: 'Note', via: 'lead', columns: ['body'] }] }, 'Note.list': {} }, data: { ...base.data, Note: { ...base.data.Note, secret: 'password' } } }, '/override/Lead.detail/related/0/columns').message ?? '', /^$/);
  assert.match(at({ data: { ...base.data, Note: { ...base.data.Note, secret: 'password' } }, override: { 'Lead.detail': { related: [{ entity: 'Note', via: 'lead', columns: ['secret'] }] } } }, '/override/Lead.detail/related/0/columns').message, /never shown/);
  assert.match(at({ override: { 'Lead.detail': { actions: ['glob'] } } }, '/override/Lead.detail/actions/0').message, /action "glob" is not bound to Lead/);
  assert.match(at({ override: { 'Lead.detail': { related: [{ entity: 'Note', via: 'lead', rowActions: ['fly'] }] } } }, '/override/Lead.detail/related/0/rowActions/0').message, /unknown action "fly" on Note/);
  assert.match(at({ override: { 'Lead.form': { fields: ['title'] }, 'Note.form': { fields: ['nn'] } } }, '/override/Note.form/fields').message, /does not exist/);
  assert.match(at({ data: { ...base.data, Lead: { ...base.data.Lead, d: 'int := 1' } }, override: { 'Lead.form': { fields: ['d'] } } }, '/override/Lead.form/fields').message, /"d" is derived \(:=\) and cannot be written/);
  assert.equal(at({ data: { ...base.data, Lead: { ...base.data.Lead, d: 'int := 1' } }, override: { 'Lead.detail': { fields: ['d'] } } }, '/override/Lead.detail/fields').message, undefined, 'a detail may show a derived field');
  assert.match(at({ override: { 'Lead.list': { where: { value: { zz: 1 } } } } }, '/override/Lead.list/where/value/zz').message, /unknown comparison "zz"/);
  assert.match(at({ lists: [{ id: 'l', entity: 'Lead', where: { when: { after: 1 } } }] }, '/lists/0/where/when/after').message, /unknown comparison/);
  assert.match(at({ dashboards: [{ id: 'd', title: 'D', period: { Ghost: 'x' } }] }, '/dashboards/0/period/Ghost').message, /unknown entity/);
  assert.match(at({ dashboards: [{ id: 'd', title: 'D', period: { Lead: 'title' } }] }, '/dashboards/0/period/Lead').message, /must be a date or time; it is text/);
  assert.match(at({ dashboards: [{ id: 'd', title: 'D', tables: [{ entity: 'Lead', groupBy: 'createdAt', groupUnit: 'week' }] }] }, '/dashboards/0/tables/0/groupUnit').hint, /units: day, month, year/);
  assert.match(at({ dashboards: [{ id: 'd', title: 'D', tables: [{ entity: 'Lead', groupBy: 'status', groupUnit: 'month' }] }] }, '/dashboards/0/tables/0/groupUnit').message, /needs a date or time groupBy; "status" is enum/);
  assert.match(at({ dashboards: [{ id: 'd', title: 'D', cards: [{ entity: 'Lead', where: { value: { between: 1 } } }] }] }, '/dashboards/0/cards/0/where/value/between').message, /unknown comparison/);
  assert.match(at({ dashboards: [{ id: 'd', title: 'D', tables: [{ entity: 'Lead', where: { value: { between: 1 } } }] }] }, '/dashboards/0/tables/0/where/value/between').message, /unknown comparison/);
  assert.deepEqual(errs({ dashboards: [{ id: 'd', title: 'D', period: { Lead: 'createdAt' }, tables: [{ entity: 'Lead', groupBy: 'when', groupUnit: 'day', where: { value: { gte: 1 } } }] }] }), []);
});

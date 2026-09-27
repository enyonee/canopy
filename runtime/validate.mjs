// The checker. Every error must name the path, the problem and the way out —
// the repair loop is where the tokens go, not the writing. This is the driver:
// it builds the shared toolbox (`h`) and calls one checker module per
// top-level node kind, in the order later kinds may depend on (data before
// everything; roles before override/lists/dashboards/pages/states, which read
// its role list; states/actions before nothing else needs them). See
// runtime/ARCHITECTURE.md for the full module map and runtime/check/*.mjs for
// the checkers themselves.
import { DEFAULT } from './registry.mjs';
import { createScope } from './check/scope.mjs';
import { createStepsChecker } from './check/steps.mjs';
import { checkTop, checkViews } from './check/basics.mjs';
import * as plugins from './check/plugins.mjs';
import * as data from './check/data.mjs';
import * as roles from './check/roles.mjs';
import * as override from './check/override.mjs';
import * as lists from './check/lists.mjs';
import * as dashboards from './check/dashboards.mjs';
import * as pages from './check/pages.mjs';
import * as seed from './check/seed.mjs';
import * as actions from './check/actions.mjs';
import * as events from './check/events.mjs';
import * as states from './check/states.mjs';
import * as connectors from './check/connectors.mjs';
import * as rules from './check/rules.mjs';

// The top-level node kinds this format understands. Order matters here only
// for the "did you mean" and "nodes are: …" hints in an unknown-key message —
// tests pin the exact join, so keep it as printed. runtime/check/*.mjs's
// exported `NODES` must union to exactly this set (tests/arch.test.mjs checks
// it against docs/FORMAT.md's «Top-level nodes» table too).
export const TOP = ['app', 'task', 'note', 'theme', 'home', 'data', 'seed', 'identity', 'roles', 'views', 'override', 'lists',
  'dashboards', 'pages', 'actions', 'events', 'states', 'connectors', 'rules', 'allowDestructive', 'plugins'];

export function validate(graph, registry = DEFAULT) {
  const errors = [];
  const err = (path, message, hint) => errors.push({ path, message, hint });
  if (!graph || typeof graph !== 'object') return [{ path: '/', message: 'graph must be an object' }];

  const h = { err, graph, registry, CATALOG: registry.blocks };
  checkTop(graph, h, TOP);
  plugins.check(graph, h);
  if (!graph.data || typeof graph.data !== 'object' || !Object.keys(graph.data).length) {
    err('/data', 'at least one entity is required', 'e.g. {"Task": {"title": "text!"}}');
    return errors;
  }

  h.entities = Object.keys(graph.data);
  h.fields = {};
  data.parseFields(graph, h);
  Object.assign(h, createScope(graph, h));
  h.checkSteps = createStepsChecker(h);

  data.check(graph, h);
  checkViews(graph, h);
  roles.check(graph, h);
  override.check(graph, h);
  lists.check(graph, h);
  dashboards.check(graph, h);
  pages.check(graph, h);
  seed.check(graph, h);
  actions.check(graph, h);
  events.check(graph, h);
  states.check(graph, h);
  connectors.check(graph, h);
  rules.check(graph, h);

  return errors;
}

export const formatErrors = (errors) =>
  errors.map((e) => `  ✗ ${e.path}: ${e.message}${e.hint ? `\n      → ${e.hint}` : ''}`).join('\n');

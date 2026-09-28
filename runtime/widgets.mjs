// The widgets table. A widget is presentation + input only: it renders state it
// reads and sends intents to the graph's own actions/transitions; it never
// writes storage itself. No core widget ships — apps register their own
// through a plugin (`widgets: { name: { summary, client, props?, check? } }`,
// see docs/FORMAT.md's «Widgets» section), the same way the other three
// registries stay empty of anything the format itself does not need.
/** @type {Record<string, import('./types.d.ts').WidgetType>} */
export const WIDGETS = {};

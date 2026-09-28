// Server side of the HTML editor widget. There is no custom block: saving a
// document, and marking it a template, are both plain writes to the
// Document row's own stored fields — the core edit route already does that,
// through the widget's own api.post — and the code/text conversion is a pure
// client-side function with nothing to referee server-side. This plugin's
// only job is registering the widget itself.
export default {
  widgets: {
    htmleditor: {
      summary: 'a code/text HTML editor: syntax-highlighted source, a live sandboxed preview, a text mode with one-way "convert to HTML", save and save-as-template',
      client: './htmleditor.client.mjs',
    },
  },
};

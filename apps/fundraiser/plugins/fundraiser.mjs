// Server side of the fundraiser site's one widget: no custom block, because
// the carousel neither writes storage nor referees a rule — it only reads
// Offer rows (through its own api.get) and rotates what it shows.
export default {
  widgets: {
    carousel: {
      summary: 'an auto-advancing carousel over the /Offer rows, one slide at a time on a timer',
      client: './carousel.client.mjs',
    },
  },
};

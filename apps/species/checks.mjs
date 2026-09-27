// WebGen-Bench 000088 — species biological information database: browse, search, filter.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Browse the database for available biological information of different species.',
    run: async ({ asGuest, get, rows, must }) => {
      asGuest();
      const { html, status } = await get('/Species');
      must(status === 200, `species database returned ${status}`);
      const found = rows(html);
      must(found.length === 9, `expected 9 seeded species, got ${found.length}`);
      must(found.every((r) => /<td>[^<]+<\/td><td>[^<]+<\/td><td>(?:Animalia|Plantae|Fungi)<\/td><td>(?:Forest|Ocean|Desert|Grassland|Freshwater|Arctic)<\/td><td>[A-Z]{2}<\/td><td>[\d,]*<\/td>/.test(r)),
        'a species row is missing a field (common name, scientific name, kingdom, habitat, status or population)');
      return `${found.length} species listed, every row fully populated`;
    } },
  { task: 'Perform a search for a specific species using the search functionality.',
    run: async ({ asGuest, get, rows, must }) => {
      asGuest();
      const hits = rows((await get('/Species?q=Vaquita')).html);
      must(hits.length === 1 && /Vaquita/.test(hits[0]) && /Phocoena sinus/.test(hits[0]), `expected only Vaquita, got ${hits.length}`);
      const bySci = rows((await get('/Species?q=Loxodonta')).html);
      must(bySci.length === 1 && /African Elephant/.test(bySci[0]), 'searching a scientific name should find its species');
      return 'searching by common or scientific name returns exactly the matching species';
    } },
  { task: 'Apply a filter to the data based on a given criterion (e.g., habitat type).',
    run: async ({ asGuest, get, rows, must }) => {
      asGuest();
      const ocean = rows((await get('/Species?habitat=Ocean')).html);
      must(ocean.length === 2 && ocean.every((r) => /<td>Ocean<\/td>/.test(r)), `expected 2 ocean species, got ${ocean.length}`);
      must(ocean.some((r) => /Bottlenose Dolphin/.test(r)) && ocean.some((r) => /Vaquita/.test(r)), 'the ocean filter is missing an expected species');
      const desert = rows((await get('/Species?habitat=Desert')).html);
      must(desert.length === 2, `expected 2 desert species, got ${desert.length}`);
      return 'filtering by habitat shows only matching species (2 ocean, 2 desert)';
    } },
  colorCheck('linen', 'maroon'),
];

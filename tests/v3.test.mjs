// Round three: sorting and paging, CSV export, inline images, correlated aggregates,
// date arithmetic, landing on a created row, filtering by id, the payment sandbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { boot, rows, tmpGraph } from './helpers.mjs';

const payment = path.resolve('plugins/payment.mjs');

const graph = {
  app: 'r3', plugins: [payment],
  data: {
    Car: { name: 'text!', pricePerDay: 'money!', photo: 'image',
      bookings: 'int := count(Booking)', nextFree: 'date := max(Booking: end)' },
    Booking: { car: 'ref:Car!', start: 'date!', end: 'date!', card: 'text', status: 'enum[draft,paid]=draft',
      days: 'int := days(end, start)', total: 'money := days * car.pricePerDay', until: 'date := addDays(end, 1)',
      clashes: 'int := count(Booking: car = row.car and start <= row.end and end >= row.start) - 1' },
    Note: { car: 'ref:Car!', text: 'text!' },
  },
  rules: { Booking: [{ check: 'end >= start', message: 'The end must not be before the start' }] },
  seed: { Car: [{ name: 'Beetle', pricePerDay: 30 }, { name: 'Alpine', pricePerDay: 90 }, { name: 'Coupe', pricePerDay: 60 }],
    Booking: [{ car: 1, start: '2026-05-10', end: '2026-05-12' }] },
  connectors: { gateway: { kind: 'payment', currency: 'EUR' } },
  states: { Booking: { field: 'status', transitions: [{ name: 'pay', from: ['draft'], to: 'paid', fields: ['card'], confirm: 'Paid {row.total}, reference {authorization}',
    do: [{ block: 'payment.charge', connector: 'gateway', amount: '= total', card: '@row.card' }] }] } },
  actions: [{ name: 'note', in: 'Car', after: '/Note/{created}', confirm: 'noted', do: [{ block: 'db.createRow', entity: 'Note', values: { car: '@row.id', text: 'hello' } }] }],
  override: { 'Car.list': { columns: ['name', 'pricePerDay', 'bookings', 'nextFree', 'photo'], pageSize: 2, sort: { field: 'name', dir: 'asc' }, rowActions: ['note'] },
    'Booking.list': { columns: ['id', 'car', 'start', 'end', 'days', 'total', 'until', 'clashes', 'status'], where: { id: { gte: 1 } } } },
  lists: [{ id: 'cheap', entity: 'Car', where: { pricePerDay: { lte: 60 } }, columns: ['name', 'pricePerDay'], sort: { field: 'pricePerDay', dir: 'desc' } }],
  dashboards: [{ id: 'd', title: 'D', period: { Booking: 'start' }, cards: [{ title: 'Cars', entity: 'Car' }, { title: 'Revenue', entity: 'Booking', fn: 'sum', field: 'total' }],
    tables: [{ title: 'By car', entity: 'Booking', groupBy: 'car', metrics: [{ fn: 'count', as: 'n', title: 'Bookings' }, { fn: 'sum', field: 'total', as: 'rev', title: 'Revenue' }] }] }],
};

const s = await boot(tmpGraph(graph));

test('every column sorts both ways and the graph sort is the default', async () => {
  const names = (html) => rows(html).map((r) => /<td>([^<]+)<\/td>/.exec(r)[1]);
  assert.deepEqual(names((await s.get('/Car')).html), ['Alpine', 'Beetle'], 'page one of the default sort');
  assert.deepEqual(names((await s.get('/Car?sort=pricePerDay&dir=desc')).html), ['Alpine', 'Coupe']);
  assert.deepEqual(names((await s.get('/Car?sort=pricePerDay&dir=asc&page=2')).html), ['Alpine']);
  assert.deepEqual(names((await s.get('/Car?sort=nope')).html), ['Alpine', 'Beetle'], 'an unknown sort falls back');
  assert.deepEqual(names((await s.get('/Car?sort=id&dir=desc')).html), ['Coupe', 'Alpine'], 'id sorts too');
  const page = await s.get('/Car');
  assert.match(page.html, /<th><a href="\/Car\?sort=name&dir=desc">Name ▲<\/a><\/th>/, 'the active column shows its direction and flips');
  assert.match(page.html, /Page 1 of 2 · <a href="\/Car\?page=2">Next<\/a>/);
  assert.match((await s.get('/Car?page=2')).html, /Page 2 of 2 · <a href="\/Car\?page=1">Previous<\/a>/);
  assert.match(page.html, /3 item\(s\) · <a href="\/Car\.csv">Export CSV<\/a>/);
  assert.match((await s.get('/Car?page=9')).html, /Page 2 of 2/, 'a page past the end is the last page');
  assert.deepEqual(names((await s.get('/list/cheap')).html), ['Coupe', 'Beetle']);
  assert.deepEqual(names((await s.get('/list/cheap?sort=name&dir=asc')).html), ['Beetle', 'Coupe']);
});

test('CSV export of an entity list, a saved list and a dashboard, with the same filters and labels', async () => {
  const r = await s.get('/Car.csv?sort=pricePerDay&dir=desc');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="Car.csv"');
  assert.equal(r.html, 'Name,Price Per Day,Bookings,Next Free,Photo\r\nAlpine,90.00,0,,\r\nCoupe,60.00,0,,\r\nBeetle,30.00,1,2026-05-12,\r\n', 'money formatted, derived included, every row regardless of paging');
  assert.equal((await s.get('/list/cheap.csv')).html, 'Name,Price Per Day\r\nCoupe,60.00\r\nBeetle,30.00\r\n');
  const b = await s.get('/Booking.csv');
  assert.match(b.html, /^Id,Car,Start,End,Days,Total,Until,Clashes,Status\r\n1,Beetle,2026-05-10,2026-05-12,2,60\.00,2026-05-13,0,draft\r\n$/, 'references export as labels');
  const d = await s.get('/dashboard/d.csv');
  assert.equal(d.html, 'Section,Metric,Group,Value\r\ncard,Cars,,3\r\ncard,Revenue,,60.00\r\nBy car,Bookings,Beetle,1\r\nBy car,Revenue,Beetle,60.00\r\n');
  const outsidePeriod = await s.get('/dashboard/d.csv?from=2026-06-01&to=2026-06-30');
  assert.equal(outsidePeriod.html, 'Section,Metric,Group,Value\r\ncard,Cars,,3\r\ncard,Revenue,,0.00\r\n', 'a period outside every booking narrows the CSV export too, not only the HTML view');
  assert.equal((await s.get('/dashboard/nope.csv')).status, 404);
  assert.equal((await s.get('/list/nope.csv')).status, 404);
  await s.post('/Note', { car: 1, text: 'a "quoted", note' });
  assert.match((await s.get('/Note.csv')).html, /"a ""quoted"", note"/, 'cells with quotes and commas are quoted');
});

test('correlated aggregates, addDays and max over dates, and a where on id', async () => {
  const list = await s.get('/Booking');
  assert.match(list.html, /<td>2<\/td><td>60\.00<\/td><td>2026-05-13<\/td><td>0<\/td>/, 'days, total through a hop, addDays, no clash');
  const clash = await s.post('/Booking', { car: 1, start: '2026-05-11', end: '2026-05-14' });
  assert.equal(clash.status, 303);
  const after = await s.get('/Booking');
  assert.equal(rows(after.html).filter((r) => /<td>1<\/td><td><span class="status">Draft/.test(r)).length, 2, 'both overlapping bookings count one clash');
  const car = await s.get('/Car/1');
  assert.match(car.html, /<th>Next Free<\/th><td>2026-05-14<\/td>/, 'max over a date field');
  assert.match(car.html, /<th>Bookings<\/th><td>2<\/td>/);
  assert.equal((await s.post('/Booking', { car: 1, start: '2026-06-02', end: '2026-06-01' })).status, 400);
  assert.equal(rows((await s.get('/Booking')).html).length, 2, 'where on id filters');
  assert.equal(rows((await s.get('/Booking?sort=id&dir=desc')).html)[0].includes('<td>2</td>'), true);
});

test('an action lands on the row it created', async () => {
  const r = await s.post('/Car/2/action/note', {});
  assert.equal(r.status, 303);
  assert.match(r.location, /^\/Note\/\d+\?ok=noted$/);
  const id = /\/Note\/(\d+)/.exec(r.location)[1];
  assert.match((await s.get(`/Note/${id}`)).html, /<th>Text<\/th><td>hello<\/td>/);
});

test('an image field is uploaded like a file and served inline as an image', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const up = await s.upload('/Car/1', { name: 'Beetle', pricePerDay: '30' }, { field: 'photo', name: 'beetle.png', content: png });
  assert.equal(up.status, 303);
  const list = await s.get('/Car');
  assert.match(list.html, /<img class="thumb" src="\/file\/Car\/1\/photo\?inline=1" alt="beetle.png">/);
  const inline = await fetch(`${s.base}/file/Car/1/photo?inline=1`);
  assert.equal(inline.headers.get('content-type'), 'image/png');
  assert.match(inline.headers.get('content-disposition'), /^inline; filename="beetle\.png"/);
  assert.equal((await inline.arrayBuffer()).byteLength, png.length);
  const download = await fetch(`${s.base}/file/Car/1/photo`);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.match(download.headers.get('content-disposition'), /^attachment/);
  await download.arrayBuffer();
  const form = await s.get('/Car/1/edit');
  assert.match(form.html, /accept="image\/\*"/);
  const csvLine = (await s.get('/Car.csv')).html.split('\r\n')[2];
  assert.match(csvLine, /Beetle,30\.00,2,2026-05-14,\d+-beetle\.png/);
});

test('the payment sandbox authorises inside the transaction and captures through the outbox', async () => {
  const declined = await s.post('/Booking/1/go/pay', { card: '4000 0000 0000 0002' });
  assert.equal(declined.status, 400); assert.match(declined.html, /Card declined/);
  assert.match((await s.get('/Booking/1')).html, /status">Draft/, 'a declined charge rolls the transition back');
  const invalid = await s.post('/Booking/1/go/pay', { card: '1234' });
  assert.equal(invalid.status, 400); assert.match(invalid.html, /Card number is not valid/);
  const paid = await s.post('/Booking/1/go/pay', { card: '4242 4242 4242 4242' });
  assert.equal(paid.status, 303);
  assert.match(decodeURIComponent(paid.location), /Paid 60\.00, reference AUTH-4242-/);
  assert.match((await s.get('/Booking/1')).html, /status">Paid/);
  const [capture] = await s.app.store.outbox({ kind: 'payment' });
  assert.equal(capture.status, 'sent'); assert.equal(capture.target, '**** 4242'); assert.equal(capture.code, 200);
  assert.deepEqual({ amount: capture.payload.amount, currency: capture.payload.currency }, { amount: 60, currency: 'EUR' });
  assert.match(capture.payload.authorization, /^AUTH-4242-/);
  const zero = await boot(tmpGraph({ ...graph, seed: { ...graph.seed, Booking: [{ car: 1, start: '2026-05-10', end: '2026-05-10' }] } }));
  try {
    const r = await zero.post('/Booking/1/go/pay', { card: '4242424242424242' });
    assert.equal(r.status, 400); assert.match(r.html, /the amount must be positive/);
  } finally { zero.close(); }
  const { validate } = await import('../runtime/validate.mjs');
  const { loadPlugins } = await import('../runtime/registry.mjs');
  const { registry } = await loadPlugins(graph, process.cwd());
  const bad = validate({ ...graph, connectors: { gateway: { kind: 'payment', currency: 'euro' } } }, registry);
  assert.match(bad.find((e) => e.path === '/connectors/gateway/currency').message, /three letters/);
});

test('the checker: row. inside an aggregate is the outer row; min/max over dates type-check; addDays wants a date', async () => {
  const { validate } = await import('../runtime/validate.mjs');
  const at = (data, p) => validate({ app: 'c', data }, undefined).find((e) => e.path === p) || {};
  const base = { A: { d: 'date', n: 'int' }, B: { a: 'ref:A!', d: 'date', n: 'int' } };
  assert.equal(at({ ...base, A: { ...base.A, x: 'int := count(B: d >= row.d)', y: 'date := max(B: d)', z: 'date := addDays(d, n)' } }, '/data/A/x').message, undefined);
  assert.equal(validate({ app: 'c', data: { ...base, A: { ...base.A, x: 'int := count(B: d >= row.d)', y: 'date := max(B: d)', z: 'date := addDays(d, n)' } } }).length, 0);
  assert.match(at({ ...base, A: { ...base.A, x: 'int := count(B: row.ghost = 1)' } }, '/data/A/x').message, /A has no field "ghost"/);
  assert.match(at({ ...base, A: { ...base.A, x: 'int := sum(B: d)' } }, '/data/A/x').message, /sum\(B: …\) needs a number, got date/);
  assert.match(at({ ...base, A: { ...base.A, x: 'int := max(B: d)' } }, '/data/A/x').message, /derived int field gets a date expression/);
  assert.match(at({ ...base, A: { ...base.A, x: 'date := addDays(n, 1)' } }, '/data/A/x').message, /addDays\(\) needs a date first, got number/);
  assert.match(at({ ...base, A: { ...base.A, x: 'date := addDays(d, d)' } }, '/data/A/x').message, /addDays\(\) needs a number, got date/);
  assert.match(at({ ...base, A: { ...base.A, x: 'int := n', y: 'int := count(B: row.x > 0)', z: 'int := y' } }, '/data/A/x').message ?? '', /^$/);
  const cyc = validate({ app: 'c', data: { ...base, A: { ...base.A, x: 'int := count(B: row.y > 0)', y: 'int := x + 1' } } });
  assert.match(cyc[0].message, /depend on each other: A\.x → A\.y → A\.x/, 'row. inside an aggregate counts as a dependency on the outer field');
  const { validate: v } = await import('../runtime/validate.mjs');
  assert.match(v({ app: 'c', data: base, override: { 'A.list': { pageSize: 0 } } })[0].message, /pageSize must be a positive integer/);
  assert.equal(v({ app: 'c', data: base, lists: [{ id: 'l', entity: 'A', where: { id: { gte: 1 } } }] }).length, 0, 'a where on id is legal');
});

test.after(() => s.close());

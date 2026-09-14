import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, check, evaluate, isExpression, stripExpression } from '../runtime/expr.mjs';

// A scope over a tiny schema: Order { qty number, price money, name text, paid bool, when date, at time, customer ref→Customer { discount number } }
// with children Item { qty number, price money }.
const kinds = { qty: 'number', price: 'money', name: 'text', paid: 'bool', when: 'date', at: 'time', customer: 'ref', n: 'any' };
const scope = {
  field(p) {
    if (p[0] === 'customer' && p.length > 1) return p[1] === 'discount' ? 'number' : (() => { throw new Error(`Customer has no field "${p[1]}"`); })();
    if (!(p[0] in kinds)) throw new Error(`Order has no field "${p[0]}"`);
    return kinds[p[0]];
  },
  children(entity, via) {
    if (entity !== 'Item') throw new Error(`unknown entity "${entity}"`);
    if (via && via !== 'order') throw new Error(`Item.${via} is not a reference`);
    return { field: (p) => ({ qty: 'number', price: 'money' }[p[0]] || (() => { throw new Error(`Item has no field "${p[0]}"`); })()), children: () => { throw new Error('no'); } };
  },
};
const row = { qty: 3, price: 12.5, name: 'Mug', paid: true, when: '2026-03-10', at: '2026-03-12T10:00:00Z', customer: { discount: 10 }, n: null };
const items = [{ qty: 1, price: 10 }, { qty: 2, price: 5 }, { qty: 4, price: null }];
const ctxOf = (r, kids = items) => ({
  get: (p) => (p.length === 2 ? r[p[0]]?.[p[1]] ?? null : r[p[0]] ?? null),
  rows: (entity, via) => { if (entity !== 'Item') throw new Error('no such child'); void via; return kids.map((k) => ctxOf(k, [])); },
});
const ev = (src, r = row) => evaluate(parse(src), ctxOf(r));
const kind = (src) => check(parse(src), scope);

test('parses literals, paths, precedence, parentheses and unary minus', () => {
  assert.deepEqual(parse('1 + 2 * 3'), { t: 'bin', op: '+', a: { t: 'num', v: 1 }, b: { t: 'bin', op: '*', a: { t: 'num', v: 2 }, b: { t: 'num', v: 3 } } });
  assert.deepEqual(parse('(1 + 2) * 3').op, '*');
  assert.deepEqual(parse('-qty'), { t: 'un', op: '-', a: { t: 'path', p: ['qty'] } });
  assert.deepEqual(parse('customer.discount'), { t: 'path', p: ['customer', 'discount'] });
  assert.deepEqual(parse("'a'"), { t: 'str', v: 'a' });
  assert.deepEqual(parse('"b c"'), { t: 'str', v: 'b c' });
  assert.deepEqual(parse('true'), { t: 'bool', v: true });
  assert.deepEqual(parse('false'), { t: 'bool', v: false });
  assert.deepEqual(parse('null'), { t: 'null' });
  assert.equal(parse('.5').v, 0.5);
  assert.equal(parse('a == 1').op, '=', '== is an alias of =');
  for (const op of ['!=', '<', '<=', '>', '>=']) assert.equal(parse(`a ${op} 1`).op, op);
  assert.equal(parse('a and b or not c').op, 'or');
  assert.equal(parse('not a and b').op, 'and', 'not binds tighter than and');
});

test('parses calls and the aggregate forms', () => {
  assert.deepEqual(parse('sum(Item: qty * price)'), { t: 'agg', fn: 'sum', entity: 'Item', via: null, body: { t: 'bin', op: '*', a: { t: 'path', p: ['qty'] }, b: { t: 'path', p: ['price'] } } });
  assert.deepEqual(parse('count(Item)'), { t: 'agg', fn: 'count', entity: 'Item', via: null, body: null });
  assert.equal(parse('count(Item.order: qty > 1)').via, 'order');
  assert.equal(parse('min(1, 2)').t, 'call', 'min with two scalars is a function, not an aggregate');
  assert.equal(parse('max(Item: qty)').t, 'agg');
  assert.deepEqual(parse('max(Total + 1, 2)'), { t: 'call', fn: 'max', args: [{ t: 'bin', op: '+', a: { t: 'path', p: ['Total'] }, b: { t: 'num', v: 1 } }, { t: 'num', v: 2 }] }, 'a capitalised path is not an aggregate');
  assert.equal(parse('if(paid, 1, 0)').args.length, 3);
  assert.equal(parse('round(price)').args.length, 1);
  assert.equal(parse('coalesce(n, qty, 1)').args.length, 3);
});

test('refuses what it cannot parse, and says where', () => {
  assert.throws(() => parse(''), /empty expression/);
  assert.throws(() => parse('   '), /empty expression/);
  assert.throws(() => parse(42), /empty expression/);
  assert.throws(() => parse("'abc"), /unterminated string at 0/);
  assert.throws(() => parse('a $ b'), /unexpected character "\$" at 2/);
  assert.throws(() => parse('(1 + 2'), /expected "\)" at 6/);
  assert.throws(() => parse('1 +'), /unexpected end of expression/);
  assert.throws(() => parse('a.'), /expected a name after "\." at 2/);
  assert.throws(() => parse('a b'), /unexpected "b" at 2/);
  assert.throws(() => parse('foo(1)'), /unknown function "foo"; known: if, days/);
  assert.throws(() => parse('if(1, 2)'), /if\(\) takes 3 argument\(s\), got 2/);
  assert.throws(() => parse('round(1, 2, 3)'), /round\(\) takes 1–2 argument\(s\), got 3/);
  assert.throws(() => parse('sum()'), /sum\(\) aggregates rows: write sum\(Entity: field\)/);
  assert.throws(() => parse('sum(qty)'), /sum\(\) aggregates rows/);
  assert.throws(() => parse('sum(Item)'), /sum\(Item\) needs a body: sum\(Item: field\)/);
  assert.throws(() => parse('count(1, 2)'), /count\(\) aggregates rows/);
  assert.throws(() => parse(')'), /unexpected "\)" at 0/);
});

test('type-checks against the scope', () => {
  assert.equal(kind('qty * 2'), 'number');
  assert.equal(kind('qty * price'), 'money');
  assert.equal(kind('price / price'), 'number', 'money over money is a ratio');
  assert.equal(kind('price / 2'), 'money');
  assert.equal(kind('-price'), 'money');
  assert.equal(kind('-n'), 'any');
  assert.equal(kind('not paid'), 'bool');
  assert.equal(kind('qty > 1 and paid'), 'bool');
  assert.equal(kind('qty = n'), 'bool');
  assert.equal(kind("name = 'Mug'"), 'bool');
  assert.equal(kind('customer.discount'), 'number');
  assert.equal(kind('today'), 'date');
  assert.equal(kind('now'), 'time');
  assert.equal(kind('null'), 'any');
  assert.equal(kind('if(paid, price, 0)'), 'money');
  assert.equal(kind('if(paid, n, price)'), 'money', 'if falls through "any" to the other branch');
  assert.equal(kind('days(today, when)'), 'number');
  assert.equal(kind('days(at, n)'), 'number');
  assert.equal(kind('round(price, 1)'), 'money');
  assert.equal(kind('abs(n)'), 'number');
  assert.equal(kind('min(qty, 2)'), 'number');
  assert.equal(kind('coalesce(n, price)'), 'money');
  assert.equal(kind('coalesce(n, n)'), 'any');
  assert.equal(kind('len(name)'), 'number');
  assert.equal(kind('lower(name)'), 'text');
  assert.equal(kind('upper(name)'), 'text');
  assert.equal(kind("concat(name, ' x')"), 'text');
  assert.equal(kind('not(paid)'), 'bool');
  assert.equal(kind('sum(Item: qty * price)'), 'money');
  assert.equal(kind('sum(Item: qty)'), 'number');
  assert.equal(kind('avg(Item: qty)'), 'number');
  assert.equal(kind('avg(Item: price)'), 'money');
  assert.equal(kind('count(Item)'), 'number');
  assert.equal(kind('count(Item: qty > 1)'), 'number');
  assert.equal(kind('max(Item: price)'), 'money');
});

test('type errors name the operator and the offending kind', () => {
  assert.throws(() => kind('name + 1'), /"\+" needs numbers, got text \(use concat\(\) for text\)/);
  assert.throws(() => kind('paid * 2'), /"\*" needs numbers, got bool/);
  assert.throws(() => kind('-name'), /unary "-" needs a number, got text/);
  assert.throws(() => kind('days(qty, when)'), /days\(\) needs dates, got number/);
  assert.throws(() => kind('round(name)'), /round\(\) needs a number, got text/);
  assert.throws(() => kind('abs(paid)'), /abs\(\) needs a number, got bool/);
  assert.throws(() => kind('sum(Item: qty > 1)'), /sum\(Item: …\) needs a number, got bool/);
  assert.throws(() => kind('ghost'), /Order has no field "ghost"/);
  assert.throws(() => kind('customer.ghost'), /Customer has no field "ghost"/);
  assert.throws(() => kind('sum(Ghost: qty)'), /unknown entity "Ghost"/);
  assert.throws(() => kind('sum(Item.nope: qty)'), /Item.nope is not a reference/);
  assert.throws(() => kind('sum(Item: ghost)'), /Item has no field "ghost"/);
});

test('evaluates arithmetic, comparisons and logic with null propagation', () => {
  assert.equal(ev('qty * price'), 37.5);
  assert.equal(ev('(qty + 1) * 2 - 1'), 7);
  assert.equal(ev('price / 0'), null, 'division by zero is null, not Infinity');
  assert.equal(ev('price / 5'), 2.5);
  assert.equal(ev('-qty'), -3);
  assert.equal(ev('-n'), null);
  assert.equal(ev('n + 1'), null);
  assert.equal(ev('n * 2'), null);
  assert.equal(ev('n - 2'), null);
  assert.equal(ev('n / 2'), null);
  assert.equal(ev('n < 1'), false);
  assert.equal(ev('n >= 1'), false);
  assert.equal(ev('1 > n'), false);
  assert.equal(ev('1 <= n'), false);
  assert.equal(ev('n = null'), true);
  assert.equal(ev('n != null'), false);
  assert.equal(ev('qty = 3'), true);
  assert.equal(ev("qty = '3'"), true, 'form values compare loosely');
  assert.equal(ev('qty != 3'), false);
  assert.equal(ev('qty < 4 and paid'), true);
  assert.equal(ev('qty > 4 or paid'), true);
  assert.equal(ev('qty > 4 and paid'), false);
  assert.equal(ev('not paid'), false);
  assert.equal(ev('not n'), true);
  assert.equal(ev('qty <= 3'), true);
  assert.equal(ev('qty >= 4'), false);
  assert.equal(ev("name = 'Mug'"), true);
  assert.equal(ev('"x" = "x"'), true);
  assert.equal(ev('null'), null);
  assert.equal(ev('true and false'), false);
  assert.equal(ev('false or true'), true);
});

test('evaluates every function', () => {
  assert.equal(ev('if(paid, 1, 2)'), 1);
  assert.equal(ev('if(n, 1, 2)'), 2);
  assert.equal(ev('days(at, when)'), 2, 'calendar days between a timestamp and a date');
  assert.equal(ev("days('2026-03-10', '2026-03-12')"), -2);
  assert.equal(ev("days('2026-03-10T23:59:00Z', '2026-03-10T00:01:00Z')"), 0, 'hours never make a day');
  assert.equal(ev('days(n, when)'), null);
  assert.equal(ev('days(when, n)'), null);
  assert.equal(ev('round(price)'), 13);
  assert.equal(ev('round(price, 1)'), 12.5);
  assert.equal(ev('round(1.2345, 2)'), 1.23);
  assert.equal(ev('round(n)'), null);
  assert.equal(ev('abs(-qty)'), 3);
  assert.equal(ev('abs(n)'), null);
  assert.equal(ev('min(qty, 2)'), 2);
  assert.equal(ev('min(n, 2)'), 2);
  assert.equal(ev('min(2, n)'), 2);
  assert.equal(ev('max(qty, 2)'), 3);
  assert.equal(ev('max(n, 2)'), 2);
  assert.equal(ev('max(2, n)'), 2);
  assert.equal(ev('coalesce(n, qty)'), 3);
  assert.equal(ev("coalesce(n, '', 'x')"), 'x', 'empty text is not a value');
  assert.equal(ev('coalesce(n, n)'), null);
  assert.equal(ev('len(name)'), 3);
  assert.equal(ev('len(n)'), 0);
  assert.equal(ev('lower(name)'), 'mug');
  assert.equal(ev('lower(n)'), null);
  assert.equal(ev('upper(name)'), 'MUG');
  assert.equal(ev('upper(n)'), null);
  assert.equal(ev("concat(name, ' ', qty, n)"), 'Mug 3');
  assert.equal(ev('not(paid)'), false);
  assert.match(String(ev('today')), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(String(ev('now')), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(ev('days(today, today)'), 0);
});

test('aggregates walk child rows and ignore nulls', () => {
  assert.equal(ev('sum(Item: qty * price)'), 20, 'the row with a null price contributes nothing');
  assert.equal(ev('sum(Item: qty)'), 7);
  assert.equal(ev('count(Item)'), 3);
  assert.equal(ev('count(Item: qty > 1)'), 2);
  assert.equal(ev('avg(Item: price)'), 7.5);
  assert.equal(ev('min(Item: price)'), 5);
  assert.equal(ev('max(Item: qty)'), 4);
  const empty = { get: () => null, rows: () => [] };
  assert.equal(evaluate(parse('sum(Item: qty)'), empty), 0, 'an empty sum is 0');
  assert.equal(evaluate(parse('count(Item)'), empty), 0);
  assert.equal(evaluate(parse('avg(Item: qty)'), empty), null, 'an empty average is null');
  assert.equal(evaluate(parse('min(Item: qty)'), empty), null);
  assert.equal(evaluate(parse('max(Item: qty)'), empty), null);
  assert.equal(evaluate(parse('sum(Item: price) - 1'), ctxOf(row, [])), -1);
});

test('the "= expr" marker for values inside steps', () => {
  assert.equal(isExpression('= qty * 2'), true);
  assert.equal(isExpression('=qty'), true);
  assert.equal(isExpression('qty'), false);
  assert.equal(isExpression(5), false);
  assert.equal(stripExpression('=  qty * 2 '), 'qty * 2');
});

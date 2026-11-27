import { quoted } from './contracts.mjs';

function statement(spec, op, input) {
  const quote = (name) => quoted(spec.type, name);
  const bind = (i) => spec.type === 'postgres' ? '$' + (i + 1) : spec.type === 'sqlserver' ? '@p' + i : '?';
  const table = spec.relation.map(quote).join('.');
  const names = input.values.map(([name]) => quote(name));
  const values = input.values.map(([, value]) => value);
  if (op === 'insert') return [
    'INSERT INTO ' + table + ' (' + names.join(', ') + ') VALUES (' + names.map((_, i) => bind(i)).join(', ') + ')', values,
  ];
  const set = names.map((name, i) => name + ' = ' + bind(i)).join(', ');
  return ['UPDATE ' + table + ' SET ' + set + ' WHERE ' + quote(spec.write.key) + ' = ' + bind(values.length),
    [...values, input.key]];
}

export function sqlWriter(transaction) {
  return (spec, op, input) => transaction(async (execute) => {
    const count = await execute(...statement(spec, op, input));
    if (count !== 1 && !(op === 'update' && count === 0)) throw new Error('unexpected write row count');
    return count;
  });
}

export async function asyncTransaction(work, begin, execute, commit, rollback) {
  await begin();
  try {
    const result = await work(execute);
    await commit();
    return result;
  } catch (error) {
    await rollback();
    throw error;
  }
}

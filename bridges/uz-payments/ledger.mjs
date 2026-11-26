import { DatabaseSync } from 'node:sqlite';

export function openLedger(file) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>0)
    );
    CREATE TABLE IF NOT EXISTS payments (
      localId INTEGER PRIMARY KEY, provider TEXT NOT NULL, external TEXT NOT NULL,
      orderId TEXT NOT NULL REFERENCES orders(id), amount INTEGER NOT NULL,
      state INTEGER NOT NULL, providerTime INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL,
      performed INTEGER NOT NULL DEFAULT 0, cancelled INTEGER NOT NULL DEFAULT 0, reason INTEGER,
      UNIQUE(provider,external)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS active_payment ON payments(orderId) WHERE state IN (1,2);`);
  const order = db.prepare('SELECT * FROM orders WHERE id=?');
  const payment = db.prepare('SELECT * FROM payments WHERE provider=? AND external=?');
  const active = db.prepare('SELECT * FROM payments WHERE orderId=? AND state IN (1,2)');
  const last = db.prepare('SELECT * FROM payments WHERE orderId=? ORDER BY localId DESC LIMIT 1');
  const insertOrder = db.prepare('INSERT OR IGNORE INTO orders(id,provider,amount) VALUES (?,?,?)');
  const insert = db.prepare('INSERT INTO payments(provider,external,orderId,amount,state,providerTime,created) VALUES (?,?,?,?,1,?,?)');
  const pay = db.prepare('UPDATE payments SET state=2, performed=? WHERE localId=? AND state=1');
  const cancel = db.prepare('UPDATE payments SET state=?, cancelled=?, reason=? WHERE localId=? AND state IN (1,2)');
  const statement = db.prepare('SELECT * FROM payments WHERE provider=? AND providerTime BETWEEN ? AND ? ORDER BY providerTime,localId');
  const read = (r) => r ? { ...r } : null;
  return {
    close: () => db.close(),
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const value = fn(); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    register(id, provider, amount) {
      insertOrder.run(id, provider, amount);
      const saved = order.get(id);
      return saved.provider === provider && saved.amount === amount;
    },
    order: (id) => read(order.get(id)),
    payment: (provider, external) => read(payment.get(provider, external)),
    status: (id) => read(active.get(id) ?? last.get(id)),
    active: (id) => read(active.get(id)),
    create(provider, external, orderId, amount, providerTime, now) {
      insert.run(provider, external, orderId, amount, providerTime, now);
      return read(payment.get(provider, external));
    },
    pay(row, now) { pay.run(now, row.localId); return read(payment.get(row.provider, row.external)); },
    cancel(row, now, reason) {
      cancel.run(row.state === 2 ? -2 : -1, now, reason, row.localId);
      return read(payment.get(row.provider, row.external));
    },
    statement: (from, to) => statement.all('payme', from, to).map(read),
  };
}

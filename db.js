'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'mpesa.db'));

// Optimise for concurrent reads
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    sms_raw             TEXT,
    transaction_code    TEXT,
    direction           TEXT,
    amount              REAL,
    counterparty_name   TEXT,
    counterparty_number TEXT,
    transaction_date    TEXT,
    mpesa_balance       REAL,
    category            TEXT DEFAULT 'uncategorized',
    note                TEXT,
    is_pending          INTEGER DEFAULT 1,
    parse_failed        INTEGER DEFAULT 0,
    created_at          TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tx_date     ON transactions(transaction_date DESC);
  CREATE INDEX IF NOT EXISTS idx_tx_pending  ON transactions(is_pending);
  CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category);
`);

// ── helpers ──────────────────────────────────────────────────────────────────

function getDateBounds(period) {
  const now = new Date();
  let from = null, to = null;

  switch (period) {
    case 'this_month':
      from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
      break;
    case 'last_month':
      from = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
      to   = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10) + 'T23:59:59';
      break;
    case '3_months':
      from = new Date(now.getFullYear(), now.getMonth() - 3, 1).toISOString().slice(0, 10);
      break;
    // 'all' → no filter
  }
  return { from, to };
}

function buildDateWhere(from, to, prefix = '') {
  const clauses = [];
  const params = [];
  if (from) { clauses.push(`${prefix}transaction_date >= ?`); params.push(from); }
  if (to)   { clauses.push(`${prefix}transaction_date <= ?`); params.push(to); }
  return { clauses, params };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

const insertStmt = db.prepare(`
  INSERT INTO transactions
    (sms_raw, transaction_code, direction, amount, counterparty_name, counterparty_number,
     transaction_date, mpesa_balance, category, note, is_pending, parse_failed, created_at)
  VALUES
    (@sms_raw, @transaction_code, @direction, @amount, @counterparty_name, @counterparty_number,
     @transaction_date, @mpesa_balance, @category, @note, @is_pending, @parse_failed, @created_at)
`);

function insertTransaction(tx) {
  const result = insertStmt.run(tx);
  return getTransactionById(result.lastInsertRowid);
}

function getTransactionById(id) {
  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
}

function getTransactions(filters = {}) {
  const conditions = [];
  const params = [];

  if (filters.category)             { conditions.push('category = ?');        params.push(filters.category); }
  if (filters.direction)            { conditions.push('direction = ?');        params.push(filters.direction); }
  if (filters.from)                 { conditions.push('transaction_date >= ?'); params.push(filters.from); }
  if (filters.to)                   { conditions.push('transaction_date <= ?'); params.push(filters.to); }
  if (filters.pending !== undefined) {
    conditions.push('is_pending = ?');
    params.push(filters.pending ? 1 : 0);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const rows = db.prepare(
    `SELECT * FROM transactions ${where} ORDER BY transaction_date DESC, created_at DESC`
  ).all(...params);

  // Monthly totals from the same filtered set
  const totals = rows.reduce(
    (acc, tx) => {
      if (tx.parse_failed) return acc;
      if (tx.direction === 'in')  acc.in  += tx.amount || 0;
      if (tx.direction === 'out') acc.out += tx.amount || 0;
      return acc;
    },
    { in: 0, out: 0, net: 0 }
  );
  totals.net = totals.in - totals.out;

  return { transactions: rows, totals };
}

function updateTransaction(id, updates) {
  const allowed = ['category', 'note', 'is_pending'];
  const fields = Object.keys(updates).filter(k => allowed.includes(k));
  if (!fields.length) return getTransactionById(id);

  const setClause = fields.map(f => `${f} = ?`).join(', ');
  db.prepare(`UPDATE transactions SET ${setClause} WHERE id = ?`)
    .run(...fields.map(f => updates[f]), id);
  return getTransactionById(id);
}

// ── SUMMARY ──────────────────────────────────────────────────────────────────

function getSummary(period = 'this_month') {
  const { from, to } = getDateBounds(period);
  const { clauses, params } = buildDateWhere(from, to);
  const base = clauses.length ? 'AND ' + clauses.join(' AND ') : '';

  const totalIn  = db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM transactions WHERE direction='in'  AND parse_failed=0 ${base}`).get(...params).v;
  const totalOut = db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM transactions WHERE direction='out' AND parse_failed=0 ${base}`).get(...params).v;

  const byCategory = db.prepare(`
    SELECT category, direction, COALESCE(SUM(amount),0) AS total, COUNT(*) AS count
    FROM transactions WHERE parse_failed=0 ${base}
    GROUP BY category, direction ORDER BY total DESC
  `).all(...params);

  // Carry-forward: net of all transactions strictly before this period
  let carryForward = 0;
  if (from) {
    const prevIn  = db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM transactions WHERE direction='in'  AND parse_failed=0 AND transaction_date < ?`).get(from).v;
    const prevOut = db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM transactions WHERE direction='out' AND parse_failed=0 AND transaction_date < ?`).get(from).v;
    carryForward  = prevIn - prevOut;
  }

  return {
    period,
    carryForward,
    totalIn,
    totalOut,
    net: totalIn - totalOut,
    closingBalance: carryForward + totalIn - totalOut,
    byCategory,
  };
}

// ── ADVISOR SNAPSHOT ─────────────────────────────────────────────────────────

function buildAdvisorSnapshot(period = 'this_month') {
  const { from, to } = getDateBounds(period);
  const { clauses, params } = buildDateWhere(from, to);
  const base = clauses.length ? 'AND ' + clauses.join(' AND ') : '';

  const totalIn  = db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM transactions WHERE direction='in'  AND parse_failed=0 ${base}`).get(...params).v;
  const totalOut = db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM transactions WHERE direction='out' AND parse_failed=0 ${base}`).get(...params).v;

  const incomeByCategory = db.prepare(`
    SELECT category, SUM(amount) AS total, COUNT(*) AS count
    FROM transactions WHERE direction='in' AND parse_failed=0 ${base}
    GROUP BY category ORDER BY total DESC
  `).all(...params);

  const expenseByCategory = db.prepare(`
    SELECT category, SUM(amount) AS total, COUNT(*) AS count
    FROM transactions WHERE direction='out' AND parse_failed=0 ${base}
    GROUP BY category ORDER BY total DESC
  `).all(...params);

  const topSpend = db.prepare(`
    SELECT counterparty_name, SUM(amount) AS total, COUNT(*) AS txCount
    FROM transactions WHERE direction='out' AND parse_failed=0 AND counterparty_name IS NOT NULL ${base}
    GROUP BY counterparty_name ORDER BY total DESC LIMIT 5
  `).all(...params);

  const topIncome = db.prepare(`
    SELECT counterparty_name, SUM(amount) AS total, COUNT(*) AS txCount
    FROM transactions WHERE direction='in' AND parse_failed=0 AND counterparty_name IS NOT NULL ${base}
    GROUP BY counterparty_name ORDER BY total DESC LIMIT 5
  `).all(...params);

  const largestInflows = db.prepare(`
    SELECT counterparty_name, amount, transaction_date FROM transactions
    WHERE direction='in' AND parse_failed=0 ${base}
    ORDER BY amount DESC LIMIT 3
  `).all(...params);

  const largestOutflows = db.prepare(`
    SELECT counterparty_name, amount, transaction_date FROM transactions
    WHERE direction='out' AND parse_failed=0 ${base}
    ORDER BY amount DESC LIMIT 3
  `).all(...params);

  const recurring = db.prepare(`
    SELECT counterparty_name, SUM(amount) AS total, COUNT(*) AS txCount, AVG(amount) AS avgAmount
    FROM transactions WHERE direction='out' AND parse_failed=0 AND counterparty_name IS NOT NULL ${base}
    GROUP BY counterparty_name HAVING txCount >= 3
    ORDER BY total DESC
  `).all(...params);

  // Week-over-week spend (last 8 weeks)
  const weeklySpend = db.prepare(`
    SELECT strftime('%Y-W%W', transaction_date) AS week,
           SUM(CASE WHEN direction='out' THEN amount ELSE 0 END) AS outflow,
           SUM(CASE WHEN direction='in'  THEN amount ELSE 0 END) AS inflow
    FROM transactions WHERE parse_failed=0
    GROUP BY week ORDER BY week DESC LIMIT 8
  `).all();

  // Savings rate
  const savingsCategories = "('Emergency Fund','Investment','SACCO')";
  const savingsTotal = db.prepare(`
    SELECT COALESCE(SUM(amount),0) AS v FROM transactions
    WHERE category IN ${savingsCategories} AND parse_failed=0 ${base}
  `).get(...params).v;

  // Date range span for burn rate calc
  let days = 30;
  if (from) {
    const start = new Date(from);
    const end   = to ? new Date(to) : new Date();
    days = Math.max(1, Math.ceil((end - start) / 86400000));
  }

  const txCount = db.prepare(`SELECT COUNT(*) AS v FROM transactions WHERE parse_failed=0 ${base}`).get(...params).v;

  return {
    period,
    dateRange: { from: from || 'all time', to: to || 'now' },
    summary: {
      totalIn,
      totalOut,
      net: totalIn - totalOut,
      txCount,
      dailyBurnRate: days > 0 ? +(totalOut / days).toFixed(0) : 0,
      savingsRate: totalIn > 0 ? +((savingsTotal / totalIn) * 100).toFixed(1) : 0,
    },
    incomeByCategory,
    expenseByCategory,
    topSpend,
    topIncome,
    largestInflows,
    largestOutflows,
    recurring,
    weeklyTrend: weeklySpend.reverse(),
  };
}

module.exports = {
  db,
  insertTransaction,
  getTransactionById,
  getTransactions,
  updateTransaction,
  getSummary,
  buildAdvisorSnapshot,
};

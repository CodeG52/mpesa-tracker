'use strict';

require('dotenv').config();

const express  = require('express');
const path     = require('path');
const os       = require('os');

const { parseTransaction }                                            = require('./parser');
const { insertTransaction, getTransactionById, getTransactions, updateTransaction, getSummary } = require('./db');
const { streamAdvisor }                                               = require('./advisor');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API Secret guard ──────────────────────────────────────────────────────────

function requireSecret(req, res, next) {
  const secret = process.env.API_SECRET;
  if (!secret) {
    console.warn('[WARN] API_SECRET not set — endpoint is unprotected');
    return next();
  }
  if (req.headers['x-api-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  next();
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Setup page
app.get('/setup', (_req, res) =>
  res.sendFile(path.join(__dirname, 'setup', 'index.html'))
);

// Deep-link: open app with label panel pre-opened for a specific transaction
app.get('/label/:id', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// POST /api/sms  — iOS Shortcut pushes raw SMS here
app.post('/api/sms', requireSecret, (req, res) => {
  const { sms } = req.body || {};
  if (!sms || typeof sms !== 'string') {
    return res.status(400).json({ error: 'Missing "sms" field in request body' });
  }

  const parsed = parseTransaction(sms);
  const tx = insertTransaction(parsed);
  res.status(201).json(tx);
});

// GET /api/transactions
app.get('/api/transactions', (req, res) => {
  const { category, direction, from, to, pending } = req.query;

  const filters = {};
  if (category)  filters.category  = category;
  if (direction) filters.direction = direction;
  if (from)      filters.from      = from;
  if (to)        filters.to        = to;
  if (pending !== undefined) filters.pending = pending === 'true' || pending === '1';

  const result = getTransactions(filters);
  res.json(result);
});

// GET /api/transactions/:id
app.get('/api/transactions/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const tx = getTransactionById(id);
  if (!tx) return res.status(404).json({ error: 'Not found' });
  res.json(tx);
});

// PATCH /api/transactions/:id
app.patch('/api/transactions/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  const { category, note, is_pending } = req.body || {};
  const updates = {};
  if (category    !== undefined) updates.category   = category;
  if (note        !== undefined) updates.note        = note;
  if (is_pending  !== undefined) updates.is_pending  = is_pending ? 1 : 0;

  const tx = updateTransaction(id, updates);
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });
  res.json(tx);
});

// GET /api/summary
app.get('/api/summary', (req, res) => {
  const { period } = req.query;
  res.json(getSummary(period || 'this_month'));
});

// POST /api/advisor  — SSE streaming
app.post('/api/advisor', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const period = req.query.period || req.body?.period || 'this_month';
  streamAdvisor(period, res).catch(err => {
    console.error('[advisor error]', err);
    try {
      res.write(`data: ${JSON.stringify({ error: 'Internal server error' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (_) {}
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

function getLocalIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

app.listen(PORT, '0.0.0.0', () => {
  const ip     = getLocalIp();
  const appUrl = process.env.APP_URL || `http://${ip}:${PORT}`;

  console.log('');
  console.log('  ✓ mpesa-tracker running');
  console.log(`  ✓ Local:   http://localhost:${PORT}`);
  console.log(`  ✓ Network: http://${ip}:${PORT}`);
  console.log(`  ✓ Setup:   ${appUrl}/setup`);
  console.log('');
});

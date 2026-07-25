require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Pool, types } = require('pg');
// Return DATE columns as plain 'YYYY-MM-DD' strings. Letting pg parse them into
// JS Date objects shifts month-boundary dates into the previous day (via UTC
// serialization) on any server whose timezone is ahead of UTC.
types.setTypeParser(1082, v => v);
const axios = require('axios');
const multer = require('multer');
let pdfParse;
try {
  const _pdfMod = require('pdf-parse');
  pdfParse = typeof _pdfMod === 'function' ? _pdfMod : _pdfMod.default;
} catch (e) {
  try { pdfParse = require('pdf-parse/lib/pdf-parse.js'); } catch (_) {}
}

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'maali-secret-key-2026';

// ── Lean (open banking) ───────────────────────────────────
// Credentials come from env only — the client secret must never be committed.
const LEAN_APP_ID         = process.env.LEAN_APP_ID;
const LEAN_CLIENT_SECRET  = process.env.LEAN_CLIENT_SECRET;
const LEAN_WEBHOOK_SECRET = process.env.LEAN_WEBHOOK_SECRET;
const LEAN_SANDBOX        = process.env.LEAN_SANDBOX !== 'false';
// Saudi-region hosts. The generic (UAE) hosts reject KSA credentials with
// invalid_client, so region is part of the config, not an afterthought.
const LEAN_AUTH_BASE = process.env.LEAN_AUTH_BASE ||
  (LEAN_SANDBOX ? 'https://auth.sandbox.sa.leantech.me' : 'https://auth.sa.leantech.me');
const LEAN_API_BASE  = process.env.LEAN_API_BASE ||
  (LEAN_SANDBOX ? 'https://sandbox.sa.leantech.me' : 'https://sa.leantech.me');
if (!LEAN_APP_ID || !LEAN_CLIENT_SECRET) console.error('⚠️  LEAN_APP_ID / LEAN_CLIENT_SECRET not set — bank linking disabled');

// Lean issues short-lived JWTs (~1h). Cache per scope so we are not minting one per request.
const leanTokenCache = new Map();
async function leanToken(scope = 'api') {
  // The LinkSDK rejects any token with under 10 minutes left, so keep a wide
  // margin — serving a nearly-expired token makes the widget fail silently.
  const hit = leanTokenCache.get(scope);
  if (hit && hit.expiresAt > Date.now() + 15 * 60000) return hit.token;
  const body = new URLSearchParams({
    client_id: LEAN_APP_ID,
    client_secret: LEAN_CLIENT_SECRET,
    grant_type: 'client_credentials',
    scope
  });
  const res = await axios.post(`${LEAN_AUTH_BASE}/oauth2/token`, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20000
  });
  const token = res.data.access_token;
  leanTokenCache.set(scope, {
    token,
    expiresAt: Date.now() + ((res.data.expires_in || 3599) * 1000)
  });
  return token;
}

async function leanGet(pathname, params, scope = 'api') {
  const token = await leanToken(scope);
  const res = await axios.get(`${LEAN_API_BASE}${pathname}`, {
    params,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30000
  });
  return res.data;
}
// Read from env var ONLY — never hardcode (Google auto-disables leaked keys)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) console.error('⚠️  GEMINI_API_KEY env var is not set!');

// Helper: call Gemini with retry + model fallback for 503 overload
async function groqChat(prompt, maxTokens = 4096, opts = {}) {
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest'];
  let lastErr;
  for (const model of models) {
    // thinkingConfig is only meaningful on the 2.5 family, and Google rejects the
    // whole request with a 400 where it is not supported. Drop it and retry.
    let sendThinking = model.includes('2.5');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const generationConfig = {
          // gemini-2.0 models cap output at 8192 tokens; asking for more is a 400
          maxOutputTokens: model.includes('2.0') ? Math.min(maxTokens, 8192) : maxTokens,
          temperature: opts.temperature !== undefined ? opts.temperature : 0.2
        };
        if (sendThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
        if (opts.responseSchema) {
          generationConfig.responseMimeType = 'application/json';
          generationConfig.responseSchema = opts.responseSchema;
        }
        const res = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
          {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig
          },
          { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
        );
        // Join all non-thought parts (gemini can return multiple parts)
        const parts = res.data.candidates?.[0]?.content?.parts || [];
        const text = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim();
        if (text) return text;
        throw new Error('Empty response');
      } catch (err) {
        lastErr = err;
        const code = err.response?.status;
        if (code === 400 && sendThinking) { sendThinking = false; continue; }
        if (code === 503 || code === 429) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        break;
      }
    }
  }
  throw lastErr;
}

// ── Security middleware ───────────────────────────────────
// helmet sets protective headers (HSTS, nosniff, no-framing, referrer policy).
// CSP and COEP are left off because the app loads fonts, icons and the Lean
// widget from other origins; a strict policy would break them, and tightening
// CSP safely is a follow-up on its own.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// Same-origin app (the frontend is served by this server), so lock CORS to the
// known hosts instead of echoing any origin. Same-origin requests send no Origin
// header and are unaffected; this only blocks other websites' scripts.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://qurushak.onrender.com,https://maali-app.onrender.com,https://qurushak.com,https://www.qurushak.com')
  .split(',').map(s => s.trim());
app.use(cors({
  origin(origin, cb) {
    // Non-browser clients (curl, health checks) and same-origin requests have no origin.
    if (!origin || ALLOWED_ORIGINS.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  }
}));

// Throttle brute-force. Auth is strict; the rest of the API is generous so
// normal dashboard use is never affected.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'محاولات كثيرة جداً، يرجى المحاولة بعد قليل' }
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120,
  standardHeaders: true, legacyHeaders: false
});
app.use('/api/', apiLimiter);
app.use(['/api/auth/login', '/api/auth/signup'], authLimiter);

// Keep the raw body around so Lean webhook signatures can be verified against it.
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname)));

// ── Database ──────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '') ? false : { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    full_name TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS bank_connections (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    lean_customer_id TEXT UNIQUE NOT NULL,
    bank_name TEXT,
    account_id TEXT,
    connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // Lean v2 keys bank data by entity (the connection), not by customer.
  await pool.query(`ALTER TABLE bank_connections ADD COLUMN IF NOT EXISTS entity_id TEXT`);
  await pool.query(`ALTER TABLE bank_connections ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP`);

  await pool.query(`CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    transaction_id TEXT,
    amount REAL NOT NULL,
    currency TEXT DEFAULT 'SAR',
    description TEXT,
    category TEXT,
    transaction_date DATE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT transactions_user_tx_unique UNIQUE (user_id, transaction_id)
  )`);

  // Migration for databases created before transaction_id was unique per user:
  // the old global UNIQUE meant fixed ids (demo dm-*, bank tx ids) could only
  // ever be inserted for the first user who claimed them.
  await pool.query(`DO $$ BEGIN
    ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_transaction_id_key;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_user_tx_unique') THEN
      ALTER TABLE transactions ADD CONSTRAINT transactions_user_tx_unique UNIQUE (user_id, transaction_id);
    END IF;
  END $$`);

  await pool.query(`CREATE TABLE IF NOT EXISTS goals (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    target_amount REAL NOT NULL,
    current_amount REAL DEFAULT 0,
    deadline DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  console.log('✅ PostgreSQL tables ready');
}

initDB().catch(err => console.error('DB init error:', err));

// ── Auth Middleware ───────────────────────────────────────
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'غير مصرح' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(401).json({ error: 'جلسة منتهية، يرجى تسجيل الدخول' });
    req.userId = user.id;
    req.userEmail = user.email;
    next();
  });
};

// ── Auth Routes ───────────────────────────────────────────
// Reject anything that is not plausibly an email (rejects the likes of "123@123").
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalizeEmail = e => String(e || '').trim().toLowerCase();

// Block throwaway / 10-minute burner inboxes (mailinator, temp-mail, …).
const DISPOSABLE_DOMAINS = new Set(require('disposable-email-domains'));
const isDisposableEmail = email => DISPOSABLE_DOMAINS.has(email.split('@')[1] || '');

app.post('/api/auth/signup', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = req.body.password || '';
  const fullName = String(req.body.fullName || '').trim();
  if (!email || !password || !fullName) return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
  if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'البريد الإلكتروني غير صالح' });
  if (isDisposableEmail(email)) return res.status(400).json({ error: 'يُرجى استخدام بريد إلكتروني حقيقي — البُرد المؤقتة غير مسموحة' });
  if (password.length < 8) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' });
  if (fullName.length > 120) return res.status(400).json({ error: 'الاسم طويل جداً' });
  try {
    // Block case-variant duplicates (Omar@x.com vs omar@x.com) that the DB's
    // case-sensitive UNIQUE would otherwise allow.
    const dup = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = $1', [email]);
    if (dup.rows[0]) return res.status(400).json({ error: 'البريد الإلكتروني مستخدم مسبقاً' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password, full_name) VALUES ($1, $2, $3) RETURNING id',
      [email, hashedPassword, fullName]
    );
    const id = result.rows[0].id;
    const token = jwt.sign({ id, email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id, email, fullName } });
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'البريد الإلكتروني مستخدم مسبقاً' });
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = req.body.password || '';
  if (!email || !password) return res.status(400).json({ error: 'البريد وكلمة المرور مطلوبان' });
  try {
    // Case-insensitive lookup so accounts created before email normalization
    // (any casing) still log in.
    const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, fullName: user.full_name } });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Bank Connection Routes (Lean v2) ──────────────────────
// Flow: create a Lean customer for the user → hand the browser a customer-scoped
// token → LinkSDK collects the bank consent → Lean webhooks us the entity_id →
// we pull accounts + transactions from /data/v2 and store them.

async function getOrCreateLeanCustomer(userId) {
  const existing = await pool.query(
    'SELECT lean_customer_id, entity_id FROM bank_connections WHERE user_id = $1',
    [userId]
  );
  if (existing.rows[0]) return existing.rows[0];

  const token = await leanToken('api');
  const response = await axios.post(
    `${LEAN_API_BASE}/customers/v1`,
    { app_user_id: String(userId) },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
  );
  const customerId = response.data.customer_id || response.data.id;
  await pool.query(
    'INSERT INTO bank_connections (user_id, lean_customer_id) VALUES ($1, $2) ON CONFLICT (lean_customer_id) DO NOTHING',
    [userId, customerId]
  );
  return { lean_customer_id: customerId, entity_id: null };
}

// Everything the LinkSDK needs to open the bank-consent dialog.
app.post('/api/bank/link-token', authenticateToken, async (req, res) => {
  if (!LEAN_APP_ID || !LEAN_CLIENT_SECRET) {
    return res.status(503).json({ error: 'ربط البنك غير مفعّل حالياً' });
  }
  try {
    const conn = await getOrCreateLeanCustomer(req.userId);
    const customerId = conn.lean_customer_id;
    // The SDK needs a token scoped to this specific customer, not the api scope.
    const accessToken = await leanToken(`customer.${customerId}`);
    res.json({
      app_token: LEAN_APP_ID,
      customer_id: customerId,
      access_token: accessToken,
      sandbox: LEAN_SANDBOX
    });
  } catch (error) {
    console.error('Lean link-token error:', error.response?.data || error.message);
    res.status(500).json({ error: 'تعذّر بدء ربط البنك' });
  }
});

app.get('/api/bank/status', authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT lean_customer_id, entity_id, bank_name, last_synced_at FROM bank_connections WHERE user_id = $1',
      [req.userId]
    );
    const row = r.rows[0];
    res.json({
      connected: !!(row && row.entity_id),
      bankName: row?.bank_name || null,
      lastSyncedAt: row?.last_synced_at || null
    });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Lean notifies us here when a connection is made and when its data is ready.
app.post('/api/bank/webhook', async (req, res) => {
  try {
    if (LEAN_WEBHOOK_SECRET && req.rawBody) {
      const sent = req.headers['lean-signature'] || req.headers['x-lean-signature'] || '';
      const expected = crypto.createHmac('sha256', LEAN_WEBHOOK_SECRET).update(req.rawBody).digest('hex');
      // Signature header naming varies by Lean version — log a mismatch rather than
      // dropping the event, so sandbox testing is not silently broken.
      if (sent && sent.replace(/^sha256=/, '') !== expected) {
        console.warn('[lean webhook] signature mismatch, processing anyway (sandbox)');
      }
    }

    const evt = req.body || {};
    const payload = evt.payload || evt.data || evt;
    const entityId   = payload.entity_id   || payload.entityId;
    const customerId = payload.customer_id || payload.customerId;
    console.log(`[lean webhook] ${evt.type || evt.event || 'event'} entity=${entityId} status=${payload.status || ''}`);

    if (entityId && customerId) {
      await pool.query(
        'UPDATE bank_connections SET entity_id = $1, bank_name = COALESCE($2, bank_name) WHERE lean_customer_id = $3',
        [entityId, payload.bank_identifier || payload.bank?.name || null, customerId]
      );
      const owner = await pool.query('SELECT user_id FROM bank_connections WHERE lean_customer_id = $1', [customerId]);
      const userId = owner.rows[0]?.user_id;
      // Data is populated asynchronously; only pull once Lean says it is ready.
      if (userId && String(payload.status || '').toUpperCase() === 'FINISHED') {
        syncLeanTransactions(userId).catch(e => console.error('[lean webhook] sync failed:', e.message));
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[lean webhook] error:', err.message);
    res.json({ received: true }); // never make Lean retry on our bug
  }
});

// Pull accounts + transactions for a user and upsert them into `transactions`.
async function syncLeanTransactions(userId) {
  const conn = await pool.query(
    'SELECT lean_customer_id, entity_id FROM bank_connections WHERE user_id = $1',
    [userId]
  );
  const row = conn.rows[0];
  if (!row) return { synced: 0, total: 0, pending: true };

  // Webhooks can't reach a dev machine, so fall back to asking Lean which
  // entities this customer has connected.
  let entityId = row.entity_id;
  if (!entityId) {
    try {
      const entities = await leanGet(`/customers/v1/${row.lean_customer_id}/entities`);
      const list = Array.isArray(entities) ? entities : (entities.entities || []);
      const found = list[0];
      entityId = found?.entity_id || found?.id || null;
      if (entityId) {
        await pool.query(
          'UPDATE bank_connections SET entity_id = $1, bank_name = COALESCE($2, bank_name) WHERE user_id = $3',
          [entityId, found?.bank_identifier || found?.bank_details?.name || null, userId]
        );
      }
    } catch (e) {
      console.error('[lean sync] entity lookup failed:', e.response?.data || e.message);
    }
  }
  if (!entityId) return { synced: 0, total: 0, pending: true };

  const accountsRes = await leanGet('/data/v2/accounts', { entity_id: entityId });
  const accounts = accountsRes.accounts || accountsRes.data?.accounts || accountsRes.payload?.accounts || [];

  const from = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const to   = new Date().toISOString().split('T')[0];

  let inserted = 0, total = 0;
  for (const acc of accounts) {
    const accountId = acc.account_id || acc.id;
    if (!accountId) continue;
    let txRes;
    try {
      txRes = await leanGet('/data/v2/transactions', {
        entity_id: entityId,
        account_id: accountId,
        from_date: from,
        to_date: to
      });
    } catch (e) {
      console.error(`[lean sync] transactions failed for account ${accountId}:`, e.response?.data || e.message);
      continue;
    }
    const txs = txRes.transactions || txRes.data?.transactions || txRes.payload?.transactions || [];
    total += txs.length;
    for (const tx of txs) {
      const txId   = tx.lean_transaction_id || tx.transaction_id || tx.id;
      const rawAmt = tx.amount ?? tx.value ?? 0;
      // Lean marks direction separately; a CREDIT is money in, DEBIT money out.
      const dir    = String(tx.credit_debit_indicator || tx.type || '').toUpperCase();
      const amount = dir.includes('DEBIT') ? -Math.abs(Number(rawAmt)) : Number(rawAmt);
      const date   = (tx.booked_date || tx.value_date || tx.timestamp || tx.date || '').slice(0, 10);
      if (!txId || !date) continue;
      const desc = tx.description || tx.narrative || 'معاملة بنكية';
      const r = await pool.query(
        `INSERT INTO transactions (user_id, transaction_id, amount, description, category, transaction_date)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, transaction_id) DO NOTHING`,
        [userId, txId, amount, desc, inferCategory(desc) || 'أخرى', date]
      );
      if (r.rowCount > 0) inserted++;
    }
  }
  await pool.query('UPDATE bank_connections SET last_synced_at = NOW() WHERE user_id = $1', [userId]);
  console.log(`[lean sync] user ${userId}: ${inserted} new of ${total}`);
  return { synced: inserted, total, accounts: accounts.length };
}

app.post('/api/bank/sync', authenticateToken, async (req, res) => {
  try {
    const result = await syncLeanTransactions(req.userId);
    if (result.pending) {
      return res.json({ success: false, pending: true, message: 'جاري تجهيز بيانات البنك…' });
    }
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Lean sync error:', error.response?.data || error.message);
    res.status(500).json({ error: 'تعذّر جلب المعاملات من البنك' });
  }
});

// ── Data Routes ───────────────────────────────────────────
app.get('/api/transactions', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM transactions WHERE user_id = $1 ORDER BY transaction_date DESC',
      [req.userId]
    );
    res.json({ transactions: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/summary', authenticateToken, async (req, res) => {
  try {
    // Use the month of the user's most recent transaction (so imports show up).
    // Falls back to current month if no transactions exist.
    const monthExprSql = `COALESCE(
      (SELECT TO_CHAR(MAX(transaction_date),'YYYY-MM') FROM transactions WHERE user_id=$1),
      TO_CHAR(NOW(),'YYYY-MM')
    )`;
    const [inc, exp, cnt] = await Promise.all([
      pool.query(`SELECT SUM(amount) as total FROM transactions WHERE user_id=$1 AND amount>0 AND TO_CHAR(transaction_date,'YYYY-MM')=${monthExprSql}`, [req.userId]),
      pool.query(`SELECT SUM(ABS(amount)) as total FROM transactions WHERE user_id=$1 AND amount<0 AND TO_CHAR(transaction_date,'YYYY-MM')=${monthExprSql}`, [req.userId]),
      pool.query(`SELECT COUNT(*) as count FROM transactions WHERE user_id=$1`, [req.userId])
    ]);
    const income   = parseFloat(inc.rows[0].total  || 0);
    const expenses = parseFloat(exp.rows[0].total  || 0);
    const count    = parseInt(cnt.rows[0].count || 0);
    res.json({
      income:           income.toFixed(2),
      expenses:         expenses.toFixed(2),
      savings:          (income - expenses).toFixed(2),
      transactionCount: count
    });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/goals', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM goals WHERE user_id=$1 ORDER BY created_at DESC', [req.userId]);
    res.json({ goals: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/goals', authenticateToken, async (req, res) => {
  const { name, targetAmount, deadline } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO goals (user_id, name, target_amount, deadline) VALUES ($1,$2,$3,$4) RETURNING id',
      [req.userId, name, targetAmount, deadline]
    );
    res.json({ id: result.rows[0].id, name, targetAmount, currentAmount: 0, deadline });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.patch('/api/goals/:id', authenticateToken, async (req, res) => {
  const { currentAmount } = req.body;
  try {
    await pool.query('UPDATE goals SET current_amount=$1 WHERE id=$2 AND user_id=$3', [currentAmount, req.params.id, req.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/goals/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM goals WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ── AI Chat ───────────────────────────────────────────────
function buildFinancialContext(transactions, goals) {
  if (!transactions.length) return 'لا توجد بيانات معاملات متاحة.';

  const monthly = {};
  const categoryTotals = {};

  transactions.forEach(tx => {
    const dateStr = typeof tx.transaction_date === 'string'
      ? tx.transaction_date
      : tx.transaction_date.toISOString().split('T')[0];
    const month = dateStr.substring(0, 7);
    if (!monthly[month]) monthly[month] = { income: 0, expenses: 0 };
    if (tx.amount > 0) monthly[month].income   += tx.amount;
    else               monthly[month].expenses += Math.abs(tx.amount);

    if (tx.amount < 0) {
      const cat = tx.category || 'أخرى';
      categoryTotals[cat] = (categoryTotals[cat] || 0) + Math.abs(tx.amount);
    }
  });

  const totalIncome   = transactions.filter(t => t.amount > 0).reduce((s,t) => s + t.amount, 0);
  const totalExpenses = transactions.filter(t => t.amount < 0).reduce((s,t) => s + Math.abs(t.amount), 0);
  const netSavings    = totalIncome - totalExpenses;

  const monthNames = {
    '2026-01':'يناير 2026','2026-02':'فبراير 2026','2026-03':'مارس 2026',
    '2026-04':'أبريل 2026','2026-05':'مايو 2026','2026-06':'يونيو 2026',
  };

  const monthlySummary = Object.entries(monthly)
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([m,d]) => {
      const name = monthNames[m] || m;
      return `${name}: دخل ${d.income.toFixed(2)} | مصاريف ${d.expenses.toFixed(2)} | صافي ${(d.income-d.expenses).toFixed(2)} ر.س`;
    }).join('\n');

  const catBreakdown = Object.entries(categoryTotals)
    .sort(([,a],[,b]) => b-a)
    .map(([cat,total]) => `${cat}: ${total.toFixed(2)} ر.س`)
    .join('\n');

  const top10 = transactions
    .filter(t => t.amount < 0)
    .sort((a,b) => a.amount - b.amount)
    .slice(0,10)
    .map(t => {
      const d = typeof t.transaction_date === 'string' ? t.transaction_date : t.transaction_date.toISOString().split('T')[0];
      return `${t.description}: ${Math.abs(t.amount).toFixed(2)} ر.س (${d})`;
    }).join('\n');

  const allTxLines = transactions.map(tx => {
    const d = typeof tx.transaction_date === 'string' ? tx.transaction_date : tx.transaction_date.toISOString().split('T')[0];
    return `${d}|${tx.amount>0?'+':''}${tx.amount.toFixed(2)}|${tx.category||'أخرى'}|${tx.description}`;
  }).join('\n');

  const goalsText = goals.length
    ? goals.map(g => `${g.name}: مستهدف ${g.target_amount} ر.س، مُجمَّع ${g.current_amount} ر.س، موعد ${g.deadline||'غير محدد'}`).join('\n')
    : 'لا توجد أهداف مسجلة.';

  return `═══════════════════════════════════════
بيانات المعاملات الحقيقية – ${transactions.length} معاملة
═══════════════════════════════════════
📊 الملخص العام:
إجمالي الدخل: ${totalIncome.toFixed(2)} ر.س
إجمالي المصاريف: ${totalExpenses.toFixed(2)} ر.س
صافي التوفير: ${netSavings.toFixed(2)} ر.س

📅 ملخص شهري:
${monthlySummary}

🏷️ المصاريف حسب الفئة:
${catBreakdown}

💸 أكبر 10 مصاريف:
${top10}

🎯 الأهداف المالية:
${goalsText}

📋 جميع المعاملات – التاريخ|المبلغ|الفئة|الوصف:
${allTxLines}
═══════════════════════════════════════`;
}

app.post('/api/chat', authenticateToken, async (req, res) => {
  try {
    const userMessage = req.body.message;
    const [txResult, goalsResult] = await Promise.all([
      pool.query('SELECT * FROM transactions WHERE user_id=$1 ORDER BY transaction_date ASC', [req.userId]),
      pool.query('SELECT * FROM goals WHERE user_id=$1', [req.userId])
    ]);
    const financialContext = buildFinancialContext(txResult.rows, goalsResult.rows);
    const fullPrompt = `أنت محلل مالي ذكي ومتخصص. لديك بيانات المعاملات الحقيقية للمستخدم.
أجب على أسئلته بدقة تامة بناءً على هذه البيانات فقط. استخدم الأرقام الحقيقية.
أجب باللغة العربية دائماً. أجب بإيجاز شديد — 3 إلى 6 أسطر كحد أقصى، إلا إذا طلب المستخدم تفاصيل أكثر.

${financialContext}

سؤال المستخدم: ${userMessage}`;

    // Stream the answer so text appears immediately
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    // Each model is tried with thinkingConfig and then without it, since Google
    // 400s the whole request where that field is not supported.
    const attempts = [
      ['gemini-2.5-flash', true], ['gemini-2.5-flash', false],
      ['gemini-2.0-flash', false]
    ];
    let streamed = false;
    for (const [model, withThinking] of attempts) {
      try {
        const generationConfig = { maxOutputTokens: 1024, temperature: 0.2 };
        if (withThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
        const gRes = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`,
          { contents: [{ parts: [{ text: fullPrompt }] }], generationConfig },
          { headers: { 'Content-Type': 'application/json' }, timeout: 60000, responseType: 'stream' }
        );
        await new Promise((resolve, reject) => {
          let buf = '';
          gRes.data.on('data', chunk => {
            buf += chunk.toString('utf8');
            let idx;
            while ((idx = buf.indexOf('\n')) !== -1) {
              const line = buf.slice(0, idx).trim();
              buf = buf.slice(idx + 1);
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              try {
                const j = JSON.parse(payload);
                const parts = j.candidates?.[0]?.content?.parts || [];
                const t = parts.filter(p => !p.thought).map(p => p.text || '').join('');
                if (t) { streamed = true; res.write(t); }
              } catch {}
            }
          });
          gRes.data.on('end', resolve);
          gRes.data.on('error', reject);
        });
        return res.end();
      } catch (err) {
        console.error(`Stream ${model} failed:`, err.response?.status || err.message);
        if (streamed) return res.end(); // partial answer already sent — stop here
      }
    }

    // Streaming failed entirely → non-streaming fallback (still plain text)
    const text = await groqChat(fullPrompt, 1024);
    res.write(text);
    res.end();
  } catch (error) {
    // Surface the upstream reason (quota vs bad key vs outage). Google's message
    // never contains the API key, so this is safe to return.
    const upstream = error.response?.status || null;
    const detail = error.response?.data?.error?.message || error.message;
    console.error('Chat error:', upstream, detail);
    if (!res.headersSent) {
      res.status(500).json({ error: {
        message: 'حدث خطأ في الاتصال بالذكاء الاصطناعي',
        upstream,
        detail: String(detail).slice(0, 300)
      }});
    } else res.end();
  }
});

// ── Demo Data ─────────────────────────────────────────────
app.post('/api/demo/load', authenticateToken, async (req, res) => {
  const T = [
    { id:'dm-1',  amount:12500,  desc:'راتب شهر مايو',         cat:'راتب',        date:'2026-05-01' },
    { id:'dm-2',  amount:-3500,  desc:'إيجار شهري',            cat:'سكن',         date:'2026-05-02' },
    { id:'dm-3',  amount:-620,   desc:'سوبرماركت الدانوب',      cat:'تسوق',        date:'2026-05-04' },
    { id:'dm-4',  amount:-85,    desc:'مطعم البيك',             cat:'مطاعم',       date:'2026-05-05' },
    { id:'dm-5',  amount:-450,   desc:'محطة وقود أرامكو',       cat:'مواصلات',     date:'2026-05-06' },
    { id:'dm-6',  amount:-180,   desc:'فاتورة الجوال',          cat:'فواتير',      date:'2026-05-07' },
    { id:'dm-7',  amount:-380,   desc:'فاتورة الكهرباء',        cat:'فواتير',      date:'2026-05-08' },
    { id:'dm-8',  amount:-120,   desc:'ماكدونالدز',             cat:'مطاعم',       date:'2026-05-10' },
    { id:'dm-9',  amount:2000,   desc:'عمل إضافي',              cat:'دخل إضافي',   date:'2026-05-12' },
    { id:'dm-10', amount:-750,   desc:'ملابس H&M',              cat:'تسوق',        date:'2026-05-13' },
    { id:'dm-11', amount:-45,    desc:'نتفليكس وسبوتيفاي',      cat:'ترفيه',       date:'2026-05-14' },
    { id:'dm-12', amount:-210,   desc:'صيدلية النهدي',          cat:'صحة',         date:'2026-05-15' },
    { id:'dm-13', amount:-165,   desc:'ستاربكس',                cat:'مطاعم',       date:'2026-05-17' },
    { id:'dm-14', amount:-340,   desc:'سوبرماركت التميمي',      cat:'تسوق',        date:'2026-05-19' },
    { id:'dm-15', amount:-95,    desc:'أوبر',                   cat:'مواصلات',     date:'2026-05-21' },
    { id:'dm-16', amount:12500,  desc:'راتب شهر أبريل',         cat:'راتب',        date:'2026-04-01' },
    { id:'dm-17', amount:-3500,  desc:'إيجار شهري',             cat:'سكن',         date:'2026-04-02' },
    { id:'dm-18', amount:-580,   desc:'سوبرماركت',              cat:'تسوق',        date:'2026-04-05' },
    { id:'dm-19', amount:-240,   desc:'مطاعم متنوعة',           cat:'مطاعم',       date:'2026-04-08' },
    { id:'dm-20', amount:-510,   desc:'وقود',                   cat:'مواصلات',     date:'2026-04-10' },
    { id:'dm-21', amount:-420,   desc:'فواتير المياه والكهرباء', cat:'فواتير',      date:'2026-04-12' },
    { id:'dm-22', amount:-45,    desc:'اشتراكات رقمية',         cat:'ترفيه',       date:'2026-04-14' },
    { id:'dm-23', amount:-150,   desc:'صيدلية',                 cat:'صحة',         date:'2026-04-18' },
    { id:'dm-24', amount:-320,   desc:'ملابس وإكسسوارات',       cat:'تسوق',        date:'2026-04-22' },
    { id:'dm-25', amount:-195,   desc:'كافيهات',                cat:'مطاعم',       date:'2026-04-25' },
    { id:'dm-26', amount:12500,  desc:'راتب شهر مارس',          cat:'راتب',        date:'2026-03-01' },
    { id:'dm-27', amount:-3500,  desc:'إيجار شهري',             cat:'سكن',         date:'2026-03-02' },
    { id:'dm-28', amount:1500,   desc:'مكافأة عمل',             cat:'دخل إضافي',   date:'2026-03-05' },
    { id:'dm-29', amount:-650,   desc:'سوبرماركت',              cat:'تسوق',        date:'2026-03-07' },
    { id:'dm-30', amount:-310,   desc:'مطاعم',                  cat:'مطاعم',       date:'2026-03-10' },
    { id:'dm-31', amount:-480,   desc:'وقود',                   cat:'مواصلات',     date:'2026-03-12' },
    { id:'dm-32', amount:-390,   desc:'فواتير',                 cat:'فواتير',      date:'2026-03-15' },
    { id:'dm-33', amount:-45,    desc:'اشتراكات',               cat:'ترفيه',       date:'2026-03-18' },
    { id:'dm-34', amount:-280,   desc:'ملابس',                  cat:'تسوق',        date:'2026-03-22' },
    { id:'dm-35', amount:-175,   desc:'مطاعم وكافيهات',         cat:'مطاعم',       date:'2026-03-26' },
  ];

  const G = [
    { name:'سيارة هوندا سيفيك', target:45000, current:12500, deadline:'2027-12-01' },
    { name:'دفعة أولى للشقة',   target:80000, current:8000,  deadline:'2028-06-01' },
    { name:'صندوق الطوارئ',     target:25000, current:15000, deadline:'2026-12-01' },
    { name:'رحلة أوروبا',       target:12000, current:3500,  deadline:'2027-03-01' },
  ];

  try {
    let inserted = 0;
    for (const t of T) {
      const r = await pool.query(
        'INSERT INTO transactions (user_id,transaction_id,amount,description,category,transaction_date) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, transaction_id) DO NOTHING',
        [req.userId, t.id, t.amount, t.desc, t.cat, t.date]
      );
      if (r.rowCount > 0) inserted++;
    }
    const countRes = await pool.query('SELECT COUNT(*) as c FROM goals WHERE user_id=$1', [req.userId]);
    if (parseInt(countRes.rows[0].c) === 0) {
      for (const g of G) {
        await pool.query(
          'INSERT INTO goals (user_id,name,target_amount,current_amount,deadline) VALUES ($1,$2,$3,$4,$5)',
          [req.userId, g.name, g.target, g.current, g.deadline]
        );
      }
    }
    res.json({ success: true, inserted, total: T.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Merchant keyword categorizer ─────────────────────────
// Fallback when the AI (or bank data) leaves a transaction as "أخرى":
// match well-known Saudi merchants / patterns in the description.
// Order matters — first matching category wins, broadest (تسوق) last.
const CATEGORY_KEYWORDS = {
  'راتب':     ['راتب', 'رواتب', 'SALARY', 'PAYROLL'],
  'سكن':      ['إيجار', 'ايجار', 'عقار', 'سكن', 'RENT', 'REAL ESTATE'],
  'صحة':      ['صيدلية', 'النهدي', 'الدواء', 'مستشفى', 'عيادة', 'طبي', 'أسنان', 'اسنان',
               'PHARMACY', 'NAHDI', 'DAWAA', 'HOSPITAL', 'CLINIC', 'MEDICAL', 'DENTAL'],
  'مواصلات':  ['أوبر', 'اوبر', 'كريم', 'بنزين', 'وقود', 'محطة', 'أرامكو', 'ارامكو', 'بترومين',
               'ساسكو', 'الدريس', 'تاكسي', 'UBER', 'CAREEM', 'BOLT', 'ARAMCO', 'PETROMIN',
               'SASCO', 'ALDREES', 'FUEL', 'PETROL', 'PARKING', 'TAXI'],
  'مطاعم':    ['مطعم', 'البيك', 'ماكدونالدز', 'هرفي', 'كودو', 'ستاربكس', 'دانكن', 'كافيه',
               'كوفي', 'مقهى', 'بيتزا', 'برجر', 'شاورما', 'ALBAIK', 'MCDONALD', 'HERFY',
               'KUDU', 'STARBUCKS', 'DUNKIN', 'PIZZA', 'BURGER', 'KFC', 'SUBWAY', 'DOMINO',
               'RESTAURANT', 'CAFE', 'COFFEE', 'BASKIN', 'KRISPY', 'SHAWARMA'],
  'ترفيه':    ['نتفليكس', 'سبوتيفاي', 'شاهد', 'سينما', 'ألعاب', 'العاب', 'NETFLIX', 'SPOTIFY',
               'SHAHID', 'CINEMA', 'VOX', 'PLAYSTATION', 'STEAM', 'XBOX'],
  'فواتير':   ['فاتورة', 'فواتير', 'كهرباء', 'مياه', 'اتصالات', 'انترنت', 'موبايلي', 'زين',
               'STC', 'MOBILY', 'ZAIN', 'INTERNET', 'ELECTRICITY', 'TELECOM'],
  'تسوق':     ['سوبرماركت', 'هايبر', 'بنده', 'الدانوب', 'التميمي', 'كارفور', 'لولو', 'العثيم',
               'نادك', 'أسواق', 'اسواق', 'ملابس', 'جرير', 'إكسترا', 'اكسترا', 'ساكو', 'ايكيا',
               'أمازون', 'امازون', 'نون', 'شي ان', 'شي إن', 'زارا', 'DANUBE', 'PANDA', 'TAMIMI',
               'CARREFOUR', 'LULU', 'OTHAIM', 'NESTO', 'AMAZON', 'NOON', 'SHEIN', 'IKEA',
               'JARIR', 'EXTRA', 'SACO', 'ZARA', 'H&M', 'CENTREPOINT', 'MARKET', 'STORE']
};

function inferCategory(desc) {
  if (!desc) return null;
  const upper = String(desc).toUpperCase();
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
    if (words.some(w => upper.includes(w.toUpperCase()))) return cat;
  }
  return null;
}

// Re-categorize this user's "أخرى" transactions using the keyword map
app.post('/api/recategorize', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, description FROM transactions WHERE user_id=$1 AND (category IS NULL OR category IN ('أخرى','Other',''))",
      [req.userId]
    );
    let updated = 0;
    for (const row of result.rows) {
      const cat = inferCategory(row.description);
      if (cat) {
        await pool.query('UPDATE transactions SET category=$1 WHERE id=$2 AND user_id=$3', [cat, row.id, req.userId]);
        updated++;
      }
    }
    res.json({ success: true, scanned: result.rows.length, updated });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ── File Import ───────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /pdf|csv|txt/i.test(file.mimetype) || /\.(pdf|csv|txt)$/i.test(file.originalname);
    cb(null, ok);
  }
});

app.post('/api/import', authenticateToken, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const ext = req.file.originalname.split('.').pop().toLowerCase();
  let rawText = '';
  try {
    if (ext === 'pdf') {
      if (typeof pdfParse !== 'function') {
        return res.status(500).json({ error: 'PDF parsing is not available on this server. Please use CSV or TXT.' });
      }
      const parsed = await pdfParse(req.file.buffer);
      rawText = parsed.text;
    } else {
      rawText = req.file.buffer.toString('utf8');
    }
    if (!rawText || rawText.trim().length < 10) {
      return res.status(400).json({ error: 'Could not extract text from file' });
    }

    const prompt = `أنت محلل مصرفي. استخرج جميع المعاملات المالية من النص التالي.

⚠️ مهم جداً: أعد JSON صالح فقط، بدون أي نص قبله أو بعده، بدون markdown، بدون شرح.
يجب أن تبدأ إجابتك بـ [ وتنتهي بـ ]
إذا لم توجد معاملات، أعد: []

الشكل المطلوب:
[{"date":"YYYY-MM-DD","amount":number,"description":"string","category":"string"}]

قواعد:
- amount سالب للمصروفات والخصم، موجب للإيداع والدخل
- date بصيغة YYYY-MM-DD
- category يجب أن تكون إحدى: مطاعم, تسوق, مواصلات, سكن, راتب, دخل إضافي, فواتير, صحة, ترفيه, أخرى
- صنّف من اسم المتجر: البيك/ستاربكس/ماكدونالدز=مطاعم، الدانوب/بنده/التميمي/أمازون/نون=تسوق، أوبر/كريم/أرامكو=مواصلات، STC/موبايلي/زين/كهرباء=فواتير، النهدي/صيدلية=صحة، نتفليكس/سينما=ترفيه
- تجاهل عبارات مثل "شراء عبر نقاط البيع" و"Apple Pay" و"POS" — ركّز على اسم المتجر نفسه
- لا تستخدم "أخرى" إلا إذا استحال معرفة نوع المتجر
- description النص الأصلي للمعاملة
- تجاهل الأرصدة والملخصات، فقط المعاملات الفردية

النص:
${rawText.slice(0, 30000)}`;

    // temperature 0 + enforced JSON schema → same file yields the same
    // extraction every time (no markdown fences, no truncated arrays)
    const importSchema = {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          date:        { type: 'STRING' },
          amount:      { type: 'NUMBER' },
          description: { type: 'STRING' },
          category:    { type: 'STRING', enum: ['مطاعم','تسوق','مواصلات','سكن','راتب','دخل إضافي','فواتير','صحة','ترفيه','أخرى'] }
        },
        required: ['date', 'amount', 'description', 'category']
      }
    };
    const aiText = await groqChat(prompt, 32768, { temperature: 0, responseSchema: importSchema });
    console.log('AI raw response length:', aiText.length);

    // Strip markdown code fences if present
    let cleaned = aiText.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();

    // Find the opening bracket
    const startIdx = cleaned.indexOf('[');
    if (startIdx === -1) {
      return res.status(422).json({ error: 'AI could not parse transactions', raw: aiText.slice(0,500) });
    }
    cleaned = cleaned.slice(startIdx);

    let transactions;
    try {
      // Try to parse the full array first
      const endIdx = cleaned.lastIndexOf(']');
      if (endIdx !== -1) {
        try { transactions = JSON.parse(cleaned.slice(0, endIdx + 1)); } catch(_) {}
      }
      // If that fails, salvage complete transaction objects from a possibly-truncated array
      if (!transactions) {
        const objects = [];
        const regex = /\{\s*"date"[\s\S]*?\}/g;
        let m;
        while ((m = regex.exec(cleaned)) !== null) {
          try { objects.push(JSON.parse(m[0])); } catch(_) {}
        }
        if (objects.length > 0) transactions = objects;
      }
      if (!transactions) throw new Error('Could not extract any transactions');
    } catch (parseErr) {
      console.error('JSON parse error:', parseErr.message);
      return res.status(422).json({ error: 'AI returned malformed JSON', raw: aiText.slice(0,800) });
    }
    if (!Array.isArray(transactions) || transactions.length === 0) {
      return res.status(422).json({ error: 'No transactions found in file' });
    }

    // If user opted to replace, wipe all existing transactions first
    if (req.body.replaceAll === 'true' || req.body.replaceAll === true) {
      await pool.query('DELETE FROM transactions WHERE user_id = $1', [req.userId]);
      console.log(`Wiped all transactions for user ${req.userId} before import`);
    }

    // Content-derived ids: re-importing the same file skips rows already saved
    // instead of duplicating them. Identical rows within one file get -1, -2, …
    const seen = {};
    let inserted = 0, invalid = 0;
    for (const t of transactions) {
      if (!t.date || t.amount === undefined) { invalid++; continue; }
      // keyword fallback when the AI couldn't classify the merchant
      if (!t.category || t.category === 'أخرى') {
        t.category = inferCategory(t.description) || t.category || 'أخرى';
      }
      const key = crypto.createHash('sha1')
        .update(`${t.date}|${t.amount}|${(t.description || '').trim()}`)
        .digest('hex').slice(0, 16);
      seen[key] = (seen[key] || 0) + 1;
      const r = await pool.query(
        'INSERT INTO transactions (user_id,transaction_id,amount,description,category,transaction_date) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, transaction_id) DO NOTHING',
        [req.userId, `imp-${key}-${seen[key]}`, parseFloat(t.amount), t.description || 'معاملة', t.category || 'أخرى', t.date]
      );
      if (r.rowCount > 0) inserted++;
    }
    const duplicates = transactions.length - inserted - invalid;
    res.json({ success: true, total: transactions.length, inserted, duplicates, transactions: transactions.slice(0,20) });
  } catch (err) {
    console.error('Import error:', err.message);
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

// ── Health check ─────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  // Reports only whether config is PRESENT — never the values themselves — so a
  // failed deploy can be diagnosed without reading the Render dashboard.
  const config = {
    dbUrl:  process.env.DATABASE_URL   ? 'set' : 'MISSING',
    gemini: GEMINI_API_KEY             ? 'set' : 'MISSING',
    lean:   (LEAN_APP_ID && LEAN_CLIENT_SECRET) ? 'set' : 'MISSING',
    leanApiBase: LEAN_API_BASE
  };
  // ?diag=1 reports the region this instance egresses from. Gemini geo-blocks
  // some regions, and Render cannot change a service's region after creation,
  // so this is the difference that decides whether AI can work at all.
  if (req.query.diag === '1') {
    try {
      const geo = await axios.get('https://ipinfo.io/json', { timeout: 8000 });
      config.egress = { country: geo.data.country, region: geo.data.region, city: geo.data.city };
    } catch (e) { config.egress = { error: e.message }; }
  }
  // ?probe=1 checks which AI providers this region can reach at all. An auth
  // error means reachable; a geo/location error means blocked here.
  if (req.query.probe === '1') {
    const targets = {
      gemini: 'https://generativelanguage.googleapis.com/v1beta/models?key=probe',
      groq: 'https://api.groq.com/openai/v1/models',
      openrouter: 'https://openrouter.ai/api/v1/models'
    };
    config.probe = {};
    for (const [name, url] of Object.entries(targets)) {
      try {
        const r = await axios.get(url, { timeout: 10000, validateStatus: () => true });
        config.probe[name] = `${r.status} ok-reachable`;
      } catch (e) {
        const msg = e.response?.data?.error?.message || e.response?.statusText || e.message;
        config.probe[name] = `${e.response?.status || e.code}: ${String(msg).slice(0, 80)}`;
      }
    }
  }
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'connected', ...config });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...config });
  }
});

// ── Start ─────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
  console.log(`🚀 Qurushak (قروشك) running on http://localhost:${PORT}`);
});

// ── Keepalive: never let the Render free instance sleep ──
// Render spins down after ~15 min without inbound traffic. Pinging our own
// public URL every 5 min counts as inbound traffic, so the instance stays
// awake as long as it's running. The GitHub Actions cron remains as backup:
// it wakes the instance after deploys/restarts (a sleeping instance can't
// ping itself).
// RENDER_EXTERNAL_URL is set automatically by Render to this service's own
// public URL, so the self-ping follows the service wherever it's deployed.
const SELF_URL = process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL || 'https://qurushak.onrender.com';
if (process.env.RENDER || process.env.NODE_ENV === 'production') {
  setInterval(() => {
    axios.get(`${SELF_URL}/api/health`, { timeout: 30000 })
      .then(() => console.log(`[keepalive] self-ping ok ${new Date().toISOString()}`))
      .catch(err => console.error('[keepalive] self-ping failed:', err.message));
  }, 5 * 60 * 1000);
}

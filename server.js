require('dotenv').config();
const express = require('express');
const cors = require('cors');
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
const LEAN_APP_TOKEN = process.env.LEAN_APP_TOKEN || '0e9bb4e0-945d-4274-9fac-4f3dccec465f';
// Read from env var ONLY — never hardcode (Google auto-disables leaked keys)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) console.error('⚠️  GEMINI_API_KEY env var is not set!');

// Helper: call Gemini with retry + model fallback for 503 overload
async function groqChat(prompt, maxTokens = 4096, opts = {}) {
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest'];
  let lastErr;
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const generationConfig = {
          // gemini-2.0 models cap output at 8192 tokens; asking for more is a 400
          maxOutputTokens: model.includes('2.0') ? Math.min(maxTokens, 8192) : maxTokens,
          temperature: opts.temperature !== undefined ? opts.temperature : 0.2,
          thinkingConfig: { thinkingBudget: 0 } // disable thinking mode for 2.5 models
        };
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

// Middleware
app.use(cors());
app.use(express.json());
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

  await pool.query(`CREATE TABLE IF NOT EXISTS gamification (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    points INTEGER DEFAULT 0,
    quiz_correct INTEGER DEFAULT 0,
    quiz_total INTEGER DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS user_badges (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    badge_id TEXT NOT NULL,
    earned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, badge_id)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS challenges (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL,
    target_amount REAL NOT NULL,
    baseline_amount REAL DEFAULT 0,
    reward_points INTEGER DEFAULT 50,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    status TEXT DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS budgets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    category TEXT NOT NULL,
    monthly_limit REAL NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, category)
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
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, fullName } = req.body;
  if (!email || !password || !fullName) return res.status(400).json({ error: 'All fields required' });
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password, full_name) VALUES ($1, $2, $3) RETURNING id',
      [email, hashedPassword, fullName]
    );
    const id = result.rows[0].id;
    const token = jwt.sign({ id, email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id, email, fullName } });
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Email already exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, fullName: user.full_name } });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// App Store guideline 5.1.1(v): apps with account creation must offer
// in-app account deletion. Wipes every table that references the user.
app.delete('/api/auth/account', authenticateToken, async (req, res) => {
  try {
    const uid = req.userId;
    await pool.query('DELETE FROM user_badges       WHERE user_id=$1', [uid]);
    await pool.query('DELETE FROM challenges        WHERE user_id=$1', [uid]);
    await pool.query('DELETE FROM budgets           WHERE user_id=$1', [uid]);
    await pool.query('DELETE FROM gamification      WHERE user_id=$1', [uid]);
    await pool.query('DELETE FROM goals             WHERE user_id=$1', [uid]);
    await pool.query('DELETE FROM transactions      WHERE user_id=$1', [uid]);
    await pool.query('DELETE FROM bank_connections  WHERE user_id=$1', [uid]);
    await pool.query('DELETE FROM users             WHERE id=$1',      [uid]);
    res.json({ success: true });
  } catch (err) {
    console.error('Account deletion error:', err.message);
    res.status(500).json({ error: 'تعذّر حذف الحساب، حاول مرة أخرى' });
  }
});

// ── Bank Connection Routes ────────────────────────────────
app.post('/api/bank/customer', authenticateToken, async (req, res) => {
  try {
    const existing = await pool.query('SELECT lean_customer_id FROM bank_connections WHERE user_id = $1', [req.userId]);
    if (existing.rows[0]) return res.json({ customer_id: existing.rows[0].lean_customer_id });
    const response = await axios.post(
      'https://sandbox.leantech.me/customers/v1',
      { app_user_id: String(req.userId) },
      { headers: { 'lean-app-token': LEAN_APP_TOKEN } }
    );
    const customerId = response.data.customer_id;
    await pool.query(
      'INSERT INTO bank_connections (user_id, lean_customer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.userId, customerId]
    );
    res.json({ customer_id: customerId });
  } catch (error) {
    console.error('Lean customer error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to create Lean customer' });
  }
});

app.post('/api/bank/connect', authenticateToken, async (req, res) => {
  const { authCode } = req.body;
  if (!authCode) return res.status(400).json({ error: 'Authorization code required' });
  try {
    const response = await axios.post(
      'https://sandbox.leantech.me/auth/v1/authorize',
      { authorization_code: authCode },
      { headers: { 'lean-app-token': LEAN_APP_TOKEN } }
    );
    const customerId = response.data.customer_id;
    const bankName = response.data.bank_identifier || 'Bank';
    await pool.query(
      'INSERT INTO bank_connections (user_id, lean_customer_id, bank_name) VALUES ($1, $2, $3)',
      [req.userId, customerId, bankName]
    );
    res.json({ success: true, customerId, bankName });
  } catch (error) {
    res.status(500).json({ error: 'Failed to connect bank account' });
  }
});

app.get('/api/bank/accounts', authenticateToken, async (req, res) => {
  try {
    const conn = await pool.query('SELECT lean_customer_id FROM bank_connections WHERE user_id = $1', [req.userId]);
    if (!conn.rows[0]) return res.json({ accounts: [] });
    const response = await axios.get('https://sandbox.leantech.me/data/v1/accounts', {
      headers: { 'lean-app-token': LEAN_APP_TOKEN, 'customer-id': conn.rows[0].lean_customer_id }
    });
    res.json({ accounts: response.data.accounts || [] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

app.post('/api/bank/sync-transactions', authenticateToken, async (req, res) => {
  try {
    const conn = await pool.query('SELECT lean_customer_id FROM bank_connections WHERE user_id = $1', [req.userId]);
    if (!conn.rows[0]) return res.status(404).json({ error: 'No bank connected' });
    const from = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const to   = new Date().toISOString().split('T')[0];
    const response = await axios.get(
      `https://sandbox.leantech.me/data/v1/transactions?from=${from}&to=${to}`,
      { headers: { 'lean-app-token': LEAN_APP_TOKEN, 'customer-id': conn.rows[0].lean_customer_id } }
    );
    const txs = response.data.transactions || [];
    let inserted = 0;
    for (const tx of txs) {
      const r = await pool.query(
        'INSERT INTO transactions (user_id, transaction_id, amount, description, category, transaction_date) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, transaction_id) DO NOTHING',
        [req.userId, tx.id, tx.amount, tx.description || 'Transaction', tx.category || 'Other', tx.date]
      );
      if (r.rowCount > 0) inserted++;
    }
    res.json({ success: true, synced: inserted, total: txs.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to sync transactions' });
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

// ── Gamification: points, levels, badges ──────────────────
const LEVELS = [
  { min: 0,    title: 'مبتدئ',       emoji: '🌱' },
  { min: 100,  title: 'مدخر ناشئ',   emoji: '🪙' },
  { min: 250,  title: 'مخطط ذكي',    emoji: '📊' },
  { min: 500,  title: 'محترف مالي',  emoji: '💎' },
  { min: 1000, title: 'خبير الثروة', emoji: '👑' },
];

const BADGES = [
  { id: 'first_steps',    name: 'البداية',         emoji: '🚀', desc: 'أضفت أول معاملة',                     test: s => s.txCount >= 1 },
  { id: 'data_master',    name: 'محلل البيانات',   emoji: '📈', desc: '50 معاملة مسجلة أو أكثر',             test: s => s.txCount >= 50 },
  { id: 'bank_link',      name: 'مصرفية مفتوحة',   emoji: '🏦', desc: 'ربطت حسابك البنكي',                   test: s => s.bankConnected },
  { id: 'goal_setter',    name: 'صاحب طموح',       emoji: '🎯', desc: 'أنشأت هدفاً مالياً',                  test: s => s.goalCount >= 1 },
  { id: 'goal_crusher',   name: 'محقق الأهداف',    emoji: '🏆', desc: 'حققت هدفاً مالياً كاملاً',            test: s => s.goalsAchieved >= 1 },
  { id: 'saver',          name: 'مدخر',            emoji: '💰', desc: 'صافي مدخراتك موجب',                   test: s => s.netSavings > 0 },
  { id: 'super_saver',    name: 'مدخر محترف',      emoji: '🌟', desc: 'نسبة ادخار 20% أو أكثر',              test: s => s.income > 0 && (s.netSavings / s.income) >= 0.2 },
  { id: 'challenger',     name: 'المتحدي',         emoji: '⚔️', desc: 'أكملت تحدي ادخار',                    test: s => s.challengesDone >= 1 },
  { id: 'quiz_starter',   name: 'طالب المعرفة',    emoji: '🧠', desc: 'خضت اختبار الوعي المالي',             test: s => s.quizTotal >= 1 },
  { id: 'quiz_genius',    name: 'عبقري مالي',      emoji: '🎓', desc: '10 إجابات صحيحة في الاختبارات',       test: s => s.quizCorrect >= 10 },
  { id: 'budget_planner', name: 'منظم الميزانية',  emoji: '🗂️', desc: 'وضعت ميزانية شهرية',                  test: s => s.budgetCount >= 1 },
];

const NEW_BADGE_POINTS = 25;

function levelInfo(points) {
  let idx = 0;
  for (let i = 0; i < LEVELS.length; i++) if (points >= LEVELS[i].min) idx = i;
  const cur = LEVELS[idx], next = LEVELS[idx + 1] || null;
  const progressPct = next ? Math.min(Math.round((points - cur.min) / (next.min - cur.min) * 100), 100) : 100;
  return { n: idx + 1, title: cur.title, emoji: cur.emoji, nextAt: next ? next.min : null, progressPct };
}

async function addPoints(userId, pts) {
  await pool.query(
    `INSERT INTO gamification (user_id, points) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET points = gamification.points + $2, updated_at = NOW()`,
    [userId, pts]
  );
}

const todayStr = () => new Date().toISOString().split('T')[0];

app.get('/api/gamification', authenticateToken, async (req, res) => {
  try {
    const [tx, bank, goals, chal, gami, budg, earned] = await Promise.all([
      pool.query(`SELECT COUNT(*) c,
                         COALESCE(SUM(CASE WHEN amount>0 THEN amount ELSE 0 END),0) inc,
                         COALESCE(SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END),0) exp
                  FROM transactions WHERE user_id=$1`, [req.userId]),
      pool.query('SELECT COUNT(*) c FROM bank_connections WHERE user_id=$1', [req.userId]),
      pool.query(`SELECT COUNT(*) c,
                         COUNT(*) FILTER (WHERE current_amount >= target_amount) done
                  FROM goals WHERE user_id=$1`, [req.userId]),
      pool.query(`SELECT COUNT(*) FILTER (WHERE status='completed') done FROM challenges WHERE user_id=$1`, [req.userId]),
      pool.query('SELECT points, quiz_correct, quiz_total FROM gamification WHERE user_id=$1', [req.userId]),
      pool.query('SELECT COUNT(*) c FROM budgets WHERE user_id=$1', [req.userId]),
      pool.query('SELECT badge_id, earned_at FROM user_badges WHERE user_id=$1', [req.userId]),
    ]);

    const g = gami.rows[0] || { points: 0, quiz_correct: 0, quiz_total: 0 };
    const stats = {
      txCount:        parseInt(tx.rows[0].c),
      income:         parseFloat(tx.rows[0].inc),
      netSavings:     parseFloat(tx.rows[0].inc) - parseFloat(tx.rows[0].exp),
      bankConnected:  parseInt(bank.rows[0].c) > 0,
      goalCount:      parseInt(goals.rows[0].c),
      goalsAchieved:  parseInt(goals.rows[0].done),
      challengesDone: parseInt(chal.rows[0].done),
      quizCorrect:    g.quiz_correct,
      quizTotal:      g.quiz_total,
      budgetCount:    parseInt(budg.rows[0].c),
    };

    // Award any newly-qualified badges (+points each, exactly once via UNIQUE)
    const have = new Set(earned.rows.map(r => r.badge_id));
    const newBadges = [];
    for (const b of BADGES) {
      if (have.has(b.id) || !b.test(stats)) continue;
      const r = await pool.query(
        'INSERT INTO user_badges (user_id, badge_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING badge_id',
        [req.userId, b.id]
      );
      if (r.rowCount > 0) { newBadges.push({ id: b.id, name: b.name, emoji: b.emoji }); have.add(b.id); }
    }
    if (newBadges.length) await addPoints(req.userId, newBadges.length * NEW_BADGE_POINTS);

    const ptsRow = await pool.query('SELECT points FROM gamification WHERE user_id=$1', [req.userId]);
    const points = ptsRow.rows[0]?.points || 0;

    res.json({
      points,
      level: levelInfo(points),
      newBadges,
      badges: BADGES.map(b => ({ id: b.id, name: b.name, emoji: b.emoji, desc: b.desc, earned: have.has(b.id) })),
      stats: { quizCorrect: stats.quizCorrect, quizTotal: stats.quizTotal, challengesDone: stats.challengesDone },
    });
  } catch (err) {
    console.error('Gamification error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Savings Challenges (AI-generated, verified against real spending) ──
async function weeklySpendByCategory(userId) {
  // Baseline window = 90 days ending at the user's newest transaction,
  // so demo/imported data from past months still yields a real baseline.
  const r = await pool.query(`
    SELECT category, SUM(ABS(amount)) AS total
    FROM transactions
    WHERE user_id=$1 AND amount<0
      AND transaction_date > (SELECT MAX(transaction_date) FROM transactions WHERE user_id=$1) - INTERVAL '90 days'
    GROUP BY category ORDER BY total DESC`, [userId]);
  const span = await pool.query(`
    SELECT GREATEST(1, LEAST(90, MAX(transaction_date) - MIN(transaction_date) + 1)) AS days
    FROM transactions WHERE user_id=$1 AND amount<0`, [userId]);
  const days = parseInt(span.rows[0]?.days || 30);
  return r.rows
    .map(row => ({ category: row.category || 'أخرى', weekly: parseFloat(row.total) / days * 7 }))
    .filter(c => c.weekly >= 20 && !['راتب', 'دخل إضافي', 'سكن'].includes(c.category));
}

app.post('/api/challenges/generate', authenticateToken, async (req, res) => {
  try {
    const cats = (await weeklySpendByCategory(req.userId)).slice(0, 5);
    if (!cats.length) return res.status(400).json({ error: 'أضف معاملاتك أولاً ليتم توليد تحديات مناسبة لك' });

    let items = null;
    try {
      const schema = {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            title:         { type: 'STRING' },
            description:   { type: 'STRING' },
            category:      { type: 'STRING' },
            target_amount: { type: 'NUMBER' },
            reward_points: { type: 'NUMBER' }
          },
          required: ['title', 'description', 'category', 'target_amount', 'reward_points']
        }
      };
      const prompt = `أنت مدرب ادخار سعودي محفّز. اقترح 3 تحديات ادخار أسبوعية (7 أيام) بناءً على متوسط الإنفاق الأسبوعي الفعلي للمستخدم أدناه.
قواعد صارمة:
- category يجب أن تكون واحدة من هذه القائمة حرفياً: ${cats.map(c => c.category).join('، ')}
- target_amount هو سقف الإنفاق المسموح للفئة خلال الأسبوع، بين 50% و 85% من المتوسط الأسبوعي للفئة
- title قصير وجذاب (5 كلمات كحد أقصى) مع إيموجي واحد
- description سطر واحد يوضح التحدي والتوفير المتوقع بالأرقام
- reward_points بين 40 و 80 حسب صعوبة التحدي
- اختر 3 فئات مختلفة

متوسط الإنفاق الأسبوعي للمستخدم:
${cats.map(c => `${c.category}: ${c.weekly.toFixed(0)} ر.س/أسبوع`).join('\n')}`;
      const aiText = await groqChat(prompt, 2048, { temperature: 0.7, responseSchema: schema });
      const parsed = JSON.parse(aiText.replace(/```(?:json)?/gi, '').trim());
      if (Array.isArray(parsed)) items = parsed;
    } catch (aiErr) {
      console.error('Challenge AI failed, using fallback:', aiErr.message);
    }

    // Deterministic fallback keeps the feature alive when the AI is unavailable
    if (!items || !items.length) {
      items = cats.slice(0, 3).map(c => ({
        title: `⚔️ تحدي ${c.category}`,
        description: `أنفق أقل من ${Math.round(c.weekly * 0.75)} ر.س على ${c.category} خلال أسبوع (متوسطك ${Math.round(c.weekly)} ر.س) ووفّر ${Math.round(c.weekly * 0.25)} ر.س`,
        category: c.category,
        target_amount: Math.round(c.weekly * 0.75),
        reward_points: 50
      }));
    }

    const byCat = Object.fromEntries(cats.map(c => [c.category, c.weekly]));
    const start = todayStr();
    const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Replace current active challenges with the fresh set
    await pool.query(`UPDATE challenges SET status='archived' WHERE user_id=$1 AND status='active'`, [req.userId]);

    const saved = [];
    for (const it of items.slice(0, 3)) {
      if (!byCat[it.category]) continue; // AI hallucinated a category → skip
      const weekly = byCat[it.category];
      const target = Math.min(Math.max(it.target_amount, weekly * 0.4), weekly * 0.9);
      const reward = Math.min(Math.max(Math.round(it.reward_points || 50), 40), 80);
      const r = await pool.query(
        `INSERT INTO challenges (user_id, title, description, category, target_amount, baseline_amount, reward_points, start_date, end_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [req.userId, it.title, it.description, it.category, Math.round(target), Math.round(weekly), reward, start, end]
      );
      saved.push(r.rows[0]);
    }
    if (!saved.length) return res.status(500).json({ error: 'تعذّر توليد التحديات، حاول مرة أخرى' });
    res.json({ success: true, challenges: saved });
  } catch (err) {
    console.error('Challenge generate error:', err.message);
    res.status(500).json({ error: 'تعذّر توليد التحديات' });
  }
});

app.get('/api/challenges', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM challenges WHERE user_id=$1 AND status != 'archived' ORDER BY created_at DESC LIMIT 12`,
      [req.userId]
    );
    const today = todayStr();
    const out = [];
    for (const ch of rows) {
      const spentRes = await pool.query(
        `SELECT COALESCE(SUM(ABS(amount)),0) s FROM transactions
         WHERE user_id=$1 AND amount<0 AND category=$2 AND transaction_date BETWEEN $3 AND $4`,
        [req.userId, ch.category, ch.start_date, ch.end_date]
      );
      const spent = parseFloat(spentRes.rows[0].s);
      let status = ch.status;

      if (status === 'active' && spent > ch.target_amount) {
        // Budget blown → challenge failed immediately
        await pool.query(`UPDATE challenges SET status='failed' WHERE id=$1`, [ch.id]);
        status = 'failed';
      } else if (status === 'active' && today > ch.end_date) {
        // Window over & stayed under budget → success, award points exactly once
        const r = await pool.query(
          `UPDATE challenges SET status='completed' WHERE id=$1 AND status='active' RETURNING id`,
          [ch.id]
        );
        if (r.rowCount > 0) await addPoints(req.userId, ch.reward_points);
        status = 'completed';
      }

      const daysLeft = Math.max(0, Math.ceil((new Date(ch.end_date) - new Date(today)) / 86400000));
      out.push({ ...ch, status, spent: Math.round(spent), days_left: daysLeft });
    }
    res.json({ challenges: out });
  } catch (err) {
    console.error('Challenges error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Financial Literacy Quiz (personalized from the user's own data) ──
app.post('/api/quiz/generate', authenticateToken, async (req, res) => {
  try {
    const { rows: txs } = await pool.query(
      'SELECT amount, category, description, transaction_date FROM transactions WHERE user_id=$1 ORDER BY transaction_date DESC LIMIT 200',
      [req.userId]
    );
    if (!txs.length) return res.status(400).json({ error: 'أضف معاملاتك أولاً ليكون الاختبار مخصصاً لك' });

    const catTotals = {}, monthTotals = {};
    let income = 0, expenses = 0;
    txs.forEach(t => {
      const m = String(t.transaction_date).slice(0, 7);
      if (t.amount < 0) {
        const a = Math.abs(t.amount);
        expenses += a;
        catTotals[t.category || 'أخرى'] = (catTotals[t.category || 'أخرى'] || 0) + a;
        monthTotals[m] = (monthTotals[m] || 0) + a;
      } else income += t.amount;
    });
    const topCats = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);
    const lastMonth = Object.keys(monthTotals).sort().pop();

    let questions = null;
    try {
      const schema = {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            question:    { type: 'STRING' },
            options:     { type: 'ARRAY', items: { type: 'STRING' } },
            correct:     { type: 'NUMBER' },
            explanation: { type: 'STRING' }
          },
          required: ['question', 'options', 'correct', 'explanation']
        }
      };
      const prompt = `أنت مدرّب تثقيف مالي. أنشئ 4 أسئلة اختيار من متعدد بالعربية لاختبار وعي المستخدم المالي.
- سؤالان عن بياناته الفعلية أدناه (مثلاً: أكبر فئة إنفاق، إجمالي مصاريف شهر معين)
- سؤالان عن مبادئ مالية عامة (صندوق الطوارئ، قاعدة 50/30/20، الادخار، التضخم)
- لكل سؤال 4 خيارات، correct هو رقم الخيار الصحيح (0-3)
- explanation سطر واحد يشرح الإجابة الصحيحة

بيانات المستخدم:
إجمالي الدخل: ${income.toFixed(0)} ر.س | إجمالي المصاريف: ${expenses.toFixed(0)} ر.س
المصاريف حسب الفئة: ${topCats.map(([c, v]) => `${c}: ${v.toFixed(0)}`).join('، ')}
المصاريف الشهرية: ${Object.entries(monthTotals).sort().map(([m, v]) => `${m}: ${v.toFixed(0)}`).join('، ')}`;
      const aiText = await groqChat(prompt, 4096, { temperature: 0.5, responseSchema: schema });
      const parsed = JSON.parse(aiText.replace(/```(?:json)?/gi, '').trim());
      if (Array.isArray(parsed)) {
        questions = parsed.filter(q =>
          q.question && Array.isArray(q.options) && q.options.length === 4 &&
          Number.isInteger(q.correct) && q.correct >= 0 && q.correct <= 3
        ).slice(0, 4);
      }
    } catch (aiErr) {
      console.error('Quiz AI failed, using fallback:', aiErr.message);
    }

    // Data-derived fallback quiz — works with zero AI availability
    if (!questions || questions.length < 2) {
      const shuffle = (opts, correctVal) => {
        const arr = [...opts].sort(() => Math.random() - 0.5);
        return { options: arr, correct: arr.indexOf(correctVal) };
      };
      questions = [];
      if (topCats.length >= 2) {
        const names = topCats.slice(0, 4).map(([c]) => c);
        while (names.length < 4) names.push(['ترفيه', 'صحة', 'فواتير', 'مواصلات'].find(x => !names.includes(x)) || 'أخرى');
        const q = shuffle(names, topCats[0][0]);
        questions.push({ question: 'ما أكبر فئة إنفاق لديك؟', ...q, explanation: `أكبر فئة إنفاق لديك هي ${topCats[0][0]} بمجموع ${topCats[0][1].toFixed(0)} ر.س` });
      }
      if (lastMonth) {
        const v = monthTotals[lastMonth];
        const q = shuffle([v, v * 0.7, v * 1.3, v * 1.6].map(x => `${Math.round(x).toLocaleString('en')} ر.س`), `${Math.round(v).toLocaleString('en')} ر.س`);
        questions.push({ question: `كم بلغ إجمالي مصاريفك في شهر ${lastMonth}؟`, ...q, explanation: `أنفقت ${Math.round(v).toLocaleString('en')} ر.س في ${lastMonth}` });
      }
      const q3 = shuffle(['شهر واحد', '3 إلى 6 أشهر', 'أسبوعان', 'سنتان كاملتان'], '3 إلى 6 أشهر');
      questions.push({ question: 'كم يُنصح أن يغطي صندوق الطوارئ من نفقاتك؟', ...q3, explanation: 'يُنصح بادخار ما يغطي 3-6 أشهر من النفقات الأساسية للطوارئ' });
      const q4 = shuffle(['50% أساسيات، 30% رغبات، 20% ادخار', '50% رغبات، 30% ادخار، 20% أساسيات', '50% ادخار، 30% أساسيات، 20% رغبات', 'إنفاق كل الدخل بالتساوي'], '50% أساسيات، 30% رغبات، 20% ادخار');
      questions.push({ question: 'ما هي قاعدة 50/30/20 لتوزيع الدخل؟', ...q4, explanation: 'القاعدة: 50% للأساسيات، 30% للرغبات، 20% للادخار والاستثمار' });
    }

    res.json({ questions });
  } catch (err) {
    console.error('Quiz generate error:', err.message);
    res.status(500).json({ error: 'تعذّر توليد الاختبار' });
  }
});

const QUIZ_POINTS_PER_CORRECT = 15;

app.post('/api/quiz/submit', authenticateToken, async (req, res) => {
  try {
    const total   = Math.min(Math.max(parseInt(req.body.total) || 0, 0), 10);
    const correct = Math.min(Math.max(parseInt(req.body.correct) || 0, 0), total);
    const gained  = correct * QUIZ_POINTS_PER_CORRECT;
    await pool.query(
      `INSERT INTO gamification (user_id, points, quiz_correct, quiz_total) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id) DO UPDATE SET
         points = gamification.points + $2,
         quiz_correct = gamification.quiz_correct + $3,
         quiz_total = gamification.quiz_total + $4,
         updated_at = NOW()`,
      [req.userId, gained, correct, total]
    );
    const { rows } = await pool.query('SELECT points, quiz_correct, quiz_total FROM gamification WHERE user_id=$1', [req.userId]);
    res.json({ success: true, gained, points: rows[0].points, level: levelInfo(rows[0].points) });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Smart Budget (AI-suggested caps vs real spending) ─────
async function monthlyAvgByCategory(userId) {
  // Average over the 3 most recent months that actually have expenses
  const { rows } = await pool.query(`
    WITH months AS (
      SELECT DISTINCT TO_CHAR(transaction_date,'YYYY-MM') m
      FROM transactions WHERE user_id=$1 AND amount<0
      ORDER BY m DESC LIMIT 3
    )
    SELECT category, SUM(ABS(amount)) / (SELECT COUNT(*) FROM months) AS avg_monthly
    FROM transactions
    WHERE user_id=$1 AND amount<0 AND TO_CHAR(transaction_date,'YYYY-MM') IN (SELECT m FROM months)
    GROUP BY category ORDER BY avg_monthly DESC`, [userId]);
  return rows.map(r => ({ category: r.category || 'أخرى', avg: parseFloat(r.avg_monthly) }));
}

app.get('/api/budget', authenticateToken, async (req, res) => {
  try {
    const { rows: budgets } = await pool.query('SELECT category, monthly_limit FROM budgets WHERE user_id=$1', [req.userId]);
    // Reference month = latest month with data (same convention as /api/summary)
    const { rows: spent } = await pool.query(`
      SELECT category, SUM(ABS(amount)) s FROM transactions
      WHERE user_id=$1 AND amount<0 AND TO_CHAR(transaction_date,'YYYY-MM') = COALESCE(
        (SELECT TO_CHAR(MAX(transaction_date),'YYYY-MM') FROM transactions WHERE user_id=$1),
        TO_CHAR(NOW(),'YYYY-MM'))
      GROUP BY category`, [req.userId]);
    const { rows: monthRow } = await pool.query(
      `SELECT COALESCE((SELECT TO_CHAR(MAX(transaction_date),'YYYY-MM') FROM transactions WHERE user_id=$1), TO_CHAR(NOW(),'YYYY-MM')) m`,
      [req.userId]);
    const spentBy = Object.fromEntries(spent.map(r => [r.category || 'أخرى', parseFloat(r.s)]));
    const out = budgets.map(b => ({
      category: b.category,
      monthly_limit: b.monthly_limit,
      spent: Math.round(spentBy[b.category] || 0),
      pct: Math.round((spentBy[b.category] || 0) / b.monthly_limit * 100)
    })).sort((a, b) => b.pct - a.pct);
    res.json({
      month: monthRow[0].m,
      budgets: out,
      totalLimit: Math.round(out.reduce((s, b) => s + b.monthly_limit, 0)),
      totalSpent: Math.round(out.reduce((s, b) => s + b.spent, 0))
    });
  } catch (err) {
    console.error('Budget error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/budget/generate', authenticateToken, async (req, res) => {
  try {
    const avgs = await monthlyAvgByCategory(req.userId);
    if (!avgs.length) return res.status(400).json({ error: 'أضف معاملاتك أولاً ليتم اقتراح ميزانية مناسبة' });
    const { rows: incRows } = await pool.query(
      `SELECT COALESCE(SUM(amount),0) / GREATEST(COUNT(DISTINCT TO_CHAR(transaction_date,'YYYY-MM')),1) inc
       FROM transactions WHERE user_id=$1 AND amount>0`, [req.userId]);
    const monthlyIncome = parseFloat(incRows[0].inc);

    let items = null;
    try {
      const schema = {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: { category: { type: 'STRING' }, monthly_limit: { type: 'NUMBER' } },
          required: ['category', 'monthly_limit']
        }
      };
      const prompt = `أنت مخطط ميزانيات. ضع سقف إنفاق شهري لكل فئة من فئات المستخدم أدناه.
قواعد:
- category حرفياً من القائمة أدناه فقط، ولكل فئة سطر واحد
- الفئات الأساسية (سكن، فواتير، صحة) تبقى قريبة من متوسطها
- الفئات الكمالية (مطاعم، تسوق، ترفيه) خفّضها 10-25% عن المتوسط
- مجموع السقوف لا يتجاوز 80% من الدخل الشهري (${monthlyIncome.toFixed(0)} ر.س) إن أمكن

متوسط الإنفاق الشهري:
${avgs.map(a => `${a.category}: ${a.avg.toFixed(0)} ر.س`).join('\n')}`;
      const aiText = await groqChat(prompt, 2048, { temperature: 0.3, responseSchema: schema });
      const parsed = JSON.parse(aiText.replace(/```(?:json)?/gi, '').trim());
      if (Array.isArray(parsed)) items = parsed;
    } catch (aiErr) {
      console.error('Budget AI failed, using fallback:', aiErr.message);
    }
    if (!items || !items.length) {
      // Same policy the AI is prompted with: essentials keep their average, discretionary tightens
      const essential = ['سكن', 'فواتير', 'صحة'];
      items = avgs.map(a => ({ category: a.category, monthly_limit: Math.round(a.avg * (essential.includes(a.category) ? 1.0 : 0.85)) }));
    }

    const avgBy = Object.fromEntries(avgs.map(a => [a.category, a.avg]));
    let saved = 0;
    for (const it of items) {
      if (!avgBy[it.category] || !(it.monthly_limit > 0)) continue;
      // Keep AI output sane: between 50% and 120% of the category's average
      const limit = Math.round(Math.min(Math.max(it.monthly_limit, avgBy[it.category] * 0.5), avgBy[it.category] * 1.2));
      await pool.query(
        `INSERT INTO budgets (user_id, category, monthly_limit) VALUES ($1,$2,$3)
         ON CONFLICT (user_id, category) DO UPDATE SET monthly_limit=$3, updated_at=NOW()`,
        [req.userId, it.category, limit]
      );
      saved++;
    }
    if (!saved) return res.status(500).json({ error: 'تعذّر توليد الميزانية' });
    res.json({ success: true, saved });
  } catch (err) {
    console.error('Budget generate error:', err.message);
    res.status(500).json({ error: 'تعذّر توليد الميزانية' });
  }
});

app.put('/api/budget', authenticateToken, async (req, res) => {
  const { category, monthlyLimit } = req.body;
  if (!category || !(monthlyLimit > 0)) return res.status(400).json({ error: 'فئة ومبلغ صحيح مطلوبان' });
  try {
    await pool.query(
      `INSERT INTO budgets (user_id, category, monthly_limit) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, category) DO UPDATE SET monthly_limit=$3, updated_at=NOW()`,
      [req.userId, category, monthlyLimit]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/budget/:category', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM budgets WHERE user_id=$1 AND category=$2', [req.userId, req.params.category]);
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

    const models = ['gemini-2.5-flash', 'gemini-2.0-flash'];
    let streamed = false;
    for (const model of models) {
      try {
        const gRes = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`,
          {
            contents: [{ parts: [{ text: fullPrompt }] }],
            generationConfig: { maxOutputTokens: 1024, temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } }
          },
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
    console.error('Chat error:', error.response?.data || error.message);
    if (!res.headersSent) res.status(500).json({ error: { message: 'حدث خطأ في الاتصال بالذكاء الاصطناعي' } });
    else res.end();
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
- category يجب أن تكون إحدى: مطاعم, تسوق, مواصلات, سكن, راتب, دخل إضافي, فواتير, أخرى
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
          category:    { type: 'STRING' }
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
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'connected', dbUrl: process.env.DATABASE_URL ? 'set' : 'MISSING' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, dbUrl: process.env.DATABASE_URL ? 'set' : 'MISSING' });
  }
});

// ── Start ─────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
  console.log(`🚀 Maali running on http://localhost:${PORT}`);
});

// ── Keepalive: never let the Render free instance sleep ──
// Render spins down after ~15 min without inbound traffic. Pinging our own
// public URL every 5 min counts as inbound traffic, so the instance stays
// awake as long as it's running. The GitHub Actions cron remains as backup:
// it wakes the instance after deploys/restarts (a sleeping instance can't
// ping itself).
const SELF_URL = process.env.SELF_URL || 'https://maali-app.onrender.com';
if (process.env.RENDER || process.env.NODE_ENV === 'production') {
  setInterval(() => {
    axios.get(`${SELF_URL}/api/health`, { timeout: 30000 })
      .then(() => console.log(`[keepalive] self-ping ok ${new Date().toISOString()}`))
      .catch(err => console.error('[keepalive] self-ping failed:', err.message));
  }, 5 * 60 * 1000);
}

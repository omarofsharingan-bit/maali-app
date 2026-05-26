const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
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
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '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';

// Helper: call OpenRouter (free GPT-OSS-120B)
async function groqChat(prompt, maxTokens = 4096) {
  const res = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: 'openai/gpt-oss-120b:free',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.2
    },
    {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://maali-app.onrender.com',
        'X-Title': 'Maali',
        'Content-Type': 'application/json'
      },
      timeout: 60000
    }
  );
  return res.data.choices[0].message.content;
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Database ──────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
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
    transaction_id TEXT UNIQUE,
    amount REAL NOT NULL,
    currency TEXT DEFAULT 'SAR',
    description TEXT,
    category TEXT,
    transaction_date DATE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

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
        'INSERT INTO transactions (user_id, transaction_id, amount, description, category, transaction_date) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (transaction_id) DO NOTHING',
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
    const [inc, exp, cnt] = await Promise.all([
      pool.query(`SELECT SUM(amount) as total FROM transactions WHERE user_id=$1 AND amount>0 AND TO_CHAR(transaction_date,'YYYY-MM')=TO_CHAR(NOW(),'YYYY-MM')`, [req.userId]),
      pool.query(`SELECT SUM(ABS(amount)) as total FROM transactions WHERE user_id=$1 AND amount<0 AND TO_CHAR(transaction_date,'YYYY-MM')=TO_CHAR(NOW(),'YYYY-MM')`, [req.userId]),
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
أجب باللغة العربية دائماً. كن محدداً ومختصراً.

${financialContext}

سؤال المستخدم: ${userMessage}`;

    const text = await groqChat(fullPrompt);
    // Return in Gemini-compatible shape so the frontend doesn't need changes
    res.json({ candidates: [{ content: { parts: [{ text }] } }] });
  } catch (error) {
    console.error('Groq error:', error.response?.data || error.message);
    res.status(500).json({ error: { message: 'حدث خطأ في الاتصال بالذكاء الاصطناعي' } });
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
    for (const t of T) {
      await pool.query(
        'INSERT INTO transactions (user_id,transaction_id,amount,description,category,transaction_date) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (transaction_id) DO NOTHING',
        [req.userId, t.id, t.amount, t.desc, t.cat, t.date]
      );
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
    res.json({ success: true });
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
أعد JSON فقط — مصفوفة بهذا الشكل بدون أي نص إضافي:
[{"date":"YYYY-MM-DD","amount":number,"description":"string","category":"string"}]

قواعد:
- amount سالب للمصروفات والخصم، موجب للإيداع والدخل
- date بصيغة YYYY-MM-DD
- category يجب أن تكون إحدى: مطاعم, تسوق, مواصلات, سكن, راتب, دخل إضافي, فواتير, أخرى
- description النص الأصلي للمعاملة
- تجاهل الأرصدة والملخصات، فقط المعاملات الفردية

النص:
${rawText.slice(0, 30000)}`;

    const aiText = await groqChat(prompt);
    const match = aiText.match(/\[[\s\S]*\]/);
    if (!match) return res.status(422).json({ error: 'AI could not parse transactions', raw: aiText.slice(0,500) });

    const transactions = JSON.parse(match[0]);
    if (!Array.isArray(transactions) || transactions.length === 0) {
      return res.status(422).json({ error: 'No transactions found in file' });
    }

    const timestamp = Date.now();
    let inserted = 0;
    for (const [i, t] of transactions.entries()) {
      if (!t.date || t.amount === undefined) continue;
      await pool.query(
        'INSERT INTO transactions (user_id,transaction_id,amount,description,category,transaction_date) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (transaction_id) DO NOTHING',
        [req.userId, `imp-${timestamp}-${i}`, parseFloat(t.amount), t.description || 'معاملة', t.category || 'أخرى', t.date]
      );
      inserted++;
    }
    res.json({ success: true, total: transactions.length, inserted, transactions: transactions.slice(0,20) });
  } catch (err) {
    console.error('Import error:', err.message);
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

// ── Start ─────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
  console.log(`🚀 Maali running on http://localhost:${PORT}`);
});

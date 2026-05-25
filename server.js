const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const multer = require('multer');
const pdfParse = require('pdf-parse');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const LEAN_APP_TOKEN = process.env.LEAN_APP_TOKEN || '0e9bb4e0-945d-4274-9fac-4f3dccec465f';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyDNU9NglqCC3pvAJ1okPfrsmcNSlsMbdMY';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Database setup
const DB_PATH = process.env.DB_PATH || './maali.db';
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error(err);
  else console.log('✅ Connected to SQLite database');
});

// Create tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    full_name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS bank_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    lean_customer_id TEXT UNIQUE NOT NULL,
    bank_name TEXT,
    account_id TEXT,
    connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    transaction_id TEXT UNIQUE,
    amount REAL NOT NULL,
    currency TEXT DEFAULT 'SAR',
    description TEXT,
    category TEXT,
    transaction_date DATE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    target_amount REAL NOT NULL,
    current_amount REAL DEFAULT 0,
    deadline DATE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
});

// ══════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ══════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════════════════════════

app.post('/api/auth/signup', async (req, res) => {
  const { email, password, fullName } = req.body;
  if (!email || !password || !fullName) return res.status(400).json({ error: 'All fields required' });

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    db.run(
      'INSERT INTO users (email, password, full_name) VALUES (?, ?, ?)',
      [email, hashedPassword, fullName],
      function (err) {
        if (err) return res.status(400).json({ error: 'Email already exists or DB error' });
        const token = jwt.sign({ id: this.lastID, email }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, user: { id: this.lastID, email, fullName } });
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
    if (err || !user) return res.status(401).json({ error: 'Invalid credentials' });
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, fullName: user.full_name } });
  });
});

// ══════════════════════════════════════════════════════════
// LEAN BANK CONNECTION
// ══════════════════════════════════════════════════════════

app.post('/api/bank/customer', authenticateToken, async (req, res) => {
  // Return existing customer_id if already created
  db.get('SELECT lean_customer_id FROM bank_connections WHERE user_id = ?', [req.userId], async (err, row) => {
    if (row) return res.json({ customer_id: row.lean_customer_id });

    try {
      const response = await axios.post(
        'https://sandbox.leantech.me/customers/v1',
        { app_user_id: String(req.userId) },
        { headers: { 'lean-app-token': LEAN_APP_TOKEN } }
      );
      const customerId = response.data.customer_id;

      db.run(
        'INSERT OR IGNORE INTO bank_connections (user_id, lean_customer_id) VALUES (?, ?)',
        [req.userId, customerId]
      );
      res.json({ customer_id: customerId });
    } catch (error) {
      console.error('Lean customer error:', error.response?.data || error.message);
      res.status(500).json({ error: 'Failed to create Lean customer' });
    }
  });
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

    db.run(
      'INSERT INTO bank_connections (user_id, lean_customer_id, bank_name) VALUES (?, ?, ?)',
      [req.userId, customerId, bankName],
      function (err) {
        if (err) return res.status(400).json({ error: 'Bank already connected' });
        res.json({ success: true, customerId, bankName });
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Failed to connect bank account' });
  }
});

app.get('/api/bank/accounts', authenticateToken, async (req, res) => {
  db.get('SELECT lean_customer_id FROM bank_connections WHERE user_id = ?', [req.userId], async (err, connection) => {
    if (err || !connection) return res.json({ accounts: [] });
    try {
      const response = await axios.get('https://sandbox.leantech.me/data/v1/accounts', {
        headers: { 'lean-app-token': LEAN_APP_TOKEN, 'customer-id': connection.lean_customer_id }
      });
      res.json({ accounts: response.data.accounts || [] });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch accounts' });
    }
  });
});

app.post('/api/bank/sync-transactions', authenticateToken, async (req, res) => {
  db.get('SELECT lean_customer_id FROM bank_connections WHERE user_id = ?', [req.userId], async (err, connection) => {
    if (err || !connection) return res.status(404).json({ error: 'No bank connected' });
    try {
      const from = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const to = new Date().toISOString().split('T')[0];
      const response = await axios.get(
        `https://sandbox.leantech.me/data/v1/transactions?from=${from}&to=${to}`,
        { headers: { 'lean-app-token': LEAN_APP_TOKEN, 'customer-id': connection.lean_customer_id } }
      );
      const transactions = response.data.transactions || [];
      let inserted = 0;
      const stmt = db.prepare('INSERT OR IGNORE INTO transactions (user_id, transaction_id, amount, description, category, transaction_date) VALUES (?, ?, ?, ?, ?, ?)');
      transactions.forEach((tx) => {
        stmt.run([req.userId, tx.id, tx.amount, tx.description || 'Transaction', tx.category || 'Other', tx.date], (e) => { if (!e) inserted++; });
      });
      stmt.finalize(() => res.json({ success: true, synced: inserted, total: transactions.length }));
    } catch (error) {
      res.status(500).json({ error: 'Failed to sync transactions' });
    }
  });
});

// ══════════════════════════════════════════════════════════
// DATA ROUTES
// ══════════════════════════════════════════════════════════

app.get('/api/transactions', authenticateToken, (req, res) => {
  db.all('SELECT * FROM transactions WHERE user_id = ? ORDER BY transaction_date DESC', [req.userId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json({ transactions: rows });
  });
});

app.get('/api/summary', authenticateToken, (req, res) => {
  const queries = {
    income: `SELECT SUM(amount) as total FROM transactions WHERE user_id = ? AND amount > 0 AND strftime('%Y-%m', transaction_date) = strftime('%Y-%m', 'now')`,
    expenses: `SELECT SUM(ABS(amount)) as total FROM transactions WHERE user_id = ? AND amount < 0 AND strftime('%Y-%m', transaction_date) = strftime('%Y-%m', 'now')`,
    count: `SELECT COUNT(*) as count FROM transactions WHERE user_id = ?`
  };
  Promise.all([
    new Promise(r => db.get(queries.income, [req.userId], (err, row) => r(row?.total || 0))),
    new Promise(r => db.get(queries.expenses, [req.userId], (err, row) => r(row?.total || 0))),
    new Promise(r => db.get(queries.count, [req.userId], (err, row) => r(row?.count || 0)))
  ]).then(([income, expenses, count]) => {
    res.json({ income: parseFloat(income).toFixed(2), expenses: parseFloat(expenses).toFixed(2), savings: (parseFloat(income) - parseFloat(expenses)).toFixed(2), transactionCount: count });
  });
});

app.get('/api/goals', authenticateToken, (req, res) => {
  db.all('SELECT * FROM goals WHERE user_id = ? ORDER BY created_at DESC', [req.userId], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json({ goals: rows });
  });
});

app.post('/api/goals', authenticateToken, (req, res) => {
  const { name, targetAmount, deadline } = req.body;
  db.run('INSERT INTO goals (user_id, name, target_amount, deadline) VALUES (?, ?, ?, ?)', [req.userId, name, targetAmount, deadline], function (err) {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json({ id: this.lastID, name, targetAmount, currentAmount: 0, deadline });
  });
});

// ══════════════════════════════════════════════════════════
// AI CHAT ROUTE – full transaction context
// ══════════════════════════════════════════════════════════

function buildFinancialContext(transactions, goals) {
  if (!transactions.length) return 'لا توجد بيانات معاملات متاحة.';

  const monthly = {};
  const categoryTotals = {};

  transactions.forEach(tx => {
    const month = tx.transaction_date.substring(0, 7);
    if (!monthly[month]) monthly[month] = { income: 0, expenses: 0 };
    if (tx.amount > 0) monthly[month].income += tx.amount;
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
    .map(t => `${t.description}: ${Math.abs(t.amount).toFixed(2)} ر.س (${t.transaction_date})`)
    .join('\n');

  const allTxLines = transactions
    .map(tx => `${tx.transaction_date}|${tx.amount>0?'+':''}${tx.amount.toFixed(2)}|${tx.category||'أخرى'}|${tx.description}`)
    .join('\n');

  const goalsText = goals.length
    ? goals.map(g => `${g.name}: مستهدف ${g.target_amount} ر.س، مُجمَّع ${g.current_amount} ر.س، موعد ${g.deadline||'غير محدد'}`).join('\n')
    : 'لا توجد أهداف مسجلة.';

  return `═══════════════════════════════════════
بيانات المعاملات الحقيقية – بنك الراجحي | يناير–مايو 2026
عدد المعاملات: ${transactions.length}
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

📋 جميع المعاملات (${transactions.length} معاملة) – التاريخ|المبلغ|الفئة|الوصف:
${allTxLines}
═══════════════════════════════════════`;
}

app.post('/api/chat', authenticateToken, async (req, res) => {
  try {
    const userMessage = req.body.message;
    const userId = req.userId;

    // Fetch all transactions + goals in parallel
    const [transactions, goals] = await Promise.all([
      new Promise((resolve, reject) =>
        db.all('SELECT * FROM transactions WHERE user_id = ? ORDER BY transaction_date ASC', [userId],
          (err, rows) => err ? reject(err) : resolve(rows || []))),
      new Promise((resolve, reject) =>
        db.all('SELECT * FROM goals WHERE user_id = ?', [userId],
          (err, rows) => err ? reject(err) : resolve(rows || []))),
    ]);

    const financialContext = buildFinancialContext(transactions, goals);

    const fullPrompt = `أنت محلل مالي ذكي ومتخصص. لديك بيانات المعاملات الحقيقية للمستخدم من بنك الراجحي.
أجب على أسئلته بدقة تامة بناءً على هذه البيانات فقط. استخدم الأرقام الحقيقية.
أجب باللغة العربية دائماً. كن محدداً ومختصراً.

${financialContext}

سؤال المستخدم: ${userMessage}`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: fullPrompt }] }] },
      { headers: { 'Content-Type': 'application/json' } }
    );

    res.json(response.data);
  } catch (error) {
    console.error('Gemini API Error:', error.response?.data || error.message);
    res.status(500).json({ error: { message: 'حدث خطأ في الاتصال بالذكاء الاصطناعي' } });
  }
});

// ══════════════════════════════════════════════════════════
// DEMO DATA
// ══════════════════════════════════════════════════════════

app.post('/api/demo/load', authenticateToken, (req, res) => {
  const T = [
    // ── May 2026 ──
    { id: 'dm-1',  amount: 12500,  desc: 'راتب شهر مايو',         cat: 'راتب',        date: '2026-05-01' },
    { id: 'dm-2',  amount: -3500,  desc: 'إيجار شهري',            cat: 'سكن',         date: '2026-05-02' },
    { id: 'dm-3',  amount: -620,   desc: 'سوبرماركت الدانوب',      cat: 'تسوق',        date: '2026-05-04' },
    { id: 'dm-4',  amount: -85,    desc: 'مطعم البيك',             cat: 'مطاعم',       date: '2026-05-05' },
    { id: 'dm-5',  amount: -450,   desc: 'محطة وقود أرامكو',       cat: 'مواصلات',     date: '2026-05-06' },
    { id: 'dm-6',  amount: -180,   desc: 'فاتورة الجوال',          cat: 'فواتير',      date: '2026-05-07' },
    { id: 'dm-7',  amount: -380,   desc: 'فاتورة الكهرباء',        cat: 'فواتير',      date: '2026-05-08' },
    { id: 'dm-8',  amount: -120,   desc: 'ماكدونالدز',             cat: 'مطاعم',       date: '2026-05-10' },
    { id: 'dm-9',  amount: 2000,   desc: 'عمل إضافي',              cat: 'دخل إضافي',   date: '2026-05-12' },
    { id: 'dm-10', amount: -750,   desc: 'ملابس H&M',              cat: 'تسوق',        date: '2026-05-13' },
    { id: 'dm-11', amount: -45,    desc: 'نتفليكس وسبوتيفاي',      cat: 'ترفيه',       date: '2026-05-14' },
    { id: 'dm-12', amount: -210,   desc: 'صيدلية النهدي',          cat: 'صحة',         date: '2026-05-15' },
    { id: 'dm-13', amount: -165,   desc: 'ستاربكس',                cat: 'مطاعم',       date: '2026-05-17' },
    { id: 'dm-14', amount: -340,   desc: 'سوبرماركت التميمي',      cat: 'تسوق',        date: '2026-05-19' },
    { id: 'dm-15', amount: -95,    desc: 'أوبر',                   cat: 'مواصلات',     date: '2026-05-21' },
    // ── April 2026 ──
    { id: 'dm-16', amount: 12500,  desc: 'راتب شهر أبريل',        cat: 'راتب',        date: '2026-04-01' },
    { id: 'dm-17', amount: -3500,  desc: 'إيجار شهري',            cat: 'سكن',         date: '2026-04-02' },
    { id: 'dm-18', amount: -580,   desc: 'سوبرماركت',             cat: 'تسوق',        date: '2026-04-05' },
    { id: 'dm-19', amount: -240,   desc: 'مطاعم متنوعة',          cat: 'مطاعم',       date: '2026-04-08' },
    { id: 'dm-20', amount: -510,   desc: 'وقود',                  cat: 'مواصلات',     date: '2026-04-10' },
    { id: 'dm-21', amount: -420,   desc: 'فواتير المياه والكهرباء',cat: 'فواتير',      date: '2026-04-12' },
    { id: 'dm-22', amount: -45,    desc: 'اشتراكات رقمية',        cat: 'ترفيه',       date: '2026-04-14' },
    { id: 'dm-23', amount: -150,   desc: 'صيدلية',                cat: 'صحة',         date: '2026-04-18' },
    { id: 'dm-24', amount: -320,   desc: 'ملابس وإكسسوارات',      cat: 'تسوق',        date: '2026-04-22' },
    { id: 'dm-25', amount: -195,   desc: 'كافيهات',               cat: 'مطاعم',       date: '2026-04-25' },
    // ── March 2026 ──
    { id: 'dm-26', amount: 12500,  desc: 'راتب شهر مارس',         cat: 'راتب',        date: '2026-03-01' },
    { id: 'dm-27', amount: -3500,  desc: 'إيجار شهري',            cat: 'سكن',         date: '2026-03-02' },
    { id: 'dm-28', amount: 1500,   desc: 'مكافأة عمل',            cat: 'دخل إضافي',   date: '2026-03-05' },
    { id: 'dm-29', amount: -650,   desc: 'سوبرماركت',             cat: 'تسوق',        date: '2026-03-07' },
    { id: 'dm-30', amount: -310,   desc: 'مطاعم',                 cat: 'مطاعم',       date: '2026-03-10' },
    { id: 'dm-31', amount: -480,   desc: 'وقود',                  cat: 'مواصلات',     date: '2026-03-12' },
    { id: 'dm-32', amount: -390,   desc: 'فواتير',                cat: 'فواتير',      date: '2026-03-15' },
    { id: 'dm-33', amount: -45,    desc: 'اشتراكات',              cat: 'ترفيه',       date: '2026-03-18' },
    { id: 'dm-34', amount: -280,   desc: 'ملابس',                 cat: 'تسوق',        date: '2026-03-22' },
    { id: 'dm-35', amount: -175,   desc: 'مطاعم وكافيهات',        cat: 'مطاعم',       date: '2026-03-26' },
  ];

  const G = [
    { name: 'سيارة هوندا سيفيك', target: 45000, current: 12500, deadline: '2027-12-01' },
    { name: 'دفعة أولى للشقة',   target: 80000, current: 8000,  deadline: '2028-06-01' },
    { name: 'صندوق الطوارئ',     target: 25000, current: 15000, deadline: '2026-12-01' },
    { name: 'رحلة أوروبا',       target: 12000, current: 3500,  deadline: '2027-03-01' },
  ];

  const stmt = db.prepare('INSERT OR IGNORE INTO transactions (user_id, transaction_id, amount, description, category, transaction_date) VALUES (?, ?, ?, ?, ?, ?)');
  T.forEach(t => stmt.run([req.userId, t.id, t.amount, t.desc, t.cat, t.date]));
  stmt.finalize();

  // Only insert goals if none exist
  db.get('SELECT COUNT(*) as c FROM goals WHERE user_id = ?', [req.userId], (err, row) => {
    if (row && row.c === 0) {
      const gs = db.prepare('INSERT INTO goals (user_id, name, target_amount, current_amount, deadline) VALUES (?, ?, ?, ?, ?)');
      G.forEach(g => gs.run([req.userId, g.name, g.target, g.current, g.deadline]));
      gs.finalize();
    }
    res.json({ success: true });
  });
});

app.patch('/api/goals/:id', authenticateToken, (req, res) => {
  const { currentAmount } = req.body;
  db.run('UPDATE goals SET current_amount = ? WHERE id = ? AND user_id = ?',
    [currentAmount, req.params.id, req.userId],
    function(err) {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json({ success: true });
    });
});

app.delete('/api/goals/:id', authenticateToken, (req, res) => {
  db.run('DELETE FROM goals WHERE id = ? AND user_id = ?', [req.params.id, req.userId],
    function(err) {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json({ success: true });
    });
});

// ══════════════════════════════════════════════════════════
// FILE IMPORT — CSV / PDF → Gemini → Transactions
// ══════════════════════════════════════════════════════════

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
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
    // ── Extract text ──────────────────────────────────────
    if (ext === 'pdf') {
      const parsed = await pdfParse(req.file.buffer);
      rawText = parsed.text;
    } else {
      // CSV / TXT
      rawText = req.file.buffer.toString('utf8');
    }

    if (!rawText || rawText.trim().length < 10) {
      return res.status(400).json({ error: 'Could not extract text from file' });
    }

    // ── Send to Gemini ────────────────────────────────────
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

    const geminiRes = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] },
      { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
    );

    const aiText = geminiRes.data.candidates[0].content.parts[0].text;

    // Extract JSON array from response
    const match = aiText.match(/\[[\s\S]*\]/);
    if (!match) return res.status(422).json({ error: 'AI could not parse transactions from file', raw: aiText.slice(0, 500) });

    const transactions = JSON.parse(match[0]);
    if (!Array.isArray(transactions) || transactions.length === 0) {
      return res.status(422).json({ error: 'No transactions found in file' });
    }

    // ── Save to database ──────────────────────────────────
    const timestamp = Date.now();
    let inserted = 0;
    const stmt = db.prepare(
      'INSERT OR IGNORE INTO transactions (user_id, transaction_id, amount, description, category, transaction_date) VALUES (?, ?, ?, ?, ?, ?)'
    );
    transactions.forEach((t, i) => {
      if (!t.date || t.amount === undefined) return;
      const txId = `imp-${timestamp}-${i}`;
      stmt.run([req.userId, txId, parseFloat(t.amount), t.description || 'معاملة', t.category || 'أخرى', t.date]);
      inserted++;
    });
    stmt.finalize();

    res.json({ success: true, total: transactions.length, inserted, transactions: transactions.slice(0, 20) });

  } catch (err) {
    console.error('Import error:', err.message);
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

// ══════════════════════════════════════════════════════════
// START SERVER
// ══════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({ status: 'Maali API is running', version: '1.0.0' });
});

app.listen(PORT, () => {
  console.log(`🚀 Maali backend running on http://localhost:${PORT}`);
});
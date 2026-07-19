// Generates App Store screenshots (6.7" — 1290×2796) into store/screenshots/.
//
// Usage (from repo root, on a machine with internet):
//   npm i -D playwright && npx playwright install chromium
//   BASE_URL=https://maali-app.onrender.com EMAIL=you@x.com PASSWORD=... node scripts/store-screenshots.js
//
// EMAIL/PASSWORD must be an existing account with demo data loaded.
const path = require('path');
const fs = require('fs');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3100';
const EMAIL    = process.env.EMAIL    || 'demo@amad.sa';
const PASSWORD = process.env.PASSWORD || 'test123';

let chromium, launchOpts = {};
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('playwright-core'));
  launchOpts.executablePath = process.env.CHROME_PATH;
}

(async () => {
  const out = path.join(__dirname, '..', 'store', 'screenshots');
  fs.mkdirSync(out, { recursive: true });

  // --force-device-scale-factor guarantees true 3x rendering even on
  // chromium builds that ignore context-level deviceScaleFactor emulation
  const browser = await chromium.launch({ ...launchOpts, args: ['--no-sandbox', '--force-device-scale-factor=3'] });
  const page = await browser.newPage({
    viewport: { width: 430, height: 932 },   // ×3 = 1290×2796 (6.7-inch)
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  });

  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.fill('#loginEmail', EMAIL);
  await page.fill('#loginPassword', PASSWORD);
  await page.click('#loginBtn');
  await page.waitForSelector('#authPage.hidden', { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(4000); // charts + AI tips settle

  const shot = f => page.screenshot({ path: path.join(out, f) });

  await shot('01-dashboard.png');

  await page.click('.bnav-btn[data-page="challenges-page"]');
  await page.waitForTimeout(2500);
  await shot('02-challenges.png');

  await page.click('button:has-text("ابدأ الاختبار")');
  await page.waitForSelector('.quiz-opt', { timeout: 20000 });
  await page.waitForTimeout(400);
  await shot('03-quiz.png');
  await page.evaluate(() => document.getElementById('quizOverlay').classList.remove('open'));

  await page.click('.bnav-btn[data-page="expenses"]');
  await page.waitForTimeout(2500);
  await shot('04-budget.png');

  await page.click('.bnav-btn[data-page="goals-page"]');
  await page.waitForTimeout(1500);
  await shot('05-goals.png');

  await browser.close();
  console.log('✅ screenshots in store/screenshots/ (1290×2796)');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });

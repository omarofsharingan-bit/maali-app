# App Store Listing — مالي (Maali)

Ready-to-paste metadata for App Store Connect. Fill each field from here when
creating the app record.

## Basics

| Field | Value |
|---|---|
| App Name | مالي — إدارة مالية ذكية |
| Subtitle (30 chars) | مساعدك المالي بالذكاء الاصطناعي |
| Bundle ID | `sa.maali.app` (must match Xcode + your Apple Developer identifier) |
| Primary Category | Finance |
| Secondary Category | Productivity |
| Age Rating | 4+ |
| Price | Free |
| Privacy Policy URL | https://maali-app.onrender.com/privacy.html |
| Support URL | https://maali-app.onrender.com |

## Promotional Text (170 chars)

تتبع مصاريفك، حقق أهدافك، واسأل مساعدك المالي الذكي عن أي شيء في أموالك — مع تحديات ادخار أسبوعية ونقاط وأوسمة تجعل الادخار ممتعاً.

## Description (Arabic — primary)

مالي هو مساعدك المالي الشخصي الذكي، مصمم بالعربية ولأسلوب حياتك.

• اربط حسابك البنكي أو استورد كشف حسابك (PDF/CSV) وسيصنّف الذكاء الاصطناعي معاملاتك تلقائياً
• لوحة تحكم واضحة: دخلك، مصاريفك، مدخراتك، ونقاط صحتك المالية من 100
• مساعد ذكي يجيب فوراً على أسئلتك من أرقامك الحقيقية: «كم صرفت على المطاعم؟»
• ميزانية ذكية يقترحها الذكاء الاصطناعي لكل فئة، مع تنبيهات قبل التجاوز
• تحديات ادخار أسبوعية مولّدة من إنفاقك الفعلي — أكملها واكسب النقاط والأوسمة
• اختبار وعي مالي مخصص من بياناتك يرفع ثقافتك المالية
• أهداف ادخار بمتابعة مرئية: سيارة، شقة، صندوق طوارئ، سفر

بياناتك ملكك: كلمات المرور مشفّرة، ولا نبيع بياناتك أبداً، ويمكنك حذف حسابك وكل بياناتك بضغطة واحدة.

## Description (English — for the EN locale)

Maali is your Arabic-first AI money companion.

• Link your bank or import statements (PDF/CSV) — AI categorizes everything automatically
• A clear dashboard: income, spending, savings, and a 0-100 financial health score
• Ask the AI assistant anything about your own numbers and get instant answers
• Smart budgets suggested by AI per category, with overspend alerts
• Weekly saving challenges generated from your real spending — complete them to earn points and badges
• A personalized financial literacy quiz built from your own data
• Visual savings goals: car, home, emergency fund, travel

Your data is yours: encrypted passwords, never sold, and one-tap full account deletion.

## Keywords (100 chars, comma-separated)

ميزانية,مصاريف,ادخار,مالية,فلوس,تحديات,ذكاء اصطناعي,budget,expense,saving,finance,money

## App Privacy (questionnaire answers)

- **Data collected, linked to identity:**
  - Contact Info → Name, Email (account creation)
  - Financial Info → Other Financial Info (transactions the user adds/imports/syncs)
- **Data used for tracking:** None
- **Third parties:** transaction text is processed by Google Gemini for analysis
  features; not used to train models. Bank linking (optional) via Lean.

## App Review Information

- **Demo account:** create a fresh account in the review notes, or provide:
  email `demo@amad.sa` / password `test123` (make sure it exists on production
  with demo data loaded via the in-app «تجربة البيانات التجريبية» flow)
- **Notes for reviewer:** "Arabic-first personal finance app. Bank linking uses
  Lean sandbox in this build; all other features (import, AI analysis,
  challenges, budget) work with the demo data. Account deletion is on the
  dashboard footer."

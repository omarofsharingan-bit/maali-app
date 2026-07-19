# iOS Submission Guide — مالي

Everything in the repo is already prepared. When the Apple Developer membership
is paid, the remaining work is roughly **one evening on a Mac**.

## Already done (in this repo)

- ✅ Capacitor iOS project: `ios/` (Xcode project, Swift Package Manager — no CocoaPods needed)
- ✅ App icon + splash screens with Maali branding (`ios/App/App/Assets.xcassets`)
- ✅ Bundle ID `sa.maali.app`, display name «مالي», Arabic dev region
- ✅ Web assets build script: `npm run build:www`
- ✅ API auto-targets `https://maali-app.onrender.com` when running natively
- ✅ In-app account deletion (App Store guideline 5.1.1)
- ✅ Privacy policy at `/privacy.html` (required URL)
- ✅ App Store listing text: `store/app-store-metadata.md`
- ✅ 6.7" screenshots: `store/screenshots/` (regenerate below for final quality)

## Step 0 — Apple Developer Program (the $99)

1. https://developer.apple.com/programs/enroll → sign in with your Apple ID
2. Enroll as **Individual** ($99/year). Approval usually takes 24–48h.

## Step 1 — On a Mac: build & run

```bash
git clone https://github.com/omarofsharingan-bit/maali-app && cd maali-app
npm install
npm run ios:sync          # builds www/ and syncs it into the iOS project
npx cap open ios          # opens Xcode
```

In Xcode:
1. Select the **App** target → **Signing & Capabilities**
2. Check **Automatically manage signing**, pick your **Team** (appears after enrollment)
3. Plug in your iPhone → select it as the run target → press **▶**. The app
   installs and runs on your phone (this part works even during the free
   7-day personal-team signing if you want to test before enrollment finishes).

## Step 2 — Screenshots (final quality)

The committed screenshots were generated in a sandbox without CDN access, so
charts/icon fonts are missing in two of them. Regenerate perfect ones locally:

```bash
npm i -D playwright && npx playwright install chromium
BASE_URL=https://maali-app.onrender.com EMAIL=<demo email> PASSWORD=<demo pass> \
  node scripts/store-screenshots.js
```

Output: `store/screenshots/*.png` at exactly 1290×2796 (6.7-inch requirement).

## Step 3 — App Store Connect

1. https://appstoreconnect.apple.com → **My Apps → + → New App**
2. Platform iOS, Name/Bundle ID/SKU from `store/app-store-metadata.md`
3. Paste description, subtitle, keywords, promotional text from the same file
4. Upload the screenshots
5. Fill the **App Privacy** questionnaire using the answers in the metadata file
6. Add the demo account under **App Review Information**

## Step 4 — Archive & upload

In Xcode: **Product → Archive** → Organizer opens → **Distribute App →
App Store Connect → Upload** (defaults are fine). Wait ~15 min for processing,
select the build in App Store Connect, then **Submit for Review**.

Review typically takes 1–3 days.

## Rejection insurance (guideline 4.2 "minimum functionality")

Apple sometimes rejects web-wrapper apps. If that happens, add native touches
and resubmit — each is a small Capacitor plugin:

```bash
npm i @capacitor/push-notifications   # budget/challenge alerts
npm i @capacitor/haptics              # haptic feedback on badges
npm i @capacitor/app                  # deep links, app state
```

Mentioning offline support (the service worker) and Face ID (via
`capacitor-native-biometric`) in the review notes also helps.

## No Mac? Cloud options

- **MacinCloud / MacStadium** — rent a Mac by the hour, do Steps 1 & 4 there
- **GitHub Actions `macos-14` runner** — can build and upload with fastlane;
  more setup (certificates as secrets), worth it only if this becomes routine

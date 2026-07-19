// Assemble the web assets Capacitor bundles into the native app.
// Run before `npx cap sync ios`.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'www');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'icons'), { recursive: true });

for (const f of ['index.html', 'manifest.json', 'sw.js', 'privacy.html']) {
  fs.copyFileSync(path.join(root, f), path.join(out, f));
}
for (const f of fs.readdirSync(path.join(root, 'icons'))) {
  fs.copyFileSync(path.join(root, 'icons', f), path.join(out, 'icons', f));
}
console.log('✅ www/ ready');

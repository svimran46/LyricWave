/**
 * Every web file the app loads must be in the Android APK allowlist (android/app/build.gradle,
 * webAppFiles). A missing module 404s inside the app and stops app.js, so nothing responds to taps.
 */

import { readFileSync, existsSync } from 'node:fs';

let passed = 0;
let failed = 0;

function assert(condition, desc) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${desc}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${desc}`);
  }
}

console.log('--- Testing Android asset allowlist ---');

const gradle = readFileSync('android/app/build.gradle', 'utf8');
const listMatch = gradle.match(/def webAppFiles = \[([\s\S]*?)\]/);
assert(Boolean(listMatch), 'build.gradle declares webAppFiles');
const allowed = new Set(listMatch ? [...listMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : []);

// index.html entry points, then every relative static import reachable from them
const html = readFileSync('index.html', 'utf8');
const queue = [...html.matchAll(/<script[^>]*\ssrc="\.?\/?([^"]+\.js)"/g)].map((m) => m[1]);
const seen = new Set();
while (queue.length) {
  const file = queue.shift();
  if (seen.has(file)) continue;
  seen.add(file);
  if (!existsSync(file)) continue;
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/^\s*import\s[^'"]*['"]\.\/([^'"]+)['"]/gm)) queue.push(m[1]);
}

assert(seen.has('app.js'), 'index.html loads app.js');
for (const file of [...seen].sort()) {
  assert(allowed.has(file), `${file} is packed into the APK`);
}
assert(allowed.has('index.html') && allowed.has('styles.css'), 'index.html and styles.css are packed into the APK');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

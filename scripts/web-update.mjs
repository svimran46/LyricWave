#!/usr/bin/env node
/**
 * In-app web updates for the Android app (see android/.../WebUpdater.java).
 *
 *   node scripts/web-update.mjs keygen   one-time: create the signing key pair
 *   node scripts/web-update.mjs sync     copy the web files (repo root) into the Android assets
 *   node scripts/web-update.mjs build    zip + sign the web files into dist/web-update/
 *
 * The bundle holds the same files as android/app/src/main/assets/, taken from the repo root
 * (the root copy is the one the website and the APK are built from).
 *
 * build env:
 *   WEB_UPDATE_PRIVATE_KEY  PKCS#8 PEM of the signing key (GitHub secret). Without it the
 *                           bundle is built unsigned, which the app will refuse.
 *   WEB_VERSION             override the version (default: commit time of HEAD, in seconds;
 *                           the APK build stamps its own files the same way).
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS_DIR = join(ROOT, 'android', 'app', 'src', 'main', 'assets');
const PUBLIC_KEY_PATH = join(ROOT, 'android', 'web-update-public.pem');
const PRIVATE_KEY_PATH = join(ROOT, 'web-update-private.pem'); // gitignored
const OUT_DIR = join(ROOT, 'dist', 'web-update');

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(relative(ASSETS_DIR, full).split(sep).join('/'));
  }
  return out.sort();
}

/** [{ path, source }] — each Android asset, read from the repo root when it exists there. */
function bundleFiles() {
  return listFiles(ASSETS_DIR).map((path) => {
    const rootCopy = join(ROOT, ...path.split('/'));
    return { path, source: existsSync(rootCopy) ? rootCopy : join(ASSETS_DIR, ...path.split('/')) };
  });
}

function sync() {
  let changed = 0;
  for (const { path, source } of bundleFiles()) {
    const dest = join(ASSETS_DIR, ...path.split('/'));
    if (source === dest) continue;
    if (!readFileSync(source).equals(readFileSync(dest))) {
      copyFileSync(source, dest);
      console.log(`updated ${path}`);
      changed++;
    }
  }
  console.log(changed ? `${changed} file(s) synced into the Android assets.` : 'Android assets already up to date.');
}

// ---- minimal deterministic zip writer (deflate, fixed timestamps) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const DOS_TIME = 0;
  const DOS_DATE = (1 << 5) | 1; // 1980-01-01
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

function webVersion() {
  if (process.env.WEB_VERSION) return Number.parseInt(process.env.WEB_VERSION, 10);
  return Number.parseInt(execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: ROOT }).toString().trim(), 10);
}

function nativeVersionCode() {
  const gradle = readFileSync(join(ROOT, 'android', 'app', 'build.gradle'), 'utf8');
  const m = gradle.match(/versionCode\s+(\d+)/);
  if (!m) throw new Error('versionCode not found in android/app/build.gradle');
  return Number.parseInt(m[1], 10);
}

function build({ requireSignature }) {
  const version = webVersion();
  if (!Number.isSafeInteger(version) || version <= 0) throw new Error(`bad version ${version}`);
  const files = bundleFiles();
  if (!files.some((f) => f.path === 'index.html')) throw new Error('index.html missing from bundle');

  const bundle = zip(files.map(({ path, source }) => ({ name: path, data: readFileSync(source) })));
  const manifest = [
    `version=${version}`,
    // The page may call native bridge methods added up to this APK version.
    `minNativeVersion=${nativeVersionCode()}`,
    `sha256=${createHash('sha256').update(bundle).digest('hex')}`,
    `size=${bundle.length}`,
    ''
  ].join('\n');

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'web-bundle.zip'), bundle);
  writeFileSync(join(OUT_DIR, 'web-update.properties'), manifest);

  const pem = process.env.WEB_UPDATE_PRIVATE_KEY;
  if (pem) {
    const key = createPrivateKey(pem);
    const signature = sign('sha256', Buffer.from(manifest), key); // DER, what Java's SHA256withECDSA expects
    // Catch a secret that doesn't match the key compiled into the app before publishing.
    if (existsSync(PUBLIC_KEY_PATH)) {
      const pub = createPublicKey(readFileSync(PUBLIC_KEY_PATH));
      if (!verify('sha256', Buffer.from(manifest), pub, signature)) {
        throw new Error('WEB_UPDATE_PRIVATE_KEY does not match android/web-update-public.pem');
      }
    } else if (requireSignature) {
      throw new Error('android/web-update-public.pem is missing; run `node scripts/web-update.mjs keygen`');
    }
    writeFileSync(join(OUT_DIR, 'web-update.sig'), signature);
  } else if (requireSignature) {
    throw new Error('WEB_UPDATE_PRIVATE_KEY is not set');
  }

  console.log(`web bundle v${version}: ${files.length} files, ${bundle.length} bytes${pem ? ', signed' : ', UNSIGNED'}`);
  console.log(manifest.trim());
}

function keygen({ force }) {
  if (existsSync(PUBLIC_KEY_PATH) && !force) {
    console.error('android/web-update-public.pem already exists. Replacing it stops installed apps from');
    console.error('accepting updates until they get an APK with the new key. Re-run with --force to do it anyway.');
    process.exit(1);
  }
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  writeFileSync(PUBLIC_KEY_PATH, publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(PRIVATE_KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log(`Wrote ${relative(ROOT, PUBLIC_KEY_PATH)} (commit this) and ${relative(ROOT, PRIVATE_KEY_PATH)} (secret, gitignored).`);
  console.log('');
  console.log('Next:');
  console.log('  1. GitHub repo -> Settings -> Secrets and variables -> Actions -> New repository secret');
  console.log('     Name: WEB_UPDATE_PRIVATE_KEY   Value: the whole contents of web-update-private.pem');
  console.log('  2. Keep a backup of web-update-private.pem in your password manager, then delete it here.');
  console.log('  3. Commit android/web-update-public.pem and install the next APK once; after that, web');
  console.log('     changes pushed to main reach the app without a new APK.');
}

const [command, ...flags] = process.argv.slice(2);
try {
  if (command === 'sync') sync();
  else if (command === 'build') build({ requireSignature: flags.includes('--require-signature') });
  else if (command === 'keygen') keygen({ force: flags.includes('--force') });
  else {
    console.error('usage: node scripts/web-update.mjs <keygen [--force] | sync | build [--require-signature]>');
    process.exit(2);
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}

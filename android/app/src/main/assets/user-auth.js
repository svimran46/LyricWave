/**
 * LyricWave User Authentication Service
 * 
 * Manages user accounts (Sign Up, Log In, Log Out, Session State, User Preferences)
 * using client-side secure PBKDF2-SHA256 password hashing via Web Crypto API
 * and persistent storage (IndexedDB + localStorage session cache).
 */

const AUTH_DB_NAME = 'LyricWaveAuthDB';
const AUTH_DB_VERSION = 1;
const USERS_STORE = 'users';
const SESSION_KEY = 'lyricwave_current_user';

function openAuthDB() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(AUTH_DB_NAME, AUTH_DB_VERSION);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(USERS_STORE)) {
          const store = db.createObjectStore(USERS_STORE, { keyPath: 'email' });
          store.createIndex('email', 'email', { unique: true });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Generate cryptographically secure salt
 */
function generateSalt(length = 16) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Hash password using PBKDF2-SHA256
 */
async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits', 'deriveKey']
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode(salt),
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt']
  );

  const exported = await crypto.subtle.exportKey('raw', key);
  return Array.from(new Uint8Array(exported), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Get user by email from IndexedDB
 */
async function getUser(email) {
  const db = await openAuthDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(USERS_STORE, 'readonly');
      const store = tx.objectStore(USERS_STORE);
      const req = store.get(email.toLowerCase().trim());
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Save user to IndexedDB
 */
async function saveUser(user) {
  const db = await openAuthDB();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(USERS_STORE, 'readwrite');
      const store = tx.objectStore(USERS_STORE);
      const req = store.put(user);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Register a new user
 */
export async function signUp({ name, email, password }) {
  if (!email || !email.includes('@')) {
    throw new Error('Please enter a valid email address.');
  }
  if (!password || password.length < 6) {
    throw new Error('Password must be at least 6 characters long.');
  }

  const cleanEmail = email.toLowerCase().trim();
  const existing = await getUser(cleanEmail);
  if (existing) {
    throw new Error('An account with this email already exists. Please log in.');
  }

  const salt = generateSalt();
  const passwordHash = await hashPassword(password, salt);
  const displayName = (name || '').trim() || cleanEmail.split('@')[0];

  const newUser = {
    email: cleanEmail,
    displayName,
    salt,
    passwordHash,
    createdAt: Date.now(),
    preferences: {
      theme: 'aurora',
      wordReveal: true,
      fontScale: 1.0
    }
  };

  await saveUser(newUser);

  // Set active session
  const sessionUser = {
    email: newUser.email,
    displayName: newUser.displayName,
    createdAt: newUser.createdAt,
    preferences: newUser.preferences
  };

  localStorage.setItem(SESSION_KEY, JSON.stringify(sessionUser));
  return sessionUser;
}

/**
 * Log in an existing user
 */
export async function logIn({ email, password }) {
  if (!email || !password) {
    throw new Error('Please enter both email and password.');
  }

  const cleanEmail = email.toLowerCase().trim();
  const user = await getUser(cleanEmail);
  if (!user) {
    throw new Error('No account found with this email. Please sign up first.');
  }

  const hash = await hashPassword(password, user.salt);
  if (hash !== user.passwordHash) {
    throw new Error('Incorrect password. Please try again.');
  }

  const sessionUser = {
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt,
    preferences: user.preferences || {}
  };

  localStorage.setItem(SESSION_KEY, JSON.stringify(sessionUser));
  return sessionUser;
}

/**
 * Log out current user
 */
export function logOut() {
  localStorage.removeItem(SESSION_KEY);
}

/**
 * Get currently logged-in user
 */
export function getCurrentUser() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Update user preferences
 */
export async function updateUserPreferences(prefs) {
  const current = getCurrentUser();
  if (!current) return;

  current.preferences = { ...(current.preferences || {}), ...prefs };
  localStorage.setItem(SESSION_KEY, JSON.stringify(current));

  const user = await getUser(current.email);
  if (user) {
    user.preferences = current.preferences;
    await saveUser(user);
  }
}

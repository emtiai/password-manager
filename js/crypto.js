// Kryptografie: alles über die eingebaute WebCrypto-API, keine Fremdbibliotheken.
//
// Aufbau:
//   Tresor-Schlüssel (VK, zufällig, AES-256-GCM)  -> verschlüsselt die Einträge
//   Master-Passwort --PBKDF2-SHA256-->  KEK_pw     -> verschlüsselt (wrappt) den VK
//   Fingerabdruck  --WebAuthn PRF + HKDF--> KEK_bio -> wrappt den VK zusätzlich (optional)

const enc = new TextEncoder();
const dec = new TextDecoder();

export const PBKDF2_ITERATIONS = 600_000; // OWASP-Empfehlung für PBKDF2-HMAC-SHA256

const AAD_DATA = enc.encode('pw-tresor/v1/data');
const AAD_WRAP = enc.encode('pw-tresor/v1/vault-key');

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function toB64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromB64(str) {
  const s = atob(str);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

export async function deriveKeyFromPassword(password, salt, iterations = PBKDF2_ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

export async function deriveKeyFromPrf(prfOutput, salt) {
  const base = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('pw-tresor/v1/bio-kek') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

// Der VK muss "extractable" sein, damit er später (z. B. beim Aktivieren des
// Fingerabdrucks oder Ändern des Passworts) erneut gewrappt werden kann.
// Er existiert nur im Arbeitsspeicher, solange der Tresor entsperrt ist.
export function generateVaultKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function wrapVaultKey(vaultKey, kek) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.wrapKey('raw', vaultKey, kek, { name: 'AES-GCM', iv, additionalData: AAD_WRAP });
  return { iv: toB64(iv), ct: toB64(ct) };
}

// Wirft eine Exception, wenn der KEK falsch ist (GCM-Authentifizierung schlägt fehl).
export function unwrapVaultKey(wrapped, kek) {
  return crypto.subtle.unwrapKey(
    'raw',
    fromB64(wrapped.ct),
    kek,
    { name: 'AES-GCM', iv: fromB64(wrapped.iv), additionalData: AAD_WRAP },
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptJson(obj, key) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD_DATA }, key, enc.encode(JSON.stringify(obj)));
  return { iv: toB64(iv), ct: toB64(ct) };
}

export async function decryptJson(box, key) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv), additionalData: AAD_DATA }, key, fromB64(box.ct));
  return JSON.parse(dec.decode(pt));
}

// ---------- Passwort-Generator ----------

const SETS = {
  lower: 'abcdefghijkmnopqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digits: '23456789',
  symbols: '!#$%&*+-=?@_~.:;',
};
const AMBIGUOUS = { lower: 'l', upper: 'IO', digits: '01' };

function randInt(max) {
  // Gleichverteilt ohne Modulo-Bias (Rejection Sampling).
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return buf[0] % max;
}

export function generatePassword({ length = 20, lower = true, upper = true, digits = true, symbols = true, ambiguous = false } = {}) {
  const sets = Object.entries({ lower, upper, digits, symbols })
    .filter(([, on]) => on)
    .map(([name]) => SETS[name] + (ambiguous ? AMBIGUOUS[name] || '' : ''));
  if (!sets.length) sets.push(SETS.lower);
  const all = sets.join('');
  const chars = sets.map((s) => s[randInt(s.length)]); // mind. ein Zeichen pro Gruppe
  while (chars.length < length) chars.push(all[randInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.slice(0, Math.max(length, sets.length)).join('');
}

// Grobe Stärke-Schätzung in Bit (Zeichenvorrat × Länge), nur als Orientierung.
export function estimateBits(pw) {
  if (!pw) return 0;
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 33;
  const unique = new Set(pw).size;
  return Math.round(Math.log2(pool) * Math.min(pw.length, unique * 1.5));
}

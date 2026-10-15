// Tresor-Zustand: Anlegen, Entsperren, Speichern, Fingerabdruck, Export/Import.

import {
  PBKDF2_ITERATIONS, randomBytes, toB64, fromB64,
  deriveKeyFromPassword, deriveKeyFromPrf, generateVaultKey,
  wrapVaultKey, unwrapVaultKey, encryptJson, decryptJson,
} from './crypto.js';
import { loadVault, storeVault, deleteVault } from './storage.js';
import { registerBiometric, getBiometricSecret } from './webauthn.js';

const EXPORT_FORMAT = 'pw-tresor-export';

export const DEFAULT_SETTINGS = {
  autoLockMinutes: 5, // Inaktivität
  lockWhenHiddenSeconds: 60, // App im Hintergrund
  clipboardClearSeconds: 30,
  generator: { length: 20, lower: true, upper: true, digits: true, symbols: true, ambiguous: false },
};

let record = null; // verschlüsselter Datensatz, wie in IndexedDB
let vaultKey = null; // CryptoKey, nur solange entsperrt
let data = null; // { entries: [], settings: {} } im Klartext, nur solange entsperrt

export const isUnlocked = () => !!vaultKey;
export const hasBiometric = () => !!record?.bio;
export const entries = () => data?.entries ?? [];
export const settings = () => ({ ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) });

export async function init() {
  record = (await loadVault()) ?? null;
  return !!record;
}

async function persist() {
  record = { ...record, data: await encryptJson(data, vaultKey), updated: Date.now() };
  await storeVault(record);
}

export async function create(password) {
  const salt = randomBytes(16);
  const kek = await deriveKeyFromPassword(password, salt, PBKDF2_ITERATIONS);
  vaultKey = await generateVaultKey();
  data = { entries: [], settings: {} };
  record = {
    version: 1,
    kdf: { name: 'PBKDF2-SHA256', salt: toB64(salt), iterations: PBKDF2_ITERATIONS },
    pwWrap: await wrapVaultKey(vaultKey, kek),
    bio: null,
    created: Date.now(),
  };
  await persist();
}

async function openWith(key) {
  data = await decryptJson(record.data, key);
  data.entries ??= [];
  data.settings ??= {};
  vaultKey = key;
}

export async function unlockWithPassword(password) {
  const kek = await deriveKeyFromPassword(password, fromB64(record.kdf.salt), record.kdf.iterations);
  let key;
  try {
    key = await unwrapVaultKey(record.pwWrap, kek);
  } catch {
    throw new Error('Falsches Master-Passwort.');
  }
  await openWith(key);
}

export async function unlockWithBiometric() {
  const { credId, prfSalt, wrap } = record.bio;
  const prf = await getBiometricSecret(fromB64(credId), fromB64(prfSalt));
  const kek = await deriveKeyFromPrf(prf, fromB64(prfSalt));
  let key;
  try {
    key = await unwrapVaultKey(wrap, kek);
  } catch {
    throw new Error('Fingerabdruck-Schlüssel passt nicht. Bitte mit Master-Passwort entsperren und Fingerabdruck neu einrichten.');
  }
  await openWith(key);
}

export function lock() {
  vaultKey = null;
  data = null;
}

export async function enableBiometric() {
  const prfSalt = randomBytes(32);
  const { credId, prf } = await registerBiometric(prfSalt);
  const kek = await deriveKeyFromPrf(prf, prfSalt);
  record = { ...record, bio: { credId: toB64(credId), prfSalt: toB64(prfSalt), wrap: await wrapVaultKey(vaultKey, kek) } };
  await persist();
}

export async function disableBiometric() {
  record = { ...record, bio: null };
  await persist();
}

export async function verifyPassword(password) {
  const kek = await deriveKeyFromPassword(password, fromB64(record.kdf.salt), record.kdf.iterations);
  try {
    await unwrapVaultKey(record.pwWrap, kek);
    return true;
  } catch {
    return false;
  }
}

// Erzeugt einen komplett neuen Tresor-Schlüssel und verschlüsselt alle Daten damit neu.
// Dadurch nützt ein früher geknacktes/bekanntes Passwort nichts mehr für neue Daten.
// Der Fingerabdruck-Schlüssel gehört zum alten Tresor-Schlüssel und wird deshalb entfernt.
// Rückgabe: true, wenn der Fingerabdruck neu aktiviert werden muss.
async function rekey(password) {
  const hadBiometric = !!record.bio;
  const salt = randomBytes(16);
  const kek = await deriveKeyFromPassword(password, salt, PBKDF2_ITERATIONS);
  const newKey = await generateVaultKey();
  record = {
    ...record,
    kdf: { name: 'PBKDF2-SHA256', salt: toB64(salt), iterations: PBKDF2_ITERATIONS },
    pwWrap: await wrapVaultKey(newKey, kek),
    bio: null,
  };
  vaultKey = newKey;
  await persist();
  return hadBiometric;
}

export async function changePassword(oldPassword, newPassword) {
  if (!(await verifyPassword(oldPassword))) throw new Error('Aktuelles Master-Passwort ist falsch.');
  return rekey(newPassword);
}

export async function rotateKey(password) {
  if (!(await verifyPassword(password))) throw new Error('Master-Passwort ist falsch.');
  return rekey(password);
}

export async function destroy() {
  lock();
  record = null;
  await deleteVault();
}

// ---------- Einträge ----------

export async function upsertEntry(entry) {
  const now = Date.now();
  const i = data.entries.findIndex((e) => e.id === entry.id);
  if (i >= 0) data.entries[i] = { ...data.entries[i], ...entry, updated: now };
  else data.entries.push({ id: crypto.randomUUID(), created: now, updated: now, ...entry });
  await persist();
}

export async function removeEntry(id) {
  data.entries = data.entries.filter((e) => e.id !== id);
  await persist();
}

export async function touchEntry(id) {
  const e = data.entries.find((x) => x.id === id);
  if (!e) return;
  e.lastUsed = Date.now();
  await persist();
}

export async function saveSettings(patch) {
  data.settings = { ...data.settings, ...patch };
  await persist();
}

// ---------- Export / Import ----------

// Export ist genauso verschlüsselt wie der Tresor (nur Passwort-Wrap, ohne Fingerabdruck,
// da der Passkey an dieses Gerät gebunden ist).
export function exportEncrypted() {
  return JSON.stringify({
    format: EXPORT_FORMAT,
    version: 1,
    exported: new Date().toISOString(),
    kdf: record.kdf,
    pwWrap: record.pwWrap,
    data: record.data,
  }, null, 2);
}

function mergeEntries(incoming) {
  let added = 0;
  let updated = 0;
  for (const e of incoming) {
    if (!e || typeof e !== 'object') continue;
    const clean = {
      id: typeof e.id === 'string' ? e.id : crypto.randomUUID(),
      title: String(e.title ?? ''),
      username: String(e.username ?? ''),
      password: String(e.password ?? ''),
      url: String(e.url ?? ''),
      tags: String(e.tags ?? ''),
      notes: String(e.notes ?? ''),
      favorite: !!e.favorite,
      created: Number(e.created) || Date.now(),
      updated: Number(e.updated) || Date.now(),
      lastUsed: Number(e.lastUsed) || 0,
    };
    const i = data.entries.findIndex((x) => x.id === clean.id);
    if (i < 0) {
      data.entries.push(clean);
      added++;
    } else if (clean.updated > (data.entries[i].updated || 0)) {
      data.entries[i] = clean;
      updated++;
    }
  }
  return { added, updated };
}

export async function importEncrypted(text, password) {
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error('Datei ist kein gültiger Export.');
  }
  if (file?.format !== EXPORT_FORMAT) throw new Error('Datei ist kein PW-Tresor-Export.');
  const kek = await deriveKeyFromPassword(password, fromB64(file.kdf.salt), file.kdf.iterations);
  let key;
  try {
    key = await unwrapVaultKey(file.pwWrap, kek);
  } catch {
    throw new Error('Falsches Passwort für diese Export-Datei.');
  }
  const imported = await decryptJson(file.data, key);
  const result = mergeEntries(imported.entries ?? []);
  await persist();
  return result;
}

// CSV-Import (Chrome/Edge, Firefox, Bitwarden, KeePass-CSV …): erkennt typische Spaltennamen.
export async function importCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('CSV enthält keine Daten.');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => header.findIndex((h) => names.includes(h));
  const c = {
    title: col('name', 'title', 'titel', 'account'),
    url: col('url', 'login_uri', 'website', 'web site', 'origin'),
    username: col('username', 'login_username', 'user name', 'benutzername', 'login name', 'email'),
    password: col('password', 'login_password', 'passwort', 'kennwort'),
    notes: col('note', 'notes', 'notizen', 'extra', 'comments'),
  };
  if (c.password < 0) throw new Error('Keine Passwort-Spalte in der CSV gefunden.');
  const now = Date.now();
  const list = rows.slice(1).filter((r) => r.some((v) => v)).map((r) => {
    const get = (i) => (i >= 0 ? (r[i] ?? '') : '');
    const url = get(c.url);
    let title = get(c.title);
    if (!title && url) title = url.replace(/^https?:\/\//, '').split('/')[0];
    return { id: crypto.randomUUID(), title, url, username: get(c.username), password: get(c.password), notes: get(c.notes), created: now, updated: now };
  });
  const result = mergeEntries(list);
  await persist();
  return result;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  const sep = (s.split('\n')[0].match(/;/g) || []).length > (s.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(field); field = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

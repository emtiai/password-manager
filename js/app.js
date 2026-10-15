import * as V from './vault.js';
import { generatePassword, estimateBits } from './crypto.js';
import { extractDomains, matchEntries, normalizeHost } from './domain.js';
import { isBiometricAvailable, describeBiometricError } from './webauthn.js';
import { requestPersistence } from './storage.js';

const app = document.getElementById('app');
const isAndroid = /Android/i.test(navigator.userAgent);
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const state = {
  view: 'list',
  params: {},
  query: '',
  context: null, // { source: 'share' | 'camera', domains: [], words: [] }
  bioAvailable: false,
  stopCamera: null,
};

// ---------- DOM-Helfer (nur textContent, nie innerHTML mit Nutzerdaten) ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else if (v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ICONS = {
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
  camera: 'M3 8h4l2-3h6l2 3h4v12H3zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  plus: 'M12 5v14M5 12h14',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  back: 'M15 18l-6-6 6-6',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  eye: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10.9 10.9 0 0 1 12 5c7 0 11 7 11 7a18 18 0 0 1-3.2 3.9M6.6 6.6A18 18 0 0 0 1 12s4 7 11 7a10.6 10.6 0 0 0 5.4-1.5M9.9 9.9a3 3 0 0 0 4.2 4.2',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
  key: 'M15 7a4 4 0 1 1-3.5 6L4 20.5V17h3v-3h3l1.5-1.5A4 4 0 0 1 15 7z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  dice: 'M4 4h16v16H4zM9 9h.01M15 15h.01M15 9h.01M9 15h.01',
  ext: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  finger: 'M12 11v4m-4-6a4 4 0 0 1 8 0v5a8 8 0 0 1-1 4M6 11a6 6 0 0 1 12 0M4.5 15A13 13 0 0 1 4 11a8 8 0 0 1 16 0v1M8 13v1a10 10 0 0 0 1.5 5',
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name]);
  svg.append(p);
  return svg;
}

const iconBtn = (name, label, onclick, cls = '') => h('button', { class: `icon-btn ${cls}`, type: 'button', 'aria-label': label, title: label, onclick }, icon(name));

function toast(msg, ms = 2600) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

function dialog({ title, text, input, confirmLabel = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const field = input ? h('input', { type: input.type || 'password', placeholder: input.placeholder || '', autocomplete: 'off' }) : null;
    const dlg = h('dialog', { class: 'dialog' },
      h('form', { method: 'dialog' },
        h('h2', {}, title),
        text && h('p', {}, text),
        field,
        h('div', { class: 'row end' },
          h('button', { value: 'cancel', class: 'btn ghost', type: 'submit' }, 'Abbrechen'),
          h('button', { value: 'ok', class: `btn ${danger ? 'danger' : 'primary'}`, type: 'submit' }, confirmLabel))));
    dlg.addEventListener('close', () => {
      const ok = dlg.returnValue === 'ok';
      resolve(ok ? (field ? field.value : true) : null);
      dlg.remove();
    });
    document.body.append(dlg);
    dlg.showModal();
    field?.focus();
  });
}

function avatar(title) {
  const t = (title || '?').trim();
  let hash = 0;
  for (const ch of t) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  const el = h('span', { class: 'avatar' }, [...t][0]?.toUpperCase() || '?');
  el.style.setProperty('--hue', String(hash % 360)); // CSSOM statt style-Attribut (CSP)
  return el;
}

function busy(btn, fn) {
  return async (...args) => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('loading');
    try {
      await fn(...args);
    } finally {
      btn.disabled = false;
      btn.classList.remove('loading');
    }
  };
}

// ---------- Zwischenablage mit automatischem Leeren ----------

let clipTimer = null;
let clipPending = false;

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    toast('Kopieren nicht möglich.');
    return;
  }
  const secs = V.isUnlocked() ? V.settings().clipboardClearSeconds : 30;
  toast(`${label} kopiert${secs ? ` – wird nach ${secs}s geleert` : ''}`);
  navigator.vibrate?.(30);
  clearTimeout(clipTimer);
  if (secs) clipTimer = setTimeout(clearClipboard, secs * 1000);
}

async function clearClipboard() {
  // Browser erlauben das Schreiben nur, wenn die Seite den Fokus hat. Sonst beim
  // nächsten Zurückkehren in die App nachholen.
  if (!document.hasFocus()) {
    clipPending = true;
    return;
  }
  try {
    await navigator.clipboard.writeText('');
    clipPending = false;
  } catch {
    clipPending = true;
  }
}

// ---------- Navigation ----------

function go(view, params = {}, { push = true } = {}) {
  if (state.view === 'camera' && view !== 'camera') stopCamera();
  state.view = view;
  state.params = params;
  if (push) history.pushState({ view, params }, '');
  render();
  window.scrollTo(0, 0);
}

addEventListener('popstate', (e) => {
  const s = e.state;
  if (!V.isUnlocked()) return render();
  go(s?.view || 'list', s?.params || {}, { push: false });
});

// ---------- Auto-Sperre ----------

let lastActivity = Date.now();
let hiddenAt = null;

for (const ev of ['pointerdown', 'keydown', 'scroll', 'touchstart']) {
  addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true });
}

setInterval(() => {
  if (V.isUnlocked() && Date.now() - lastActivity > V.settings().autoLockMinutes * 60_000) lockNow();
}, 5000);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = Date.now();
    if (state.view === 'camera') stopCamera();
  } else {
    if (V.isUnlocked() && hiddenAt && Date.now() - hiddenAt > V.settings().lockWhenHiddenSeconds * 1000) lockNow();
    else if (state.view === 'camera') render();
    hiddenAt = null;
    if (clipPending) setTimeout(clearClipboard, 300);
  }
});
addEventListener('focus', () => { if (clipPending) clearClipboard(); });

function lockNow() {
  stopCamera();
  V.lock();
  state.query = '';
  history.replaceState({ view: 'list', params: {} }, '');
  state.view = 'list';
  render();
}

// ---------- Ansichten ----------

function render() {
  app.replaceChildren();
  document.body.dataset.view = V.isUnlocked() ? state.view : 'lock';
  if (!state.hasVault) return app.append(viewSetup());
  if (!V.isUnlocked()) return app.append(viewLock());
  const views = { list: viewList, detail: viewDetail, edit: viewEdit, settings: viewSettings, camera: viewCamera };
  app.append((views[state.view] || viewList)());
}

function header(title, { back = false, actions = [] } = {}) {
  return h('header', { class: 'topbar' },
    back ? iconBtn('back', 'Zurück', () => history.back()) : h('span', { class: 'brand' }, icon('key')),
    h('h1', {}, title),
    h('div', { class: 'actions' }, actions));
}

function strengthMeter(input) {
  const bar = h('div', { class: 'meter' }, h('span'));
  const label = h('small', { class: 'muted' });
  const update = () => {
    const bits = estimateBits(input.value);
    const pct = Math.min(100, (bits / 100) * 100);
    const level = bits < 40 ? 'weak' : bits < 70 ? 'ok' : 'strong';
    bar.dataset.level = level;
    bar.firstChild.style.width = `${pct}%`;
    label.textContent = input.value ? `ca. ${bits} Bit – ${{ weak: 'schwach', ok: 'mittel', strong: 'stark' }[level]}` : '';
  };
  input.addEventListener('input', update);
  update();
  return [bar, label];
}

function passwordInput(attrs = {}) {
  const input = h('input', { type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, ...attrs });
  const toggle = h('button', { type: 'button', class: 'icon-btn inset', 'aria-label': 'Anzeigen' }, icon('eye'));
  toggle.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.replaceChildren(icon(show ? 'eyeOff' : 'eye'));
  });
  return { input, wrap: h('div', { class: 'input-wrap' }, input, toggle) };
}

function viewSetup() {
  const pw1 = passwordInput({ placeholder: 'Master-Passwort', autocomplete: 'new-password' });
  const pw2 = passwordInput({ placeholder: 'Wiederholen', autocomplete: 'new-password' });
  const err = h('p', { class: 'error', role: 'alert' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Tresor anlegen');
  const form = h('form', { class: 'card stack' },
    h('p', {}, 'Wähle ein starkes Master-Passwort. Es verschlüsselt alle Daten und kann ',
      h('strong', {}, 'nicht wiederhergestellt'), ' werden. Tipp: 4–5 zufällige Wörter.'),
    pw1.wrap, ...strengthMeter(pw1.input), pw2.wrap, err, btn);
  form.addEventListener('submit', busy(btn, async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (pw1.input.value.length < 10) return void (err.textContent = 'Mindestens 10 Zeichen.');
    if (pw1.input.value !== pw2.input.value) return void (err.textContent = 'Passwörter stimmen nicht überein.');
    await V.create(pw1.input.value);
    state.hasVault = true;
    requestPersistence();
    history.replaceState({ view: 'list', params: {} }, '');
    state.view = 'list';
    render();
    if (state.bioAvailable) toast('Tipp: Fingerabdruck in den Einstellungen aktivieren.', 4000);
  }));
  return h('main', { class: 'center' }, h('div', { class: 'hero' }, icon('key'), h('h1', {}, 'PW Tresor')), form);
}

let autoBioTried = false;

function viewLock() {
  const pw = passwordInput({ placeholder: 'Master-Passwort', autocomplete: 'current-password' });
  const err = h('p', { class: 'error', role: 'alert' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Entsperren');
  const form = h('form', { class: 'card stack' }, pw.wrap, err, btn);
  const afterUnlock = () => {
    lastActivity = Date.now();
    history.replaceState({ view: 'list', params: {} }, '');
    state.view = 'list';
    render();
    if (state.pendingView) {
      go(state.pendingView);
      state.pendingView = null;
    }
  };
  form.addEventListener('submit', busy(btn, async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      await V.unlockWithPassword(pw.input.value);
      afterUnlock();
    } catch (ex) {
      err.textContent = ex.message;
      pw.input.select();
    }
  }));

  let bioBtn = null;
  if (V.hasBiometric()) {
    bioBtn = h('button', { class: 'btn bio block', type: 'button' }, icon('finger'), 'Mit Fingerabdruck entsperren');
    const tryBio = busy(bioBtn, async () => {
      err.textContent = '';
      try {
        await V.unlockWithBiometric();
        afterUnlock();
      } catch (ex) {
        if (ex.name !== 'NotAllowedError' && ex.name !== 'AbortError') err.textContent = describeBiometricError(ex);
      }
    });
    bioBtn.addEventListener('click', tryBio);
    // Android erlaubt den Fingerabdruck-Dialog direkt beim Start; iOS nur nach einem Tippen.
    if (isAndroid && !autoBioTried && document.visibilityState === 'visible') {
      autoBioTried = true;
      setTimeout(tryBio, 150);
    }
  } else {
    setTimeout(() => pw.input.focus(), 50);
  }

  const ctx = state.context?.domains?.[0];
  return h('main', { class: 'center' },
    h('div', { class: 'hero' }, icon('lock'), h('h1', {}, 'Gesperrt'), ctx && h('p', { class: 'muted' }, `Suche: ${ctx}`)),
    bioBtn, form);
}

function entryRow(e) {
  const quick = iconBtn('copy', 'Passwort kopieren', async (ev) => {
    ev.stopPropagation();
    await copy(e.password, 'Passwort');
    V.touchEntry(e.id);
  }, 'quick');
  return h('li', {},
    h('button', { class: 'entry', type: 'button', onclick: () => go('detail', { id: e.id }) },
      avatar(e.title),
      h('span', { class: 'entry-text' },
        h('span', { class: 'entry-title' }, e.title || '(ohne Titel)', e.favorite && h('span', { class: 'fav' }, ' ★')),
        h('span', { class: 'entry-sub' }, e.username || normalizeHost(e.url) || ''))),
    quick);
}

function entryList(list) {
  return h('ul', { class: 'entries' }, list.map(entryRow));
}

function searchEntries(all, q) {
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  return all.filter((e) => {
    const hay = `${e.title} ${e.username} ${e.url} ${e.tags}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
}

function contextCard(all) {
  const ctx = state.context;
  if (!ctx) return null;
  const matches = matchEntries(all, ctx.domains, ctx.words);
  const label = ctx.domains[0] || ctx.words[0] || 'Unbekannt';
  return h('section', { class: 'context card' },
    h('div', { class: 'row between' },
      h('h2', {}, `Passend zu ${label}`),
      iconBtn('plus', 'Schließen', () => { state.context = null; render(); }, 'close')),
    matches.length
      ? entryList(matches)
      : h('div', { class: 'stack' },
        h('p', { class: 'muted' }, 'Kein passender Eintrag gefunden.'),
        h('button', { class: 'btn', type: 'button', onclick: () => go('edit', { prefill: { title: label.split('.')[0].replace(/^./, (c) => c.toUpperCase()), url: ctx.domains[0] ? `https://${ctx.domains[0]}` : '' } }) }, `Eintrag für ${label} anlegen`)));
}

function viewList() {
  const all = V.entries();
  const search = h('input', {
    type: 'search', class: 'search', placeholder: `Suchen in ${all.length} Einträgen …`, value: state.query,
    autocomplete: 'off', autocapitalize: 'off', spellcheck: false, enterkeyhint: 'search',
  });
  const results = h('div');
  const fill = () => {
    const q = state.query.trim();
    results.replaceChildren();
    if (q) {
      const found = searchEntries(all, q).sort(byTitle);
      results.append(found.length ? entryList(found) : h('p', { class: 'muted pad' }, 'Nichts gefunden.'));
      return;
    }
    if (!all.length) {
      results.append(h('div', { class: 'empty' },
        h('p', {}, 'Noch keine Einträge.'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => go('edit', {}) }, icon('plus'), 'Ersten Eintrag anlegen'),
        h('p', { class: 'muted' }, 'Oder in den Einstellungen eine CSV aus Chrome, Firefox oder Bitwarden importieren.')));
      return;
    }
    const favs = all.filter((e) => e.favorite).sort(byTitle);
    const recent = all.filter((e) => e.lastUsed && !e.favorite).sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 5);
    if (favs.length) results.append(h('h2', { class: 'section' }, 'Favoriten'), entryList(favs));
    if (recent.length) results.append(h('h2', { class: 'section' }, 'Zuletzt verwendet'), entryList(recent));
    results.append(h('h2', { class: 'section' }, 'Alle'), entryList([...all].sort(byTitle)));
  };
  search.addEventListener('input', () => {
    state.query = search.value;
    fill();
  });
  fill();

  const installHint = !isStandalone && !sessionStorage.getItem('hideInstall')
    ? h('div', { class: 'hint card' },
      h('p', {}, isIOS
        ? 'Tipp: Über „Teilen“ → „Zum Home-Bildschirm“ als App installieren.'
        : 'Tipp: Über das Browser-Menü → „App installieren“ zum Startbildschirm hinzufügen.'),
      h('button', { class: 'btn ghost small', type: 'button', onclick: (ev) => { sessionStorage.setItem('hideInstall', '1'); ev.target.closest('.hint').remove(); } }, 'OK'))
    : null;

  return h('div', {},
    header('Tresor', {
      actions: [
        iconBtn('camera', 'Kamera-Erkennung', () => go('camera')),
        iconBtn('gear', 'Einstellungen', () => go('settings')),
        iconBtn('lock', 'Sperren', lockNow),
      ],
    }),
    h('main', { class: 'list' }, installHint, contextCard(all), search, results),
    h('button', { class: 'fab', type: 'button', 'aria-label': 'Neuer Eintrag', onclick: () => go('edit', {}) }, icon('plus')));
}

const byTitle = (a, b) => (a.title || '').localeCompare(b.title || '', 'de', { sensitivity: 'base' });

function field(label, value, { secret = false, copyLabel, mono = false } = {}) {
  if (!value) return null;
  const val = h('span', { class: `value ${mono ? 'mono' : ''}` }, secret ? '••••••••••' : value);
  let shown = false;
  const btns = [];
  if (secret) {
    const eye = iconBtn('eye', 'Anzeigen', () => {
      shown = !shown;
      val.replaceChildren(...(shown ? colorize(value) : ['••••••••••']));
      eye.replaceChildren(icon(shown ? 'eyeOff' : 'eye'));
    });
    btns.push(eye);
  }
  if (copyLabel) btns.push(iconBtn('copy', `${copyLabel} kopieren`, () => copy(value, copyLabel)));
  return h('div', { class: 'field' }, h('label', {}, label), h('div', { class: 'row between' }, val, h('div', { class: 'row' }, btns)));
}

// Ziffern und Sonderzeichen farbig, damit man das Passwort leichter abtippen kann.
function colorize(pw) {
  return [...pw].map((ch) => h('span', { class: /\d/.test(ch) ? 'c-digit' : /[a-zA-Z]/.test(ch) ? '' : 'c-sym' }, ch));
}

function safeHref(url) {
  if (!url) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

function viewDetail() {
  const e = V.entries().find((x) => x.id === state.params.id);
  if (!e) return viewList();
  const href = safeHref(e.url);
  const touch = () => V.touchEntry(e.id);
  const fav = iconBtn('star', e.favorite ? 'Favorit entfernen' : 'Als Favorit', async () => {
    await V.upsertEntry({ id: e.id, favorite: !e.favorite });
    render();
  }, e.favorite ? 'active' : '');
  const del = h('button', { class: 'btn danger ghost', type: 'button' }, 'Löschen');
  del.addEventListener('click', async () => {
    if (await dialog({ title: 'Eintrag löschen?', text: `„${e.title}“ wird endgültig gelöscht.`, confirmLabel: 'Löschen', danger: true })) {
      await V.removeEntry(e.id);
      toast('Gelöscht');
      history.back();
    }
  });
  const pwField = field('Passwort', e.password, { secret: true, copyLabel: 'Passwort', mono: true });
  pwField?.addEventListener('click', touch);
  return h('div', {},
    header(e.title || '(ohne Titel)', { back: true, actions: [fav, iconBtn('edit', 'Bearbeiten', () => go('edit', { id: e.id }), 'edit')] }),
    h('main', { class: 'stack' },
      h('div', { class: 'card stack' },
        field('Benutzer', e.username, { copyLabel: 'Benutzername' }),
        pwField,
        e.url && h('div', { class: 'field' }, h('label', {}, 'Webseite'),
          h('div', { class: 'row between' }, h('span', { class: 'value' }, e.url),
            href && h('a', { class: 'icon-btn', href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Öffnen', onclick: touch }, icon('ext')))),
        e.tags && field('Weitere Domains / Apps', e.tags),
        e.notes && h('div', { class: 'field' }, h('label', {}, 'Notizen'), h('p', { class: 'notes' }, e.notes))),
      h('div', { class: 'row between' },
        h('small', { class: 'muted' }, `Geändert: ${new Date(e.updated).toLocaleString('de-DE')}`),
        del)));
}

function generatorPanel(target) {
  const g = { ...V.settings().generator };
  const out = h('span', { class: 'mono value' });
  const len = h('input', { type: 'range', min: '8', max: '64', value: String(g.length) });
  const lenLabel = h('span', {}, String(g.length));
  const regen = () => {
    g.length = Number(len.value);
    lenLabel.textContent = len.value;
    out.replaceChildren(...colorize(generatePassword(g)));
  };
  const opt = (key, label) => {
    const cb = h('input', { type: 'checkbox', checked: g[key] });
    cb.addEventListener('change', () => { g[key] = cb.checked; regen(); });
    return h('label', { class: 'check' }, cb, label);
  };
  len.addEventListener('input', regen);
  regen();
  const panel = h('div', { class: 'generator card stack' },
    h('div', { class: 'row between' }, out, iconBtn('dice', 'Neu würfeln', regen)),
    h('label', { class: 'row' }, 'Länge ', lenLabel, len),
    h('div', { class: 'row wrap' }, opt('lower', 'a–z'), opt('upper', 'A–Z'), opt('digits', '0–9'), opt('symbols', '!#%'), opt('ambiguous', 'l/1/O/0 erlauben')),
    h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      target.value = out.textContent;
      target.type = 'text';
      target.dispatchEvent(new Event('input'));
      panel.remove();
      await V.saveSettings({ generator: g });
    } }, 'Übernehmen'));
  return panel;
}

function viewEdit() {
  const existing = state.params.id ? V.entries().find((x) => x.id === state.params.id) : null;
  const e = existing || { title: '', username: '', password: '', url: '', tags: '', notes: '', favorite: false, ...(state.params.prefill || {}) };
  const inp = (name, attrs = {}) => h('input', { name, value: e[name] || '', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, ...attrs });
  const title = inp('title', { required: true, autocapitalize: 'sentences', placeholder: 'z. B. Amazon' });
  const url = inp('url', { type: 'text', inputmode: 'url', placeholder: 'amazon.de' });
  const username = inp('username', { placeholder: 'E-Mail oder Benutzername' });
  const pw = passwordInput({ name: 'password', value: e.password || '' });
  const tags = inp('tags', { placeholder: 'z. B. amazon.com, primevideo.com, Prime' });
  const notes = h('textarea', { name: 'notes', rows: '3' }, e.notes || '');
  const fav = h('input', { type: 'checkbox', checked: !!e.favorite });
  const genSlot = h('div');
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Speichern');

  if (!existing && !e.password) pw.input.value = generatePassword(V.settings().generator);

  const form = h('form', { class: 'stack' },
    h('label', { class: 'field' }, 'Titel', title),
    h('label', { class: 'field' }, 'Webseite', url),
    h('label', { class: 'field' }, 'Benutzer', username),
    h('div', { class: 'field' }, h('label', {}, 'Passwort'),
      h('div', { class: 'row' }, pw.wrap, iconBtn('dice', 'Passwort generieren', () => {
        genSlot.firstChild ? genSlot.replaceChildren() : genSlot.replaceChildren(generatorPanel(pw.input));
      })),
      ...strengthMeter(pw.input), genSlot),
    h('label', { class: 'field' }, 'Weitere Domains / App-Namen', tags,
      h('small', { class: 'muted' }, 'Hilft der Kamera- und Teilen-Erkennung. Kommagetrennt.')),
    h('label', { class: 'field' }, 'Notizen', notes),
    h('label', { class: 'check' }, fav, 'Favorit'),
    btn);

  form.addEventListener('submit', busy(btn, async (ev) => {
    ev.preventDefault();
    const entry = {
      title: title.value.trim(),
      url: url.value.trim(),
      username: username.value.trim(),
      password: pw.input.value,
      tags: tags.value.trim(),
      notes: notes.value,
      favorite: fav.checked,
    };
    if (existing) entry.id = existing.id;
    await V.upsertEntry(entry);
    toast('Gespeichert');
    history.back();
  }));
  if (!existing) setTimeout(() => title.focus(), 50);
  return h('div', {}, header(existing ? 'Bearbeiten' : 'Neuer Eintrag', { back: true }), h('main', {}, form));
}

function viewSettings() {
  const s = V.settings();
  const section = (title, ...children) => h('section', { class: 'card stack' }, h('h2', {}, title), ...children);

  // Fingerabdruck
  const bioBtn = h('button', { class: 'btn', type: 'button' });
  let bioContent;
  if (V.hasBiometric()) {
    bioBtn.textContent = 'Fingerabdruck deaktivieren';
    bioBtn.addEventListener('click', busy(bioBtn, async () => {
      await V.disableBiometric();
      toast('Fingerabdruck deaktiviert');
      render();
    }));
    bioContent = [h('p', {}, '✅ Entsperren per Fingerabdruck ist aktiv.'), bioBtn];
  } else if (state.bioAvailable) {
    bioBtn.textContent = 'Fingerabdruck aktivieren';
    bioBtn.classList.add('primary');
    bioBtn.addEventListener('click', busy(bioBtn, async () => {
      try {
        await V.enableBiometric();
        toast('Fingerabdruck aktiviert');
        render();
      } catch (ex) {
        await dialog({ title: 'Fingerabdruck nicht aktiviert', text: describeBiometricError(ex) });
      }
    }));
    bioContent = [h('p', { class: 'muted' }, 'Erstellt einen Passkey auf diesem Gerät. Der Tresor wird dann mit einem Schlüssel entsperrt, den nur dein Fingerabdruck freigibt.'), bioBtn];
  } else {
    bioContent = [h('p', { class: 'muted' }, 'Auf diesem Gerät/Browser nicht verfügbar (benötigt HTTPS und eine Bildschirmsperre mit Fingerabdruck oder Face ID).')];
  }

  // Sperre & Zwischenablage
  const num = (key, label, options) => {
    const sel = h('select', {}, options.map(([v, l]) => h('option', { value: String(v), selected: s[key] === v }, l)));
    sel.addEventListener('change', () => V.saveSettings({ [key]: Number(sel.value) }));
    return h('label', { class: 'field' }, label, sel);
  };

  // Master-Passwort ändern
  const oldPw = passwordInput({ placeholder: 'Aktuelles Passwort', autocomplete: 'current-password' });
  const newPw = passwordInput({ placeholder: 'Neues Passwort', autocomplete: 'new-password' });
  const newPw2 = passwordInput({ placeholder: 'Neues Passwort wiederholen', autocomplete: 'new-password' });
  const pwErr = h('p', { class: 'error', role: 'alert' });
  const pwBtn = h('button', { class: 'btn', type: 'submit' }, 'Passwort ändern');
  const pwForm = h('form', { class: 'stack' }, oldPw.wrap, newPw.wrap, ...strengthMeter(newPw.input), newPw2.wrap, pwErr, pwBtn);
  pwForm.addEventListener('submit', busy(pwBtn, async (ev) => {
    ev.preventDefault();
    pwErr.textContent = '';
    if (newPw.input.value.length < 10) return void (pwErr.textContent = 'Mindestens 10 Zeichen.');
    if (newPw.input.value !== newPw2.input.value) return void (pwErr.textContent = 'Neue Passwörter stimmen nicht überein.');
    try {
      await V.changePassword(oldPw.input.value, newPw.input.value);
      toast('Master-Passwort geändert. Bitte neuen Export als Backup anlegen.', 4000);
      pwForm.reset();
    } catch (ex) {
      pwErr.textContent = ex.message;
    }
  }));

  // Export / Import
  const exportBtn = h('button', { class: 'btn', type: 'button' }, 'Verschlüsselten Export speichern');
  exportBtn.addEventListener('click', () => {
    const blob = new Blob([V.exportEncrypted()], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `pw-tresor-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });
  const fileInput = h('input', { type: 'file', accept: '.json,.csv,application/json,text/csv', hidden: true });
  const importBtn = h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, 'Importieren (Export-Datei oder CSV)');
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    const text = await file.text();
    try {
      let res;
      if (/\.csv$/i.test(file.name) || file.type === 'text/csv') {
        res = await V.importCsv(text);
      } else {
        const pw = await dialog({ title: 'Export-Datei entsperren', text: 'Master-Passwort, mit dem diese Datei exportiert wurde:', input: {}, confirmLabel: 'Importieren' });
        if (pw == null) return;
        res = await V.importEncrypted(text, pw);
      }
      toast(`${res.added} neu, ${res.updated} aktualisiert`, 3500);
    } catch (ex) {
      await dialog({ title: 'Import fehlgeschlagen', text: ex.message });
    }
  });

  const delBtn = h('button', { class: 'btn danger', type: 'button' }, 'Tresor auf diesem Gerät löschen');
  delBtn.addEventListener('click', async () => {
    const typed = await dialog({ title: 'Alles löschen?', text: 'Alle Einträge auf diesem Gerät werden unwiderruflich gelöscht. Zum Bestätigen LÖSCHEN eingeben.', input: { type: 'text', placeholder: 'LÖSCHEN' }, confirmLabel: 'Endgültig löschen', danger: true });
    if (typed?.trim().toUpperCase() !== 'LÖSCHEN') return;
    await V.destroy();
    state.hasVault = false;
    state.context = null;
    render();
  });

  const persistInfo = h('p', { class: 'muted' });
  navigator.storage?.persisted?.().then((p) => {
    persistInfo.textContent = p ? '✅ Speicher ist als dauerhaft markiert.' : '⚠️ Speicher nicht dauerhaft markiert – App installieren und regelmäßig exportieren.';
  });

  return h('div', {},
    header('Einstellungen', { back: true }),
    h('main', { class: 'stack' },
      section('Fingerabdruck', ...bioContent),
      section('Automatisch sperren',
        num('autoLockMinutes', 'Nach Inaktivität', [[1, '1 Minute'], [2, '2 Minuten'], [5, '5 Minuten'], [15, '15 Minuten'], [60, '1 Stunde']]),
        num('lockWhenHiddenSeconds', 'Wenn App im Hintergrund', [[0, 'Sofort'], [30, 'nach 30 Sekunden'], [60, 'nach 1 Minute'], [300, 'nach 5 Minuten']]),
        num('clipboardClearSeconds', 'Zwischenablage leeren', [[15, 'nach 15 Sekunden'], [30, 'nach 30 Sekunden'], [60, 'nach 1 Minute'], [0, 'nie']])),
      section('Backup', h('p', { class: 'muted' }, 'Der Export ist mit deinem Master-Passwort verschlüsselt. Bewahre ihn z. B. in der Cloud oder auf einem USB-Stick auf.'),
        exportBtn, importBtn, fileInput, persistInfo),
      section('Master-Passwort ändern', pwForm),
      section('Gefahrenzone', delBtn),
      h('p', { class: 'muted center-text' }, `PW Tresor · ${V.entries().length} Einträge · alles lokal auf diesem Gerät`)));
}

// ---------- Kamera ----------

function stopCamera() {
  state.cameraActive = false;
  state.stopCamera?.();
  state.stopCamera = null;
}

function viewCamera() {
  const video = h('video', { autoplay: true, muted: true, playsinline: true });
  const status = h('p', { class: 'cam-status' }, 'Kamera wird gestartet …');
  const chips = h('div', { class: 'chips' });
  const results = h('div', { class: 'cam-results' });
  const seen = new Set();
  const all = V.entries();

  const showResult = (domains, words) => {
    chips.replaceChildren(...domains.slice(0, 5).map((d) => h('button', {
      class: 'chip', type: 'button',
      onclick: () => {
        state.context = { source: 'camera', domains: [d], words: [] };
        go('list');
      },
    }, d)));
    const matches = matchEntries(all, domains, words);
    if (matches.length) {
      results.replaceChildren(entryList(matches.slice(0, 5)));
      const key = matches[0].id;
      if (!seen.has(key)) {
        seen.add(key);
        navigator.vibrate?.(60);
      }
    }
    return matches.length;
  };

  (async () => {
    try {
      const { startCamera, getWorker, recognize } = await import('./ocr.js');
      state.stopCamera = await startCamera(video);
      state.cameraActive = true;
      status.textContent = 'Texterkennung wird geladen …';
      await getWorker((m) => {
        if (m.status && m.progress != null && state.cameraActive) status.textContent = `Lade Texterkennung … ${Math.round(m.progress * 100)}%`;
      });
      status.textContent = 'Adresszeile oder Logo in den Rahmen halten';
      while (state.cameraActive && state.view === 'camera' && V.isUnlocked()) {
        const t0 = performance.now();
        const { domains, words } = await recognize(video);
        if (!state.cameraActive) break;
        const n = showResult(domains, words);
        status.textContent = n ? `${n} Treffer – antippen für Details` : domains.length ? `Erkannt: ${domains[0]} – kein Eintrag` : 'Suche …';
        await new Promise((r) => setTimeout(r, Math.max(300, 1200 - (performance.now() - t0))));
      }
    } catch (ex) {
      stopCamera();
      status.textContent = ex.name === 'NotAllowedError' ? 'Kamerazugriff verweigert.' : (ex.message || 'Kamera nicht verfügbar.');
    }
  })();

  return h('div', { class: 'camera' },
    header('Kamera-Erkennung', { back: true }),
    h('div', { class: 'viewport' }, video, h('div', { class: 'frame' })),
    status, chips, results,
    h('p', { class: 'muted pad' }, 'Funktioniert für Seiten auf einem anderen Bildschirm (PC, Laptop, TV). Für Apps auf diesem Handy: „Teilen“ → PW Tresor oder die Suche verwenden.'));
}

// ---------- Teilen-Ziel (Web Share Target) ----------

function readShareParams() {
  if (location.hash === '#kamera') {
    state.pendingView = 'camera'; // App-Verknüpfung "Kamera-Erkennung"
    history.replaceState(null, '', location.pathname + location.search);
  }
  const p = new URLSearchParams(location.search);
  const raw = [p.get('url'), p.get('text'), p.get('title')].filter(Boolean).join(' ');
  if (!raw) return;
  const domains = extractDomains(raw);
  const words = (p.get('title') || '').split(/\s+/).filter((w) => w.length >= 4);
  if (domains.length || words.length) state.context = { source: 'share', domains, words };
  history.replaceState(null, '', location.pathname);
}

// ---------- Start ----------

async function start() {
  readShareParams();
  state.bioAvailable = await isBiometricAvailable();
  state.hasVault = await V.init();
  history.replaceState({ view: 'list', params: {} }, '');
  render();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

start().catch((err) => {
  app.replaceChildren(h('main', { class: 'center' }, h('p', { class: 'error' }, `Fehler beim Start: ${err.message}`)));
});

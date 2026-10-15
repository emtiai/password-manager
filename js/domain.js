// Domain-Erkennung und Zuordnung von Einträgen zu Webseiten/Apps.

const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'co.at', 'or.at', 'gv.at',
  'co.jp', 'com.br', 'com.tr', 'co.za', 'com.mx', 'co.in', 'com.cn', 'com.hk', 'com.sg',
]);

// Bewusst begrenzte Liste: filtert OCR-Rauschen wie "fi1e.xyzq" heraus.
const KNOWN_TLDS = new Set(('de com net org io at ch eu info biz app dev co me tv uk fr it es nl be pl cz se dk no fi '
  + 'us ca au jp cn ru gov edu online shop store cloud ai gg xyz tech site page email bank ly to li lu ie pt gr hu sk '
  + 'si hr ro bg tr in br mx nz za kr tw hk sg berlin hamburg koeln nrw bayern').split(' '));

export function normalizeHost(input) {
  if (!input) return '';
  let s = String(input).trim().toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = 'https://' + s;
  try {
    return new URL(s).hostname.replace(/^www\d?\./, '').replace(/\.$/, '');
  } catch {
    return '';
  }
}

export function baseDomain(host) {
  const h = normalizeHost(host);
  if (!h || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const last2 = parts.slice(-2).join('.');
  return MULTI_PART_SUFFIXES.has(last2) ? parts.slice(-3).join('.') : last2;
}

// Zieht Domains aus freiem Text (geteilte URL, OCR-Ergebnis).
export function extractDomains(text) {
  if (!text) return [];
  const cleaned = String(text)
    .toLowerCase()
    .replace(/[․‧·•]/g, '.') // OCR: Punkt-ähnliche Zeichen
    .replace(/\s*\.\s*/g, '.') // "amazon . de" -> "amazon.de"
    .replace(/[|\\]/g, 'l');
  const found = new Map();
  const re = /(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24}))(?![a-z0-9-])/g;
  for (const m of cleaned.matchAll(re)) {
    const tld = m[2];
    const tldOk = KNOWN_TLDS.has(tld) || MULTI_PART_SUFFIXES.has(m[1].split('.').slice(-2).join('.'));
    if (!tldOk) continue;
    const d = baseDomain(m[1]);
    if (d && d.split('.')[0].length >= 2) found.set(d, (found.get(d) || 0) + 1);
  }
  return [...found.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
}

function entryKeys(entry) {
  const keys = new Set();
  const add = (v) => {
    const d = baseDomain(v);
    if (d) keys.add(d);
  };
  if (entry.url) add(entry.url);
  for (const t of String(entry.tags || '').split(/[,\s]+/)) {
    if (!t) continue;
    if (t.includes('.')) add(t);
    keys.add(t.toLowerCase());
  }
  return keys;
}

/**
 * Bewertet Einträge gegen erkannte Domains und (optional) erkannte Wörter.
 * Wörter helfen z. B., wenn die Kamera nur ein Logo/einen Namen wie "PayPal" liest.
 */
export function matchEntries(entries, domains = [], words = []) {
  const domainSet = new Set(domains.map(baseDomain).filter(Boolean));
  const labelSet = new Set([...domainSet].map((d) => d.split('.')[0]));
  const wordSet = new Set(words.map((w) => w.toLowerCase()).filter((w) => w.length >= 4));
  const scored = [];
  for (const e of entries) {
    const keys = entryKeys(e);
    const title = String(e.title || '').toLowerCase();
    let score = 0;
    for (const k of keys) {
      if (domainSet.has(k)) score = Math.max(score, 100);
      else if (labelSet.has(k.split('.')[0])) score = Math.max(score, 60);
      else if (wordSet.has(k.split('.')[0])) score = Math.max(score, 40);
    }
    if (!score && title) {
      for (const l of labelSet) if (l.length >= 3 && title.includes(l)) score = Math.max(score, 50);
      for (const w of wordSet) if (title === w || title.split(/\s+/).includes(w)) score = Math.max(score, 30);
    }
    if (score) scored.push({ entry: e, score });
  }
  return scored.sort((a, b) => b.score - a.score || (b.entry.lastUsed || 0) - (a.entry.lastUsed || 0)).map((s) => s.entry);
}

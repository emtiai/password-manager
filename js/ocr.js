// Kamera + Texterkennung (Tesseract.js, lokal mitgeliefert unter /vendor).
// Alles läuft auf dem Gerät, kein Bild verlässt das Handy.

import { extractDomains } from './domain.js';

const BASE = new URL('../vendor/tesseract/', import.meta.url).href;

let workerPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Texterkennung konnte nicht geladen werden.'));
    document.head.append(s);
  });
}

export function getWorker(onProgress) {
  workerPromise ??= (async () => {
    await loadScript(BASE + 'tesseract.min.js');
    const worker = await window.Tesseract.createWorker('eng', 1 /* LSTM_ONLY */, {
      workerPath: BASE + 'worker.min.js',
      corePath: BASE + 'core',
      langPath: BASE + 'lang',
      workerBlobURL: false,
      gzip: true,
      logger: (m) => onProgress?.(m),
    });
    await worker.setParameters({
      tessedit_pageseg_mode: '11', // verstreuter Text (Adresszeile, Login-Seite, Logo-Schriftzug)
      user_defined_dpi: '300',
    });
    return worker;
  })().catch((err) => {
    workerPromise = null;
    throw err;
  });
  return workerPromise;
}

export async function startCamera(video) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Kamera wird in diesem Browser nicht unterstützt.');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  });
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play();
  return () => {
    for (const t of stream.getTracks()) t.stop();
    video.srcObject = null;
  };
}

// Schneidet den markierten Bereich (mittleres Band) aus, vergrößert ihn und
// wandelt ihn in Graustufen mit erhöhtem Kontrast um. Das verbessert die Erkennung deutlich.
function grabFrame(video, band = 0.4) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const sh = Math.round(vh * band);
  const sy = Math.round((vh - sh) / 2);
  const scale = Math.min(2, 1600 / vw);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vw * scale);
  canvas.height = Math.round(sh * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, sy, vw, sh, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = img.data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) {
    const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    px[i] = g;
    sum += g;
  }
  const mean = sum / (px.length / 4);
  for (let i = 0; i < px.length; i += 4) {
    const v = Math.max(0, Math.min(255, (px[i] - mean) * 1.6 + 128));
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export async function recognize(video) {
  if (!video.videoWidth) return { domains: [], words: [], text: '' };
  const worker = await getWorker();
  const { data } = await worker.recognize(grabFrame(video));
  const text = data.text || '';
  const words = [...new Set(
    (data.words || [])
      .filter((w) => w.confidence > 60)
      .map((w) => w.text.toLowerCase().replace(/[^a-z0-9äöüß-]/g, ''))
      .filter((w) => w.length >= 4),
  )];
  return { domains: extractDomains(text), words, text };
}

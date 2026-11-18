// Arquivos de vídeo (chips) e ícones de plataformas em pixel art. Usados na esteira (2D) e na cena (WebGL).
// Os ícones de plataforma são aproximações desenhadas em código, não os arquivos oficiais das marcas.
import { drawText } from './pixelfont.js';
import { ICONS as BRANDS } from './platformIcons.js';

export const CHIP_W = 20, CHIP_H = 14;
const PAL = ['#35e0ff', '#8b6cff', '#ffb347', '#3df5a0', '#ff7ac8', '#7da7ff'];
const R = (g, c, x, y, w, h) => { g.fillStyle = c; g.fillRect(x, y, w, h); };

const hash = (s) => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
export const jobColor = (id) => PAL[hash(id) % PAL.length];
export const shortId = (id) => id.replace(/^job[-_]?/i, '').replace(/[^a-z0-9]/gi, '').slice(-4).toUpperCase() || '?';

const dim = (hex, f) => { const n = parseInt(hex.slice(1), 16); return `rgb(${(n >> 16) * f | 0},${((n >> 8) & 255) * f | 0},${(n & 255) * f | 0})`; };

// Miniatura opcional (data:image ou caminho do mesmo servidor, validado no EventManager).
const thumbs = new Map();
function thumbFor(job) {
  if (!job.thumb) return null;
  let t = thumbs.get(job.id);
  if (!t) { t = { img: new Image(), ok: false }; t.img.onload = () => { t.ok = true; }; t.img.onerror = () => { t.ok = false; }; t.img.src = job.thumb; thumbs.set(job.id, t); }
  return t.ok ? t.img : null;
}

/** mode: 'normal' | 'ready' (saída pendente) | 'blocked' (falha). */
export function drawChip(g, x, y, job, mode = 'normal') {
  const col = mode === 'blocked' ? '#ff4d5e' : jobColor(job.id);
  R(g, '#05070c', x, y, CHIP_W, CHIP_H);
  R(g, dim(col, 0.55), x + 1, y + 1, CHIP_W - 2, CHIP_H - 2);
  R(g, '#0a0d14', x + 1, y + 1, 3, 6); for (let i = 0; i < 3; i++) R(g, col, x + 2, y + 2 + i * 2, 1, 1); // furos de filme
  R(g, '#0a0d14', x + 5, y + 1, CHIP_W - 6, 6);
  const img = thumbFor(job);
  if (img && mode !== 'blocked') { g.imageSmoothingEnabled = false; g.drawImage(img, x + 5, y + 1, CHIP_W - 6, 6); }
  else { R(g, '#ffffff', x + 10, y + 2, 1, 4); R(g, '#ffffff', x + 11, y + 3, 1, 2); R(g, '#ffffff', x + 12, y + 3, 1, 1); } // ▶
  R(g, col, x + 1, y + 7, CHIP_W - 2, 1);
  R(g, '#0a0d14', x + 1, y + 8, CHIP_W - 2, 5);
  drawText(g, shortId(job.id), x + 2, y + 8, '#e8ecf5');
  if (mode === 'blocked') { g.fillStyle = '#ff4d5e'; for (let i = 0; i < 5; i++) { g.fillRect(x + 8 + i, y + 1 + i, 1, 1); g.fillRect(x + 12 - i, y + 1 + i, 1, 1); } }
  if (mode === 'ready') { R(g, '#3df5a0', x + CHIP_W - 4, y - 2, 5, 5); R(g, '#05070c', x + CHIP_W - 3, y - 1, 3, 3); R(g, '#3df5a0', x + CHIP_W - 2, y - 1, 1, 3); }
}

// Logos reais (simple-icons) rasterizadas em 12x12 sem antialias: o contorno vira pixel art.
const tiles = new Map();
export function platformTile(id) { return tile(id); }
function tile(id) {
  let c = tiles.get(id); if (c) return c;
  c = document.createElement('canvas'); c.width = c.height = 12; tiles.set(id, c);
  const g = c.getContext('2d'), b = BRANDS[id];
  const bg = b ? '#' + b.hex : '#4a5678';
  const light = b && parseInt(b.hex, 16) > 0xd0d000;
  if (id === 'instagram') for (let y = 0; y < 12; y++) R(g, y < 4 ? '#833ab4' : y < 8 ? '#e1306c' : '#fcaf45', 0, y, 12, 1);
  else R(g, b && b.hex === '000000' ? '#0a0a0a' : bg, 0, 0, 12, 12);
  const glyph = light ? '#0a0a0a' : '#ffffff';
  if (b) {
    const t = document.createElement('canvas'); t.width = t.height = 12;
    const tg = t.getContext('2d'); tg.translate(1, 1); tg.scale(10 / 24, 10 / 24); tg.fill(new Path2D(b.path));
    const d = tg.getImageData(0, 0, 12, 12).data;
    g.fillStyle = glyph;
    for (let i = 0; i < 144; i++) if (d[i * 4 + 3] > 110) g.fillRect(i % 12, (i / 12) | 0, 1, 1);
  } else drawText(g, id[0], 6, 3, '#e8ecf5', 'c');
  for (const [x, y] of [[0, 0], [11, 0], [0, 11], [11, 11]]) g.clearRect(x, y, 1, 1); // cantos arredondados
  return c;
}

/** Ícone 12x12 da plataforma + selo de estado (waiting | publishing | published | failed). */
export function drawPlatform(g, id, x, y, state = 'waiting', t = 0) {
  g.save();
  g.globalAlpha = state === 'waiting' ? 0.75 : 1;
  R(g, '#05070c', x - 1, y - 1, 14, 14);
  g.imageSmoothingEnabled = false; g.drawImage(tile(id), x, y);
  g.restore();
  const bx = x + 8, by = y + 8;
  if (state === 'waiting') return;
  R(g, '#05070c', bx - 1, by - 1, 6, 6);
  if (state === 'publishing') R(g, Math.floor(t * 4) % 2 ? '#35e0ff' : '#1d7a8c', bx, by, 4, 4);
  else if (state === 'published') { R(g, '#3df5a0', bx, by, 4, 4); R(g, '#05070c', bx, by + 2, 1, 1); R(g, '#05070c', bx + 1, by + 3, 1, 1); R(g, '#05070c', bx + 2, by + 2, 1, 1); R(g, '#05070c', bx + 3, by + 1, 1, 1); }
  else { R(g, '#ff4d5e', bx, by, 4, 4); R(g, '#05070c', bx, by, 1, 1); R(g, '#05070c', bx + 3, by, 1, 1); R(g, '#05070c', bx + 1, by + 1, 2, 2); R(g, '#05070c', bx, by + 3, 1, 1); R(g, '#05070c', bx + 3, by + 3, 1, 1); }
}

// Arte estática procedural: mesa/cadeira/props, plaqueta, brilho e fundo (piso, parede, neon).
import { drawText, textWidth } from './pixelfont.js';
import { STATUS_COLOR } from './MonitorRenderer.js';

export const CELL_W = 120, CELL_H = 104;
export const MON_POS = { x: 34, y: 2 };
export const WORKER_POS = { x: 40, y: 44 };
export const PLAQUE = { x: 14, y: 95, w: 92, h: 9 };

export const mkCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const R = (g, c, x, y, w, h) => { g.fillStyle = c; g.fillRect(x, y, w, h); };

/** Mesa + cadeira + teclado + mouse + props + sombra (camada estática). */
export function drawDeskBase(index) {
  const c = mkCanvas(CELL_W, CELL_H), g = c.getContext('2d');
  // sombras projetadas
  g.fillStyle = 'rgba(0,0,0,.38)';
  g.fillRect(12, 42, 104, 44); g.fillRect(40, 84, 46, 14);
  // cadeira (atrás do funcionário): encosto, assento, rodízios
  R(g, '#05070c', 34, 74, 52, 20); R(g, '#1b2236', 35, 75, 50, 18); R(g, '#2a3350', 36, 76, 48, 3); R(g, '#141a2b', 38, 82, 44, 9);
  R(g, '#05070c', 52, 94, 16, 5); R(g, '#2a3350', 53, 94, 14, 3);
  R(g, '#05070c', 46, 98, 4, 3); R(g, '#05070c', 70, 98, 4, 3);
  // mesa: tampo, quina clara, frente, pernas
  R(g, '#05070c', 7, 33, 106, 49);
  R(g, '#2c3652', 8, 34, 104, 40); R(g, '#37446a', 8, 34, 104, 2); R(g, '#242d46', 8, 70, 104, 4);
  R(g, '#181e31', 8, 74, 104, 6); R(g, '#242d46', 8, 74, 104, 1);
  R(g, '#05070c', 10, 80, 6, 4); R(g, '#05070c', 104, 80, 6, 4);
  // linhas de luz do tampo e cabos
  g.fillStyle = 'rgba(255,255,255,.04)'; for (let x = 14; x < 108; x += 18) g.fillRect(x, 36, 1, 34);
  R(g, '#10141f', 57, 36, 2, 10);
  // mousepad, teclado, mouse
  R(g, '#161c2c', 80, 48, 17, 16); R(g, '#05070c', 43, 51, 34, 10); R(g, '#1c2338', 44, 52, 32, 8);
  for (let kx = 45; kx < 75; kx += 3) for (let ky = 53; ky < 59; ky += 2) R(g, '#4a5678', kx, ky, 2, 1);
  R(g, '#05070c', 85, 52, 7, 9); R(g, '#3d486a', 86, 53, 5, 7); R(g, '#6b7ba6', 88, 53, 1, 3);
  // props que identificam cada mesa
  const props = [
    () => { R(g, '#05070c', 14, 44, 9, 9); R(g, '#e8ecf5', 15, 45, 7, 7); R(g, '#7a4a2a', 16, 46, 5, 3); }, // caneca
    () => { R(g, '#05070c', 13, 43, 14, 18); R(g, '#e8ecf5', 14, 44, 12, 16); R(g, '#8fa6d1', 16, 47, 8, 1); R(g, '#8fa6d1', 16, 50, 8, 1); }, // bloco
    () => { R(g, '#05070c', 14, 42, 10, 10); R(g, '#2f9e6b', 16, 43, 6, 5); R(g, '#7a4a2a', 17, 48, 4, 3); R(g, '#3dd68c', 17, 43, 2, 2); }, // planta
    () => { R(g, '#05070c', 13, 46, 8, 13); R(g, '#1b1b24', 14, 47, 6, 11); R(g, '#35e0ff', 15, 48, 4, 8); }, // celular
    () => { R(g, '#05070c', 13, 41, 12, 10); R(g, '#ffb347', 14, 42, 10, 8); R(g, '#e8ecf5', 14, 42, 4, 3); }, // post-its
    () => { R(g, '#05070c', 13, 44, 10, 10); R(g, '#e0558f', 14, 45, 8, 4); R(g, '#e8ecf5', 14, 49, 8, 4); }, // marmita
  ];
  props[index % props.length]();
  return c;
}

/** Brilho do monitor sobre a mesa (aditivo), em degraus pixelados. */
export function drawGlow() {
  const c = mkCanvas(64, 40), g = c.getContext('2d');
  for (let i = 0; i < 5; i++) {
    g.fillStyle = `rgba(255,255,255,${0.1 + i * 0.12})`;
    const w = 64 - i * 11, h = 40 - i * 7;
    g.beginPath(); g.ellipse(32, 20, w / 2, h / 2, 0, 0, 7); g.fill();
  }
  return c;
}

/** Plaqueta do chão com número, nome e LED de atividade (redesenhada ao mudar estado). */
export function drawPlaque(g, desk, index, view, t) {
  const { w, h } = PLAQUE;
  g.clearRect(0, 0, w, h);
  R(g, '#05070c', 0, 0, w, h); R(g, '#1a2136', 1, 1, w - 2, h - 2); R(g, '#2a3452', 1, 1, w - 2, 1);
  const col = STATUS_COLOR[view.status];
  const blink = view.status === 'idle' || view.status === 'completed' || Math.floor(t * 4) % 2 === 0;
  g.globalAlpha = blink ? 1 : 0.35; R(g, col, 3, 2, 5, 5); g.globalAlpha = 1;
  R(g, 'rgba(255,255,255,.35)', 4, 3, 1, 1);
  drawText(g, `${String(index + 1).padStart(2, '0')} ${desk.short}`, 11, 2, '#c8d4f0');
  const tag = { idle: 'LIVRE', queued: 'FILA', working: 'ATIVO', completed: 'PRONTO', cancelled: 'CANCEL', error: 'ERRO' }[view.status];
  drawText(g, tag, w - 3, 2, col, 'r');
}

/** Anel de seleção/hover (retângulo vazado de cantos). */
export function drawSelection(color) {
  const c = mkCanvas(CELL_W, CELL_H), g = c.getContext('2d');
  g.fillStyle = color;
  const L = 10;
  for (const [x, y, sx, sy] of [[1, 1, 1, 1], [CELL_W - 2, 1, -1, 1], [1, CELL_H - 2, 1, -1], [CELL_W - 2, CELL_H - 2, -1, -1]]) {
    g.fillRect(sx > 0 ? x : x - L + 1, y, L, 1); g.fillRect(x, sy > 0 ? y : y - L + 1, 1, L);
    if (sx < 0) g.fillRect(x, y, 1, 1);
  }
  return c;
}

const hash2 = (x, y) => ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0) % 100;

/** Fundo completo: piso, parede, neon, plantas, tapetes e poças de luz sob cada estação. */
export function drawBackground(w, h, layout) {
  const c = mkCanvas(w, h), g = c.getContext('2d');
  const wall = layout.wallH;
  // piso
  R(g, '#0f131d', 0, 0, w, h);
  for (let y = wall; y < h; y += 16) for (let x = 0; x < w; x += 16) {
    const odd = ((x >> 4) + (y >> 4)) & 1;
    R(g, odd ? '#121725' : '#10151f', x, y, 16, 16);
    if (hash2(x, y) < 12) R(g, 'rgba(255,255,255,.025)', x + 3, y + 5, 5, 1);
    R(g, 'rgba(0,0,0,.25)', x, y, 16, 1); R(g, 'rgba(0,0,0,.25)', x, y, 1, 16);
  }
  // tapete + luz por estação
  for (const cell of layout.cells) {
    const x = cell.x - 6, y = cell.y - 4, cw = CELL_W + 12, ch = CELL_H + 6;
    R(g, 'rgba(0,0,0,.35)', x + 2, y + 3, cw, ch);
    R(g, '#161d30', x, y, cw, ch); R(g, '#1c2540', x + 2, y + 2, cw - 4, ch - 4); R(g, '#222d4d', x + 2, y + 2, cw - 4, 1);
    g.fillStyle = 'rgba(53,224,255,.05)'; g.beginPath(); g.ellipse(cell.x + CELL_W / 2, cell.y + 40, 70, 44, 0, 0, 7); g.fill();
  }
  // parede
  R(g, '#0a0d15', 0, 0, w, wall);
  for (let x = 0; x < w; x += 24) R(g, '#0e1320', x, 0, 23, wall - 4);
  R(g, '#05070c', 0, wall - 4, w, 4); R(g, '#1f2a47', 0, wall - 4, w, 1);
  R(g, 'rgba(0,0,0,.5)', 0, wall, w, 3);
  // faixa neon + letreiro
  const mid = w >> 1;
  const sign = mkCanvas(80, 7), sg = sign.getContext('2d');
  drawText(sg, 'FABRICA DE CLIPE', 0, 1, '#ffffff');
  const tw = textWidth('FABRICA DE CLIPE'), sw = tw * 2, sx = mid - sw / 2 | 0, sy = layout.cols === 2 ? 36 : 7;
  g.imageSmoothingEnabled = false;
  R(g, 'rgba(53,224,255,.10)', sx - 10, sy - 3, sw + 20, 22);
  R(g, '#05070c', sx - 5, sy - 2, sw + 10, 18); R(g, '#35e0ff', sx - 5, sy - 2, sw + 10, 1); R(g, '#35e0ff', sx - 5, sy + 15, sw + 10, 1);
  g.save(); g.globalAlpha = 0.45; g.drawImage(sign, 0, 0, tw, 7, sx + 1, sy + 1, sw, 14); g.restore();
  const tint = mkCanvas(80, 7), tg = tint.getContext('2d');
  tg.drawImage(sign, 0, 0); tg.globalCompositeOperation = 'source-in'; tg.fillStyle = '#7df1ff'; tg.fillRect(0, 0, 80, 7);
  g.drawImage(tint, 0, 0, tw, 7, sx, sy, sw, 14);
  // pôsteres laterais e plantas
  const poster = (px, kind) => {
    R(g, '#05070c', px, 5, 22, 28); R(g, '#141b30', px + 1, 6, 20, 26);
    if (kind) { R(g, '#8b6cff', px + 4, 10, 14, 10); R(g, '#05070c', px + 9, 12, 1, 6); R(g, '#ffffff', px + 10, 13, 3, 4); R(g, '#35e0ff', px + 4, 24, 14, 1); }
    else for (let i = 0; i < 9; i++) R(g, '#3df5a0', px + 3 + i * 2, 20 - (hash2(i, 3) % 9), 1, 4 + hash2(i, 3) % 9);
  };
  if (mid - sw / 2 > 70) { poster(20, 1); poster(w - 42, 0); }
  const plant = (px) => { R(g, '#05070c', px, 24, 12, 18); R(g, '#2a2f45', px + 2, 34, 8, 8); R(g, '#1f7a52', px + 1, 25, 10, 10); R(g, '#3dd68c', px + 3, 24, 3, 5); R(g, '#3dd68c', px + 7, 27, 3, 4); };
  if (w > 260) { plant(2); plant(w - 14); }
  // luz de teto nas pontas da parede
  R(g, 'rgba(255,255,255,.04)', 0, 0, w, 2);
  return c;
}

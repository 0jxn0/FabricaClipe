// Sprites procedurais em pixel art. Interface de troca: { LOOKS, SPRITE_W, SPRITE_H, drawWorker(ctx, look, pose) }.
// Para usar spritesheets de arquivo basta reimplementar drawWorker; eventos/animação não mudam.
export const SPRITE_W = 40;
export const SPRITE_H = 52;
const OUT = '#0a0d14';

export const LOOKS = {
  rafa:   { skin: '#d9a066', hair: '#1b1b24', style: 'short',  shirt: '#6a4cc9', shade: '#4d36a0', accent: '#35e0ff', phones: true },
  bia:    { skin: '#f1c7a0', hair: '#d2493b', style: 'long',   shirt: '#1fa6a0', shade: '#16807b', accent: '#ffd36b' },
  leo:    { skin: '#8d5a3b', hair: '#2a1a14', style: 'curly',  shirt: '#e0b83c', shade: '#b8932a', accent: '#2a1a14' },
  duda:   { skin: '#f6d9c0', hair: '#3b82f6', style: 'bun',    shirt: '#e8782f', shade: '#bd5c1e', accent: '#35e0ff', phones: true },
  marcos: { skin: '#5c3a28', hair: '#2f9e6b', style: 'beanie', shirt: '#e6ebf2', shade: '#b4bccb', accent: '#2f9e6b' },
  nina:   { skin: '#e2b184', hair: '#e8c05a', style: 'pony',   shirt: '#e0558f', shade: '#b43a6d', accent: '#ffffff', cap: true },
};

const lighten = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.min(255, Math.round(c + (255 - c) * a));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
};

/** pose: { br, turn(-1|0|1), dx, dy, blink, mode: 'type'|'rest'|'raise'|'face', lh, rh (offset dos braços) } */
export function drawWorker(ctx, look, pose) {
  const ops = [];
  const r = (x, y, w, h, c) => ops.push([x, y, w, h, c]);
  const rr = (x, y, w, h, c) => { r(x + 1, y, w - 2, h, c); r(x, y + 1, w, h - 2, c); };
  const { br, turn, dx, dy, mode } = pose;
  const hx = 20 + dx, hy = 20 + dy + br;

  // torso
  rr(8, 25 + br, 24, 17 - br, look.shirt);
  r(10, 36, 20, 6, look.shade);
  r(8, 27 + br, 2, 12, look.shade); r(30, 27 + br, 2, 12, look.shade);
  if (look.style === 'long') r(13, 27 + br, 14, 8, look.hair); // cabelo caído nas costas
  if (look.style === 'pony') { r(18, 27 + br, 4, 7, look.hair); r(19, 34 + br, 2, 3, look.hair); }

  // braços
  const arm = (side, off) => {
    const ax = side < 0 ? 7 : 29; // ombro
    if (mode === 'raise') { // comemorando: braços para cima
      const x = side < 0 ? 3 : 33, w = pose.wave ? 1 : 0;
      r(side < 0 ? 4 : 32, 22, 4, 6, look.shirt);
      r(x, 8 + w, 4, 15 - w, look.shirt); r(x, 4 + w, 4, 4, look.skin);
      return;
    }
    if (mode === 'face') { // mãos na cabeça
      const x = side < 0 ? 10 : 26;
      r(ax, 24, 4, 7, look.shirt); r(x, 15, 4, 11, look.shirt); r(side < 0 ? 11 : 25, 12, 4, 4, look.skin);
      return;
    }
    if (mode === 'rest') { // mãos no colo/teclado, quietas
      const hxp = side < 0 ? 13 : 23;
      r(ax, 24, 4, 7, look.shirt); r(Math.min(ax, hxp), 22, Math.abs(hxp - ax) + 4, 4, look.shirt);
      r(hxp, 13 + off, 4, 10 - off, look.shirt); r(hxp, 10 + off, 4, 3, look.skin);
      return;
    }
    const hxp = side < 0 ? 12 : 24; // digitando
    r(ax, 24, 4, 7, look.shirt); r(Math.min(ax, hxp), 22, Math.abs(hxp - ax) + 4, 4, look.shirt);
    r(hxp, 11 + off, 4, 12 - off, look.shirt); r(hxp, 7 + off, 4, 4, look.skin);
  };
  arm(-1, pose.lh); arm(1, pose.rh);

  // cabeça
  rr(hx - 7, hy - 7, 14, 14, look.hair);
  r(hx - 4, hy - 6, 6, 2, lighten(look.hair, 0.35));
  if (look.style === 'curly') { r(hx - 8, hy - 4, 16, 8, look.hair); r(hx - 6, hy - 8, 12, 2, look.hair); }
  if (look.style === 'bun') { rr(hx - 3, hy - 11, 7, 6, look.hair); r(hx - 1, hy - 10, 3, 1, lighten(look.hair, 0.4)); }
  if (look.style === 'beanie') { rr(hx - 8, hy - 8, 16, 12, look.accent); r(hx - 8, hy + 2, 16, 3, lighten(look.accent, 0.3)); r(hx - 1, hy - 10, 3, 3, lighten(look.accent, 0.5)); }
  if (look.cap) { r(hx - 6, hy - 10, 12, 4, look.accent); r(hx - 5, hy - 11, 10, 2, look.shirt); }
  if (look.phones) { r(hx - 8, hy - 6, 16, 2, look.accent); r(hx - 9, hy - 3, 3, 7, look.accent); r(hx + 6, hy - 3, 3, 7, look.accent); }
  if (turn === 0) { if (!look.phones && look.style !== 'beanie') { r(hx - 8, hy, 2, 3, look.skin); r(hx + 6, hy, 2, 3, look.skin); } }
  else {
    const fx = turn > 0 ? hx + 3 : hx - 7; // rosto de perfil
    r(fx, hy - 3, 4, 8, look.skin);
    if (!pose.blink) r(turn > 0 ? fx + 2 : fx + 1, hy - 1, 1, 2, OUT);
    else r(turn > 0 ? fx + 1 : fx, hy, 2, 1, OUT);
  }

  ctx.clearRect(0, 0, SPRITE_W, SPRITE_H);
  ctx.fillStyle = OUT;
  for (const [x, y, w, h] of ops) ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  for (const [x, y, w, h, c] of ops) { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); }
}

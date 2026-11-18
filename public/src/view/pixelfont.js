// Fonte bitmap 3x5 para textos dentro da cena (monitores, plaquetas). Sem antialias.
const G = {
  A: '111101111101101', B: '110101110101110', C: '111100100100111', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '111100101101111', H: '101101111101101', I: '111010010010111', J: '001001001101111',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '111101101101111',
  P: '111101111100100', Q: '111101101111001', R: '111101110101101', S: '111100111001111', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111',
  0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111', 4: '101101111001001',
  5: '111100111001111', 6: '111100111101111', 7: '111001001010010', 8: '111101111101111', 9: '111101111001111',
  '.': '000000000000010', ':': '000010000010000', '-': '000000111000000', '%': '101001010100101', '/': '001001010100100',
  '!': '010010010000010', '?': '111001011000010', _: '000000000000111', '+': '000010111010000', ',': '000000000010100',
  '#': '101111101111101', '>': '100010001010100', ' ': '000000000000000',
};

export const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
export const textWidth = (s) => Math.max(0, norm(s).length * 4 - 1);

/** Desenha texto em (x,y) = canto superior esquerdo. align: 'l' | 'c' | 'r'. */
export function drawText(ctx, str, x, y, color, align = 'l') {
  const s = norm(str);
  let cx = align === 'c' ? x - Math.floor(textWidth(s) / 2) : align === 'r' ? x - textWidth(s) : x;
  ctx.fillStyle = color;
  for (const ch of s) {
    const g = G[ch] ?? G['?'];
    for (let i = 0; i < 15; i++) if (g[i] === '1') ctx.fillRect(cx + (i % 3), y + ((i / 3) | 0), 1, 1);
    cx += 4;
  }
}

export function fit(str, maxChars) {
  const s = norm(str);
  return s.length <= maxChars ? s : s.slice(0, Math.max(0, maxChars - 1)) + '.';
}

/** Quebra em até `lines` linhas de `maxChars`. */
export function wrap(str, maxChars, lines) {
  const words = norm(str).split(/\s+/).filter(Boolean);
  const out = []; let cur = '';
  for (let w of words) {
    while (w.length > maxChars) { if (cur) { out.push(cur); cur = ''; } out.push(w.slice(0, maxChars)); w = w.slice(maxChars); }
    if (!cur) cur = w; else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w; else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  if (out.length > lines) { out.length = lines; out[lines - 1] = fit(out[lines - 1] + '..', maxChars); }
  return out;
}

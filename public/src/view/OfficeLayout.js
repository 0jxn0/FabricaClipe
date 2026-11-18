// Geometria do escritório em "pixels de arte". Só números, sem three.js nem DOM.
import { CELL_W, CELL_H } from './art.js';

export const DESK_COUNT = 6;
export const PIPE_COUNT = 6;
export const PIPE_T = 16;                                   // espessura do cano
export const PIPE_LEN = (cols) => (cols === 2 ? 30 : 40);   // comprimento visível (o resto fica fora da tela)
export const pipeReserve = (cols) => (cols === 2 ? 0 : PIPE_LEN(cols) + 6); // desktop: coluna à direita; mobile: canos no teto
export const wallFor = (cols) => (cols === 2 ? 60 : 44);
const WALL_H = 44, MARGIN = 3, MIN_GAP_X = 2, MIN_GAP_Y = 2;

export const rowsFor = (cols) => Math.ceil(DESK_COUNT / cols);

/** Tamanho mínimo (art px) necessário para a grade cols x rows. */
export function minSize(cols) {
  return { w: cols * (CELL_W + MIN_GAP_X) + MARGIN * 2 + pipeReserve(cols), h: wallFor(cols) + rowsFor(cols) * (CELL_H + MIN_GAP_Y) + MARGIN };
}

/** Distribui as 6 estações em cols x rows, centralizadas e com espaço extra repartido (limitado). */
export function computeLayout(viewW, viewH, cols) {
  const rows = rowsFor(cols);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const gridW = viewW - pipeReserve(cols);
  const pitchX = clamp((gridW - MARGIN * 2) / cols, CELL_W + MIN_GAP_X, CELL_W + 16);
  const pitchY = clamp((viewH - wallFor(cols) - MARGIN) / rows, CELL_H + MIN_GAP_Y, CELL_H + 30);
  const left = Math.floor((gridW - pitchX * cols) / 2);
  const top = wallFor(cols) + Math.floor((viewH - wallFor(cols) - pitchY * rows) / 2);
  const cells = [];
  for (let i = 0; i < DESK_COUNT; i++) {
    const c = i % cols, r = Math.floor(i / cols);
    cells.push({
      index: i,
      x: Math.floor(left + c * pitchX + (pitchX - CELL_W) / 2),
      y: Math.floor(top + r * pitchY + (pitchY - CELL_H) / 2),
      w: CELL_W, h: CELL_H,
    });
  }
  const last = cells[cells.length - 1], gTop = cells[0].y, span = last.y + CELL_H - gTop, len = PIPE_LEN(cols);
  const pipes = Array.from({ length: PIPE_COUNT }, (_, i) => {
    if (cols === 2) { // celular: canos pendurados no teto, boca para baixo
      const gap = Math.min(40, (viewW - 14) / PIPE_COUNT), x = Math.round(viewW / 2 + (i - (PIPE_COUNT - 1) / 2) * gap);
      return { vertical: true, sx: x - PIPE_T / 2, sy: 0, w: PIPE_T, h: len, mouth: { x, y: len - 5 } };
    }
    const pitch = Math.min(26, span / PIPE_COUNT), y = Math.round(gTop + span / 2 + (i - (PIPE_COUNT - 1) / 2) * pitch);
    return { vertical: false, sx: viewW - len, sy: y - PIPE_T / 2, w: len, h: PIPE_T, mouth: { x: viewW - len + 5, y } }; // saem da borda direita
  });
  return { cols, rows, wallH: wallFor(cols), cells, pipes, viewW };
}

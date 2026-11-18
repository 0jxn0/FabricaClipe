// Canos à direita do escritório: um por rede social. Recebem o arquivo arremessado e piscam com o resultado real.
import { mkCanvas } from './art.js';
import { drawText } from './pixelfont.js';
import { platformTile } from './chips.js';

const R = (g, c, x, y, w, h) => { g.fillStyle = c; g.fillRect(x, y, w, h); };
const FLASH = 0.8;
const T = 16; // espessura

/** Desenha em coordenadas "horizontais" (x ao longo do cano, boca em x=0); no modo vertical o cano pende do teto com a boca embaixo. */
function drawPipe(g, w, h, vertical, platform, mode, t, count) {
  g.clearRect(0, 0, w, h);
  const L = vertical ? h : w;
  const r = (c, x, y, ww, hh) => (vertical ? R(g, c, y, L - x - ww, hh, ww) : R(g, c, x, y, ww, hh));
  r('rgba(0,0,0,.35)', 4, 14, L - 4, 2);
  r('#05070c', 4, 0, L - 4, 15);
  [['#8a9bcb', 1], ['#6676a6', 1], ['#4d5c8a', 3], ['#3b4870', 4], ['#2b3558', 3], ['#1d2542', 2]].reduce((y, [c, hh]) => { r(c, 5, y, L - 5, hh); return y + hh; }, 1);
  for (let x = 30; x < L - 2; x += 40) { r('#05070c', x - 1, 0, 5, 15); r('#7384b5', x, 1, 3, 13); r('#a9b9e3', x, 1, 1, 13); } // flange
  r('#05070c', 0, 2, 9, 12); r('#05070c', 1, 1, 7, 14);                                                  // boca
  r('#9aabd8', 1, 2, 6, 12); r('#9aabd8', 2, 1, 4, 14);
  const glow = { pending: '#35e0ff', ok: '#3df5a0', fail: '#ff4d5e', idle: '#0a0d14' }[mode];
  const k = mode === 'pending' ? 0.45 + 0.4 * Math.sin(t * 6) : mode === 'idle' ? 1 : 0.65 + 0.35 * Math.sin(t * 22);
  r('#05070c', 2, 3, 4, 10); g.globalAlpha = k; r(glow, 2, 3, 4, 10); g.globalAlpha = 1;
  g.imageSmoothingEnabled = false;
  const n = String(count), txt = count > 0;
  if (vertical) { // logo e contador empilhados, boca embaixo
    const ty = L - 10 - 12 - 1; R(g, '#05070c', 1, ty - 1, 14, 14); g.drawImage(platformTile(platform), 2, ty);
    if (txt) drawText(g, n, 8, ty - 7, '#3df5a0', 'c');
  } else {
    R(g, '#05070c', 11, 1, 14, 14); g.drawImage(platformTile(platform), 12, 2);
    if (txt && 27 + n.length * 4 <= L) { R(g, '#05070c', 26, 5, n.length * 4 + 1, 7); drawText(g, n, 27, 5.5 | 0, '#3df5a0'); }
  }
}

export class PipeManager {
  constructor(scene, platforms) {
    this.scene = scene; this.platforms = platforms; this.count = () => 0;
    this.pipes = new Map(platforms.map((p) => [p, { sprite: null, w: 0, h: 0, x: 0, y: 0, landing: new Set(), awaiting: new Set(), final: new Map(), flash: null, flashT: -9, dirty: true, T: 0 }]));
  }

  /** geometry: layout.pipes (posição, tamanho, orientação e boca de cada cano). */
  layout(geom) {
    this.platforms.forEach((id, i) => {
      const p = this.pipes.get(id), g = geom[i]; if (!g) return;
      if (!p.sprite || p.w !== g.w || p.h !== g.h || p.vertical !== g.vertical) {
        if (p.sprite) { this.scene.scene.remove(p.sprite.mesh); p.sprite.tex.dispose(); p.sprite.mesh.geometry.dispose(); p.sprite.mat.dispose(); }
        p.canvas = mkCanvas(g.w, g.h); p.ctx = p.canvas.getContext('2d'); p.sprite = this.scene.sprite(p.canvas, 4.5);
        p.w = g.w; p.h = g.h; p.vertical = g.vertical;
      }
      p.mouth = g.mouth; p.dirty = true;
      this.scene.place(p.sprite.mesh, g.sx, g.sy);
    });
  }

  has(id) { return this.pipes.has(id); }
  mouth(id) { return this.pipes.get(id)?.mouth ?? null; }

  land(id, job) { this.pipes.get(id)?.landing.add(job); }           // arquivo no ar
  arrive(id, job) {                                                    // arquivo chegou à boca
    const p = this.pipes.get(id); if (!p) return;
    p.landing.delete(job);
    if (p.final.has(job)) this._flash(p, p.final.get(job)); else p.awaiting.add(job);
    p.dirty = true;
  }
  result(id, job, state) {                                             // resultado real da integração
    const p = this.pipes.get(id); if (!p || state === 'publishing') return;
    const kind = state === 'published' ? 'ok' : 'fail';
    if (p.landing.has(job)) p.final.set(job, kind); else { p.awaiting.delete(job); this._flash(p, kind); }
    p.dirty = true;
  }
  _flash(p, kind) { p.flash = kind; p.flashT = p.T; }

  tick(dt, t, counts) {
    for (const [id, p] of this.pipes) {
      if (!p.sprite) continue;
      p.T = t;
      const flashing = p.flash && t - p.flashT < FLASH;
      const mode = flashing ? p.flash : p.awaiting.size ? 'pending' : 'idle';
      const count = counts[id]?.published ?? 0;
      p.acc = (p.acc ?? 0) + dt;
      if (p.dirty || p.count !== count || (mode !== 'idle' && p.acc > 0.08) || p.mode !== mode) {
        p.acc = 0; p.dirty = false; p.count = count; p.mode = mode;
        drawPipe(p.ctx, p.w, p.h, p.vertical, id, mode, t, count); p.sprite.tex.needsUpdate = true;
      }
    }
  }
}

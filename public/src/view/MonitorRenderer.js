// Desenha a tela de cada monitor (44x26 px) proceduralmente, só a partir do estado da estação.
import { drawText, fit, wrap } from './pixelfont.js';

export const MON_W = 52, MON_H = 40;
const SX = 4, SY = 3, SW = 44, SH = 26;

export const STATUS_COLOR = {
  idle: '#5f86c9', queued: '#ffb347', working: '#35e0ff', completed: '#3df5a0', cancelled: '#ffb347', error: '#ff4d5e',
};

const hash = (s) => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const jobLabel = (id) => (id || '').replace(/^job[-_]?/i, '#');
const fmtDur = (s) => (s >= 60 ? `${Math.floor(s / 60)}M${String(Math.round(s % 60)).padStart(2, '0')}S` : `${Math.round(s)}S`);

function makeFrame() {
  const c = document.createElement('canvas'); c.width = MON_W; c.height = MON_H;
  const g = c.getContext('2d');
  g.fillStyle = '#05070c'; g.fillRect(1, 0, MON_W - 2, 33); g.fillRect(0, 1, MON_W, 31); // contorno
  g.fillStyle = '#2d3550'; g.fillRect(1, 1, MON_W - 2, 31); g.fillRect(0, 2, MON_W, 29);
  g.fillStyle = '#3f4a6c'; g.fillRect(2, 1, MON_W - 4, 1);
  g.fillStyle = '#1a2033'; g.fillRect(1, 29, MON_W - 2, 3);
  g.fillStyle = '#05070c'; g.fillRect(SX - 1, SY - 1, SW + 2, SH + 2);
  g.fillStyle = '#05070c'; g.fillRect(22, 32, 8, 6); g.fillRect(16, 37, 20, 3);
  g.fillStyle = '#232a40'; g.fillRect(23, 33, 6, 4); g.fillStyle = '#2d3550'; g.fillRect(17, 37, 18, 2);
  return c;
}

export class MonitorRenderer {
  constructor(deskId) {
    this.deskId = deskId;
    this.canvas = document.createElement('canvas'); this.canvas.width = MON_W; this.canvas.height = MON_H;
    this.ctx = this.canvas.getContext('2d');
    this.frame = MonitorRenderer.frame ??= makeFrame();
  }

  draw(view, t, linkOk, pub = null, unavail = false) {
    const g = this.ctx;
    g.clearRect(0, 0, MON_W, MON_H);
    g.drawImage(this.frame, 0, 0);
    g.save(); g.translate(SX, SY); g.beginPath(); g.rect(0, 0, SW, SH); g.clip();
    const s = view.status;
    if (unavail && s === 'idle') this._unavail(g);
    else if (s === 'working') this._working(g, view, t);
    else if (s === 'completed') this._completed(g, view, t, pub);
    else if (s === 'error') this._error(g, view, t);
    else if (s === 'cancelled') this._cancelled(g, view, t);
    else this._idle(g, view, t);
    if (!linkOk && Math.floor(t * 2) % 2 === 0) { g.fillStyle = '#ffb347'; g.fillRect(40, 1, 3, 3); }
    g.restore();
    // LED de atividade no bezel
    const pulse = s === 'working' || s === 'error' || s === 'queued' ? (Math.floor(t * 4) % 2 ? 1 : 0.45) : 1;
    g.globalAlpha = s === 'idle' ? 0.5 : pulse; g.fillStyle = STATUS_COLOR[s]; g.fillRect(46, 30, 3, 2); g.globalAlpha = 1;
  }

  _bar(g, bg, title, dot, dotOn = true) {
    g.fillStyle = bg; g.fillRect(0, 0, SW, SH);
    g.fillStyle = '#161e33'; g.fillRect(0, 0, SW, 5);
    if (dotOn) { g.fillStyle = dot; g.fillRect(2, 1, 3, 3); }
    drawText(g, title, 7, 0, '#8fa6d1');
  }

  _idle(g, v, t) {
    this._bar(g, '#0b1120', 'EDITOR', '#3df5a0');
    g.fillStyle = '#05080f'; g.fillRect(2, 7, 14, 10); g.fillStyle = '#232e4a'; g.fillRect(2, 7, 14, 1); g.fillRect(2, 16, 14, 1);
    g.fillStyle = '#2a3658'; g.fillRect(8, 10, 1, 4); g.fillRect(9, 11, 1, 2); g.fillRect(10, 12, 1, 0);
    for (const y of [7, 12]) {
      g.fillStyle = '#121a2e'; g.fillRect(19, y, 23, 4);
      g.fillStyle = '#1c2740'; for (let x = 19; x < 42; x += 6) g.fillRect(x, y, 1, 4);
    }
    if (Math.floor(t / 0.7) % 2 === 0) { g.fillStyle = '#35e0ff'; g.fillRect(19, 6, 1, 11); }
    if (v.queued > 0) {
      g.fillStyle = '#ffb347'; g.fillRect(2, 20, 3, 3);
      drawText(g, `NA FILA ${v.queued}`, 7, 19, '#ffb347');
    } else {
      g.globalAlpha = 0.55 + 0.45 * Math.sin(t * 2); g.fillStyle = '#3df5a0'; g.fillRect(2, 20, 3, 3); g.globalAlpha = 1;
      drawText(g, 'DISPONIVEL', 7, 19, '#6f8fc4');
    }
  }

  _working(g, v, t) {
    this._bar(g, '#07131c', fit(v.title || jobLabel(v.jobId) || 'RENDER', v.progress != null ? 6 : 8), '#ff4d5e', Math.floor(t * 2) % 2 === 0);
    if (v.progress != null) drawText(g, `${Math.round(v.progress)}%`, 42, 0, '#35e0ff', 'r');
    // preview "procedural"
    g.fillStyle = '#05080f'; g.fillRect(2, 7, 14, 10);
    const ph = (t * 14) | 0;
    for (let i = 0; i < 4; i++) { g.fillStyle = ['#35e0ff', '#8b6cff', '#ffb347', '#3df5a0'][(i + (ph >> 3)) % 4]; g.fillRect(3 + ((i * 3 + ph) % 11), 8 + i * 2, 3, 2); }
    const seed = hash(v.jobId || v.deskId);
    for (let tr = 0; tr < 2; tr++) {
      const y = 7 + tr * 5; g.fillStyle = '#121a2e'; g.fillRect(19, y, 23, 4);
      let x = 19 - ((t * 7 + tr * 5) % 14);
      let k = seed >> tr;
      while (x < 42) {
        const w = 5 + (k & 7); k = (k >>> 3) | ((k & 7) << 28);
        const x0 = Math.max(19, Math.floor(x)), x1 = Math.min(42, Math.floor(x + w));
        if (x1 > x0) { g.fillStyle = ['#2b8fb0', '#6b52c4', '#b88433'][(w + tr) % 3]; g.fillRect(x0, y, x1 - x0, 4); g.fillStyle = 'rgba(255,255,255,.25)'; g.fillRect(x0, y, x1 - x0, 1); }
        x += w + 2;
      }
    }
    g.fillStyle = '#fff'; g.fillRect(30, 6, 1, 11);
    for (let i = 0; i < 20; i++) { // waveform
      const h = 1 + Math.round(Math.abs(Math.sin(i * 0.7 + t * 9) * Math.sin(i * 0.31 + t * 3.1)) * 4);
      g.fillStyle = i % 5 === 0 ? '#35e0ff' : '#1f7f9c'; g.fillRect(2 + i * 2, 20 - h, 1, h * 2);
    }
    g.fillStyle = '#10202c'; g.fillRect(2, 23, 40, 2);
    g.fillStyle = '#35e0ff';
    if (v.progress != null) g.fillRect(2, 23, Math.round(40 * v.progress / 100), 2);
    else { const x = Math.floor((t * 20) % 50) - 10; g.fillRect(Math.max(2, 2 + x), 23, Math.max(0, Math.min(10, 40 - x, 10 + x)), 2); } // indeterminado: sem % inventado
  }

  _completed(g, v, t, pub) {
    g.fillStyle = '#07170f'; g.fillRect(0, 0, SW, SH);
    g.fillStyle = '#0f3a24'; g.fillRect(0, 0, SW, 5);
    drawText(g, 'RENDER OK', 2, 0, '#3df5a0');
    const pts = [[0, 4], [1, 5], [2, 6], [3, 7], [4, 6], [5, 5], [6, 4], [7, 3], [8, 2], [9, 1]];
    g.fillStyle = Math.floor(t * 3) % 2 || t % 1 > 0.5 ? '#3df5a0' : '#7dffc6';
    for (const [x, y] of pts) g.fillRect(2 + x, 7 + y, 2, 2);
    drawText(g, fit(jobLabel(v.jobId), 7), 16, 8, '#c8f5df');
    drawText(g, v.duration != null ? `T ${fmtDur(v.duration)}` : 'CLIPE PRONTO', 16, 14, '#6fcf9f');
    const P = { published: ['PUBLICADO', '#3df5a0'], failed: ['FALHA PUB', '#ff4d5e'], pending: ['AGUARD PUB', '#ffb347'] }[pub];
    drawText(g, P ? P[0] : 'CONCLUIDO', 22, 19, P ? P[1] : '#3df5a0', 'c');
    g.fillStyle = '#3df5a0'; g.fillRect(2, 24, 40, 1);
  }

  _error(g, v, t) {
    const on = Math.floor(t * 2.5) % 2 === 0;
    g.fillStyle = on ? '#2a0a10' : '#1a070b'; g.fillRect(0, 0, SW, SH);
    g.fillStyle = '#5a1420'; g.fillRect(0, 0, SW, 1);
    g.fillStyle = on ? '#ff4d5e' : '#b83545';
    for (let i = 0; i < 9; i++) g.fillRect(6 - (i >> 1), 3 + i, 1 + i, 1); // triângulo de alerta
    g.fillStyle = '#2a0a10'; g.fillRect(6, 6, 1, 3); g.fillRect(6, 10, 1, 1);
    drawText(g, 'FALHA', 14, 3, '#ff4d5e');
    drawText(g, fit(jobLabel(v.jobId), 7), 14, 9, '#ffb347');
    wrap(v.error || 'ERRO', 11, 2).forEach((l, i) => drawText(g, l, 2, 15 + i * 6, '#ffb3bb'));
  }

  _unavail(g) { // estação sem serviço: tela apagada, sem animação
    g.fillStyle = '#0c0e14'; g.fillRect(0, 0, SW, SH);
    g.fillStyle = '#3a4260'; g.fillRect(0, 0, SW, 1);
    drawText(g, 'FORA DO AR', 22, 8, '#7f8db3', 'c');
    drawText(g, 'SEM SERVICO', 22, 15, '#4a5578', 'c');
  }

  _cancelled(g, v) {
    g.fillStyle = '#1a1407'; g.fillRect(0, 0, SW, SH);
    drawText(g, 'CANCELADO', 22, 8, '#ffb347', 'c');
    drawText(g, fit(jobLabel(v.jobId), 10), 22, 15, '#a07a3a', 'c');
  }
}

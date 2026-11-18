// Esteira da barra operacional (canvas 2D, pixel art). Posições vêm do FlowManager; só o deslize da transferência é tempo local.
import { drawText } from './pixelfont.js';
import { drawChip, CHIP_W } from './chips.js';
import { STATUS_COLOR } from './MonitorRenderer.js';
import { TIMING } from '../config.js';

export const BELT_H = 50;
const CHIP_Y = 13, SURF = 28, LIP = 36, LEGS = 40, LABEL_Y = 44;
const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - ((-2 * p + 2) ** 2) / 2);
const R = (g, c, x, y, w, h) => { g.fillStyle = c; g.fillRect(x, y, w, h); };

export class BeltRenderer {
  constructor(canvas, desks) {
    this.c = canvas; this.g = canvas.getContext('2d'); this.desks = desks;
    this.sprites = new Map(); this.hidden = new Map(); this.pulses = []; this.jobs = []; this.views = new Map(); this.active = null;
    this.now = 0; this.entryT = -9; this.exitT = -9; this.acc = 0;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  resize() {
    const w = this.c.parentElement.clientWidth;
    this.W = Math.max(120, Math.floor(w / 2)); this.c.width = this.W; this.c.height = BELT_H;
    this.g.imageSmoothingEnabled = false;
  }

  sx(i) { return Math.round(30 + (i * (this.W - 60)) / (this.desks.length - 1)); }
  idx(id) { return this.desks.findIndex((d) => d.id === id); }

  setViews(views, active) { this.views = new Map(views.map((v) => [v.deskId, v])); this.active = active; }

  /** Reconcilia com o FlowManager.snapshot(): posição de repouso de cada job. */
  sync(jobs) {
    this.jobs = jobs;
    const live = new Set(jobs.map((j) => j.id));
    for (const j of jobs) {
      const key = `${j.delivered}|${j.blocked}|${j.outbox}|${j.at}`;
      if (this.hidden.get(j.id) === key) continue; // já expirou da esteira neste estado
      this.hidden.delete(j.id);
      let s = this.sprites.get(j.id);
      if (!s) { s = { x: null, tw: null, a: 1, gone: 0, job: j }; this.sprites.set(j.id, s); }
      if (s.key !== key) { s.key = key; s.since = this.now; }
      s.job = j;
      if (s.tw) continue;
      s.prev = s.x; // origem do deslize se uma transferência real chegar logo depois
      const tx = this._rest(j);
      if (tx != null) s.x = tx;
    }
    for (const [id, s] of this.sprites) if (!live.has(id) && !s.gone) s.gone = this.now;
    for (const id of this.hidden.keys()) if (!live.has(id)) this.hidden.delete(id);
  }

  _rest(j) {
    if (j.delivered) return this.W - 14;
    const d = j.outbox ?? j.at; if (!d) return null;
    return this.sx(this.idx(d)) + (j.outbox ? 13 : 0);
  }

  /** Ação do FlowManager. Transferência real -> deslize; sem animate -> posição direta. */
  action(a) {
    const s = this.sprites.get(a.jobId);
    if (a.kind === 'drop') { if (s) s.gone = this.now; return; }
    if (!s) return;
    const slide = (from, to, dur, delay, done) => { s.tw = { from, to, t0: this.now + delay, dur, done }; s.x = from; };
    if (a.kind === 'enter') { this.entryT = this.now; slide(8, this.sx(0), 1, 0); }
    else if (a.kind === 'transfer' && a.animate) {
      const to = this.sx(this.idx(a.to)), from = s.prev ?? this.sx(this.idx(a.from)) + 13;
      slide(from, to, TIMING.transferSec, TIMING.transferDelaySec, () => this.pulses.push({ x: to, t0: this.now }));
    } else if (a.kind === 'deliver' && a.animate) {
      this.exitT = this.now + 1.5;
      slide(this.sx(this.idx(a.from)), this.W - 14, 1.4, TIMING.transferDelaySec, () => { s.gone = this.now + 3; });
    } else if (a.kind === 'receive' && a.animate) this.pulses.push({ x: this.sx(this.idx(a.deskId)), t0: this.now });
  }

  _frame(g, t) {
    const W = this.W;
    // sombra e pernas
    R(g, 'rgba(0,0,0,.35)', 4, LEGS, W - 8, 3);
    for (let x = 16; x < W - 8; x += 44) { R(g, '#0b0f1a', x - 1, LEGS, 6, 5); R(g, '#232c47', x, LEGS, 4, 4); R(g, '#3b4a73', x, LEGS, 1, 4); }
    // lábio frontal com rebites
    R(g, '#05070c', 0, LIP - 1, W, 6); R(g, '#1d2640', 1, LIP, W - 2, 4); R(g, '#34426b', 1, LIP, W - 2, 1);
    for (let x = 6; x < W - 4; x += 8) R(g, '#0b0f1a', x, LIP + 2, 1, 1);
    // superfície com roletes em movimento
    R(g, '#05070c', 0, SURF - 1, W, 9); R(g, '#0f1524', 1, SURF, W - 2, 8);
    R(g, '#4a5a86', 1, SURF, W - 2, 1); R(g, '#080b14', 1, SURF + 7, W - 2, 1);
    const off = (t * 16) % 6;
    for (let x = -6 + off; x < W; x += 6) {
      const X = Math.round(x); if (X < 1 || X > W - 3) continue;
      R(g, '#26314f', X, SURF + 1, 2, 6); R(g, '#1a2238', X + 2, SURF + 1, 1, 6); R(g, '#35446e', X, SURF + 1, 2, 1);
    }
    // setas de sentido
    const ao = (t * 16) % 44; g.globalAlpha = 0.55;
    for (let x = -44 + ao; x < W; x += 44) { const X = Math.round(x); if (X < 8 || X > W - 12) continue; R(g, '#35e0ff', X, SURF + 2, 1, 4); R(g, '#35e0ff', X + 1, SURF + 3, 1, 2); R(g, '#35e0ff', X + 2, SURF + 3.5 | 0, 1, 1); }
    g.globalAlpha = 1;
    // tambores das pontas
    for (const x of [0, W - 7]) { R(g, '#05070c', x, SURF - 2, 7, 12); R(g, '#2a3452', x + 1, SURF - 1, 5, 10); R(g, '#4a5a86', x + 1, SURF - 1, 2, 10); }
  }

  draw(dt, t) {
    this.now = t; this.acc += dt;
    if (this.acc < 1 / 30) return;
    this.acc = 0;
    const g = this.g, W = this.W;
    g.clearRect(0, 0, W, BELT_H);
    this._frame(g, t);

    // entrada / saída
    const blink = (since) => t - since < 1.4 && Math.floor(t * 8) % 2 === 0;
    drawText(g, 'ENT', 9, 3, '#7f8db3'); R(g, blink(this.entryT) ? '#3df5a0' : '#1f4a3a', 3, 4, 3, 3);
    drawText(g, 'SAI', W - 9, 3, '#7f8db3', 'r'); R(g, blink(this.exitT) ? '#3df5a0' : '#1f4a3a', W - 6, 4, 3, 3);

    // portais das estações
    const sp = this.sx(1) - this.sx(0), pw = Math.min(26, sp - 2), narrow = sp < 44;
    this.desks.forEach((d, i) => {
      const x = this.sx(i), v = this.views.get(d.id), col = STATUS_COLOR[v?.status ?? 'idle'], act = this.active === d.id;
      const line = act ? '#35e0ff' : '#2e3a5c', px = x - (pw >> 1);
      R(g, line, px, 11, 1, SURF - 11); R(g, line, px + pw - 1, 11, 1, SURF - 11); // colunas do portal
      R(g, '#05070c', px, 0, pw, 11); R(g, act ? '#0f3a4a' : '#121a2e', px + 1, 1, pw - 2, 9); R(g, line, px + 1, 1, pw - 2, 1);
      drawText(g, String(i + 1), px + 4, 3, act ? '#ffffff' : '#9fb0d6');
      g.globalAlpha = v?.status === 'working' || v?.status === 'error' ? (Math.floor(t * 4) % 2 ? 1 : 0.45) : 1;
      R(g, col, px + pw - 8, 4, 4, 3); g.globalAlpha = 1;
      if (act) { R(g, 'rgba(53,224,255,.18)', px + 1, 11, pw - 2, SURF - 11); }
      drawText(g, narrow ? d.short.slice(0, 4) : d.short, x, LABEL_Y, act ? '#e8ecf5' : '#6f7fa8', 'c');
    });

    // arquivos
    const items = [];
    for (const [id, s] of this.sprites) {
      const ttl = s.job.delivered ? 6 : s.job.blocked ? 90 : s.job.outbox ? 120 : 600; // limpa arquivos parados
      if (!s.gone && !s.tw && t - s.since > ttl) { s.gone = t; this.hidden.set(id, s.key); }
      if (s.gone) { s.a = Math.max(0, 1 - (t - s.gone) / 0.6); if (s.a <= 0 && t > s.gone) { this.sprites.delete(id); continue; } }
      s.vx = 0;
      if (s.tw && t >= s.tw.t0) {
        const p = Math.min(1, (t - s.tw.t0) / s.tw.dur), nx = s.tw.from + (s.tw.to - s.tw.from) * ease(p);
        s.vx = Math.sign(nx - s.x); s.x = nx; s.sliding = p < 1;
        if (p >= 1) { const done = s.tw.done; s.tw = null; s.sliding = false; done?.(); }
      } else s.sliding = false;
      if (s.x != null) items.push(s);
    }
    const slot = new Map();
    for (const s of items) { // arquivos parados na mesma posição ficam lado a lado
      const k = Math.round(s.x / 4), n = s.tw ? 0 : slot.get(k) ?? 0; slot.set(k, n + 1);
      s.dx = n ? (n % 2 ? 1 : -1) * Math.ceil(n / 2) * (CHIP_W - 6) : 0;
    }
    for (const s of items.sort((a, b) => a.job.seq - b.job.seq)) {
      const x = Math.round(s.x - CHIP_W / 2 + s.dx);
      g.globalAlpha = s.a;
      R(g, 'rgba(0,0,0,.45)', x + 1, SURF + 1, CHIP_W - 2, 3); // sombra sobre a esteira
      if (s.sliding) { g.globalAlpha = s.a * 0.35; R(g, '#35e0ff', x - 7 * s.vx + (s.vx > 0 ? 0 : CHIP_W), CHIP_Y + 3, 6 * s.vx, 1); R(g, '#35e0ff', x - 5 * s.vx + (s.vx > 0 ? 0 : CHIP_W), CHIP_Y + 8, 4 * s.vx, 1); g.globalAlpha = s.a; }
      drawChip(g, x, CHIP_Y, s.job, s.job.blocked ? 'blocked' : s.job.outbox ? 'ready' : 'normal');
      g.globalAlpha = 1;
    }

    // pulso de recebimento
    this.pulses = this.pulses.filter((p) => t - p.t0 < 0.5);
    for (const p of this.pulses) {
      const r = 2 + Math.floor((t - p.t0) * 16); g.globalAlpha = 1 - (t - p.t0) / 0.5; g.strokeStyle = '#3df5a0'; g.lineWidth = 1;
      g.strokeRect(Math.round(p.x) - 13 - r + 0.5, CHIP_Y - r + 0.5, 26 + r * 2, SURF - CHIP_Y + r * 2); g.globalAlpha = 1;
    }
  }
}

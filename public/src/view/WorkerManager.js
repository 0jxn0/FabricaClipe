// Uma "estação" visual por mesa: mesa, funcionário, monitor, brilho, plaqueta, bandeja de arquivo, ícones de publicação.
// Recebe só views (estado) e snapshots/ações do fluxo — nada de rede.
import { WorkerAnimation } from './WorkerAnimation.js';
import { MonitorRenderer, STATUS_COLOR } from './MonitorRenderer.js';
import { drawWorker, LOOKS, SPRITE_W, SPRITE_H } from './characters.js';
import { drawDeskBase, drawGlow, drawPlaque, drawSelection, mkCanvas, MON_POS, WORKER_POS, PLAQUE } from './art.js';
import { drawChip, drawPlatform, CHIP_W, CHIP_H } from './chips.js';
import { TIMING } from '../config.js';

const L = { base: 1, glow: 2, worker: 3, monitor: 4, fx: 5, plaque: 5, sel: 6, shadow: 7, fly: 8 };
const FX = { x: 84, y: 0, w: 36, h: 52 };           // faixa à direita do monitor
const SLOT = { x: 88, y: 36 };                       // bandeja de arquivo (canto da mesa)
// Arremesso: o arquivo sai da bandeja de uma mesa, faz um arco e cai na bandeja da outra.
const SLOT_C = { x: SLOT.x + CHIP_W / 2, y: SLOT.y + CHIP_H / 2 };
function buildPath(a, b) {
  const pts = [[a.x + SLOT_C.x, a.y + SLOT_C.y], [b.x + SLOT_C.x, b.y + SLOT_C.y]];
  const len = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
  return { pts, cum: [0, len], len, hop: Math.min(34, 12 + len * 0.1) };
}
const pointAt = (path, d) => {
  let i = 1; while (i < path.pts.length - 1 && path.cum[i] < d) i++;
  const k = (d - path.cum[i - 1]) / Math.max(1e-6, path.cum[i] - path.cum[i - 1]), p0 = path.pts[i - 1], p1 = path.pts[i];
  return [p0[0] + (p1[0] - p0[0]) * k, p0[1] + (p1[1] - p0[1]) * k];
};

function pubState(job) {
  const ps = job?.platforms ?? [];
  if (!ps.length) return null;
  if (ps.every((p) => p.state === 'published')) return 'published';
  if (ps.some((p) => p.state === 'waiting' || p.state === 'publishing')) return 'pending';
  return 'failed';
}

class Station {
  constructor(scene, desk, index) {
    this.scene = scene; this.desk = desk; this.index = index;
    this.view = { status: 'idle', queued: 0, deskId: desk.id };
    this.anim = new WorkerAnimation();
    this.look = LOOKS[desk.look];
    this.poseKey = ''; this.monT = 0; this.plqT = 0; this.fxT = 0;
    this.plqDirty = this.monDirty = this.fxDirty = true;
    this.job = null; this.jobMode = 'normal'; this.pulseT = -9;

    this.base = scene.sprite(drawDeskBase(index), L.base);
    this.glow = scene.sprite(drawGlow(), L.glow, { additive: true, color: 0x35e0ff, opacity: 0.3 });
    this.workerCanvas = mkCanvas(SPRITE_W, SPRITE_H); this.workerCtx = this.workerCanvas.getContext('2d');
    this.worker = scene.sprite(this.workerCanvas, L.worker);
    this.monitor = new MonitorRenderer(desk.id);
    this.mon = scene.sprite(this.monitor.canvas, L.monitor);
    this.fxCanvas = mkCanvas(FX.w, FX.h); this.fxCtx = this.fxCanvas.getContext('2d');
    this.fx = scene.sprite(this.fxCanvas, L.fx);
    this.plaqueCanvas = mkCanvas(PLAQUE.w, PLAQUE.h); this.plaqueCtx = this.plaqueCanvas.getContext('2d');
    this.plaque = scene.sprite(this.plaqueCanvas, L.plaque);
    this.selSprite = scene.sprite(drawSelection('#35e0ff'), L.sel);
    this.hoverSprite = scene.sprite(drawSelection('rgba(255,255,255,.55)'), L.sel);
    this.selSprite.mesh.visible = this.hoverSprite.mesh.visible = false;
  }

  moveTo(x, y) {
    this.x = x; this.y = y;
    const p = (s, dx, dy) => this.scene.place(s.mesh, x + dx, y + dy);
    p(this.base, 0, 0); p(this.glow, 28, 24); p(this.worker, WORKER_POS.x, WORKER_POS.y);
    p(this.mon, MON_POS.x, MON_POS.y); p(this.fx, FX.x, FX.y); p(this.plaque, PLAQUE.x, PLAQUE.y);
    p(this.selSprite, 0, 0); p(this.hoverSprite, 0, 0);
  }

  setView(view) {
    this.view = view;
    this.anim.setState(view.status);
    this.glow.mat.color.set(STATUS_COLOR[view.status]);
    this.monDirty = this.plqDirty = this.fxDirty = true;
  }

  setJob(job, mode) {
    if (job?.id !== this.job?.id || mode !== this.jobMode || JSON.stringify(job?.platforms) !== this.platKey) {
      this.fxDirty = this.monDirty = true;
    }
    this.job = job; this.jobMode = mode; this.platKey = JSON.stringify(job?.platforms);
  }

  _drawFx(t) {
    const g = this.fxCtx; g.clearRect(0, 0, FX.w, FX.h);
    const job = this.job;
    if (!job) return;
    const plats = this.index === 5 ? job.platforms.slice(0, 4) : []; // ícones de plataforma só na estação 06
    plats.forEach((p, i) => drawPlatform(g, p.id, 3 + (i % 2) * 14, 3 + Math.floor(i / 2) * 15, p.state, t));
    if (this.jobMode !== 'hidden' && !job.delivered) {
      const cx = SLOT.x - FX.x, cy = SLOT.y - FX.y;
      const age = t - this.pulseT;
      if (age < 0.5) { // recebimento: anel curto e discreto
        const r = 1 + Math.floor(age * 10); g.globalAlpha = 1 - age / 0.5; g.strokeStyle = '#3df5a0'; g.lineWidth = 1;
        g.strokeRect(cx - r + 0.5, cy - r + 0.5, CHIP_W + r * 2 - 1, CHIP_H + r * 2 - 1); g.globalAlpha = 1;
      }
      drawChip(g, cx, cy, job, this.jobMode);
    }
  }

  tick(dt, t, linkOk) {
    const p = this.anim.update(dt);
    const key = `${p.br}${p.turn}${p.dx}${p.dy}${+p.blink}${p.mode}${p.lh}${p.rh}${+p.wave}`;
    if (key !== this.poseKey) { this.poseKey = key; drawWorker(this.workerCtx, this.look, p); this.worker.tex.needsUpdate = true; }

    const s = this.view.status;
    this.monT -= dt;
    if (this.monDirty || this.monT <= 0) {
      this.monT = s === 'working' ? 1 / 14 : 1 / 8; this.monDirty = false;
      this.monitor.draw(this.view, t, linkOk, this.index === 5 ? pubState(this.job) : null); this.mon.tex.needsUpdate = true;
    }
    this.plqT -= dt;
    if (this.plqDirty || (this.plqT <= 0 && s !== 'idle')) {
      this.plqT = 0.25; this.plqDirty = false;
      drawPlaque(this.plaqueCtx, this.desk, this.index, this.view, t); this.plaque.tex.needsUpdate = true;
    }
    this.fxT -= dt;
    const animating = t - this.pulseT < 0.5 || this.job?.platforms.some((q) => q.state === 'publishing');
    if (this.fxDirty || (animating && this.fxT <= 0)) {
      this.fxT = 1 / 10; this.fxDirty = false; this._drawFx(t); this.fx.tex.needsUpdate = true;
    }
    const flick = s === 'working' ? 0.38 + 0.08 * Math.sin(t * 9) : s === 'error' ? 0.25 + 0.2 * (Math.floor(t * 2.5) % 2) : s === 'idle' ? 0.12 : 0.32;
    this.glow.mat.opacity = flick;
  }
}

export class WorkerManager {
  constructor(scene, desks, pipes) {
    this.scene = scene; this.pipes = pipes; this.throwN = 0; this.throwT = 0;
    this.stations = new Map(desks.map((d, i) => [d.id, new Station(scene, d, i)]));
    this.list = [...this.stations.values()];
    this.linkOk = false; this.jobs = []; this.transit = new Map(); this.t = 0;
    this.flyers = Array.from({ length: 12 }, () => {
      const canvas = mkCanvas(CHIP_W + 2, CHIP_H + 2), sh = mkCanvas(CHIP_W, 5);
      const g = sh.getContext('2d'); g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(2, 1, CHIP_W - 4, 3); g.fillRect(0, 2, CHIP_W, 1);
      const f = { canvas, sprite: scene.sprite(canvas, L.fly), shadow: scene.sprite(sh, L.shadow), job: null };
      f.sprite.mesh.visible = f.shadow.mesh.visible = false;
      return f;
    });
    scene.onTick((dt, t) => this._tick(dt, t));
  }

  layout(cells) { this.cells = cells; this.list.forEach((s, i) => s.moveTo(cells[i].x, cells[i].y)); }
  apply(view) { this.stations.get(view.deskId)?.setView(view); }
  setLink(ok) { this.linkOk = ok; }
  setHover(id) { for (const s of this.list) s.hoverSprite.mesh.visible = s.desk.id === id; }
  setSelected(id) { for (const s of this.list) s.selSprite.mesh.visible = s.desk.id === id; }

  /** Snapshot do FlowManager: decide qual arquivo cada bandeja mostra. */
  setFlow(jobs) { this.jobs = jobs; this._assign(); }

  _assign() {
    for (const s of this.list) {
      const id = s.desk.id;
      const here = this.jobs.filter((j) => {
        const tr = this.transit.get(j.id);
        if (tr) return tr.from === id && this.t < tr.t0; // ainda na bandeja de origem até a decolagem
        return j.at === id;
      });
      here.sort((a, b) => (b.id === s.view.jobId) - (a.id === s.view.jobId) || b.seq - a.seq);
      const j = here[0] ?? null;
      s.setJob(j, !j ? 'normal' : j.blocked ? 'blocked' : j.outbox === id ? 'ready' : 'normal');
    }
  }

  /** Ação real do FlowManager. Só 'transfer' com animate cria voo; o resto é imediato. */
  action(a) {
    if (a.kind === 'receive' && a.animate !== false) { const s = this.stations.get(a.deskId); if (s) s.pulseT = this.t; }
    if (a.kind === 'throw') return this._throw(a);
    if (a.kind === 'publish') { if (a.animate) this.pipes.result(a.platform, a.jobId, a.state); return; }
    if (a.kind !== 'transfer' || !a.animate) return;
    const f = this.flyers.find((q) => !q.job);
    const from = this.stations.get(a.from), to = this.stations.get(a.to);
    const job = this.jobs.find((j) => j.id === a.jobId);
    if (!f || !from || !to || !job || from.x == null) return; // sem vaga: o arquivo só aparece no destino
    const tr = { from: a.from, to: a.to, t0: this.t + TIMING.transferDelaySec, dur: TIMING.transferSec, jobId: a.jobId, started: false, path: buildPath(from, to) };
    this.transit.set(a.jobId, tr); f.job = job; f.tr = tr;
    const g = f.canvas.getContext('2d'); g.clearRect(0, 0, f.canvas.width, f.canvas.height); drawChip(g, 1, 1, job, 'normal'); f.sprite.tex.needsUpdate = true;
    this._assign();
  }

  /** Arremesso do arquivo da bandeja da estação final ao cano da rede (cópia do job: o original segue na mesa). */
  _throw(a) {
    const last = this.list[this.list.length - 1], mouth = this.pipes.mouth(a.platform);
    const f = this.flyers.find((q) => !q.job), job = this.jobs.find((j) => j.id === a.jobId);
    if (!a.animate || !mouth || !f || !job || last.x == null) return;
    if (this.t - this.throwT > 0.4) this.throwN = 0;
    this.throwT = this.t;
    const A = [last.x + SLOT_C.x, last.y + SLOT_C.y], len = Math.hypot(mouth.x - A[0], mouth.y - A[1]);
    const tr = { pipe: a.platform, jobId: a.jobId, t0: this.t + TIMING.transferDelaySec + 0.22 * this.throwN++, dur: TIMING.transferSec, started: true,
      path: { pts: [A, [mouth.x, mouth.y]], cum: [0, len], len, hop: Math.min(40, 14 + len * 0.12) } };
    f.job = job; f.tr = tr; this.pipes.land(a.platform, a.jobId);
    const g = f.canvas.getContext('2d'); g.clearRect(0, 0, f.canvas.width, f.canvas.height); drawChip(g, 1, 1, job, 'normal'); f.sprite.tex.needsUpdate = true;
  }

  _tick(dt, t) {
    this.t = t;
    for (const f of this.flyers) {
      if (!f.job) continue;
      const tr = f.tr, b = tr.pipe ? null : this.stations.get(tr.to);
      const p = (t - tr.t0) / tr.dur;
      if (p < 0) continue;
      if (!tr.started) { tr.started = true; this._assign(); } // decolou: some da bandeja de origem (só entre estações)
      if (p >= 1) { // chegada
        f.job = null; f.sprite.mesh.visible = f.shadow.mesh.visible = false;
        if (tr.pipe) { this.pipes.arrive(tr.pipe, tr.jobId); continue; }
        this.transit.delete(tr.jobId);
        b.pulseT = t; this._assign(); continue;
      }
      const e = p < 0.5 ? 2 * p * p : 1 - ((-2 * p + 2) ** 2) / 2;
      const [x, y] = pointAt(tr.path, e * tr.path.len);
      const hop = Math.round(Math.sin(Math.PI * e) * tr.path.hop); // altura do arco
      this.scene.place(f.sprite.mesh, Math.round(x - CHIP_W / 2) - 1, Math.round(y - CHIP_H / 2) - hop - 1);
      this.scene.place(f.shadow.mesh, Math.round(x - CHIP_W / 2), Math.round(y + CHIP_H / 2) - 2);
      f.shadow.mat.opacity = 0.85 - 0.5 * Math.sin(Math.PI * e);
      f.sprite.mesh.visible = f.shadow.mesh.visible = true;
    }
    for (const s of this.list) s.tick(dt, t, this.linkOk);
  }
}

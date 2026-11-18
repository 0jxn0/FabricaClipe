// Lógica de eventos pura (sem DOM, sem WebGL): valida, deduplica, ordena e mantém um estado por estação.
// Eventos de fluxo (transferred/published/...) não mexem na estação: seguem para o FlowManager via 'accepted'.
import { EVENT_TYPES, TIMING } from '../config.js';

const TERMINAL = new Set(['clip.job.completed', 'clip.job.failed', 'clip.job.cancelled', 'clip.job.paused']);
const FLOW_ONLY = new Set(['clip.job.transferred', 'clip.job.published', 'clip.job.publish_failed']);
const MAX_JOBS = 200;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const slug = (v) => (typeof v === 'string' && /^[a-z0-9_-]{1,24}$/i.test(v) ? v.toLowerCase() : null);
// Miniatura: só data:image (pequena) ou caminho do mesmo servidor. URL externa vazaria o IP do visualizador.
const thumbOk = (v) => typeof v === 'string' && v.length <= 24000 && (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v) || /^\/[A-Za-z0-9._~\-/]+$/.test(v));

export function validateEvent(raw, deskIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'not-object' };
  if (!EVENT_TYPES.includes(raw.type)) return { error: 'bad-type' };
  if (!deskIds.includes(raw.deskId)) return { error: 'bad-desk' };
  if (typeof raw.jobId !== 'string' || !raw.jobId || raw.jobId.length > 128) return { error: 'bad-job' };
  const e = { type: raw.type, deskId: raw.deskId, jobId: raw.jobId, replay: raw.replay === true };
  e.title = str(raw.title, 120);
  e.error = str(raw.error, 300);
  if (raw.thumb != null && thumbOk(raw.thumb)) e.thumb = raw.thumb;
  if (raw.timestamp != null) {
    const t = Date.parse(raw.timestamp);
    if (Number.isNaN(t)) return { error: 'bad-timestamp' };
    e.ts = t;
  }
  if (raw.type === 'clip.job.progress') {
    if (typeof raw.progress !== 'number' || !Number.isFinite(raw.progress)) return { error: 'bad-progress' };
    e.progress = Math.min(100, Math.max(0, raw.progress));
  }
  if (raw.duration != null) {
    if (typeof raw.duration !== 'number' || !Number.isFinite(raw.duration) || raw.duration < 0) return { error: 'bad-duration' };
    e.duration = raw.duration;
  }
  if (raw.type === 'clip.job.transferred') {
    if (!deskIds.includes(raw.toDeskId) || raw.toDeskId === raw.deskId) return { error: 'bad-target' };
    e.toDeskId = raw.toDeskId;
  }
  if (raw.platforms != null) {
    if (!Array.isArray(raw.platforms)) return { error: 'bad-platforms' };
    e.platforms = [...new Set(raw.platforms.slice(0, 8).map(slug).filter(Boolean))];
  }
  if (raw.platform != null) { e.platform = slug(raw.platform); if (!e.platform) return { error: 'bad-platform' }; }
  return { event: e };
}

const blank = (deskId) => ({
  deskId, status: 'idle', jobId: null, title: null, progress: null, error: null,
  duration: null, queued: 0, lastEvent: null, updatedAt: 0, changedAt: 0,
});

export class EventManager {
  constructor(deskIds, { timing = TIMING, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
    this.deskIds = deskIds;
    this.timing = timing;
    // wrappers: setTimeout/clearTimeout exigem this=window no navegador
    this.setTimer = (f, ms) => setTimer(f, ms); this.clearTimer = (h) => clearTimer(h); this.now = now;
    this.desks = new Map(deskIds.map((id) => [id, { view: blank(id), jobs: new Map(), seen: new Set(), timer: null }]));
    this.listeners = { change: [], event: [], accepted: [] };
  }

  on(name, fn) { this.listeners[name].push(fn); return () => { this.listeners[name] = this.listeners[name].filter((f) => f !== fn); }; }
  emit(name, arg) { for (const fn of this.listeners[name]) { try { fn(arg); } catch (err) { console.error(err); } } }

  snapshot(deskId) { return { ...this.desks.get(deskId).view }; }
  all() { return this.deskIds.map((id) => this.snapshot(id)); }

  dispose() { for (const d of this.desks.values()) this.clearTimer(d.timer); }

  /** Aceita um objeto bruto. Retorna { ok, reason }. Nunca lança. */
  handle(raw) {
    let res;
    try { res = this._handle(raw); } catch (err) { res = { ok: false, reason: 'exception' }; console.error(err); }
    this.emit('event', { raw, ok: res.ok, reason: res.reason });
    if (res.ok) this.emit('accepted', res.e);
    return { ok: res.ok, reason: res.reason };
  }

  _handle(raw) {
    const { event: e, error } = validateEvent(raw, this.deskIds);
    if (error) return { ok: false, reason: error };
    const desk = this.desks.get(e.deskId); // único estado tocado: o da própria estação

    const key = `${e.type}|${e.jobId}|${e.ts ?? ''}|${e.progress ?? ''}|${e.toDeskId ?? ''}|${e.platform ?? ''}`;
    if (desk.seen.has(key)) return { ok: false, reason: 'duplicate' };
    desk.seen.add(key);
    if (desk.seen.size > MAX_JOBS * 2) desk.seen.delete(desk.seen.values().next().value);

    const v = desk.view;
    const touch = () => { v.lastEvent = { type: e.type, jobId: e.jobId, ts: e.ts ?? null, receivedAt: this.now() }; v.updatedAt = this.now(); };
    let job = desk.jobs.get(e.jobId);

    // Eventos de fluxo: não alteram o estado de trabalho da estação.
    if (FLOW_ONLY.has(e.type)) { touch(); this.emit('change', this.snapshot(e.deskId)); return { ok: true, e }; }

    // Reinício de um job já finalizado só com timestamp mais novo (retry); sem timestamp é ruído fora de ordem.
    if (job?.done && (e.type === 'clip.job.started' || e.type === 'clip.job.queued' || e.type === 'clip.job.received') && e.ts && e.ts >= (job.doneTs ?? 0)) {
      desk.jobs.delete(e.jobId); job = undefined;
    }

    if (TERMINAL.has(e.type)) {
      // falha de transferência chega depois da conclusão da etapa; cancelar um job que falhou também é válido
      const overrides = job?.done && e.ts && e.ts >= (job.doneTs ?? 0) && ((e.type === 'clip.job.failed' && job.status === 'completed') || (e.type === 'clip.job.cancelled' && job.status === 'failed'));
      if (job?.done && !overrides) return { ok: false, reason: 'already-finished' };
    } else if (job?.done) {
      if (e.type === 'clip.job.publishing' || e.type === 'clip.job.received') { touch(); return { ok: true, e }; } // só fluxo
      return { ok: false, reason: 'stale-after-finish' };
    }

    let changed = false;
    const ensure = (status) => {
      if (!job) {
        job = { id: e.jobId, status, title: e.title ?? null, progress: null, done: false };
        desk.jobs.set(e.jobId, job);
        if (desk.jobs.size > MAX_JOBS) desk.jobs.delete(desk.jobs.keys().next().value);
      }
      if (e.title && !job.title) job.title = e.title;
      return job;
    };

    switch (e.type) {
      case 'clip.job.queued':
      case 'clip.job.received': // arquivo recebido: aguarda na fila da estação até o job começar
        if (job) { if (e.type === 'clip.job.received') { touch(); return { ok: true, e }; } return { ok: false, reason: 'stale' }; }
        ensure('queued'); changed = true; break;

      case 'clip.job.started':
        if (job && job.status !== 'queued') return { ok: false, reason: 'stale' };
        ensure('working').status = 'working';
        this._activate(desk, job); changed = true; break;

      case 'clip.job.progress':
        ensure('working'); job.status = 'working';
        if (job.progress != null && e.progress < job.progress) return { ok: false, reason: 'stale-progress' };
        job.progress = e.progress;
        if (!this._activeLive(desk)) this._activate(desk, job);
        else if (v.jobId === job.id) v.progress = job.progress;
        changed = true; break;

      case 'clip.job.publishing': // a estação está publicando: conta como trabalho, sem inventar progresso
        ensure('working'); job.status = 'working';
        if (!this._activeLive(desk)) this._activate(desk, job);
        changed = true; break;

      default: { // completed | failed | cancelled
        ensure('working');
        job.done = true; job.doneTs = e.ts ?? 0;
        job.status = e.type.split('.')[2];
        if (job.status === 'paused') job.status = 'cancelled'; // pausa: a mesa fica livre; o job volta com um novo queued
        job.duration = e.duration ?? null; job.error = e.error ?? null;
        const isActive = v.jobId === job.id || !this._activeLive(desk);
        if (isActive) this._finish(desk, job, e.replay);
        changed = true;
      }
    }

    v.queued = [...desk.jobs.values()].filter((j) => j.status === 'queued').length;
    touch();
    if (changed) this.emit('change', this.snapshot(e.deskId));
    return { ok: true, e };
  }

  _activeLive(desk) {
    const j = desk.jobs.get(desk.view.jobId);
    return !!j && !j.done && desk.view.status === 'working';
  }

  _setStatus(desk, status) {
    const v = desk.view;
    if (v.status !== status) v.changedAt = this.now();
    v.status = status;
  }

  _activate(desk, job) {
    this.clearTimer(desk.timer);
    const v = desk.view;
    v.jobId = job.id; v.title = job.title; v.progress = job.progress;
    v.error = null; v.duration = null;
    this._setStatus(desk, 'working');
  }

  _finish(desk, job, replay = false) {
    const v = desk.view;
    this.clearTimer(desk.timer);
    v.jobId = job.id; v.title = job.title ?? v.title;
    if (job.progress != null) v.progress = job.progress;
    v.duration = job.duration; v.error = null;
    if (job.status === 'failed') {
      v.error = job.error || 'Falha sem detalhes';
      this._setStatus(desk, 'error'); // erro é persistente até o próximo job
      return;
    }
    // Histórico reenviado após reconexão não deve reencenar a comemoração.
    if (replay) { this._setStatus(desk, 'idle'); return; }
    const wait = job.status === 'completed' ? this.timing.completedSettleMs : this.timing.cancelledSettleMs;
    this._setStatus(desk, job.status);
    desk.timer = this.setTimer(() => {
      if (desk.view.jobId !== job.id || desk.view.status === 'working') return;
      this._setStatus(desk, 'idle');
      desk.view.updatedAt = this.now();
      this.emit('change', this.snapshot(desk.view.deskId));
    }, wait);
    // Havendo outro job em andamento em paralelo, ele reassume imediatamente.
    const next = [...desk.jobs.values()].find((j) => !j.done && j.status === 'working');
    if (next) { this.clearTimer(desk.timer); this._activate(desk, next); }
  }
}

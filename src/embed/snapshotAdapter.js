// Snapshot de GET /api/factory -> eventos NO CONTRATO LEGADO (clip.job.*) do EventManager. Puro: sem DOM, sem timers.
// Compara cada snapshot com o anterior e emite só o que mudou; o mesmo snapshot duas vezes não emite nada.
const ORDER = ['desk-1', 'desk-2', 'desk-3', 'desk-4', 'desk-5', 'desk-6'];

export class SnapshotAdapter {
  /** emit(legacyEvent). clock: relógio local em ms (injetável). */
  constructor(emit, { order = ORDER, clock = Date.now } = {}) {
    this.emit = emit; this.order = order; this.clock = clock;
    this.items = new Map(); // id -> { station, state, progress, error, title }
    this.primed = false;
    this.unavailable = []; this.reasons = {}; // estações sem serviço (available:false)
  }

  feed(snap) {
    if (!snap || !Array.isArray(snap.items)) return;
    const replay = !this.primed; this.primed = true;
    const now = Number.isFinite(snap.now) ? snap.now : this.clock() / 1000;
    this.unavailable = []; this.reasons = {};
    for (const s of snap.stations ?? []) {
      if (s && s.available === false && this.order.includes(s.id)) { this.unavailable.push(s.id); this.reasons[s.id] = s.reason || 'sem serviço'; }
    }
    // relógio local menos a idade no servidor: imune a diferença de relógio entre servidor e navegador
    const ts = (it) => new Date(this.clock() - Math.max(0, now - (Number.isFinite(it.updated_at) ? it.updated_at : now)) * 1000).toISOString();
    const seen = new Set();
    for (const it of snap.items) {
      if (!it || typeof it.id !== 'string' || !this.order.includes(it.station)) continue;
      seen.add(it.id);
      const prev0 = this.items.get(it.id);
      this._item(it, prev0, replay, ts(it));
      // baseline de progresso = maior valor já visto nesta execução (nunca regride)
      const pct = typeof it.progress === 'number' && Number.isFinite(it.progress) ? it.progress : null;
      const prog = prev0 && prev0.station === it.station && prev0.state === it.state ? prev0.progress : null;
      this.items.set(it.id, { station: it.station, state: it.state, progress: pct == null ? prog : prog == null ? pct : Math.max(prog, pct), error: it.error ?? null });
    }
    for (const [id, p] of this.items) {
      if (seen.has(id)) continue;
      this.items.delete(id);
      if (p.state !== 'done') this._ev('cancelled', p.station, id, { timestamp: new Date(this.clock()).toISOString() });
    }
  }

  _ev(kind, deskId, jobId, x = {}) { this.emit({ type: `clip.job.${kind}`, deskId, jobId, ...x }); }

  _item(it, prev, replay, timestamp) {
    const id = it.id, d = it.station, base = { title: it.title, timestamp, ...(replay ? { replay: true } : {}) };
    const ev = (kind, desk, x = {}) => this._ev(kind, desk, id, { ...base, ...x });
    // progresso REAL: só números finitos; nunca inventado
    const pct = typeof it.progress === 'number' && Number.isFinite(it.progress) ? it.progress : null;
    const enter = (st) => { // estado do item ao chegar/aparecer em d
      if (st === 'working') { ev('started', d); if (pct != null) ev('progress', d, { progress: pct }); }
      else if (st === 'failed') ev('failed', d, { error: it.error || 'Falha' });
      else if (st === 'done') ev('completed', d);
    };

    if (!prev) { // primeiro snapshot (reconstrói sem animação) ou item novo
      if (it.state === 'queued' || it.state === 'waiting') ev('queued', d); else enter(it.state);
      return;
    }
    if (prev.station !== d) { // mudou de estação: um único transfer, mesmo que tenha pulado estações
      const a = prev.station;
      if (prev.state === 'failed') ev('started', a); // recuperação real: libera o bloqueio do arquivo
      ev('completed', a);
      ev('transferred', a, { toDeskId: d });
      ev('received', d);
      enter(it.state);
      return;
    }
    if (it.state === prev.state) { // mesmo estado: só progresso que avançou
      if (it.state === 'working' && pct != null && (prev.progress == null || pct > prev.progress)) ev('progress', d, { progress: pct });
      else if (it.state === 'failed' && it.error !== prev.error) ev('failed', d, { error: it.error || 'Falha' });
      return;
    }
    if (it.state === 'queued' || it.state === 'waiting') { // voltou à espera (pausa/retry)
      if (prev.state === 'working') ev('paused', d);
      ev('queued', d);
    } else enter(it.state);
  }
}

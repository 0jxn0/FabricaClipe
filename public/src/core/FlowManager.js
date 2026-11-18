// Percurso dos vídeos entre estações (sem DOM). Só reage a eventos JÁ aceitos pelo EventManager:
// nada é animado por conta própria. Transferência = evidência real:
//   (a) clip.job.transferred, ou (b) o mesmo jobId aparece em outra estação depois de concluído na anterior.
// Publicação só vira "publicada" com clip.job.published; completed na última estação não implica publicação.
const MAX_JOBS = 120;

export class FlowManager {
  constructor(deskIds, { now = Date.now, staleMs = 15000 } = {}) {
    this.deskIds = deskIds; this.last = deskIds[deskIds.length - 1];
    this.now = now; this.staleMs = staleMs;
    this.seq0 = 0; this.buf = []; this.jobs = new Map(); this.l = { action: [], change: [] };
  }

  on(name, fn) { this.l[name].push(fn); return this; }
  _act(a) { this.buf.push(a); } // ações saem depois do 'change', para a visão já conhecer o job
  _chg() { for (const f of this.l.change) { try { f(); } catch (err) { console.error(err); } } }
  idx(d) { return this.deskIds.indexOf(d); }

  /** Cópia imutável para a camada visual. */
  snapshot() {
    return [...this.jobs.values()].map((j) => ({
      id: j.id, title: j.title, thumb: j.thumb, at: j.at, outbox: j.outbox, blocked: j.blocked, delivered: j.delivered, seq: j.seq,
      platforms: j.platforms.map((p) => ({ id: p, state: j.pub.get(p) ?? 'waiting', error: j.pubErr.get(p) ?? null })),
    }));
  }
  job(id) { return this.snapshot().find((j) => j.id === id) ?? null; }

  handle(e) {
    this._handle(e);
    this._chg();
    const acts = this.buf; this.buf = [];
    for (const a of acts) for (const f of this.l.action) { try { f(a); } catch (err) { console.error(err); } }
  }

  _handle(e) {
    const animate = !e.replay && !(e.ts && this.now() - e.ts > this.staleMs);
    let j = this.jobs.get(e.jobId);
    if (e.type === 'clip.job.cancelled') {
      if (j) { this.jobs.delete(j.id); this._act({ kind: 'drop', jobId: j.id }); }
      return;
    }
    if (!j) {
      j = { id: e.jobId, title: null, thumb: null, platforms: [], pub: new Map(), pubErr: new Map(), at: null, outbox: null, blocked: null, delivered: false, seq: ++this.seq0, tr: new Set(), thrown: new Set(), fresh: true };
      this.jobs.set(j.id, j);
      if (this.jobs.size > MAX_JOBS) this.jobs.delete(this.jobs.keys().next().value);
    }
    if (e.title && !j.title) j.title = e.title;
    if (e.thumb && !j.thumb) j.thumb = e.thumb;
    for (const p of e.platforms ?? []) if (!j.platforms.includes(p)) j.platforms.push(p);

    switch (e.type) {
      case 'clip.job.transferred': this._transfer(j, e.deskId, e.toDeskId, animate); break;
      case 'clip.job.completed': this._completed(j, e.deskId, animate); break;
      case 'clip.job.failed': j.blocked = e.deskId; j.outbox = null; j.at ??= e.deskId; this._act({ kind: 'blocked', jobId: j.id, deskId: e.deskId }); break;
      case 'clip.job.publishing': this._arrive(j, e, animate); this._pub(j, e, 'publishing', animate); break;
      case 'clip.job.published': this._pub(j, e, 'published', animate); break;
      case 'clip.job.publish_failed': this._pub(j, e, 'failed', animate); break;
      default: this._arrive(j, e, animate); // queued | received | started | progress
    }
    j.fresh = false;
  }

  _arrive(j, e, animate) {
    const d = e.deskId;
    if (j.blocked) {
      // Só recuperação real (novo started na mesma estação) libera o arquivo.
      if (j.blocked === d && e.type === 'clip.job.started') { j.blocked = null; this._act({ kind: 'unblocked', jobId: j.id, deskId: d }); }
      else return;
    }
    if (j.outbox && j.outbox !== d) { this._transfer(j, j.outbox, d, animate); return; }
    if (j.at === d) { if (e.type === 'clip.job.received') this._act({ kind: 'receive', jobId: j.id, deskId: d, animate }); return; }
    const first = j.at === null;
    j.at = d; j.outbox = null;
    this._act({ kind: first && this.idx(d) === 0 && animate ? 'enter' : 'place', jobId: j.id, to: d, animate });
  }

  _transfer(j, from, to, animate) {
    if (j.blocked) return; // falha interrompe o encaminhamento
    const key = `${from}>${to}`;
    if (j.tr.has(key)) return; // sem animação duplicada
    j.tr.add(key);
    j.outbox = null; j.at = to; j.delivered = false;
    this._act({ kind: 'transfer', jobId: j.id, from, to, animate });
  }

  _completed(j, d, animate) {
    if (j.blocked) return;
    if (j.at && this.idx(j.at) > this.idx(d)) return; // chegou fora de ordem: o arquivo já avançou
    j.at = d;
    if (d === this.last) { j.delivered = true; j.outbox = null; this._act({ kind: 'deliver', jobId: j.id, from: d, animate }); return; }
    j.outbox = d;
    this._act({ kind: 'outbox', jobId: j.id, deskId: d, animate });
  }

  _pub(j, e, state, animate) {
    const targets = e.platform ? [e.platform] : j.platforms;
    if (e.platform && !j.platforms.includes(e.platform)) j.platforms.push(e.platform);
    for (const p of targets) {
      if (!j.thrown.has(p)) { j.thrown.add(p); this._act({ kind: 'throw', jobId: j.id, platform: p, animate }); } // arremesso ao cano da rede
      const cur = j.pub.get(p);
      if (cur === 'published') continue; // publicado é definitivo
      j.pub.set(p, state);
      if (state === 'failed') j.pubErr.set(p, e.error ?? null);
      this._act({ kind: 'publish', jobId: j.id, platform: p, state, animate });
    }
  }
}

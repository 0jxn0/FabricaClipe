// KPIs agregados a partir dos eventos já aceitos (sem DOM). "Concluído" = job concluído na última estação.
export class StatsManager {
  constructor(deskIds, { now = Date.now } = {}) {
    this.deskIds = deskIds; this.last = deskIds[deskIds.length - 1]; this.now = now;
    this.done = new Set(); this.failed = new Set(); this.byDesk = Object.fromEntries(deskIds.map((d) => [d, 0]));
    this.deskDone = new Set(); this.durations = []; this.stamps = []; this.plat = {}; this.platSeen = new Set(); this.l = [];
  }

  on(fn) { this.l.push(fn); }

  handle(e) {
    if (e.type === 'clip.job.completed') {
      const k = `${e.deskId}|${e.jobId}`;
      if (!this.deskDone.has(k)) { this.deskDone.add(k); this.byDesk[e.deskId]++; if (e.duration != null) this.durations.push(e.duration); }
      if (e.deskId === this.last && !this.done.has(e.jobId)) { this.done.add(e.jobId); this.stamps.push(e.ts ?? this.now()); this.failed.delete(e.jobId); }
    } else if (e.type === 'clip.job.failed') { if (!this.done.has(e.jobId)) this.failed.add(e.jobId); }
    else if (e.type === 'clip.job.started') this.failed.delete(e.jobId); // recuperação
    else if (e.type === 'clip.job.published' || e.type === 'clip.job.publish_failed') {
      const ps = e.platform ? [e.platform] : e.platforms ?? [];
      for (const p of ps) {
        const k = `${e.jobId}|${p}|${e.type}`; if (this.platSeen.has(k)) continue; this.platSeen.add(k);
        const c = (this.plat[p] ??= { published: 0, failed: 0 });
        if (e.type === 'clip.job.published') c.published++; else c.failed++;
      }
    }
    for (const f of this.l) f();
  }

  snapshot() {
    const n = this.now(), hour = this.stamps.filter((t) => n - t <= 3600e3).length;
    const total = this.done.size + this.failed.size;
    return {
      done: this.done.size, failed: this.failed.size, successRate: total ? Math.round((this.done.size / total) * 100) : null,
      avgSec: this.durations.length ? this.durations.reduce((a, b) => a + b, 0) / this.durations.length : null,
      perHour: hour, byDesk: { ...this.byDesk }, plat: this.plat,
    };
  }
}

// Diagnóstico para o usuário entender uma falha sem abrir o código.
import fs from 'node:fs';
import type { Db } from '../infrastructure/database/db.ts';
import type { Orchestrator } from '../core/orchestrator/Orchestrator.ts';

export function diagnostics(o: { db: Db; orch: Orchestrator; dataDir: string; ffmpeg?: () => { ok: boolean; detail: string }; integrations?: () => Record<string, string> }) {
  const disk = (() => { try { const s = fs.statfsSync(o.dataDir); return { freeGB: +(Number(s.bavail) * Number(s.bsize) / 1e9).toFixed(1) }; } catch (e) { return { error: String(e) }; } })();
  const mem = process.memoryUsage();
  const counts = o.db.all<{ state: string; n: number }>('SELECT state, COUNT(*) AS n FROM jobs GROUP BY state');
  return {
    backend: { ok: true, pid: process.pid, uptimeSec: Math.round(process.uptime()), node: process.versions.node },
    database: { file: o.db.file, integrity: o.db.integrity(), migrations: o.db.all('SELECT id, name, applied_at FROM schema_migrations ORDER BY id') },
    workers: o.orch.employees(),
    ffmpeg: o.ffmpeg?.() ?? { ok: false, detail: 'ainda não configurado (Fase 3)' },
    disk, memoryMB: { rss: Math.round(mem.rss / 1e6), heapUsed: Math.round(mem.heapUsed / 1e6) },
    jobs: Object.fromEntries(counts.map((c) => [c.state, c.n])),
    lastErrors: o.db.all("SELECT timestamp, job_id AS jobId, station_id AS stationId, message FROM execution_logs WHERE level = 'error' ORDER BY id DESC LIMIT 10"),
    integrations: o.integrations?.() ?? {},
  };
}

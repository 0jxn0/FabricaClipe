// Orquestrador: dono do ciclo de vida dos jobs. Só ele muda estado/estação; tudo é persistido ANTES do evento correspondente.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../infrastructure/database/db.ts';
import type { Logger } from '../../infrastructure/logging/logger.ts';
import type { EventBus } from '../event-bus/EventBus.ts';
import { assertTransition, isActive } from '../state-machine/jobStateMachine.ts';
import { ensureInside, validateImportFile } from '../../infrastructure/filesystem/safePaths.ts';
import type { StepContext, StepResult, Worker } from '../../workers/Worker.ts';
import { ApprovalDecision, CreateJobInput, JobAction, type JobRow } from '../../../shared/contracts/jobs.ts';
import { STATIONS, STATION_INFO, nextStation, type EmployeeState, type JobState, type StationId } from '../../../shared/contracts/stations.ts';
import type { EventDraft } from '../../../shared/contracts/events.ts';

export interface OrchestratorConfig {
  concurrency: Record<StationId, number>;   // por estação (render pesado = 1)
  maxJobs: number;                          // jobs simultâneos no total
  maxAttempts: number; retryBackoffMs: number;
  revisionStation: StationId;               // para onde volta um job rejeitado
  pumpIntervalMs: number;
}
export const DEFAULT_CONFIG: OrchestratorConfig = {
  concurrency: { capture: 2, cutting: 2, subtitles: 1, rendering: 1, approval: 99, publishing: 2 },
  maxJobs: 4, maxAttempts: 3, retryBackoffMs: 15000, revisionStation: 'cutting', pumpIntervalMs: 500,
};

interface Row {
  id: string; name: string; project_id: string; source_path: string; current_path: string; station_id: string; employee_id: string | null;
  state: JobState; progress: number; priority: number; attempts: number; not_before: string | null; locked_by: string | null; error: string | null;
  config_json: string; platforms_json: string; created_at: string; started_at: string | null; completed_at: string | null;
}
const toJob = (r: Row): JobRow => ({
  id: r.id, name: r.name, projectId: r.project_id, sourcePath: r.source_path, currentPath: r.current_path, stationId: r.station_id,
  employeeId: r.employee_id ?? '', state: r.state, progress: r.progress, createdAt: r.created_at, startedAt: r.started_at, completedAt: r.completed_at,
  config: JSON.parse(r.config_json), platforms: JSON.parse(r.platforms_json), priority: r.priority, attempts: r.attempts, error: r.error,
});

export interface OrchestratorDeps {
  db: Db; bus: EventBus; logger: Logger; dataDir: string; workers: Worker[]; config?: Partial<OrchestratorConfig>; now?: () => Date;
}

export class Orchestrator {
  readonly db: Db; readonly bus: EventBus; readonly log: Logger; readonly cfg: OrchestratorConfig;
  private workers = new Map<StationId, Worker>(); private unavailable = new Map<StationId, string>();
  private running = new Map<string, { station: StationId; abort: AbortController; want?: 'pause' | 'cancel' | 'shutdown' }>();
  private timer: ReturnType<typeof setInterval> | null = null; private pumping = false; private stopped = true;
  private lastProgress = new Map<string, { p: number; t: number }>();
  private readonly owner = `orch-${randomUUID().slice(0, 8)}`;

  private d: OrchestratorDeps;
  constructor(d: OrchestratorDeps) {
    this.d = d; this.db = d.db; this.bus = d.bus; this.log = d.logger; this.cfg = { ...DEFAULT_CONFIG, ...d.config, concurrency: { ...DEFAULT_CONFIG.concurrency, ...d.config?.concurrency } };
    for (const w of d.workers) this.workers.set(w.stationId, w);
    this.seedStations();
  }

  private now() { return (this.d.now?.() ?? new Date()).toISOString(); }

  private seedStations() {
    STATIONS.forEach((s, i) => {
      const info = STATION_INFO[s];
      this.db.run('INSERT OR IGNORE INTO stations (id, name, desk_id, position, max_concurrency) VALUES (?, ?, ?, ?, ?)', s, info.name, info.deskId, i, this.cfg.concurrency[s]);
      this.db.run("INSERT OR IGNORE INTO employees (id, name, station_id, state) VALUES (?, ?, ?, 'unavailable')", info.employeeId, info.agent, s);
    });
  }

  // ---------------------------------------------------------------- ciclo de vida
  async start(): Promise<void> {
    if (!this.stopped || this.timer) return; // já iniciado
    this.publish({ event: 'system.initializing', payload: {} });
    for (const s of STATIONS) {
      if (s === 'approval') { this.setEmployee(s, 'idle'); continue; } // aprovação é humana: sempre disponível
      const w = this.workers.get(s);
      if (!w) { this.markUnavailable(s, 'nenhum worker registrado'); continue; }
      try { await w.initialize(); this.setEmployee(s, 'idle'); this.publish({ event: 'clip.station.idle', stationId: s, payload: {} }); }
      catch (e) { this.markUnavailable(s, (e as Error).message); }
    }
    const recovered = await this.recover();
    this.stopped = false;
    this.timer = setInterval(() => void this.pump(), this.cfg.pumpIntervalMs);
    this.publish({ event: 'system.ready', payload: { recoveredJobs: recovered } });
    void this.pump();
  }

  /** Para o laço. `interrupt`: aborta o que estiver rodando (volta à fila na próxima abertura). Sem isso, espera terminar. */
  async stop(interrupt = false): Promise<void> {
    this.stopped = true; if (this.timer) clearInterval(this.timer);
    if (interrupt) for (const r of this.running.values()) { r.want = 'shutdown'; r.abort.abort(); }
    const t0 = Date.now();
    while (this.running.size && Date.now() - t0 < (interrupt ? 2000 : 15000)) await new Promise((r) => setTimeout(r, 50));
    this.publish({ event: 'system.shutdown', payload: { interrupted: this.running.size } });
  }

  private markUnavailable(s: StationId, reason: string) {
    this.unavailable.set(s, reason); this.setEmployee(s, 'unavailable');
    this.publish({ event: 'clip.station.unavailable', stationId: s, payload: { reason } });
    this.log.warn(`estação indisponível: ${reason}`, { stationId: s });
  }

  // ---------------------------------------------------------------- criação e consulta
  createJob(raw: unknown): JobRow {
    const input = CreateJobInput.parse(raw);
    validateImportFile(input.sourcePath);
    const id = this.db.tx(() => {
      const n = Number(this.db.get<{ v: string }>("SELECT value_json AS v FROM settings WHERE key = 'job_seq'")?.v ?? 1000) + 1;
      this.db.run("INSERT INTO settings (key, value_json, updated_at) VALUES ('job_seq', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at", String(n), this.now());
      if (!this.db.get('SELECT 1 AS x FROM projects WHERE id = ?', input.projectId)) this.db.run('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)', input.projectId, input.projectId, this.now());
      const jobId = `job-${n}`;
      this.db.run(`INSERT INTO jobs (id, name, project_id, source_path, current_path, station_id, employee_id, state, priority, config_json, platforms_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'capture', ?, 'queued', ?, ?, ?, ?, ?)`, jobId, input.name, input.projectId, input.sourcePath, input.sourcePath,
        STATION_INFO.capture.employeeId, input.priority, JSON.stringify(input.config), JSON.stringify(input.platforms), this.now(), this.now());
      return jobId;
    });
    const job = this.job(id)!;
    this.publish({ event: 'clip.job.created', jobId: id, stationId: 'capture', payload: { name: job.name, projectId: job.projectId, platforms: job.platforms, source: path.basename(job.sourcePath) } });
    this.publish({ event: 'clip.job.queued', jobId: id, stationId: 'capture', payload: { name: job.name, platforms: job.platforms } });
    this.log.info('job criado', { jobId: id, stationId: 'capture' });
    void this.pump();
    return job;
  }

  job(id: string): JobRow | undefined { const r = this.db.get<Row>('SELECT * FROM jobs WHERE id = ?', id); return r ? toJob(r) : undefined; }
  listJobs(limit = 200): JobRow[] { return this.db.all<Row>('SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT ?', limit).map(toJob); }
  history(jobId: string) { return this.db.all('SELECT * FROM job_steps WHERE job_id = ? ORDER BY id', jobId); }

  // ---------------------------------------------------------------- laço de execução
  async pump(): Promise<void> {
    if (this.pumping || this.stopped) return; this.pumping = true;
    try {
      for (const s of STATIONS) {
        if (s === 'approval') { this.queueApprovals(); continue; }
        const w = this.workers.get(s); if (!w || this.unavailable.has(s)) continue;
        while (this.running.size < this.cfg.maxJobs && this.countRunning(s) < this.cfg.concurrency[s]) {
          const row = this.claim(s); if (!row) break;
          void this.runStep(toJob(row), w);
        }
      }
    } catch (e) { this.log.error('falha no pump', { err: String(e) }); } finally { this.pumping = false; }
  }

  private countRunning(s: StationId) { let n = 0; for (const r of this.running.values()) if (r.station === s) n++; return n; }

  /** Reserva atômica: um job nunca é processado duas vezes ao mesmo tempo. */
  private claim(s: StationId): Row | undefined {
    return this.db.tx(() => {
      const r = this.db.get<Row>(`SELECT * FROM jobs WHERE station_id = ? AND state = 'queued' AND locked_by IS NULL AND (not_before IS NULL OR not_before <= ?)
        ORDER BY priority DESC, created_at LIMIT 1`, s, this.now());
      if (!r) return undefined;
      const upd = this.db.run("UPDATE jobs SET state = 'validating', locked_by = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND state = 'queued' AND locked_by IS NULL", this.owner, this.now(), r.id);
      return Number(upd.changes) === 1 ? this.db.get<Row>('SELECT * FROM jobs WHERE id = ?', r.id) : undefined;
    });
  }

  private async runStep(job: JobRow, w: Worker): Promise<void> {
    const station = w.stationId, abort = new AbortController();
    this.running.set(job.id, { station, abort });
    const stepId = Number(this.db.run('INSERT INTO job_steps (job_id, station_id, attempt, state, started_at) VALUES (?, ?, ?, ?, ?)', job.id, station, job.attempts, 'validating', this.now()).lastInsertRowid);
    this.db.run('UPDATE jobs SET started_at = COALESCE(started_at, ?) WHERE id = ?', this.now(), job.id);
    this.setEmployee(station, 'working', job.id, 0);
    this.publish({ event: 'clip.station.started', jobId: job.id, stationId: station, payload: { attempt: job.attempts, name: job.name } });
    this.publish({ event: 'clip.job.started', jobId: job.id, stationId: station, payload: { name: job.name, attempt: job.attempts } });
    try {
      await w.validate(job);
      this.transition(job.id, 'processing', { progress: 0 });
      const workDir = this.stepDir(job, station);
      const ctx: StepContext = {
        job, attempt: job.attempts, signal: abort.signal, workDir,
        reportProgress: (p, message) => this.reportProgress(job.id, station, p, message),
        log: (level, message, data) => this.log[level](message, { jobId: job.id, stationId: station, ...data }),
        emit: (d) => this.publish({ ...d, jobId: job.id, stationId: station }),
      };
      const result = await w.execute(job, ctx);
      if (abort.signal.aborted) throw new Error('aborted');
      this.verifyResult(result);
      this.db.tx(() => {
        this.db.run("UPDATE job_steps SET state = 'completed', finished_at = ?, output_path = ?, result_json = ? WHERE id = ?", this.now(), result.outputPath, JSON.stringify(result.metadata ?? {}), stepId);
        for (const f of [{ kind: result.kind ?? 'output', path: result.outputPath }, ...(result.extraFiles ?? [])]) {
          const st = fs.statSync(f.path);
          this.db.run('INSERT INTO media_files (job_id, station_id, kind, path, size_bytes, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', job.id, station, f.kind, f.path, st.size, JSON.stringify(result.metadata ?? {}), this.now());
        }
        this.db.run('UPDATE jobs SET current_path = ?, progress = 100, updated_at = ? WHERE id = ?', result.outputPath, this.now(), job.id);
      });
      this.publish({ event: 'clip.station.completed', jobId: job.id, stationId: station, payload: { output: path.basename(result.outputPath), metadata: result.metadata ?? {} } });
      this.setEmployee(station, 'completed', job.id, 100);
      this.handoff(job.id, station, result.outputPath);
    } catch (thrown) {
      const e = thrown instanceof Error ? thrown : new Error(String(thrown));
      const want = this.running.get(job.id)?.want;
      if (want === 'pause') { this.db.run("UPDATE job_steps SET state = 'paused', finished_at = ? WHERE id = ?", this.now(), stepId); this.settle(job.id, 'paused', station); }
      else if (want === 'cancel') { this.db.run("UPDATE job_steps SET state = 'cancelled', finished_at = ? WHERE id = ?", this.now(), stepId); this.settle(job.id, 'cancelled', station); }
      else if (want === 'shutdown') this.db.run("UPDATE job_steps SET state = 'interrupted', finished_at = ? WHERE id = ?", this.now(), stepId); // recover() decide na próxima abertura
      else this.failStep(job, station, stepId, e);
    } finally {
      if (this.running.get(job.id)?.abort === abort) this.running.delete(job.id); // a etapa seguinte pode já ter registrado o mesmo job
      this.lastProgress.delete(job.id);
      if (this.running.size < this.cfg.maxJobs && !this.stopped) setTimeout(() => void this.pump(), 0);
    }
  }

  private verifyResult(r: StepResult) {
    if (!r?.outputPath) throw new Error('worker não informou o arquivo resultante');
    const root = path.join(this.d.dataDir, 'projects');
    for (const f of [r.outputPath, ...(r.extraFiles ?? []).map((x) => x.path)]) ensureInside(root, f); // resultado só dentro da pasta de projetos
    const st = fs.statSync(r.outputPath);
    if (!st.isFile() || st.size === 0) throw new Error(`arquivo resultante inválido ou vazio: ${r.outputPath}`);
  }

  private stepDir(job: JobRow, station: StationId): string {
    const root = path.join(this.d.dataDir, 'projects');
    const dir = ensureInside(root, path.join(job.projectId, job.id, station));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private reportProgress(jobId: string, station: StationId, p: number, message?: string) {
    if (!Number.isFinite(p)) return;
    const v = Math.max(0, Math.min(100, Math.round(p))), last = this.lastProgress.get(jobId), t = Date.now();
    if (last && v === last.p) return;
    if (last && v < 100 && t - last.t < 250) return; // limita a taxa de eventos
    this.lastProgress.set(jobId, { p: v, t });
    this.db.run('UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ?', v, this.now(), jobId);
    this.db.run('UPDATE employees SET progress = ?, last_activity_at = ? WHERE station_id = ?', v, this.now(), station);
    this.publish({ event: 'clip.station.progress', jobId, stationId: station, payload: { progress: v, status: 'processing', message: message ?? '' } });
    this.publish({ event: 'clip.job.progress', jobId, stationId: station, payload: { progress: v, status: 'processing', message: message ?? '' } });
  }

  // ---------------------------------------------------------------- transferência entre estações
  /** Etapa concluída e persistida -> registra a transferência, confere o arquivo e entrega ao próximo funcionário. */
  private handoff(jobId: string, from: StationId, file: string, to: StationId | null = nextStation(from)) {
    if (!to) {
      this.transition(jobId, 'completed', { completed: true, progress: 100 });
      this.publish({ event: 'clip.job.completed', jobId, stationId: from, payload: { duration: this.elapsedSec(jobId) } });
      this.setEmployee(from, 'idle'); this.publish({ event: 'clip.station.idle', stationId: from, payload: {} });
      return;
    }
    this.transition(jobId, 'transferring');
    const tid = Number(this.db.run("INSERT INTO transfers (job_id, from_station, to_station, file_path, state, created_at) VALUES (?, ?, ?, ?, 'started', ?)", jobId, from, to, file, this.now()).lastInsertRowid);
    this.setEmployee(from, 'transferring', jobId);
    const name = path.basename(file);
    this.publish({ event: 'clip.transfer.started', jobId, stationId: from, payload: { from, to, fromDesk: STATION_INFO[from].deskId, toDesk: STATION_INFO[to].deskId, file: name } });
    try {
      const st = fs.statSync(file); if (!st.isFile() || st.size === 0) throw new Error('arquivo a transferir não existe ou está vazio');
      this.db.tx(() => {
        this.db.run("UPDATE transfers SET state = 'completed', completed_at = ? WHERE id = ?", this.now(), tid);
        this.db.run("UPDATE jobs SET state = 'queued', station_id = ?, employee_id = ?, progress = 0, locked_by = NULL, not_before = NULL, updated_at = ? WHERE id = ?", to, STATION_INFO[to].employeeId, this.now(), jobId);
      });
    } catch (e) {
      this.db.run("UPDATE transfers SET state = 'failed', error = ? WHERE id = ?", String(e), tid);
      this.db.run("UPDATE jobs SET state = 'failed', error = ?, locked_by = NULL, updated_at = ? WHERE id = ?", `transferência falhou: ${(e as Error).message}`, this.now(), jobId);
      this.publish({ event: 'clip.transfer.failed', jobId, stationId: from, payload: { from, to, error: (e as Error).message } });
      this.publish({ event: 'clip.job.failed', jobId, stationId: from, payload: { error: `transferência falhou: ${(e as Error).message}` } });
      this.setEmployee(from, 'error', jobId); return;
    }
    this.setEmployee(from, 'idle'); this.publish({ event: 'clip.station.idle', stationId: from, payload: {} });
    this.publish({ event: 'clip.transfer.completed', jobId, stationId: from, payload: { from, to, file: name } });
    this.publish({ event: 'clip.file.received', jobId, stationId: to, payload: { from, file: name } });
    this.setEmployee(to, to === 'approval' ? 'receiving' : 'receiving', jobId);
    this.publish({ event: 'clip.job.queued', jobId, stationId: to, payload: { name: this.job(jobId)?.name ?? '', platforms: this.job(jobId)?.platforms ?? [] } });
    void this.pump();
  }

  // ---------------------------------------------------------------- aprovação humana
  private queueApprovals() {
    for (const r of this.db.all<Row>("SELECT * FROM jobs WHERE station_id = 'approval' AND state = 'queued' AND locked_by IS NULL")) {
      this.transition(r.id, 'awaiting_approval');
      if (!this.db.get("SELECT 1 AS x FROM approvals WHERE job_id = ? AND state = 'pending'", r.id)) this.db.run("INSERT INTO approvals (job_id, state, requested_at) VALUES (?, 'pending', ?)", r.id, this.now());
      this.setEmployee('approval', 'working', r.id, 0);
      this.publish({ event: 'clip.station.started', jobId: r.id, stationId: 'approval', payload: { name: r.name } });
      this.publish({ event: 'clip.job.started', jobId: r.id, stationId: 'approval', payload: { name: r.name } });
      this.publish({ event: 'clip.approval.pending', jobId: r.id, stationId: 'approval', payload: { file: path.basename(r.current_path), name: r.name } });
    }
  }

  decide(raw: unknown): JobRow {
    const d = ApprovalDecision.parse(raw), job = this.job(d.jobId);
    if (!job) throw new Error('job inexistente'); if (job.state !== 'awaiting_approval') throw new Error(`job não está aguardando aprovação (${job.state})`);
    this.db.run("UPDATE approvals SET state = ?, decided_by = ?, note = ?, decided_at = ? WHERE job_id = ? AND state = 'pending'", d.decision === 'approve' ? 'approved' : 'rejected', d.user, d.note, this.now(), d.jobId);
    this.setEmployee('approval', 'completed', d.jobId, 100);
    this.publish({ event: 'clip.station.completed', jobId: d.jobId, stationId: 'approval', payload: { decision: d.decision, user: d.user, note: d.note } });
    if (d.decision === 'approve') {
      this.transition(d.jobId, 'approved');
      this.publish({ event: 'clip.approval.approved', jobId: d.jobId, stationId: 'approval', payload: { user: d.user, note: d.note } });
      this.handoff(d.jobId, 'approval', job.currentPath, job.platforms.length ? 'publishing' : null); // sem destino: encerra aqui, sem publicar nada
    } else {
      this.transition(d.jobId, 'rejected');
      this.publish({ event: 'clip.approval.rejected', jobId: d.jobId, stationId: 'approval', payload: { user: d.user, note: d.note } });
      this.publish({ event: 'clip.approval.revision_requested', jobId: d.jobId, stationId: 'approval', payload: { to: this.cfg.revisionStation, note: d.note } });
      this.handoff(d.jobId, 'approval', job.currentPath, this.cfg.revisionStation); // histórico anterior permanece em job_steps
    }
    return this.job(d.jobId)!;
  }

  // ---------------------------------------------------------------- pausa, retomada, cancelamento, retry
  act(raw: unknown): JobRow {
    const { jobId, action } = JobAction.parse(raw), job = this.job(jobId); if (!job) throw new Error('job inexistente');
    const run = this.running.get(jobId);
    if (action === 'pause' || action === 'cancel') {
      if (run) { run.want = action; run.abort.abort(); this.workers.get(run.station)?.cancel(jobId); return job; } // finaliza em runStep
      this.settle(jobId, action === 'pause' ? 'paused' : 'cancelled', job.stationId as StationId);
    } else if (action === 'resume') {
      if (job.state !== 'paused') throw new Error('job não está pausado');
      this.transition(jobId, 'queued', { unlock: true }); this.publish({ event: 'clip.job.resumed', jobId, stationId: job.stationId, payload: {} });
      this.publish({ event: 'clip.job.queued', jobId, stationId: job.stationId, payload: { name: job.name, resumed: true } }); void this.pump();
    } else {
      if (job.state !== 'failed') throw new Error('só jobs com falha podem ser reexecutados');
      this.transition(jobId, 'queued', { unlock: true, clearError: true });
      this.setEmployee(job.stationId as StationId, 'idle');
      this.publish({ event: 'clip.job.queued', jobId, stationId: job.stationId, payload: { name: job.name, retry: true } }); void this.pump();
    }
    return this.job(jobId)!;
  }

  private settle(jobId: string, state: 'paused' | 'cancelled', station: StationId) {
    this.transition(jobId, state, { unlock: state !== 'paused' ? true : false, completed: state === 'cancelled' });
    this.db.run("UPDATE approvals SET state = ? WHERE job_id = ? AND state = 'pending'", state, jobId);
    if (state === 'paused') this.db.run('UPDATE jobs SET locked_by = NULL WHERE id = ?', jobId);
    this.setEmployee(station, 'idle'); this.publish({ event: 'clip.station.idle', stationId: station, payload: {} });
    this.publish({ event: state === 'paused' ? 'clip.job.paused' : 'clip.job.cancelled', jobId, stationId: station, payload: {} });
  }

  private failStep(job: JobRow, station: StationId, stepId: number, e: Error) {
    const msg = e.message || String(e);
    this.log.error(`etapa falhou: ${msg}`, { jobId: job.id, stationId: station, stack: e.stack });
    this.db.run("UPDATE job_steps SET state = 'failed', finished_at = ?, error = ? WHERE id = ?", this.now(), msg, stepId);
    const cur = this.job(job.id)!;
    this.db.run("UPDATE jobs SET state = 'failed', error = ?, locked_by = NULL, updated_at = ? WHERE id = ?", msg, this.now(), job.id);
    this.setEmployee(station, 'error', job.id);
    this.publish({ event: 'clip.station.failed', jobId: job.id, stationId: station, payload: { error: msg, attempt: cur.attempts } });
    this.publish({ event: 'clip.job.failed', jobId: job.id, stationId: station, payload: { error: msg, attempt: cur.attempts } });
    if (cur.attempts < this.cfg.maxAttempts) { // retry controlado com recuo crescente
      const at = new Date(Date.now() + this.cfg.retryBackoffMs * cur.attempts).toISOString();
      this.db.run("UPDATE jobs SET state = 'queued', not_before = ?, updated_at = ? WHERE id = ?", at, this.now(), job.id);
      this.publish({ event: 'clip.job.queued', jobId: job.id, stationId: station, payload: { name: job.name, retry: true, retryAt: at, attempt: cur.attempts + 1 } });
    }
  }

  // ---------------------------------------------------------------- recuperação após queda
  async recover(): Promise<number> {
    const rows = this.db.all<Row>("SELECT * FROM jobs WHERE locked_by IS NOT NULL OR state IN ('validating','processing','publishing','transferring')");
    let n = 0;
    for (const r of rows) {
      const job = toJob(r); n++;
      if (r.state === 'transferring') { // continua só se o arquivo existir e a transferência ainda não foi concluída
        const tr = this.db.get<{ id: number; to_station: StationId; from_station: StationId; file_path: string }>("SELECT * FROM transfers WHERE job_id = ? AND state = 'started' ORDER BY id DESC LIMIT 1", job.id);
        // handoff refaz processing -> transferring
      if (tr && fs.existsSync(tr.file_path)) { this.db.run("UPDATE transfers SET state = 'failed', error = 'interrompida' WHERE id = ?", tr.id); this.db.run("UPDATE jobs SET state = 'processing' WHERE id = ?", job.id); this.handoff(job.id, tr.from_station, tr.file_path, tr.to_station); continue; }
        this.db.run("UPDATE jobs SET state = 'failed', error = 'transferência interrompida e arquivo ausente', locked_by = NULL WHERE id = ?", job.id); continue;
      }
      const w = this.workers.get(job.stationId as StationId);
      const verdict = w ? await w.recover(job).catch(() => 'fail' as const) : 'restart';
      if (verdict === 'restart') { this.db.run("UPDATE jobs SET state = 'queued', locked_by = NULL, progress = 0, updated_at = ? WHERE id = ?", this.now(), job.id); this.publish({ event: 'clip.job.queued', jobId: job.id, stationId: job.stationId, payload: { name: job.name, platforms: job.platforms, recovered: true } }); }
      else { this.db.run("UPDATE jobs SET state = 'failed', error = 'etapa interrompida: confirme o estado antes de repetir', locked_by = NULL, updated_at = ? WHERE id = ?", this.now(), job.id); this.publish({ event: 'clip.station.failed', jobId: job.id, stationId: job.stationId, payload: { error: 'etapa interrompida: confirme o estado antes de repetir' } }); }
      this.db.run("UPDATE job_steps SET state = 'interrupted', finished_at = COALESCE(finished_at, ?) WHERE job_id = ? AND state IN ('validating','processing')", this.now(), job.id);
      this.log.warn(`job recuperado (${verdict})`, { jobId: job.id, stationId: job.stationId });
    }
    if (n) this.publish({ event: 'system.recovered', payload: { jobs: n } });
    return n;
  }

  // ---------------------------------------------------------------- helpers
  private elapsedSec(jobId: string): number {
    const j = this.db.get<{ s: string | null }>('SELECT started_at AS s FROM jobs WHERE id = ?', jobId);
    return j?.s ? Math.max(0, Math.round((Date.now() - Date.parse(j.s)) / 1000)) : 0;
  }

  private transition(jobId: string, to: JobState, o: { progress?: number; completed?: boolean; unlock?: boolean; clearError?: boolean } = {}) {
    const cur = this.db.get<{ state: JobState }>('SELECT state FROM jobs WHERE id = ?', jobId);
    if (!cur) throw new Error(`job inexistente: ${jobId}`);
    assertTransition(cur.state, to, jobId);
    this.db.run(`UPDATE jobs SET state = ?, updated_at = ?${o.progress != null ? ', progress = ' + Number(o.progress) : ''}${o.completed ? ', completed_at = ?' : ''}${o.unlock ? ', locked_by = NULL' : ''}${o.clearError ? ', error = NULL' : ''}${to === 'queued' && o.unlock ? ', not_before = NULL' : ''} WHERE id = ?`,
      ...(o.completed ? [to, this.now(), this.now(), jobId] : [to, this.now(), jobId]));
    if (isActive(to)) this.db.run('UPDATE jobs SET updated_at = updated_at WHERE id = ?', jobId);
  }

  private setEmployee(station: StationId, state: EmployeeState, jobId: string | null = null, progress: number | null = null) {
    this.db.run('UPDATE employees SET state = ?, current_job_id = ?, progress = ?, last_activity_at = ? WHERE station_id = ?', state, jobId, progress, this.now(), station);
  }

  employees() { return this.db.all('SELECT e.*, s.desk_id FROM employees e JOIN stations s ON s.id = e.station_id ORDER BY s.position'); }

  private publish(d: EventDraft) {
    const station = d.stationId as StationId | undefined;
    return this.bus.publish({ ...d, ...(station && STATION_INFO[station] ? { employeeId: STATION_INFO[station].employeeId } : {}) });
  }
}

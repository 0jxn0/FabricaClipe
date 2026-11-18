import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Db } from '../src/backend/infrastructure/database/db.ts';
import { Logger } from '../src/backend/infrastructure/logging/logger.ts';
import { EventBus } from '../src/backend/core/event-bus/EventBus.ts';
import { Orchestrator } from '../src/backend/core/orchestrator/Orchestrator.ts';
import { probe, resolveBins, run } from '../src/backend/infrastructure/ffmpeg/ffmpeg.ts';
import { CuttingWorker } from '../src/backend/workers/cutting/CuttingWorker.ts';
import { ConfiguredIntervalPlanner } from '../src/backend/workers/cutting/planner.ts';
import type { StepContext, Worker } from '../src/backend/workers/Worker.ts';
import type { JobRow } from '../src/shared/contracts/jobs.ts';

const dir = fs.mkdtempSync(path.join(process.env.TEST_TMP ?? os.tmpdir(), 'fabrica-cut-'));
const bins = resolveBins();
const sample = path.join(dir, 'amostra.mp4'), longSample = path.join(dir, 'longo.mp4');
const gen = (out: string, secs: number, size: string) => run(bins.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `testsrc=duration=${secs}:size=${size}:rate=25`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`,
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]);

test.before(async () => { assert.equal((await gen(sample, 10, '320x240')).code, 0); assert.equal((await gen(longSample, 40, '960x720')).code, 0); });
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* handles ainda sendo soltos no Windows */ } });

let seq = 0;
const mkJob = (file: string, cut?: { startSec?: number; durationSec?: number }): JobRow => ({
  id: `job-${++seq}`, name: 'x', projectId: 'p', sourcePath: file, currentPath: file, stationId: 'cutting', employeeId: '', state: 'processing', progress: 0,
  createdAt: '', startedAt: null, completedAt: null, config: cut ? { cut } : {}, platforms: [], priority: 5, attempts: 1, error: null,
});
const mkCtx = (job: JobRow, signal = new AbortController().signal) => {
  const wd = fs.mkdtempSync(path.join(dir, 'wd-')), progress: number[] = [];
  const ctx: StepContext = { job, attempt: 1, signal, workDir: wd, reportProgress: (p) => progress.push(p), log() {}, emit() {} };
  return { ctx, wd, progress };
};
/** Quadro em escala de cinza 32x24 no instante t (para comparar conteúdo). */
const frame = (file: string, t: number) => execFileSync(bins.ffmpeg, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=32:24', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { maxBuffer: 1e6 });
const diff = (a: Buffer, b: Buffer) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!); return s / a.length; };

test('corte 2–5 s: duração ≈3 s e conteúdo realmente do trecho', async () => {
  const w = new CuttingWorker({ bins }); await w.initialize();
  const job = mkJob(sample, { startSec: 2, durationSec: 3 }); await w.validate(job);
  const { ctx, wd } = mkCtx(job); const r = await w.execute(job, ctx);
  assert.equal(r.kind, 'cut'); assert.ok(r.outputPath.startsWith(wd)); assert.notEqual(r.outputPath, sample);
  const m = await probe(r.outputPath, bins);
  assert.ok(Math.abs(m.durationSec - 3) <= 0.5, `duração ${m.durationSec}`); assert.ok(m.hasAudio);
  assert.equal(r.metadata!.startSec, 2); assert.equal(r.metadata!.endSec, 5); assert.equal(r.metadata!.planner, 'configured-interval'); assert.equal(r.metadata!.width, 320);
  const first = frame(r.outputPath, 0);
  assert.ok(diff(first, frame(sample, 2)) < diff(first, frame(sample, 0)) / 2, 'primeiro quadro do corte deve vir de ~2 s do original');
  assert.deepEqual(fs.readdirSync(wd), [path.basename(r.outputPath)]); // sem parciais
  const r2 = await w.execute(job, mkCtx(job).ctx); assert.notEqual(r2.outputPath, r.outputPath);
});

test('sem config: vídeo inteiro, mas em arquivo novo', async () => {
  const w = new CuttingWorker({ bins }); const job = mkJob(sample);
  const r = await w.execute(job, mkCtx(job).ctx);
  assert.notEqual(r.outputPath, sample); assert.ok(Math.abs((await probe(r.outputPath, bins)).durationSec - 10) <= 0.5);
});

test('intervalos inválidos são recusados no validate; fim é limitado à duração', async () => {
  const w = new CuttingWorker({ bins });
  await assert.rejects(w.validate(mkJob(sample, { startSec: 11, durationSec: 3 })), /além da duração/);
  await assert.rejects(w.validate(mkJob(sample, { startSec: 9.8 })), /mínimo/);
  await assert.rejects(w.validate(mkJob(path.join(dir, 'nao-existe.mp4'))), /não existe/);
  const iv = new ConfiguredIntervalPlanner().plan(await probe(sample, bins), { cut: { startSec: 8, durationSec: 30 } });
  assert.deepEqual(iv.map((x) => [x.startSec, Math.round(x.endSec)]), [[8, 10]]);
});

test('arquivo corrompido é recusado', async () => {
  const bad = path.join(dir, 'ruim.mp4'); fs.writeFileSync(bad, 'isto não é um vídeo');
  await assert.rejects(new CuttingWorker({ bins }).validate(mkJob(bad)), /ffprobe recusou/);
});

test('progresso real do ffmpeg: monotônico entre 0 e 100', async () => {
  const w = new CuttingWorker({ bins }); const job = mkJob(longSample, { startSec: 1, durationSec: 30 });
  const { ctx, progress } = mkCtx(job); await w.execute(job, ctx);
  assert.ok(progress.length >= 2, `poucas medições: ${progress}`);
  assert.deepEqual(progress, [...progress].sort((a, b) => a - b)); assert.ok(progress.every((p) => p >= 0 && p <= 100)); assert.equal(progress.at(-1), 100);
});

test('cancelamento no meio aborta o ffmpeg e não deixa parcial', async () => {
  const w = new CuttingWorker({ bins }); const job = mkJob(longSample);
  const { ctx, wd } = mkCtx(job); const orig = ctx.reportProgress; let cancelled = false;
  ctx.reportProgress = (p, m) => { orig(p, m); if (!cancelled) { cancelled = true; w.cancel(job.id); } };
  await assert.rejects(w.execute(job, ctx), /aborted/);
  assert.ok(cancelled); assert.deepEqual(fs.readdirSync(wd), []);
  // via ctx.signal
  const ac = new AbortController(), c2 = mkCtx(job, ac.signal); setTimeout(() => ac.abort(), 100);
  await assert.rejects(w.execute(job, c2.ctx), /aborted/); assert.deepEqual(fs.readdirSync(c2.wd), []);
});

test('recover apaga parciais do workDir e manda reiniciar', async () => {
  const job = mkJob(sample), wd = path.join(dir, 'projects', job.projectId, job.id, 'cutting'); fs.mkdirSync(wd, { recursive: true });
  fs.writeFileSync(path.join(wd, 'cut-1.part'), 'x'); fs.writeFileSync(path.join(wd, 'cut-0.mp4'), 'ok');
  assert.equal(await new CuttingWorker({ bins, dataDir: dir }).recover(job), 'restart'); assert.deepEqual(fs.readdirSync(wd), ['cut-0.mp4']);
});

test('integração: Orchestrator captura (cópia) -> corta de verdade -> job chega à fila de subtitles', async () => {
  const capture: Worker = { stationId: 'capture', async initialize() {}, async validate() {}, cancel() {}, async recover() { return 'restart'; },
    async execute(job, ctx) { const out = path.join(ctx.workDir, 'capturado.mp4'); fs.copyFileSync(job.currentPath, out); return { outputPath: out, kind: 'video' }; } };
  const d = fs.mkdtempSync(path.join(dir, 'orch-')); const db = new Db(path.join(d, 'db.sqlite')); db.migrate();
  const logger = new Logger(null); logger.attach(db);
  const orch = new Orchestrator({ db, bus: new EventBus(db), logger, dataDir: d, workers: [capture, new CuttingWorker({ bins, dataDir: d })], config: { pumpIntervalMs: 20 } });
  await orch.start();
  const job = orch.createJob({ name: 'c', sourcePath: sample, config: { cut: { startSec: 2, durationSec: 3 } } });
  const t0 = Date.now(); while (orch.job(job.id)!.stationId !== 'subtitles') { if (Date.now() - t0 > 20000) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 30)); }
  const j = orch.job(job.id)!; assert.equal(j.state, 'queued');
  assert.ok(j.currentPath.includes(path.join(job.id, 'cutting'))); assert.ok(Math.abs((await probe(j.currentPath, bins)).durationSec - 3) <= 0.5);
  await orch.stop();
});

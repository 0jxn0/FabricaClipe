import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../src/backend/infrastructure/database/db.ts';
import { Logger } from '../src/backend/infrastructure/logging/logger.ts';
import { EventBus } from '../src/backend/core/event-bus/EventBus.ts';
import { Orchestrator } from '../src/backend/core/orchestrator/Orchestrator.ts';
import { resolveBins, run } from '../src/backend/infrastructure/ffmpeg/ffmpeg.ts';
import { CaptureWorker } from '../src/backend/workers/capture/CaptureWorker.ts';
import type { JobRow } from '../src/shared/contracts/jobs.ts';
import type { StepContext } from '../src/backend/workers/Worker.ts';

const dir = fs.mkdtempSync(path.join(process.env.TEST_TMP ?? os.tmpdir(), 'fabrica-cap-'));
const bins = resolveBins();
const sample = path.join(dir, 'amostra.mp4');
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const jobFor = (sourcePath: string): JobRow => ({ id: 'job-1', name: 'x', projectId: 'p', sourcePath, currentPath: sourcePath, stationId: 'capture' } as JobRow);
const mkCtx = (workDir: string, signal = new AbortController().signal, progress: number[] = []): StepContext => ({
  job: jobFor(sample), attempt: 1, signal, workDir, reportProgress: (p) => { progress.push(p); }, log() {}, emit() {},
});
const mkWork = () => fs.mkdtempSync(path.join(dir, 'w-'));

test('prepara vídeo de amostra real', async () => {
  const r = await run(bins.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sample]);
  assert.equal(r.code, 0, r.stderr);
});

test('caminho feliz: cópia idêntica, miniatura, metadata e progresso real', async () => {
  const w = new CaptureWorker({ bins }); await w.initialize();
  const job = jobFor(sample); await w.validate(job);
  const work = mkWork(), prog: number[] = [], before = sha(sample);
  const res = await w.execute(job, mkCtx(work, undefined, prog));
  assert.equal(res.kind, 'video');
  assert.notEqual(res.outputPath, sample); assert.ok(res.outputPath.startsWith(work));
  assert.equal(sha(res.outputPath), before); assert.equal(sha(sample), before);
  const thumb = res.extraFiles!.find((f) => f.kind === 'thumbnail')!.path, meta = res.extraFiles!.find((f) => f.kind === 'metadata')!.path;
  assert.ok(fs.statSync(thumb).size > 0); assert.ok(thumb.endsWith('.jpg'));
  const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
  assert.equal(m.width, 320); assert.equal(m.height, 240); assert.equal(m.fps, 25); assert.equal(m.sha256, before);
  assert.equal(m.sizeBytes, fs.statSync(sample).size); assert.equal(m.source, sample);
  assert.equal(m.videoCodec, 'h264'); assert.equal(m.audioCodec, 'aac'); assert.ok(m.audioChannels >= 1);
  assert.ok(Math.abs(m.durationSec - 6) < 0.3); assert.equal(res.metadata!.sha256, before);
  assert.equal(prog.at(-1), 100); assert.deepEqual(prog, [...prog].sort((a, b) => a - b));
  assert.ok(!fs.readdirSync(work).some((f) => f.endsWith('.partial')));
  const res2 = await w.execute(job, mkCtx(work)); // segunda importação nunca sobrescreve
  assert.notEqual(res2.outputPath, res.outputPath);
});

test('validate recusa corrompido, inexistente e extensão inválida', async () => {
  const w = new CaptureWorker({ bins });
  const bad = path.join(dir, 'ruim.mp4'); fs.writeFileSync(bad, 'isto não é um vídeo');
  await assert.rejects(w.validate(jobFor(bad)), /corrompido/);
  await assert.rejects(w.validate(jobFor(path.join(dir, 'nao-existe.mp4'))), /não encontrado/);
  const txt = path.join(dir, 'nota.txt'); fs.writeFileSync(txt, 'x');
  await assert.rejects(w.validate(jobFor(txt)), /Formato não suportado/);
  await assert.rejects(w.validate(jobFor(dir)), /recusado/);
});

test('cancelamento no meio não deixa arquivo parcial', async () => {
  const big = path.join(dir, 'grande.mp4'); fs.copyFileSync(sample, big); fs.appendFileSync(big, Buffer.alloc(64 * 1024 * 1024)); // lixo no fim: o mp4 segue legível
  const w = new CaptureWorker({ bins }), work = mkWork(), ac = new AbortController();
  const ctx = mkCtx(work, ac.signal); ctx.reportProgress = (p) => { if (p >= 10) w.cancel('job-1'); };
  await assert.rejects(w.execute(jobFor(big), ctx), /aborted/);
  assert.deepEqual(fs.readdirSync(work), []);
  assert.equal(fs.statSync(big).size > 64 * 1024 * 1024, true); // original intacto
  const ac2 = new AbortController(); ac2.abort(); // sinal já abortado
  await assert.rejects(w.execute(jobFor(big), mkCtx(work, ac2.signal)), /aborted/);
  assert.deepEqual(fs.readdirSync(work), []);
});

test('recover apaga parciais e manda reiniciar', async () => {
  const data = mkWork(), job = jobFor(sample), step = path.join(data, 'projects', job.projectId, job.id, 'capture');
  fs.mkdirSync(step, { recursive: true }); fs.writeFileSync(path.join(step, 'x.mp4.partial'), 'meio');
  assert.equal(await new CaptureWorker({ bins, dataDir: data }).recover(job), 'restart');
  assert.deepEqual(fs.readdirSync(step), []);
});

test('integração com o Orchestrator: capture -> fila de cutting; demais estações sem worker', async () => {
  const d = mkWork(), db = new Db(path.join(d, 'db.sqlite')); db.migrate();
  const logger = new Logger(null); logger.attach(db);
  const bus = new EventBus(db), events: string[] = []; bus.subscribe((e) => events.push(`${e.event}${e.stationId ? '@' + e.stationId : ''}`));
  const orch = new Orchestrator({ db, bus, logger, dataDir: d, workers: [new CaptureWorker({ bins, dataDir: d })], config: { pumpIntervalMs: 20, retryBackoffMs: 10 } });
  await orch.start();
  const job = orch.createJob({ name: 'cap', sourcePath: sample });
  const t0 = Date.now(); while (orch.job(job.id)!.stationId !== 'cutting') { if (Date.now() - t0 > 15000) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 25)); }
  await new Promise((r) => setTimeout(r, 100));
  const j = orch.job(job.id)!;
  assert.equal(j.state, 'queued'); assert.equal(sha(j.currentPath), sha(sample)); assert.notEqual(j.currentPath, sample);
  assert.ok(events.includes('clip.station.unavailable@cutting'));
  assert.ok(!events.some((e) => e.startsWith('clip.station.started@') && !e.endsWith('@capture')));
  await orch.stop();
});

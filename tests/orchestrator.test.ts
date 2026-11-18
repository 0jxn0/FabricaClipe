import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../src/backend/infrastructure/database/db.ts';
import { Logger } from '../src/backend/infrastructure/logging/logger.ts';
import { EventBus } from '../src/backend/core/event-bus/EventBus.ts';
import { Orchestrator } from '../src/backend/core/orchestrator/Orchestrator.ts';
import { canTransition } from '../src/backend/core/state-machine/jobStateMachine.ts';
import { toLegacy } from '../src/backend/core/compat/legacyBridge.ts';
import type { StationId } from '../src/shared/contracts/stations.ts';
import type { Worker } from '../src/backend/workers/Worker.ts';

// Worker de TESTE: faz trabalho de verdade (copia o arquivo, com progresso medido) para o teste conseguir verificar a saída.
const copyWorker = (stationId: StationId, o: { fail?: () => boolean; delay?: number } = {}): Worker => ({
  stationId, async initialize() {}, async validate() {}, cancel() {}, async recover() { return 'restart'; },
  async execute(job, ctx) {
    if (o.fail?.()) throw new Error('falha de teste');
    const out = path.join(ctx.workDir, `${stationId}-${path.basename(job.currentPath)}`);
    ctx.reportProgress(50); await new Promise((r) => setTimeout(r, o.delay ?? 5));
    if (ctx.signal.aborted) throw new Error('aborted');
    fs.copyFileSync(job.currentPath, out); ctx.reportProgress(100);
    return { outputPath: out, kind: stationId };
  },
});

function setup(workers: Worker[], cfg = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TEST_TMP ?? os.tmpdir(), 'fabrica-'));
  const db = new Db(path.join(dir, 'db.sqlite')); db.migrate();
  const logger = new Logger(null); logger.attach(db);
  const bus = new EventBus(db), events: string[] = []; bus.subscribe((e) => events.push(`${e.event}${e.stationId ? '@' + e.stationId : ''}`));
  const src = path.join(dir, 'in.mp4'); fs.writeFileSync(src, 'video-bytes');
  const orch = new Orchestrator({ db, bus, logger, dataDir: dir, workers, config: { pumpIntervalMs: 20, retryBackoffMs: 10, ...cfg } });
  return { dir, db, bus, orch, events, src };
}
const until = async (f: () => boolean, ms = 4000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 15)); } };
const all: StationId[] = ['capture', 'cutting', 'subtitles', 'rendering', 'publishing'];

test('máquina de estados rejeita transições inválidas', () => {
  assert.equal(canTransition('queued', 'validating'), true);
  assert.equal(canTransition('completed', 'queued'), false);
  assert.equal(canTransition('queued', 'completed'), false);
  assert.equal(canTransition('processing', 'awaiting_approval'), false);
});

test('sem workers as estações ficam indisponíveis e o job não anda', async () => {
  const t = setup([]); await t.orch.start();
  t.orch.createJob({ name: 'x', sourcePath: t.src }); await new Promise((r) => setTimeout(r, 120));
  assert.equal(t.orch.listJobs()[0]!.state, 'queued');
  assert.ok(t.events.includes('clip.station.unavailable@capture'));
  assert.equal(t.db.get<{ state: string }>("SELECT state FROM employees WHERE station_id='capture'")!.state, 'unavailable');
  await t.orch.stop();
});

test('pipeline completo com aprovação humana, transferências persistidas e arquivos verificáveis', async () => {
  const t = setup(all.map((s) => copyWorker(s))); await t.orch.start();
  const job = t.orch.createJob({ name: 'clipe', sourcePath: t.src, platforms: ['youtube'] });
  await until(() => t.orch.job(job.id)!.state === 'awaiting_approval');
  assert.equal(t.orch.job(job.id)!.stationId, 'approval');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!t.events.includes('clip.station.started@publishing'), 'não pode publicar sem aprovação');
  t.orch.decide({ jobId: job.id, decision: 'approve', user: 'ana', note: 'ok' });
  await until(() => t.orch.job(job.id)!.state === 'completed');
  const tr = t.db.all<{ from_station: string; to_station: string; state: string }>('SELECT * FROM transfers ORDER BY id');
  assert.deepEqual(tr.map((x) => `${x.from_station}>${x.to_station}:${x.state}`), ['capture>cutting:completed', 'cutting>subtitles:completed', 'subtitles>rendering:completed', 'rendering>approval:completed', 'approval>publishing:completed']);
  const final = t.orch.job(job.id)!;
  assert.ok(fs.statSync(final.currentPath).size > 0);
  assert.equal(t.db.get<{ decided_by: string }>('SELECT decided_by FROM approvals')!.decided_by, 'ana');
  const seqs = t.bus.since(0).map((e) => e.seq); assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  await t.orch.stop();
});

test('rejeição volta para a revisão e preserva o histórico', async () => {
  const t = setup(all.map((s) => copyWorker(s)), { revisionStation: 'cutting' }); await t.orch.start();
  const job = t.orch.createJob({ name: 'c', sourcePath: t.src });
  await until(() => t.orch.job(job.id)!.state === 'awaiting_approval');
  t.orch.decide({ jobId: job.id, decision: 'reject', note: 'refazer' });
  await until(() => t.orch.job(job.id)!.state === 'awaiting_approval' && t.orch.history(job.id).length > 5);
  assert.equal(t.orch.history(job.id).length, 7); // 4 etapas iniciais + 3 de revisão (corte, legenda, render)
  await t.orch.stop();
});

test('falha com retry controlado e depois falha definitiva', async () => {
  let n = 0; const t = setup([copyWorker('capture', { fail: () => ++n < 2 }), ...all.slice(1).map((s) => copyWorker(s))], { maxAttempts: 3 });
  await t.orch.start(); const job = t.orch.createJob({ name: 'r', sourcePath: t.src });
  await until(() => t.orch.job(job.id)!.stationId === 'cutting');
  assert.equal(n, 2); assert.ok(t.events.includes('clip.station.failed@capture'));
  await t.orch.stop();
  const t2 = setup([copyWorker('capture', { fail: () => true })], { maxAttempts: 2 }); await t2.orch.start();
  const j2 = t2.orch.createJob({ name: 'f', sourcePath: t2.src });
  await until(() => t2.orch.job(j2.id)!.attempts === 2 && t2.orch.job(j2.id)!.state === 'failed');
  await t2.orch.stop();
});

test('cancelamento, pausa e retomada', async () => {
  const t = setup(all.map((s) => copyWorker(s, { delay: 150 }))); await t.orch.start();
  const a = t.orch.createJob({ name: 'a', sourcePath: t.src }), b = t.orch.createJob({ name: 'b', sourcePath: t.src });
  await until(() => t.orch.job(a.id)!.state === 'processing');
  t.orch.act({ jobId: a.id, action: 'cancel' }); await until(() => t.orch.job(a.id)!.state === 'cancelled');
  t.orch.act({ jobId: b.id, action: 'pause' }); await until(() => t.orch.job(b.id)!.state === 'paused');
  t.orch.act({ jobId: b.id, action: 'resume' }); await until(() => t.orch.job(b.id)!.stationId !== 'capture' || t.orch.job(b.id)!.state === 'queued' && false || t.orch.job(b.id)!.state !== 'paused');
  await t.orch.stop(true);
});

test('recuperação após queda: job interrompido volta à fila sem duplicar', async () => {
  const t = setup([copyWorker('capture')]);
  const job = (() => { t.orch.createJob({ name: 'q', sourcePath: t.src }); return t.orch.listJobs()[0]!; })();
  t.db.run("UPDATE jobs SET state = 'processing', locked_by = 'morto' WHERE id = ?", job.id); // simula encerramento no meio
  const o2 = new Orchestrator({ db: t.db, bus: t.bus, logger: new Logger(null), dataDir: t.dir, workers: [copyWorker('capture')], config: { pumpIntervalMs: 20 } });
  await o2.start(); await until(() => o2.job(job.id)!.stationId === 'cutting');
  assert.equal(t.db.all('SELECT 1 FROM jobs').length, 1); assert.ok(t.events.includes('system.recovered'));
  await o2.stop();
});

test('barramento: duplicados ignorados e recuperação por seq', () => {
  const t = setup([]); const a = t.bus.publish({ event: 'system.warning', payload: {}, eventId: '11111111-1111-4111-8111-111111111111' });
  assert.ok(a); assert.equal(t.bus.publish({ event: 'system.warning', payload: {}, eventId: '11111111-1111-4111-8111-111111111111' }), null);
  t.bus.publish({ event: 'system.warning', payload: { n: 2 } });
  assert.equal(t.bus.since(a!.seq).length, 1);
  assert.throws(() => t.bus.publish({ event: 'bogus' as never, payload: {} }));
});

test('ponte legada gera o contrato que o frontend já usa', async () => {
  const t = setup(all.map((s) => copyWorker(s))); const legacy: string[] = []; t.bus.subscribe((e) => { const l = toLegacy(e); if (l) legacy.push(`${l.type}@${l.deskId}`); });
  await t.orch.start(); const job = t.orch.createJob({ name: 'l', sourcePath: t.src }); await until(() => t.orch.job(job.id)!.state === 'awaiting_approval');
  for (const x of ['clip.job.started@desk-1', 'clip.job.completed@desk-1', 'clip.job.transferred@desk-1', 'clip.job.received@desk-2', 'clip.job.started@desk-2']) assert.ok(legacy.includes(x), x);
  await t.orch.stop();
});

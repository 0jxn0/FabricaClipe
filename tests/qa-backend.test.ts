// QA adversarial das fronteiras do backend. Testes que falham aqui = bug real no código-fonte (ver relatório).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../src/backend/infrastructure/database/db.ts';
import { MIGRATIONS } from '../src/backend/infrastructure/database/migrations.ts';
import { Logger } from '../src/backend/infrastructure/logging/logger.ts';
import { EventBus } from '../src/backend/core/event-bus/EventBus.ts';
import { Orchestrator } from '../src/backend/core/orchestrator/Orchestrator.ts';
import { canTransition } from '../src/backend/core/state-machine/jobStateMachine.ts';
import { toLegacy } from '../src/backend/core/compat/legacyBridge.ts';
import { JOB_STATES, STATIONS, STATION_INFO } from '../src/shared/contracts/stations.ts';
import type { StationId } from '../src/shared/contracts/stations.ts';
import type { Worker } from '../src/backend/workers/Worker.ts';

const made: string[] = [];
const mkdtemp = () => { const d = fs.mkdtempSync(path.join(process.env.TEST_TMP ?? os.tmpdir(), 'qa-be-')); made.push(d); return d; };
const orchs: Orchestrator[] = [];
after(() => { for (const o of orchs) { const tm = (o as any).timer; if (tm) clearInterval(tm); (o as any).stopped = true; } for (const d of made) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(10); } };
const all: StationId[] = ['capture', 'cutting', 'subtitles', 'rendering', 'publishing'];

type Exec = Worker['execute'];
const mkWorker = (stationId: StationId, o: Partial<Worker> & { exec?: Exec } = {}): Worker => ({
  stationId, async initialize() {}, async validate() {}, cancel() {}, async recover() { return 'restart'; },
  async execute(job, ctx) {
    const out = path.join(ctx.workDir, `${stationId}-out.mp4`); fs.copyFileSync(job.currentPath, out);
    return { outputPath: out, kind: stationId };
  },
  ...o, ...(o.exec ? { execute: o.exec } : {}),
});

function setup(workers: Worker[], cfg: Record<string, unknown> = {}, opts: { dir?: string } = {}) {
  const dir = opts.dir ?? mkdtemp();
  const db = new Db(path.join(dir, 'db.sqlite')); db.migrate();
  const logger = new Logger(null); logger.attach(db);
  const errs: unknown[] = [];
  const bus = new EventBus(db, (_m, e) => errs.push(e)); const events: string[] = [];
  bus.subscribe((e) => events.push(`${e.event}${e.stationId ? '@' + e.stationId : ''}`));
  const src = path.join(dir, 'in.mp4'); fs.writeFileSync(src, 'video-bytes');
  const mk = (ws: Worker[]) => { const o = new Orchestrator({ db, bus, logger, dataDir: dir, workers: ws, config: { pumpIntervalMs: 15, retryBackoffMs: 10, maxAttempts: 1, ...cfg } as never }); orchs.push(o); return o; };
  const orch = mk(workers);
  return { dir, db, bus, orch, events, src, errs, mk, logger };
}
const state = (t: { orch: Orchestrator }, id: string) => t.orch.job(id)!.state;

// ============================================================ (1) CONCORRÊNCIA
function meter() {
  const s = { g: 0, peakG: 0, st: {} as Record<string, number>, peak: {} as Record<string, number>, perJob: new Map<string, number>(), dup: [] as string[], calls: new Map<string, number>() };
  const wrap = (stationId: StationId, delay = 25): Worker => mkWorker(stationId, {
    async exec(job, ctx) {
      const k = `${job.id}|${stationId}`, n = (s.perJob.get(job.id) ?? 0) + 1; s.perJob.set(job.id, n); if (n > 1) s.dup.push(k);
      s.calls.set(`${k}|${job.attempts}`, (s.calls.get(`${k}|${job.attempts}`) ?? 0) + 1);
      s.g++; s.peakG = Math.max(s.peakG, s.g); s.st[stationId] = (s.st[stationId] ?? 0) + 1; s.peak[stationId] = Math.max(s.peak[stationId] ?? 0, s.st[stationId]!);
      try { await sleep(delay); const out = path.join(ctx.workDir, `${stationId}.mp4`); fs.copyFileSync(job.currentPath, out); return { outputPath: out }; }
      finally { s.g--; s.st[stationId]!--; s.perJob.set(job.id, s.perJob.get(job.id)! - 1); }
    },
  });
  return { s, wrap };
}

test('concorrência: 12 jobs respeitam limite por estação e nenhum job executa duas etapas/vezes ao mesmo tempo', async () => {
  const m = meter(); const t = setup(all.map((x) => m.wrap(x)), { maxJobs: 99, concurrency: { capture: 3, cutting: 2, subtitles: 1, rendering: 1, approval: 99, publishing: 2 } });
  await t.orch.start();
  const ids = Array.from({ length: 12 }, (_, i) => t.orch.createJob({ name: `j${i}`, sourcePath: t.src }).id);
  await until(() => ids.every((id) => state(t, id) === 'awaiting_approval'), 20000);
  assert.ok((m.s.peak.capture ?? 0) <= 3, `capture pico ${m.s.peak.capture}`);
  assert.ok((m.s.peak.cutting ?? 0) <= 2, `cutting pico ${m.s.peak.cutting}`);
  assert.ok((m.s.peak.subtitles ?? 0) <= 1, `subtitles pico ${m.s.peak.subtitles}`);
  assert.ok((m.s.peak.rendering ?? 0) <= 1, `rendering pico ${m.s.peak.rendering}`);
  assert.deepEqual(m.s.dup, [], 'job executando em duas estações/vezes ao mesmo tempo');
  for (const [k, n] of m.s.calls) assert.equal(n, 1, `execução duplicada ${k}`);
  // cada job passou por exatamente 4 etapas
  for (const id of ids) assert.equal(t.orch.history(id).length, 4);
  await t.orch.stop();
});

test('concorrência: limite global maxJobs nunca é excedido (pico medido nos workers)', async () => {
  const m = meter(); const t = setup(all.map((x) => m.wrap(x, 30)), { maxJobs: 2, concurrency: { capture: 9, cutting: 9, subtitles: 9, rendering: 9, approval: 99, publishing: 9 } });
  await t.orch.start();
  const ids = Array.from({ length: 8 }, (_, i) => t.orch.createJob({ name: `g${i}`, sourcePath: t.src }).id);
  await until(() => ids.every((id) => state(t, id) === 'awaiting_approval'), 20000);
  assert.ok(m.s.peakG <= 2, `pico global ${m.s.peakG} > maxJobs 2 (running map perde a entrada do job no handoff)`);
  await t.orch.stop();
});

test('concorrência: createJob em rajada gera ids únicos e sem lacunas de seq no bus', () => {
  const t = setup([]); const ids = new Set<string>();
  for (let i = 0; i < 200; i++) ids.add(t.orch.createJob({ name: `n${i}`, sourcePath: t.src }).id);
  assert.equal(ids.size, 200); assert.equal(t.orch.listJobs(500).length, 200);
});

test('cancelar job em estação > capture: o worker é abortado e o job NÃO ressuscita', async () => {
  let aborted = false, finished = false;
  const slow = mkWorker('subtitles', { async exec(job, ctx) { ctx.signal.addEventListener('abort', () => { aborted = true; }); await sleep(400); finished = true; const o = path.join(ctx.workDir, 's.mp4'); fs.copyFileSync(job.currentPath, o); return { outputPath: o }; } });
  const t = setup([mkWorker('capture'), mkWorker('cutting'), slow, mkWorker('rendering')], { maxAttempts: 3 }); await t.orch.start();
  const j = t.orch.createJob({ name: 'c', sourcePath: t.src });
  await until(() => t.orch.job(j.id)!.stationId === 'subtitles' && state(t, j.id) === 'processing');
  t.orch.act({ jobId: j.id, action: 'cancel' });
  await sleep(700);
  assert.ok(aborted, 'worker de legenda não recebeu abort (running[jobId] sobrescrito/removido no handoff)');
  assert.equal(state(t, j.id), 'cancelled', `job cancelado mudou para ${state(t, j.id)} (finished=${finished})`);
  assert.equal(t.db.all("SELECT 1 FROM transfers WHERE from_station='subtitles'").length, 0);
  await t.orch.stop();
});

test('pausa em estação > capture: job fica pausado e retoma sem executar etapa em duplicidade', async () => {
  const m = meter(); const t = setup(all.map((x) => m.wrap(x, 120))); await t.orch.start();
  const j = t.orch.createJob({ name: 'p', sourcePath: t.src });
  await until(() => t.orch.job(j.id)!.stationId === 'cutting' && state(t, j.id) === 'processing');
  t.orch.act({ jobId: j.id, action: 'pause' });
  await until(() => state(t, j.id) === 'paused'); await sleep(300);
  assert.equal(state(t, j.id), 'paused');
  t.orch.act({ jobId: j.id, action: 'resume' });
  await until(() => state(t, j.id) === 'awaiting_approval', 10000);
  assert.deepEqual(m.s.dup, []);
  await t.orch.stop();
});

// ============================================================ (2) WORKERS HOSTIS
async function runOne(w: Worker, rest: Worker[] = []) {
  const t = setup([w, ...rest]); await t.orch.start();
  const j = t.orch.createJob({ name: 'w', sourcePath: t.src });
  return { t, j };
}
const settleFailed = async (t: ReturnType<typeof setup>, id: string) => { await until(() => ['failed', 'completed', 'cancelled'].includes(state(t, id)) || t.orch.job(id)!.stationId !== 'capture'); };

test('worker: validate lança erro SÍNCRONO -> job failed, erro registrado, fábrica segue viva', async () => {
  let n = 0;
  const w = mkWorker('capture', { validate: ((): Promise<void> => { if (++n === 1) throw new Error('validate-sync'); return Promise.resolve(); }) as never });
  const t = setup([w, mkWorker('cutting')]); await t.orch.start();
  const a = t.orch.createJob({ name: 'a', sourcePath: t.src });
  await until(() => state(t, a.id) === 'failed');
  assert.match(t.orch.job(a.id)!.error!, /validate-sync/);
  assert.equal(t.db.get<{ state: string }>("SELECT state FROM employees WHERE station_id='capture'")!.state, 'error');
  assert.equal(t.db.all("SELECT 1 FROM job_steps WHERE job_id=? AND state='failed'", a.id).length, 1);
  const b = t.orch.createJob({ name: 'b', sourcePath: t.src }); // pump continua funcionando
  await until(() => t.orch.job(b.id)!.stationId !== 'capture');
  await t.orch.stop();
});

test('worker: execute lança erro síncrono -> failed e sem arquivos em media_files', async () => {
  const { t, j } = await runOne(mkWorker('capture', { execute: (() => { throw new Error('exec-sync'); }) as never }));
  await until(() => state(t, j.id) === 'failed');
  assert.match(t.orch.job(j.id)!.error!, /exec-sync/); assert.equal(t.db.all('SELECT 1 FROM media_files').length, 0);
  await t.orch.stop();
});

for (const [nome, make] of [
  ['arquivo inexistente', (dir: string) => path.join(dir, 'nao-existe.mp4')],
  ['arquivo vazio', (dir: string) => { const p = path.join(dir, 'vazio.mp4'); fs.writeFileSync(p, ''); return p; }],
  ['diretório no lugar de arquivo', (dir: string) => dir],
  ['outputPath vazio', () => ''],
] as const) {
  test(`worker: resultado inválido (${nome}) -> failed, nada transferido`, async () => {
    const { t, j } = await runOne(mkWorker('capture', { exec: async (_job, ctx) => ({ outputPath: make(ctx.workDir) }) }), [mkWorker('cutting')]);
    await until(() => state(t, j.id) === 'failed');
    assert.equal(t.db.all('SELECT 1 FROM transfers').length, 0); assert.equal(t.db.all('SELECT 1 FROM media_files').length, 0);
    assert.equal(t.orch.job(j.id)!.stationId, 'capture');
    await t.orch.stop();
  });
}

test('worker: retorna undefined -> failed com mensagem clara (sem TypeError cru)', async () => {
  const { t, j } = await runOne(mkWorker('capture', { exec: (async () => undefined) as never }));
  await until(() => state(t, j.id) === 'failed');
  assert.match(t.orch.job(j.id)!.error!, /worker n[ãa]o informou/);
  await t.orch.stop();
});

test('worker: extraFiles inexistente -> failed e transação desfeita (nenhum media_file órfão, current_path inalterado)', async () => {
  const { t, j } = await runOne(mkWorker('capture', { async exec(job, ctx) { const o = path.join(ctx.workDir, 'o.mp4'); fs.copyFileSync(job.currentPath, o); return { outputPath: o, extraFiles: [{ kind: 'thumb', path: path.join(ctx.workDir, 'fantasma.jpg') }] }; } }));
  await until(() => state(t, j.id) === 'failed');
  assert.equal(t.db.all('SELECT 1 FROM media_files').length, 0);
  assert.equal(t.orch.job(j.id)!.currentPath, t.src);
  await t.orch.stop();
});

test('worker: outputPath FORA do projeto (arquivo em outro diretório) deve ser rejeitado', async () => {
  const outside = path.join(mkdtemp(), 'fora.mp4'); fs.writeFileSync(outside, 'x');
  const { t, j } = await runOne(mkWorker('capture', { exec: async () => ({ outputPath: outside }) }), [mkWorker('cutting')]);
  await sleep(300);
  const rows = t.db.all<{ path: string }>("SELECT path FROM media_files WHERE station_id='capture'");
  assert.ok(rows.every((r) => r.path.startsWith(t.dir)) && !rows.some((r) => r.path === outside), `media_files aceitou outputPath fora do dataDir: ${rows.map((r) => r.path)} (verifyResult sem ensureInside)`);
  await t.orch.stop();
});

test('worker: ignora o signal -> cancel mantém cancelled e descarta resultado tardio', async () => {
  const { t, j } = await runOne(mkWorker('capture', { async exec(job, ctx) { await sleep(250); const o = path.join(ctx.workDir, 'o.mp4'); fs.copyFileSync(job.currentPath, o); return { outputPath: o }; } }), [mkWorker('cutting')]);
  await until(() => state(t, j.id) === 'processing');
  t.orch.act({ jobId: j.id, action: 'cancel' });
  await until(() => state(t, j.id) === 'cancelled'); await sleep(400);
  assert.equal(state(t, j.id), 'cancelled'); assert.equal(t.db.all('SELECT 1 FROM transfers').length, 0);
  assert.equal(t.db.get<{ locked_by: string | null }>('SELECT locked_by FROM jobs WHERE id=?', j.id)!.locked_by, null);
  await t.orch.stop();
});

test('worker que NUNCA resolve: stop(true) não deve segurar o shutdown por 15s e deixa job recuperável', { timeout: 40000 }, async () => {
  const hang = mkWorker('capture', { exec: () => new Promise(() => {}) });
  const { t, j } = await runOne(hang);
  await until(() => state(t, j.id) === 'processing');
  const t0 = Date.now(); await t.orch.stop(true); const el = Date.now() - t0;
  console.log(`# stop(true) com worker pendurado levou ${el}ms`);
  assert.ok(el < 5000, `stop(true) esperou ${el}ms (laço fixo de 15s em Orchestrator.stop)`);
  // reabrir: recover() deve devolver o job à fila
  const o2 = t.mk([mkWorker('capture')]); await o2.start();
  await until(() => o2.job(j.id)!.stationId === 'cutting' || ['queued', 'validating', 'processing'].includes(o2.job(j.id)!.state));
  await o2.stop(true);
});

test('stop(true) com worker que ignora signal: job vira interrompido e reabrir executa só uma etapa concluída', async () => {
  const w = mkWorker('capture', { async exec(job, ctx) { await sleep(200); const o = path.join(ctx.workDir, 'o.mp4'); fs.copyFileSync(job.currentPath, o); return { outputPath: o }; } });
  const { t, j } = await runOne(w);
  await until(() => state(t, j.id) === 'processing');
  await t.orch.stop(true);
  assert.equal(t.db.all("SELECT 1 FROM job_steps WHERE job_id=? AND state='completed'", j.id).length, 0);
  const o2 = t.mk([w]); await o2.start(); await until(() => o2.job(j.id)!.stationId === 'cutting');
  assert.equal(t.db.all("SELECT 1 FROM job_steps WHERE job_id=? AND state='completed'", j.id).length, 1);
  assert.equal(t.db.all('SELECT 1 FROM transfers WHERE job_id=?', j.id).length, 1);
  await o2.stop(true);
});

test('start() chamado duas vezes não vaza setInterval', async () => {
  const live = new Set<unknown>(); const si = globalThis.setInterval, ci = globalThis.clearInterval;
  (globalThis as any).setInterval = (...a: any[]) => { const h = (si as any)(...a); live.add(h); return h; };
  (globalThis as any).clearInterval = (h: any) => { live.delete(h); return ci(h); };
  try {
    const t = setup([]); await t.orch.start(); await t.orch.start(); await t.orch.stop();
    assert.equal(live.size, 0, `${live.size} timers vivos após stop() (start duplo sobrescreve this.timer)`);
  } finally { for (const h of live) ci(h as never); globalThis.setInterval = si; globalThis.clearInterval = ci; }
});

// ============================================================ (3) pause/cancel/retry/decide em estados inesperados
test('act/decide em todos os estados: ou lança erro claro ou aplica transição legal; nunca corrompe', () => {
  const t = setup([]);
  for (const st of JOB_STATES) for (const action of ['pause', 'resume', 'cancel', 'retry'] as const) {
    const j = t.orch.createJob({ name: `${st}-${action}`, sourcePath: t.src });
    t.db.run('UPDATE jobs SET state = ? WHERE id = ?', st, j.id);
    let threw: Error | null = null; try { t.orch.act({ jobId: j.id, action }); } catch (e) { threw = e as Error; }
    const after = t.orch.job(j.id)!.state;
    assert.ok((JOB_STATES as readonly string[]).includes(after), `estado inválido ${after}`);
    if (threw) { assert.equal(after, st, `${st}+${action} lançou mas mudou estado`); assert.ok(threw.message.length > 5); }
    else assert.ok(after === st || canTransition(st, after as never), `${st}+${action} -> ${after} ilegal`);
    if (['completed', 'cancelled'].includes(st)) assert.equal(after, st, `terminal ${st} alterado por ${action}`);
  }
});

test('act/decide em job inexistente ou jobId estranho: erro claro, sem tocar no banco', () => {
  const t = setup([]); const before = t.db.all('SELECT 1 FROM jobs').length;
  for (const id of ['job-999999', "x' OR '1'='1", "job-1'; DROP TABLE jobs;--", 'ç🙂\u0000', '\n', 'a'.repeat(128)]) {
    assert.throws(() => t.orch.act({ jobId: id, action: 'cancel' }), /inexistente/);
    assert.throws(() => t.orch.decide({ jobId: id, decision: 'approve' }), /inexistente/);
    assert.equal(t.orch.job(id), undefined);
  }
  for (const id of ['', 'a'.repeat(129)]) assert.throws(() => t.orch.act({ jobId: id, action: 'cancel' }));
  assert.throws(() => t.orch.act({ jobId: 'job-1', action: 'explode' }));
  assert.throws(() => t.orch.decide({ jobId: 'job-1', decision: 'maybe' }));
  assert.throws(() => t.orch.act(null)); assert.throws(() => t.orch.decide(undefined));
  assert.equal(t.db.all('SELECT 1 FROM jobs').length, before);
});

test('cancel/pause/retry de job concluído ou cancelado não geram evento nem mudam nada', async () => {
  const t = setup([]); const j = t.orch.createJob({ name: 'x', sourcePath: t.src });
  t.db.run("UPDATE jobs SET state='completed' WHERE id=?", j.id); const n = t.bus.lastSeq();
  for (const a of ['cancel', 'pause', 'resume', 'retry'] as const) assert.throws(() => t.orch.act({ jobId: j.id, action: a }));
  assert.equal(t.bus.lastSeq(), n); assert.equal(state(t, j.id), 'completed');
});

async function toApproval(extra: Partial<Parameters<typeof setup>[1]> = {}, platforms: string[] = ['youtube']) {
  const t = setup(all.map((s) => mkWorker(s)), extra); await t.orch.start();
  const j = t.orch.createJob({ name: 'ap', sourcePath: t.src, platforms });
  await until(() => state(t, j.id) === 'awaiting_approval');
  return { t, j };
}

test('decide duplicado: segunda chamada lança, 1 aprovação decidida, 1 transferência para publishing', async () => {
  const { t, j } = await toApproval();
  t.orch.decide({ jobId: j.id, decision: 'approve', user: 'ana' });
  assert.throws(() => t.orch.decide({ jobId: j.id, decision: 'approve', user: 'bob' }), /n[ãa]o est[áa] aguardando/);
  assert.throws(() => t.orch.decide({ jobId: j.id, decision: 'reject', user: 'bob' }));
  await until(() => state(t, j.id) === 'completed');
  const ap = t.db.all<{ state: string; decided_by: string }>('SELECT * FROM approvals WHERE job_id=?', j.id);
  assert.equal(ap.length, 1); assert.equal(ap[0]!.decided_by, 'ana');
  assert.equal(t.db.all("SELECT 1 FROM transfers WHERE to_station='publishing'").length, 1);
  await t.orch.stop();
});

test('rejeição seguida de aprovação: aprovação lança; job volta ao fluxo e reaparece em awaiting_approval com NOVA aprovação', async () => {
  const { t, j } = await toApproval();
  t.orch.decide({ jobId: j.id, decision: 'reject', note: 'refaz' });
  assert.throws(() => t.orch.decide({ jobId: j.id, decision: 'approve' }));
  assert.equal(t.db.all("SELECT 1 FROM transfers WHERE to_station='publishing'").length, 0);
  await until(() => state(t, j.id) === 'awaiting_approval' && t.db.all('SELECT 1 FROM approvals WHERE job_id=?', j.id).length === 2);
  assert.equal(t.db.all("SELECT 1 FROM approvals WHERE state='pending'").length, 1);
  assert.equal(t.db.all("SELECT 1 FROM approvals WHERE state='rejected'").length, 1);
  await t.orch.stop();
});

test('pausar job em awaiting_approval e retomar não pode duplicar a aprovação pendente', async () => {
  const { t, j } = await toApproval();
  t.orch.act({ jobId: j.id, action: 'pause' }); assert.equal(state(t, j.id), 'paused');
  assert.throws(() => t.orch.decide({ jobId: j.id, decision: 'approve' }));
  t.orch.act({ jobId: j.id, action: 'resume' });
  await until(() => state(t, j.id) === 'awaiting_approval');
  assert.equal(t.db.all("SELECT 1 FROM approvals WHERE job_id=? AND state='pending'", j.id).length, 1, 'aprovações pendentes duplicadas após pause/resume');
  await t.orch.stop();
});

test('cancelar job em awaiting_approval não deixa aprovação "pending" órfã', async () => {
  const { t, j } = await toApproval();
  t.orch.act({ jobId: j.id, action: 'cancel' }); assert.equal(state(t, j.id), 'cancelled');
  assert.equal(t.db.all("SELECT 1 FROM approvals WHERE job_id=? AND state='pending'", j.id).length, 0, 'approval pendente de job cancelado');
  assert.throws(() => t.orch.decide({ jobId: j.id, decision: 'approve' }));
  await t.orch.stop();
});

test('aprovar sem plataformas conclui sem publicar; aprovar com arquivo apagado -> failed + transfer failed (sem excecão vazando)', async () => {
  const a = await toApproval({}, []);
  a.t.orch.decide({ jobId: a.j.id, decision: 'approve' }); assert.equal(state(a.t, a.j.id), 'completed');
  assert.equal(a.t.db.all("SELECT 1 FROM transfers WHERE to_station='publishing'").length, 0); await a.t.orch.stop();
  const b = await toApproval(); fs.unlinkSync(b.t.orch.job(b.j.id)!.currentPath);
  assert.doesNotThrow(() => b.t.orch.decide({ jobId: b.j.id, decision: 'approve' }));
  assert.equal(state(b.t, b.j.id), 'failed'); assert.ok(b.t.events.includes('clip.transfer.failed@approval'));
  await b.t.orch.stop();
});

test('retry: job failed definitivo volta à fila, executa de novo e limpa o erro; retry em fila lança', async () => {
  let n = 0; const t = setup([mkWorker('capture', { exec: async (job, ctx) => { if (++n === 1) throw new Error('boom'); const o = path.join(ctx.workDir, 'o.mp4'); fs.copyFileSync(job.currentPath, o); return { outputPath: o }; } }), mkWorker('cutting')]);
  await t.orch.start(); const j = t.orch.createJob({ name: 'r', sourcePath: t.src });
  await until(() => state(t, j.id) === 'failed');
  assert.throws(() => t.orch.act({ jobId: j.id, action: 'resume' })); assert.throws(() => t.orch.act({ jobId: j.id, action: 'pause' }));
  t.orch.act({ jobId: j.id, action: 'retry' });
  await until(() => t.orch.job(j.id)!.stationId !== 'capture');
  assert.equal(t.orch.job(j.id)!.error, null); assert.equal(n, 2);
  assert.throws(() => t.orch.act({ jobId: j.id, action: 'retry' }));
  await t.orch.stop();
});

test('retry/resume repetidos em rajada não enfileiram o job duas vezes', async () => {
  const m = meter(); const t = setup(all.map((x) => m.wrap(x, 60))); await t.orch.start();
  const j = t.orch.createJob({ name: 'burst', sourcePath: t.src });
  t.orch.act({ jobId: j.id, action: 'pause' }); await until(() => state(t, j.id) === 'paused');
  assert.throws(() => t.orch.act({ jobId: j.id, action: 'pause' }));
  t.orch.act({ jobId: j.id, action: 'resume' }); assert.throws(() => t.orch.act({ jobId: j.id, action: 'resume' }));
  await until(() => state(t, j.id) === 'awaiting_approval', 10000);
  assert.deepEqual(m.s.dup, []); assert.equal(t.db.all("SELECT 1 FROM job_steps WHERE job_id=? AND state='completed'", j.id).length, 4);
  await t.orch.stop();
});

// ============================================================ (4) RECOVERY / DB
function forceTransferring(t: ReturnType<typeof setup>, file: string) {
  const j = t.orch.createJob({ name: 'tr', sourcePath: t.src });
  t.db.run("UPDATE jobs SET state='transferring', locked_by='morto', current_path=? WHERE id=?", file, j.id);
  t.db.run("INSERT INTO transfers (job_id, from_station, to_station, file_path, state, created_at) VALUES (?, 'capture', 'cutting', ?, 'started', datetime('now'))", j.id, file);
  return j;
}

test('recovery: job transferring com arquivo APAGADO -> failed claro; reabrir de novo não muda nada nem duplica eventos', async () => {
  const t = setup([mkWorker('capture'), mkWorker('cutting')]); const j = forceTransferring(t, path.join(t.dir, 'sumiu.mp4'));
  const o2 = t.mk([mkWorker('capture'), mkWorker('cutting')]); await o2.start(); await o2.stop();
  assert.equal(o2.job(j.id)!.state, 'failed'); assert.match(o2.job(j.id)!.error!, /ausente|interrompida/);
  assert.equal(t.db.get<{ locked_by: string | null }>('SELECT locked_by FROM jobs WHERE id=?', j.id)!.locked_by, null);
  const rec1 = t.db.all("SELECT 1 FROM event_logs WHERE event='system.recovered'").length;
  const o3 = t.mk([mkWorker('capture'), mkWorker('cutting')]); await o3.start(); await o3.stop();
  assert.equal(t.db.all("SELECT 1 FROM event_logs WHERE event='system.recovered'").length, rec1, 'recovery repetido sem trabalho gerou evento');
  assert.equal(o3.job(j.id)!.state, 'failed'); assert.equal(t.db.all('SELECT 1 FROM jobs').length, 1);
});

test('recovery: job transferring com arquivo PRESENTE continua para a próxima estação (uma transferência concluída)', async () => {
  const t = setup([mkWorker('capture'), mkWorker('cutting')]); const j = forceTransferring(t, t.src);
  const o2 = t.mk([mkWorker('capture'), mkWorker('cutting')]);
  await o2.start(); // handoff() faz transition(transferring->transferring): inválida
  await until(() => o2.job(j.id)!.stationId !== 'capture');
  // o job segue adiante (cutting -> subtitles) enquanto o teste espera: o que importa é UMA transferência capture>cutting concluída
  assert.equal(t.db.all("SELECT 1 FROM transfers WHERE job_id=? AND from_station='capture' AND to_station='cutting' AND state='completed'", j.id).length, 1);
  await o2.stop();
});

test('recovery: banco reaberto 3x não duplica jobs, eventos, passos nem transferências', async () => {
  const t = setup([mkWorker('capture')]); await t.orch.start();
  const j = t.orch.createJob({ name: 'once', sourcePath: t.src }); await until(() => t.orch.job(j.id)!.stationId === 'cutting'); await t.orch.stop();
  const snap = () => ({ jobs: t.db.all('SELECT * FROM jobs').length, steps: t.db.all('SELECT 1 FROM job_steps').length, tr: t.db.all('SELECT 1 FROM transfers').length, appr: t.db.all('SELECT 1 FROM approvals').length, emp: t.db.all('SELECT 1 FROM employees').length, st: t.db.all('SELECT 1 FROM stations').length });
  const a = snap();
  for (let i = 0; i < 3; i++) { const o = t.mk([mkWorker('capture')]); await o.start(); await sleep(60); await o.stop(); }
  assert.deepEqual(snap(), a); assert.equal(a.emp, 6); assert.equal(a.st, 6);
  const ids = t.db.all<{ event_id: string }>('SELECT event_id FROM event_logs'); assert.equal(new Set(ids.map((x) => x.event_id)).size, ids.length);
  assert.equal(t.db.all("SELECT 1 FROM event_logs WHERE event='system.recovered'").length, 0);
});

test('recovery: job processing com locked_by + publishing com recover()="fail" -> failed sem executar de novo', async () => {
  const w = mkWorker('capture', { recover: async () => 'fail' });
  const t = setup([w]); const j = t.orch.createJob({ name: 'q', sourcePath: t.src });
  t.db.run("UPDATE jobs SET state='processing', locked_by='morto' WHERE id=?", j.id);
  t.db.run("INSERT INTO job_steps (job_id, station_id, attempt, state, started_at) VALUES (?, 'capture', 1, 'processing', datetime('now'))", j.id);
  const o = t.mk([w]); await o.start(); await sleep(100);
  assert.equal(o.job(j.id)!.state, 'failed'); assert.equal(t.db.all("SELECT 1 FROM job_steps WHERE state='interrupted'").length, 1);
  await o.stop();
});

test('recovery: worker.recover() que lança -> trata como fail (não derruba start)', async () => {
  const w = mkWorker('capture', { recover: async () => { throw new Error('x'); } });
  const t = setup([w]); const j = t.orch.createJob({ name: 'q', sourcePath: t.src });
  t.db.run("UPDATE jobs SET state='validating', locked_by='morto' WHERE id=?", j.id);
  const o = t.mk([w]); await o.start(); assert.equal(o.job(j.id)!.state, 'failed'); await o.stop();
});

test('recovery: estação com worker ausente restaura job para queued (sem travar locked_by)', async () => {
  const t = setup([]); const j = t.orch.createJob({ name: 'q', sourcePath: t.src });
  t.db.run("UPDATE jobs SET state='processing', locked_by='morto' WHERE id=?", j.id);
  const o = t.mk([]); await o.start(); assert.equal(o.job(j.id)!.state, 'queued');
  assert.equal(t.db.get<{ l: string | null }>('SELECT locked_by AS l FROM jobs WHERE id=?', j.id)!.l, null); await o.stop();
});

test('db: migrate() duas vezes (mesma conexão e conexão nova) é idempotente e não duplica seed', () => {
  const dir = mkdtemp(), f = path.join(dir, 'm.sqlite'); const a = new Db(f);
  assert.deepEqual(a.migrate(), MIGRATIONS.map((m) => m.id)); assert.deepEqual(a.migrate(), []);
  const b = new Db(f); assert.deepEqual(b.migrate(), []);
  assert.equal(a.all('SELECT 1 FROM projects').length, 1); assert.equal(a.all('SELECT 1 FROM schema_migrations').length, MIGRATIONS.length);
  assert.equal(a.integrity(), 'ok'); a.close(); b.close();
});

test('db: migração com SQL inválido faz rollback total e não é marcada como aplicada', () => {
  const f = path.join(mkdtemp(), 'bad.sqlite'); const d = new Db(f);
  MIGRATIONS.push({ id: 9999, name: 'ruim', sql: 'CREATE TABLE qa_zz (x INTEGER); INSERT INTO qa_zz VALUES (1); SELEC broken;' });
  try {
    assert.throws(() => d.migrate());
    assert.equal(d.get("SELECT 1 AS x FROM sqlite_master WHERE name='qa_zz'"), undefined, 'DDL parcial vazou');
    assert.equal(d.get('SELECT 1 AS x FROM schema_migrations WHERE id=9999'), undefined);
    assert.equal((d as any).depth, 0, 'depth do tx vazou após falha');
  } finally { MIGRATIONS.pop(); }
  assert.deepEqual(d.migrate(), []); d.close();
});

test('db: tx() cujo BEGIN falha (banco ocupado) não deixa o contador de aninhamento corrompido', () => {
  const f = path.join(mkdtemp(), 'busy.sqlite'); const a = new Db(f); a.migrate(); const b = new Db(f); b.raw.exec('PRAGMA busy_timeout = 30');
  a.raw.exec('BEGIN IMMEDIATE');
  assert.throws(() => b.tx(() => 1));
  a.raw.exec('ROLLBACK');
  assert.equal((b as any).depth, 0, 'Db.tx: depth++ antes do BEGIN e fora do try/finally -> vaza');
  assert.equal(b.tx(() => 7), 7); a.close(); b.close();
});

test('db: tx aninhada com exceção interna desfaz só o savepoint interno', () => {
  const t = setup([]);
  t.db.tx(() => { t.db.run("INSERT INTO settings VALUES ('a','1','x')"); try { t.db.tx(() => { t.db.run("INSERT INTO settings VALUES ('b','1','x')"); throw new Error('int'); }); } catch { /* ok */ } });
  assert.ok(t.db.get("SELECT 1 AS x FROM settings WHERE key='a'")); assert.equal(t.db.get("SELECT 1 AS x FROM settings WHERE key='b'"), undefined);
  assert.equal((t.db as any).depth, 0);
});

test('db: backup com aspas no caminho gera arquivo consistente', () => {
  const t = setup([]); const dest = path.join(mkdtemp(), "bk'up x.sqlite"); t.db.backup(dest);
  const d = new Db(dest); assert.equal(d.integrity(), 'ok'); assert.equal(d.all('SELECT 1 FROM projects').length, 1); d.close();
});

// ============================================================ (5) EVENT BUS
function bus() { const db = new Db(':memory:'); db.migrate(); const errs: unknown[] = []; return { db, bus: new EventBus(db, (_m, e) => errs.push(e)), errs }; }
const count = (db: Db) => db.all('SELECT 1 FROM event_logs').length;

test('bus: eventos inválidos (payload, nome, jobId longo, eventId, timestamp) lançam e não deixam lixo em event_logs', () => {
  const { db, bus: b } = bus(); b.publish({ event: 'system.warning', payload: {} }); const n = count(db), seq0 = b.lastSeq();
  const bad: any[] = [
    { event: 'system.warning', payload: [] }, { event: 'system.warning', payload: 'str' }, { event: 'system.warning', payload: null },
    { event: 'bogus', payload: {} }, { event: 'system.warning', payload: {}, jobId: 'j'.repeat(200) }, { event: 'system.warning', payload: {}, jobId: '' },
    { event: 'system.warning', payload: {}, eventId: 'nao-uuid' }, { event: 'system.warning', payload: {}, timestamp: 'ontem' },
    { event: 'system.warning', payload: {}, stationId: 's'.repeat(40) },
  ];
  for (const d of bad) assert.throws(() => b.publish(d), /inv[áa]lido|Evento/, JSON.stringify(d).slice(0, 60));
  assert.equal(count(db), n); assert.equal(b.since(0).length, n); assert.equal(b.lastSeq(), seq0, 'seq avançou/ficou lixo');
});

test('bus: payload não serializável (circular, BigInt) lança sem gravar nada', () => {
  const { db, bus: b } = bus(); const c: any = {}; c.self = c;
  assert.throws(() => b.publish({ event: 'system.warning', payload: c })); assert.throws(() => b.publish({ event: 'system.warning', payload: { n: 1n } }));
  assert.equal(count(db), 0);
});

test('bus: listener que lança não impede os outros nem o retorno; onError é chamado', () => {
  const { bus: b, errs } = bus(); const seen: string[] = [];
  b.subscribe(() => { throw new Error('l1'); }); b.subscribe((e) => seen.push('B' + e.seq)); b.subscribe(() => { throw 'str'; }); b.subscribe((e) => seen.push('D' + e.seq));
  const e = b.publish({ event: 'system.warning', payload: {} });
  assert.ok(e); assert.deepEqual(seen, ['B1', 'D1']); assert.equal(errs.length, 2);
});

test('bus: unsubscribe dentro do dispatch e subscribe durante dispatch não quebram a rodada', () => {
  const { bus: b } = bus(); const seen: string[] = []; let off: () => void = () => {};
  off = b.subscribe(() => { seen.push('A'); off(); b.subscribe(() => seen.push('late')); }); b.subscribe(() => seen.push('B'));
  b.publish({ event: 'system.warning', payload: {} }); assert.deepEqual(seen, ['A', 'B']);
  b.publish({ event: 'system.warning', payload: {} }); assert.deepEqual(seen, ['A', 'B', 'B', 'late']);
});

test('bus: since() respeita limit, é contíguo e ordenado; limit 0 não devolve nada', () => {
  const { bus: b } = bus(); for (let i = 0; i < 25; i++) b.publish({ event: 'system.warning', payload: { i } });
  const p1 = b.since(0, 10), p2 = b.since(p1.at(-1)!.seq, 10), p3 = b.since(p2.at(-1)!.seq, 10);
  assert.deepEqual([p1.length, p2.length, p3.length], [10, 10, 5]);
  const seqs = [...p1, ...p2, ...p3].map((e) => e.seq); assert.deepEqual(seqs, Array.from({ length: 25 }, (_, i) => i + 1));
  assert.equal(b.since(0, 0).length, 0); assert.equal(b.since(999).length, 0); assert.equal(b.since(-5, 3).length, 3);
});

test('bus: since(seq, limit negativo) não pode devolver o log inteiro (LIMIT -1 do SQLite é ilimitado)', () => {
  const { bus: b } = bus(); for (let i = 0; i < 700; i++) b.publish({ event: 'system.warning', payload: {} });
  assert.ok(b.since(0, -1).length <= 500, 'limit=-1 devolveu tudo (EventBus.since sem clamp)');
});

test('bus: listener que publica (reentrância) -> todos os assinantes veem a MESMA ordem de seq', () => {
  const { bus: b } = bus(); const A: number[] = [], C: number[] = [];
  b.subscribe((e) => { A.push(e.seq); if (e.seq === 1) b.publish({ event: 'system.warning', payload: { nested: true } }); });
  b.subscribe((e) => C.push(e.seq));
  b.publish({ event: 'system.warning', payload: {} });
  assert.deepEqual(C, [1, 2], `assinante C viu ${JSON.stringify(C)} (entrega aninhada fura a ordem; precisa fila no publish)`);
});

test('bus: eventId duplicado é descartado também sob publicação aninhada; payload unicode/10k roundtrip', () => {
  const { bus: b, db } = bus(); const id = '22222222-2222-4222-8222-222222222222';
  b.subscribe((e) => { if (e.eventId !== id) return; assert.equal(b.publish({ event: 'system.warning', payload: {}, eventId: id }), null); });
  assert.ok(b.publish({ event: 'system.warning', payload: {}, eventId: id }));
  const big = { s: "'; DROP TABLE event_logs;--" + 'ç🙂\n"\\'.repeat(2000), nested: { a: [1, 2, { b: null }] } };
  const e = b.publish({ event: 'system.warning', payload: big })!; assert.deepEqual(b.since(e.seq - 1)[0]!.payload, JSON.parse(JSON.stringify(big)));
  assert.equal(count(db), 2);
});

// ============================================================ (6) LEGACY BRIDGE
const validDesk = (d: unknown) => typeof d === 'string' && /^desk-[1-6]$/.test(d);

async function fullRun() {
  const t = setup(all.map((s) => mkWorker(s))); const bad: string[] = [];
  await t.orch.start();
  const j = t.orch.createJob({ name: 'ponte', sourcePath: t.src, platforms: ['youtube', 'tiktok'] });
  await until(() => state(t, j.id) === 'awaiting_approval');
  t.orch.decide({ jobId: j.id, decision: 'reject', note: 'n' });
  await until(() => state(t, j.id) === 'awaiting_approval' && t.db.all('SELECT 1 FROM approvals').length === 2);
  t.orch.decide({ jobId: j.id, decision: 'approve' });
  await until(() => state(t, j.id) === 'completed');
  await t.orch.stop(); return { t, j, bad };
}

test('legacyBridge: todo transfer.started do pipeline completo tem fromDesk/toDesk válidos e distintos; legado traduz sem campos undefined', async () => {
  const { t } = await fullRun(); const evs = t.bus.since(0, 5000);
  const transfers = evs.filter((e) => e.event === 'clip.transfer.started'); assert.ok(transfers.length >= 8);
  for (const e of transfers) {
    const p = e.payload as any; assert.ok(validDesk(p.fromDesk) && validDesk(p.toDesk) && p.fromDesk !== p.toDesk, JSON.stringify(p));
    assert.equal(p.fromDesk, STATION_INFO[p.from as StationId].deskId); assert.equal(p.toDesk, STATION_INFO[p.to as StationId].deskId);
    const l = toLegacy(e)!; assert.equal(l.type, 'clip.job.transferred'); assert.equal(l.deskId, p.fromDesk); assert.equal(l.toDeskId, p.toDesk);
  }
  const undef: string[] = [];
  for (const e of evs) {
    const l = toLegacy(e); if (!l) continue;
    assert.ok(validDesk(l.deskId), `${e.event} -> desk ${String(l.deskId)}`); assert.ok(l.jobId); assert.equal(typeof l.seq, 'number');
    for (const [k, v] of Object.entries(l)) if (v === undefined) undef.push(`${e.event}.${k}`);
  }
  assert.deepEqual([...new Set(undef)], [], 'campos undefined na ponte legada (ex.: clip.job.queued emitido no handoff não leva platforms)');
});

test('legacyBridge: sequência por job é coerente (cada started tem completed/failed/cancelled; transferred precede received)', async () => {
  const { t, j } = await fullRun(); const legacy = t.bus.since(0, 5000).map((e) => toLegacy(e)).filter(Boolean) as any[];
  const mine = legacy.filter((l) => l.jobId === j.id);
  const open = new Map<string, number>();
  for (const l of mine) { if (l.type === 'clip.job.started') open.set(l.deskId, (open.get(l.deskId) ?? 0) + 1); if (['clip.job.completed', 'clip.job.failed', 'clip.job.cancelled'].includes(l.type)) open.set(l.deskId, (open.get(l.deskId) ?? 0) - 1); }
  for (const [d, n] of open) assert.equal(n, 0, `desk ${d} com started sem fim`);
  const seqs = mine.map((l) => l.seq); assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  for (let i = 0; i < mine.length; i++) if (mine[i].type === 'clip.job.received') assert.ok(mine.slice(0, i).some((x) => x.type === 'clip.job.transferred' && x.toDeskId === mine[i].deskId));
});

test('legacyBridge: falha de transferência chega ao frontend como clip.job.failed (hoje só emite eventos sem tradução)', async () => {
  const t = setup(all.map((s) => mkWorker(s))); await t.orch.start();
  t.bus.subscribe((e) => { if (e.event === 'clip.transfer.started' && (e.payload as any).from === 'capture') fs.unlinkSync(t.orch.job(e.jobId!)!.currentPath); });
  const j = t.orch.createJob({ name: 'tf', sourcePath: t.src }); await until(() => state(t, j.id) === 'failed');
  const legacy = t.bus.since(0, 500).filter((e) => e.jobId === j.id).map((e) => toLegacy(e)).filter(Boolean) as any[];
  assert.ok(legacy.some((l) => l.type === 'clip.job.failed'), `legado viu apenas: ${legacy.map((l) => l.type).join(',')}`);
  await t.orch.stop();
});

test('legacyBridge: eventos sem jobId, estação desconhecida e payload vazio não explodem', () => {
  const base = { eventId: '1', version: 1, seq: 1, timestamp: 't', payload: {} } as any;
  assert.equal(toLegacy({ ...base, event: 'system.ready' }), null);
  assert.equal(toLegacy({ ...base, event: 'clip.job.queued', jobId: 'j', stationId: 'nope' }), null);
  assert.equal(toLegacy({ ...base, event: 'clip.job.queued', jobId: 'j' }), null);
  const l = toLegacy({ ...base, event: 'clip.transfer.started', jobId: 'j', payload: {} });
  assert.ok(l === null || validDesk(l.deskId), 'transferred sem fromDesk vira deskId undefined (sem guarda no bridge)');
  assert.equal(toLegacy({ ...base, event: 'clip.job.cancelled', jobId: 'j', stationId: 'capture' }, true)!.replay, true);
});

// ============================================================ (7) SQL / entradas hostis
const NASTY = ["O'Brien", '"; DROP TABLE jobs; --', "'; DROP TABLE jobs;--", 'ação 🙂 日本語 ‮', 'a\nb\tc', '%_\\', 'x'.repeat(120)];

test('SQL: nomes de job com aspas, DROP, unicode e 120 chars são guardados literalmente', async () => {
  const t = setup(all.map((s) => mkWorker(s))); await t.orch.start(); const ids: string[] = [];
  for (const name of NASTY) { const j = t.orch.createJob({ name, sourcePath: t.src }); ids.push(j.id); assert.equal(t.orch.job(j.id)!.name, name.trim()); }
  await until(() => ids.every((id) => state(t, id) === 'awaiting_approval'), 20000);
  assert.ok(t.db.get("SELECT 1 AS x FROM sqlite_master WHERE name='jobs'")); assert.equal(t.orch.listJobs().length, NASTY.length);
  for (const e of t.bus.since(0, 5000)) if (e.event === 'clip.job.created') assert.ok(typeof (e.payload as any).name === 'string');
  await t.orch.stop();
});

test('SQL: nome de 10k caracteres / vazio / só espaços é rejeitado sem criar job nem queimar job_seq', () => {
  const t = setup([]); const seq = () => t.db.get<{ v: string }>("SELECT value_json AS v FROM settings WHERE key='job_seq'")?.v;
  const s0 = seq();
  for (const name of ['x'.repeat(10000), '', '   ', 'x'.repeat(121)]) assert.throws(() => t.orch.createJob({ name, sourcePath: t.src }));
  assert.equal(t.orch.listJobs().length, 0); assert.equal(seq(), s0); assert.equal(t.bus.lastSeq(), 0);
});

test('SQL: sourcePath com aspas/unicode no nome do arquivo funciona; caminhos inválidos são rejeitados', () => {
  const t = setup([]); const p = path.join(t.dir, `we'ird é 🙂;--.mp4`); fs.writeFileSync(p, 'x');
  assert.equal(t.orch.createJob({ name: 'ok', sourcePath: p }).sourcePath, p);
  for (const bad of ['relativo.mp4', path.join(t.dir, 'nao-existe.mp4'), path.join(t.dir, 'a.txt'), t.dir, p + '\0.mp4', 'x'.repeat(2000)]) assert.throws(() => t.orch.createJob({ name: 'x', sourcePath: bad }), (e: unknown) => e instanceof Error, bad.slice(0, 40));
  assert.equal(t.orch.listJobs().length, 1);
});

test('SQL: projectId com aspas/injeção é parametrizado; projectId com path traversal é rejeitado na criação', () => {
  const t = setup([]);
  assert.throws(() => t.orch.createJob({ name: 'x', sourcePath: t.src, projectId: "p'; DROP TABLE projects;--" })); // só [A-Za-z0-9_-] é aceito
  assert.ok(t.db.get("SELECT 1 AS x FROM sqlite_master WHERE name='projects'"));
  assert.throws(() => t.orch.createJob({ name: 'x', sourcePath: t.src, projectId: '../../escape' }));
  assert.throws(() => t.orch.createJob({ name: 'x', sourcePath: t.src, projectId: '..\\..\\escape' }));
});

test('SQL: erro de worker com 10k chars, aspas e unicode é persistido íntegro; evento publicado e job_steps ok', async () => {
  const msg = "falha ' \" ; DROP TABLE jobs; -- 🙂\n" + 'é'.repeat(10000);
  const { t, j } = await runOne(mkWorker('capture', { execute: (async () => { throw new Error(msg); }) as never }));
  await until(() => state(t, j.id) === 'failed');
  assert.equal(t.orch.job(j.id)!.error, msg); assert.equal(t.db.get<{ error: string }>('SELECT error FROM job_steps WHERE job_id=?', j.id)!.error, msg);
  assert.ok(t.events.includes('clip.job.failed@capture')); assert.equal(t.errs.length, 0);
  await t.orch.stop();
});

test('SQL: worker que lança valor não-Error (string/objeto/null) -> job failed sem derrubar o laço', async () => {
  for (const thrown of ['texto puro', { code: 1 }, null, undefined]) {
    const { t, j } = await runOne(mkWorker('capture', { execute: (async () => { throw thrown; }) as never }));
    await until(() => state(t, j.id) === 'failed', 3000).catch(() => { throw new Error(`job travado em ${state(t, j.id)} ao lançar ${String(thrown)}`); });
    await t.orch.stop();
  }
});

test('SQL: ids de jobs gerados são sempre job-N e employee/estações semeados uma vez', () => {
  const t = setup([]); const j = t.orch.createJob({ name: 'a', sourcePath: t.src });
  assert.match(j.id, /^job-\d+$/); assert.deepEqual(t.db.all<{ id: string }>('SELECT id FROM stations ORDER BY position').map((r) => r.id), [...STATIONS]);
  assert.equal(t.orch.employees().length, 6);
});

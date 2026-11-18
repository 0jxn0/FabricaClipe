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
import { RenderWorker } from '../src/backend/workers/rendering/RenderWorker.ts';
import { buildRenderArgs, escapeFilterPath } from '../src/backend/workers/rendering/ffargs.ts';
import type { StepContext, Worker } from '../src/backend/workers/Worker.ts';
import type { JobRow } from '../src/shared/contracts/jobs.ts';

const dir = fs.mkdtempSync(path.join(process.env.TEST_TMP ?? os.tmpdir(), 'fabrica-render-'));
const bins = resolveBins();
const sample = path.join(dir, 'amostra.mp4'), longSample = path.join(dir, 'longo.mp4'), subSample = path.join(dir, 'sub', 'legendado.mp4'), noAudio = path.join(dir, 'mudo.mp4');
const gen = (out: string, secs: number, size: string, audio = true) => run(bins.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `testsrc=duration=${secs}:size=${size}:rate=25`,
  ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`, '-c:a', 'aac', '-shortest'] : []), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out]);
const filters = execFileSync(bins.ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' });
const encoders = execFileSync(bins.ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
const hasAss = /\bsubtitles\b/.test(filters), hasX265 = /\blibx265\b/.test(encoders);

test.before(async () => {
  assert.equal((await gen(sample, 6, '640x360')).code, 0); assert.equal((await gen(longSample, 40, '1280x720')).code, 0);
  assert.equal((await gen(noAudio, 3, '640x360', false)).code, 0);
  fs.mkdirSync(path.dirname(subSample)); fs.copyFileSync(sample, subSample);
  fs.writeFileSync(path.join(dir, 'sub', 'legendado.srt'), '1\n00:00:00,000 --> 00:00:05,000\nOLA MUNDO LEGENDA GRANDE\n');
});
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* handles ainda sendo soltos no Windows */ } });

let seq = 0;
const mkJob = (file: string, render: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): JobRow => ({
  id: `job-${++seq}`, name: 'x', projectId: 'p', sourcePath: file, currentPath: file, stationId: 'rendering', employeeId: '', state: 'processing', progress: 0,
  createdAt: '', startedAt: null, completedAt: null, config: { render: { width: 1080, height: 1920, fps: 30, codec: 'h264', bitrateKbps: 4000, format: 'mp4', audioBitrateKbps: 128, ...render }, ...extra }, platforms: [], priority: 5, attempts: 1, error: null,
});
const mkCtx = (job: JobRow, signal = new AbortController().signal) => {
  const wd = fs.mkdtempSync(path.join(dir, 'wd-')), progress: number[] = [];
  const ctx: StepContext = { job, attempt: 1, signal, workDir: wd, reportProgress: (p) => progress.push(p), log() {}, emit() {} };
  return { ctx, wd, progress };
};
const frame = (file: string, t: number) => execFileSync(bins.ffmpeg, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { maxBuffer: 1e8 });

test('ffargs puro: letterbox, fps, codec, bitrate, áudio, faststart, legenda', () => {
  const base = { render: { width: 1080, height: 1920, fps: 30, codec: 'h264' as const, bitrateKbps: 4000, format: 'mp4' as const, audioBitrateKbps: 128 }, info: { width: 1920, height: 1080, hasAudio: true }, input: 'in.mp4', output: 'out.part' };
  const a = buildRenderArgs(base), vf = a[a.indexOf('-vf') + 1]!;
  assert.match(vf, /scale=1080:1920:force_original_aspect_ratio=decrease/); assert.match(vf, /pad=1080:1920:\(ow-iw\)\/2:\(oh-ih\)\/2:black/); assert.match(vf, /fps=30/); assert.ok(!vf.includes('subtitles'));
  for (const [k, v] of [['-c:v', 'libx264'], ['-b:v', '4000k'], ['-maxrate', '4000k'], ['-bufsize', '8000k'], ['-c:a', 'aac'], ['-b:a', '128k'], ['-pix_fmt', 'yuv420p'], ['-movflags', '+faststart'], ['-f', 'mp4']] as const) assert.equal(a[a.indexOf(k) + 1], v, k);
  const h = buildRenderArgs({ ...base, render: { ...base.render, codec: 'h265', format: 'mov', width: 1081 }, info: { ...base.info, hasAudio: false }, subtitlePath: 'C:\\v ideos\\o\'k [1].srt' });
  assert.equal(h[h.indexOf('-c:v') + 1], 'libx265'); assert.ok(!h.includes('-movflags')); assert.ok(!h.includes('-c:a')); assert.equal(h[h.indexOf('-f') + 1], 'mov');
  const hvf = h[h.indexOf('-vf') + 1]!; assert.match(hvf, /scale=1080:1920/); assert.ok(hvf.includes("subtitles=filename=C\\\\:/v ideos/o\\\\\\'k \\[1\\].srt"), hvf);
  assert.equal(escapeFilterPath('D:\\a\\b.srt'), 'D\\\\:/a/b.srt');
});

test('render 16:9 -> 1080x1920 30fps h264: probe confirma tudo, thumbnail e sem parciais', async () => {
  const w = new RenderWorker({ bins }); await w.initialize();
  const job = mkJob(sample); await w.validate(job);
  const { ctx, wd } = mkCtx(job); const r = await w.execute(job, ctx);
  assert.equal(r.kind, 'render'); assert.ok(r.outputPath.startsWith(wd));
  const m = await probe(r.outputPath, bins);
  assert.equal(m.width, 1080); assert.equal(m.height, 1920); assert.ok(Math.abs(m.fps - 30) <= 0.5); assert.equal(m.videoCodec, 'h264'); assert.ok(m.hasAudio); assert.ok(Math.abs(m.durationSec - 6) <= 0.5);
  assert.equal(r.metadata!.width, 1080); assert.equal(r.metadata!.codec, 'h264'); assert.equal(r.metadata!.subtitlesBurned, false);
  assert.equal(r.extraFiles!.length, 1); assert.equal(r.extraFiles![0]!.kind, 'thumbnail'); assert.ok(fs.statSync(r.extraFiles![0]!.path).size > 0);
  assert.deepEqual(fs.readdirSync(wd).sort(), [path.basename(r.outputPath), path.basename(r.extraFiles![0]!.path)].sort());
  // letterbox: faixa superior da imagem é preta (pad), não conteúdo cortado
  const g = frame(r.outputPath, 1); assert.ok(g.subarray(0, 1080 * 20).every((v) => v <= 20), 'topo deve ser pad preto');
  // bitrate aproximado do pedido (conteúdo sintético: aceita bem abaixo, nunca muito acima)
  assert.ok(m.bitrateKbps! <= 4000 * 1.3, `bitrate ${m.bitrateKbps}`);
});

test('mov, vídeo sem áudio e h265 (se disponível)', async (t) => {
  const w = new RenderWorker({ bins });
  const j1 = mkJob(noAudio, { format: 'mov', width: 540, height: 960 }); const r1 = await w.execute(j1, mkCtx(j1).ctx);
  assert.ok(r1.outputPath.endsWith('.mov')); const m1 = await probe(r1.outputPath, bins); assert.equal(m1.hasAudio, false); assert.equal(m1.width, 540);
  if (!hasX265) return t.skip('ffmpeg sem libx265');
  const j2 = mkJob(sample, { codec: 'h265', width: 540, height: 960 }); const r2 = await w.execute(j2, mkCtx(j2).ctx);
  assert.equal((await probe(r2.outputPath, bins)).videoCodec, 'hevc'); assert.equal(r2.metadata!.codec, 'hevc');
});

test('legenda: .srt ao lado é queimada (se libass) e o arquivo difere do render sem legenda', async () => {
  const w = new RenderWorker({ bins });
  const plain = mkJob(sample, { width: 640, height: 360 }), withSrt = mkJob(subSample, { width: 640, height: 360 });
  const rp = await w.execute(plain, mkCtx(plain).ctx), rs = await w.execute(withSrt, mkCtx(withSrt).ctx);
  assert.equal(rp.metadata!.subtitlesBurned, false); assert.match(String(rp.metadata!.subtitlesNote), /nenhum \.srt/);
  if (!hasAss) { assert.equal(rs.metadata!.subtitlesBurned, false); assert.match(String(rs.metadata!.subtitlesNote), /libass/); return; }
  assert.equal(rs.metadata!.subtitlesBurned, true);
  assert.notDeepEqual(frame(rs.outputPath, 1), frame(rp.outputPath, 1));
  const off = mkJob(subSample, { width: 640, height: 360 }, { subtitles: 'off' }); assert.equal((await w.execute(off, mkCtx(off).ctx)).metadata!.subtitlesBurned, false);
});

test('config incoerente e arquivo inexistente/corrompido são recusados', async () => {
  const w = new RenderWorker({ bins });
  await assert.rejects(w.validate(mkJob(sample, { width: 10 })), /config\.render inválida/);
  await assert.rejects(w.validate(mkJob(path.join(dir, 'nao-existe.mp4'))), /não existe/);
  const bad = path.join(dir, 'ruim.mp4'); fs.writeFileSync(bad, 'isto não é um vídeo');
  await assert.rejects(w.validate(mkJob(bad)), /ffprobe recusou/);
});

test('progresso real do ffmpeg: monotônico entre 0 e 100', async () => {
  const w = new RenderWorker({ bins }); const job = mkJob(longSample, { width: 640, height: 360 });
  const { ctx, progress } = mkCtx(job); await w.execute(job, ctx);
  assert.ok(progress.length >= 2, `poucas medições: ${progress}`);
  assert.deepEqual(progress, [...progress].sort((a, b) => a - b)); assert.ok(progress.every((p) => p >= 0 && p <= 100)); assert.equal(progress.at(-1), 100);
});

test('cancelamento aborta o ffmpeg e não deixa parcial', async () => {
  const w = new RenderWorker({ bins }); const job = mkJob(longSample, { width: 1080, height: 1920 });
  const { ctx, wd } = mkCtx(job); const orig = ctx.reportProgress; let cancelled = false;
  ctx.reportProgress = (p, m) => { orig(p, m); if (!cancelled) { cancelled = true; w.cancel(job.id); } };
  await assert.rejects(w.execute(job, ctx), /aborted/);
  assert.ok(cancelled); assert.deepEqual(fs.readdirSync(wd), []);
  const ac = new AbortController(), c2 = mkCtx(job, ac.signal); setTimeout(() => ac.abort(), 150);
  await assert.rejects(w.execute(job, c2.ctx), /aborted/); assert.deepEqual(fs.readdirSync(c2.wd), []);
});

test('recover apaga parciais do workDir e manda reiniciar', async () => {
  const job = mkJob(sample), wd = path.join(dir, 'projects', job.projectId, job.id, 'rendering'); fs.mkdirSync(wd, { recursive: true });
  fs.writeFileSync(path.join(wd, 'render-1.mp4.part'), 'x'); fs.writeFileSync(path.join(wd, 'render-0.mp4'), 'ok');
  assert.equal(await new RenderWorker({ bins, dataDir: dir }).recover(job), 'restart'); assert.deepEqual(fs.readdirSync(wd), ['render-0.mp4']);
});

test('integração: estações anteriores (cópia) -> render real -> awaiting_approval na estação approval', async () => {
  const copier = (stationId: 'capture' | 'cutting' | 'subtitles'): Worker => ({ stationId, async initialize() {}, async validate() {}, cancel() {}, async recover() { return 'restart'; },
    async execute(job, ctx) { const out = path.join(ctx.workDir, `${stationId}.mp4`); fs.copyFileSync(job.currentPath, out); return { outputPath: out, kind: 'video' }; } });
  const d = fs.mkdtempSync(path.join(dir, 'orch-')); const db = new Db(path.join(d, 'db.sqlite')); db.migrate();
  const logger = new Logger(null); logger.attach(db);
  const orch = new Orchestrator({ db, bus: new EventBus(db), logger, dataDir: d, workers: [copier('capture'), copier('cutting'), copier('subtitles'), new RenderWorker({ bins, dataDir: d })], config: { pumpIntervalMs: 20 } });
  await orch.start();
  const job = orch.createJob({ name: 'r', sourcePath: sample, config: { cut: {}, subtitleLang: 'pt', subtitles: 'auto', render: { width: 540, height: 960, fps: 30, codec: 'h264', bitrateKbps: 2000, format: 'mp4', audioBitrateKbps: 128 } } });
  const t0 = Date.now(); while (orch.job(job.id)!.state !== 'awaiting_approval') { if (Date.now() - t0 > 30000) throw new Error(`timeout: ${orch.job(job.id)!.stationId}/${orch.job(job.id)!.state}`); await new Promise((r) => setTimeout(r, 30)); }
  const j = orch.job(job.id)!; assert.equal(j.stationId, 'approval');
  assert.ok(j.currentPath.includes(path.join(job.id, 'rendering'))); const m = await probe(j.currentPath, bins); assert.equal(m.width, 540); assert.equal(m.height, 960);
  await orch.stop();
});

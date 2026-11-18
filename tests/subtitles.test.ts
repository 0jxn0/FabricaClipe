import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../src/backend/infrastructure/database/db.ts';
import { Logger } from '../src/backend/infrastructure/logging/logger.ts';
import { EventBus } from '../src/backend/core/event-bus/EventBus.ts';
import { Orchestrator } from '../src/backend/core/orchestrator/Orchestrator.ts';
import { probe, resolveBins, run } from '../src/backend/infrastructure/ffmpeg/ffmpeg.ts';
import { SubtitlesWorker } from '../src/backend/workers/subtitles/SubtitlesWorker.ts';
import { SidecarProvider, WhisperCppProvider } from '../src/backend/workers/subtitles/providers.ts';
import { formatTimestamp, normalizeCues, parseSrt, parseTimestamp, parseVtt, toSrt, toVtt, validateCues } from '../src/backend/workers/subtitles/srt.ts';
import type { StepContext, Worker } from '../src/backend/workers/Worker.ts';
import type { JobRow } from '../src/shared/contracts/jobs.ts';

const dir = fs.mkdtempSync(path.join(process.env.TEST_TMP ?? os.tmpdir(), 'fabrica-sub-'));
const bins = resolveBins();
const sample = path.join(dir, 'amostra.mp4'), longSample = path.join(dir, 'longo.mp4');
const gen = (out: string, secs: number) => run(bins.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `testsrc=duration=${secs}:size=320x240:rate=25`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`,
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]);
const SRT = '1\n00:00:01,000 --> 00:00:03,500\nOlá, mundo\nsegunda linha\n\n2\n00:00:04,000 --> 00:00:06,000\nTchau\n';

test.before(async () => { assert.equal((await gen(sample, 10)).code, 0); assert.equal((await gen(longSample, 60)).code, 0); });
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* handles ainda sendo soltos no Windows */ } });

let seq = 0;
const mkJob = (file: string, config: Record<string, unknown> = {}, source = file): JobRow => ({
  id: `job-${++seq}`, name: 'x', projectId: 'p', sourcePath: source, currentPath: file, stationId: 'subtitles', employeeId: '', state: 'processing', progress: 0,
  createdAt: '', startedAt: null, completedAt: null, config, platforms: [], priority: 5, attempts: 1, error: null,
});
const mkCtx = (job: JobRow, signal = new AbortController().signal) => {
  const wd = fs.mkdtempSync(path.join(dir, 'wd-')), progress: number[] = [], logs: { message: string; data?: Record<string, unknown> }[] = [];
  const ctx: StepContext = { job, attempt: 1, signal, workDir: wd, reportProgress: (p) => progress.push(p), log: (_l, message, data) => logs.push({ message, data }), emit() {} };
  return { ctx, wd, progress, logs };
};
const noProviders = () => new SubtitlesWorker({ bins, providers: [new SidecarProvider(), new WhisperCppProvider({ bin: '', model: '' })] });
const withSidecar = (name: string, content = SRT, ext = 'srt') => {
  const d = fs.mkdtempSync(path.join(dir, 'side-')), v = path.join(d, `${name}.mp4`);
  fs.copyFileSync(sample, v); fs.writeFileSync(path.join(d, `${name}.${ext}`), content); return v;
};

test('srt: parse, serialização e round-trip (srt e vtt)', () => {
  const cues = parseSrt(SRT);
  assert.deepEqual(cues, [{ startSec: 1, endSec: 3.5, text: 'Olá, mundo\nsegunda linha' }, { startSec: 4, endSec: 6, text: 'Tchau' }]);
  assert.equal(toSrt(cues), SRT);
  const vtt = toVtt(cues); assert.ok(vtt.startsWith('WEBVTT\n\n00:00:01.000 --> 00:00:03.500\n'));
  assert.deepEqual(parseVtt(vtt), cues);
  assert.deepEqual(parseSrt('\uFEFF' + SRT.replace(/\n/g, '\r\n')), cues);
  assert.deepEqual(parseVtt('WEBVTT\n\nNOTE x\n\nintro\n01:02.5 --> 01:04.000 align:start\nOi\n'), [{ startSec: 62.5, endSec: 64, text: 'Oi' }]);
  assert.equal(parseTimestamp('01:02:03,004'), 3723.004); assert.equal(formatTimestamp(3723.004, ','), '01:02:03,004');
});

test('srt: validação e normalização', () => {
  assert.throws(() => parseTimestamp('1:99:00,000'), /inválido/); assert.throws(() => parseSrt('1\nsem tempo\n'), /sem tempo/); assert.throws(() => parseVtt('1\n00:00.000 --> 00:01.000\nx'), /WEBVTT/);
  const n = normalizeCues([{ startSec: 5, endSec: 8, text: 'b' }, { startSec: 1, endSec: 6, text: 'a' }, { startSec: 9, endSec: 10, text: '  ' }]);
  assert.deepEqual(n.map((c) => [c.text, c.startSec, c.endSec]), [['a', 1, 5], ['b', 5, 8]]); // ordenadas, sem sobreposição, vazias descartadas
  assert.throws(() => normalizeCues([{ startSec: 3, endSec: 3, text: 'x' }]), /duração/); assert.throws(() => normalizeCues([{ startSec: -1, endSec: 3, text: 'x' }]), /inválido/);
  assert.throws(() => validateCues([], 10), /vazias/);
  assert.throws(() => validateCues([{ startSec: 11, endSec: 12, text: 'x' }], 10), /além da duração/); assert.throws(() => validateCues([{ startSec: 1, endSec: 12, text: 'x' }], 10), /além da duração/);
  assert.equal(validateCues([{ startSec: 1, endSec: 10.5, text: 'x' }], 10)[0]!.endSec, 10);
});

test('sidecar .srt ao lado da origem: worker gera .srt/.vtt corretos e vídeo novo', async () => {
  const v = withSidecar('aula'), w = new SubtitlesWorker({ bins }); await w.initialize();
  const job = mkJob(v, { subtitles: 'auto', subtitleLang: 'pt' }); await w.validate(job);
  const { ctx, wd, logs } = mkCtx(job); const r = await w.execute(job, ctx);
  assert.equal(r.kind, 'video'); assert.ok(r.outputPath.startsWith(wd)); assert.notEqual(r.outputPath, v);
  assert.deepEqual(r.metadata, { provider: 'sidecar', lang: 'pt', cues: 2, subtitles: 'auto', state: 'completed' });
  assert.deepEqual(r.extraFiles!.map((f) => f.kind), ['subtitle-srt', 'subtitle-vtt']);
  assert.equal(fs.readFileSync(r.extraFiles![0]!.path, 'utf8'), SRT); assert.deepEqual(parseVtt(fs.readFileSync(r.extraFiles![1]!.path, 'utf8')), parseSrt(SRT));
  assert.ok(fs.readFileSync(r.outputPath).equals(fs.readFileSync(v))); assert.equal(fs.readdirSync(wd).length, 3);
  assert.deepEqual(logs.map((l) => l.data?.state), ['pending', 'processing', 'completed']);
});

test('sidecar .vtt e preferência pelo idioma', async () => {
  const v = withSidecar('b', 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nVtt\n', 'vtt');
  const job = mkJob(v, { subtitles: 'auto' }); const r = await new SubtitlesWorker({ bins }).execute(job, mkCtx(job).ctx);
  assert.equal(r.metadata!.cues, 1); assert.match(fs.readFileSync(r.extraFiles![0]!.path, 'utf8'), /Vtt/);
});

test('legenda além da duração do vídeo é reprovada e não deixa arquivos', async () => {
  const v = withSidecar('c', '1\n00:00:20,000 --> 00:00:22,000\nfora\n'), job = mkJob(v, { subtitles: 'auto' }), { ctx, wd, logs } = mkCtx(job);
  await assert.rejects(new SubtitlesWorker({ bins }).execute(job, ctx), /além da duração/); assert.deepEqual(fs.readdirSync(wd), []); assert.equal(logs.at(-1)!.data?.state, 'error');
});

test("'off': cópia idêntica sem legendas, em arquivo novo", async () => {
  const w = noProviders(), job = mkJob(sample, { subtitles: 'off' }); await w.initialize(); await w.validate(job);
  const { ctx, wd } = mkCtx(job); const r = await w.execute(job, ctx);
  assert.notEqual(r.outputPath, sample); assert.ok(r.outputPath.startsWith(wd)); assert.ok(fs.readFileSync(r.outputPath).equals(fs.readFileSync(sample)));
  assert.equal(r.metadata!.subtitles, 'off'); assert.equal(r.extraFiles, undefined); assert.deepEqual(fs.readdirSync(wd), [path.basename(r.outputPath)]);
  const r2 = await w.execute(job, mkCtx(job).ctx); assert.notEqual(r2.outputPath, r.outputPath);
});

test("'auto' sem provedor: validate falha com mensagem clara; initialize não lança", async () => {
  const w = noProviders(); await w.initialize();
  await assert.rejects(w.validate(mkJob(sample, { subtitles: 'auto' })), /nenhum motor de transcrição disponível: configure o whisper\.cpp ou use legendas desligadas/);
  await assert.rejects(w.validate(mkJob(path.join(dir, 'nao-existe.mp4'), { subtitles: 'off' })), /não existe/);
  const bad = path.join(dir, 'ruim.mp4'); fs.writeFileSync(bad, 'nada'); await assert.rejects(w.validate(mkJob(bad, { subtitles: 'off' })), /ffprobe recusou/);
});

test('WhisperCppProvider com executável FALSO de teste (node): só valida argumentos, progresso e parsing', async () => {
  // O "whisper" abaixo é um script node de teste, NÃO transcreve nada: grava os argumentos recebidos e imprime um SRT fixo.
  const fake = path.join(dir, 'fake-whisper.mjs'), model = path.join(dir, 'ggml-fake.bin'), argsLog = path.join(dir, 'args.json');
  fs.writeFileSync(model, 'x');
  fs.writeFileSync(fake, `import fs from 'node:fs'; const a = process.argv.slice(2); fs.writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(a));
for (const p of [10, 60, 100]) console.error('whisper_print_progress_callback: progress = ' + p + '%');
fs.writeFileSync(a[a.indexOf('-of') + 1] + '.srt', ${JSON.stringify(SRT)});`);
  const p = new WhisperCppProvider({ bin: process.execPath, model, prefixArgs: [fake] });
  assert.equal((await p.isAvailable()).ok, true);
  const audio = path.join(dir, 'a.wav'), prog: number[] = [];
  const cues = await p.transcribe(audio, { lang: 'pt', onProgress: (x) => prog.push(x) });
  assert.equal(cues.length, 2); assert.deepEqual(prog, [10, 60, 100]);
  const a: string[] = JSON.parse(fs.readFileSync(argsLog, 'utf8'));
  assert.deepEqual(a.slice(0, 8), ['-m', model, '-f', audio, '-l', 'pt', '-osrt', '-of']); assert.ok(a.includes('-pp')); assert.ok(!fs.existsSync(`${audio}.out.srt`));
  // fluxo completo no worker: extrai áudio real com ffmpeg e usa o provedor falso
  const job = mkJob(sample, { subtitles: 'auto', subtitleLang: 'en' }), { ctx, progress } = mkCtx(job);
  const r = await new SubtitlesWorker({ bins, providers: [p] }).execute(job, ctx);
  assert.equal(r.metadata!.provider, 'whisper.cpp'); assert.equal(r.metadata!.cues, 2); assert.equal(JSON.parse(fs.readFileSync(argsLog, 'utf8'))[5], 'en');
  assert.deepEqual(progress, [...progress].sort((x, y) => x - y)); assert.equal(progress.at(-1), 100);
  assert.ok(fs.readdirSync(path.dirname(r.outputPath)).every((f) => !f.startsWith('tmp-')), 'wav temporário removido');
});

test('WhisperCppProvider não configurado: indisponível com mensagem clara', async () => {
  const r = await new WhisperCppProvider({ bin: '', model: '' }).isAvailable(); assert.equal(r.ok, false); assert.match(r.detail, /FABRICA_WHISPER_BIN/);
  assert.equal((await new WhisperCppProvider({ bin: 'inexistente.exe', model: 'm' }).isAvailable()).ok, false);
});

test('cancelamento: aborta processos e não deixa parciais', async () => {
  const fake = path.join(dir, 'slow-whisper.mjs'), model = path.join(dir, 'ggml-fake.bin'); fs.writeFileSync(model, 'x'); fs.writeFileSync(fake, 'setTimeout(() => {}, 60000);'); // processo falso que nunca termina
  const w = new SubtitlesWorker({ bins, providers: [new WhisperCppProvider({ bin: process.execPath, model, prefixArgs: [fake] })] }), job = mkJob(longSample, { subtitles: 'auto' });
  const { ctx, wd } = mkCtx(job); const orig = ctx.reportProgress; let cancelled = false;
  ctx.reportProgress = (p, m) => { orig(p, m); if (!cancelled && p >= 19) { cancelled = true; w.cancel(job.id); } };
  await assert.rejects(w.execute(job, ctx), /aborted/); assert.deepEqual(fs.readdirSync(wd), []);
  const ac = new AbortController(), c2 = mkCtx(job, ac.signal); setTimeout(() => ac.abort(), 50);
  await assert.rejects(w.execute(job, c2.ctx), /aborted/); assert.deepEqual(fs.readdirSync(c2.wd), []);
});

test('recover apaga parciais/temporários e manda reiniciar', async () => {
  const job = mkJob(sample), wd = path.join(dir, 'projects', job.projectId, job.id, 'subtitles'); fs.mkdirSync(wd, { recursive: true });
  for (const f of ['a.mp4.part', 'tmp-x.wav', 'sub-0.mp4', 'sub-0.srt']) fs.writeFileSync(path.join(wd, f), 'x');
  assert.equal(await new SubtitlesWorker({ bins, dataDir: dir }).recover(job), 'restart'); assert.deepEqual(fs.readdirSync(wd).sort(), ['sub-0.mp4', 'sub-0.srt']);
});

test('integração: capture/cutting (cópia) + SubtitlesWorker real -> job chega à fila de rendering', async () => {
  const copy = (id: 'capture' | 'cutting', name: string): Worker => ({ stationId: id, async initialize() {}, async validate() {}, cancel() {}, async recover() { return 'restart'; },
    async execute(job, ctx) { const out = path.join(ctx.workDir, name); fs.copyFileSync(job.currentPath, out); return { outputPath: out, kind: 'video' }; } });
  const src = withSidecar('orch'); // origem com .srt ao lado; o currentPath muda ao longo da pipeline, o sidecar segue a origem
  const d = fs.mkdtempSync(path.join(dir, 'orch-')); const db = new Db(path.join(d, 'db.sqlite')); db.migrate();
  const logger = new Logger(null); logger.attach(db);
  const orch = new Orchestrator({ db, bus: new EventBus(db), logger, dataDir: d, workers: [copy('capture', 'capturado.mp4'), copy('cutting', 'cortado.mp4'), new SubtitlesWorker({ bins, dataDir: d })], config: { pumpIntervalMs: 20 } });
  await orch.start();
  const job = orch.createJob({ name: 's', sourcePath: src, config: {} });
  const t0 = Date.now(); while (orch.job(job.id)!.stationId !== 'rendering') { if (Date.now() - t0 > 20000) throw new Error(`timeout (${JSON.stringify(orch.job(job.id))})`); await new Promise((r) => setTimeout(r, 30)); }
  const j = orch.job(job.id)!; assert.equal(j.state, 'queued'); assert.ok(j.currentPath.includes(path.join(job.id, 'subtitles'))); assert.ok(Math.abs((await probe(j.currentPath, bins)).durationSec - 10) <= 0.5);
  await orch.stop();
});

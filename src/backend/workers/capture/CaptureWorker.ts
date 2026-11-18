// Estação CAPTAÇÃO: valida e IMPORTA o vídeo (cópia por stream com sha256 e progresso real), gera miniatura e metadata.json.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { JobRow } from '../../../shared/contracts/jobs.ts';
import { check, probe, resolveBins, run } from '../../infrastructure/ffmpeg/ffmpeg.ts';
import type { Bins, MediaInfo } from '../../infrastructure/ffmpeg/ffmpeg.ts';
import { validateImportFile } from '../../infrastructure/filesystem/safePaths.ts';
import type { StepContext, StepResult, Worker } from '../Worker.ts';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const rm = (p: string) => fs.rmSync(p, { force: true });

export class CaptureWorker implements Worker {
  readonly stationId = 'capture' as const;
  private bins: Bins;
  private dataDir: string | undefined;
  private running = new Map<string, AbortController>();
  private dirs = new Set<string>();

  /** `dataDir` (mesmo do orquestrador) permite ao recover() achar o diretório da etapa após reinício. */
  constructor(o: { dataDir?: string; bins?: Bins } = {}) { this.bins = o.bins ?? resolveBins(); this.dataDir = o.dataDir; }

  async initialize(): Promise<void> {
    const c = await check(this.bins);
    if (!c.ok) throw new Error(`FFmpeg/FFprobe indisponível: ${c.detail}`);
  }

  async validate(job: JobRow): Promise<void> {
    const p = job.sourcePath;
    if (!fs.existsSync(p)) throw new Error(`Arquivo de origem não encontrado: ${p}`);
    try { validateImportFile(p); } catch (e) { throw new Error(`Arquivo de origem recusado: ${errMsg(e)}`); }
    let m: MediaInfo;
    try { m = await probe(p, this.bins); } catch (e) { throw new Error(`Vídeo ilegível ou corrompido: ${errMsg(e)}`); }
    if (!(m.durationSec > 0)) throw new Error('Vídeo com duração inválida');
    if (!(m.width > 0 && m.height > 0)) throw new Error('Vídeo com resolução inválida');
  }

  async execute(job: JobRow, ctx: StepContext): Promise<StepResult> {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal.aborted) ac.abort();
    this.running.set(job.id, ac); this.dirs.add(ctx.workDir);
    const created: string[] = []; // tudo que esta execução criou: removido em qualquer falha
    try {
      const src = job.sourcePath, size = fs.statSync(src).size;
      const ext = path.extname(src), stem = path.basename(src, ext);
      const final = path.join(ctx.workDir, `${stem}-${crypto.randomUUID().slice(0, 8)}${ext}`); // nome único; 'wx' impede sobrescrita
      const part = `${final}.partial`; created.push(part, final);

      // 1) cópia por stream (origem só lida), progresso por bytes: 0–85%
      const hash = crypto.createHash('sha256'); let done = 0, last = -1;
      const tap = new Transform({ transform(chunk: Buffer, _e, cb) {
        hash.update(chunk); done += chunk.length;
        const pct = size ? Math.floor((done / size) * 85) : 85;
        if (pct !== last) { last = pct; ctx.reportProgress(pct, 'Importando vídeo'); }
        cb(null, chunk);
      } });
      await pipeline(fs.createReadStream(src), tap, fs.createWriteStream(part, { flags: 'wx' }), { signal: ac.signal });
      const sha256 = hash.digest('hex');
      fs.renameSync(part, final);

      // 2) integridade: tamanho, sha256 da cópia e leitura pelo ffprobe: 85–95%
      if (fs.statSync(final).size !== size) throw new Error('Integridade: tamanho da cópia difere da origem');
      const copyHash = crypto.createHash('sha256'); let re = 0;
      for await (const c of fs.createReadStream(final)) {
        if (ac.signal.aborted) throw new Error('aborted');
        copyHash.update(c as Buffer); re += (c as Buffer).length;
        ctx.reportProgress(85 + Math.floor((re / size) * 10), 'Verificando integridade');
      }
      return await this.finish(job, ctx, ac.signal, final, sha256, copyHash.digest('hex'), size, created);
    } catch (e) {
      for (const f of created) rm(f);
      if (ac.signal.aborted || ctx.signal.aborted) throw new Error('aborted');
      throw e;
    } finally {
      ctx.signal.removeEventListener('abort', onAbort); this.running.delete(job.id);
    }
  }

  private async finish(job: JobRow, ctx: StepContext, signal: AbortSignal, final: string, sha256: string, copySha: string, size: number, created: string[]): Promise<StepResult> {
    if (copySha !== sha256) throw new Error('Integridade: sha256 da cópia difere da origem');
    const m = await probe(final, this.bins, signal);
    ctx.reportProgress(95, 'Integridade verificada');

    const base = final.slice(0, -path.extname(final).length);
    const thumb = `${base}.thumb.jpg`, meta = `${base}.metadata.json`; created.push(thumb, meta);
    const r = await run(this.bins.ffmpeg, ['-v', 'error', '-y', '-ss', (m.durationSec * 0.1).toFixed(3), '-i', final, '-frames:v', '1', '-q:v', '3', '-update', '1', thumb], { signal, timeoutMs: 60000 });
    if (r.code !== 0 || !fs.existsSync(thumb) || fs.statSync(thumb).size === 0) throw new Error(`Falha ao gerar miniatura: ${r.stderr.trim().split('\n').pop() ?? ''}`);
    ctx.reportProgress(98, 'Miniatura gerada');

    const metadata = {
      durationSec: m.durationSec, width: m.width, height: m.height, fps: m.fps, videoCodec: m.videoCodec, audioCodec: m.audioCodec,
      audioChannels: m.audioChannels, sampleRate: m.sampleRate, bitrateKbps: m.bitrateKbps, sizeBytes: size, sha256, source: job.sourcePath,
    };
    fs.writeFileSync(meta, JSON.stringify(metadata, null, 2));
    ctx.reportProgress(100, 'Captação concluída');
    return { outputPath: final, kind: 'video', metadata, extraFiles: [{ kind: 'thumbnail', path: thumb }, { kind: 'metadata', path: meta }] };
  }

  cancel(jobId: string): void { this.running.get(jobId)?.abort(); }

  async recover(job: JobRow): Promise<'restart' | 'fail'> {
    const dirs = new Set(this.dirs);
    if (this.dataDir) dirs.add(path.join(this.dataDir, 'projects', job.projectId, job.id, 'capture'));
    for (const d of dirs) if (fs.existsSync(d) && d.split(path.sep).includes(job.id)) { // só o diretório deste job
      for (const f of fs.readdirSync(d)) rm(path.join(d, f));
    }
    return 'restart';
  }
}

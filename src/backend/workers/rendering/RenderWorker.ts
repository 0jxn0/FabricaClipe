// Estação RENDER: reencoda para o formato final (letterbox, fps, codec, bitrate, legenda queimada se possível) e CONFERE a saída com ffprobe.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StepContext, StepResult, Worker } from '../Worker.ts';
import { RenderConfig, type JobRow } from '../../../shared/contracts/jobs.ts';
import { check, probe, resolveBins, run, type Bins, type MediaInfo } from '../../infrastructure/ffmpeg/ffmpeg.ts';
import { buildRenderArgs, type RenderCfg } from './ffargs.ts';

const PART = '.part';

/** run() rejeita no abort antes do processo morrer; no Windows o arquivo fica preso por instantes. Best-effort. */
async function removeSoon(files: string[]): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try { for (const f of files) fs.rmSync(f, { force: true }); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
}

export class RenderWorker implements Worker {
  readonly stationId = 'rendering' as const;
  private bins: Bins; private dataDir?: string;
  private active = new Map<string, AbortController>();
  private libass?: Promise<boolean>;

  constructor(o: { bins?: Bins; dataDir?: string } = {}) { this.bins = o.bins ?? resolveBins(); this.dataDir = o.dataDir; }

  async initialize(): Promise<void> {
    const c = await check(this.bins); if (!c.ok) throw new Error(`FFmpeg indisponível: ${c.detail}`);
  }

  /** O ffmpeg empacotado pode ser compilado sem libass; então o filtro `subtitles` não existe. */
  private hasSubtitlesFilter(): Promise<boolean> {
    return this.libass ??= run(this.bins.ffmpeg, ['-hide_banner', '-filters'], { timeoutMs: 10000 }).then((r) => /\bsubtitles\b/.test(r.stdout), () => false);
  }

  /** Convenção: (1) <base do currentPath>.srt ao lado dele; (2) primeiro .srt em <dataDir>/projects/<proj>/<job>/subtitles; (3) único .srt no diretório do currentPath. */
  findSubtitle(job: JobRow): string | undefined {
    const cur = job.currentPath, dir = path.dirname(cur);
    const same = path.join(dir, `${path.basename(cur, path.extname(cur))}.srt`);
    if (fs.existsSync(same)) return same;
    const srts = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.toLowerCase().endsWith('.srt')).sort() : []).map((f) => path.join(d, f));
    if (this.dataDir) { const s = srts(path.join(this.dataDir, 'projects', job.projectId, job.id, 'subtitles')); if (s[0]) return s[0]; }
    const local = srts(dir); return local.length === 1 ? local[0] : undefined;
  }

  private cfg(job: JobRow): RenderCfg {
    const r = RenderConfig.safeParse((job.config as { render?: unknown } | null)?.render);
    if (!r.success) throw new Error(`config.render inválida: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    return r.data;
  }

  private async inspect(job: JobRow, signal?: AbortSignal): Promise<{ info: MediaInfo; render: RenderCfg }> {
    if (!fs.existsSync(job.currentPath) || !fs.statSync(job.currentPath).isFile()) throw new Error(`arquivo de entrada não existe: ${job.currentPath}`);
    return { render: this.cfg(job), info: await probe(job.currentPath, this.bins, signal) };
  }

  async validate(job: JobRow): Promise<void> { await this.inspect(job); }

  async execute(job: JobRow, ctx: StepContext): Promise<StepResult> {
    const own = new AbortController(); this.active.set(job.id, own);
    const signal = AbortSignal.any([ctx.signal, own.signal]);
    const id = `render-${Date.now()}-${randomUUID().slice(0, 8)}`;
    let ext = 'mp4'; const thumb = path.join(ctx.workDir, `${id}.jpg`);
    let part = '', out = '';
    try {
      const { info, render } = await this.inspect(job, signal);
      ext = render.format; part = path.join(ctx.workDir, `${id}.${ext}${PART}`); out = path.join(ctx.workDir, `${id}.${ext}`);
      const srt = job.config && (job.config as { subtitles?: string }).subtitles === 'off' ? undefined : this.findSubtitle(job);
      let subtitlePath: string | undefined, subtitlesNote: string;
      if (!srt) subtitlesNote = 'nenhum .srt encontrado';
      else if (!(await this.hasSubtitlesFilter())) subtitlesNote = 'ffmpeg sem libass/filtro subtitles; legenda não queimada';
      else { subtitlePath = srt; subtitlesNote = 'queimada'; }
      if (srt && !subtitlePath) ctx.log('warn', subtitlesNote, { srt });

      let last = -1;
      const r = await run(this.bins.ffmpeg, buildRenderArgs({ render, info, input: job.currentPath, output: part, subtitlePath }), { signal, onStderr: (l) => {
        const m = /^out_time_(us|ms)=(\d+)$/.exec(l); if (!m) return; // out_time_ms também é em microssegundos
        const p = Math.min(99, Math.floor((Number(m[2]) / 1e6 / info.durationSec) * 100));
        if (p > last) { last = p; ctx.reportProgress(p, 'renderizando'); }
      } });
      if (r.code !== 0) throw new Error(`ffmpeg falhou (${r.code}): ${r.stderr.trim().split('\n').filter((x) => !/^[a-z_0-9]+=/.test(x)).pop() ?? ''}`);
      fs.renameSync(part, out);

      const o = await probe(out, this.bins, signal);
      const want = render.codec === 'h265' ? 'hevc' : 'h264', bad: string[] = [];
      if (o.width !== render.width - (render.width % 2) || o.height !== render.height - (render.height % 2)) bad.push(`resolução ${o.width}x${o.height}`);
      if (Math.abs(o.fps - render.fps) > 0.5) bad.push(`fps ${o.fps}`);
      if (o.videoCodec !== want) bad.push(`codec ${o.videoCodec}`);
      if (Math.abs(o.durationSec - info.durationSec) > 0.5) bad.push(`duração ${o.durationSec.toFixed(2)}s (original ${info.durationSec.toFixed(2)}s)`);
      if (info.hasAudio && !o.hasAudio) bad.push('sem áudio');
      if (bad.length) throw new Error(`saída do render reprovada: ${bad.join(', ')}`);

      const t = await run(this.bins.ffmpeg, ['-v', 'error', '-nostdin', '-n', '-ss', String(Math.min(1, o.durationSec / 2)), '-i', out, '-frames:v', '1', '-q:v', '3', '-update', '1', thumb], { signal });
      if (t.code !== 0 || !fs.existsSync(thumb)) throw new Error(`falha ao gerar thumbnail: ${t.stderr.trim().split('\n').pop() ?? ''}`);
      ctx.reportProgress(100, 'render concluído');
      return { outputPath: out, kind: 'render', extraFiles: [{ kind: 'thumbnail', path: thumb }], metadata: {
        width: o.width, height: o.height, fps: o.fps, codec: o.videoCodec, bitrateKbps: o.bitrateKbps, requestedBitrateKbps: render.bitrateKbps, durationSec: o.durationSec,
        format: ext, hasAudio: o.hasAudio, sizeBytes: o.sizeBytes, subtitlesBurned: !!subtitlePath, subtitlesNote, ...(srt ? { subtitleFile: srt } : {}) } };
    } catch (e) {
      await removeSoon([part, out, thumb].filter(Boolean)); // não deixa parcial nem saída reprovada
      throw e;
    } finally { this.active.delete(job.id); }
  }

  cancel(jobId: string): void { this.active.get(jobId)?.abort(); }

  async recover(job: JobRow): Promise<'restart' | 'fail'> {
    if (this.dataDir) {
      const dir = path.join(this.dataDir, 'projects', job.projectId, job.id, this.stationId);
      if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith(PART)) fs.rmSync(path.join(dir, f), { force: true });
    }
    return 'restart';
  }
}

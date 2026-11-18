// Estação LEGENDAGEM: transcrição REAL (sidecar ou whisper.cpp) -> .srt/.vtt. Com subtitles:'off' só copia o vídeo; nunca inventa legenda.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StepContext, StepResult, Worker } from '../Worker.ts';
import type { JobRow } from '../../../shared/contracts/jobs.ts';
import { probe, resolveBins, run, type Bins, type MediaInfo } from '../../infrastructure/ffmpeg/ffmpeg.ts';
import { SidecarProvider, WhisperCppProvider, type TranscriptionProvider } from './providers.ts';
import { toSrt, toVtt, validateCues } from './srt.ts';

const PART = '.part', TMP = 'tmp-';
const NO_ENGINE = 'nenhum motor de transcrição disponível: configure o whisper.cpp ou use legendas desligadas';

/** No Windows o arquivo fica preso por instantes após o abort. Best-effort. */
async function removeSoon(files: string[]): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try { for (const f of files) fs.rmSync(f, { force: true }); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
}

export class SubtitlesWorker implements Worker {
  readonly stationId = 'subtitles' as const;
  private bins: Bins; private providers: TranscriptionProvider[]; private dataDir?: string;
  private active = new Map<string, AbortController>();

  constructor(o: { dataDir?: string; bins?: Bins; providers?: TranscriptionProvider[] } = {}) {
    this.bins = o.bins ?? resolveBins(); this.dataDir = o.dataDir;
    this.providers = o.providers ?? [new SidecarProvider(), new WhisperCppProvider()]; // Sidecar primeiro
  }

  /** Não lança por falta de provedor: a estação precisa funcionar com subtitles:'off'. */
  async initialize(): Promise<void> {}

  private cfg(job: JobRow) { const c = (job.config ?? {}) as { subtitles?: string; subtitleLang?: string }; return { mode: c.subtitles === 'off' ? 'off' as const : 'auto' as const, lang: c.subtitleLang ?? 'pt' }; }

  private async pick(job: JobRow, lang: string): Promise<TranscriptionProvider> {
    for (const p of this.providers) if ((await p.isAvailable({ sourcePath: job.sourcePath, lang })).ok) return p;
    throw new Error(NO_ENGINE);
  }

  private async info(job: JobRow, signal?: AbortSignal): Promise<MediaInfo> {
    if (!fs.existsSync(job.currentPath) || !fs.statSync(job.currentPath).isFile()) throw new Error(`arquivo de entrada não existe: ${job.currentPath}`);
    return probe(job.currentPath, this.bins, signal);
  }

  async validate(job: JobRow): Promise<void> {
    const info = await this.info(job);
    const { mode, lang } = this.cfg(job);
    if (mode === 'auto' && info.durationSec > 6 * 3600) throw new Error('vídeo com mais de 6 horas: a extração de áudio para a transcrição encheria o disco; corte o vídeo antes ou desligue as legendas');
    if (mode === 'auto') await this.pick(job, lang);
  }

  async execute(job: JobRow, ctx: StepContext): Promise<StepResult> {
    const own = new AbortController(); this.active.set(job.id, own);
    const signal = AbortSignal.any([ctx.signal, own.signal]);
    const id = `sub-${Date.now()}-${randomUUID().slice(0, 8)}`, ext = path.extname(job.currentPath) || '.mp4';
    const vPart = path.join(ctx.workDir, `${id}${ext}${PART}`), vOut = path.join(ctx.workDir, `${id}${ext}`);
    const wav = path.join(ctx.workDir, `${TMP}${id}.wav`), srtOut = path.join(ctx.workDir, `${id}.srt`), vttOut = path.join(ctx.workDir, `${id}.vtt`);
    const { mode, lang } = this.cfg(job);
    ctx.log('info', 'legendagem pendente', { state: 'pending', mode });
    try {
      const info = await this.info(job, signal);
      let result: StepResult;
      if (mode === 'off') {
        ctx.log('info', 'legendas desligadas: copiando o vídeo sem legenda', { state: 'processing', mode });
        fs.copyFileSync(job.currentPath, vPart); fs.renameSync(vPart, vOut);
        result = { outputPath: vOut, kind: 'video', metadata: { subtitles: 'off', state: 'completed' } };
      } else {
        const prov = await this.pick(job, lang);
        ctx.log('info', `transcrevendo com ${prov.name}`, { state: 'processing', provider: prov.name, lang });
        if (prov.needsAudio) {
          const args = ['-v', 'error', '-nostdin', '-nostats', '-stats_period', '0.2', '-progress', 'pipe:2', '-y', '-i', job.currentPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav];
          const r = await run(this.bins.ffmpeg, args, { signal, onStderr: (l) => {
            const m = /^out_time_(?:us|ms)=(\d+)$/.exec(l); if (m) ctx.reportProgress(Math.min(19, Math.floor((Number(m[1]) / 1e6 / info.durationSec) * 20)), 'extraindo áudio');
          } });
          if (r.code !== 0) throw new Error(`ffmpeg falhou ao extrair áudio (${r.code}): ${r.stderr.trim().split('\n').filter((x) => !/^[a-z_]+=/.test(x)).pop() ?? ''}`);
        }
        let last = -1;
        const raw = await prov.transcribe(wav, { lang, signal, sourcePath: job.sourcePath, onProgress: (p) => { const v = 20 + Math.floor(p * 0.75); if (v > last) { last = v; ctx.reportProgress(Math.min(95, v), 'transcrevendo'); } } });
        const cues = validateCues(raw, info.durationSec);
        fs.writeFileSync(srtOut, toSrt(cues)); fs.writeFileSync(vttOut, toVtt(cues));
        fs.copyFileSync(job.currentPath, vPart); fs.renameSync(vPart, vOut);
        result = { outputPath: vOut, kind: 'video', extraFiles: [{ kind: 'subtitle-srt', path: srtOut }, { kind: 'subtitle-vtt', path: vttOut }],
          metadata: { provider: prov.name, lang, cues: cues.length, subtitles: 'auto', state: 'completed' } };
      }
      ctx.reportProgress(100, 'legendagem concluída'); ctx.log('info', 'legendagem concluída', { state: 'completed', ...result.metadata });
      return result;
    } catch (e) {
      ctx.log('error', `legendagem falhou: ${(e as Error).message}`, { state: 'error' });
      await removeSoon([vPart, vOut, srtOut, vttOut]); throw e;
    } finally { await removeSoon([wav]); this.active.delete(job.id); }
  }

  cancel(jobId: string): void { this.active.get(jobId)?.abort(); }

  async recover(job: JobRow): Promise<'restart' | 'fail'> {
    if (this.dataDir) {
      const dir = path.join(this.dataDir, 'projects', job.projectId, job.id, this.stationId);
      if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith(PART) || f.startsWith(TMP)) fs.rmSync(path.join(dir, f), { force: true });
    }
    return 'restart';
  }
}

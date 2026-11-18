// Estação CORTE: recorta o intervalo planejado com FFmpeg (reencode para precisão de quadro) e confere a saída com ffprobe.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StepContext, StepResult, Worker } from '../Worker.ts';
import type { JobRow } from '../../../shared/contracts/jobs.ts';
import { check, probe, resolveBins, run, type Bins, type MediaInfo } from '../../infrastructure/ffmpeg/ffmpeg.ts';
import { ConfiguredIntervalPlanner, type CutConfig, type CutInterval, type CutPlanner } from './planner.ts';

const PART = '.part';

/** run() rejeita no abort antes do processo morrer; no Windows o arquivo fica preso por instantes. Best-effort, nunca mascara o erro original. */
async function removeSoon(files: string[]): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try { for (const f of files) fs.rmSync(f, { force: true }); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
}

export class CuttingWorker implements Worker {
  readonly stationId = 'cutting' as const;
  private bins: Bins; private planner: CutPlanner; private dataDir?: string;
  private active = new Map<string, AbortController>();

  /** dataDir = o mesmo do Orchestrator; permite a recover() achar o workDir do job. */
  constructor(o: { bins?: Bins; planner?: CutPlanner; dataDir?: string } = {}) { this.bins = o.bins ?? resolveBins(); this.planner = o.planner ?? new ConfiguredIntervalPlanner(); this.dataDir = o.dataDir; }

  async initialize(): Promise<void> {
    const c = await check(this.bins); if (!c.ok) throw new Error(`FFmpeg indisponível: ${c.detail}`);
  }

  private async planFor(job: JobRow, signal?: AbortSignal): Promise<{ info: MediaInfo; iv: CutInterval }> {
    if (!fs.existsSync(job.currentPath) || !fs.statSync(job.currentPath).isFile()) throw new Error(`arquivo de entrada não existe: ${job.currentPath}`);
    const info = await probe(job.currentPath, this.bins, signal);
    const iv = this.planner.plan(info, (job.config ?? {}) as CutConfig)[0]; // shortcut: um único trecho por job, múltiplos exigem outro contrato de saída
    if (!iv) throw new Error('o planner não devolveu nenhum trecho');
    return { info, iv };
  }

  async validate(job: JobRow): Promise<void> { await this.planFor(job); }

  async execute(job: JobRow, ctx: StepContext): Promise<StepResult> {
    const own = new AbortController(); this.active.set(job.id, own);
    const signal = AbortSignal.any([ctx.signal, own.signal]);
    const id = `cut-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const part = path.join(ctx.workDir, `${id}${PART}`), out = path.join(ctx.workDir, `${id}.mp4`);
    try {
      const { info, iv } = await this.planFor(job, signal);
      const dur = iv.endSec - iv.startSec;
      const args = ['-v', 'error', '-nostdin', '-nostats', '-stats_period', '0.2', '-progress', 'pipe:2', '-n',
        '-ss', String(iv.startSec), '-i', job.currentPath, '-t', String(dur),
        '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-movflags', '+faststart', '-f', 'mp4', part];
      let last = -1;
      const r = await run(this.bins.ffmpeg, args, { signal, onStderr: (l) => {
        const m = /^out_time_(us|ms)=(\d+)$/.exec(l); if (!m) return; // out_time_ms também é em microssegundos (bug histórico do ffmpeg)
        const p = Math.min(99, Math.floor((Number(m[2]) / 1e6 / dur) * 100));
        if (p > last) { last = p; ctx.reportProgress(p, 'cortando'); }
      } });
      if (r.code !== 0) throw new Error(`ffmpeg falhou (${r.code}): ${r.stderr.trim().split('\n').filter((x) => !/^[a-z_]+=/.test(x)).pop() ?? ''}`);
      fs.renameSync(part, out);
      const o = await probe(out, this.bins, signal);
      if (Math.abs(o.durationSec - dur) > 0.5) throw new Error(`duração do corte (${o.durationSec.toFixed(2)}s) difere da pedida (${dur.toFixed(2)}s)`);
      ctx.reportProgress(100, 'corte concluído');
      return { outputPath: out, kind: 'cut', metadata: { startSec: iv.startSec, endSec: iv.endSec, durationSec: o.durationSec, width: o.width, height: o.height, fps: o.fps, planner: this.planner.name, sourceDurationSec: info.durationSec } };
    } catch (e) {
      await removeSoon([part, out]); // não deixa parcial nem saída reprovada
      throw e;
    } finally { this.active.delete(job.id); }
  }

  cancel(jobId: string): void { this.active.get(jobId)?.abort(); }

  async recover(job: JobRow): Promise<'restart' | 'fail'> {
    if (this.dataDir) { // mesmo layout de Orchestrator.stepDir
      const dir = path.join(this.dataDir, 'projects', job.projectId, job.id, this.stationId);
      if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith(PART)) fs.rmSync(path.join(dir, f), { force: true });
    }
    return 'restart';
  }
}

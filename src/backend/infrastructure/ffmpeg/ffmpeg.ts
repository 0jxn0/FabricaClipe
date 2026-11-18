// FFmpeg/FFprobe: resolução dos binários empacotados e execução SEM shell (argumentos em array, nunca string de comando).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';

// no bundle CJS do Electron import.meta.url não existe; __filename sim. No Node ESM (testes) vale o inverso.
const req = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);

export interface Bins { ffmpeg: string; ffprobe: string }

/** Ordem: variáveis FABRICA_FFMPEG/FABRICA_FFPROBE > binários empacotados (ffmpeg-static/ffprobe-static) > PATH. */
export function resolveBins(): Bins {
  const unpack = (p: string) => p.replace('app.asar', 'app.asar.unpacked'); // em app empacotado os binários ficam fora do asar
  let ffmpeg = process.env.FABRICA_FFMPEG || '', ffprobe = process.env.FABRICA_FFPROBE || '';
  try { if (!ffmpeg) ffmpeg = unpack(req('ffmpeg-static') as string); } catch { /* sem pacote */ }
  try { if (!ffprobe) ffprobe = unpack((req('ffprobe-static') as { path: string }).path); } catch { /* sem pacote */ }
  return { ffmpeg: ffmpeg && fs.existsSync(ffmpeg) ? ffmpeg : 'ffmpeg', ffprobe: ffprobe && fs.existsSync(ffprobe) ? ffprobe : 'ffprobe' };
}

export interface RunOpts { signal?: AbortSignal; onStderr?: (line: string) => void; timeoutMs?: number }
export interface RunResult { code: number; stdout: string; stderr: string }

export function run(bin: string, args: string[], o: RunOpts = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) return reject(new Error('aborted'));
    const p = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', tail = '';
    const kill = () => { try { p.kill('SIGKILL'); } catch { /* já saiu */ } };
    const onAbort = () => { kill(); reject(new Error('aborted')); };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = o.timeoutMs ? setTimeout(() => { kill(); reject(new Error(`tempo esgotado (${o.timeoutMs} ms)`)); }, o.timeoutMs) : null;
    p.stdout.on('data', (d: Buffer) => { out += d; if (out.length > 4e6) out = out.slice(-2e6); });
    p.stderr.on('data', (d: Buffer) => {
      const s = String(d); err += s; if (err.length > 1e6) err = err.slice(-5e5);
      if (o.onStderr) { tail += s; const lines = tail.split(/[\r\n]+/); tail = lines.pop() ?? ''; for (const l of lines) if (l) o.onStderr(l); }
    });
    p.on('error', (e) => { clearTimeout(timer!); reject(new Error(`não foi possível executar ${bin}: ${e.message}`)); });
    p.on('close', (code) => { clearTimeout(timer!); o.signal?.removeEventListener('abort', onAbort); resolve({ code: code ?? -1, stdout: out, stderr: err }); });
  });
}

export interface MediaInfo {
  durationSec: number; sizeBytes: number; format: string; width: number; height: number; fps: number;
  videoCodec: string; audioCodec: string | null; audioChannels: number | null; sampleRate: number | null; bitrateKbps: number | null; hasAudio: boolean;
}

export async function probe(file: string, bins = resolveBins(), signal?: AbortSignal): Promise<MediaInfo> {
  const r = await run(bins.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { signal, timeoutMs: 60000 });
  if (r.code !== 0) throw new Error(`ffprobe recusou o arquivo: ${r.stderr.trim().split('\n').pop() || 'erro desconhecido'}`);
  const j = JSON.parse(r.stdout) as { format?: Record<string, string>; streams?: Record<string, any>[] };
  const v = j.streams?.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1), a = j.streams?.find((s) => s.codec_type === 'audio');
  if (!v) throw new Error('arquivo sem faixa de vídeo');
  const [n, d] = String(v.avg_frame_rate ?? v.r_frame_rate ?? '0/1').split('/').map(Number);
  const duration = Number(j.format?.duration ?? v.duration ?? 0);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('duração inválida ou ausente');
  return {
    durationSec: duration, sizeBytes: Number(j.format?.size ?? fs.statSync(file).size), format: String(j.format?.format_name ?? ''),
    width: Number(v.width), height: Number(v.height), fps: d ? Math.round(((n ?? 0) / d) * 100) / 100 : 0, videoCodec: String(v.codec_name),
    audioCodec: a ? String(a.codec_name) : null, audioChannels: a ? Number(a.channels) : null, sampleRate: a ? Number(a.sample_rate) : null,
    bitrateKbps: j.format?.bit_rate ? Math.round(Number(j.format.bit_rate) / 1000) : null, hasAudio: !!a,
  };
}

/** Disponibilidade para o diagnóstico (versão do ffmpeg e do ffprobe). */
export async function check(bins = resolveBins()): Promise<{ ok: boolean; detail: string }> {
  try {
    const [a, b] = await Promise.all([run(bins.ffmpeg, ['-version'], { timeoutMs: 8000 }), run(bins.ffprobe, ['-version'], { timeoutMs: 8000 })]);
    if (a.code || b.code) return { ok: false, detail: 'ffmpeg/ffprobe retornaram erro' };
    return { ok: true, detail: `${a.stdout.split('\n')[0]} | ${bins.ffmpeg}` };
  } catch (e) { return { ok: false, detail: (e as Error).message }; }
}

// Motores de transcrição. Nenhum inventa texto: ou há legenda real (sidecar) ou há um binário whisper.cpp configurado.
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../../infrastructure/ffmpeg/ffmpeg.ts';
import { parseSrt, parseVtt, type Cue } from './srt.ts';

export type { Cue };
export interface JobRef { sourcePath: string; lang?: string }
export interface TranscribeOpts { lang: string; signal?: AbortSignal; onProgress?: (pct: number) => void; sourcePath?: string }

export interface TranscriptionProvider {
  readonly name: string;
  /** false = não precisa do WAV (o worker pula a extração de áudio). */
  readonly needsAudio: boolean;
  isAvailable(job?: JobRef): Promise<{ ok: boolean; detail: string }>;
  transcribe(audioWav: string, o: TranscribeOpts): Promise<Cue[]>;
}

/** Legenda já existente ao lado do vídeo de ORIGEM (mesma base: x.mp4 -> x.<lang>.srt, x.srt, x.<lang>.vtt, x.vtt). */
export class SidecarProvider implements TranscriptionProvider {
  readonly name = 'sidecar'; readonly needsAudio = false;
  private find(sourcePath: string | undefined, lang: string): string | null {
    if (!sourcePath) return null;
    const base = sourcePath.slice(0, sourcePath.length - path.extname(sourcePath).length);
    for (const c of [`${base}.${lang}.srt`, `${base}.srt`, `${base}.${lang}.vtt`, `${base}.vtt`]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    return null;
  }
  async isAvailable(job?: JobRef) {
    const f = this.find(job?.sourcePath, job?.lang ?? 'pt');
    return f ? { ok: true, detail: `legenda encontrada: ${f}` } : { ok: false, detail: 'nenhum .srt/.vtt ao lado do vídeo de origem' };
  }
  async transcribe(_audio: string, o: TranscribeOpts): Promise<Cue[]> {
    const f = this.find(o.sourcePath, o.lang); if (!f) throw new Error('legenda ao lado do vídeo não encontrada');
    const text = fs.readFileSync(f, 'utf8'); o.onProgress?.(100);
    return f.toLowerCase().endsWith('.vtt') ? parseVtt(text) : parseSrt(text);
  }
}

/** whisper.cpp (whisper-cli): FABRICA_WHISPER_BIN + FABRICA_WHISPER_MODEL. Sem shell, argumentos em array; lê o .srt gerado. Nada é baixado. */
export class WhisperCppProvider implements TranscriptionProvider {
  readonly name = 'whisper.cpp'; readonly needsAudio = true;
  private o: { bin?: string; model?: string; prefixArgs?: string[] };
  /** prefixArgs: argumentos antes dos do whisper (ex.: script de um wrapper). Uso normal: vazio. */
  constructor(o: { bin?: string; model?: string; prefixArgs?: string[] } = {}) { this.o = o; }
  private cfg() { return { bin: this.o.bin ?? process.env.FABRICA_WHISPER_BIN ?? '', model: this.o.model ?? process.env.FABRICA_WHISPER_MODEL ?? '' }; }

  async isAvailable() {
    const { bin, model } = this.cfg();
    if (!bin || !model) return { ok: false, detail: 'whisper.cpp não configurado: defina FABRICA_WHISPER_BIN e FABRICA_WHISPER_MODEL' };
    if (!fs.existsSync(bin)) return { ok: false, detail: `binário do whisper.cpp não encontrado: ${bin}` };
    if (!fs.existsSync(model)) return { ok: false, detail: `modelo do whisper.cpp não encontrado: ${model}` };
    return { ok: true, detail: `${bin} | ${model}` };
  }

  async transcribe(audioWav: string, o: TranscribeOpts): Promise<Cue[]> {
    const a = await this.isAvailable(); if (!a.ok) throw new Error(a.detail);
    const { bin, model } = this.cfg(), outBase = `${audioWav}.out`, outSrt = `${outBase}.srt`;
    const args = [...(this.o.prefixArgs ?? []), '-m', model, '-f', audioWav, '-l', o.lang, '-osrt', '-of', outBase, '-pp'];
    try {
      const r = await run(bin, args, { signal: o.signal, onStderr: (l) => { const m = /progress\s*=\s*(\d{1,3})%/.exec(l); if (m) o.onProgress?.(Math.min(100, Number(m[1]))); } });
      if (r.code !== 0) throw new Error(`whisper.cpp falhou (${r.code}): ${r.stderr.trim().split('\n').pop() ?? ''}`);
      if (!fs.existsSync(outSrt)) throw new Error('whisper.cpp não gerou o arquivo .srt');
      return parseSrt(fs.readFileSync(outSrt, 'utf8'));
    } finally { fs.rmSync(outSrt, { force: true }); }
  }
}

// Monta os argumentos do ffmpeg da estação RENDER. Função pura: sem I/O, testável sem rodar o ffmpeg.
//
// Decisões:
// - Proporção: SEMPRE preserva o aspecto da origem e completa com PAD PRETO (letterbox/pillarbox) até WxH. Nunca corta (crop) conteúdo.
// - Largura/altura são arredondadas para baixo ao par mais próximo (yuv420p exige dimensões pares).
// - Convenção da legenda (resolvida pelo worker, ver findSubtitle em RenderWorker.ts): um .srt com a mesma base do currentPath,
//   ou o .srt gerado pela estação 'subtitles' do mesmo job, ou o único .srt do diretório do currentPath.
import type { RenderConfig } from '../../../shared/contracts/jobs.ts';
import type { z } from 'zod';

export type RenderCfg = z.infer<typeof RenderConfig>;
export interface RenderArgsInput {
  render: RenderCfg;
  info: { width: number; height: number; hasAudio: boolean };
  input: string; output: string;
  /** Só passe se o ffmpeg tiver o filtro `subtitles` E o arquivo existir. */
  subtitlePath?: string;
}

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/** Escapa um valor para a sintaxe de filtros do ffmpeg em dois níveis: opção (\ : ') e grafo (\ ' , ; [ ]). Funciona com "C:\a b\x'y.srt". */
export function escapeFilterPath(p: string): string {
  const lvl = (s: string, chars: string) => [...s].map((c) => (chars.includes(c) ? `\\${c}` : c)).join('');
  return lvl(lvl(p.replace(/\\/g, '/'), ":'\\"), "\\',;[]");
}

export function buildRenderArgs(a: RenderArgsInput): string[] {
  const { render: r } = a, W = even(r.width), H = even(r.height);
  const vf = [`scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`, 'setsar=1', `fps=${r.fps}`];
  if (a.subtitlePath) vf.push(`subtitles=filename=${escapeFilterPath(a.subtitlePath)}`);
  const b = r.bitrateKbps;
  const args = ['-v', 'error', '-nostdin', '-nostats', '-stats_period', '0.2', '-progress', 'pipe:2', '-n', '-i', a.input,
    '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf.join(','),
    '-c:v', r.codec === 'h265' ? 'libx265' : 'libx264', '-preset', 'veryfast', '-b:v', `${b}k`, '-maxrate', `${b}k`, '-bufsize', `${b * 2}k`, '-pix_fmt', 'yuv420p'];
  if (r.codec === 'h265') args.push('-tag:v', 'hvc1', '-x265-params', 'log-level=error');
  if (a.info.hasAudio) args.push('-c:a', 'aac', '-b:a', `${r.audioBitrateKbps}k`);
  if (r.format === 'mp4') args.push('-movflags', '+faststart');
  args.push('-f', r.format === 'mov' ? 'mov' : 'mp4', a.output);
  return args;
}

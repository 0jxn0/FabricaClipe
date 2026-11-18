// "Analisar": inspeção técnica real (ffprobe) com um relatório de problemas. Não modifica nada, não cria job.
import { probe, resolveBins, type Bins, type MediaInfo } from '../infrastructure/ffmpeg/ffmpeg.ts';
import { validateImportFile } from '../infrastructure/filesystem/safePaths.ts';

export interface Problem { severity: 'error' | 'warning' | 'info'; code: string; message: string }
export interface AnalysisReport { ok: boolean; file: string; info: MediaInfo | null; problems: Problem[]; summary: string }

export async function analyzeFile(file: string, bins: Bins = resolveBins(), signal?: AbortSignal): Promise<AnalysisReport> {
  const problems: Problem[] = [];
  try { validateImportFile(file); } catch (e) { return { ok: false, file, info: null, problems: [{ severity: 'error', code: 'invalid-file', message: (e as Error).message }], summary: 'Arquivo inválido' }; }
  let info: MediaInfo;
  try { info = await probe(file, bins, signal); }
  catch (e) { return { ok: false, file, info: null, problems: [{ severity: 'error', code: 'unreadable', message: (e as Error).message }], summary: 'Arquivo ilegível ou corrompido' }; }

  const add = (severity: Problem['severity'], code: string, message: string) => problems.push({ severity, code, message });
  if (!info.hasAudio) add('warning', 'no-audio', 'O vídeo não tem faixa de áudio: legendas automáticas e normalização não terão efeito.');
  if (Math.min(info.width, info.height) < 720) add('warning', 'low-resolution', `Resolução baixa (${info.width}x${info.height}); o render em 1080x1920 vai ampliar a imagem.`);
  if (info.fps > 0 && info.fps < 15) add('warning', 'low-fps', `Taxa de quadros muito baixa (${info.fps} fps).`);
  if (info.fps > 60) add('info', 'high-fps', `${info.fps} fps: o render reduz para o fps configurado.`);
  if (info.durationSec < 1) add('warning', 'very-short', 'Duração menor que 1 segundo.');
  if (info.durationSec > 7200) add('warning', 'very-long', 'Mais de 2 horas: o corte e o render podem demorar bastante.');
  if (info.width > info.height) add('info', 'landscape', 'Vídeo horizontal: o render vertical usa barras pretas (letterbox).');
  if (info.hasAudio && info.sampleRate != null && info.sampleRate < 16000) add('warning', 'low-sample-rate', `Taxa de amostragem do áudio baixa (${info.sampleRate} Hz): a transcrição pode piorar.`);
  const errors = problems.filter((p) => p.severity === 'error').length, warns = problems.filter((p) => p.severity === 'warning').length;
  return { ok: errors === 0, file, info, problems, summary: warns ? `Legível, com ${warns} aviso${warns > 1 ? 's' : ''}` : 'Legível, sem problemas encontrados' };
}

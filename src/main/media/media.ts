// Preview seguro do vídeo a aprovar. O renderer só conhece o jobId; o caminho do disco vem SEMPRE do banco e nunca da URL.
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../../backend/infrastructure/database/db.ts';
import { isInside, VIDEO_EXT } from '../../backend/infrastructure/filesystem/safePaths.ts';

export const MEDIA_SCHEME = 'media';
export const MEDIA_HOST = 'job';
const MIME: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.ts': 'video/mp2t' };
const JOB_ID = /^[\w-]{1,128}$/;

export const mediaUrl = (jobId: string) => `${MEDIA_SCHEME}://${MEDIA_HOST}/${encodeURIComponent(jobId)}?v=${Date.now()}`;

/** Extrai o jobId de media://job/<id>. Qualquer outra forma (host, subcaminho, id estranho) é recusada. */
export function jobIdFromUrl(raw: string): string {
  const u = new URL(raw);
  if (u.protocol !== `${MEDIA_SCHEME}:` || u.host !== MEDIA_HOST) throw new Error('origem de mídia inválida');
  let id: string; try { id = decodeURIComponent(u.pathname.slice(1)); } catch { throw new Error('url inválida'); }
  if (!JOB_ID.test(id)) throw new Error('jobId inválido');
  return id;
}

/** Caminho real do vídeo do job, ou erro. Exige: job aguardando aprovação, arquivo registrado em media_files/jobs.current_path,
 *  dentro de <dataDir>/projects (após resolver links), regular (nunca symlink) e de extensão de vídeo. */
export function resolveJobMedia(db: Db, dataDir: string, jobId: string): { file: string; size: number; mime: string } {
  if (!JOB_ID.test(jobId)) throw new Error('jobId inválido');
  const job = db.get<{ current_path: string; state: string }>('SELECT current_path, state FROM jobs WHERE id = ?', jobId);
  if (!job) throw new Error('job inexistente');
  if (job.state !== 'awaiting_approval') throw new Error('o job não está aguardando aprovação');
  const reg = db.get('SELECT 1 AS x FROM media_files WHERE job_id = ? AND path = ?', jobId, job.current_path);
  if (!reg) throw new Error('arquivo não registrado para este job');
  return resolveRegistered(path.join(dataDir, 'projects'), job.current_path);
}

/** Parte pura (sem banco): confere o caminho registrado contra a raiz permitida. */
export function resolveRegistered(projectsDir: string, registered: string): { file: string; size: number; mime: string } {
  if (!path.isAbsolute(registered) || registered.includes('\0')) throw new Error('caminho inválido');
  const ext = path.extname(registered).toLowerCase();
  if (!VIDEO_EXT.has(ext)) throw new Error('formato não permitido');
  if (!isInside(projectsDir, registered)) throw new Error('arquivo fora da pasta de projetos');
  const st = fs.lstatSync(registered);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error('o caminho não é um arquivo regular');
  const real = fs.realpathSync(registered);          // junctions/links em pastas intermediárias
  if (!isInside(fs.realpathSync(projectsDir), real)) throw new Error('arquivo fora da pasta de projetos');
  return { file: real, size: st.size, mime: MIME[ext] ?? 'application/octet-stream' };
}

/** Cabeçalho Range (um único intervalo de bytes). null = sem Range; 'invalid' = 416. */
export function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number, end: number;
  if (m[1] === '') { const n = Number(m[2]); if (n === 0) return 'invalid'; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (!Number.isSafeInteger(start) || start >= size || start > end) return 'invalid';
  return { start, end };
}

// Validação de caminhos vindos da interface: nada fora das raízes permitidas, só extensões de mídia conhecidas.
import path from 'node:path';
import fs from 'node:fs';

export const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.ts']);

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolve e confere que o caminho está dentro de `root`. Lança erro caso contrário. */
export function ensureInside(root: string, target: string): string {
  const abs = path.resolve(root, target);
  if (!isInside(root, abs)) throw new Error(`Caminho fora do diretório permitido: ${target}`);
  return abs;
}

/** Arquivo de vídeo importável: caminho absoluto, extensão conhecida, existe, é arquivo regular (sem link simbólico). */
export function validateImportFile(p: string): string {
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) throw new Error('Caminho de arquivo inválido');
  if (!VIDEO_EXT.has(path.extname(p).toLowerCase())) throw new Error(`Formato não suportado: ${path.extname(p) || '(sem extensão)'}`);
  const st = fs.lstatSync(p);
  if (!st.isFile()) throw new Error('O caminho não é um arquivo regular');
  return p;
}

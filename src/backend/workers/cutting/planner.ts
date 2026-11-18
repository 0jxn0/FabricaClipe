// Ponto de integração para escolha de trechos. Hoje só existe o planner que obedece ao intervalo pedido pelo usuário.
import type { MediaInfo } from '../../infrastructure/ffmpeg/ffmpeg.ts';

export interface CutInterval { startSec: number; endSec: number }
export interface CutConfig { cut?: { startSec?: number; durationSec?: number } }

export interface CutPlanner {
  readonly name: string;
  /** Devolve os trechos a cortar; lança se o pedido for inválido para a mídia. */
  plan(info: MediaInfo, cfg: CutConfig): CutInterval[];
}

export const MIN_CUT_SEC = 0.5;

/** Usa SOMENTE config.cut (startSec/durationSec). Sem config = vídeo inteiro. Não analisa conteúdo. */
export class ConfiguredIntervalPlanner implements CutPlanner {
  readonly name = 'configured-interval';
  plan(info: MediaInfo, cfg: CutConfig): CutInterval[] {
    const dur = info.durationSec, start = cfg.cut?.startSec ?? 0, want = cfg.cut?.durationSec;
    if (!Number.isFinite(start) || start < 0) throw new Error(`início inválido: ${start}`);
    if (want !== undefined && (!Number.isFinite(want) || want <= 0)) throw new Error(`duração inválida: ${want}`);
    if (start >= dur) throw new Error(`início (${start}s) além da duração do vídeo (${dur.toFixed(2)}s)`);
    const end = Math.min(want === undefined ? dur : start + want, dur);
    if (end - start < MIN_CUT_SEC) throw new Error(`intervalo menor que o mínimo de ${MIN_CUT_SEC}s (${(end - start).toFixed(2)}s)`);
    return [{ startSec: start, endSec: end }];
  }
}

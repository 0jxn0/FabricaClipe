// Contrato comum das seis estações. O orquestrador chama; o worker só executa e devolve um resultado verificável.
import type { EventDraft } from '../../shared/contracts/events.ts';
import type { JobRow } from '../../shared/contracts/jobs.ts';
import type { StationId } from '../../shared/contracts/stations.ts';

export interface StepContext {
  job: JobRow; attempt: number; signal: AbortSignal;
  /** Diretório da etapa para este job (já criado). Escreva os resultados aqui. */
  workDir: string;
  /** Progresso REAL (0–100) medido pelo worker. Não chame se não tiver como medir. */
  reportProgress(progress: number, message?: string): void;
  log(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void;
  /** Eventos próprios da estação (ex.: clip.publish.*), já com job/estação preenchidos. */
  emit(draft: Pick<EventDraft, 'event' | 'payload'>): void;
}

export interface StepResult {
  outputPath: string;                         // arquivo principal produzido (obrigatório, existente e não vazio)
  kind?: string;                              // video | cut | subtitle | render | thumbnail ...
  metadata?: Record<string, unknown>;
  extraFiles?: { kind: string; path: string }[];
}

export interface Worker {
  readonly stationId: StationId;
  initialize(): Promise<void>;                // lança se a estação não puder operar (vira "unavailable")
  validate(job: JobRow): Promise<void>;       // lança se o job/arquivo não serve para esta etapa
  execute(job: JobRow, ctx: StepContext): Promise<StepResult>;
  cancel(jobId: string): void;
  /** Após queda inesperada: 'restart' refaz a etapa; 'fail' exige decisão humana (ex.: publicação sem confirmação remota). */
  recover(job: JobRow): Promise<'restart' | 'fail'>;
}

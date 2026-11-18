// Contrato tipado entre Renderer (preload) e Main. Todo payload que entra no Main passa por estes schemas.
import { z } from 'zod';
import { ApprovalDecision, CreateJobInput, JobAction, type JobRow } from './jobs.ts';

export const CH = {
  jobsCreate: 'fabrica:jobs:create', jobsList: 'fabrica:jobs:list', jobsAction: 'fabrica:jobs:action', jobsHistory: 'fabrica:jobs:history',
  approvalDecide: 'fabrica:approval:decide', filesPick: 'fabrica:files:pick', filesAnalyze: 'fabrica:files:analyze', eventsSnapshot: 'fabrica:events:snapshot',
  eventsSince: 'fabrica:events:since', mediaUrl: 'fabrica:media:url', eventPush: 'fabrica:event', diagnostics: 'fabrica:system:diagnostics', quit: 'fabrica:lifecycle:quit',
} as const;

export const IpcSchemas = {
  create: CreateJobInput, action: JobAction, decide: ApprovalDecision,
  history: z.object({ jobId: z.string().min(1).max(128) }),
  since: z.object({ seq: z.number().int().min(0) }),
  analyze: z.object({ path: z.string().min(1).max(1024) }),
  mediaUrl: z.object({ jobId: z.string().regex(/^[\w-]{1,128}$/) }),
};

export interface FabricaApi {
  readonly version: 1;
  jobs: {
    create(input: z.input<typeof CreateJobInput>): Promise<JobRow>;
    list(): Promise<JobRow[]>;
    action(input: z.input<typeof JobAction>): Promise<JobRow>;
    history(jobId: string): Promise<unknown[]>;
    decide(input: z.input<typeof ApprovalDecision>): Promise<JobRow>;
  };
  files: { pickVideos(): Promise<string[]>; analyze(path: string): Promise<import('../../backend/services/analysis.ts').AnalysisReport> };
  media: { url(jobId: string): Promise<string> }; // media://job/<id>, só para jobs aguardando aprovação
  events: {
    snapshot(): Promise<{ lastSeq: number; events: Record<string, unknown>[] }>;
    since(seq: number): Promise<Record<string, unknown>[]>;
    onEvent(cb: (e: Record<string, unknown>) => void): () => void;
  };
  system: { diagnostics(): Promise<Record<string, unknown>>; quitFactory(): Promise<void> };
}

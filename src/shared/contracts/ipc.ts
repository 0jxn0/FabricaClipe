// Contrato tipado entre Renderer (preload) e Main. Todo payload que entra no Main passa por estes schemas.
import { z } from 'zod';
import { ApprovalDecision, CreateJobInput, JobAction, Platform, type JobRow } from './jobs.ts';
import type { PlatformStatus } from '../../backend/integrations/IntegrationsService.ts';
import type { Guide, PlatformId, TestResult } from '../../backend/integrations/platforms.ts';

export const CH = {
  jobsCreate: 'fabrica:jobs:create', jobsList: 'fabrica:jobs:list', jobsAction: 'fabrica:jobs:action', jobsHistory: 'fabrica:jobs:history',
  approvalDecide: 'fabrica:approval:decide', filesPick: 'fabrica:files:pick', filesAnalyze: 'fabrica:files:analyze', eventsSnapshot: 'fabrica:events:snapshot',
  eventsSince: 'fabrica:events:since', mediaUrl: 'fabrica:media:url', eventPush: 'fabrica:event', diagnostics: 'fabrica:system:diagnostics', quit: 'fabrica:lifecycle:quit',
  integList: 'integrations:list', integGuide: 'integrations:guide', integSave: 'integrations:saveCredentials', integConnect: 'integrations:connect',
  integDisconnect: 'integrations:disconnect', integTest: 'integrations:test', integConsole: 'integrations:openConsole',
} as const;

export const IpcSchemas = {
  create: CreateJobInput, action: JobAction, decide: ApprovalDecision,
  history: z.object({ jobId: z.string().min(1).max(128) }),
  since: z.object({ seq: z.number().int().min(0) }),
  analyze: z.object({ path: z.string().min(1).max(1024) }),
  mediaUrl: z.object({ jobId: z.string().regex(/^[\w-]{1,128}$/) }),
  integPlatform: z.object({ platform: Platform }),
  integSave: z.object({ platform: Platform, clientId: z.string().trim().min(1).max(512).regex(/^\S+$/, 'sem espaços'), clientSecret: z.string().trim().max(512).regex(/^\S*$/, 'sem espaços').optional() }),
  integConsole: z.object({ platform: Platform, consoleId: z.string().regex(/^[a-z]{1,20}$/) }),
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
  /** Contas das plataformas. O renderer só recebe status/rótulo/mensagem, nunca segredo ou token. */
  integrations: {
    list(): Promise<PlatformStatus[]>; guide(platform: PlatformId): Promise<Guide>;
    saveCredentials(i: { platform: PlatformId; clientId: string; clientSecret?: string }): Promise<PlatformStatus>;
    connect(platform: PlatformId): Promise<PlatformStatus>; disconnect(platform: PlatformId): Promise<PlatformStatus>;
    test(platform: PlatformId): Promise<TestResult>; openConsole(platform: PlatformId, consoleId: string): Promise<void>;
  };
  system: { diagnostics(): Promise<Record<string, unknown>>; quitFactory(): Promise<void> };
}

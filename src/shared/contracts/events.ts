// Envelope padronizado e catálogo de eventos (versão 1 do contrato).
import { z } from 'zod';

export const CONTRACT_VERSION = 1;

export const EVENT_NAMES = [
  'clip.job.created', 'clip.job.queued', 'clip.job.started', 'clip.job.progress', 'clip.job.paused', 'clip.job.resumed',
  'clip.job.completed', 'clip.job.failed', 'clip.job.cancelled',
  'clip.station.started', 'clip.station.progress', 'clip.station.completed', 'clip.station.failed', 'clip.station.idle', 'clip.station.unavailable',
  'clip.transfer.started', 'clip.transfer.progress', 'clip.transfer.completed', 'clip.transfer.failed', 'clip.file.received',
  'clip.approval.pending', 'clip.approval.approved', 'clip.approval.rejected', 'clip.approval.revision_requested',
  'clip.publish.started', 'clip.publish.progress', 'clip.publish.completed', 'clip.publish.failed',
  'system.ready', 'system.initializing', 'system.error', 'system.warning', 'system.shutdown', 'system.recovered',
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export const EnvelopeSchema = z.object({
  event: z.enum(EVENT_NAMES),
  eventId: z.string().uuid(),
  version: z.literal(CONTRACT_VERSION),
  seq: z.number().int().nonnegative(),          // ordem total de emissão (gerada pelo barramento)
  timestamp: z.string().datetime(),
  jobId: z.string().min(1).max(128).optional(),
  stationId: z.string().min(1).max(32).optional(),
  employeeId: z.string().min(1).max(32).optional(),
  payload: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof EnvelopeSchema>;

/** O que um serviço informa ao publicar; o barramento completa eventId, seq e timestamp. */
export type EventDraft = Pick<EventEnvelope, 'event' | 'payload'> & Partial<Pick<EventEnvelope, 'jobId' | 'stationId' | 'employeeId'>>;

// Compatibilidade: traduz o envelope novo para o contrato "plano" (clip.job.* + deskId) que o frontend já entende.
// O frontend continua só recebendo eventos e desenhando o estado confirmado pelo backend.
import type { EventEnvelope } from '../../../shared/contracts/events.ts';
import { STATION_INFO, type StationId } from '../../../shared/contracts/stations.ts';

export type LegacyEvent = Record<string, unknown> & { type: string; deskId: string; jobId: string };

const desk = (s?: string) => (s && STATION_INFO[s as StationId]?.deskId) || null;

export function toLegacy(e: EventEnvelope, replay = false): LegacyEvent | null {
  const p = e.payload as Record<string, any>, deskId = desk(e.stationId), jobId = e.jobId;
  if (!jobId) return null;
  const base = { jobId, timestamp: e.timestamp, seq: e.seq, ...(replay ? { replay: true } : {}) };
  switch (e.event) {
    case 'clip.job.queued': return deskId ? { type: 'clip.job.queued', deskId, ...base, title: p.name, platforms: p.platforms } : null;
    case 'clip.station.started': return deskId ? { type: 'clip.job.started', deskId, ...base, title: p.name } : null;
    case 'clip.station.progress': return deskId ? { type: 'clip.job.progress', deskId, ...base, progress: p.progress } : null;
    case 'clip.station.completed': return deskId ? { type: 'clip.job.completed', deskId, ...base } : null;
    case 'clip.station.failed': return deskId ? { type: 'clip.job.failed', deskId, ...base, error: p.error } : null;
    case 'clip.job.cancelled': return deskId ? { type: 'clip.job.cancelled', deskId, ...base } : null;
    case 'clip.transfer.started': return { type: 'clip.job.transferred', deskId: p.fromDesk, toDeskId: p.toDesk, ...base };
    case 'clip.file.received': return deskId ? { type: 'clip.job.received', deskId, ...base } : null;
    case 'clip.publish.started': return deskId ? { type: 'clip.job.publishing', deskId, ...base, platform: p.platform } : null;
    case 'clip.publish.completed': return deskId ? { type: 'clip.job.published', deskId, ...base, platform: p.platform } : null;
    case 'clip.publish.failed': return deskId ? { type: 'clip.job.publish_failed', deskId, ...base, platform: p.platform, error: p.error } : null;
    default: return null;
  }
}

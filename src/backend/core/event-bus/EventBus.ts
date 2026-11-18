// Barramento central: valida o envelope, grava no event_logs (ordem = seq), deduplica por eventId e entrega aos assinantes.
import { randomUUID } from 'node:crypto';
import type { Db } from '../../infrastructure/database/db.ts';
import { CONTRACT_VERSION, EnvelopeSchema, type EventDraft, type EventEnvelope } from '../../../shared/contracts/events.ts';

type Listener = (e: EventEnvelope) => void;

export class EventBus {
  private listeners = new Set<Listener>();
  private db: Db; private onError: (m: string, e: unknown) => void;
  constructor(db: Db, onError: (m: string, e: unknown) => void = () => {}) { this.db = db; this.onError = onError; }

  subscribe(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** Publica e persiste. Retorna o envelope completo. Entrega só depois de gravado (nunca anuncia o que não persistiu). */
  publish(draft: EventDraft & { eventId?: string; timestamp?: string }): EventEnvelope | null {
    const eventId = draft.eventId ?? randomUUID(), timestamp = draft.timestamp ?? new Date().toISOString();
    if (this.db.get('SELECT 1 AS x FROM event_logs WHERE event_id = ?', eventId)) return null; // duplicado
    const res = this.db.run('INSERT INTO event_logs (event_id, event, timestamp, job_id, station_id, employee_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      eventId, draft.event, timestamp, draft.jobId ?? null, draft.stationId ?? null, draft.employeeId ?? null, JSON.stringify(draft.payload ?? {}));
    const parsed = EnvelopeSchema.safeParse({ ...draft, eventId, timestamp, version: CONTRACT_VERSION, seq: Number(res.lastInsertRowid) });
    if (!parsed.success) { this.db.run('DELETE FROM event_logs WHERE event_id = ?', eventId); throw new Error(`Evento inválido (${draft.event}): ${parsed.error.issues[0]?.message}`); }
    for (const fn of [...this.listeners]) { try { fn(parsed.data); } catch (e) { this.onError('listener de evento falhou', e); } }
    return parsed.data;
  }

  /** Recuperação: tudo que aconteceu depois de `seq` (cliente guarda o último seq visto). */
  since(seq = 0, limit = 500): EventEnvelope[] {
    return this.db.all<{ seq: number; event_id: string; event: string; timestamp: string; job_id: string | null; station_id: string | null; employee_id: string | null; payload_json: string }>(
      'SELECT * FROM event_logs WHERE seq > ? ORDER BY seq LIMIT ?', seq, limit).map((r) => ({
      event: r.event as EventEnvelope['event'], eventId: r.event_id, version: CONTRACT_VERSION, seq: r.seq, timestamp: r.timestamp,
      ...(r.job_id ? { jobId: r.job_id } : {}), ...(r.station_id ? { stationId: r.station_id } : {}), ...(r.employee_id ? { employeeId: r.employee_id } : {}),
      payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    }));
  }

  lastSeq(): number { return Number(this.db.get<{ s: number | null }>('SELECT MAX(seq) AS s FROM event_logs')?.s ?? 0); }
}

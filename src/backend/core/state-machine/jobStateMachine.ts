// Transições válidas do job. Qualquer outra é erro de programação ou evento fora de ordem.
import type { JobState } from '../../../shared/contracts/stations.ts';

const T: Record<JobState, JobState[]> = {
  queued:            ['validating', 'awaiting_approval', 'paused', 'cancelled', 'failed'],
  validating:        ['processing', 'publishing', 'failed', 'paused', 'cancelled'],
  processing:        ['transferring', 'completed', 'failed', 'paused', 'cancelled'],
  publishing:        ['completed', 'transferring', 'failed', 'paused', 'cancelled'],
  transferring:      ['queued', 'failed', 'cancelled', 'paused'],
  awaiting_approval: ['approved', 'rejected', 'paused', 'cancelled', 'failed'],
  approved:          ['transferring', 'completed', 'cancelled', 'failed'],
  rejected:          ['transferring', 'failed', 'cancelled'],
  paused:            ['queued', 'cancelled'],
  failed:            ['queued', 'cancelled'],   // retry
  completed:         [],
  cancelled:         [],
};

export const canTransition = (from: JobState, to: JobState): boolean => T[from]?.includes(to) ?? false;
export const isTerminal = (s: JobState): boolean => s === 'completed' || s === 'cancelled';
export const isActive = (s: JobState): boolean => s === 'validating' || s === 'processing' || s === 'publishing' || s === 'transferring';

export class InvalidTransition extends Error {
  from: JobState; to: JobState; jobId: string;
  constructor(from: JobState, to: JobState, jobId: string) { super(`Transição inválida (${jobId}): ${from} -> ${to}`); this.from = from; this.to = to; this.jobId = jobId; }
}
export function assertTransition(from: JobState, to: JobState, jobId: string) { if (!canTransition(from, to)) throw new InvalidTransition(from, to, jobId); }

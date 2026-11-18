// Lógica pura dos controles do app desktop (sem DOM): testada em tests/ui-media.test.ts.
export const PLATFORM_LABELS = { youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook' };
const STATION_BY_DESK = ['capture', 'cutting', 'subtitles', 'rendering', 'approval', 'publishing'];
export const stationOfDesk = (deskId) => STATION_BY_DESK[Number(String(deskId).replace('desk-', '')) - 1] ?? null;

export const ACTIONS = {
  pause: { label: 'Pausar', aria: 'Pausar o job' }, resume: { label: 'Retomar', aria: 'Retomar o job' },
  cancel: { label: 'Cancelar', aria: 'Cancelar o job', danger: true }, retry: { label: 'Tentar novamente', aria: 'Tentar novamente o job com falha' },
};
const RUNNING = ['queued', 'validating', 'processing', 'transferring', 'publishing'];
const TERMINAL = ['completed', 'cancelled'];

/** Ações oferecidas por estado real do job (espelha a máquina de estados do orquestrador). */
export function actionsFor(state) {
  if (RUNNING.includes(state)) return ['pause', 'cancel'];
  if (state === 'paused') return ['resume', 'cancel'];
  if (state === 'failed') return ['retry', 'cancel'];
  if (state === 'awaiting_approval') return ['cancel'];
  return [];
}

/** Job a mostrar na estação em foco: o mais recente não terminado naquela estação. */
export function jobForDesk(jobs, deskId) {
  const st = stationOfDesk(deskId); if (!st) return null;
  return jobs.find((j) => j.stationId === st && !TERMINAL.includes(j.state)) ?? null;
}
export const awaitingApproval = (jobs) => jobs.filter((j) => j.state === 'awaiting_approval');

export const nameFromPath = (p) => {
  const base = String(p).split(/[\\/]/).pop() ?? '';
  return (base.replace(/\.[^.]+$/, '').trim() || base.trim()).slice(0, 120);
};

const num = (s) => { const t = String(s ?? '').trim().replace(',', '.'); return t === '' ? undefined : Number(t); };

/** Monta o input de jobs.create. Devolve { error } se algum campo for inválido (mensagem pronta para exibir). */
export function buildCreateInput(path, f) {
  const start = num(f.start), dur = num(f.duration);
  if (start !== undefined && (!Number.isFinite(start) || start < 0)) return { error: 'O início do corte deve ser um número maior ou igual a 0.' };
  if (dur !== undefined && (!Number.isFinite(dur) || dur < 0.5 || dur > 3600)) return { error: 'A duração do corte deve ficar entre 0,5 e 3600 segundos.' };
  const cut = {}; if (start !== undefined) cut.startSec = start; if (dur !== undefined) cut.durationSec = dur;
  return { input: { name: nameFromPath(path), sourcePath: path, platforms: f.platforms ?? [], config: { cut, subtitles: f.subtitles ? 'auto' : 'off' } } };
}

/** Erros do invoke vêm como "Error invoking remote method 'x': Error: mensagem". */
export const cleanIpcError = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');

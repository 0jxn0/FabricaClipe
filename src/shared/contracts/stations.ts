// Estações do pipeline e a ligação com o frontend (desk-N). Única fonte da verdade para os dois lados.
export const STATIONS = ['capture', 'cutting', 'subtitles', 'rendering', 'approval', 'publishing'] as const;
export type StationId = (typeof STATIONS)[number];

export const STATION_INFO: Record<StationId, { name: string; deskId: string; employeeId: string; agent: string }> = {
  capture:    { name: 'Captação',   deskId: 'desk-1', employeeId: 'employee-01', agent: 'Rafa' },
  cutting:    { name: 'Corte',      deskId: 'desk-2', employeeId: 'employee-02', agent: 'Bia' },
  subtitles:  { name: 'Legenda',    deskId: 'desk-3', employeeId: 'employee-03', agent: 'Léo' },
  rendering:  { name: 'Render',     deskId: 'desk-4', employeeId: 'employee-04', agent: 'Duda' },
  approval:   { name: 'Aprovação',  deskId: 'desk-5', employeeId: 'employee-05', agent: 'Marcos' },
  publishing: { name: 'Publicação', deskId: 'desk-6', employeeId: 'employee-06', agent: 'Nina' },
};

export const deskOf = (s: StationId): string => STATION_INFO[s].deskId;
export const stationOfDesk = (d: string): StationId | undefined => STATIONS.find((s) => STATION_INFO[s].deskId === d);
export const nextStation = (s: StationId): StationId | null => STATIONS[STATIONS.indexOf(s) + 1] ?? null;

export const JOB_STATES = ['queued', 'validating', 'processing', 'transferring', 'awaiting_approval', 'approved', 'rejected',
  'publishing', 'completed', 'failed', 'paused', 'cancelled'] as const;
export type JobState = (typeof JOB_STATES)[number];

export const EMPLOYEE_STATES = ['idle', 'working', 'receiving', 'transferring', 'completed', 'error', 'unavailable'] as const;
export type EmployeeState = (typeof EMPLOYEE_STATES)[number];

// Estações = etapas da esteira do repo VIDEO-MAKER (esteira.py). Trocar aqui não afeta eventos nem render.
export const DESKS = [
  { id: 'desk-1', name: 'Captação',   short: 'CAPTACAO',   agent: 'Rafa',   role: 'scrap / add',        look: 'rafa' },
  { id: 'desk-2', name: 'Corte',      short: 'CORTE',      agent: 'Bia',    role: 'detect / cut',       look: 'bia' },
  { id: 'desk-3', name: 'Legenda',    short: 'LEGENDA',    agent: 'Léo',    role: 'whisper / viralizei', look: 'leo' },
  { id: 'desk-4', name: 'Render',     short: 'RENDER',     agent: 'Duda',   role: 'render ffmpeg',      look: 'duda' },
  { id: 'desk-5', name: 'Aprovação',  short: 'APROVACAO',  agent: 'Marcos', role: 'approve',            look: 'marcos' },
  { id: 'desk-6', name: 'Publicação', short: 'PUBLICACAO', agent: 'Nina',   role: 'post',               look: 'nina' },
];

export const EVENT_TYPES = [
  'clip.job.queued', 'clip.job.started', 'clip.job.progress',
  'clip.job.completed', 'clip.job.failed', 'clip.job.cancelled', 'clip.job.paused',
  // fluxo entre estações e publicação (ver README: "Contrato de eventos")
  'clip.job.transferred', 'clip.job.received',
  'clip.job.publishing', 'clip.job.published', 'clip.job.publish_failed',
];

export const PLATFORM_IDS = ['instagram', 'tiktok', 'youtube', 'facebook'];
// Um cano por rede social, de cima para baixo (ids de view/platformIcons.js). Plataforma fora da lista só aparece nos ícones da estação 06.
export const PIPES = ['instagram', 'tiktok', 'youtube', 'facebook', 'kwai', 'x'];

export const TIMING = {
  completedSettleMs: 6000, // monitor mostra "concluído" e volta a idle
  cancelledSettleMs: 3000,
  transferSec: 1.3,        // duração do arremesso do arquivo (mesa e barra)
  transferDelaySec: 0.35,  // pausa na bandeja antes de partir
  celebrateMs: 2200,       // duração da animação do funcionário
};

// URL do backend: ?ws=ws://host:porta/ws  >  window.FABRICA_CONFIG.wsUrl  >  mesmo host da página
export function resolveWsUrl() {
  const q = new URLSearchParams(location.search).get('ws');
  if (q) return q;
  if (window.FABRICA_CONFIG?.wsUrl) return window.FABRICA_CONFIG.wsUrl;
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  }
  return 'ws://localhost:8787/ws';
}

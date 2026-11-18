// Decisão de pausa do componente embutido (função pura, testável sem DOM).
// `reduced` = prefers-reduced-motion do SO; `override` = escolha explícita do host (pause()/resume()) ou null.
// O host vence o SO enquanto não houver mudança da media query; ao mudar, o override é descartado.
export const MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export const initialMotion = (reduced) => ({ reduced: !!reduced, override: null });
export const isPaused = (s) => s.override ?? s.reduced;
export function motionReduce(s, action, value) {
  if (action === 'pause') return { ...s, override: true };
  if (action === 'resume') return { ...s, override: false };
  if (action === 'media') return { reduced: !!value, override: null };
  return s;
}

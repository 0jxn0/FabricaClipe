// SRT e WebVTT: parse, serialização e validação de cues. Sem dependências.
export interface Cue { startSec: number; endSec: number; text: string }

const TS = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/;

export function parseTimestamp(s: string): number {
  const m = TS.exec(s.trim()); if (!m) throw new Error(`timestamp inválido: "${s}"`);
  const [, h, mi, se, ms] = m;
  if (Number(mi) > 59 || Number(se) > 59) throw new Error(`timestamp inválido: "${s}"`);
  return Number(h ?? 0) * 3600 + Number(mi) * 60 + Number(se) + Number(ms!.padEnd(3, '0')) / 1000;
}

export function formatTimestamp(sec: number, sep: ',' | '.'): string {
  const t = Math.round(Math.max(0, sec) * 1000), p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(t / 3600000))}:${p(Math.floor(t / 60000) % 60)}:${p(Math.floor(t / 1000) % 60)}${sep}${p(t % 1000, 3)}`;
}

function parseBlocks(text: string, kind: 'srt' | 'vtt'): Cue[] {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (kind === 'vtt' && !/^WEBVTT/.test(src)) throw new Error('WebVTT inválido: falta o cabeçalho WEBVTT');
  const cues: Cue[] = [];
  for (const block of src.split(/\n{2,}/)) {
    const lines = block.split('\n'), i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) { if (kind === 'srt' && block.trim()) throw new Error(`bloco SRT sem tempo: "${block.slice(0, 40)}"`); continue; } // vtt: cabeçalho/NOTE/STYLE
    const [a, b] = lines[i]!.split('-->').map((x) => x.trim().split(/\s+/)[0]!); // ignora configurações de posição do vtt
    const text = lines.slice(i + 1).join('\n').trim();
    if (!text) continue;
    cues.push({ startSec: parseTimestamp(a!), endSec: parseTimestamp(b!), text });
  }
  return cues;
}
export const parseSrt = (t: string): Cue[] => parseBlocks(t, 'srt');
export const parseVtt = (t: string): Cue[] => parseBlocks(t, 'vtt');

export const toSrt = (cues: Cue[]): string => cues.map((c, i) => `${i + 1}\n${formatTimestamp(c.startSec, ',')} --> ${formatTimestamp(c.endSec, ',')}\n${c.text}\n`).join('\n');
export const toVtt = (cues: Cue[]): string => `WEBVTT\n\n${cues.map((c) => `${formatTimestamp(c.startSec, '.')} --> ${formatTimestamp(c.endSec, '.')}\n${c.text}\n`).join('\n')}`;

/** Ordena, descarta vazias e remove sobreposição (o fim é recortado no início da próxima). Lança se sobrar cue com duração <= 0 ou tempo negativo. */
export function normalizeCues(cues: Cue[]): Cue[] {
  const s = cues.map((c) => ({ ...c, text: c.text.trim() })).filter((c) => c.text).sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!, n = s[i + 1];
    if (!Number.isFinite(c.startSec) || !Number.isFinite(c.endSec) || c.startSec < 0) throw new Error(`cue ${i + 1} com tempo inválido`);
    if (n && c.endSec > n.startSec) c.endSec = n.startSec;
    if (c.endSec <= c.startSec) throw new Error(`cue ${i + 1} com duração não positiva (${formatTimestamp(c.startSec, ',')})`);
  }
  return s;
}

/** Normaliza e confere contra a duração do vídeo (fim até 1 s além é recortado; mais que isso é erro). */
export function validateCues(cues: Cue[], durationSec: number): Cue[] {
  const n = normalizeCues(cues);
  if (!n.length) throw new Error('nenhuma legenda (cues vazias)');
  for (const c of n) {
    if (c.startSec >= durationSec) throw new Error(`legenda começa em ${c.startSec.toFixed(2)}s, além da duração do vídeo (${durationSec.toFixed(2)}s)`);
    if (c.endSec > durationSec + 1) throw new Error(`legenda termina em ${c.endSec.toFixed(2)}s, além da duração do vídeo (${durationSec.toFixed(2)}s)`);
    c.endSec = Math.min(c.endSec, durationSec);
  }
  return n;
}

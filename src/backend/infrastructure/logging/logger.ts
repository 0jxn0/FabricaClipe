// Logs estruturados: arquivo JSON-lines com rotação simples + tabela execution_logs (consultável pelo diagnóstico).
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../database/db.ts';

export type Level = 'debug' | 'info' | 'warn' | 'error';
export interface LogCtx { jobId?: string; stationId?: string; [k: string]: unknown }

export class Logger {
  private file: string | null; private db: Db | null = null; private maxBytes = 5 * 1024 * 1024;
  constructor(dir: string | null) { this.file = dir ? path.join(dir, 'fabrica.log') : null; if (dir) fs.mkdirSync(dir, { recursive: true }); }
  attach(db: Db) { this.db = db; }

  log(level: Level, message: string, ctx: LogCtx = {}) {
    const { jobId, stationId, ...data } = ctx; const timestamp = new Date().toISOString();
    if (this.file) {
      try {
        if (fs.existsSync(this.file) && fs.statSync(this.file).size > this.maxBytes) fs.renameSync(this.file, `${this.file}.1`);
        fs.appendFileSync(this.file, JSON.stringify({ timestamp, level, message, jobId, stationId, ...data }) + '\n');
      } catch { /* log nunca derruba a fábrica */ }
    }
    try { this.db?.run('INSERT INTO execution_logs (level, timestamp, job_id, station_id, message, data_json) VALUES (?, ?, ?, ?, ?, ?)', level, timestamp, jobId ?? null, stationId ?? null, message, Object.keys(data).length ? JSON.stringify(data) : null); } catch { /* idem */ }
  }
  info(m: string, c?: LogCtx) { this.log('info', m, c); }
  warn(m: string, c?: LogCtx) { this.log('warn', m, c); }
  error(m: string, c?: LogCtx) { this.log('error', m, c); }
}

// SQLite local (node:sqlite, sem módulo nativo para compilar). Troca por better-sqlite3 só exige reimplementar esta classe.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations.ts';

type P = string | number | bigint | null | Uint8Array;

export class Db {
  readonly raw: DatabaseSync;
  readonly file: string;
  private depth = 0;

  constructor(file: string) {
    this.file = file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  }

  run(sql: string, ...p: P[]) { return this.raw.prepare(sql).run(...p); }
  get<T = Record<string, unknown>>(sql: string, ...p: P[]): T | undefined { return this.raw.prepare(sql).get(...p) as T | undefined; }
  all<T = Record<string, unknown>>(sql: string, ...p: P[]): T[] { return this.raw.prepare(sql).all(...p) as T[]; }

  /** Transação (aninhável via SAVEPOINT). Qualquer exceção desfaz tudo. */
  tx<T>(fn: () => T): T {
    const name = `sp${this.depth++}`;
    this.raw.exec(this.depth === 1 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
    try { const r = fn(); this.raw.exec(this.depth === 1 ? 'COMMIT' : `RELEASE ${name}`); return r; }
    catch (e) { this.raw.exec(this.depth === 1 ? 'ROLLBACK' : `ROLLBACK TO ${name}`); throw e; }
    finally { this.depth--; }
  }

  migrate(): number[] {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const done = new Set(this.all<{ id: number }>('SELECT id FROM schema_migrations').map((r) => r.id));
    const applied: number[] = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      this.tx(() => { this.raw.exec(m.sql); this.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', m.id, m.name, new Date().toISOString()); });
      applied.push(m.id);
    }
    return applied;
  }

  integrity(): string { return String((this.get<{ integrity_check: string }>('PRAGMA integrity_check') ?? {}).integrity_check ?? 'unknown'); }

  /** Backup consistente (VACUUM INTO) — não copia o arquivo "no meio" de uma escrita. */
  backup(dest: string) { fs.mkdirSync(path.dirname(dest), { recursive: true }); this.raw.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`); }

  close() { this.raw.close(); }
}

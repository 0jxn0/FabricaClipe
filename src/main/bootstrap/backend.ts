// Monta o backend inteiro (banco, barramento, orquestrador). Sem Electron aqui: dá para testar e reutilizar.
import fs from 'node:fs';
import path from 'node:path';
import { Db } from '../../backend/infrastructure/database/db.ts';
import { Logger } from '../../backend/infrastructure/logging/logger.ts';
import { EventBus } from '../../backend/core/event-bus/EventBus.ts';
import { Orchestrator } from '../../backend/core/orchestrator/Orchestrator.ts';
import type { Worker } from '../../backend/workers/Worker.ts';

export const DIRS = ['database', 'projects', 'temp', 'logs', 'backups', 'exports'] as const;

export function startBackend(dataDir: string, workers: Worker[] = []) {
  for (const d of DIRS) fs.mkdirSync(path.join(dataDir, d), { recursive: true });
  const logger = new Logger(path.join(dataDir, 'logs'));
  const db = new Db(path.join(dataDir, 'database', 'fabrica.sqlite'));
  const applied = db.migrate(); logger.attach(db);
  if (applied.length) logger.info(`migrations aplicadas: ${applied.join(', ')}`);
  const integrity = db.integrity(); if (integrity !== 'ok') logger.error(`banco com problema: ${integrity}`);
  try { // um backup consistente por abertura; mantém os 7 mais recentes
    const bdir = path.join(dataDir, 'backups');
    db.backup(path.join(bdir, `fabrica-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`));
    const olds = fs.readdirSync(bdir).filter((f) => /^fabrica-.*\.sqlite$/.test(f)).sort().slice(0, -7);
    for (const f of olds) fs.rmSync(path.join(bdir, f), { force: true });
  } catch (e) { logger.warn(`backup do banco ignorado: ${(e as Error).message}`); }
  const bus = new EventBus(db, (m, e) => logger.error(m, { err: String(e) }));
  const orchestrator = new Orchestrator({ db, bus, logger, dataDir, workers });
  return { db, bus, orchestrator, logger, dataDir };
}
export type Backend = ReturnType<typeof startBackend>;

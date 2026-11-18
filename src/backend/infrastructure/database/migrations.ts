// Migrations versionadas. Nunca edite uma migration já publicada: crie a próxima.
export const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  { id: 1, name: 'schema inicial', sql: `
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO projects (id, name, created_at) VALUES ('default', 'Padrão', datetime('now'));
    CREATE TABLE stations (id TEXT PRIMARY KEY, name TEXT NOT NULL, desk_id TEXT NOT NULL, position INTEGER NOT NULL, max_concurrency INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE employees (id TEXT PRIMARY KEY, name TEXT NOT NULL, station_id TEXT NOT NULL REFERENCES stations(id),
      state TEXT NOT NULL DEFAULT 'unavailable', current_job_id TEXT, progress REAL, last_activity_at TEXT);
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id),
      source_path TEXT NOT NULL, current_path TEXT NOT NULL, station_id TEXT NOT NULL, employee_id TEXT,
      state TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 5, attempts INTEGER NOT NULL DEFAULT 0,
      not_before TEXT, locked_by TEXT, error TEXT, config_json TEXT NOT NULL, platforms_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL);
    CREATE INDEX jobs_queue ON jobs (station_id, state, priority DESC, created_at);
    CREATE TABLE media_files (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id), station_id TEXT NOT NULL,
      kind TEXT NOT NULL, path TEXT NOT NULL, size_bytes INTEGER, sha256 TEXT, metadata_json TEXT, created_at TEXT NOT NULL);
    CREATE TABLE job_steps (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id), station_id TEXT NOT NULL,
      attempt INTEGER NOT NULL, state TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, output_path TEXT, result_json TEXT, error TEXT);
    CREATE INDEX job_steps_job ON job_steps (job_id, id);
    CREATE TABLE transfers (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id), from_station TEXT NOT NULL, to_station TEXT NOT NULL,
      file_path TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT, error TEXT);
    CREATE TABLE approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id), state TEXT NOT NULL,
      decided_by TEXT, note TEXT, requested_at TEXT NOT NULL, decided_at TEXT);
    CREATE TABLE publications (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id), platform TEXT NOT NULL,
      state TEXT NOT NULL, external_id TEXT, url TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
      UNIQUE (job_id, platform));
    CREATE TABLE platform_accounts (platform TEXT PRIMARY KEY, label TEXT, secret_file TEXT, connected_at TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE event_logs (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, event TEXT NOT NULL, timestamp TEXT NOT NULL,
      job_id TEXT, station_id TEXT, employee_id TEXT, payload_json TEXT NOT NULL);
    CREATE INDEX event_logs_job ON event_logs (job_id, seq);
    CREATE TABLE execution_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, timestamp TEXT NOT NULL, job_id TEXT, station_id TEXT, message TEXT NOT NULL, data_json TEXT);
  ` },
  { id: 2, name: 'status das contas de plataforma', sql: `ALTER TABLE platform_accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'none';` },
];

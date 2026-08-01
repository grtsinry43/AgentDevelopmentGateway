import type Database from 'better-sqlite3'

interface Migration {
  version: number
  sql: string
}

const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE server_identity (
        singleton_key INTEGER PRIMARY KEY CHECK (singleton_key = 1),
        id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        path TEXT NOT NULL,
        normalized_path TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (host_id, normalized_path)
      ) STRICT;

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        adapter_id TEXT NOT NULL,
        runtime_session_id TEXT,
        provider_profile_id TEXT,
        model TEXT,
        reasoning_effort TEXT,
        mode TEXT CHECK (mode IS NULL OR mode IN ('default', 'plan')),
        status TEXT NOT NULL CHECK (
          status IN ('starting', 'idle', 'running', 'waiting', 'interrupted', 'error', 'closed')
        ),
        title TEXT,
        last_event_sequence INTEGER NOT NULL,
        provider_state_snapshot TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX sessions_project_id_idx ON sessions(project_id);
      CREATE INDEX sessions_status_idx ON sessions(status);
    `
  },
  {
    version: 2,
    sql: `
      ALTER TABLE projects ADD COLUMN archived_at INTEGER;
      CREATE INDEX projects_archived_at_idx ON projects(archived_at);
    `
  },
  {
    version: 3,
    sql: `
      CREATE TABLE session_events (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence)
      ) STRICT;

      CREATE INDEX session_events_session_id_idx ON session_events(session_id);
      CREATE INDEX session_events_timestamp_idx ON session_events(timestamp);
    `
  },
  {
    version: 4,
    sql: `
      ALTER TABLE sessions ADD COLUMN work_mode TEXT NOT NULL DEFAULT 'build'
        CHECK (work_mode IN ('build', 'plan'));
      ALTER TABLE sessions ADD COLUMN execution_settings_json TEXT NOT NULL DEFAULT
        '{"workMode":"build","approval":{"defaultAction":"ask","reviewer":"user","rules":[]},"sandbox":{"filesystem":"workspace-write","network":"ask"}}';
      ALTER TABLE sessions ADD COLUMN effective_execution_settings_json TEXT NOT NULL DEFAULT
        '{"workMode":"build","approval":{"defaultAction":"ask","reviewer":"user","rules":[]},"sandbox":{"filesystem":"workspace-write","network":"ask"}}';
      ALTER TABLE sessions ADD COLUMN execution_limitations_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE sessions ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT
        '{"steer":"unsupported","modelSwitch":"unsupported","execution":{"workModes":[],"approvalActions":[],"approvalReviewers":[],"filesystemSandbox":[],"networkAccess":[],"update":"unsupported","granularRules":false},"features":{},"raw":[],"degradations":[{"capability":"runtime.snapshot","status":"unsupported","reason":"Capability snapshot predates protocol version 2"}]}';
      ALTER TABLE sessions ADD COLUMN control_revision INTEGER NOT NULL DEFAULT 0;
      UPDATE sessions SET work_mode = 'plan' WHERE mode = 'plan';
      UPDATE sessions SET execution_settings_json = json_set(execution_settings_json, '$.workMode', 'plan'),
        effective_execution_settings_json = json_set(effective_execution_settings_json, '$.workMode', 'plan')
        WHERE mode = 'plan';
    `
  },
  {
    version: 5,
    sql: `
      ALTER TABLE sessions ADD COLUMN task_state_json TEXT NOT NULL DEFAULT '{"tasks":[]}';
    `
  },
  {
    version: 6,
    sql: `
      ALTER TABLE sessions ADD COLUMN subagent_runs_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE sessions ADD COLUMN input_queue_json TEXT NOT NULL DEFAULT '[]';
    `
  }
]

export function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `)

  const appliedRows = database.prepare('SELECT version FROM schema_migrations').all() as Array<{
    version: number
  }>
  const applied = new Set(appliedRows.map((row) => row.version))
  const record = database.prepare(
    'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
  )

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue
    database.transaction(() => {
      database.exec(migration.sql)
      record.run(migration.version, Date.now())
    })()
  }
}

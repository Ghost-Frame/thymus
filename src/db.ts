import Database from "libsql";

export function initDb(path: string): InstanceType<typeof Database> {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS rubrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      criteria TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rubric_id INTEGER NOT NULL REFERENCES rubrics(id),
      agent TEXT NOT NULL,
      subject TEXT NOT NULL,
      input TEXT NOT NULL DEFAULT '{}',
      output TEXT NOT NULL DEFAULT '{}',
      scores TEXT NOT NULL DEFAULT '{}',
      overall_score REAL NOT NULL,
      notes TEXT,
      evaluator TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      tags TEXT NOT NULL DEFAULT '{}',
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_evaluations_agent_created ON evaluations(agent, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_evaluations_rubric_created ON evaluations(rubric_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_metrics_agent_metric_recorded ON metrics(agent, metric, recorded_at DESC);
  `);

  return db;
}

export type Db = InstanceType<typeof Database>;

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

/**
 * Database — the single SQLite connection + schema owner for CodeX
 * Desktop's local storage (spec sections 12, 25). Everything Core needs
 * to survive an app restart (projects, environments, jobs, snapshots,
 * project memory) lives here. No cloud storage, no telemetry database —
 * fully local, per spec section 23 (Offline First).
 */
export class CodexDatabase {
  readonly db: Database.Database;

  constructor(storageDir: string) {
    fs.mkdirSync(storageDir, { recursive: true });
    const dbPath = path.join(storageDir, 'codex.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        environment_id TEXT NOT NULL,
        environment_version TEXT NOT NULL,
        source_path TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        network_permission INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_history (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        timestamp TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        job_id TEXT,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_project_history_project ON project_history(project_id);

      CREATE TABLE IF NOT EXISTS project_memory (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS environments (
        environment_id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        project_id TEXT,
        environment_id TEXT,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        job_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(project_id);

      CREATE TABLE IF NOT EXISTS repair_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        job_id TEXT NOT NULL,
        session_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS network_grants (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        grant_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        manifest_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        installed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }
}

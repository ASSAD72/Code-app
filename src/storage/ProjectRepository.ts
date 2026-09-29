import { randomUUID } from 'crypto';
import { CodexDatabase } from './CodexDatabase';
import { ProjectManifest, ProjectHistoryEntry, ProjectMemoryRecord } from '@core/types';

interface ProjectRow {
  id: string;
  name: string;
  type: string;
  environment_id: string;
  environment_version: string;
  source_path: string;
  manifest_json: string;
  network_permission: number;
  created_at: string;
  updated_at: string;
}

export class ProjectRepository {
  constructor(private readonly database: CodexDatabase) {}

  create(manifest: ProjectManifest): void {
    this.database.db
      .prepare(
        `INSERT INTO projects (id, name, type, environment_id, environment_version, source_path, manifest_json, network_permission, created_at, updated_at)
         VALUES (@id, @name, @type, @environmentId, @environmentVersion, @sourcePath, @manifestJson, @networkPermission, @createdAt, @updatedAt)`
      )
      .run({
        id: manifest.id,
        name: manifest.name,
        type: manifest.type,
        environmentId: manifest.environmentId,
        environmentVersion: manifest.environmentVersion,
        sourcePath: manifest.sourcePath,
        manifestJson: JSON.stringify(manifest),
        networkPermission: manifest.networkPermission ? 1 : 0,
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
      });
  }

  update(manifest: ProjectManifest): void {
    this.database.db
      .prepare(
        `UPDATE projects SET name=@name, type=@type, environment_id=@environmentId, environment_version=@environmentVersion,
         source_path=@sourcePath, manifest_json=@manifestJson, network_permission=@networkPermission, updated_at=@updatedAt
         WHERE id=@id`
      )
      .run({
        id: manifest.id,
        name: manifest.name,
        type: manifest.type,
        environmentId: manifest.environmentId,
        environmentVersion: manifest.environmentVersion,
        sourcePath: manifest.sourcePath,
        manifestJson: JSON.stringify(manifest),
        networkPermission: manifest.networkPermission ? 1 : 0,
        updatedAt: new Date().toISOString(),
      });
  }

  get(id: string): ProjectManifest | null {
    const row = this.database.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined;
    return row ? (JSON.parse(row.manifest_json) as ProjectManifest) : null;
  }

  list(): ProjectManifest[] {
    const rows = this.database.db.prepare(`SELECT * FROM projects ORDER BY updated_at DESC`).all() as ProjectRow[];
    return rows.map((r) => JSON.parse(r.manifest_json) as ProjectManifest);
  }

  delete(id: string): void {
    this.database.db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
  }

  addHistoryEntry(projectId: string, entry: ProjectHistoryEntry): void {
    this.database.db
      .prepare(
        `INSERT INTO project_history (id, project_id, timestamp, kind, summary, job_id, detail)
         VALUES (@id, @projectId, @timestamp, @kind, @summary, @jobId, @detail)`
      )
      .run({
        id: randomUUID(),
        projectId,
        timestamp: entry.timestamp,
        kind: entry.kind,
        summary: entry.summary,
        jobId: entry.jobId ?? null,
        detail: entry.detail ?? null,
      });
  }

  getHistory(projectId: string, limit = 200): ProjectHistoryEntry[] {
    const rows = this.database.db
      .prepare(`SELECT * FROM project_history WHERE project_id = ? ORDER BY timestamp DESC LIMIT ?`)
      .all(projectId, limit) as {
      timestamp: string;
      kind: ProjectHistoryEntry['kind'];
      summary: string;
      job_id: string | null;
      detail: string | null;
    }[];
    return rows.map((r) => ({
      timestamp: r.timestamp,
      kind: r.kind,
      summary: r.summary,
      jobId: r.job_id ?? undefined,
      detail: r.detail ?? undefined,
    }));
  }

  getMemory(projectId: string): ProjectMemoryRecord | null {
    const row = this.database.db.prepare(`SELECT record_json FROM project_memory WHERE project_id = ?`).get(projectId) as
      | { record_json: string }
      | undefined;
    return row ? (JSON.parse(row.record_json) as ProjectMemoryRecord) : null;
  }

  saveMemory(record: ProjectMemoryRecord): void {
    this.database.db
      .prepare(
        `INSERT INTO project_memory (project_id, record_json, updated_at) VALUES (@projectId, @recordJson, @updatedAt)
         ON CONFLICT(project_id) DO UPDATE SET record_json=@recordJson, updated_at=@updatedAt`
      )
      .run({ projectId: record.projectId, recordJson: JSON.stringify(record), updatedAt: new Date().toISOString() });
  }
}

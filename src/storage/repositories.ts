import { CodexDatabase } from './CodexDatabase';
import { Job, EnvironmentManifest, Snapshot, RepairSession } from '@core/types';

export class JobRepository {
  constructor(private readonly database: CodexDatabase) {}

  upsert(job: Job): void {
    this.database.db
      .prepare(
        `INSERT INTO jobs (id, kind, project_id, environment_id, status, title, job_json, created_at, updated_at)
         VALUES (@id, @kind, @projectId, @environmentId, @status, @title, @jobJson, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET status=@status, job_json=@jobJson, updated_at=@updatedAt`
      )
      .run({
        id: job.id,
        kind: job.kind,
        projectId: job.projectId ?? null,
        environmentId: job.environmentId ?? null,
        status: job.status,
        title: job.title,
        jobJson: JSON.stringify(job),
        createdAt: job.createdAt,
        updatedAt: new Date().toISOString(),
      });
  }

  get(id: string): Job | null {
    const row = this.database.db.prepare(`SELECT job_json FROM jobs WHERE id = ?`).get(id) as
      | { job_json: string }
      | undefined;
    return row ? (JSON.parse(row.job_json) as Job) : null;
  }

  listByProject(projectId: string, limit = 100): Job[] {
    const rows = this.database.db
      .prepare(`SELECT job_json FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(projectId, limit) as { job_json: string }[];
    return rows.map((r) => JSON.parse(r.job_json) as Job);
  }

  listActive(): Job[] {
    const rows = this.database.db
      .prepare(`SELECT job_json FROM jobs WHERE status IN ('QUEUED','RUNNING','BUILDING','TESTING','PAUSED')`)
      .all() as { job_json: string }[];
    return rows.map((r) => JSON.parse(r.job_json) as Job);
  }

  listAll(limit = 500): Job[] {
    const rows = this.database.db.prepare(`SELECT job_json FROM jobs ORDER BY created_at DESC LIMIT ?`).all(limit) as {
      job_json: string;
    }[];
    return rows.map((r) => JSON.parse(r.job_json) as Job);
  }
}

export class EnvironmentRepository {
  constructor(private readonly database: CodexDatabase) {}

  upsert(manifest: EnvironmentManifest): void {
    this.database.db
      .prepare(
        `INSERT INTO environments (environment_id, pack_id, manifest_json, created_at, updated_at)
         VALUES (@environmentId, @packId, @manifestJson, @createdAt, @updatedAt)
         ON CONFLICT(environment_id) DO UPDATE SET manifest_json=@manifestJson, updated_at=@updatedAt`
      )
      .run({
        environmentId: manifest.environmentId,
        packId: manifest.packId,
        manifestJson: JSON.stringify(manifest),
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
      });
  }

  get(environmentId: string): EnvironmentManifest | null {
    const row = this.database.db
      .prepare(`SELECT manifest_json FROM environments WHERE environment_id = ?`)
      .get(environmentId) as { manifest_json: string } | undefined;
    return row ? (JSON.parse(row.manifest_json) as EnvironmentManifest) : null;
  }

  list(): EnvironmentManifest[] {
    const rows = this.database.db.prepare(`SELECT manifest_json FROM environments ORDER BY created_at DESC`).all() as {
      manifest_json: string;
    }[];
    return rows.map((r) => JSON.parse(r.manifest_json) as EnvironmentManifest);
  }

  delete(environmentId: string): void {
    this.database.db.prepare(`DELETE FROM environments WHERE environment_id = ?`).run(environmentId);
  }
}

export class SnapshotRepository {
  constructor(private readonly database: CodexDatabase) {}

  create(snapshot: Snapshot): void {
    this.database.db
      .prepare(`INSERT INTO snapshots (id, project_id, snapshot_json, created_at) VALUES (@id, @projectId, @json, @createdAt)`)
      .run({ id: snapshot.id, projectId: snapshot.projectId, json: JSON.stringify(snapshot), createdAt: snapshot.createdAt });
  }

  listByProject(projectId: string): Snapshot[] {
    const rows = this.database.db
      .prepare(`SELECT snapshot_json FROM snapshots WHERE project_id = ? ORDER BY created_at DESC`)
      .all(projectId) as { snapshot_json: string }[];
    return rows.map((r) => JSON.parse(r.snapshot_json) as Snapshot);
  }

  get(id: string): Snapshot | null {
    const row = this.database.db.prepare(`SELECT snapshot_json FROM snapshots WHERE id = ?`).get(id) as
      | { snapshot_json: string }
      | undefined;
    return row ? (JSON.parse(row.snapshot_json) as Snapshot) : null;
  }

  delete(id: string): void {
    this.database.db.prepare(`DELETE FROM snapshots WHERE id = ?`).run(id);
  }
}

export class RepairSessionRepository {
  constructor(private readonly database: CodexDatabase) {}

  upsert(session: RepairSession): void {
    this.database.db
      .prepare(
        `INSERT INTO repair_sessions (id, project_id, job_id, session_json, created_at, updated_at)
         VALUES (@id, @projectId, @jobId, @json, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET session_json=@json, updated_at=@updatedAt`
      )
      .run({
        id: session.id,
        projectId: session.projectId,
        jobId: session.jobId,
        json: JSON.stringify(session),
        createdAt: session.startedAt,
        updatedAt: new Date().toISOString(),
      });
  }

  get(id: string): RepairSession | null {
    const row = this.database.db.prepare(`SELECT session_json FROM repair_sessions WHERE id = ?`).get(id) as
      | { session_json: string }
      | undefined;
    return row ? (JSON.parse(row.session_json) as RepairSession) : null;
  }

  listByProject(projectId: string): RepairSession[] {
    const rows = this.database.db
      .prepare(`SELECT session_json FROM repair_sessions WHERE project_id = ? ORDER BY created_at DESC`)
      .all(projectId) as { session_json: string }[];
    return rows.map((r) => JSON.parse(r.session_json) as RepairSession);
  }
}

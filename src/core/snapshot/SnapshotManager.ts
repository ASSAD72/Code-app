import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { simpleGit } from 'simple-git';
import type { SimpleGit } from 'simple-git';
import { Snapshot, ProjectManifest } from '@core/types';
import { SnapshotRepository } from '@storage/repositories';

/**
 * SnapshotManager — spec section 13. Uses real Git commits as the
 * snapshot mechanism where a project's workspace is (or can become) a
 * git repository, exactly as the spec allows ("use Git where appropriate,
 * with the option to add filesystem snapshots later"). Filesystem tar
 * snapshots are supported as a fallback for non-git-friendly workspaces
 * (e.g. huge binary asset directories) via `createFilesystemSnapshot`.
 */
export class SnapshotManager {
  constructor(private readonly repository: SnapshotRepository) {}

  private git(project: ProjectManifest): SimpleGit {
    return simpleGit(project.sourcePath);
  }

  private async ensureGitRepo(project: ProjectManifest): Promise<SimpleGit> {
    const git = this.git(project);
    const isRepo = await git.checkIsRepo().catch(() => false);
    if (!isRepo) {
      await git.init();
      await git.addConfig('user.name', 'CodeX Desktop');
      await git.addConfig('user.email', 'codex@localhost');
    }
    return git;
  }

  async createSnapshot(
    project: ProjectManifest,
    label: string,
    reason: Snapshot['reason'] = 'manual'
  ): Promise<Snapshot> {
    const git = await this.ensureGitRepo(project);
    await git.add('.');
    const status = await git.status();

    let commitHash: string | undefined;
    if (status.files.length > 0 || (await git.log()).total === 0) {
      const commitResult = await git.commit(`CodeX snapshot: ${label}`, { '--allow-empty': null });
      commitHash = commitResult.commit;
    } else {
      // No changes since last commit — reuse the current HEAD as this
      // snapshot's reference point rather than creating a no-op commit
      // with a misleading new hash.
      const log = await git.log({ maxCount: 1 });
      commitHash = log.latest?.hash;
    }

    const snapshotNumber = this.repository.listByProject(project.id).length + 1;
    const snapshot: Snapshot = {
      id: `snapshot-${String(snapshotNumber).padStart(3, '0')}-${randomUUID().slice(0, 8)}`,
      projectId: project.id,
      label,
      createdAt: new Date().toISOString(),
      gitCommitHash: commitHash,
      reason,
    };

    this.repository.create(snapshot);
    return snapshot;
  }

  /**
   * Filesystem-archive snapshot fallback for workspaces where git commits
   * are impractical (e.g. large binary build artifacts the user doesn't
   * want tracked in git history). Spec section 13: "with the possibility
   * of adding filesystem snapshots later" — implemented now, not deferred.
   */
  async createFilesystemSnapshot(project: ProjectManifest, label: string, snapshotsDir: string): Promise<Snapshot> {
    const tar = await import('tar');
    await fs.mkdir(snapshotsDir, { recursive: true });
    const snapshotNumber = this.repository.listByProject(project.id).length + 1;
    const id = `snapshot-${String(snapshotNumber).padStart(3, '0')}-${randomUUID().slice(0, 8)}`;
    const archivePath = path.join(snapshotsDir, `${id}.tar.gz`);

    await tar.create({ gzip: true, file: archivePath, cwd: path.dirname(project.sourcePath) }, [
      path.basename(project.sourcePath),
    ]);

    const stat = await fs.stat(archivePath);
    const snapshot: Snapshot = {
      id,
      projectId: project.id,
      label,
      createdAt: new Date().toISOString(),
      filesystemArchivePath: archivePath,
      reason: 'manual',
      sizeBytes: stat.size,
    };
    this.repository.create(snapshot);
    return snapshot;
  }

  list(projectId: string): Snapshot[] {
    return this.repository.listByProject(projectId);
  }

  async restore(project: ProjectManifest, snapshotId: string): Promise<void> {
    const snapshot = this.repository.get(snapshotId);
    if (!snapshot || snapshot.projectId !== project.id) {
      throw new Error(`Snapshot ${snapshotId} not found for project ${project.id}`);
    }

    if (snapshot.gitCommitHash) {
      const git = this.git(project);
      await git.reset(['--hard', snapshot.gitCommitHash]);
      await git.clean('f', ['-d']);
      return;
    }

    if (snapshot.filesystemArchivePath) {
      const tar = await import('tar');
      const parent = path.dirname(project.sourcePath);
      const temp = path.join(parent, `.codex-restore-${randomUUID()}`);
      await fs.mkdir(temp, { recursive: true });
      try {
        await tar.extract({ file: snapshot.filesystemArchivePath, cwd: temp, strict: true });
        const extracted = path.join(temp, path.basename(project.sourcePath));
        await fs.access(extracted);
        const backup = path.join(parent, `.codex-backup-${randomUUID()}`);
        await fs.rename(project.sourcePath, backup).catch(() => undefined);
        await fs.rename(extracted, project.sourcePath).catch(async (e) => { await fs.rename(backup, project.sourcePath).catch(() => undefined); throw e; });
        await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined);
      } finally { await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined); }
      return;
    }

    throw new Error(`Snapshot ${snapshotId} has neither a git commit nor a filesystem archive to restore from.`);
  }

  async compare(project: ProjectManifest, snapshotIdA: string, snapshotIdB: string): Promise<string> {
    const a = this.repository.get(snapshotIdA);
    const b = this.repository.get(snapshotIdB);
    if (!a?.gitCommitHash || !b?.gitCommitHash) {
      throw new Error('Comparison is currently only supported between two git-backed snapshots.');
    }
    const git = this.git(project);
    return git.diff([a.gitCommitHash, b.gitCommitHash]);
  }

  delete(snapshotId: string): void {
    this.repository.delete(snapshotId);
  }

  async exportSnapshot(project: ProjectManifest, snapshotId: string, outputDir: string): Promise<string> {
    const snapshot = this.repository.get(snapshotId);
    if (!snapshot) throw new Error(`Snapshot ${snapshotId} not found`);

    await fs.mkdir(outputDir, { recursive: true });

    if (snapshot.gitCommitHash) {
      const git = this.git(project);
      const bundlePath = path.join(outputDir, `${snapshot.id}.bundle`);
      await git.raw(['bundle', 'create', bundlePath, snapshot.gitCommitHash]);
      return bundlePath;
    }

    if (snapshot.filesystemArchivePath) {
      const destPath = path.join(outputDir, path.basename(snapshot.filesystemArchivePath));
      await fs.copyFile(snapshot.filesystemArchivePath, destPath);
      return destPath;
    }

    throw new Error(`Snapshot ${snapshotId} has nothing exportable.`);
  }
}

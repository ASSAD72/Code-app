import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import * as tar from 'tar';
import { ProjectManifest, EnvironmentManifest } from '@core/types';
import { ProjectRepository } from '@storage/ProjectRepository';
import { EnvironmentManager } from '../environments/EnvironmentManager';

/**
 * Importer — spec section 14's "codex import": takes a source-export
 * archive (produced by ProjectExporter.exportSource) or an environment
 * archive (produced by EnvironmentManager.exportEnvironment) and
 * reconstitutes it as a usable project/environment on this machine.
 */
export class Importer {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly environmentManager: EnvironmentManager
  ) {}

  /**
   * Import a project source archive. If the embedded environment manifest
   * references an environment that already exists locally (by checksum),
   * it's reused; otherwise a fresh environment is created from the
   * embedded manifest so the imported project has somewhere to run.
   */
  async importProject(archivePath: string, workspaceRootDir: string): Promise<ProjectManifest> {
    const extractDir = path.join(workspaceRootDir, `.codex-import-${randomUUID()}`);
    await fs.mkdir(extractDir, { recursive: true });
    await tar.extract({ file: archivePath, cwd: extractDir, strict: true });

    const entries = await fs.readdir(extractDir, { withFileTypes: true });
    if (entries.some((entry) => !entry.isDirectory())) throw new Error('Import archive contains unexpected top-level files.');
    const projectDirName = entries[0]?.name;
    if (!projectDirName) {
      throw new Error('Import archive did not contain a project directory.');
    }
    if (!projectDirName || projectDirName === '.' || projectDirName === '..' || path.basename(projectDirName) !== projectDirName) throw new Error('Invalid project directory name in import archive.');
    const extractedProjectDir = path.join(extractDir, projectDirName);

    const exportManifestPath = path.join(extractedProjectDir, '.codex-project-export.json');
    const exportManifestRaw = await fs.readFile(exportManifestPath, 'utf-8').catch(() => null);
    if (!exportManifestRaw) {
      throw new Error('Archive is missing .codex-project-export.json; this does not look like a CodeX source export.');
    }
    const { project: originalManifest, environment: originalEnvironment } = JSON.parse(exportManifestRaw) as {
      project: ProjectManifest;
      environment: EnvironmentManifest;
    };

    // Move extracted source into its final home in the workspace root.
    const finalProjectDir = await allocateImportPath(workspaceRootDir, projectDirName);
    await fs.rename(extractedProjectDir, finalProjectDir);
    await fs.rm(path.join(finalProjectDir, '.codex-project-export.json'), { force: true });
    await fs.rm(extractDir, { recursive: true, force: true });

    // Ensure an environment exists locally for this project to run in.
    let environment: EnvironmentManifest | null = this.environmentManager.get(originalEnvironment.environmentId);
    try {
      if (!environment) environment = await this.environmentManager.create({ packId: originalEnvironment.packId });
    } catch (error) {
      await fs.rm(finalProjectDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    const newProjectId = randomUUID();
    const now = new Date().toISOString();
    const importedManifest: ProjectManifest = {
      ...originalManifest,
      id: newProjectId,
      sourcePath: finalProjectDir,
      environmentId: environment.environmentId,
      environmentVersion: environment.version,
      createdAt: now,
      updatedAt: now,
    };

    this.projectRepository.create(importedManifest);
    this.projectRepository.addHistoryEntry(newProjectId, {
      timestamp: now,
      kind: 'command',
      summary: `Project imported from archive ${path.basename(archivePath)}.`,
    });

    return importedManifest;
  }

  async importEnvironment(archivePath: string): Promise<EnvironmentManifest> {
    return this.environmentManager.importEnvironment(archivePath);
  }
}


async function allocateImportPath(root: string, baseName: string): Promise<string> {
  const safe = path.basename(baseName);
  for (let i = 0; i < 10000; i += 1) {
    const candidate = path.join(root, i === 0 ? safe : `${safe}-${i + 1}`);
    if (!await fs.access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  throw new Error('Unable to allocate an import destination.');
}

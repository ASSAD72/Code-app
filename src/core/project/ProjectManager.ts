import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import {
  ProjectManifest,
  ProjectType,
  ProjectHistoryEntry,
  ProjectMemoryRecord,
  EnvironmentManifest,
} from '@core/types';
import { ProjectRepository } from '@storage/ProjectRepository';
import { EnvironmentManager } from '../../environments/EnvironmentManager';
import { EnvironmentPackRegistry } from '../../environments/EnvironmentPackRegistry';

export interface CreateProjectOptions {
  name: string;
  type: ProjectType;
  packId: string;
  workspaceRootDir: string;
  onProgress?: (line: string) => void;
}

/**
 * ProjectManager — spec section 11 (project.json) and section 12
 * (Project Memory). Owns the full lifecycle: create, scaffold via the
 * appropriate EnvironmentPack, persist manifest + history + memory.
 */
export class ProjectManager {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly environmentManager: EnvironmentManager,
    private readonly packRegistry: EnvironmentPackRegistry
  ) {}

  async createProject(options: CreateProjectOptions): Promise<ProjectManifest> {
    const pack = this.packRegistry.get(options.packId);
    const projectId = randomUUID();
    const root = path.resolve(options.workspaceRootDir);
    await fs.mkdir(root, { recursive: true });
    const baseName = sanitizeDirName(options.name);
    if (!baseName) throw new Error('Project name must contain at least one letter or number.');
    const sourcePath = await allocateUniqueProjectPath(root, baseName);
    let environment: EnvironmentManifest | undefined;
    let scaffolded = false;
    try {
      options.onProgress?.(`Creating environment for pack ${options.packId}...`);
      environment = await this.environmentManager.create({
        packId: options.packId,
        onProgress: options.onProgress,
      });
      await fs.mkdir(sourcePath, { recursive: false });
      options.onProgress?.(`Scaffolding ${options.type} project files...`);
      const createdFiles = await pack.scaffoldProject(sourcePath, options.name);
      scaffolded = true;

    const now = new Date().toISOString();
    const manifest: ProjectManifest = {
      id: projectId,
      name: options.name,
      type: options.type,
      environmentId: environment.environmentId,
      environmentVersion: environment.version,
      sourcePath,
      dependencies: [],
      commands: {
        buildCommand: pack.definition.buildCommand,
        testCommand: pack.definition.testCommand,
        runCommand: pack.definition.runCommand,
      },
      exportConfiguration: {
        sourceExportEnabled: true,
        nativeExportTargets: [],
        environmentExportEnabled: true,
      },
      createdAt: now,
      updatedAt: now,
      networkPermission: false,
    };

    this.projectRepository.create(manifest);
    this.addHistory(projectId, {
      timestamp: now,
      kind: 'command',
      summary: `Project "${options.name}" created with ${createdFiles.length} scaffolded files.`,
    });

    const memory: ProjectMemoryRecord = {
      projectId,
      architectureDecisions: [`Initialized as a ${options.type} project using pack ${options.packId}.`],
      importantFiles: createdFiles,
      knownErrors: [],
      fixes: [],
      dependenciesNotes: [],
      environmentNotes: [`Environment ${environment.environmentId} (${environment.name}) created for this project.`],
      previousSuccessfulBuilds: [],
    };
      this.projectRepository.saveMemory(memory);
      return manifest;
    } catch (error) {
      if (scaffolded || await pathExists(sourcePath)) await fs.rm(sourcePath, { recursive: true, force: true }).catch(() => undefined);
      if (environment) await this.environmentManager.delete(environment.environmentId).catch(() => undefined);
      throw error;
    }
  }

  get(projectId: string): ProjectManifest | null {
    return this.projectRepository.get(projectId);
  }

  list(): ProjectManifest[] {
    return this.projectRepository.list();
  }

  update(manifest: ProjectManifest): void {
    manifest.updatedAt = new Date().toISOString();
    this.projectRepository.update(manifest);
  }

  async delete(projectId: string, deleteFiles: boolean): Promise<void> {
    const project = this.projectRepository.get(projectId);
    if (!project) return;
    if (deleteFiles) {
      await fs.rm(project.sourcePath, { recursive: true, force: true });
    }
    this.projectRepository.delete(projectId);
  }

  addHistory(projectId: string, entry: ProjectHistoryEntry): void {
    this.projectRepository.addHistoryEntry(projectId, entry);
  }

  getHistory(projectId: string): ProjectHistoryEntry[] {
    return this.projectRepository.getHistory(projectId);
  }

  getMemory(projectId: string): ProjectMemoryRecord | null {
    return this.projectRepository.getMemory(projectId);
  }

  updateMemory(record: ProjectMemoryRecord): void {
    this.projectRepository.saveMemory(record);
  }

  setNetworkPermission(projectId: string, enabled: boolean): void {
    const project = this.projectRepository.get(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    project.networkPermission = enabled;
    this.update(project);
    this.addHistory(projectId, {
      timestamp: new Date().toISOString(),
      kind: 'environment-change',
      summary: `Network permission ${enabled ? 'enabled' : 'disabled'} for this project.`,
    });
  }
}

function sanitizeDirName(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/-+/g, '-').replace(/^[-_]+|[-_]+$/g, '').toLowerCase();
}

async function pathExists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true).catch(() => false);
}

async function allocateUniqueProjectPath(root: string, baseName: string): Promise<string> {
  for (let i = 0; i < 10000; i += 1) {
    const candidate = path.join(root, i === 0 ? baseName : `${baseName}-${i + 1}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new Error(`Unable to allocate a unique project directory for "${baseName}".`);
}

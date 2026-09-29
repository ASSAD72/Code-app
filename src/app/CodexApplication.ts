import path from 'path';
import os from 'os';
import { CodexDatabase } from '@storage/CodexDatabase';
import { ProjectRepository } from '@storage/ProjectRepository';
import { JobRepository, EnvironmentRepository, SnapshotRepository, RepairSessionRepository } from '@storage/repositories';

import { SandboxProviderRegistry } from '../sandbox/SandboxProviderRegistry';
import { ResourceManager } from '../sandbox/ResourceManager';
import { NetworkPolicy } from '../sandbox/NetworkPolicy';
import { PolicyEngine } from '../policy/PolicyEngine';

import { EnvironmentPackRegistry } from '../environments/EnvironmentPackRegistry';
import { EnvironmentManager } from '../environments/EnvironmentManager';

import { ProjectManager } from '../core/project/ProjectManager';
import { JobManager } from '../core/job/JobManager';
import { ProcessManager } from '../core/process/ProcessManager';
import { BuildEngine } from '../core/build/BuildEngine';
import { TestEngine } from '../core/test/TestEngine';
import { SnapshotManager } from '../core/snapshot/SnapshotManager';
import { RepairEngine } from '../core/repair/RepairEngine';

import { LocalModelProvider, NoOpLocalModelProvider } from '../intelligence/LocalModelProvider';
import { OllamaProvider } from '../intelligence/providers/OllamaProvider';
import { LlamaCppProvider } from '../intelligence/providers/LlamaCppProvider';
import { Planner } from '../intelligence/Planner';

import { ToolRegistry } from '../tools/ToolRegistry';
import { ToolExecutor } from '../tools/ToolExecutor';
import { filesystemTools } from '../tools/definitions/filesystemTools';
import { buildCoreTools } from '../tools/definitions/coreTools';

import { ProjectExporter } from '../export/ProjectExporter';
import { Importer } from '../export/Importer';
import { PluginManager } from '../plugins/PluginManager';

export interface CodexApplicationConfig {
  dataDir?: string;
  workspaceRootDir?: string;
  aiProvider?: 'ollama' | 'llamacpp' | 'none';
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  llamaCppBaseUrl?: string;
  maxConcurrentJobs?: number;
}

/**
 * CodexApplication is the single composition root. Every subsystem built
 * across Sandbox, Storage, Environments, Core, Intelligence, Tools, and
 * Export is instantiated and wired together exactly once, here. The CLI
 * entry point and the Electron main process both construct exactly one
 * of these and drive the whole system through its public members —
 * neither duplicates wiring logic.
 */
export class CodexApplication {
  readonly database: CodexDatabase;
  readonly projectRepository: ProjectRepository;
  readonly jobRepository: JobRepository;
  readonly environmentRepository: EnvironmentRepository;
  readonly snapshotRepository: SnapshotRepository;
  readonly repairSessionRepository: RepairSessionRepository;

  readonly sandboxRegistry: SandboxProviderRegistry;
  readonly resourceManager: ResourceManager;
  readonly networkPolicy: NetworkPolicy;
  readonly policyEngine: PolicyEngine;

  readonly environmentPackRegistry: EnvironmentPackRegistry;
  readonly environmentManager: EnvironmentManager;

  readonly projectManager: ProjectManager;
  readonly jobManager: JobManager;
  readonly processManager: ProcessManager;
  readonly buildEngine: BuildEngine;
  readonly testEngine: TestEngine;
  readonly snapshotManager: SnapshotManager;
  readonly repairEngine: RepairEngine;

  readonly localModelProvider: LocalModelProvider;
  readonly planner: Planner;

  readonly toolRegistry: ToolRegistry;
  readonly toolExecutor: ToolExecutor;

  readonly projectExporter: ProjectExporter;
  readonly importer: Importer;

  readonly pluginManager: PluginManager;

  readonly config: Required<Pick<CodexApplicationConfig, 'dataDir' | 'workspaceRootDir'>> & CodexApplicationConfig;

  constructor(config: CodexApplicationConfig = {}) {
    const dataDir = config.dataDir ?? path.join(os.homedir(), '.codex-desktop');
    const workspaceRootDir = config.workspaceRootDir ?? path.join(dataDir, 'workspaces');
    this.config = { ...config, dataDir, workspaceRootDir };

    this.database = new CodexDatabase(dataDir);
    this.projectRepository = new ProjectRepository(this.database);
    this.jobRepository = new JobRepository(this.database);
    this.environmentRepository = new EnvironmentRepository(this.database);
    this.snapshotRepository = new SnapshotRepository(this.database);
    this.repairSessionRepository = new RepairSessionRepository(this.database);

    this.sandboxRegistry = new SandboxProviderRegistry();
    this.resourceManager = new ResourceManager();
    this.networkPolicy = new NetworkPolicy();
    this.policyEngine = new PolicyEngine();

    this.environmentPackRegistry = new EnvironmentPackRegistry();
    this.environmentManager = new EnvironmentManager(
      this.environmentRepository,
      this.environmentPackRegistry,
      this.sandboxRegistry,
      path.join(dataDir, 'environments')
    );

    this.projectManager = new ProjectManager(this.projectRepository, this.environmentManager, this.environmentPackRegistry);
    this.jobManager = new JobManager(this.jobRepository, config.maxConcurrentJobs ?? 4);
    this.processManager = new ProcessManager(this.sandboxRegistry, this.resourceManager, this.networkPolicy);
    this.buildEngine = new BuildEngine(this.jobManager, this.processManager, this.policyEngine);
    this.testEngine = new TestEngine(this.jobManager, this.processManager, this.policyEngine);
    this.snapshotManager = new SnapshotManager(this.snapshotRepository);

    this.localModelProvider = this.buildLocalModelProvider(config);
    this.repairEngine = new RepairEngine(
      this.buildEngine,
      this.testEngine,
      this.snapshotManager,
      this.projectManager,
      this.repairSessionRepository,
      this.localModelProvider
    );

    this.toolRegistry = new ToolRegistry();
    this.toolExecutor = new ToolExecutor(this.toolRegistry, this.policyEngine, this.projectManager, this.environmentManager, this.processManager);
    this.planner = new Planner(this.localModelProvider, this.toolRegistry, this.toolExecutor);
    this.registerTools();

    this.projectExporter = new ProjectExporter(this.processManager);
    this.importer = new Importer(this.projectRepository, this.environmentManager);

    this.pluginManager = new PluginManager(
      path.join(dataDir, 'plugins'),
      this.environmentPackRegistry,
      this.toolRegistry
    );
  }

  private buildLocalModelProvider(config: CodexApplicationConfig): LocalModelProvider {
    switch (config.aiProvider) {
      case 'ollama':
        return new OllamaProvider(config.ollamaBaseUrl, config.ollamaModel);
      case 'llamacpp':
        return new LlamaCppProvider(config.llamaCppBaseUrl);
      case 'none':
      default:
        return new NoOpLocalModelProvider();
    }
  }

  private registerTools(): void {
    for (const tool of filesystemTools) {
      this.toolRegistry.register(tool);
    }
    const coreTools = buildCoreTools({
      projectManager: this.projectManager,
      jobManager: this.jobManager,
      buildEngine: this.buildEngine,
      testEngine: this.testEngine,
      processManager: this.processManager,
      environmentManager: this.environmentManager,
      snapshotManager: this.snapshotManager,
      sandboxRegistry: this.sandboxRegistry,
    });
    for (const tool of coreTools) {
      this.toolRegistry.register(tool);
    }
  }

  async initialize(): Promise<void> {
    this.networkPolicy.clearSessionGrants();
    await this.pluginManager.loadAll((pluginId, error) => {
      // eslint-disable-next-line no-console
      console.error(`[CodeX] Failed to load plugin "${pluginId}": ${error.message}`);
    });
  }

  async shutdown(): Promise<void> {
    await this.processManager.teardownAll();
    this.database.close();
  }
}

import { ProjectManifest, EnvironmentManifest, ExecutionResult } from '@core/types';
import { SandboxProviderRegistry } from '../../sandbox/SandboxProviderRegistry';
import { SandboxInstanceHandle } from '../../sandbox/SandboxProvider';
import { ResourceManager } from '../../sandbox/ResourceManager';
import { NetworkPolicy } from '../../sandbox/NetworkPolicy';

/**
 * ProcessManager — the layer between Core (BuildEngine, TestEngine,
 * RepairEngine) and the raw SandboxProvider abstraction. It owns the
 * mapping from "a project" to "its currently active sandbox instance",
 * so engines never talk to dockerode/wsl.exe/etc directly and never
 * have to re-derive resource limits or network policy themselves.
 */
export class ProcessManager {
  private activeInstances = new Map<string, SandboxInstanceHandle>(); // projectId -> handle

  constructor(
    private readonly sandboxRegistry: SandboxProviderRegistry,
    private readonly resourceManager: ResourceManager,
    private readonly networkPolicy: NetworkPolicy
  ) {}

  async ensureInstance(project: ProjectManifest, environment: EnvironmentManifest): Promise<SandboxInstanceHandle> {
    const existing = this.activeInstances.get(project.id);
    if (existing) return existing;

    const provider = this.sandboxRegistry.get(environment.providerType);
    const networkEnabled = this.networkPolicy.isNetworkAllowed(project.id) && project.networkPermission;

    const handle = await provider.createInstance({
      environment,
      projectId: project.id,
      workspaceHostPath: project.sourcePath,
      networkEnabled,
      resourceLimits: environment.requiredResources,
    });

    this.activeInstances.set(project.id, handle);
    return handle;
  }

  async exec(
    project: ProjectManifest,
    environment: EnvironmentManifest,
    command: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
    }
  ): Promise<ExecutionResult> {
    const handle = await this.ensureInstance(project, environment);
    const provider = this.sandboxRegistry.get(environment.providerType);

    const result = await provider.exec(handle, {
      command,
      cwd: options?.cwd,
      env: options?.env,
      timeoutMs: options?.timeoutMs ?? environment.requiredResources.timeoutMs,
      onStdout: options?.onStdout,
      onStderr: options?.onStderr,
    });

    const usage = await provider.getResourceUsage(handle).catch(() => undefined);
    if (usage) this.resourceManager.recordSample(handle.instanceId, usage);

    return result;
  }

  async teardown(project: ProjectManifest, environment: EnvironmentManifest): Promise<void> {
    const handle = this.activeInstances.get(project.id);
    if (!handle) return;
    const provider = this.sandboxRegistry.get(environment.providerType);
    await provider.destroyInstance(handle);
    this.resourceManager.clearHistory(handle.instanceId);
    this.activeInstances.delete(project.id);
  }

  async teardownAll(): Promise<void> {
    for (const projectId of Array.from(this.activeInstances.keys())) {
      const handle = this.activeInstances.get(projectId);
      if (!handle) continue;
      const provider = this.sandboxRegistry.get(handle.providerType as never);
      await provider.destroyInstance(handle).catch(() => undefined);
    }
    this.activeInstances.clear();
  }

  getActiveHandle(projectId: string): SandboxInstanceHandle | undefined {
    return this.activeInstances.get(projectId);
  }

  async setNetworkEnabled(project: ProjectManifest, environment: EnvironmentManifest, enabled: boolean): Promise<void> {
    const handle = this.activeInstances.get(project.id);
    if (!handle) return; // will be applied next time an instance is created
    const provider = this.sandboxRegistry.get(environment.providerType);
    await provider.setNetworkEnabled(handle, enabled);
  }
}

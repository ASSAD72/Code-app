import path from 'path';
import { ToolCallRequest, ToolCallResult, ToolExecutionContext, PolicyContext, SandboxProviderType } from '@core/types';
import { ToolRegistry } from './ToolRegistry';
import { PolicyEngine } from '../policy/PolicyEngine';
import { ProjectManager } from '../core/project/ProjectManager';
import { EnvironmentManager } from '../environments/EnvironmentManager';
import { ProcessManager } from '../core/process/ProcessManager';

export class ToolExecutor {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly policyEngine: PolicyEngine,
    private readonly projectManager?: ProjectManager,
    private readonly environmentManager?: EnvironmentManager,
    private readonly processManager?: ProcessManager
  ) {}

  async dispatch(request: ToolCallRequest, context: ToolExecutionContext, projectNetworkPermission: boolean, targetPath?: string): Promise<ToolCallResult> {
    const startTime = Date.now();
    const tool = this.toolRegistry.get(request.toolName);
    if (!tool) return { requestId: request.requestId, toolName: request.toolName, success: false, error: `Unknown tool "${request.toolName}"`, durationMs: 0 };

    const input = { ...request.input };
    const projectId = context.projectId ?? (typeof input.projectId === 'string' ? input.projectId : undefined);
    let workspaceRoot = context.workspaceRoot;
    let sandboxProviderType: SandboxProviderType | undefined = context.sandboxProviderType;
    let effectiveNetworkPermission = projectNetworkPermission;

    if (projectId && this.projectManager) {
      const project = this.projectManager.get(projectId);
      if (!project) return this.failure(request, `Project ${projectId} not found`, startTime);
      workspaceRoot = project.sourcePath;
      effectiveNetworkPermission = project.networkPermission;
      if (this.environmentManager) {
        const environment = this.environmentManager.get(project.environmentId);
        if (!environment) return this.failure(request, `Environment ${project.environmentId} not found`, startTime);
        sandboxProviderType = environment.providerType;
        if (context.requestedByAI && sandboxProviderType === 'process' && tool.requiresSandbox) {
          return this.failure(request, 'AI sandbox execution is blocked when only the host ProcessProvider is available.', startTime);
        }
      }
    }

    if (context.requestedByAI && typeof input.outputDir === 'string') {
      if (!workspaceRoot || !isInsideWorkspace(path.resolve(workspaceRoot, input.outputDir), workspaceRoot)) {
        return this.failure(request, 'AI-originated exports may only write output inside the project workspace.', startTime);
      }
      input.outputDir = path.resolve(workspaceRoot, input.outputDir);
    }

    const rawPath = targetPath ?? extractToolPath(input) ?? (typeof input.outputDir === 'string' ? input.outputDir : undefined);
    let effectiveTargetPath: string | undefined;
    if (rawPath) {
      if (!workspaceRoot) return this.failure(request, 'A workspace root is required for path-scoped tool execution.', startTime);
      const root = workspaceRoot;
      const resolvedTargetPath = path.resolve(root, rawPath);
      effectiveTargetPath = resolvedTargetPath;
      if (!isInsideWorkspace(resolvedTargetPath, root)) {
        return this.failure(request, 'Tool path escapes the project workspace.', startTime);
      }
      const pathKey = 'path' in input ? 'path' : 'artifactPath' in input ? 'artifactPath' : undefined;
      if (pathKey) input[pathKey] = effectiveTargetPath;
    }

    const policyContext: PolicyContext = {
      toolName: request.toolName,
      destructive: tool.destructive,
      requiresNetwork: tool.requiresNetwork,
      projectNetworkPermission: effectiveNetworkPermission,
      requestedByAI: context.requestedByAI,
      targetPath: targetPath ?? effectiveTargetPath,
      workspaceRoot,
      sandboxProviderType,
    };
    const decision = this.policyEngine.evaluate(policyContext);
    if (!decision.allowed) return this.failure(request, `Blocked by policy: ${decision.reason}${decision.requiresUserConfirmation ? ' (requires explicit user confirmation)' : ''}`, startTime);

    if (tool.requiresSandbox && projectId && this.projectManager && this.environmentManager && this.processManager) {
      const project = this.projectManager.get(projectId);
      const environment = project ? this.environmentManager.get(project.environmentId) : null;
      if (!project || !environment) return this.failure(request, 'Sandbox context could not be resolved after policy approval.', startTime);
      await this.processManager.ensureInstance(project, environment);
    }

    try {
      const output = await this.toolRegistry.execute({ ...request, input }, { ...context, projectId, workspaceRoot, sandboxProviderType });
      return { ...output, durationMs: Date.now() - startTime };
    } catch (err) {
      return this.failure(request, err instanceof Error ? err.message : String(err), startTime);
    }
  }

  confirmPendingDestructiveAction(toolName: string, targetPath?: string): void {
    this.policyEngine.confirmDestructive({ toolName, destructive: true, requiresNetwork: false, projectNetworkPermission: false, requestedByAI: false, targetPath });
  }

  private failure(request: ToolCallRequest, error: string, startTime: number): ToolCallResult {
    return { requestId: request.requestId, toolName: request.toolName, success: false, error, durationMs: Date.now() - startTime };
  }
}

function extractToolPath(input: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'artifactPath']) {
    const value = input[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function isInsideWorkspace(target: string, workspaceRoot: string): boolean {
  const root = path.resolve(workspaceRoot);
  const relative = path.relative(root, path.resolve(target));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

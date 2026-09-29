import { ToolDefinition } from '@core/types';
import { ProjectManager } from '../../core/project/ProjectManager';
import { JobManager } from '../../core/job/JobManager';
import { BuildEngine } from '../../core/build/BuildEngine';
import { TestEngine } from '../../core/test/TestEngine';
import { ProcessManager } from '../../core/process/ProcessManager';
import { EnvironmentManager } from '../../environments/EnvironmentManager';
import { SnapshotManager } from '../../core/snapshot/SnapshotManager';
import { SandboxProviderRegistry } from '../../sandbox/SandboxProviderRegistry';
import { AndroidRuntimeProvider } from '../../environments/android/AndroidRuntimeProvider';

/**
 * Core tool set — spec section 18's full catalog:
 *   process.run, project.create, project.build, project.test, project.run,
 *   sandbox.create, sandbox.destroy, environment.create, environment.install,
 *   environment.export, snapshot.create, snapshot.restore, package.install,
 *   artifact.export, emulator.start, emulator.stop
 *
 * These are thin, structured wrappers around the real Core engines built
 * earlier — the tool layer's job is purely to expose them to the AI
 * planner and CLI/GUI through one structured, schema-validated, policy-gated
 * surface, never to duplicate logic.
 */
export function buildCoreTools(deps: {
  projectManager: ProjectManager;
  jobManager: JobManager;
  buildEngine: BuildEngine;
  testEngine: TestEngine;
  processManager: ProcessManager;
  environmentManager: EnvironmentManager;
  snapshotManager: SnapshotManager;
  sandboxRegistry: SandboxProviderRegistry;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): ToolDefinition<any, any>[] {
  const processRunTool: ToolDefinition<{ projectId: string; command: string[] }, { exitCode: number; stdout: string; stderr: string }> = {
    name: 'process.run',
    description: 'Run an arbitrary command inside a project\'s sandbox instance.',
    requiresSandbox: true,
    requiresNetwork: false,
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        command: { type: 'array', description: 'Executable and arguments.', items: { type: 'string' } },
      },
      required: ['projectId', 'command'],
    },
    handler: async (input) => {
      const project = deps.projectManager.get(input.projectId);
      if (!project) throw new Error(`Project ${input.projectId} not found`);
      const environment = deps.environmentManager.get(project.environmentId);
      if (!environment) throw new Error(`Environment ${project.environmentId} not found`);
      const result = await deps.processManager.exec(project, environment, input.command as unknown as string[]);
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
  };

  const projectBuildTool: ToolDefinition<{ projectId: string }, { success: boolean; exitCode: number }> = {
    name: 'project.build',
    description: 'Build a project using its configured build command.',
    requiresSandbox: true,
    requiresNetwork: false,
    destructive: false,
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] },
    handler: async (input) => {
      const project = deps.projectManager.get(input.projectId);
      if (!project) throw new Error(`Project ${input.projectId} not found`);
      const environment = deps.environmentManager.get(project.environmentId);
      if (!environment) throw new Error(`Environment ${project.environmentId} not found`);
      const result = await deps.buildEngine.build(project, environment);
      return { success: result.success, exitCode: result.exitCode };
    },
  };

  const projectTestTool: ToolDefinition<{ projectId: string }, { success: boolean; passed?: number; failed?: number }> = {
    name: 'project.test',
    description: 'Run a project\'s test suite using its configured test command.',
    requiresSandbox: true,
    requiresNetwork: false,
    destructive: false,
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] },
    handler: async (input) => {
      const project = deps.projectManager.get(input.projectId);
      if (!project) throw new Error(`Project ${input.projectId} not found`);
      const environment = deps.environmentManager.get(project.environmentId);
      if (!environment) throw new Error(`Environment ${project.environmentId} not found`);
      const result = await deps.testEngine.test(project, environment);
      return { success: result.success, passed: result.passed, failed: result.failed };
    },
  };

  const projectRunTool: ToolDefinition<{ projectId: string }, { exitCode: number; stdout: string }> = {
    name: 'project.run',
    description: 'Run a project using its configured run command.',
    requiresSandbox: true,
    requiresNetwork: false,
    destructive: false,
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] },
    handler: async (input) => {
      const project = deps.projectManager.get(input.projectId);
      if (!project) throw new Error(`Project ${input.projectId} not found`);
      if (!project.commands.runCommand) throw new Error(`Project ${project.name} has no run command configured.`);
      const environment = deps.environmentManager.get(project.environmentId);
      if (!environment) throw new Error(`Environment ${project.environmentId} not found`);
      const commandParts = project.commands.runCommand.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [project.commands.runCommand];
      const result = await deps.processManager.exec(project, environment, commandParts);
      return { exitCode: result.exitCode, stdout: result.stdout };
    },
  };

  const sandboxDestroyTool: ToolDefinition<{ projectId: string }, { destroyed: boolean }> = {
    name: 'sandbox.destroy',
    description: 'Tear down the active sandbox instance for a project, releasing its resources.',
    requiresSandbox: false,
    requiresNetwork: false,
    destructive: true,
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] },
    handler: async (input) => {
      const project = deps.projectManager.get(input.projectId);
      if (!project) throw new Error(`Project ${input.projectId} not found`);
      const environment = deps.environmentManager.get(project.environmentId);
      if (!environment) throw new Error(`Environment ${project.environmentId} not found`);
      await deps.processManager.teardown(project, environment);
      return { destroyed: true };
    },
  };

  const environmentInstallTool: ToolDefinition<{ environmentId: string; projectId: string; packageName: string; command: string }, { exitCode: number; output: string }> = {
    name: 'environment.install',
    description: 'Install a package/dependency inside a project\'s environment.',
    requiresSandbox: true,
    requiresNetwork: true,
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: {
        environmentId: { type: 'string' },
        projectId: { type: 'string' },
        packageName: { type: 'string' },
        command: { type: 'string', description: 'Full install command, e.g. "pip install requests".' },
      },
      required: ['environmentId', 'projectId', 'packageName', 'command'],
    },
    handler: async (input) => {
      const project = deps.projectManager.get(input.projectId);
      if (!project) throw new Error(`Project ${input.projectId} not found`);
      if (project.environmentId !== input.environmentId) throw new Error('environmentId does not belong to the selected project.');
      const environment = deps.environmentManager.get(input.environmentId);
      if (!environment) throw new Error(`Environment ${input.environmentId} not found`);
      const commandParts = splitInstallCommand(input.command, input.packageName);
      const result = await deps.processManager.exec(project, environment, commandParts);
      return { exitCode: result.exitCode, output: result.stdout + result.stderr };
    },
  };

  const environmentExportTool: ToolDefinition<{ environmentId: string; outputDir: string }, { archivePath: string }> = {
    name: 'environment.export',
    description: 'Export an environment as a portable archive.',
    requiresSandbox: false,
    requiresNetwork: false,
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: { environmentId: { type: 'string' }, outputDir: { type: 'string' } },
      required: ['environmentId', 'outputDir'],
    },
    handler: async (input) => {
      const archivePath = await deps.environmentManager.exportEnvironment(input.environmentId, input.outputDir);
      return { archivePath };
    },
  };

  const snapshotCreateTool: ToolDefinition<{ projectId: string; label: string }, { snapshotId: string }> = {
    name: 'snapshot.create',
    description: 'Create a snapshot of the current project state.',
    requiresSandbox: false,
    requiresNetwork: false,
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, label: { type: 'string' } },
      required: ['projectId', 'label'],
    },
    handler: async (input) => {
      const project = deps.projectManager.get(input.projectId);
      if (!project) throw new Error(`Project ${input.projectId} not found`);
      const snapshot = await deps.snapshotManager.createSnapshot(project, input.label);
      return { snapshotId: snapshot.id };
    },
  };

  const snapshotRestoreTool: ToolDefinition<{ projectId: string; snapshotId: string }, { restored: boolean }> = {
    name: 'snapshot.restore',
    description: 'Restore a project to a previous snapshot. This overwrites current uncommitted state.',
    requiresSandbox: false,
    requiresNetwork: false,
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, snapshotId: { type: 'string' } },
      required: ['projectId', 'snapshotId'],
    },
    handler: async (input) => {
      const project = deps.projectManager.get(input.projectId);
      if (!project) throw new Error(`Project ${input.projectId} not found`);
      await deps.snapshotManager.restore(project, input.snapshotId);
      return { restored: true };
    },
  };

  const packageInstallTool: ToolDefinition<{ projectId: string; installCommand: string }, { exitCode: number; output: string }> = {
    name: 'package.install',
    description: 'Install a dependency/package inside a project\'s sandbox using the given install command.',
    requiresSandbox: true,
    requiresNetwork: true,
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, installCommand: { type: 'string' } },
      required: ['projectId', 'installCommand'],
    },
    handler: async (input) => {
      const project = deps.projectManager.get(input.projectId);
      if (!project) throw new Error(`Project ${input.projectId} not found`);
      const environment = deps.environmentManager.get(project.environmentId);
      if (!environment) throw new Error(`Environment ${project.environmentId} not found`);
      const commandParts = splitSafeInstallCommand(input.installCommand);
      const result = await deps.processManager.exec(project, environment, commandParts);
      return { exitCode: result.exitCode, output: result.stdout + result.stderr };
    },
  };

  const artifactExportTool: ToolDefinition<{ projectId: string; artifactPath: string; outputDir: string }, { exportedPath: string }> = {
    name: 'artifact.export',
    description: 'Copy a built artifact (binary, APK, bundle) out of the project workspace to an output directory.',
    requiresSandbox: false,
    requiresNetwork: false,
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        artifactPath: { type: 'string', description: 'Path to the artifact relative to the project workspace.' },
        outputDir: { type: 'string' },
      },
      required: ['projectId', 'artifactPath', 'outputDir'],
    },
    handler: async (input) => {
      const project = deps.projectManager.get(input.projectId);
      if (!project) throw new Error(`Project ${input.projectId} not found`);
      const { promises: fs } = await import('fs');
      const path = await import('path');
      const sourcePath = path.isAbsolute(input.artifactPath) ? input.artifactPath : path.resolve(project.sourcePath, input.artifactPath);
      await fs.mkdir(input.outputDir, { recursive: true });
      const destPath = path.join(input.outputDir, path.basename(input.artifactPath));
      await fs.copyFile(sourcePath, destPath);
      return { exportedPath: destPath };
    },
  };

  const emulatorStartTool: ToolDefinition<{ avdName: string; headless?: boolean }, { started: boolean }> = {
    name: 'emulator.start',
    description: 'Start an Android emulator by AVD name.',
    requiresSandbox: false,
    requiresNetwork: false,
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: { avdName: { type: 'string' }, headless: { type: 'boolean' } },
      required: ['avdName'],
    },
    handler: async (input) => {
      const runtime = new AndroidRuntimeProvider(deps.sandboxRegistry.get('wsl2'));
      await runtime.ensureAvd(input.avdName);
      await runtime.startEmulator(input.avdName, input.headless ?? true);
      return { started: true };
    },
  };

  const emulatorStopTool: ToolDefinition<Record<string, unknown>, { stopped: boolean }> = {
    name: 'emulator.stop',
    description: 'Stop the currently running Android emulator.',
    requiresSandbox: false,
    requiresNetwork: false,
    destructive: false,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const runtime = new AndroidRuntimeProvider(deps.sandboxRegistry.get('wsl2'));
      await runtime.stopEmulator();
      return { stopped: true };
    },
  };

  return [
    processRunTool,
    projectBuildTool,
    projectTestTool,
    projectRunTool,
    sandboxDestroyTool,
    environmentInstallTool,
    environmentExportTool,
    snapshotCreateTool,
    snapshotRestoreTool,
    packageInstallTool,
    artifactExportTool,
    emulatorStartTool,
    emulatorStopTool,
  ];
}


function splitInstallCommand(command: string, packageName: string): string[] {
  if (!packageName || packageName.startsWith('-') || /[;&|`$<>\\]/.test(packageName)) throw new Error('Invalid package name.');
  if (/[;&|`$<>]/.test(command)) throw new Error('Install command may not contain shell operators.');
  const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  if (parts.length < 2) throw new Error('Invalid install command.');
  const allowed = new Set(['npm','pnpm','yarn','pip','pip3','cargo','go','dotnet','composer','gradle','mvn','flutter','dart']);
  const executable = parts[0]?.split(/[\\/]/).pop() ?? '';
  if (!allowed.has(executable)) throw new Error(`Package manager "${executable}" is not allowed for environment.install.`);
  if (!parts.some((part) => part.replace(/^"|"$/g, '') === packageName)) throw new Error('Install command must explicitly contain packageName.');
  return parts;
}


function splitSafeInstallCommand(command: string): string[] {
  if (!command.trim()) throw new Error('Install command cannot be empty.');
  if (/[;&|`$<>\n\r]/.test(command)) throw new Error('Install command contains shell operators.');
  const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((p) => p.replace(/^"|"$/g, '')) ?? [];
  const allowed = new Set(['npm','pnpm','yarn','pip','pip3','cargo','go','dotnet','composer','gradle','mvn','flutter','dart']);
  if (parts.length < 2 || !allowed.has(parts[0].split(/[\\/]/).pop() ?? '')) throw new Error('Invalid package manager command.');
  if (!parts.slice(1).some((x) => !x.startsWith('-'))) throw new Error('Install command must specify a package/dependency target.');
  return parts;
}

import { describe, it, expect, vi } from 'vitest';
import { RepairEngine } from '../../src/core/repair/RepairEngine';
import { LocalModelProvider } from '@intelligence/LocalModelProvider';
import {
  ProjectManifest,
  EnvironmentManifest,
  BuildResult,
  TestResult,
  ErrorAnalysis,
  Patch,
  LocalModelInfo,
} from '@core/types';

/**
 * RepairEngine's collaborators (BuildEngine, TestEngine, SnapshotManager,
 * ProjectManager, the repository) are legitimately expensive to construct
 * for real (they need a real sandbox + real git + real SQLite). Per the
 * spec's own carve-out ("mocks are acceptable in unit tests where a real
 * service is unavailable"), we fake those collaborators here with
 * minimal, behavior-preserving stand-ins, while testing RepairEngine's
 * OWN control-flow logic — the actual code under test — for real.
 */
describe('RepairEngine', () => {
  const project: ProjectManifest = {
    id: 'proj-1',
    name: 'test-project',
    type: 'node',
    environmentId: 'env-1',
    environmentVersion: '1.0.0',
    sourcePath: '/tmp/test-project',
    dependencies: [],
    commands: { buildCommand: 'npm run build', testCommand: 'npm test' },
    exportConfiguration: { sourceExportEnabled: true, nativeExportTargets: [], environmentExportEnabled: true },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    networkPermission: false,
  };

  const environment: EnvironmentManifest = {
    environmentId: 'env-1',
    name: 'node-env',
    version: '1.0.0',
    packId: 'codex-pack-node',
    baseImage: 'codex-node:20',
    os: 'linux',
    architecture: 'x64',
    installedRuntimes: [],
    sdkVersions: {},
    packageManagers: [],
    environmentVariables: {},
    requiredResources: {},
    capabilities: [],
    networkEnabledByDefault: false,
    checksum: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    providerType: 'process',
  };

  function buildResult(success: boolean): BuildResult {
    return { success, jobId: 'job-1', exitCode: success ? 0 : 1, stdout: '', stderr: success ? '' : 'SyntaxError: bad', durationMs: 10, timedOut: false };
  }

  function testResult(success: boolean): TestResult {
    return { success, jobId: 'job-2', exitCode: success ? 0 : 1, stdout: '', stderr: success ? '' : 'AssertionError: failed', durationMs: 10, timedOut: false };
  }

  class NeverAvailableModel implements LocalModelProvider {
    async getInfo(): Promise<LocalModelInfo> {
      return { provider: 'none', available: false };
    }
    async generatePlan() {
      return null;
    }
    async generateToolCalls() {
      return [];
    }
    async analyzeBuildError(): Promise<ErrorAnalysis | null> {
      return null;
    }
    async generatePatch(): Promise<Patch | null> {
      return null;
    }
  }

  class AlwaysFixesModel implements LocalModelProvider {
    async getInfo(): Promise<LocalModelInfo> {
      return { provider: 'ollama', available: true, modelName: 'test' };
    }
    async generatePlan() {
      return null;
    }
    async generateToolCalls() {
      return [];
    }
    async analyzeBuildError(rawOutput: string): Promise<ErrorAnalysis> {
      return { errorSignature: rawOutput.slice(0, 20), category: 'syntax', message: rawOutput, rawOutput };
    }
    async generatePatch(analysis: ErrorAnalysis): Promise<Patch> {
      return {
        id: 'patch-1',
        errorSignature: analysis.errorSignature,
        files: [],
        description: 'Fixed it',
        createdAt: new Date().toISOString(),
        appliedByJobId: '',
      };
    }
  }

  function buildFakeCollaborators(buildOutcomes: boolean[], testOutcomes: boolean[]) {
    let buildCallIndex = 0;
    let testCallIndex = 0;

    const buildEngine = { build: vi.fn(async () => buildResult(buildOutcomes[buildCallIndex++] ?? true)) };
    const testEngine = { test: vi.fn(async () => testResult(testOutcomes[testCallIndex++] ?? true)) };
    const snapshotManager = {
      createSnapshot: vi.fn(async () => ({ id: 'snap-1', projectId: project.id, label: 'x', createdAt: new Date().toISOString(), reason: 'manual' as const })),
      restore: vi.fn(async () => undefined),
    };
    const memory = {
      projectId: project.id,
      architectureDecisions: [],
      importantFiles: [],
      knownErrors: [] as { signature: string; description: string; firstSeen: string }[],
      fixes: [] as { errorSignature: string; description: string; patchSummary: string; appliedAt: string }[],
      dependenciesNotes: [],
      environmentNotes: [],
      previousSuccessfulBuilds: [] as { jobId: string; timestamp: string }[],
    };
    const projectManager = {
      getMemory: vi.fn(() => memory),
      updateMemory: vi.fn((updated: typeof memory) => Object.assign(memory, updated)),
    };
    const repairSessionRepository = { upsert: vi.fn(), get: vi.fn(), listByProject: vi.fn(() => []) };

    return { buildEngine, testEngine, snapshotManager, projectManager, repairSessionRepository, memory };
  }

  it('succeeds immediately when build and tests pass on the first attempt', async () => {
    const fakes = buildFakeCollaborators([true], [true]);
    const engine = new RepairEngine(
      fakes.buildEngine as any,
      fakes.testEngine as any,
      fakes.snapshotManager as any,
      fakes.projectManager as any,
      fakes.repairSessionRepository as any,
      new NeverAvailableModel(),
      8
    );

    const session = await engine.runRepairLoop(project, environment);
    expect(session.status).toBe('success');
    expect(session.attempts).toHaveLength(1);
    expect(session.attempts[0].outcome).toBe('success');
  });

  it('stops after a build failure when no local model is available to propose a patch', async () => {
    const fakes = buildFakeCollaborators([false, false, false], []);
    const engine = new RepairEngine(
      fakes.buildEngine as any,
      fakes.testEngine as any,
      fakes.snapshotManager as any,
      fakes.projectManager as any,
      fakes.repairSessionRepository as any,
      new NeverAvailableModel(),
      8
    );

    const session = await engine.runRepairLoop(project, environment);
    expect(session.status).toBe('exhausted');
    expect(session.attempts).toHaveLength(1); // stops immediately, no model to patch with
    expect(fakes.buildEngine.build).toHaveBeenCalledTimes(1);
  });

  it('retries with a patch when a local model is available, eventually succeeding', async () => {
    const fakes = buildFakeCollaborators([false, true], [true]);
    const engine = new RepairEngine(
      fakes.buildEngine as any,
      fakes.testEngine as any,
      fakes.snapshotManager as any,
      fakes.projectManager as any,
      fakes.repairSessionRepository as any,
      new AlwaysFixesModel(),
      8
    );

    const session = await engine.runRepairLoop(project, environment);
    expect(session.status).toBe('success');
    expect(session.attempts).toHaveLength(2);
    expect(session.attempts[0].outcome).toBe('patch-applied');
    expect(session.attempts[1].outcome).toBe('success');
    expect(fakes.buildEngine.build).toHaveBeenCalledTimes(2);
  });

  it('never exceeds maxRetries even if the model keeps proposing patches that do not fix the build', async () => {
    const fakes = buildFakeCollaborators([false, false, false, false, false], []);
    const engine = new RepairEngine(
      fakes.buildEngine as any,
      fakes.testEngine as any,
      fakes.snapshotManager as any,
      fakes.projectManager as any,
      fakes.repairSessionRepository as any,
      new AlwaysFixesModel(),
      3 // maxRetries
    );

    const session = await engine.runRepairLoop(project, environment, { maxRetries: 3 });
    expect(session.status).toBe('exhausted');
    expect(session.attempts.length).toBeLessThanOrEqual(3);
    expect(fakes.buildEngine.build.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('creates a pre-repair snapshot before any attempt', async () => {
    const fakes = buildFakeCollaborators([true], [true]);
    const engine = new RepairEngine(
      fakes.buildEngine as any,
      fakes.testEngine as any,
      fakes.snapshotManager as any,
      fakes.projectManager as any,
      fakes.repairSessionRepository as any,
      new NeverAvailableModel(),
      8
    );

    const session = await engine.runRepairLoop(project, environment);
    expect(fakes.snapshotManager.createSnapshot).toHaveBeenCalledWith(project, 'Before repair cycle', 'pre-repair-cycle');
    expect(session.preRepairSnapshotId).toBe('snap-1');
  });

  it('records known errors and fixes into project memory', async () => {
    const fakes = buildFakeCollaborators([false, true], [true]);
    const engine = new RepairEngine(
      fakes.buildEngine as any,
      fakes.testEngine as any,
      fakes.snapshotManager as any,
      fakes.projectManager as any,
      fakes.repairSessionRepository as any,
      new AlwaysFixesModel(),
      8
    );

    await engine.runRepairLoop(project, environment);
    expect(fakes.memory.knownErrors.length).toBeGreaterThan(0);
    expect(fakes.memory.fixes.length).toBeGreaterThan(0);
    expect(fakes.memory.previousSuccessfulBuilds.length).toBe(1);
  });
});

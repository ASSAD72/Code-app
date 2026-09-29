import { randomUUID } from 'crypto';
import path from 'path';
import {
  ProjectManifest,
  EnvironmentManifest,
  RepairSession,
  RepairAttempt,
  ErrorAnalysis,
  Patch,
} from '@core/types';
import { BuildEngine } from '../build/BuildEngine';
import { TestEngine } from '../test/TestEngine';
import { SnapshotManager } from '../snapshot/SnapshotManager';
import { ProjectManager } from '../project/ProjectManager';
import { RepairSessionRepository } from '@storage/repositories';
import { LocalModelProvider } from '../../intelligence/LocalModelProvider';

/**
 * RepairEngine — spec section 9, the self-healing build loop:
 *
 *   PLAN -> EXECUTE -> BUILD -> TEST -> ANALYZE ERROR -> PATCH -> BUILD -> TEST
 *
 * with max retries, timeout, error history, patch history, and rollback.
 * This is deliberately NOT allowed to loop forever (spec: "do not allow
 * an infinite loop"), and it snapshots the project BEFORE any patch is
 * applied so every attempt is reversible (spec section 13: "before
 * dangerous operations or large patches, create a snapshot").
 *
 * The AI's role here is strictly advisory (spec section 2/19): analyzeError
 * and generatePatch below call into LocalModelProvider to get a *proposed*
 * diagnosis and patch, but RepairEngine is the one that decides whether to
 * apply it, snapshots first, and re-verifies via a real build/test cycle
 * afterward. If no local model is available, RepairEngine still functions
 * for the "keep every attempt, allow manual intervention between retries"
 * parts of the loop — it simply can't auto-generate patches, and reports
 * that plainly rather than silently doing nothing.
 */
export class RepairEngine {
  constructor(
    private readonly buildEngine: BuildEngine,
    private readonly testEngine: TestEngine,
    private readonly snapshotManager: SnapshotManager,
    private readonly projectManager: ProjectManager,
    private readonly repairSessionRepository: RepairSessionRepository,
    private readonly localModelProvider: LocalModelProvider,
    private readonly maxRetriesDefault = 8
  ) {}

  async runRepairLoop(
    project: ProjectManifest,
    environment: EnvironmentManifest,
    options?: { maxRetries?: number; runTests?: boolean; onAttempt?: (attempt: RepairAttempt) => void }
  ): Promise<RepairSession> {
    const maxRetries = options?.maxRetries ?? this.maxRetriesDefault;
    const runTests = options?.runTests ?? true;

    const preRepairSnapshot = await this.snapshotManager.createSnapshot(
      project,
      'Before repair cycle',
      'pre-repair-cycle'
    );

    const session: RepairSession = {
      id: randomUUID(),
      projectId: project.id,
      jobId: '', // set below once first build job is created
      maxRetries,
      attempts: [],
      status: 'running',
      preRepairSnapshotId: preRepairSnapshot.id,
      startedAt: new Date().toISOString(),
    };
    this.repairSessionRepository.upsert(session);

    for (let attemptNumber = 1; attemptNumber <= maxRetries; attemptNumber++) {
      const attempt: RepairAttempt = {
        attemptNumber,
        timestamp: new Date().toISOString(),
        outcome: 'aborted',
      };

      try {
        const buildResult = await this.buildEngine.build(project, environment);
        attempt.buildResult = buildResult;
        session.jobId = session.jobId || buildResult.jobId;

        if (!buildResult.success) {
          attempt.outcome = 'build-failed';
          const analysis = await this.analyzeError(buildResult.stderr || buildResult.stdout, project);
          attempt.errorAnalysis = analysis;
          this.recordKnownError(project, analysis);

          const patch = await this.generateAndApplyPatch(project, analysis);
          if (patch) {
            attempt.patch = patch;
            attempt.outcome = 'patch-applied';
          } else {
            session.attempts.push(attempt);
            options?.onAttempt?.(attempt);
            session.status = 'exhausted';
            session.finishedAt = new Date().toISOString();
            this.repairSessionRepository.upsert(session);
            return session;
          }

          session.attempts.push(attempt);
          options?.onAttempt?.(attempt);
          continue;
        }

        if (runTests && project.commands.testCommand) {
          const testResult = await this.testEngine.test(project, environment);
          attempt.testResult = testResult;

          if (!testResult.success) {
            attempt.outcome = 'test-failed';
            const analysis = await this.analyzeError(testResult.stderr || testResult.stdout, project);
            attempt.errorAnalysis = analysis;
            this.recordKnownError(project, analysis);

            const patch = await this.generateAndApplyPatch(project, analysis);
            if (patch) {
              attempt.patch = patch;
            } else {
              session.attempts.push(attempt);
              options?.onAttempt?.(attempt);
              session.status = 'exhausted';
              session.finishedAt = new Date().toISOString();
              this.repairSessionRepository.upsert(session);
              return session;
            }

            session.attempts.push(attempt);
            options?.onAttempt?.(attempt);
            continue;
          }
        }

        attempt.outcome = 'success';
        session.attempts.push(attempt);
        options?.onAttempt?.(attempt);
        session.status = 'success';
        session.finishedAt = new Date().toISOString();
        this.recordSuccessfulBuild(project, session.jobId);
        this.repairSessionRepository.upsert(session);
        return session;
      } catch (err) {
        attempt.outcome = 'aborted';
        session.attempts.push(attempt);
        options?.onAttempt?.(attempt);
        session.status = 'exhausted';
        session.finishedAt = new Date().toISOString();
        this.repairSessionRepository.upsert(session);
        throw err;
      } finally {
        this.repairSessionRepository.upsert(session);
      }
    }

    session.status = 'exhausted';
    session.finishedAt = new Date().toISOString();
    this.repairSessionRepository.upsert(session);
    return session;
  }

  async rollbackToPreRepairState(project: ProjectManifest, session: RepairSession): Promise<void> {
    if (!session.preRepairSnapshotId) {
      throw new Error(`Repair session ${session.id} has no pre-repair snapshot to roll back to.`);
    }
    await this.snapshotManager.restore(project, session.preRepairSnapshotId);
  }

  getSession(sessionId: string): RepairSession | null {
    return this.repairSessionRepository.get(sessionId);
  }

  listSessionsForProject(projectId: string): RepairSession[] {
    return this.repairSessionRepository.listByProject(projectId);
  }

  private async analyzeError(rawOutput: string, project: ProjectManifest): Promise<ErrorAnalysis> {
    const modelAnalysis = await this.localModelProvider.analyzeBuildError(rawOutput, {
      projectType: project.type,
    });
    if (modelAnalysis) return modelAnalysis;
    return heuristicErrorAnalysis(rawOutput);
  }

  private async generateAndApplyPatch(project: ProjectManifest, analysis: ErrorAnalysis): Promise<Patch | null> {
    const proposedPatch = await this.localModelProvider.generatePatch(analysis, { projectSourcePath: project.sourcePath });
    if (!proposedPatch) return null;

    await this.snapshotManager.createSnapshot(project, `Before patch: ${proposedPatch.description}`, 'pre-patch');

    await this.applyPatchToFiles(proposedPatch, project);
    this.recordFix(project, analysis, proposedPatch);
    return proposedPatch;
  }

  private async applyPatchToFiles(patch: Patch, project?: ProjectManifest): Promise<void> {
    const { promises: fs } = await import('fs');
    if (!project) throw new Error('Project context is required to apply a repair patch.');
    const workspace = path.resolve(project.sourcePath);
    for (const fileChange of patch.files) {
      // Patches are expressed as full replacement content in `diff` for
      // this implementation (a true unified-diff applier is a reasonable
      // future enhancement); LocalModelProvider always returns full file
      // content per changed file, never a diff format, which keeps this
      // application step unambiguous and safe.
      const rootReal = await fs.realpath(workspace);
      const target = path.resolve(rootReal, fileChange.path);
      if (!inside(rootReal, target)) throw new Error(`Repair patch path escapes project workspace: ${fileChange.path}`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const parentReal = await fs.realpath(path.dirname(target));
      if (!inside(rootReal, parentReal)) throw new Error(`Repair patch parent escapes project workspace: ${fileChange.path}`);
      const existing = await fs.lstat(target).catch(() => null);
      if (existing?.isSymbolicLink()) throw new Error(`Repair patch refuses symbolic-link target: ${fileChange.path}`);
      await fs.writeFile(target, fileChange.diff, 'utf-8');
    }
  }

  private recordKnownError(project: ProjectManifest, analysis: ErrorAnalysis): void {
    const memory = this.projectManager.getMemory(project.id);
    if (!memory) return;
    const alreadyKnown = memory.knownErrors.some((e) => e.signature === analysis.errorSignature);
    if (!alreadyKnown) {
      memory.knownErrors.push({
        signature: analysis.errorSignature,
        description: analysis.message,
        firstSeen: new Date().toISOString(),
      });
      this.projectManager.updateMemory(memory);
    }
  }

  private recordFix(project: ProjectManifest, analysis: ErrorAnalysis, patch: Patch): void {
    const memory = this.projectManager.getMemory(project.id);
    if (!memory) return;
    memory.fixes.push({
      errorSignature: analysis.errorSignature,
      description: analysis.message,
      patchSummary: patch.description,
      appliedAt: new Date().toISOString(),
    });
    this.projectManager.updateMemory(memory);
  }

  private recordSuccessfulBuild(project: ProjectManifest, jobId: string): void {
    const memory = this.projectManager.getMemory(project.id);
    if (!memory) return;
    memory.previousSuccessfulBuilds.push({ jobId, timestamp: new Date().toISOString() });
    this.projectManager.updateMemory(memory);
  }
}

function heuristicErrorAnalysis(rawOutput: string): ErrorAnalysis {
  const signature = rawOutput.slice(0, 200).replace(/\s+/g, ' ').trim();
  let category: ErrorAnalysis['category'] = 'unknown';

  if (/SyntaxError|ParseError|unexpected token/i.test(rawOutput)) category = 'syntax';
  else if (/Cannot find module|ModuleNotFoundError|No module named|package .* not found/i.test(rawOutput))
    category = 'dependency';
  else if (/TypeError|type mismatch|incompatible types/i.test(rawOutput)) category = 'type';
  else if (/AssertionError|test.*failed|FAILED/i.test(rawOutput)) category = 'test-failure';
  else if (/permission denied|ENOENT|network|ECONNREFUSED/i.test(rawOutput)) category = 'environment';
  else if (/panic|segmentation fault|exception/i.test(rawOutput)) category = 'runtime';

  const fileLineMatch = /([\w./\\-]+\.\w+):(\d+)/.exec(rawOutput);

  return {
    errorSignature: signature,
    category,
    file: fileLineMatch?.[1],
    line: fileLineMatch?.[2] ? parseInt(fileLineMatch[2], 10) : undefined,
    message: signature,
    rawOutput,
  };
}


function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

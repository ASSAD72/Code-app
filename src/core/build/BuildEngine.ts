import { ProjectManifest, EnvironmentManifest, BuildResult, JobLogLine } from '@core/types';
import { JobManager } from '../job/JobManager';
import { ProcessManager } from '../process/ProcessManager';
import { PolicyEngine } from '../../policy/PolicyEngine';

/**
 * BuildEngine — spec section 9's BUILD step, and the "Build" surface in
 * spec section 28's MVP list. Executes the project's configured build
 * command inside its sandbox instance via ProcessManager, streaming logs
 * into the owning Job as they arrive.
 */
export class BuildEngine {
  constructor(
    private readonly jobManager: JobManager,
    private readonly processManager: ProcessManager,
    private readonly policyEngine: PolicyEngine
  ) {}

  async build(project: ProjectManifest, environment: EnvironmentManifest, maxRetries = 0): Promise<BuildResult> {
    if (!project.commands.buildCommand) {
      throw new Error(`Project "${project.name}" has no build command configured.`);
    }

    const job = this.jobManager.create({
      kind: 'build',
      title: `Build: ${project.name}`,
      projectId: project.id,
      environmentId: environment.environmentId,
      maxRetries,
    });

    const policyDecision = this.policyEngine.evaluate({
      toolName: 'project.build',
      destructive: false,
      requiresNetwork: environment.networkEnabledByDefault,
      projectNetworkPermission: project.networkPermission,
      requestedByAI: false,
    });
    if (!policyDecision.allowed) {
      throw new Error(`Build blocked by policy: ${policyDecision.reason}`);
    }

    let result: BuildResult = {
      success: false,
      jobId: job.id,
      exitCode: -1,
      stdout: '',
      stderr: '',
      durationMs: 0,
      timedOut: false,
    };

    await this.jobManager.runJob(job.id, async (currentJob, appendLog) => {
      let attempt = 0;
      while (true) {
        const segments = splitShellAnd(project.commands.buildCommand!);
        let execResult = { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false } as Awaited<ReturnType<typeof this.processManager.exec>>;
        for (const segment of segments) {
          const commandParts = splitCommand(segment);
          execResult = await this.processManager.exec(project, environment, commandParts, {
            onStdout: (chunk) => appendLog(logLine('stdout', chunk)),
            onStderr: (chunk) => appendLog(logLine('stderr', chunk)),
          });
          result = { success: execResult.exitCode === 0 && !execResult.timedOut, jobId: currentJob.id, ...execResult };
          this.jobManager.setExitCode(currentJob.id, execResult.exitCode);
          if (!result.success || this.jobManager.isCancellationRequested(currentJob.id)) break;
        }
        if (this.jobManager.isCancellationRequested(currentJob.id)) { currentJob.status = 'CANCELLED'; return; }
        if (result.success) return;
        if (attempt < currentJob.maxRetries) {
          attempt += 1;
          this.jobManager.incrementRetry(currentJob.id);
          appendLog(logLine('system', `Retrying build (${attempt}/${currentJob.maxRetries})...`));
          continue;
        }
        currentJob.status = 'FAILED';
        throw new Error(`Build failed with exit code ${result.exitCode}`);
      }
    });

    return result;
  }
}

function splitShellAnd(command: string): string[] {
  const parts: string[] = []; let current = ''; let quote: string | null = null;
  for (let i=0;i<command.length;i++){ const ch=command[i]; if ((ch==='"'||ch==="'") && (i===0||command[i-1] !== '\\')) quote=quote===ch?null:quote??ch; if(!quote&&ch==='&'&&command[i+1]==='&'){if(current.trim())parts.push(current.trim());current='';i++;continue;} current+=ch;} if(current.trim())parts.push(current.trim()); return parts.length?parts:[command];
}

function splitCommand(command: string): string[] {
  // Simple shell-word split sufficient for the commands EnvironmentPacks
  // configure (no complex quoting/pipes expected here — those belong in
  // a wrapper script within the project, not the build command string).
  return command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [command];
}

function logLine(stream: JobLogLine['stream'], text: string): JobLogLine {
  return { timestamp: new Date().toISOString(), stream, text };
}

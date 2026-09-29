import { ProjectManifest, EnvironmentManifest, TestResult, JobLogLine } from '@core/types';
import { JobManager } from '../job/JobManager';
import { ProcessManager } from '../process/ProcessManager';
import { PolicyEngine } from '../../policy/PolicyEngine';

/**
 * TestEngine — spec section 9's TEST step, and the "Test" MVP surface
 * (spec section 28). Runs the project's test command and does a
 * best-effort parse of common test-runner output formats (Jest, pytest,
 * cargo test, go test, JUnit/Gradle) to populate passed/failed/skipped
 * counts for the GUI's Tests panel, without requiring every
 * EnvironmentPack to implement its own parser.
 */
export class TestEngine {
  constructor(
    private readonly jobManager: JobManager,
    private readonly processManager: ProcessManager,
    private readonly policyEngine: PolicyEngine
  ) {}

  async test(project: ProjectManifest, environment: EnvironmentManifest, maxRetries = 0): Promise<TestResult> {
    if (!project.commands.testCommand) {
      throw new Error(`Project "${project.name}" has no test command configured.`);
    }

    const job = this.jobManager.create({
      kind: 'test',
      title: `Test: ${project.name}`,
      projectId: project.id,
      environmentId: environment.environmentId,
      maxRetries,
    });

    const policyDecision = this.policyEngine.evaluate({
      toolName: 'project.test',
      destructive: false,
      requiresNetwork: false,
      projectNetworkPermission: project.networkPermission,
      requestedByAI: false,
    });
    if (!policyDecision.allowed) {
      throw new Error(`Test run blocked by policy: ${policyDecision.reason}`);
    }

    let result: TestResult = {
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
        let combinedOutput = '';
        let execResult = { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false };
        for (const commandParts of splitShellAnd(project.commands.testCommand!)) {
          if (this.jobManager.isCancellationRequested(currentJob.id)) { currentJob.status = 'CANCELLED'; return; }
          const part = await this.processManager.exec(project, environment, splitCommand(commandParts), {
            onStdout: (chunk) => { combinedOutput += chunk; appendLog(logLine('stdout', chunk)); },
            onStderr: (chunk) => { combinedOutput += chunk; appendLog(logLine('stderr', chunk)); },
          });
          execResult = { exitCode: part.exitCode, stdout: execResult.stdout + part.stdout, stderr: execResult.stderr + part.stderr, durationMs: execResult.durationMs + part.durationMs, timedOut: part.timedOut };
          if (part.exitCode !== 0 || part.timedOut) break;
        }
        const parsed = parseTestOutput(combinedOutput);
        result = { success: execResult.exitCode === 0 && !execResult.timedOut, jobId: currentJob.id, ...execResult, ...parsed };
        this.jobManager.setExitCode(currentJob.id, execResult.exitCode);
        if (this.jobManager.isCancellationRequested(currentJob.id)) { currentJob.status = 'CANCELLED'; return; }
        if (result.success) return;
        if (attempt < currentJob.maxRetries) {
          attempt += 1;
          this.jobManager.incrementRetry(currentJob.id);
          appendLog(logLine('system', `Retrying tests (${attempt}/${currentJob.maxRetries})...`));
          continue;
        }
        currentJob.status = 'FAILED';
        throw new Error(`Tests failed with exit code ${execResult.exitCode}`);
      }
    });

    return result;
  }
}

function splitShellAnd(command: string): string[] {
  const parts: string[] = []; let current = ''; let quote: string | null = null;
  for (let i=0;i<command.length;i++){ const ch=command[i]; if ((ch==='"'||ch==="'") && (i===0||command[i-1]!=='\\')) quote=quote===ch?null:quote??ch; if(!quote&&ch==='&'&&command[i+1]==='&'){if(current.trim())parts.push(current.trim());current='';i++;continue;} current+=ch;} if(current.trim())parts.push(current.trim()); return parts.length?parts:[command];
}

function splitCommand(command: string): string[] {
  return command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [command];
}

function logLine(stream: JobLogLine['stream'], text: string): JobLogLine {
  return { timestamp: new Date().toISOString(), stream, text };
}

/**
 * Best-effort multi-framework test summary parser. Each pattern targets
 * a specific, well-documented output format; unmatched output falls back
 * to undefined counts rather than guessing.
 */
function parseTestOutput(output: string): { passed?: number; failed?: number; skipped?: number } {
  // Jest: "Tests: 2 failed, 1 skipped, 10 passed, 13 total"
  const jestMatch = /Tests:\s+(?:(\d+) failed,\s*)?(?:(\d+) skipped,\s*)?(?:(\d+) passed,\s*)?(\d+) total/.exec(output);
  if (jestMatch) {
    return {
      failed: jestMatch[1] ? parseInt(jestMatch[1], 10) : 0,
      skipped: jestMatch[2] ? parseInt(jestMatch[2], 10) : 0,
      passed: jestMatch[3] ? parseInt(jestMatch[3], 10) : 0,
    };
  }

  // pytest: "5 passed, 1 failed, 2 skipped in 1.23s"
  const pytestPassed = /(\d+) passed/.exec(output);
  const pytestFailed = /(\d+) failed/.exec(output);
  const pytestSkipped = /(\d+) skipped/.exec(output);
  if (pytestPassed || pytestFailed || pytestSkipped) {
    return {
      passed: pytestPassed ? parseInt(pytestPassed[1] ?? '0', 10) : 0,
      failed: pytestFailed ? parseInt(pytestFailed[1] ?? '0', 10) : 0,
      skipped: pytestSkipped ? parseInt(pytestSkipped[1] ?? '0', 10) : 0,
    };
  }

  // cargo test: "test result: ok. 5 passed; 0 failed; 1 ignored"
  const cargoMatch = /test result: \w+\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) ignored/.exec(output);
  if (cargoMatch) {
    return {
      passed: parseInt(cargoMatch[1] ?? '0', 10),
      failed: parseInt(cargoMatch[2] ?? '0', 10),
      skipped: parseInt(cargoMatch[3] ?? '0', 10),
    };
  }

  // go test: "ok  	module/path	0.123s" (pass) or "FAIL" lines counted
  const goFailCount = (output.match(/^--- FAIL:/gm) ?? []).length;
  const goPassCount = (output.match(/^--- PASS:/gm) ?? []).length;
  if (goFailCount > 0 || goPassCount > 0) {
    return { passed: goPassCount, failed: goFailCount, skipped: 0 };
  }

  // Gradle/JUnit: "5 tests completed, 1 failed"
  const gradleMatch = /(\d+) tests? completed(?:,\s*(\d+) failed)?/.exec(output);
  if (gradleMatch) {
    const total = parseInt(gradleMatch[1] ?? '0', 10);
    const failed = gradleMatch[2] ? parseInt(gradleMatch[2], 10) : 0;
    return { passed: total - failed, failed, skipped: 0 };
  }

  return {};
}

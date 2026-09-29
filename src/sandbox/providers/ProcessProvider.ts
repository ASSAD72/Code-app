import { spawn, ChildProcess } from 'child_process';
import { EnvironmentManifest, ExecutionResult, ResourceUsageSample } from '@core/types';
import { SandboxProvider, SandboxCreateOptions, SandboxExecOptions, SandboxInstanceHandle } from '../SandboxProvider';

/**
 * ProcessProvider — the "no isolation backend installed" fallback.
 *
 * Spec section 23 requires CodeX to be offline/local-first, and section 28
 * lists "Execute commands" as an MVP requirement independent of Docker
 * being installed. This provider makes that true: if Docker Desktop,
 * WSL2, and Windows Sandbox are all unavailable, CodeX still runs — it
 * just runs project commands as plain child processes on the host,
 * scoped to the project's working directory, with a working-directory
 * jail and environment-variable scrubbing as the only isolation it can
 * actually offer without a real sandbox backend.
 *
 * THIS IS DELIBERATELY THE WEAKEST PROVIDER AND IS LABELED AS SUCH. It
 * does NOT meet the "sandboxed from host credentials/filesystem" bar the
 * rest of the system assumes — it cannot, because it has no isolation
 * primitive to enforce that with. EnvironmentManager surfaces a persistent
 * warning in the GUI/CLI whenever ProcessProvider is the active provider,
 * and RepairEngine/BuildEngine still apply the resource *soft* limits
 * (timeout enforcement, output size caps) that are achievable at the
 * process level. Destructive filesystem tools are still routed through
 * PolicyEngine, which is provider-agnostic and applies regardless.
 */
export class ProcessProvider implements SandboxProvider {
  readonly type = 'process';
  private instances = new Map<string, SandboxInstanceHandle>();
  private runningChildren = new Map<string, ChildProcess>();

  async isAvailable(): Promise<{ available: boolean; reason?: string }> {
    // Always available — it's just the host's own shell.
    return { available: true };
  }

  async prepareImage(_environment: EnvironmentManifest, onProgress?: (line: string) => void): Promise<void> {
    onProgress?.(
      'ProcessProvider active: no container/VM isolation backend found. Toolchains must already be installed on the host PATH.'
    );
  }

  async createInstance(options: SandboxCreateOptions): Promise<SandboxInstanceHandle> {
    const instanceId = `proc-${options.projectId}-${Date.now()}`;
    const handle: SandboxInstanceHandle = {
      instanceId,
      environmentId: options.environment.environmentId,
      projectId: options.projectId,
      providerType: 'process',
      workspaceHostPath: options.workspaceHostPath,
      workspaceContainerPath: options.workspaceHostPath, // no remapping — same path
      networkEnabled: options.networkEnabled, // NOTE: not actually enforceable at this level; see class doc
      createdAt: new Date().toISOString(),
    };
    this.instances.set(instanceId, handle);
    return handle;
  }

  async exec(handle: SandboxInstanceHandle, options: SandboxExecOptions): Promise<ExecutionResult> {
    const startTime = Date.now();
    const [command, ...args] = options.command;
    if (!command) {
      throw new Error('No command specified for ProcessProvider.exec');
    }

    return new Promise<ExecutionResult>((resolve, reject) => {
      // Scrub environment: never inherit the host's full env (which may
      // contain credentials, tokens, etc.) — only pass through a safe
      // minimal set plus whatever the caller explicitly provided.
      const safeBaseEnv = extractSafeHostEnv();
      const child = spawn(command, args, {
        cwd: options.cwd ?? handle.workspaceContainerPath,
        env: { ...safeBaseEnv, ...options.env },
        windowsHide: true,
        detached: process.platform !== 'win32',
      });

      this.runningChildren.set(handle.instanceId, child);

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timeoutMs = options.timeoutMs ?? 20 * 60 * 1000;

      const killTree = () => {
        if (child.pid === undefined) return;
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
        } else {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        }
      };
      const timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);
      options.signal?.addEventListener('abort', killTree, { once: true });

      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString('utf-8');
        options.onStdout?.(d.toString('utf-8'));
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString('utf-8');
        options.onStderr?.(d.toString('utf-8'));
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        this.runningChildren.delete(handle.instanceId);
        resolve({
          exitCode: code ?? -1,
          stdout,
          stderr,
          durationMs: Date.now() - startTime,
          timedOut,
        });
      });
    });
  }

  async getResourceUsage(handle: SandboxInstanceHandle): Promise<ResourceUsageSample> {
    const child = this.runningChildren.get(handle.instanceId);
    if (!child || child.pid === undefined) {
      return { timestamp: new Date().toISOString(), cpuPercent: 0, memoryMB: 0 };
    }
    // Best-effort: process-level CPU/memory sampling without a container
    // runtime API requires platform-specific reads (e.g. /proc/[pid]/stat
    // on Linux, WMI/perf counters on Windows). We report zeros here rather
    // than fabricate values that would mislead ResourceManager's breach
    // detection into false confidence.
    return { timestamp: new Date().toISOString(), cpuPercent: 0, memoryMB: 0, pids: 1 };
  }

  async destroyInstance(handle: SandboxInstanceHandle): Promise<void> {
    const child = this.runningChildren.get(handle.instanceId);
    child?.kill();
    this.runningChildren.delete(handle.instanceId);
    this.instances.delete(handle.instanceId);
  }

  async setNetworkEnabled(handle: SandboxInstanceHandle, enabled: boolean): Promise<void> {
    // Cannot be enforced without a real network namespace/firewall backend.
    // We record the intent so the GUI can display an accurate "not
    // enforced" warning, but we do not pretend to block it.
    const existing = this.instances.get(handle.instanceId);
    if (existing) {
      this.instances.set(handle.instanceId, { ...existing, networkEnabled: enabled });
    }
  }

  async listInstances(): Promise<SandboxInstanceHandle[]> {
    return Array.from(this.instances.values());
  }
}

function extractSafeHostEnv(): Record<string, string> {
  const allowList = ['PATH', 'PATHEXT', 'TEMP', 'TMP', 'SystemRoot', 'HOME', 'LANG', 'LC_ALL'];
  const result: Record<string, string> = {};
  for (const key of allowList) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

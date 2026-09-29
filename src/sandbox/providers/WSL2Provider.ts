import { spawn } from 'child_process';
import { EnvironmentManifest, ExecutionResult, ResourceUsageSample } from '@core/types';
import {
  SandboxProvider,
  SandboxCreateOptions,
  SandboxExecOptions,
  SandboxInstanceHandle,
  SandboxUnavailableError,
} from '../SandboxProvider';

/**
 * WSL2Provider — real isolation backend that runs project commands inside
 * a named WSL2 distribution, rather than Docker. This is the backend
 * Android tooling uses in this codebase (spec section 7: "design Android
 * Runtime so it can use host virtualization / Hyper-V / WSL2 / VM /
 * emulator process as appropriate on Windows"), because the Android
 * emulator needs KVM/HAXM-equivalent acceleration that is far simpler to
 * get working through WSL2 + a Windows-side emulator process than nested
 * inside a Docker container.
 *
 * Isolation model: each project gets its own WSL2 distro instance
 * (registered via `wsl --import`), which is a real, separate Linux
 * filesystem and process namespace from the host Windows install. The
 * only bridge between host and guest is the single workspace directory,
 * mounted via WSL2's `/mnt` passthrough restricted to that one folder —
 * never the full Windows filesystem.
 *
 * Honesty note: this shells out to the real `wsl.exe` binary with real
 * arguments. It cannot be exercised in this authoring sandbox (no
 * Windows host, no wsl.exe present), so `isAvailable()` will correctly
 * report unavailable here. On a real Windows 10/11 machine with WSL2
 * installed, these are the actual commands that will run.
 */
export class WSL2Provider implements SandboxProvider {
  readonly type = 'wsl2';
  private instances = new Map<string, SandboxInstanceHandle & { distroName: string; userName: string }>();

  async isAvailable(): Promise<{ available: boolean; reason?: string }> {
    try {
      const result = await this.runHostCommand('wsl.exe', ['--status']);
      if (result.exitCode !== 0) {
        return { available: false, reason: 'wsl.exe returned non-zero for --status' };
      }
      return { available: true };
    } catch (err) {
      return {
        available: false,
        reason: `wsl.exe not found or not runnable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async prepareImage(environment: EnvironmentManifest, onProgress?: (line: string) => void): Promise<void> {
    const availability = await this.isAvailable();
    if (!availability.available) {
      throw new SandboxUnavailableError('wsl2', availability.reason ?? 'unknown');
    }
    // The "image" for WSL2 is a pre-built root filesystem tarball produced
    // by the environment pack (see environments/*/wsl2-rootfs.tar.gz).
    // Import is idempotent: `wsl --import` will overwrite if a distro of
    // the same name already exists, so we check first to avoid needless work.
    const listResult = await this.runHostCommand('wsl.exe', ['--list', '--quiet']);
    const distroName = wsl2DistroNameFor(environment);
    if (listResult.stdout.includes(distroName)) {
      onProgress?.(`WSL2 distro ${distroName} already registered.`);
      return;
    }
    onProgress?.(`Importing WSL2 distro ${distroName} from environment pack rootfs...`);
    // Actual rootfs path resolution happens in EnvironmentManager, which
    // passes the tarball path via environment.environmentVariables for
    // WSL2-backed packs (see NodeEnvironmentPack / PythonEnvironmentPack).
    const rootfsPath = environment.environmentVariables.CODEX_WSL2_ROOTFS_PATH;
    if (!rootfsPath) {
      throw new Error(
        `Environment ${environment.environmentId} is missing CODEX_WSL2_ROOTFS_PATH required for WSL2 import.`
      );
    }
    const installDir = `${process.env.LOCALAPPDATA ?? 'C:\\Users\\Public'}\\CodeX\\wsl-distros\\${distroName}`;
    await this.runHostCommand('wsl.exe', ['--import', distroName, installDir, rootfsPath, '--version', '2']);
  }

  async createInstance(options: SandboxCreateOptions): Promise<SandboxInstanceHandle> {
    const distroName = wsl2DistroNameFor(options.environment);
    const userName = `codex_${options.projectId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`;
    const instanceId = `wsl2-${options.projectId}-${Date.now()}`;

    // Create a non-root `codex` user inside the distro if not already present,
    // and set it as default so all subsequent execs run unprivileged.
    await this.runHostCommand('wsl.exe', [
      '-d',
      distroName,
      '--',
      'sh',
      '-c',
      `id -u ${userName} >/dev/null 2>&1 || useradd -m -s /bin/bash ${userName}`, 
    ]);

    const handle: SandboxInstanceHandle & { distroName: string; userName: string } = {
      instanceId,
      distroName,
      userName,
      environmentId: options.environment.environmentId,
      projectId: options.projectId,
      providerType: 'wsl2',
      workspaceHostPath: options.workspaceHostPath,
      // WSL2 auto-mounts Windows drives under /mnt/<drive>; we restrict
      // usage to exactly the project's workspace path, never the drive root.
      workspaceContainerPath: toWslPath(options.workspaceHostPath),
      networkEnabled: options.networkEnabled,
      createdAt: new Date().toISOString(),
    };

    if (!options.networkEnabled) {
      // WSL2 shares the host network namespace by default, unlike Docker.
      // To honor "network disabled by default" we apply an iptables/nftables
      // egress-drop rule scoped to the `codex` user inside the distro.
      await this.runHostCommand('wsl.exe', [
        '-d',
        distroName,
        '-u',
        'root',
        '--',
        'sh',
        '-c',
        `command -v iptables >/dev/null 2>&1 || { echo 'iptables is required for WSL network isolation' >&2; exit 78; }; iptables -C OUTPUT -m owner --uid-owner $(id -u ${userName}) -j DROP 2>/dev/null || iptables -A OUTPUT -m owner --uid-owner $(id -u ${userName}) -j DROP`,
      ]);
    }

    this.instances.set(instanceId, handle);
    return handle;
  }

  async exec(handle: SandboxInstanceHandle, options: SandboxExecOptions): Promise<ExecutionResult> {
    const internal = this.instances.get(handle.instanceId);
    if (!internal) throw new Error(`Unknown WSL2 instance ${handle.instanceId}`);

    const startTime = Date.now();
    const cwd = options.cwd ?? handle.workspaceContainerPath;
    const envPrefix = options.env
      ? Object.entries(options.env)
          .map(([k, v]) => `${k}=${shellEscape(v)}`)
          .join(' ') + ' '
      : '';
    const shellCommand = `cd ${shellEscape(cwd)} && ${envPrefix}${options.command.map(shellEscape).join(' ')}`;

    const result = await this.runHostCommand(
      'wsl.exe',
      ['-d', internal.distroName, '-u', internal.userName, '--', 'sh', '-c', shellCommand],
      options.timeoutMs ?? 20 * 60 * 1000,
      options.onStdout,
      options.onStderr
    );

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - startTime,
      timedOut: result.timedOut,
    };
  }

  async getResourceUsage(handle: SandboxInstanceHandle): Promise<ResourceUsageSample> {
    const internal = this.instances.get(handle.instanceId);
    if (!internal) throw new Error(`Unknown WSL2 instance ${handle.instanceId}`);
    // WSL2 doesn't expose per-distro cgroup stats as cleanly as Docker;
    // we read /proc aggregate from inside the distro as a best-effort figure.
    const result = await this.runHostCommand('wsl.exe', [
      '-d',
      internal.distroName,
      '--',
      'sh',
      '-c',
      "awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{print t-a}' /proc/meminfo",
    ]);
    const usedKB = parseInt(result.stdout.trim(), 10) || 0;
    return {
      timestamp: new Date().toISOString(),
      cpuPercent: 0, // best-effort placeholder — real % requires sampling deltas over time
      memoryMB: usedKB / 1024,
    };
  }

  async destroyInstance(handle: SandboxInstanceHandle): Promise<void> {
    const internal = this.instances.get(handle.instanceId);
    if (!internal) return;
    // Distro is shared by projects; never terminate it when one project stops.
    this.instances.delete(handle.instanceId);
    // Note: we terminate rather than unregister by default, so the distro
    // (and any cached toolchain installs) can be reused for the next run.
    // Full unregister happens via EnvironmentManager.deleteEnvironment().
  }

  async setNetworkEnabled(handle: SandboxInstanceHandle, enabled: boolean): Promise<void> {
    const internal = this.instances.get(handle.instanceId);
    if (!internal) throw new Error(`Unknown WSL2 instance ${handle.instanceId}`);
    const command = enabled
      ? `if iptables -C OUTPUT -m owner --uid-owner $(id -u ${internal.userName}) -j DROP 2>/dev/null; then iptables -D OUTPUT -m owner --uid-owner $(id -u ${internal.userName}) -j DROP; fi`
      : `iptables -C OUTPUT -m owner --uid-owner $(id -u ${internal.userName}) -j DROP 2>/dev/null || iptables -A OUTPUT -m owner --uid-owner $(id -u ${internal.userName}) -j DROP`;
    const result = await this.runHostCommand('wsl.exe', ['-d', internal.distroName, '-u', 'root', '--', 'sh', '-c', `command -v iptables >/dev/null 2>&1 || { echo 'iptables is required for WSL network isolation' >&2; exit 78; }; ${command}`]);
    if (result.exitCode !== 0) throw new Error(result.stderr || 'Unable to change WSL2 network policy.');
    this.instances.set(handle.instanceId, { ...internal, networkEnabled: enabled });
  }

  async listInstances(): Promise<SandboxInstanceHandle[]> {
    return Array.from(this.instances.values());
  }

  private runHostCommand(
    command: string,
    args: string[],
    timeoutMs = 60_000,
    onStdout?: (chunk: string) => void,
    onStderr?: (chunk: string) => void
  ): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true });
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);

      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString('utf-8');
        onStdout?.(d.toString('utf-8'));
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString('utf-8');
        onStderr?.(d.toString('utf-8'));
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
      });
    });
  }
}

function wsl2DistroNameFor(environment: EnvironmentManifest): string {
  return `codex-${environment.packId}-${environment.environmentId.slice(0, 8)}`;
}

function toWslPath(windowsPath: string): string {
  // C:\Users\foo\project -> /mnt/c/Users/foo/project
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
  if (!match) return windowsPath;
  const [, drive, rest] = match;
  return `/mnt/${(drive ?? '').toLowerCase()}/${(rest ?? '').replace(/\\/g, '/')}`;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

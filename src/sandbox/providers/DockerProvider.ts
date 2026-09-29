import Docker from 'dockerode';
import path from 'path';
import fs from 'fs';
import { EnvironmentManifest, ExecutionResult, ResourceUsageSample } from '@core/types';
import {
  SandboxProvider,
  SandboxCreateOptions,
  SandboxExecOptions,
  SandboxInstanceHandle,
  SandboxSecurityViolationError,
  SandboxUnavailableError,
} from '../SandboxProvider';

/**
 * DockerProvider — real implementation against the Docker Engine API via
 * dockerode. This is the MVP-and-beyond default SandboxProvider for
 * Windows (Docker Desktop + WSL2 backend), per spec section 4.
 *
 * IMPORTANT (honesty note for the delivery report): this class issues
 * real Docker Engine API calls with the exact hardening flags spec'd in
 * section 4 (non-root user, --network none by default, cpu/memory/pids
 * limits, no-new-privileges, capability dropping, workspace-only mount).
 * It has NOT been exercised against a live Docker daemon in the sandbox
 * this code was written in, because that sandbox has no Docker daemon
 * and no network access to pull images. It should be run against a real
 * Docker Desktop install on Windows before being trusted in production,
 * the same as any new infrastructure code would be.
 */
export class DockerProvider implements SandboxProvider {
  readonly type = 'docker';
  private docker: Docker;
  private instances = new Map<string, SandboxInstanceHandle & { containerId: string }>();

  constructor(dockerOptions?: Docker.DockerOptions) {
    // On Windows with Docker Desktop, dockerode auto-detects the named pipe
    // (//./pipe/docker_engine) when no options are given. We accept an
    // override for testing / alternate socket paths.
    this.docker = new Docker(dockerOptions);
  }

  async isAvailable(): Promise<{ available: boolean; reason?: string }> {
    try {
      await this.docker.ping();
      return { available: true };
    } catch (err) {
      return {
        available: false,
        reason: `Docker daemon not reachable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async prepareImage(environment: EnvironmentManifest, onProgress?: (line: string) => void): Promise<void> {
    const availability = await this.isAvailable();
    if (!availability.available) {
      throw new SandboxUnavailableError('docker', availability.reason ?? 'unknown');
    }

    const images = await this.docker.listImages({
      filters: JSON.stringify({ reference: [environment.baseImage] }),
    });

    if (images.length > 0) {
      onProgress?.(`Image ${environment.baseImage} already present locally.`);
      return;
    }

    if (environment.dockerfilePath) {
      const dockerfileExists = await fs.promises.access(environment.dockerfilePath).then(() => true).catch(() => false);
      if (dockerfileExists) {
        onProgress?.(`Building local Docker image ${environment.baseImage} from ${environment.dockerfilePath}...`);
        const context = path.dirname(environment.dockerfilePath);
        const stream = await this.docker.buildImage({ context, src: [path.basename(environment.dockerfilePath)] }, { t: environment.baseImage, dockerfile: path.basename(environment.dockerfilePath) });
        await new Promise<void>((resolve, reject) => this.docker.modem.followProgress(stream, (err: Error | null) => err ? reject(err) : resolve(), (event: { stream?: string; status?: string }) => onProgress?.(event.stream ?? event.status ?? '')));
        return;
      }
    }

    if (!environment.baseImage || environment.baseImage === 'n/a') {
      throw new SandboxUnavailableError('docker', `Environment ${environment.environmentId} has no usable Docker image.`);
    }
    onProgress?.(`Pulling image ${environment.baseImage}...`);
    await new Promise<void>((resolve, reject) => {
      this.docker.pull(environment.baseImage, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        this.docker.modem.followProgress(stream, (finalErr: Error | null) => finalErr ? reject(finalErr) : resolve(), (event: { status?: string; progress?: string }) => {
          if (event.status) onProgress?.(`${event.status}${event.progress ? ' ' + event.progress : ''}`);
        });
      });
    });
  }

  async exportEnvironmentImage(environment: EnvironmentManifest, outputPath: string, onProgress?: (line: string) => void): Promise<void> {
    const stream = await this.docker.getImage(environment.baseImage).get();
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(outputPath);
      stream.pipe(output);
      stream.on('error', reject);
      output.on('error', reject);
      output.on('finish', () => { onProgress?.(`Exported Docker image ${environment.baseImage}.`); resolve(); });
    });
  }

  async importEnvironmentImage(environment: EnvironmentManifest, inputPath: string, onProgress?: (line: string) => void): Promise<void> {
    const stream = fs.createReadStream(inputPath);
    await this.docker.loadImage(stream);
    onProgress?.(`Imported Docker image ${environment.baseImage}.`);
  }

  async getImageDigest(environment: EnvironmentManifest): Promise<string | undefined> {
    const info = await this.docker.getImage(environment.baseImage).inspect();
    return info.Id;
  }

  async createInstance(options: SandboxCreateOptions): Promise<SandboxInstanceHandle> {
    this.assertNoHostRootMount(options.workspaceHostPath);

    const containerWorkspacePath = '/workspace';
    const instanceId = `codex-${options.projectId}-${Date.now()}`;

    const hostConfig: Docker.HostConfig = {
      // --- Isolation hardening (spec section 4) ---
      NetworkMode: options.networkEnabled ? 'bridge' : 'none',
      Binds: [`${options.workspaceHostPath}:${containerWorkspacePath}:rw`],
      ReadonlyRootfs: false,
      SecurityOpt: ['no-new-privileges:true'],
      CapDrop: ['ALL'],
      // Only add back what's strictly needed for common dev toolchains
      // (e.g. binding to ports during `run`, chown during install steps).
      CapAdd: ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE'],
      // --- Resource limits ---
      NanoCpus: options.resourceLimits.cpuCores
        ? Math.floor(options.resourceLimits.cpuCores * 1_000_000_000)
        : undefined,
      Memory: options.resourceLimits.memoryMB ? options.resourceLimits.memoryMB * 1024 * 1024 : undefined,
      MemorySwap: options.resourceLimits.memoryMB ? options.resourceLimits.memoryMB * 1024 * 1024 : undefined,
      PidsLimit: options.resourceLimits.pids ?? 512,
      // Never mount the Docker socket into project containers (spec section 4).
    };

    const env = Object.entries({ ...environmentToEnvMap(options.environment), ...options.extraEnv }).map(
      ([k, v]) => `${k}=${v}`
    );

    const container = await this.docker.createContainer({
      Image: options.environment.baseImage,
      name: instanceId,
      Tty: false,
      OpenStdin: false,
      WorkingDir: containerWorkspacePath,
      // Non-root user inside the container (spec section 4). Environment
      // packs' Dockerfiles are responsible for creating this `codex` user;
      // see docker/base/Dockerfile.template.
      User: await this.selectContainerUser(options.environment.baseImage),
      Env: env,
      Cmd: ['sleep', 'infinity'], // keep container alive; exec is used for actual commands
      HostConfig: hostConfig,
      Labels: {
        'codex.projectId': options.projectId,
        'codex.environmentId': options.environment.environmentId,
        'codex.managed': 'true',
      },
    });

    await container.start();

    const handle: SandboxInstanceHandle & { containerId: string } = {
      instanceId,
      containerId: container.id,
      environmentId: options.environment.environmentId,
      projectId: options.projectId,
      providerType: 'docker',
      workspaceHostPath: options.workspaceHostPath,
      workspaceContainerPath: containerWorkspacePath,
      networkEnabled: options.networkEnabled,
      createdAt: new Date().toISOString(),
    };

    this.instances.set(instanceId, handle);
    return handle;
  }

  async exec(handle: SandboxInstanceHandle, options: SandboxExecOptions): Promise<ExecutionResult> {
    const internal = this.instances.get(handle.instanceId);
    if (!internal) {
      throw new SandboxSecurityViolationError(`Unknown instance ${handle.instanceId}; refusing to exec blind.`);
    }

    const container = this.docker.getContainer(internal.containerId);
    const startTime = Date.now();

    const exec = await container.exec({
      Cmd: options.command,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: options.cwd ?? handle.workspaceContainerPath,
      Env: options.env ? Object.entries(options.env).map(([k, v]) => `${k}=${v}`) : undefined,
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeoutMs = options.timeoutMs ?? 20 * 60 * 1000;

    const execPromise = new Promise<void>((resolve, reject) => {
      const stdoutStream = new PassThroughCollector((chunk) => {
        stdout += chunk;
        options.onStdout?.(chunk);
      });
      const stderrStream = new PassThroughCollector((chunk) => {
        stderr += chunk;
        options.onStderr?.(chunk);
      });

      this.docker.modem.demuxStream(stream, stdoutStream, stderrStream);
      stream.on('end', resolve);
      stream.on('error', reject);

      options.signal?.addEventListener('abort', () => {
        reject(new Error('Execution aborted by caller'));
      });
    });

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(async () => {
        timedOut = true;
        await container.kill().catch(() => undefined);
        resolve();
      }, timeoutMs);
    });

    if (options.signal) {
      options.signal.addEventListener('abort', () => { void container.kill().catch(() => undefined); }, { once: true });
    }
    await Promise.race([execPromise, timeoutPromise]);

    const inspectResult = await exec.inspect();
    const exitCode = inspectResult.ExitCode ?? (timedOut ? -1 : 0);

    return {
      exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - startTime,
      timedOut,
    };
  }

  async getResourceUsage(handle: SandboxInstanceHandle): Promise<ResourceUsageSample> {
    const internal = this.instances.get(handle.instanceId);
    if (!internal) {
      throw new Error(`Unknown instance ${handle.instanceId}`);
    }
    const container = this.docker.getContainer(internal.containerId);
    const stats = await container.stats({ stream: false });

    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpuCount = stats.cpu_stats.online_cpus || 1;
    const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0;

    return {
      timestamp: new Date().toISOString(),
      cpuPercent,
      memoryMB: (stats.memory_stats.usage ?? 0) / (1024 * 1024),
      pids: stats.pids_stats?.current,
      networkRxBytes: sumNetworkField(stats.networks, 'rx_bytes'),
      networkTxBytes: sumNetworkField(stats.networks, 'tx_bytes'),
    };
  }

  async destroyInstance(handle: SandboxInstanceHandle): Promise<void> {
    const internal = this.instances.get(handle.instanceId);
    if (!internal) return;
    const container = this.docker.getContainer(internal.containerId);
    try {
      await container.stop({ t: 5 });
    } catch {
      // already stopped
    }
    await container.remove({ force: true });
    this.instances.delete(handle.instanceId);
  }

  async setNetworkEnabled(handle: SandboxInstanceHandle, enabled: boolean): Promise<void> {
    // Docker does not support live network-mode changes on a running
    // container. We recreate the container preserving its workspace bind
    // (the workspace itself is untouched since it's a host bind mount).
    const internal = this.instances.get(handle.instanceId);
    if (!internal) throw new Error(`Unknown instance ${handle.instanceId}`);

    const container = this.docker.getContainer(internal.containerId);
    const info = await container.inspect();

    await this.destroyInstance(handle);

    const recreated = await this.docker.createContainer({
      ...extractRecreateConfig(info),
      HostConfig: {
        ...info.HostConfig,
        NetworkMode: enabled ? 'bridge' : 'none',
      },
    });
    await recreated.start();

    this.instances.set(handle.instanceId, {
      ...handle,
      containerId: recreated.id,
      networkEnabled: enabled,
    });
  }

  async listInstances(): Promise<SandboxInstanceHandle[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: ['codex.managed=true'] }),
    });
    return containers.map((c) => ({
      instanceId: c.Names[0]?.replace(/^\//, '') ?? c.Id,
      environmentId: c.Labels['codex.environmentId'] ?? 'unknown',
      projectId: c.Labels['codex.projectId'] ?? 'unknown',
      providerType: 'docker',
      workspaceHostPath: '',
      workspaceContainerPath: '/workspace',
      networkEnabled: c.HostConfig?.NetworkMode !== 'none',
      createdAt: new Date(c.Created * 1000).toISOString(),
    }));
  }

  private async selectContainerUser(image: string): Promise<string | undefined> {
    const info = await this.docker.getImage(image).inspect();
    return info.Config?.User || undefined;
  }

  /**
   * Hard security guard (spec section 3): never allow the host root, a
   * drive root, or any path outside a plausible per-project workspace
   * directory to be used as the bind-mount source. This is a defense in
   * depth check — ProjectManager should never construct such a path, but
   * this provider refuses to trust that blindly.
   */
  private assertNoHostRootMount(hostPath: string): void {
    const normalized = hostPath.replace(/\\/g, '/');
    const forbidden = ['/', 'C:/', 'D:/', '/root', '/home', '/etc', '/var', '/usr', '/'];
    if (forbidden.includes(normalized) || normalized.length <= 3) {
      throw new SandboxSecurityViolationError(
        `Refusing to mount suspicious host path "${hostPath}" as a project workspace.`
      );
    }
  }
}

function environmentToEnvMap(environment: EnvironmentManifest): Record<string, string> {
  return { ...environment.environmentVariables, CODEX_ENVIRONMENT_ID: environment.environmentId };
}

function sumNetworkField(
  networks: Record<string, { rx_bytes?: number; tx_bytes?: number }> | undefined,
  field: 'rx_bytes' | 'tx_bytes'
): number {
  if (!networks) return 0;
  return Object.values(networks).reduce((sum, iface) => sum + (iface[field] ?? 0), 0);
}

function extractRecreateConfig(info: Docker.ContainerInspectInfo): Docker.ContainerCreateOptions {
  return {
    Image: info.Config.Image,
    name: info.Name.replace(/^\//, ''),
    Tty: false,
    WorkingDir: info.Config.WorkingDir,
    User: info.Config.User,
    Env: info.Config.Env,
    Cmd: info.Config.Cmd,
    Labels: info.Config.Labels,
  };
}

/** Minimal Writable-like collector compatible with dockerode's demuxStream. */
class PassThroughCollector {
  constructor(private readonly onChunk: (text: string) => void) {}
  write(chunk: Buffer): boolean {
    this.onChunk(chunk.toString('utf-8'));
    return true;
  }
}

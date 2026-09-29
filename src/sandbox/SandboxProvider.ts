import { EnvironmentManifest, ExecutionResult, ResourceLimits, ResourceUsageSample } from '@core/types';

/**
 * SandboxProvider is the abstraction boundary described in spec section 4/17.
 *
 * Every isolation backend (Docker today; Windows Sandbox, Hyper-V VM, WSL2
 * process-level isolation tomorrow) implements this same interface. Core
 * NEVER talks to Docker (or any backend) directly — it only ever talks to
 * a SandboxProvider. This is what lets a new isolation backend be added
 * without touching BuildEngine, TestEngine, ProcessManager, or RepairEngine.
 *
 * Security contract that every implementation MUST uphold (spec section 3/19):
 *   - No host filesystem access beyond the declared project workspace mount.
 *   - No host credentials, SSH keys, browser profiles, or Docker socket
 *     inside the sandboxed instance.
 *   - No host-root mount, ever.
 *   - Network disabled by default; only enabled when the project's
 *     `networkPermission` flag is explicitly true.
 *   - Runs as non-root inside the instance wherever the backend supports it.
 *   - Resource limits (CPU/RAM/PIDs/timeout) are enforced by the backend,
 *     not merely requested.
 */

export interface SandboxInstanceHandle {
  instanceId: string;
  environmentId: string;
  projectId: string;
  providerType: string;
  workspaceHostPath: string;
  workspaceContainerPath: string;
  networkEnabled: boolean;
  createdAt: string;
}

export interface SandboxCreateOptions {
  environment: EnvironmentManifest;
  projectId: string;
  workspaceHostPath: string;
  networkEnabled: boolean;
  resourceLimits: ResourceLimits;
  extraEnv?: Record<string, string>;
}

export interface SandboxExecOptions {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface SandboxProvider {
  readonly type: string;

  /** Whether this backend is available on the current host (binaries present, daemon reachable, etc). */
  isAvailable(): Promise<{ available: boolean; reason?: string }>;

  /** Build or pull whatever base image/template the environment manifest requires. */
  prepareImage(environment: EnvironmentManifest, onProgress?: (line: string) => void): Promise<void>;

  exportEnvironmentImage?(environment: EnvironmentManifest, outputPath: string, onProgress?: (line: string) => void): Promise<void>;
  importEnvironmentImage?(environment: EnvironmentManifest, inputPath: string, onProgress?: (line: string) => void): Promise<void>;
  getImageDigest?(environment: EnvironmentManifest): Promise<string | undefined>;

  /** Create (but do not necessarily start persistent) an isolated instance for a project. */
  createInstance(options: SandboxCreateOptions): Promise<SandboxInstanceHandle>;

  /** Execute a command inside an existing instance under the configured resource limits. */
  exec(handle: SandboxInstanceHandle, options: SandboxExecOptions): Promise<ExecutionResult>;

  /** Sample current resource usage for a running instance. */
  getResourceUsage(handle: SandboxInstanceHandle): Promise<ResourceUsageSample>;

  /** Destroy the instance and release all resources. Must not affect host state outside the workspace mount. */
  destroyInstance(handle: SandboxInstanceHandle): Promise<void>;

  /** Enable network access for an existing instance (explicit opt-in only — spec section 3/23). */
  setNetworkEnabled(handle: SandboxInstanceHandle, enabled: boolean): Promise<void>;

  /** List instances currently known to this provider (for GUI/CLI inspection and cleanup). */
  listInstances(): Promise<SandboxInstanceHandle[]>;
}

export class SandboxSecurityViolationError extends Error {
  constructor(message: string) {
    super(`Sandbox security violation: ${message}`);
    this.name = 'SandboxSecurityViolationError';
  }
}

export class SandboxUnavailableError extends Error {
  constructor(providerType: string, reason: string) {
    super(`Sandbox provider "${providerType}" is unavailable: ${reason}`);
    this.name = 'SandboxUnavailableError';
  }
}

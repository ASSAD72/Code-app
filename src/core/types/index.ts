/**
 * CodeX Desktop — Core Type Definitions
 *
 * These are the canonical data shapes shared across Core, Sandbox,
 * Environments, Intelligence, Export, and Storage. Keeping them in one
 * place prevents subsystem-specific drift and gives every provider
 * interface a single source of truth to implement against.
 */

// ---------------------------------------------------------------------------
// Common primitives
// ---------------------------------------------------------------------------

export type ISODateString = string;

export type OS = 'windows' | 'linux' | 'macos';
export type Arch = 'x64' | 'arm64';

export interface ResourceLimits {
  cpuCores?: number;
  memoryMB?: number;
  pids?: number;
  diskMB?: number;
  timeoutMs?: number;
}

export interface ResourceUsageSample {
  timestamp: ISODateString;
  cpuPercent: number;
  memoryMB: number;
  diskMB?: number;
  pids?: number;
  networkRxBytes?: number;
  networkTxBytes?: number;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export type JobStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'BUILDING'
  | 'TESTING'
  | 'FAILED'
  | 'SUCCESS'
  | 'CANCELLED'
  | 'PAUSED';

export type JobKind =
  | 'project.create'
  | 'environment.create'
  | 'environment.install'
  | 'environment.export'
  | 'environment.import'
  | 'build'
  | 'test'
  | 'run'
  | 'repair'
  | 'snapshot.create'
  | 'snapshot.restore'
  | 'export.source'
  | 'export.native'
  | 'export.environment'
  | 'import.project'
  | 'android.build'
  | 'android.emulator.start'
  | 'custom';

export interface JobLogLine {
  timestamp: ISODateString;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
}

export interface Job {
  id: string;
  kind: JobKind;
  projectId?: string;
  environmentId?: string;
  status: JobStatus;
  title: string;
  createdAt: ISODateString;
  startedAt?: ISODateString;
  finishedAt?: ISODateString;
  exitCode?: number;
  progress?: number; // 0-100
  logs: JobLogLine[];
  resourceUsage: ResourceUsageSample[];
  error?: string;
  retryCount: number;
  maxRetries: number;
  parentJobId?: string;
  cancelRequested: boolean;
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

export type EnvironmentCapability =
  | 'filesystem'
  | 'process'
  | 'network'
  | 'gpu'
  | 'usb'
  | 'kvm';

export interface RuntimeSpec {
  name: string; // e.g. "node", "python", "jdk"
  version: string; // e.g. "20.17.0"
  installCommand?: string;
}

export interface PackageManagerSpec {
  name: string; // e.g. "npm", "pip", "cargo"
  version?: string;
}

/**
 * environment.json — the manifest for a single Environment instance.
 * This is the canonical on-disk / in-DB representation described in
 * spec section 5.
 */
export interface EnvironmentManifest {
  environmentId: string;
  name: string;
  version: string; // semver of this environment definition
  packId: string; // which EnvironmentPack produced this (e.g. "codex-pack-node")
  baseImage: string; // docker image reference, e.g. "codex-node:20"
  imageDigest?: string; // immutable Docker image ID/digest when provider is Docker
  dockerfilePath?: string; // local Dockerfile used to build this image, when available
  os: OS;
  architecture: Arch;
  installedRuntimes: RuntimeSpec[];
  sdkVersions: Record<string, string>;
  packageManagers: PackageManagerSpec[];
  environmentVariables: Record<string, string>;
  requiredResources: ResourceLimits;
  capabilities: EnvironmentCapability[];
  networkEnabledByDefault: boolean;
  checksum: string; // digest of the manifest + image content
  createdAt: ISODateString;
  updatedAt: ISODateString;
  providerType: SandboxProviderType;
}

export type SandboxProviderType = 'docker' | 'wsl2' | 'windows-sandbox' | 'hyperv-vm' | 'process';

// ---------------------------------------------------------------------------
// Environment Packs (plugin-defined environment templates)
// ---------------------------------------------------------------------------

export interface EnvironmentPackDefinition {
  packId: string;
  displayName: string;
  description: string;
  category:
    | 'web'
    | 'python'
    | 'systems'
    | 'jvm'
    | 'microsoft'
    | 'mobile'
    | 'database'
    | 'other';
  version: string;
  dockerfile?: string; // relative path within the pack directory
  baseImageTag: string;
  defaultRuntimes: RuntimeSpec[];
  defaultPackageManagers: PackageManagerSpec[];
  defaultCapabilities: EnvironmentCapability[];
  buildCommand?: string;
  testCommand?: string;
  runCommand?: string;
  requiresHostVirtualization?: boolean; // e.g. Android emulator
  supportedProviderTypes: SandboxProviderType[];
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export type ProjectType =
  | 'node'
  | 'python'
  | 'rust'
  | 'cpp'
  | 'c'
  | 'go'
  | 'java'
  | 'dotnet'
  | 'android'
  | 'flutter'
  | 'react-native'
  | 'web'
  | 'custom';

export interface ProjectCommandSet {
  buildCommand?: string;
  testCommand?: string;
  runCommand?: string;
  installCommand?: string;
}

export interface ProjectExportConfiguration {
  sourceExportEnabled: boolean;
  nativeExportTargets: NativeExportTarget[];
  environmentExportEnabled: boolean;
}

export type NativeExportTarget =
  | 'windows-exe'
  | 'windows-msi'
  | 'android-apk'
  | 'android-aab'
  | 'web-bundle'
  | 'linux-binary';

export interface ProjectHistoryEntry {
  timestamp: ISODateString;
  kind: 'build' | 'test' | 'run' | 'command' | 'snapshot' | 'error' | 'fix' | 'environment-change';
  summary: string;
  jobId?: string;
  detail?: string;
}

/**
 * project.json — canonical project manifest, spec section 11.
 */
export interface ProjectManifest {
  id: string;
  name: string;
  type: ProjectType;
  environmentId: string;
  environmentVersion: string;
  sourcePath: string;
  dependencies: string[];
  commands: ProjectCommandSet;
  exportConfiguration: ProjectExportConfiguration;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  networkPermission: boolean;
}

export interface ProjectMemoryRecord {
  projectId: string;
  architectureDecisions: string[];
  importantFiles: string[];
  knownErrors: { signature: string; description: string; firstSeen: ISODateString }[];
  fixes: { errorSignature: string; description: string; patchSummary: string; appliedAt: ISODateString }[];
  dependenciesNotes: string[];
  environmentNotes: string[];
  previousSuccessfulBuilds: { jobId: string; timestamp: ISODateString; commitRef?: string }[];
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export interface Snapshot {
  id: string; // e.g. "snapshot-001"
  projectId: string;
  label: string;
  createdAt: ISODateString;
  gitCommitHash?: string;
  filesystemArchivePath?: string;
  reason: 'manual' | 'pre-patch' | 'pre-repair-cycle' | 'scheduled';
  sizeBytes?: number;
}

// ---------------------------------------------------------------------------
// Build / Test / Repair
// ---------------------------------------------------------------------------

export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  resourceUsage?: ResourceUsageSample[];
}

export interface BuildResult extends ExecutionResult {
  success: boolean;
  jobId: string;
}

export interface TestResult extends ExecutionResult {
  success: boolean;
  jobId: string;
  passed?: number;
  failed?: number;
  skipped?: number;
}

export interface ErrorAnalysis {
  errorSignature: string;
  category: 'syntax' | 'dependency' | 'type' | 'runtime' | 'test-failure' | 'environment' | 'unknown';
  file?: string;
  line?: number;
  message: string;
  suggestedFixSummary?: string;
  rawOutput: string;
}

export interface Patch {
  id: string;
  errorSignature: string;
  files: { path: string; diff: string }[];
  description: string;
  createdAt: ISODateString;
  appliedByJobId: string;
}

export interface RepairAttempt {
  attemptNumber: number;
  timestamp: ISODateString;
  buildResult?: BuildResult;
  testResult?: TestResult;
  errorAnalysis?: ErrorAnalysis;
  patch?: Patch;
  outcome: 'build-failed' | 'test-failed' | 'patch-applied' | 'success' | 'aborted';
}

export interface RepairSession {
  id: string;
  projectId: string;
  jobId: string;
  maxRetries: number;
  attempts: RepairAttempt[];
  status: 'running' | 'success' | 'exhausted' | 'aborted';
  preRepairSnapshotId?: string;
  startedAt: ISODateString;
  finishedAt?: ISODateString;
}

// ---------------------------------------------------------------------------
// Tool system
// ---------------------------------------------------------------------------

export interface ToolCallRequest {
  toolName: string;
  input: Record<string, unknown>;
  requestId: string;
  projectId?: string;
}

export interface ToolCallResult {
  requestId: string;
  toolName: string;
  success: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
}

export interface ToolDefinition<TInput = Record<string, unknown>, TOutput = unknown> {
  name: string;
  description: string;
  requiresSandbox: boolean;
  requiresNetwork: boolean;
  destructive: boolean;
  inputSchema: JSONSchema;
  handler: (input: TInput, context: ToolExecutionContext) => Promise<TOutput>;
}

export interface ToolExecutionContext {
  projectId?: string;
  environmentId?: string;
  jobId?: string;
  requestedByAI: boolean;
  workspaceRoot?: string;
  sandboxProviderType?: SandboxProviderType;
}

// Minimal JSON schema shape sufficient for tool input validation
export interface JSONSchema {
  type: 'object';
  properties: Record<string, { type: string; description?: string; enum?: string[]; items?: { type: string } }>;
  required?: string[];
}

// ---------------------------------------------------------------------------
// Policy engine
// ---------------------------------------------------------------------------

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  requiresUserConfirmation: boolean;
}

export interface PolicyContext {
  toolName: string;
  destructive: boolean;
  requiresNetwork: boolean;
  projectNetworkPermission: boolean;
  requestedByAI: boolean;
  targetPath?: string;
  workspaceRoot?: string;
  sandboxProviderType?: SandboxProviderType;
}

// ---------------------------------------------------------------------------
// Local AI / Intelligence
// ---------------------------------------------------------------------------

export interface PlanStep {
  stepNumber: number;
  description: string;
  toolCalls: ToolCallRequest[];
}

export interface ExecutionPlan {
  id: string;
  goal: string;
  steps: PlanStep[];
  createdAt: ISODateString;
}

export interface LocalModelInfo {
  provider: 'ollama' | 'llamacpp' | 'none';
  modelName?: string;
  available: boolean;
}

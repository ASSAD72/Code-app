import { EnvironmentPackDefinition, EnvironmentManifest, SandboxProviderType } from '@core/types';

/**
 * EnvironmentPack is the plugin contract described in spec section 6:
 * "Design the system with a Plugin/Pack Architecture. Do not hard-code
 * languages inside Core." Core, EnvironmentManager, BuildEngine, and
 * TestEngine only ever interact with this interface — never with a
 * hardcoded switch statement over language names.
 *
 * A pack owns:
 *   - its Dockerfile / WSL2 rootfs recipe (how the image is built)
 *   - its default runtime/SDK/package-manager versions
 *   - how to scaffold a new project of its type
 *   - its default build/test/run commands
 *
 * Additional packs (spec sections 6/7/28: Rust, C/C++, Go, Java, .NET,
 * Flutter, Android, React Native, databases) all implement this same
 * interface — see environments/packs/*.
 */
export interface EnvironmentPack {
  readonly definition: EnvironmentPackDefinition;

  /** Produce the manifest fields specific to this pack for a freshly created environment instance. */
  buildManifest(environmentId: string, providerType: SandboxProviderType): EnvironmentManifest;

  /** Scaffold a brand-new project of this pack's type into the given directory. Returns list of created file paths. */
  scaffoldProject(targetDir: string, projectName: string): Promise<string[]>;

  /** Path (relative to the pack's own directory) to the Dockerfile used to build this pack's image, if any. */
  getDockerfilePath(): string | null;
}

export abstract class BaseEnvironmentPack implements EnvironmentPack {
  abstract readonly definition: EnvironmentPackDefinition;

  buildManifest(environmentId: string, providerType: SandboxProviderType): EnvironmentManifest {
    const now = new Date().toISOString();
    return {
      environmentId,
      name: this.definition.displayName,
      version: this.definition.version,
      packId: this.definition.packId,
      baseImage: this.definition.baseImageTag,
      os: 'linux',
      architecture: 'x64',
      installedRuntimes: this.definition.defaultRuntimes,
      sdkVersions: Object.fromEntries(this.definition.defaultRuntimes.map((r) => [r.name, r.version])),
      packageManagers: this.definition.defaultPackageManagers,
      environmentVariables: {},
      requiredResources: { cpuCores: 2, memoryMB: 2048, pids: 512, timeoutMs: 20 * 60 * 1000 },
      capabilities: this.definition.defaultCapabilities,
      networkEnabledByDefault: false,
      checksum: '',
      createdAt: now,
      updatedAt: now,
      providerType,
    };
  }

  abstract scaffoldProject(targetDir: string, projectName: string): Promise<string[]>;

  getDockerfilePath(): string | null {
    return this.definition.dockerfile ?? null;
  }
}

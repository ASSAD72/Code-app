import { randomUUID, createHash } from 'crypto';
import { promises as fs, existsSync } from 'fs';
import path from 'path';
import * as tar from 'tar';
import { EnvironmentManifest, SandboxProviderType } from '@core/types';
import { EnvironmentRepository } from '@storage/repositories';
import { EnvironmentPackRegistry } from './EnvironmentPackRegistry';
import { SandboxProviderRegistry } from '../sandbox/SandboxProviderRegistry';

export interface EnvironmentCreateOptions {
  packId: string;
  preferredProviderOrder?: SandboxProviderType[];
  onProgress?: (line: string) => void;
  allowProcessFallback?: boolean;
}

/**
 * EnvironmentManager — spec section 5: create / delete / clone / snapshot /
 * restore / update / export / import / versioning, all keyed off the
 * environment.json manifest shape defined in core/types.
 */
export class EnvironmentManager {
  constructor(
    private readonly repository: EnvironmentRepository,
    private readonly packRegistry: EnvironmentPackRegistry,
    private readonly sandboxRegistry: SandboxProviderRegistry,
    private readonly environmentsStorageDir: string
  ) {}

  async create(options: EnvironmentCreateOptions): Promise<EnvironmentManifest> {
    const pack = this.packRegistry.get(options.packId);
    const preferenceOrder = options.preferredProviderOrder ?? pack.definition.supportedProviderTypes;

    const selection = await this.sandboxRegistry.selectBest(preferenceOrder, options.allowProcessFallback === true);
    if (!selection) {
      throw new Error(
        `No available sandbox provider found for pack "${options.packId}" (tried: ${preferenceOrder.join(', ')}). ` +
          `Run "codex doctor" to see what's missing.`
      );
    }

    const environmentId = randomUUID();
    const manifest = pack.buildManifest(environmentId, selection.type);
    const dockerfile = pack.getDockerfilePath();
    if (dockerfile) manifest.dockerfilePath = this.resolvePackDockerfile(options.packId, dockerfile);
    manifest.checksum = this.computeChecksum(manifest);

    options.onProgress?.(`Preparing image for ${manifest.name} using ${selection.type} provider...`);
    await selection.provider.prepareImage(manifest, options.onProgress);
    if (selection.type === 'docker' && selection.provider.getImageDigest) {
      manifest.imageDigest = await selection.provider.getImageDigest(manifest);
    }
    manifest.checksum = this.computeChecksum(manifest);
    this.repository.upsert(manifest);
    return manifest;
  }

  get(environmentId: string): EnvironmentManifest | null {
    return this.repository.get(environmentId);
  }

  list(): EnvironmentManifest[] {
    return this.repository.list();
  }

  async delete(environmentId: string): Promise<void> {
    const manifest = this.repository.get(environmentId);
    if (!manifest) return;
    const provider = this.sandboxRegistry.get(manifest.providerType);
    const instances = (await provider.listInstances()).filter((i) => i.environmentId === environmentId);
    for (const instance of instances) {
      await provider.destroyInstance(instance);
    }
    this.repository.delete(environmentId);
  }

  async clone(environmentId: string): Promise<EnvironmentManifest> {
    const source = this.repository.get(environmentId);
    if (!source) throw new Error(`Environment ${environmentId} not found`);
    const now = new Date().toISOString();
    const cloned: EnvironmentManifest = {
      ...source,
      environmentId: randomUUID(),
      name: `${source.name} (clone)`,
      createdAt: now,
      updatedAt: now,
    };
    cloned.checksum = this.computeChecksum(cloned);
    this.repository.upsert(cloned);
    return cloned;
  }

  async update(
    environmentId: string,
    patch: Partial<Pick<EnvironmentManifest, 'name' | 'environmentVariables' | 'requiredResources'>>
  ): Promise<EnvironmentManifest> {
    const existing = this.repository.get(environmentId);
    if (!existing) throw new Error(`Environment ${environmentId} not found`);
    const updated: EnvironmentManifest = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    updated.checksum = this.computeChecksum(updated);
    this.repository.upsert(updated);
    return updated;
  }

  /**
   * Export an environment as a portable EnvironmentPack archive (spec
   * section 14: "codex export" for environments). The archive contains
   * the manifest plus, for Docker-backed environments, an exported image
   * tarball so the whole thing can be reconstructed on another machine
   * without re-pulling from a registry.
   */
  async exportEnvironment(environmentId: string, outputDir: string): Promise<string> {
    const manifest = this.repository.get(environmentId);
    if (!manifest) throw new Error(`Environment ${environmentId} not found`);

    await fs.mkdir(outputDir, { recursive: true });
    const workDir = path.join(this.environmentsStorageDir, 'export-tmp', manifest.environmentId);
    await fs.mkdir(workDir, { recursive: true });

    const manifestPath = path.join(workDir, 'environment.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    const provider = this.sandboxRegistry.get(manifest.providerType);
    const archiveEntries = ['environment.json'];
    if (provider.exportEnvironmentImage && manifest.providerType === 'docker') {
      const imagePath = path.join(workDir, 'docker-image.tar');
      await provider.exportEnvironmentImage(manifest, imagePath);
      archiveEntries.push('docker-image.tar');
    }
    const outputArchivePath = path.join(outputDir, `${manifest.packId}-${manifest.environmentId}.codexenv.tar.gz`);
    await tar.create({ gzip: true, file: outputArchivePath, cwd: workDir }, archiveEntries);

    await fs.rm(workDir, { recursive: true, force: true });
    return outputArchivePath;
  }

  /**
   * Import a previously exported EnvironmentPack archive (spec section 14:
   * "codex import"). Recreates the environment record from its manifest;
   * if the referenced base image isn't present locally, `prepareImage`
   * will attempt to pull/rebuild it the next time the environment is used.
   */
  async importEnvironment(archivePath: string): Promise<EnvironmentManifest> {
    const workDir = path.join(this.environmentsStorageDir, 'import-tmp', randomUUID());
    await fs.mkdir(workDir, { recursive: true });
    try {
      await tar.extract({ file: archivePath, cwd: workDir, strict: true, preservePaths: false });

    const manifestPath = path.join(workDir, 'environment.json');
    const manifestRaw = await fs.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestRaw) as EnvironmentManifest;
    if (!manifest.environmentId || !manifest.packId || !manifest.providerType || !manifest.baseImage) throw new Error('Invalid environment manifest in archive.');

    const expectedChecksum = this.computeChecksum(manifest);
    if (manifest.checksum && manifest.checksum !== expectedChecksum) {
      throw new Error(
        `Checksum mismatch importing environment "${manifest.name}": archive may be corrupted or tampered with.`
      );
    }

    const provider = this.sandboxRegistry.get(manifest.providerType);
    if (manifest.providerType === 'docker') {
      const pack = this.packRegistry.get(manifest.packId);
      const dockerfile = pack.getDockerfilePath();
      if (dockerfile) manifest.dockerfilePath = this.resolvePackDockerfile(manifest.packId, dockerfile);
    }
    const imagePath = path.join(workDir, 'docker-image.tar');
    if (provider.importEnvironmentImage && manifest.providerType === 'docker' && await fs.access(imagePath).then(() => true).catch(() => false)) {
      await provider.importEnvironmentImage(manifest, imagePath);
    } else if (manifest.providerType === 'docker') {
      await provider.prepareImage(manifest);
    }
    if (manifest.providerType === 'docker' && provider.getImageDigest) {
      const actualDigest = await provider.getImageDigest(manifest);
      if (manifest.imageDigest && actualDigest && manifest.imageDigest !== actualDigest) {
        throw new Error(`Docker image digest mismatch importing environment "${manifest.name}".`);
      }
      manifest.imageDigest = actualDigest;
      manifest.checksum = this.computeChecksum(manifest);
    }
      this.repository.upsert(manifest);
      return manifest;
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private resolvePackDockerfile(packId: string, relativeDockerfile: string): string {
    const slug = packId.replace(/^codex-pack-/, '');
    const candidates = [
      path.resolve(process.cwd(), 'docker', slug, relativeDockerfile),
      ...(((process as typeof process & { resourcesPath?: string }).resourcesPath) ? [path.resolve((process as typeof process & { resourcesPath?: string }).resourcesPath!, 'docker', slug, relativeDockerfile)] : []),
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
  }

  private computeChecksum(manifest: EnvironmentManifest): string {
    const { checksum: _omit, dockerfilePath: _localDockerfile, ...rest } = manifest;
    return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
  }
}

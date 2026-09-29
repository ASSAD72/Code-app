import { describe, it, expect } from 'vitest';
import { EnvironmentPackRegistry } from '../../src/environments/EnvironmentPackRegistry';

describe('EnvironmentPackRegistry', () => {
  it('registers all built-in packs on construction', () => {
    const registry = new EnvironmentPackRegistry();
    const packs = registry.list();
    const expectedIds = [
      'codex-pack-node',
      'codex-pack-python',
      'codex-pack-rust',
      'codex-pack-cpp',
      'codex-pack-go',
      'codex-pack-java',
      'codex-pack-dotnet',
      'codex-pack-android',
      'codex-pack-flutter',
      'codex-pack-react-native',
      'codex-pack-postgres',
      'codex-pack-mysql',
      'codex-pack-redis',
      'codex-pack-mongo',
      'codex-pack-sqlite',
    ];
    for (const id of expectedIds) {
      expect(registry.has(id), `expected pack ${id} to be registered`).toBe(true);
    }
    expect(packs.length).toBe(expectedIds.length);
  });

  it('throws a clear error when requesting an unknown pack', () => {
    const registry = new EnvironmentPackRegistry();
    expect(() => registry.get('codex-pack-does-not-exist')).toThrow(/Unknown environment pack/);
  });

  it('filters packs by category', () => {
    const registry = new EnvironmentPackRegistry();
    const mobilePacks = registry.listByCategory('mobile');
    const mobileIds = mobilePacks.map((p) => p.definition.packId).sort();
    expect(mobileIds).toEqual(['codex-pack-android', 'codex-pack-flutter', 'codex-pack-react-native']);
  });

  it('allows registering a custom third-party pack without modifying built-ins', () => {
    const registry = new EnvironmentPackRegistry();
    const fakePack = {
      definition: {
        packId: 'codex-plugin-example',
        displayName: 'Example Plugin Pack',
        description: 'A test plugin pack.',
        category: 'other' as const,
        version: '1.0.0',
        baseImageTag: 'example:latest',
        defaultRuntimes: [],
        defaultPackageManagers: [],
        defaultCapabilities: [] as const,
        supportedProviderTypes: ['docker'] as const,
      },
      buildManifest: () => {
        throw new Error('not implemented in test fake');
      },
      scaffoldProject: async () => [],
      getDockerfilePath: () => null,
    };
    registry.register(fakePack);
    expect(registry.has('codex-plugin-example')).toBe(true);
    expect(registry.has('codex-pack-node')).toBe(true); // built-ins untouched
  });

  it('rejects registering a pack with a duplicate packId', () => {
    const registry = new EnvironmentPackRegistry();
    const duplicateNodePack = {
      definition: {
        packId: 'codex-pack-node',
        displayName: 'Duplicate Node',
        description: '',
        category: 'web' as const,
        version: '1.0.0',
        baseImageTag: 'x',
        defaultRuntimes: [],
        defaultPackageManagers: [],
        defaultCapabilities: [] as const,
        supportedProviderTypes: ['docker'] as const,
      },
      buildManifest: () => {
        throw new Error('n/a');
      },
      scaffoldProject: async () => [],
      getDockerfilePath: () => null,
    };
    expect(() => registry.register(duplicateNodePack)).toThrow(/already registered/);
  });
});

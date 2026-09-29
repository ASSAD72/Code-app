import { describe, it, expect } from 'vitest';
import { ProcessProvider } from '../../src/sandbox/providers/ProcessProvider';
import { EnvironmentManifest } from '@core/types';

/**
 * These tests exercise ProcessProvider for real — no mocking — since it
 * is designed to run plain host commands with no external daemon
 * dependency (unlike Docker/WSL2/WindowsSandbox, which genuinely require
 * infrastructure this test sandbox doesn't have). This gives real,
 * meaningful coverage of the one sandbox backend that CAN be fully
 * exercised in any CI environment, including this one.
 */
describe('ProcessProvider', () => {
  const fakeEnvironment: EnvironmentManifest = {
    environmentId: 'env-1',
    name: 'test-env',
    version: '1.0.0',
    packId: 'codex-pack-node',
    baseImage: 'n/a',
    os: 'linux',
    architecture: 'x64',
    installedRuntimes: [],
    sdkVersions: {},
    packageManagers: [],
    environmentVariables: {},
    requiredResources: {},
    capabilities: ['filesystem', 'process'],
    networkEnabledByDefault: false,
    checksum: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    providerType: 'process',
  };

  it('reports itself as always available', async () => {
    const provider = new ProcessProvider();
    const availability = await provider.isAvailable();
    expect(availability.available).toBe(true);
  });

  it('creates an instance and executes a real echo command', async () => {
    const provider = new ProcessProvider();
    const handle = await provider.createInstance({
      environment: fakeEnvironment,
      projectId: 'proj-1',
      workspaceHostPath: '/tmp',
      networkEnabled: false,
      resourceLimits: {},
    });

    const result = await provider.exec(handle, { command: ['echo', 'hello-from-codex'] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello-from-codex');
    expect(result.timedOut).toBe(false);

    await provider.destroyInstance(handle);
  });

  it('captures a non-zero exit code from a failing command', async () => {
    const provider = new ProcessProvider();
    const handle = await provider.createInstance({
      environment: fakeEnvironment,
      projectId: 'proj-2',
      workspaceHostPath: '/tmp',
      networkEnabled: false,
      resourceLimits: {},
    });

    const result = await provider.exec(handle, { command: ['sh', '-c', 'exit 7'] });
    expect(result.exitCode).toBe(7);

    await provider.destroyInstance(handle);
  });

  it('enforces the configured timeout on a long-running command', async () => {
    const provider = new ProcessProvider();
    const handle = await provider.createInstance({
      environment: fakeEnvironment,
      projectId: 'proj-3',
      workspaceHostPath: '/tmp',
      networkEnabled: false,
      resourceLimits: {},
    });

    const result = await provider.exec(handle, {
      command: ['sh', '-c', 'sleep 5'],
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);

    await provider.destroyInstance(handle);
  }, 10000);

  it('streams stdout chunks via the onStdout callback', async () => {
    const provider = new ProcessProvider();
    const handle = await provider.createInstance({
      environment: fakeEnvironment,
      projectId: 'proj-4',
      workspaceHostPath: '/tmp',
      networkEnabled: false,
      resourceLimits: {},
    });

    let streamed = '';
    await provider.exec(handle, {
      command: ['echo', 'streamed-output'],
      onStdout: (chunk) => {
        streamed += chunk;
      },
    });
    expect(streamed).toContain('streamed-output');

    await provider.destroyInstance(handle);
  });

  it('lists created instances and removes them on destroy', async () => {
    const provider = new ProcessProvider();
    const handle = await provider.createInstance({
      environment: fakeEnvironment,
      projectId: 'proj-5',
      workspaceHostPath: '/tmp',
      networkEnabled: false,
      resourceLimits: {},
    });

    const listedBefore = await provider.listInstances();
    expect(listedBefore.some((i) => i.instanceId === handle.instanceId)).toBe(true);

    await provider.destroyInstance(handle);
    const listedAfter = await provider.listInstances();
    expect(listedAfter.some((i) => i.instanceId === handle.instanceId)).toBe(false);
  });
});

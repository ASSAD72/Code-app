import { describe, expect, it } from 'vitest';
import { SandboxProviderRegistry } from '../../src/sandbox/SandboxProviderRegistry';

describe('SandboxProviderRegistry process fallback', () => {
  it('does not select ProcessProvider unless explicitly allowed', async () => {
    const registry = new SandboxProviderRegistry({
      docker: unavailableProvider('docker'),
      wsl2: unavailableProvider('wsl2'),
      'windows-sandbox': unavailableProvider('windows-sandbox'),
      process: availableProvider('process'),
    });
    expect(await registry.selectBest(['docker', 'wsl2', 'windows-sandbox', 'process'])).toBeNull();
    expect((await registry.selectBest(['docker', 'process'], true))?.type).toBe('process');
  });
});

function availableProvider(type: string): any {
  return { type, isAvailable: async () => ({ available: true }) };
}
function unavailableProvider(type: string): any {
  return { type, isAvailable: async () => ({ available: false, reason: 'test' }) };
}

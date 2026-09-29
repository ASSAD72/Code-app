import { describe, expect, it, vi } from 'vitest';
import { ToolExecutor } from '../../src/tools/ToolExecutor';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import { PolicyEngine } from '../../src/policy/PolicyEngine';

describe('ToolExecutor security boundary', () => {
  it('rejects AI path traversal', async () => {
    const registry = new ToolRegistry();
    registry.register({ name: 'filesystem.write', description: 'write', requiresSandbox: false, requiresNetwork: false, destructive: true,
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path','content'] },
      handler: vi.fn(async () => ({ ok: true })) });
    const executor = new ToolExecutor(registry, new PolicyEngine());
    const result = await executor.dispatch({ toolName: 'filesystem.write', requestId: '1', input: { path: '../escape.txt', content: 'x' } }, { requestedByAI: true, workspaceRoot: '/tmp/project' }, false);
    expect(result.success).toBe(false);
  });

  it('does not allow AI to execute through ProcessProvider', async () => {
    const registry = new ToolRegistry();
    registry.register({ name: 'process.run', description: 'run', requiresSandbox: true, requiresNetwork: false, destructive: false,
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] },
      handler: vi.fn(async () => ({ ok: true })) });
    const projectManager = { get: vi.fn(() => ({ id: 'p', sourcePath: '/tmp/project', environmentId: 'e', networkPermission: false })) } as any;
    const environmentManager = { get: vi.fn(() => ({ environmentId: 'e', providerType: 'process' })) } as any;
    const executor = new ToolExecutor(registry, new PolicyEngine(), projectManager, environmentManager, { ensureInstance: vi.fn() } as any);
    const result = await executor.dispatch({ toolName: 'process.run', requestId: '2', input: { projectId: 'p' } }, { requestedByAI: true }, false);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ProcessProvider/);
  });
});

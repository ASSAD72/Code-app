import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '@tools/ToolRegistry';
import { ToolExecutor } from '@tools/ToolExecutor';
import { PolicyEngine } from '@policy/PolicyEngine';
import { ToolDefinition } from '@core/types';

describe('ToolExecutor (AI -> Planner -> ToolCalls -> PolicyEngine -> Sandbox boundary)', () => {
  const networkTool: ToolDefinition<Record<string, never>, { ok: boolean }> = {
    name: 'test.network-op',
    description: 'Requires network.',
    requiresSandbox: true,
    requiresNetwork: true,
    destructive: false,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ ok: true }),
  };

  const destructiveTool: ToolDefinition<{ path: string }, { deleted: boolean }> = {
    name: 'test.destructive-op',
    description: 'A destructive operation.',
    requiresSandbox: false,
    requiresNetwork: false,
    destructive: true,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: async () => ({ deleted: true }),
  };

  function buildExecutor() {
    const registry = new ToolRegistry();
    registry.register(networkTool);
    registry.register(destructiveTool);
    const policy = new PolicyEngine();
    return { executor: new ToolExecutor(registry, policy), policy };
  }

  it('blocks a network-requiring tool call when the project lacks network permission', async () => {
    const { executor } = buildExecutor();
    const result = await executor.dispatch(
      { toolName: 'test.network-op', input: {}, requestId: 'r1' },
      { requestedByAI: true },
      false
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Blocked by policy/);
  });

  it('allows a network-requiring tool call when the project has network permission', async () => {
    const { executor } = buildExecutor();
    const result = await executor.dispatch(
      { toolName: 'test.network-op', input: {}, requestId: 'r2' },
      { requestedByAI: true },
      true
    );
    expect(result.success).toBe(true);
  });

  it('blocks a destructive tool call until the user confirms it', async () => {
    const { executor } = buildExecutor();
    const first = await executor.dispatch(
      { toolName: 'test.destructive-op', input: { path: 'foo.txt' }, requestId: 'r3' },
      { requestedByAI: false },
      false,
      'foo.txt'
    );
    expect(first.success).toBe(false);

    executor.confirmPendingDestructiveAction('test.destructive-op', 'foo.txt');

    const second = await executor.dispatch(
      { toolName: 'test.destructive-op', input: { path: 'foo.txt' }, requestId: 'r4' },
      { requestedByAI: false },
      false,
      'foo.txt'
    );
    expect(second.success).toBe(true);
  });

  it('never lets an unknown tool reach the handler stage', async () => {
    const { executor } = buildExecutor();
    const result = await executor.dispatch(
      { toolName: 'nonexistent.tool', input: {}, requestId: 'r5' },
      { requestedByAI: true },
      true
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown tool/);
  });
});

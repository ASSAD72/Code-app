import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '@tools/ToolRegistry';
import { ToolDefinition } from '@core/types';

describe('ToolRegistry', () => {
  const echoTool: ToolDefinition<{ message: string }, { echoed: string }> = {
    name: 'test.echo',
    description: 'Echoes the input message.',
    requiresSandbox: false,
    requiresNetwork: false,
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
    handler: async (input) => ({ echoed: input.message }),
  };

  it('registers and retrieves a tool by name', () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    expect(registry.get('test.echo')).toBeDefined();
    expect(registry.list()).toHaveLength(1);
  });

  it('throws when registering a duplicate tool name', () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    expect(() => registry.register(echoTool)).toThrow(/already registered/);
  });

  it('executes a registered tool and returns its output', async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    const result = await registry.execute(
      { toolName: 'test.echo', input: { message: 'hi' }, requestId: 'req-1' },
      { requestedByAI: false }
    );
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ echoed: 'hi' });
  });

  it('returns a failure result for an unknown tool', async () => {
    const registry = new ToolRegistry();
    const result = await registry.execute(
      { toolName: 'does.not.exist', input: {}, requestId: 'req-2' },
      { requestedByAI: false }
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown tool/);
  });

  it('rejects a tool call missing a required input field', async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    const result = await registry.execute(
      { toolName: 'test.echo', input: {}, requestId: 'req-3' },
      { requestedByAI: false }
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/missing required field/);
  });

  it('captures a thrown handler error as a failure result rather than propagating', async () => {
    const registry = new ToolRegistry();
    const throwingTool: ToolDefinition<Record<string, never>, never> = {
      name: 'test.throws',
      description: 'Always throws.',
      requiresSandbox: false,
      requiresNetwork: false,
      destructive: false,
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        throw new Error('boom');
      },
    };
    registry.register(throwingTool);
    const result = await registry.execute(
      { toolName: 'test.throws', input: {}, requestId: 'req-4' },
      { requestedByAI: false }
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
  });
});

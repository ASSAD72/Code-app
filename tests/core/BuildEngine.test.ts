import { describe, it, expect, vi } from 'vitest';
import { BuildEngine } from '../../src/core/build/BuildEngine';

describe('BuildEngine command chaining', () => {
  it('executes && segments sequentially instead of passing shell syntax as argv', async () => {
    const job = { id: 'j1', status: 'QUEUED', maxRetries: 0, retryCount: 0 };
    const jobManager = {
      create: vi.fn(() => job),
      runJob: vi.fn(async (_id: string, fn: any) => { await fn(job, () => undefined); }),
      setExitCode: vi.fn(),
      isCancellationRequested: vi.fn(() => false),
    };
    const calls: string[][] = [];
    const processManager = { exec: vi.fn(async (_p: any, _e: any, command: string[]) => { calls.push(command); return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false }; }) };
    const policy = { evaluate: vi.fn(() => ({ allowed: true, reason: 'ok', requiresUserConfirmation: false })) };
    const engine = new BuildEngine(jobManager as any, processManager as any, policy as any);
    const project: any = { id: 'p', name: 'p', commands: { buildCommand: 'cmake -B build && cmake --build build' } };
    const env: any = { environmentId: 'e', networkEnabledByDefault: false };
    const result = await engine.build(project, env);
    expect(result.success).toBe(true);
    expect(calls).toEqual([['cmake','-B','build'], ['cmake','--build','build']]);
  });
});

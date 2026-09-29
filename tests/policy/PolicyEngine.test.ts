import { describe, it, expect, beforeEach } from 'vitest';
import { PolicyEngine } from '@policy/PolicyEngine';

describe('PolicyEngine', () => {
  let policy: PolicyEngine;

  beforeEach(() => {
    policy = new PolicyEngine();
  });

  it('denies network-requiring tools when project has no network permission', () => {
    const decision = policy.evaluate({
      toolName: 'package.install',
      destructive: false,
      requiresNetwork: true,
      projectNetworkPermission: false,
      requestedByAI: false,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.requiresUserConfirmation).toBe(true);
  });

  it('allows network-requiring tools when project has network permission', () => {
    const decision = policy.evaluate({
      toolName: 'package.install',
      destructive: false,
      requiresNetwork: true,
      projectNetworkPermission: true,
      requestedByAI: false,
    });
    expect(decision.allowed).toBe(true);
  });

  it('denies destructive actions until explicitly confirmed', () => {
    const context = {
      toolName: 'filesystem.delete',
      destructive: true,
      requiresNetwork: false,
      projectNetworkPermission: false,
      requestedByAI: false,
      targetPath: 'src/index.ts',
    };
    const before = policy.evaluate(context);
    expect(before.allowed).toBe(false);

    policy.confirmDestructive(context);
    const after = policy.evaluate(context);
    expect(after.allowed).toBe(true);
  });

  it('denies AI-originated tool calls that target paths outside the workspace', () => {
    const decision = policy.evaluate({
      toolName: 'filesystem.write',
      destructive: false,
      requiresNetwork: false,
      projectNetworkPermission: false,
      requestedByAI: true,
      targetPath: '/etc/passwd',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.requiresUserConfirmation).toBe(false); // no confirmation path — hard deny
  });

  it('denies AI-originated tool calls using path traversal to escape the workspace', () => {
    const decision = policy.evaluate({
      toolName: 'filesystem.write',
      destructive: false,
      requiresNetwork: false,
      projectNetworkPermission: false,
      requestedByAI: true,
      targetPath: '../../etc/passwd',
    });
    expect(decision.allowed).toBe(false);
  });

  it('allows a human (non-AI) tool call to a workspace-relative path', () => {
    const decision = policy.evaluate({
      toolName: 'filesystem.write',
      destructive: false,
      requiresNetwork: false,
      projectNetworkPermission: false,
      requestedByAI: false,
      targetPath: 'src/index.ts',
    });
    expect(decision.allowed).toBe(true);
  });

  it('allows AI-originated calls for workspace-relative paths', () => {
    const decision = policy.evaluate({
      toolName: 'filesystem.read',
      destructive: false,
      requiresNetwork: false,
      projectNetworkPermission: false,
      requestedByAI: true,
      targetPath: 'src/index.ts',
    });
    expect(decision.allowed).toBe(true);
  });

  it('clearConfirmations revokes previously confirmed destructive actions', () => {
    const context = {
      toolName: 'snapshot.restore',
      destructive: true,
      requiresNetwork: false,
      projectNetworkPermission: false,
      requestedByAI: false,
    };
    policy.confirmDestructive(context);
    expect(policy.evaluate(context).allowed).toBe(true);

    policy.clearConfirmations();
    expect(policy.evaluate(context).allowed).toBe(false);
  });
});

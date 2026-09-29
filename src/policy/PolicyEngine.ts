import path from 'path';
import { PolicyContext, PolicyDecision } from '@core/types';

export class PolicyEngine {
  private confirmedDestructiveActions = new Set<string>();

  evaluate(context: PolicyContext): PolicyDecision {
    if (context.requiresNetwork && !context.projectNetworkPermission) {
      return { allowed: false, reason: 'Tool requires network access, but this project does not have network permission enabled.', requiresUserConfirmation: true };
    }
    if (context.destructive && !this.confirmedDestructiveActions.has(this.destructiveKey(context))) {
      return { allowed: false, reason: `Tool "${context.toolName}" is destructive and has not yet been confirmed by the user.`, requiresUserConfirmation: true };
    }
    if (context.requestedByAI && context.targetPath) {
      const outside = context.workspaceRoot
        ? this.isOutsideWorkspace(context.targetPath, context.workspaceRoot)
        : path.isAbsolute(context.targetPath) || context.targetPath.split(/[\\/]/).includes('..');
      if (outside) return { allowed: false, reason: 'AI-originated tool calls must target a path inside the project workspace.', requiresUserConfirmation: false };
    }
    if (context.requestedByAI && context.sandboxProviderType === 'process') {
      return { allowed: false, reason: 'AI-originated sandbox execution cannot use the host ProcessProvider.', requiresUserConfirmation: false };
    }
    return { allowed: true, reason: 'Allowed by policy.', requiresUserConfirmation: false };
  }

  confirmDestructive(context: PolicyContext): void { this.confirmedDestructiveActions.add(this.destructiveKey(context)); }
  clearConfirmations(): void { this.confirmedDestructiveActions.clear(); }
  private destructiveKey(context: PolicyContext): string { return `${context.toolName}:${context.targetPath ?? ''}`; }

  private isOutsideWorkspace(targetPath: string, workspaceRoot: string): boolean {
    const root = path.resolve(workspaceRoot);
    const target = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(root, targetPath);
    const relative = path.relative(root, target);
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  }
}

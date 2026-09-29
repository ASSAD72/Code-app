/**
 * NetworkPolicy centralizes the "network disabled by default" rule
 * (spec sections 3 and 23). Every SandboxProvider must consult this
 * before creating an instance with network access, and every network
 * grant must be traceable to an explicit user action.
 */

export interface NetworkGrant {
  projectId: string;
  grantedAt: string;
  grantedBy: 'user';
  reason?: string;
  scope: 'session' | 'persistent';
}

export class NetworkPolicy {
  private grants = new Map<string, NetworkGrant>();

  /** Projects always start network-disabled. This is not configurable away from false. */
  static readonly DEFAULT_NETWORK_ENABLED = false;

  isNetworkAllowed(projectId: string): boolean {
    return this.grants.has(projectId);
  }

  grant(projectId: string, scope: 'session' | 'persistent', reason?: string): NetworkGrant {
    const grant: NetworkGrant = {
      projectId,
      grantedAt: new Date().toISOString(),
      grantedBy: 'user',
      reason,
      scope,
    };
    this.grants.set(projectId, grant);
    return grant;
  }

  revoke(projectId: string): void {
    this.grants.delete(projectId);
  }

  getGrant(projectId: string): NetworkGrant | undefined {
    return this.grants.get(projectId);
  }

  /**
   * Called at the start of every new session for projects whose grant
   * scope was 'session' only — clears ephemeral grants so network access
   * never silently persists across app restarts unless the user marked
   * it persistent.
   */
  clearSessionGrants(): void {
    for (const [projectId, grant] of this.grants.entries()) {
      if (grant.scope === 'session') {
        this.grants.delete(projectId);
      }
    }
  }
}

import { SandboxProviderType } from '@core/types';
import { SandboxProvider } from './SandboxProvider';
import { DockerProvider } from './providers/DockerProvider';
import { WSL2Provider } from './providers/WSL2Provider';
import { WindowsSandboxProvider } from './providers/WindowsSandboxProvider';
import { ProcessProvider } from './providers/ProcessProvider';

/**
 * SandboxProviderRegistry is the single place Core asks "give me a
 * provider" — it owns provider selection/fallback so no other subsystem
 * needs to know which backends exist or their preference order.
 *
 * Selection order favors the strongest isolation first (spec section 3's
 * "protect the host" priority), falling back only when a backend is
 * genuinely unavailable — never silently favoring the weak ProcessProvider
 * over a working Docker install.
 */
export class SandboxProviderRegistry {
  private providers: Map<SandboxProviderType, SandboxProvider>;

  constructor(overrides?: Partial<Record<SandboxProviderType, SandboxProvider>>) {
    this.providers = new Map<SandboxProviderType, SandboxProvider>([
      ['docker', overrides?.docker ?? new DockerProvider()],
      ['wsl2', overrides?.wsl2 ?? new WSL2Provider()],
      ['windows-sandbox', overrides?.['windows-sandbox'] ?? new WindowsSandboxProvider()],
      ['process', overrides?.process ?? new ProcessProvider()],
    ]);
  }

  get(type: SandboxProviderType): SandboxProvider {
    const provider = this.providers.get(type);
    if (!provider) throw new Error(`No sandbox provider registered for type "${type}"`);
    return provider;
  }

  register(type: SandboxProviderType, provider: SandboxProvider): void {
    this.providers.set(type, provider);
  }

  /**
   * Returns the best available provider for a set of acceptable types, in
   * the caller's preference order. Used by EnvironmentManager when an
   * EnvironmentPack declares `supportedProviderTypes`.
   */
  async selectBest(
    preferenceOrder: SandboxProviderType[],
    allowProcessFallback = false
  ): Promise<{ provider: SandboxProvider; type: SandboxProviderType } | null> {
    for (const type of preferenceOrder) {
      if (type === 'process' && !allowProcessFallback) continue;
      const provider = this.providers.get(type);
      if (!provider) continue;
      const availability = await provider.isAvailable();
      if (availability.available) {
        return { provider, type };
      }
    }
    return null;
  }

  async getAvailability(): Promise<Record<SandboxProviderType, { available: boolean; reason?: string }>> {
    const entries = await Promise.all(
      Array.from(this.providers.entries()).map(async ([type, provider]) => [type, await provider.isAvailable()] as const)
    );
    return Object.fromEntries(entries) as Record<SandboxProviderType, { available: boolean; reason?: string }>;
  }
}

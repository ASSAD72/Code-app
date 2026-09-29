import { ResourceLimits, ResourceUsageSample } from '@core/types';

/**
 * ResourceManager tracks resource usage samples for running sandbox
 * instances and exposes limit-checking used by SandboxProvider
 * implementations and surfaced to the GUI (spec section 22).
 *
 * It does not itself enforce limits at the OS/container level — that is
 * each SandboxProvider's job (e.g. Docker's --cpus/--memory/--pids-limit
 * flags). ResourceManager's job is: aggregate samples, detect breaches,
 * and provide a single place the GUI/CLI can query for live numbers.
 */
export class ResourceManager {
  private usageHistory = new Map<string, ResourceUsageSample[]>();
  private readonly maxSamplesPerInstance = 500;

  recordSample(instanceId: string, sample: ResourceUsageSample): void {
    const history = this.usageHistory.get(instanceId) ?? [];
    history.push(sample);
    if (history.length > this.maxSamplesPerInstance) {
      history.shift();
    }
    this.usageHistory.set(instanceId, history);
  }

  getHistory(instanceId: string): ResourceUsageSample[] {
    return this.usageHistory.get(instanceId) ?? [];
  }

  getLatest(instanceId: string): ResourceUsageSample | undefined {
    const history = this.usageHistory.get(instanceId);
    return history && history.length > 0 ? history[history.length - 1] : undefined;
  }

  clearHistory(instanceId: string): void {
    this.usageHistory.delete(instanceId);
  }

  checkBreach(sample: ResourceUsageSample, limits: ResourceLimits): string[] {
    const breaches: string[] = [];
    if (limits.memoryMB !== undefined && sample.memoryMB > limits.memoryMB) {
      breaches.push(`Memory usage ${sample.memoryMB}MB exceeds limit ${limits.memoryMB}MB`);
    }
    if (limits.pids !== undefined && sample.pids !== undefined && sample.pids > limits.pids) {
      breaches.push(`Process count ${sample.pids} exceeds limit ${limits.pids}`);
    }
    if (limits.cpuCores !== undefined) {
      const cpuPercentLimit = limits.cpuCores * 100;
      if (sample.cpuPercent > cpuPercentLimit * 1.05) {
        // 5% grace margin for sampling jitter
        breaches.push(`CPU usage ${sample.cpuPercent.toFixed(1)}% exceeds limit ${cpuPercentLimit}%`);
      }
    }
    return breaches;
  }

  static defaultLimitsFor(profile: 'light' | 'standard' | 'heavy'): ResourceLimits {
    switch (profile) {
      case 'light':
        return { cpuCores: 1, memoryMB: 1024, pids: 256, timeoutMs: 5 * 60 * 1000 };
      case 'heavy':
        return { cpuCores: 4, memoryMB: 8192, pids: 2048, timeoutMs: 60 * 60 * 1000 };
      case 'standard':
      default:
        return { cpuCores: 2, memoryMB: 2048, pids: 512, timeoutMs: 20 * 60 * 1000 };
    }
  }
}

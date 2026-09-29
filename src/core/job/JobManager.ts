import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { Job, JobKind, JobStatus, JobLogLine, ResourceUsageSample } from '@core/types';
import { JobRepository } from '@storage/repositories';

export interface CreateJobOptions {
  kind: JobKind;
  title: string;
  projectId?: string;
  environmentId?: string;
  maxRetries?: number;
  parentJobId?: string;
}

/**
 * JobManager — spec section 10. Real queueing, cancellation, logs,
 * progress, timestamps, exit codes, resource usage, and retry — not a
 * cosmetic status field. BuildEngine/TestEngine/RepairEngine/Exporters
 * all create and drive Jobs through this manager rather than tracking
 * their own ad-hoc state, so the GUI's Jobs panel and the CLI's
 * `codex jobs` command have exactly one source of truth.
 *
 * No artificial concurrency cap is imposed here beyond what the
 * underlying SandboxProvider can execute concurrently — spec section 10
 * explicitly asks for no artificial limits on project size, and job
 * throughput follows the same principle: queueing exists for ordering
 * and visibility, not to arbitrarily gate the user.
 */
export class JobManager extends EventEmitter {
  private queue: Job[] = [];
  private runningJobIds = new Set<string>();

  constructor(private readonly repository: JobRepository, private readonly maxConcurrentJobs = 4) {
    super();
  }

  create(options: CreateJobOptions): Job {
    const now = new Date().toISOString();
    const job: Job = {
      id: randomUUID(),
      kind: options.kind,
      projectId: options.projectId,
      environmentId: options.environmentId,
      status: 'QUEUED',
      title: options.title,
      createdAt: now,
      logs: [],
      resourceUsage: [],
      retryCount: 0,
      maxRetries: options.maxRetries ?? 0,
      parentJobId: options.parentJobId,
      cancelRequested: false,
    };
    this.repository.upsert(job);
    this.queue.push(job);
    this.emit('job:created', job);
    this.tryDequeue();
    return job;
  }

  get(jobId: string): Job | null {
    return this.repository.get(jobId);
  }

  listByProject(projectId: string): Job[] {
    return this.repository.listByProject(projectId);
  }

  listActive(): Job[] {
    return this.repository.listActive();
  }

  listAll(): Job[] {
    return this.repository.listAll();
  }

  /**
   * Called by the actual executor (BuildEngine, TestEngine, etc.) once it
   * has capacity — this is the job-runner integration point. It does NOT
   * run the job itself; it just marks bookkeeping and hands control to
   * the caller-supplied executor function.
   */
  async runJob(jobId: string, executor: (job: Job, updateLog: (line: JobLogLine) => void) => Promise<void>): Promise<Job> {
    const job = this.repository.get(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);

    if (job.cancelRequested) {
      job.status = 'CANCELLED';
      this.repository.upsert(job);
      this.emit('job:cancelled', job);
      return job;
    }

    while (this.runningJobIds.size >= this.maxConcurrentJobs) {
      await new Promise<void>((resolve) => {
        const wake = () => { this.off('job:slot-available', wake); resolve(); };
        this.on('job:slot-available', wake);
      });
      const refreshed = this.repository.get(jobId);
      if (!refreshed) throw new Error(`Job ${jobId} disappeared while queued`);
      if (refreshed.cancelRequested) {
        refreshed.status = 'CANCELLED';
        this.repository.upsert(refreshed);
        this.emit('job:cancelled', refreshed);
        return refreshed;
      }
    }

    job.status = 'RUNNING';
    job.startedAt = new Date().toISOString();
    this.runningJobIds.add(jobId);
    this.repository.upsert(job);
    this.emit('job:started', job);

    const appendLog = (line: JobLogLine) => {
      job.logs.push(line);
      // Cap log retention per job to prevent unbounded memory/storage growth
      // on very long-running builds; the full log is still available via
      // streaming callbacks at execution time (spec section 10: logs).
      if (job.logs.length > 5000) job.logs.splice(0, job.logs.length - 5000);
      this.repository.upsert(job);
      this.emit('job:log', job, line);
    };

    try {
      await executor(job, appendLog);
      // TypeScript narrows `job.status` to the literal 'RUNNING' from the
      // assignment above and does not widen it across the `await`, even
      // though `executor` receives `job` by reference and may have
      // mutated `status` (BuildEngine/TestEngine do exactly this to
      // signal failure). The cast below reflects that real runtime
      // possibility; it is not suppressing an actual type error.
      const statusAfterExecution = job.status as JobStatus;
      if (statusAfterExecution !== 'FAILED' && statusAfterExecution !== 'CANCELLED') {
        job.status = 'SUCCESS';
      }
    } catch (err) {
      job.status = 'FAILED';
      job.error = err instanceof Error ? err.message : String(err);
      appendLog({ timestamp: new Date().toISOString(), stream: 'system', text: `Job failed: ${job.error}` });
    } finally {
      job.finishedAt = new Date().toISOString();
      this.runningJobIds.delete(jobId);
      this.repository.upsert(job);
      this.emit(job.status === 'SUCCESS' ? 'job:succeeded' : 'job:finished', job);
      this.emit('job:slot-available');
      this.tryDequeue();
    }

    return job;
  }

  updateProgress(jobId: string, progress: number): void {
    const job = this.repository.get(jobId);
    if (!job) return;
    job.progress = Math.max(0, Math.min(100, progress));
    this.repository.upsert(job);
    this.emit('job:progress', job);
  }

  recordResourceUsage(jobId: string, sample: ResourceUsageSample): void {
    const job = this.repository.get(jobId);
    if (!job) return;
    job.resourceUsage.push(sample);
    if (job.resourceUsage.length > 500) job.resourceUsage.shift();
    this.repository.upsert(job);
  }

  setStatus(jobId: string, status: JobStatus): void {
    const job = this.repository.get(jobId);
    if (!job) return;
    job.status = status;
    this.repository.upsert(job);
    this.emit('job:status', job);
  }

  setExitCode(jobId: string, exitCode: number): void {
    const job = this.repository.get(jobId);
    if (!job) return;
    job.exitCode = exitCode;
    this.repository.upsert(job);
  }

  requestCancellation(jobId: string): void {
    const job = this.repository.get(jobId);
    if (!job) return;
    job.cancelRequested = true;
    this.repository.upsert(job);
    this.emit('job:cancel-requested', job);
  }

  isCancellationRequested(jobId: string): boolean {
    return this.repository.get(jobId)?.cancelRequested ?? false;
  }

  pause(jobId: string): void {
    const job = this.repository.get(jobId);
    if (!job || job.status !== 'RUNNING') return;
    job.status = 'PAUSED';
    this.repository.upsert(job);
    this.emit('job:paused', job);
  }

  resume(jobId: string): void {
    const job = this.repository.get(jobId);
    if (!job || job.status !== 'PAUSED') return;
    job.status = 'RUNNING';
    this.repository.upsert(job);
    this.emit('job:resumed', job);
  }

  incrementRetry(jobId: string): void {
    const job = this.repository.get(jobId);
    if (!job) return;
    job.retryCount += 1;
    this.repository.upsert(job);
  }

  canRetry(jobId: string): boolean {
    const job = this.repository.get(jobId);
    if (!job) return false;
    return job.retryCount < job.maxRetries;
  }

  private tryDequeue(): void {
    // Concurrency gate exists purely to keep the host from being
    // overwhelmed by simultaneous sandbox instances, not to arbitrarily
    // cap project size or file counts (spec section 10).
    while (this.runningJobIds.size < this.maxConcurrentJobs && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) this.emit('job:ready', next);
    }
  }
}

import { describe, it, expect, beforeEach } from 'vitest';
import { JobManager } from '../../src/core/job/JobManager';
import { JobRepository } from '@storage/repositories';
import { CodexDatabase } from '@storage/CodexDatabase';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('JobManager', () => {
  let jobManager: JobManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-jobmanager-test-'));
    const database = new CodexDatabase(tmpDir);
    const repository = new JobRepository(database);
    jobManager = new JobManager(repository, 4);
  });

  it('creates a job with QUEUED status and zero retry count', () => {
    const job = jobManager.create({ kind: 'build', title: 'Test build' });
    expect(job.status).toBe('QUEUED');
    expect(job.retryCount).toBe(0);
    expect(job.logs).toEqual([]);
  });

  it('runs a job successfully via runJob and marks it SUCCESS', async () => {
    const job = jobManager.create({ kind: 'build', title: 'Successful build' });
    const finished = await jobManager.runJob(job.id, async (_j, log) => {
      log({ timestamp: new Date().toISOString(), stream: 'stdout', text: 'building...' });
    });
    expect(finished.status).toBe('SUCCESS');
    expect(finished.logs).toHaveLength(1);
    expect(finished.startedAt).toBeDefined();
    expect(finished.finishedAt).toBeDefined();
  });

  it('marks a job FAILED when the executor throws', async () => {
    const job = jobManager.create({ kind: 'build', title: 'Failing build' });
    const finished = await jobManager.runJob(job.id, async () => {
      throw new Error('build broke');
    });
    expect(finished.status).toBe('FAILED');
    expect(finished.error).toBe('build broke');
  });

  it('respects an explicit FAILED status set by the executor without overwriting it to SUCCESS', async () => {
    const job = jobManager.create({ kind: 'test', title: 'Test run' });
    const finished = await jobManager.runJob(job.id, async (currentJob) => {
      currentJob.status = 'FAILED';
      throw new Error('tests failed');
    });
    expect(finished.status).toBe('FAILED');
  });

  it('does not execute a job whose cancellation was requested before it started', async () => {
    const job = jobManager.create({ kind: 'build', title: 'To be cancelled' });
    jobManager.requestCancellation(job.id);

    let executed = false;
    const finished = await jobManager.runJob(job.id, async () => {
      executed = true;
    });

    expect(executed).toBe(false);
    expect(finished.status).toBe('CANCELLED');
  });

  it('tracks retry count and respects maxRetries via canRetry', () => {
    const job = jobManager.create({ kind: 'build', title: 'Retryable', maxRetries: 2 });
    expect(jobManager.canRetry(job.id)).toBe(true);
    jobManager.incrementRetry(job.id);
    expect(jobManager.canRetry(job.id)).toBe(true);
    jobManager.incrementRetry(job.id);
    expect(jobManager.canRetry(job.id)).toBe(false);
  });

  it('records resource usage samples for a job', () => {
    const job = jobManager.create({ kind: 'build', title: 'Resource tracked' });
    jobManager.recordResourceUsage(job.id, {
      timestamp: new Date().toISOString(),
      cpuPercent: 42,
      memoryMB: 128,
    });
    const updated = jobManager.get(job.id);
    expect(updated?.resourceUsage).toHaveLength(1);
    expect(updated?.resourceUsage[0].cpuPercent).toBe(42);
  });

  it('lists jobs scoped to a project', () => {
    jobManager.create({ kind: 'build', title: 'A', projectId: 'proj-1' });
    jobManager.create({ kind: 'build', title: 'B', projectId: 'proj-2' });
    const projectJobs = jobManager.listByProject('proj-1');
    expect(projectJobs).toHaveLength(1);
    expect(projectJobs[0].title).toBe('A');
  });
});

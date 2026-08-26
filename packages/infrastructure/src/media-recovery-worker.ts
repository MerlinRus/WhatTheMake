import type {
  MediaRecoveryJob,
  MediaRecoveryRepository,
  MediaStorage,
} from '@wtm/domain';

export type MediaRecoveryPhase = 'CLAIM' | 'DELETE' | 'JOURNAL';

export interface MediaRecoveryErrorContext {
  phase: MediaRecoveryPhase;
  jobId?: string;
  kind?: MediaRecoveryJob['kind'];
  attempts?: number;
}

export interface MediaRecoveryWorker {
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<boolean>;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function createMediaRecoveryWorker(options: {
  repository: MediaRecoveryRepository;
  storage: MediaStorage;
  pollIntervalMs: number;
  leaseMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  maxJobsPerRun?: number;
  onError?: (context: MediaRecoveryErrorContext, error: unknown) => void;
}): MediaRecoveryWorker {
  const pollIntervalMs = positiveInteger(
    'pollIntervalMs',
    options.pollIntervalMs,
  );
  const leaseMs = positiveInteger('leaseMs', options.leaseMs);
  const retryBaseMs = positiveInteger('retryBaseMs', options.retryBaseMs);
  const retryMaxMs = positiveInteger('retryMaxMs', options.retryMaxMs);
  const maxJobsPerRun = positiveInteger(
    'maxJobsPerRun',
    options.maxJobsPerRun ?? 25,
  );
  if (retryBaseMs > retryMaxMs) {
    throw new Error('retryBaseMs must not exceed retryMaxMs');
  }

  let timer: NodeJS.Timeout | null = null;
  let activeRun: Promise<void> | null = null;

  const report = (context: MediaRecoveryErrorContext, error: unknown): void => {
    try {
      options.onError?.(context, error);
    } catch {
      // Error reporting must not stop recovery.
    }
  };

  const retryDelay = (attempts: number): number =>
    Math.min(retryBaseMs * 2 ** Math.min(attempts - 1, 10), retryMaxMs);

  const runOnce = async (): Promise<boolean> => {
    let job: MediaRecoveryJob | null;
    try {
      job = await options.repository.claimRecoveryJob(leaseMs);
    } catch (error) {
      report({ phase: 'CLAIM' }, error);
      throw error;
    }
    if (!job) return false;

    const context = {
      jobId: job.jobId,
      kind: job.kind,
      attempts: job.attempts,
    };
    try {
      await options.storage.delete(job.assetId);
    } catch (error) {
      try {
        await options.repository.retryRecoveryJob(
          job.jobId,
          job.attempts,
          retryDelay(job.attempts),
          'MEDIA_DELETE_FAILED',
        );
      } catch (journalError) {
        report({ phase: 'JOURNAL', ...context }, journalError);
        throw journalError;
      }
      report({ phase: 'DELETE', ...context }, error);
      return true;
    }

    try {
      await options.repository.completeRecoveryJob(job.jobId, job.attempts);
    } catch (error) {
      report({ phase: 'JOURNAL', ...context }, error);
      throw error;
    }
    return true;
  };

  const runBatch = async (): Promise<void> => {
    for (let count = 0; count < maxJobsPerRun; count += 1) {
      if (!(await runOnce())) return;
    }
  };

  const tick = (): void => {
    if (activeRun) return;
    activeRun = runBatch()
      .catch(() => {})
      .finally(() => {
        activeRun = null;
      });
  };

  return {
    start(): void {
      if (timer) return;
      tick();
      timer = setInterval(tick, pollIntervalMs);
      timer.unref();
    },

    async stop(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = null;
      await activeRun;
    },

    runOnce,
  };
}

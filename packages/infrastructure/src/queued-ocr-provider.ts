import type { OcrProvider, OcrRequest, OcrResult } from '@wtm/domain';

export type OcrQueueState = 'OPEN' | 'SHUTTING_DOWN' | 'CLOSED';

export interface OcrQueueSnapshot {
  state: OcrQueueState;
  activeCount: number;
  pendingCount: number;
  concurrency: number;
  maxPending: number;
}

export interface QueuedOcrProvider extends OcrProvider {
  getQueueSnapshot(): OcrQueueSnapshot;
  shutdown(): Promise<void>;
}

interface PendingJob {
  request: OcrRequest;
  resolve: (result: OcrResult) => void;
  waitTimer: NodeJS.Timeout | null;
  abortListener: (() => void) | null;
}

function integerInRange(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function failure(
  code:
    | 'OCR_ABORTED'
    | 'OCR_OVERLOADED'
    | 'OCR_QUEUE_TIMEOUT'
    | 'OCR_SHUTTING_DOWN'
    | 'OCR_PROVIDER_UNAVAILABLE',
  retryable: boolean,
): OcrResult {
  return { kind: 'FAILED', code, retryable };
}

export function createQueuedOcrProvider(options: {
  provider: OcrProvider;
  concurrency: number;
  maxPending: number;
  waitTimeoutMs: number;
}): QueuedOcrProvider {
  const concurrency = integerInRange(
    'concurrency',
    options.concurrency,
    1,
    100,
  );
  const maxPending = integerInRange(
    'maxPending',
    options.maxPending,
    0,
    10_000,
  );
  const waitTimeoutMs = integerInRange(
    'waitTimeoutMs',
    options.waitTimeoutMs,
    1,
    300_000,
  );
  const pending: PendingJob[] = [];
  let activeCount = 0;
  let state: OcrQueueState = 'OPEN';
  let resolveShutdown: (() => void) | null = null;
  const shutdownPromise = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });

  const cleanupWait = (job: PendingJob): void => {
    if (job.waitTimer) clearTimeout(job.waitTimer);
    job.waitTimer = null;
    if (job.abortListener && job.request.signal) {
      job.request.signal.removeEventListener('abort', job.abortListener);
    }
    job.abortListener = null;
  };

  const settleShutdown = (): void => {
    if (
      state === 'SHUTTING_DOWN' &&
      activeCount === 0 &&
      pending.length === 0
    ) {
      state = 'CLOSED';
      resolveShutdown?.();
      resolveShutdown = null;
    }
  };

  const removePending = (job: PendingJob): boolean => {
    const index = pending.indexOf(job);
    if (index === -1) return false;
    pending.splice(index, 1);
    cleanupWait(job);
    return true;
  };

  function start(job: PendingJob): void {
    cleanupWait(job);
    activeCount += 1;
    void (async () => {
      let result: OcrResult;
      try {
        result = await options.provider.recognize(job.request);
      } catch {
        result = failure('OCR_PROVIDER_UNAVAILABLE', true);
      }
      job.resolve(result);
      activeCount -= 1;
      pump();
    })();
  }

  function pump(): void {
    while (activeCount < concurrency) {
      const job = pending.shift();
      if (!job) break;
      if (job.request.signal?.aborted) {
        cleanupWait(job);
        job.resolve(failure('OCR_ABORTED', false));
        continue;
      }
      start(job);
    }
    settleShutdown();
  }

  return {
    providerId: options.provider.providerId,
    version: options.provider.version,

    recognize(request): Promise<OcrResult> {
      if (request.signal?.aborted) {
        return Promise.resolve(failure('OCR_ABORTED', false));
      }
      if (state !== 'OPEN') {
        return Promise.resolve(failure('OCR_SHUTTING_DOWN', true));
      }
      if (activeCount < concurrency) {
        return new Promise<OcrResult>((resolve) => {
          start({
            request,
            resolve,
            waitTimer: null,
            abortListener: null,
          });
        });
      }
      if (pending.length >= maxPending) {
        return Promise.resolve(failure('OCR_OVERLOADED', true));
      }

      return new Promise<OcrResult>((resolve) => {
        const job: PendingJob = {
          request,
          resolve,
          waitTimer: null,
          abortListener: null,
        };
        job.waitTimer = setTimeout(() => {
          if (!removePending(job)) return;
          resolve(failure('OCR_QUEUE_TIMEOUT', true));
          settleShutdown();
        }, waitTimeoutMs);
        if (request.signal) {
          job.abortListener = () => {
            if (!removePending(job)) return;
            resolve(failure('OCR_ABORTED', false));
            settleShutdown();
          };
          request.signal.addEventListener('abort', job.abortListener, {
            once: true,
          });
        }
        pending.push(job);
      });
    },

    getQueueSnapshot(): OcrQueueSnapshot {
      return {
        state,
        activeCount,
        pendingCount: pending.length,
        concurrency,
        maxPending,
      };
    },

    shutdown(): Promise<void> {
      if (state === 'OPEN') state = 'SHUTTING_DOWN';
      settleShutdown();
      return shutdownPromise;
    },
  };
}

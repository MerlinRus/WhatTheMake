import assert from 'node:assert/strict';
import test from 'node:test';

import type { OcrProvider, OcrRequest, OcrResult } from '@wtm/domain';

import { createQueuedOcrProvider } from '../src/index.js';

const request: OcrRequest = {
  operation: 'DOCUMENT_TEXT_DETECTION',
  imageBytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
  mediaType: 'image/jpeg',
};

interface ControlledCall {
  request: OcrRequest;
  complete(result?: OcrResult): void;
}

function createControlledProvider(): {
  provider: OcrProvider;
  calls: ControlledCall[];
  maxActive(): number;
} {
  const calls: ControlledCall[] = [];
  let active = 0;
  let peakActive = 0;

  return {
    provider: {
      providerId: 'CONTROLLED',
      version: 'test-v1',
      recognize(input): Promise<OcrResult> {
        active += 1;
        peakActive = Math.max(peakActive, active);
        return new Promise<OcrResult>((resolve) => {
          let completed = false;
          calls.push({
            request: input,
            complete(result = { kind: 'SUCCEEDED', text: 'fixture' }): void {
              if (completed) return;
              completed = true;
              active -= 1;
              resolve(result);
            },
          });
        });
      },
    },
    calls,
    maxActive: () => peakActive,
  };
}

test('OCR queue bounds concurrency and rejects excess pending work', async () => {
  const controlled = createControlledProvider();
  const queue = createQueuedOcrProvider({
    provider: controlled.provider,
    concurrency: 2,
    maxPending: 2,
    waitTimeoutMs: 1_000,
  });

  const accepted = [
    queue.recognize(request),
    queue.recognize(request),
    queue.recognize(request),
    queue.recognize(request),
  ];
  assert.deepEqual(queue.getQueueSnapshot(), {
    state: 'OPEN',
    activeCount: 2,
    pendingCount: 2,
    concurrency: 2,
    maxPending: 2,
  });
  assert.deepEqual(await queue.recognize(request), {
    kind: 'FAILED',
    code: 'OCR_OVERLOADED',
    retryable: true,
  });

  const first = controlled.calls[0];
  const second = controlled.calls[1];
  assert.ok(first);
  assert.ok(second);
  first.complete();
  second.complete();
  await Promise.resolve();

  assert.equal(controlled.calls.length, 4);
  const third = controlled.calls[2];
  const fourth = controlled.calls[3];
  assert.ok(third);
  assert.ok(fourth);
  third.complete();
  fourth.complete();
  assert.deepEqual(await Promise.all(accepted), [
    { kind: 'SUCCEEDED', text: 'fixture' },
    { kind: 'SUCCEEDED', text: 'fixture' },
    { kind: 'SUCCEEDED', text: 'fixture' },
    { kind: 'SUCCEEDED', text: 'fixture' },
  ]);
  assert.equal(controlled.maxActive(), 2);
  await queue.shutdown();
});

test('OCR queue expires work that waits too long', async () => {
  const controlled = createControlledProvider();
  const queue = createQueuedOcrProvider({
    provider: controlled.provider,
    concurrency: 1,
    maxPending: 1,
    waitTimeoutMs: 5,
  });

  const active = queue.recognize(request);
  assert.deepEqual(await queue.recognize(request), {
    kind: 'FAILED',
    code: 'OCR_QUEUE_TIMEOUT',
    retryable: true,
  });
  assert.equal(controlled.calls.length, 1);
  const first = controlled.calls[0];
  assert.ok(first);
  first.complete();
  await active;
  await queue.shutdown();
});

test('OCR queue removes an aborted pending request', async () => {
  const controlled = createControlledProvider();
  const queue = createQueuedOcrProvider({
    provider: controlled.provider,
    concurrency: 1,
    maxPending: 1,
    waitTimeoutMs: 1_000,
  });
  const active = queue.recognize(request);
  const controller = new AbortController();
  const pending = queue.recognize({ ...request, signal: controller.signal });

  controller.abort();
  assert.deepEqual(await pending, {
    kind: 'FAILED',
    code: 'OCR_ABORTED',
    retryable: false,
  });
  assert.equal(queue.getQueueSnapshot().pendingCount, 0);
  assert.equal(controlled.calls.length, 1);

  const first = controlled.calls[0];
  assert.ok(first);
  first.complete();
  await active;
  await queue.shutdown();
});

test('OCR queue passes caller abort to an active provider call', async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const provider: OcrProvider = {
    providerId: 'ABORT_AWARE',
    version: 'test-v1',
    recognize(input): Promise<OcrResult> {
      observedSignal = input.signal;
      return new Promise<OcrResult>((resolve) => {
        input.signal?.addEventListener(
          'abort',
          () =>
            resolve({
              kind: 'FAILED',
              code: 'OCR_ABORTED',
              retryable: false,
            }),
          { once: true },
        );
      });
    },
  };
  const queue = createQueuedOcrProvider({
    provider,
    concurrency: 1,
    maxPending: 0,
    waitTimeoutMs: 1_000,
  });

  const result = queue.recognize({ ...request, signal: controller.signal });
  assert.equal(observedSignal, controller.signal);
  controller.abort();
  assert.deepEqual(await result, {
    kind: 'FAILED',
    code: 'OCR_ABORTED',
    retryable: false,
  });
  await queue.shutdown();
});

test('OCR queue shutdown drains accepted work and rejects new work', async () => {
  const controlled = createControlledProvider();
  const queue = createQueuedOcrProvider({
    provider: controlled.provider,
    concurrency: 1,
    maxPending: 1,
    waitTimeoutMs: 1_000,
  });
  const firstResult = queue.recognize(request);
  const secondResult = queue.recognize(request);
  let shutdownResolved = false;
  const shutdown = queue.shutdown().then(() => {
    shutdownResolved = true;
  });

  assert.equal(queue.getQueueSnapshot().state, 'SHUTTING_DOWN');
  assert.deepEqual(await queue.recognize(request), {
    kind: 'FAILED',
    code: 'OCR_SHUTTING_DOWN',
    retryable: true,
  });
  await Promise.resolve();
  assert.equal(shutdownResolved, false);

  const first = controlled.calls[0];
  assert.ok(first);
  first.complete();
  await Promise.resolve();
  assert.equal(controlled.calls.length, 2);
  assert.equal(shutdownResolved, false);

  const second = controlled.calls[1];
  assert.ok(second);
  second.complete();
  await Promise.all([firstResult, secondResult, shutdown]);
  assert.deepEqual(queue.getQueueSnapshot(), {
    state: 'CLOSED',
    activeCount: 0,
    pendingCount: 0,
    concurrency: 1,
    maxPending: 1,
  });
});

test('OCR queue normalizes unexpected provider rejection', async () => {
  const queue = createQueuedOcrProvider({
    provider: {
      providerId: 'BROKEN',
      version: 'test-v1',
      async recognize(): Promise<OcrResult> {
        throw new Error('provider detail must not escape');
      },
    },
    concurrency: 1,
    maxPending: 0,
    waitTimeoutMs: 1_000,
  });

  assert.deepEqual(await queue.recognize(request), {
    kind: 'FAILED',
    code: 'OCR_PROVIDER_UNAVAILABLE',
    retryable: true,
  });
  await queue.shutdown();
});

import { createHash } from 'node:crypto';

import type { OcrProvider, OcrRequest, OcrResult } from '@wtm/domain';

export const OCR_CACHE_KEY_VERSION = 1;

export interface OcrCacheStore {
  get(cacheKey: string): Promise<string | null>;
  put(cacheKey: string, text: string): Promise<void>;
}

export type OcrCacheEventOutcome =
  'INFLIGHT_HIT' | 'L1_HIT' | 'L2_HIT' | 'MISS' | 'READ_ERROR' | 'WRITE_ERROR';

export interface OcrCacheEvent {
  cacheKey: string;
  outcome: OcrCacheEventOutcome;
  providerId: string;
  providerVersion: string;
  operation: OcrRequest['operation'];
}

export interface CachedOcrProvider extends OcrProvider {
  getCacheSnapshot(): {
    inflightCount: number;
    l1EntryCount: number;
    l1MaxEntries: number;
  };
}

interface L1Entry {
  expiresAt: number;
  text: string;
}

interface InflightEntry {
  cacheKey: string;
  controller: AbortController;
  done: boolean;
  promise: Promise<OcrResult>;
  waiterCount: number;
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

function failure(): OcrResult {
  return {
    kind: 'FAILED',
    code: 'OCR_PROVIDER_UNAVAILABLE',
    retryable: true,
  };
}

function aborted(): OcrResult {
  return { kind: 'FAILED', code: 'OCR_ABORTED', retryable: false };
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createOcrCacheKey(
  request: OcrRequest,
  provider: Pick<OcrProvider, 'providerId' | 'version'>,
): string {
  const material = JSON.stringify({
    cacheKeyVersion: OCR_CACHE_KEY_VERSION,
    imageSha256: sha256(request.imageBytes),
    languageHints: request.languageHints ?? [],
    mediaType: request.mediaType,
    operation: request.operation,
    providerId: provider.providerId,
    providerVersion: provider.version,
  });
  return sha256(material);
}

export function createCachedOcrProvider(options: {
  provider: OcrProvider;
  store: OcrCacheStore;
  l1MaxEntries: number;
  l1TtlMs: number;
  onCacheEvent?: (event: OcrCacheEvent) => void;
}): CachedOcrProvider {
  const l1MaxEntries = integerInRange(
    'l1MaxEntries',
    options.l1MaxEntries,
    0,
    100_000,
  );
  const l1TtlMs = integerInRange('l1TtlMs', options.l1TtlMs, 1, 3_600_000);
  const inflight = new Map<string, InflightEntry>();
  const l1 = new Map<string, L1Entry>();

  const emit = (
    cacheKey: string,
    operation: OcrRequest['operation'],
    outcome: OcrCacheEventOutcome,
  ): void => {
    try {
      options.onCacheEvent?.({
        cacheKey,
        outcome,
        providerId: options.provider.providerId,
        providerVersion: options.provider.version,
        operation,
      });
    } catch {
      // Telemetry must never affect OCR behavior.
    }
  };

  const readL1 = (cacheKey: string): string | null => {
    const entry = l1.get(cacheKey);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      l1.delete(cacheKey);
      return null;
    }
    l1.delete(cacheKey);
    l1.set(cacheKey, entry);
    return entry.text;
  };

  const writeL1 = (cacheKey: string, text: string): void => {
    if (l1MaxEntries === 0) return;
    l1.delete(cacheKey);
    l1.set(cacheKey, { expiresAt: Date.now() + l1TtlMs, text });
    while (l1.size > l1MaxEntries) {
      const oldestKey = l1.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      l1.delete(oldestKey);
    }
  };

  const execute = async (
    cacheKey: string,
    request: Omit<OcrRequest, 'signal'>,
    signal: AbortSignal,
  ): Promise<OcrResult> => {
    try {
      const cachedText = await options.store.get(cacheKey);
      if (cachedText !== null) {
        writeL1(cacheKey, cachedText);
        emit(cacheKey, request.operation, 'L2_HIT');
        return { kind: 'SUCCEEDED', text: cachedText };
      }
      emit(cacheKey, request.operation, 'MISS');
    } catch {
      emit(cacheKey, request.operation, 'READ_ERROR');
    }

    if (signal.aborted) return aborted();

    let result: OcrResult;
    try {
      result = await options.provider.recognize({ ...request, signal });
    } catch {
      return failure();
    }
    if (result.kind !== 'SUCCEEDED') return result;

    writeL1(cacheKey, result.text);
    try {
      await options.store.put(cacheKey, result.text);
    } catch {
      emit(cacheKey, request.operation, 'WRITE_ERROR');
    }
    return result;
  };

  const waitForInflight = (
    entry: InflightEntry,
    signal: AbortSignal | undefined,
  ): Promise<OcrResult> => {
    entry.waiterCount += 1;
    return new Promise<OcrResult>((resolve) => {
      let settled = false;

      const finish = (result: OcrResult, wasAborted: boolean): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        entry.waiterCount -= 1;
        if (wasAborted && entry.waiterCount === 0 && !entry.done) {
          if (inflight.get(entry.cacheKey) === entry) {
            inflight.delete(entry.cacheKey);
          }
          entry.controller.abort();
        }
        resolve(result);
      };

      const onAbort = (): void => finish(aborted(), true);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      void entry.promise.then(
        (result) => finish(result, false),
        () => finish(failure(), false),
      );
    });
  };

  return {
    providerId: options.provider.providerId,
    version: options.provider.version,

    recognize(request): Promise<OcrResult> {
      if (request.signal?.aborted) return Promise.resolve(aborted());

      const stableRequest: Omit<OcrRequest, 'signal'> = {
        operation: request.operation,
        imageBytes: Uint8Array.from(request.imageBytes),
        mediaType: request.mediaType,
        ...(request.languageHints
          ? { languageHints: [...request.languageHints] }
          : {}),
      };
      const cacheKey = createOcrCacheKey(stableRequest, options.provider);
      const l1Text = readL1(cacheKey);
      if (l1Text !== null) {
        emit(cacheKey, request.operation, 'L1_HIT');
        return Promise.resolve({ kind: 'SUCCEEDED', text: l1Text });
      }

      const existing = inflight.get(cacheKey);
      if (existing) {
        emit(cacheKey, request.operation, 'INFLIGHT_HIT');
        return waitForInflight(existing, request.signal);
      }

      const controller = new AbortController();
      const entry: InflightEntry = {
        cacheKey,
        controller,
        done: false,
        promise: Promise.resolve(failure()),
        waiterCount: 0,
      };
      entry.promise = execute(
        cacheKey,
        stableRequest,
        controller.signal,
      ).finally(() => {
        entry.done = true;
        if (inflight.get(cacheKey) === entry) inflight.delete(cacheKey);
      });
      inflight.set(cacheKey, entry);
      return waitForInflight(entry, request.signal);
    },

    getCacheSnapshot() {
      return {
        inflightCount: inflight.size,
        l1EntryCount: l1.size,
        l1MaxEntries,
      };
    },
  };
}

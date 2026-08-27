import type {
  LlmProvider,
  LlmTelemetryEvent,
  OcrProvider,
  OcrTelemetryEvent,
} from '@wtm/domain';
import {
  createCachedOcrProvider,
  createDeepSeekLlmProvider,
  createGoogleVisionOcrProvider,
  createQueuedOcrProvider,
  type OcrCacheEvent,
  type OcrCacheStore,
  type QueuedOcrProvider,
} from '@wtm/infrastructure';

import type { ServerConfig } from './config.js';

export type ProviderRuntimeEvent =
  | ({ kind: 'OCR_PROVIDER' } & OcrTelemetryEvent)
  | {
      kind: 'OCR_CACHE';
      outcome: OcrCacheEvent['outcome'];
      providerId: string;
      providerVersion: string;
      operation: OcrCacheEvent['operation'];
    }
  | ({ kind: 'LLM_PROVIDER' } & LlmTelemetryEvent);

export interface ProviderRuntime {
  ocr: OcrProvider | null;
  llm: LlmProvider;
  metadata: {
    googleVision: {
      enabled: boolean;
      providerId: string | null;
      providerVersion: string | null;
    };
    deepSeek: {
      enabled: boolean;
      providerId: string;
      modelId: string;
      promptVersion: string;
    };
  };
  shutdown(): Promise<void>;
}

type ProviderConfig = Pick<
  ServerConfig,
  | 'googleVisionApiKey'
  | 'googleVisionTimeoutMs'
  | 'ocrQueueConcurrency'
  | 'ocrQueueMaxPending'
  | 'ocrQueueWaitTimeoutMs'
  | 'ocrL1MaxEntries'
  | 'ocrL1TtlMs'
  | 'deepSeekEnabled'
  | 'deepSeekApiKey'
  | 'deepSeekTimeoutMs'
>;

export function createProviderRuntime(options: {
  config: ProviderConfig;
  ocrCache: OcrCacheStore;
  onEvent?: (event: ProviderRuntimeEvent) => void;
  googleVisionFetch?: typeof fetch;
  deepSeekFetch?: typeof fetch;
}): ProviderRuntime {
  const emit = (event: ProviderRuntimeEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // Telemetry must never affect provider behavior.
    }
  };

  let queue: QueuedOcrProvider | null = null;
  let ocr: OcrProvider | null = null;
  if (options.config.googleVisionApiKey !== null) {
    const google = createGoogleVisionOcrProvider({
      apiKey: options.config.googleVisionApiKey,
      timeoutMs: options.config.googleVisionTimeoutMs,
      ...(options.googleVisionFetch
        ? { fetch: options.googleVisionFetch }
        : {}),
      onTelemetry: (event) => emit({ kind: 'OCR_PROVIDER', ...event }),
    });
    queue = createQueuedOcrProvider({
      provider: google,
      concurrency: options.config.ocrQueueConcurrency,
      maxPending: options.config.ocrQueueMaxPending,
      waitTimeoutMs: options.config.ocrQueueWaitTimeoutMs,
    });
    ocr = createCachedOcrProvider({
      provider: queue,
      store: options.ocrCache,
      l1MaxEntries: options.config.ocrL1MaxEntries,
      l1TtlMs: options.config.ocrL1TtlMs,
      onCacheEvent: (event) =>
        emit({
          kind: 'OCR_CACHE',
          outcome: event.outcome,
          providerId: event.providerId,
          providerVersion: event.providerVersion,
          operation: event.operation,
        }),
    });
  }

  let llm: LlmProvider;
  if (options.config.deepSeekEnabled) {
    if (options.config.deepSeekApiKey === null) {
      throw new Error('DEEPSEEK_API_KEY is required when DeepSeek is enabled');
    }
    llm = createDeepSeekLlmProvider({
      enabled: true,
      apiKey: options.config.deepSeekApiKey,
      timeoutMs: options.config.deepSeekTimeoutMs,
      ...(options.deepSeekFetch ? { fetch: options.deepSeekFetch } : {}),
      onTelemetry: (event) => emit({ kind: 'LLM_PROVIDER', ...event }),
    });
  } else {
    llm = createDeepSeekLlmProvider({ enabled: false });
  }

  return {
    ocr,
    llm,
    metadata: {
      googleVision: {
        enabled: ocr !== null,
        providerId: ocr?.providerId ?? null,
        providerVersion: ocr?.version ?? null,
      },
      deepSeek: {
        enabled: options.config.deepSeekEnabled,
        providerId: llm.providerId,
        modelId: llm.modelId,
        promptVersion: llm.promptVersion,
      },
    },
    shutdown: async () => {
      await queue?.shutdown();
    },
  };
}

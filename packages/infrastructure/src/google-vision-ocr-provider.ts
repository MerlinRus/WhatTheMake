import { Type } from 'typebox';
import { Value } from 'typebox/value';

import type {
  OcrFailureCode,
  OcrProvider,
  OcrRequest,
  OcrResult,
  OcrTelemetryEvent,
} from '@wtm/domain';

const GOOGLE_VISION_ENDPOINT =
  'https://vision.googleapis.com/v1/images:annotate';
const GOOGLE_VISION_PROVIDER_ID = 'GOOGLE_VISION';
const GOOGLE_VISION_VERSION = 'v1';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const LANGUAGE_HINT_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

const GoogleVisionStatusSchema = Type.Object(
  {
    code: Type.Integer(),
    message: Type.String(),
  },
  { additionalProperties: true },
);

const GoogleVisionAnnotationSchema = Type.Object(
  {
    fullTextAnnotation: Type.Optional(
      Type.Object({ text: Type.String() }, { additionalProperties: true }),
    ),
    error: Type.Optional(GoogleVisionStatusSchema),
  },
  { additionalProperties: true },
);

const GoogleVisionResponseSchema = Type.Object(
  { responses: Type.Tuple([GoogleVisionAnnotationSchema]) },
  { additionalProperties: true },
);

export interface GoogleVisionOcrProviderOptions {
  apiKey: string;
  timeoutMs?: number;
  maxImageBytes?: number;
  maxResponseBytes?: number;
  fetch?: typeof fetch;
  onTelemetry?: (event: OcrTelemetryEvent) => void;
}

function positiveInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function failure(code: OcrFailureCode, retryable: boolean): OcrResult {
  return { kind: 'FAILED', code, retryable };
}

function httpFailure(status: number): OcrResult {
  switch (status) {
    case 400:
    case 413:
      return failure('OCR_INVALID_REQUEST', false);
    case 401:
      return failure('OCR_AUTHENTICATION_FAILED', false);
    case 403:
      return failure('OCR_PERMISSION_DENIED', false);
    case 408:
      return failure('OCR_TIMEOUT', true);
    case 429:
      return failure('OCR_RATE_LIMITED', true);
    default:
      return status >= 500
        ? failure('OCR_PROVIDER_UNAVAILABLE', true)
        : failure('OCR_PROVIDER_REJECTED', false);
  }
}

function providerFailure(code: number): OcrResult {
  switch (code) {
    case 3:
      return failure('OCR_INVALID_REQUEST', false);
    case 4:
      return failure('OCR_TIMEOUT', true);
    case 7:
      return failure('OCR_PERMISSION_DENIED', false);
    case 8:
      return failure('OCR_RATE_LIMITED', true);
    case 13:
    case 14:
      return failure('OCR_PROVIDER_UNAVAILABLE', true);
    case 16:
      return failure('OCR_AUTHENTICATION_FAILED', false);
    default:
      return code === 0
        ? failure('OCR_INVALID_RESPONSE', false)
        : failure('OCR_PROVIDER_REJECTED', false);
  }
}

function validRequest(request: OcrRequest, maxImageBytes: number): boolean {
  if (
    request.operation !== 'DOCUMENT_TEXT_DETECTION' ||
    request.imageBytes.byteLength === 0 ||
    request.imageBytes.byteLength > maxImageBytes ||
    !['image/jpeg', 'image/png', 'image/webp'].includes(request.mediaType)
  ) {
    return false;
  }

  const hints = request.languageHints ?? [];
  return (
    hints.length <= 10 &&
    hints.every(
      (hint, index) =>
        LANGUAGE_HINT_PATTERN.test(hint) && hints.indexOf(hint) === index,
    )
  );
}

function abortFailure(
  requestSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): OcrResult {
  return requestSignal?.aborted
    ? failure('OCR_ABORTED', false)
    : timeoutSignal.aborted
      ? failure('OCR_TIMEOUT', true)
      : failure('OCR_PROVIDER_UNAVAILABLE', true);
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
): Promise<string | null> {
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > maxBytes
  ) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks, totalBytes),
    );
  } catch {
    return null;
  }
}

export function createGoogleVisionOcrProvider(
  options: GoogleVisionOcrProviderOptions,
): OcrProvider {
  if (options.apiKey.trim() === '') {
    throw new Error('Google Vision API key is required');
  }

  const timeoutMs = positiveInteger(
    'timeoutMs',
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    60_000,
  );
  const maxImageBytes = positiveInteger(
    'maxImageBytes',
    options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
    DEFAULT_MAX_IMAGE_BYTES,
  );
  const maxResponseBytes = positiveInteger(
    'maxResponseBytes',
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    16 * 1024 * 1024,
  );
  const requestFetch = options.fetch ?? globalThis.fetch;

  const report = (event: OcrTelemetryEvent): void => {
    try {
      options.onTelemetry?.(event);
    } catch {
      // Telemetry must never change provider behavior.
    }
  };

  return {
    providerId: GOOGLE_VISION_PROVIDER_ID,
    version: GOOGLE_VISION_VERSION,

    async recognize(request): Promise<OcrResult> {
      const startedAt = performance.now();
      const complete = (result: OcrResult): OcrResult => {
        const common = {
          providerId: GOOGLE_VISION_PROVIDER_ID,
          providerVersion: GOOGLE_VISION_VERSION,
          operation: request.operation,
          durationMs: Math.max(0, performance.now() - startedAt),
        };
        report(
          result.kind === 'SUCCEEDED'
            ? { ...common, outcome: 'SUCCEEDED' }
            : {
                ...common,
                outcome: 'FAILED',
                failureCode: result.code,
                retryable: result.retryable,
              },
        );
        return result;
      };

      if (request.signal?.aborted) {
        return complete(failure('OCR_ABORTED', false));
      }
      if (!validRequest(request, maxImageBytes)) {
        return complete(failure('OCR_INVALID_REQUEST', false));
      }

      const timeoutController = new AbortController();
      const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
      const signal = request.signal
        ? AbortSignal.any([request.signal, timeoutController.signal])
        : timeoutController.signal;

      try {
        const response = await requestFetch(GOOGLE_VISION_ENDPOINT, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': options.apiKey,
          },
          body: JSON.stringify({
            requests: [
              {
                image: {
                  content: Buffer.from(request.imageBytes).toString('base64'),
                },
                features: [{ type: request.operation }],
                ...(request.languageHints?.length
                  ? {
                      imageContext: {
                        languageHints: [...request.languageHints],
                      },
                    }
                  : {}),
              },
            ],
          }),
          signal,
        });

        if (signal.aborted) {
          await response.body?.cancel().catch(() => {});
          return complete(
            abortFailure(request.signal, timeoutController.signal),
          );
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          return complete(httpFailure(response.status));
        }

        const rawResponse = await readBoundedResponse(
          response,
          maxResponseBytes,
        );
        if (rawResponse === null) {
          return complete(failure('OCR_INVALID_RESPONSE', false));
        }
        if (signal.aborted) {
          return complete(
            abortFailure(request.signal, timeoutController.signal),
          );
        }

        let payload: unknown;
        try {
          payload = JSON.parse(rawResponse);
        } catch {
          return complete(failure('OCR_INVALID_RESPONSE', false));
        }
        if (!Value.Check(GoogleVisionResponseSchema, payload)) {
          return complete(failure('OCR_INVALID_RESPONSE', false));
        }

        const annotation = payload.responses[0];
        if (annotation.error) {
          return complete(providerFailure(annotation.error.code));
        }
        return complete({
          kind: 'SUCCEEDED',
          text: annotation.fullTextAnnotation?.text ?? '',
        });
      } catch {
        return complete(abortFailure(request.signal, timeoutController.signal));
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

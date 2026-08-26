import type { ImageMediaType } from './media.js';

export type OcrOperation = 'DOCUMENT_TEXT_DETECTION';

export type OcrFailureCode =
  | 'OCR_ABORTED'
  | 'OCR_TIMEOUT'
  | 'OCR_AUTHENTICATION_FAILED'
  | 'OCR_PERMISSION_DENIED'
  | 'OCR_RATE_LIMITED'
  | 'OCR_OVERLOADED'
  | 'OCR_QUEUE_TIMEOUT'
  | 'OCR_SHUTTING_DOWN'
  | 'OCR_INVALID_REQUEST'
  | 'OCR_PROVIDER_UNAVAILABLE'
  | 'OCR_PROVIDER_REJECTED'
  | 'OCR_INVALID_RESPONSE';

export interface OcrRequest {
  operation: OcrOperation;
  imageBytes: Uint8Array;
  mediaType: ImageMediaType;
  languageHints?: readonly string[];
  signal?: AbortSignal;
}

export type OcrResult =
  | { kind: 'SUCCEEDED'; text: string }
  | { kind: 'FAILED'; code: OcrFailureCode; retryable: boolean };

export interface OcrProvider {
  readonly providerId: string;
  readonly version: string;
  recognize(request: OcrRequest): Promise<OcrResult>;
}

export type OcrTelemetryEvent = {
  providerId: string;
  providerVersion: string;
  operation: OcrOperation;
  durationMs: number;
} & (
  | { outcome: 'SUCCEEDED' }
  | {
      outcome: 'FAILED';
      failureCode: OcrFailureCode;
      retryable: boolean;
    }
);

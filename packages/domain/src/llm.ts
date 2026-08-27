export const LLM_TEXT_ITEM_MAX_LENGTH = 10_000;
export const LLM_TEXT_TOTAL_MAX_LENGTH = 50_000;
export const LLM_TEXT_MAX_ITEMS = 50;
export const LLM_TEXT_MAX_LABELS = 30;
export const LLM_SUMMARY_MAX_LENGTH = 1_200;

export type LlmFailureCode =
  | 'LLM_DISABLED'
  | 'LLM_ABORTED'
  | 'LLM_TIMEOUT'
  | 'LLM_AUTHENTICATION_FAILED'
  | 'LLM_PERMISSION_DENIED'
  | 'LLM_RATE_LIMITED'
  | 'LLM_INVALID_REQUEST'
  | 'LLM_PROVIDER_UNAVAILABLE'
  | 'LLM_PROVIDER_REJECTED'
  | 'LLM_INVALID_RESPONSE';

export interface LlmTextItem {
  itemId: string;
  text: string;
}

export interface LlmTextTransformRequest {
  operation: 'CLASSIFY_AND_SUMMARIZE_ALLOWED_TEXT';
  locale: 'ru-RU';
  items: readonly LlmTextItem[];
  allowedLabels: readonly string[];
  signal?: AbortSignal;
}

export interface LlmTextClassificationDraft {
  itemId: string;
  labels: readonly string[];
}

/** LLM drafts are untrusted transforms and must never be promoted to evidence. */
export interface LlmTextTransformDraft {
  summary: string | null;
  classifications: readonly LlmTextClassificationDraft[];
}

export type LlmOutcome =
  | { kind: 'SUCCEEDED'; draft: LlmTextTransformDraft }
  | {
      kind: 'FALLBACK';
      code: LlmFailureCode;
      retryable: boolean;
      draft: { summary: null; classifications: readonly [] };
    };

export type LlmResult = {
  providerId: string;
  modelId: string;
  promptVersion: string;
} & LlmOutcome;

export interface LlmProvider {
  readonly providerId: string;
  readonly modelId: string;
  readonly promptVersion: string;
  transform(request: LlmTextTransformRequest): Promise<LlmResult>;
}

export type LlmTelemetryEvent = {
  providerId: string;
  modelId: string;
  promptVersion: string;
  operation: LlmTextTransformRequest['operation'];
  durationMs: number;
} & (
  | { outcome: 'SUCCEEDED' }
  | {
      outcome: 'FALLBACK';
      failureCode: LlmFailureCode;
      retryable: boolean;
    }
);

import type { ApiErrorCode, ApiErrorEnvelope } from '@wtm/contracts';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly details: unknown | undefined;

  constructor(options: {
    statusCode: number;
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  }) {
    super(options.message);
    this.name = 'AppError';
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.details = options.details;
  }
}

export function errorEnvelope(options: {
  code: ApiErrorCode;
  message: string;
  requestId: string;
  details?: unknown;
}): ApiErrorEnvelope {
  return options.details === undefined
    ? {
        error: {
          code: options.code,
          message: options.message,
          requestId: options.requestId,
        },
      }
    : {
        error: {
          code: options.code,
          message: options.message,
          requestId: options.requestId,
          details: options.details,
        },
      };
}

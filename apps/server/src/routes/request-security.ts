import type {
  FastifyRequest,
  onRequestHookHandler,
  preHandlerHookHandler,
} from 'fastify';

import { AppError } from '../errors.js';

export function requireSameOrigin(publicOrigin: string): preHandlerHookHandler {
  return async (request) => {
    if (request.headers.origin !== publicOrigin) {
      throw new AppError({
        statusCode: 403,
        code: 'FORBIDDEN',
        message: 'Same-origin request required',
      });
    }
  };
}

export const requireJson: onRequestHookHandler = async (request) => {
  const mediaType = request.headers['content-type']
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== 'application/json') {
    throw new AppError({
      statusCode: 415,
      code: 'VALIDATION_ERROR',
      message: 'Content-Type must be application/json',
    });
  }
};

export function sessionTokenCookie(
  request: FastifyRequest,
  cookieName: string,
): string | null {
  const value = request.cookies[cookieName];
  return typeof value === 'string' ? value : null;
}

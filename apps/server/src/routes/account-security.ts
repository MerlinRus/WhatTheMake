import type { FastifyInstance, onSendHookHandler } from 'fastify';

import {
  AccountRecoveryInputSchema,
  AccountRecoveryResponseSchema,
  ApiErrorEnvelopeSchema,
  RotateAccountRecoveryCodeInputSchema,
  RotateAccountRecoveryCodeResponseSchema,
  type AccountRecoveryInput,
  type AccountRecoveryResponse,
  type RotateAccountRecoveryCodeInput,
  type RotateAccountRecoveryCodeResponse,
} from '@wtm/contracts';

import type { AccountSecurityService } from '../account-security/service.js';
import { isSessionToken } from '../identity/service.js';
import {
  requireJson,
  requireSameOrigin,
  sessionTokenCookie,
} from './request-security.js';

export interface AccountSecurityRoutesOptions {
  service: AccountSecurityService;
  publicOrigin: string;
  cookieName: string;
}

const noStore: onSendHookHandler = async (_request, reply, payload) => {
  reply.header('Cache-Control', 'private, no-store');
  reply.header('Pragma', 'no-cache');
  return payload;
};

export async function registerAccountSecurityRoutes(
  app: FastifyInstance,
  options: AccountSecurityRoutesOptions,
): Promise<void> {
  const security = {
    onRequest: requireJson,
    preHandler: requireSameOrigin(options.publicOrigin),
    onSend: noStore,
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  };
  const errors = {
    400: ApiErrorEnvelopeSchema,
    401: ApiErrorEnvelopeSchema,
    403: ApiErrorEnvelopeSchema,
    415: ApiErrorEnvelopeSchema,
    429: ApiErrorEnvelopeSchema,
  };
  app.post<{
    Body: RotateAccountRecoveryCodeInput;
    Reply: RotateAccountRecoveryCodeResponse;
  }>(
    '/api/v1/accounts/current/recovery-code',
    {
      ...security,
      schema: {
        body: RotateAccountRecoveryCodeInputSchema,
        response: { 200: RotateAccountRecoveryCodeResponseSchema, ...errors },
      },
    },
    async (request) => {
      const value = sessionTokenCookie(request, options.cookieName);
      return options.service.rotateRecoveryCode(
        isSessionToken(value) ? value : null,
        request.body.currentPassword,
      );
    },
  );
  app.post<{ Body: AccountRecoveryInput; Reply: AccountRecoveryResponse }>(
    '/api/v1/account-recovery',
    {
      ...security,
      schema: {
        body: AccountRecoveryInputSchema,
        response: { 200: AccountRecoveryResponseSchema, ...errors },
      },
    },
    async (request) => options.service.recoverAccount(request.body),
  );
}

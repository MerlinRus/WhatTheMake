import type {
  FastifyInstance,
  FastifyRequest,
  onRequestHookHandler,
} from 'fastify';
import { Type } from 'typebox';

import {
  ApiErrorEnvelopeSchema,
  CreateMediaAssetQuerySchema,
  MediaAssetParamsSchema,
  MediaAssetResponseSchema,
  MediaCollectionParamsSchema,
  MediaCollectionResponseSchema,
  type CreateMediaAssetQuery,
  type ImageMediaType,
  type MediaAssetParams,
  type MediaAssetResponse,
  type MediaCollectionParams,
  type MediaCollectionResponse,
} from '@wtm/contracts';

import { isSessionToken } from '../identity/service.js';
import type { MediaService } from '../media/service.js';
import { AppError } from '../errors.js';
import { requireSameOrigin, sessionTokenCookie } from './request-security.js';

const imageMediaTypes: ImageMediaType[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
];

export interface MediaRoutesOptions {
  service: MediaService;
  publicOrigin: string;
  cookieName: string;
  maxBytes: number;
}

function token(request: FastifyRequest, cookieName: string): string | null {
  const value = sessionTokenCookie(request, cookieName);
  return isSessionToken(value) ? value : null;
}

function parsedMediaType(request: FastifyRequest): ImageMediaType | null {
  const value = request.headers['content-type']
    ?.split(';', 1)[0]
    ?.toLowerCase();
  if (
    value === 'image/jpeg' ||
    value === 'image/png' ||
    value === 'image/webp'
  ) {
    return value;
  }
  return null;
}

const requireImageContentType: onRequestHookHandler = async (request) => {
  if (!parsedMediaType(request)) {
    throw new AppError({
      statusCode: 415,
      code: 'VALIDATION_ERROR',
      message: 'Content-Type must be image/jpeg, image/png, or image/webp',
    });
  }
};

function requestMediaType(request: FastifyRequest): ImageMediaType {
  const mediaType = parsedMediaType(request);
  if (!mediaType) throw new Error('Image Content-Type hook was bypassed');
  return mediaType;
}

export async function registerMediaRoutes(
  app: FastifyInstance,
  options: MediaRoutesOptions,
): Promise<void> {
  const sameOrigin = requireSameOrigin(options.publicOrigin);

  for (const mediaType of imageMediaTypes) {
    if (!app.hasContentTypeParser(mediaType)) {
      app.addContentTypeParser(
        mediaType,
        { parseAs: 'buffer', bodyLimit: options.maxBytes },
        (_request, body, done) => done(null, body),
      );
    }
  }

  app.post<{ Reply: MediaCollectionResponse }>(
    '/api/v1/media-collections',
    {
      preHandler: sameOrigin,
      config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
      schema: {
        response: {
          201: MediaCollectionResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          429: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const collection = await options.service.createCollection(
        token(request, options.cookieName),
      );
      return reply.code(201).send({ collection });
    },
  );

  app.get<{
    Params: MediaCollectionParams;
    Reply: MediaCollectionResponse;
  }>(
    '/api/v1/media-collections/:collectionId',
    {
      schema: {
        params: MediaCollectionParamsSchema,
        response: {
          200: MediaCollectionResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) => ({
      collection: await options.service.collection(
        token(request, options.cookieName),
        request.params.collectionId,
      ),
    }),
  );

  app.post<{
    Params: MediaCollectionParams;
    Querystring: CreateMediaAssetQuery;
    Body: Buffer;
    Reply: MediaAssetResponse;
  }>(
    '/api/v1/media-collections/:collectionId/assets',
    {
      onRequest: requireImageContentType,
      preHandler: sameOrigin,
      bodyLimit: options.maxBytes,
      config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
      schema: {
        params: MediaCollectionParamsSchema,
        querystring: CreateMediaAssetQuerySchema,
        response: {
          201: MediaAssetResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
          409: ApiErrorEnvelopeSchema,
          413: ApiErrorEnvelopeSchema,
          415: ApiErrorEnvelopeSchema,
          429: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const asset = await options.service.upload(
        token(request, options.cookieName),
        {
          collectionId: request.params.collectionId,
          role: request.query.role,
          mediaType: requestMediaType(request),
          bytes: request.body,
        },
      );
      return reply.code(201).send({ asset });
    },
  );

  app.get<{ Params: MediaAssetParams }>(
    '/api/v1/media-assets/:assetId',
    {
      schema: {
        params: MediaAssetParamsSchema,
        response: {
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
          503: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const file = await options.service.file(
        token(request, options.cookieName),
        request.params.assetId,
      );
      return reply
        .header('Content-Type', file.asset.mediaType)
        .header('Content-Length', file.asset.byteSize)
        .header('Cache-Control', 'private, no-store')
        .send(Buffer.from(file.bytes));
    },
  );

  app.delete<{ Params: MediaAssetParams; Reply: null }>(
    '/api/v1/media-assets/:assetId',
    {
      preHandler: sameOrigin,
      config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
      schema: {
        params: MediaAssetParamsSchema,
        response: {
          204: Type.Null(),
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          429: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      await options.service.delete(
        token(request, options.cookieName),
        request.params.assetId,
      );
      return reply.code(204).send(null);
    },
  );
}

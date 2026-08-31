import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { basename, dirname } from 'node:path';
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifySchemaValidationError,
  type FastifyServerOptions,
} from 'fastify';

import type { Version } from '@wtm/contracts';
import type { DatabaseHealthProbe } from '@wtm/infrastructure';

import { AppError, errorEnvelope } from './errors.js';
import type { CatalogLookupService } from './catalog/service.js';
import type { ComparisonService } from './comparison/service.js';
import type { IdentityService } from './identity/service.js';
import type { InciCorrectionService } from './inci-corrections/service.js';
import type { MascaraPreferencesService } from './preferences/service.js';
import type { MediaService } from './media/service.js';
import type { ProductObservationService } from './product-observations/service.js';
import type { ProductDiscoveryService } from './product-discovery/service.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerComparisonRoutes } from './routes/comparisons.js';
import {
  registerInciCorrectionRoutes,
  type InciCorrectionRoutesOptions,
} from './routes/inci-corrections.js';
import {
  registerIdentityRoutes,
  type IdentityRoutesOptions,
} from './routes/identity.js';
import {
  registerMascaraPreferencesRoutes,
  type MascaraPreferencesRoutesOptions,
} from './routes/mascara-preferences.js';
import {
  registerMediaRoutes,
  type MediaRoutesOptions,
} from './routes/media.js';
import {
  registerProductObservationRoutes,
  type ProductObservationRoutesOptions,
} from './routes/product-observations.js';
import { registerProductDiscoveryRoutes } from './routes/product-discovery.js';

export interface BuildAppOptions {
  database?: DatabaseHealthProbe | null;
  logger?: FastifyServerOptions['logger'];
  version?: Version;
  trustProxy?: FastifyServerOptions['trustProxy'];
  webRoot?: string;
  catalog?: { service: CatalogLookupService };
  comparisons?: { service: ComparisonService; publicOrigin: string };
  identity?: Omit<IdentityRoutesOptions, 'service'> & {
    service: IdentityService;
  };
  inciCorrections?: Omit<InciCorrectionRoutesOptions, 'service'> & {
    service: InciCorrectionService;
  };
  mascaraPreferences?: Omit<MascaraPreferencesRoutesOptions, 'service'> & {
    service: MascaraPreferencesService;
  };
  media?: Omit<MediaRoutesOptions, 'service'> & { service: MediaService };
  productObservations?: Omit<ProductObservationRoutesOptions, 'service'> & {
    service: ProductObservationService;
  };
  productDiscovery?: { service: ProductDiscoveryService };
  onClose?: () => Promise<void>;
}

const defaultVersion: Version = {
  name: 'what-the-make',
  version: '0.1.0',
  buildSha: 'dev',
};

function validationErrors(
  error: unknown,
): FastifySchemaValidationError[] | null {
  if (!(error instanceof Error) || !('validation' in error)) return null;
  const validation = (error as { validation?: unknown }).validation;
  return Array.isArray(validation)
    ? (validation as FastifySchemaValidationError[])
    : null;
}

function clientErrorStatus(error: unknown): number | null {
  if (!(error instanceof Error) || !('statusCode' in error)) return null;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' &&
    Number.isInteger(statusCode) &&
    statusCode >= 400 &&
    statusCode < 500
    ? statusCode
    : null;
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: options.trustProxy ?? false,
    ajv: { customOptions: { removeAdditional: false } },
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        'upgrade-insecure-requests': null,
      },
    },
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () =>
      new AppError({
        statusCode: 429,
        code: 'RATE_LIMITED',
        message: 'Too many requests',
      }),
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(
      errorEnvelope({
        code: 'NOT_FOUND',
        message: 'Resource not found',
        requestId: request.id,
      }),
    ),
  );

  app.setErrorHandler((error, request, reply) => {
    const validation = validationErrors(error);
    if (validation) {
      return reply.code(400).send(
        errorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          requestId: request.id,
          details: validation.map(({ instancePath, keyword, message }) => ({
            instancePath,
            keyword,
            message,
          })),
        }),
      );
    }

    if (error instanceof AppError) {
      return reply.code(error.statusCode).send(
        errorEnvelope({
          code: error.code,
          message: error.message,
          requestId: request.id,
          ...(error.details === undefined ? {} : { details: error.details }),
        }),
      );
    }

    const clientStatus = clientErrorStatus(error);
    if (clientStatus) {
      return reply.code(clientStatus).send(
        errorEnvelope({
          code: 'VALIDATION_ERROR',
          message:
            clientStatus === 415
              ? 'Unsupported Content-Type'
              : 'Invalid request',
          requestId: request.id,
        }),
      );
    }

    request.log.error(
      { err: error, requestId: request.id },
      'Unhandled request error',
    );
    return reply.code(500).send(
      errorEnvelope({
        code: 'INTERNAL_ERROR',
        message: 'Service temporarily unavailable',
        requestId: request.id,
      }),
    );
  });

  await registerHealthRoutes(app, {
    database: options.database ?? null,
    version: options.version ?? defaultVersion,
  });

  if (options.catalog) {
    await registerCatalogRoutes(app, options.catalog);
  }

  if (options.comparisons) {
    await registerComparisonRoutes(app, options.comparisons);
  }

  if (options.identity) {
    await registerIdentityRoutes(app, options.identity);
  }

  if (options.inciCorrections) {
    await registerInciCorrectionRoutes(app, options.inciCorrections);
  }

  if (options.mascaraPreferences) {
    await registerMascaraPreferencesRoutes(app, options.mascaraPreferences);
  }

  if (options.media) {
    await registerMediaRoutes(app, options.media);
  }

  if (options.productObservations) {
    await registerProductObservationRoutes(app, options.productObservations);
  }

  if (options.productDiscovery) {
    await registerProductDiscoveryRoutes(app, options.productDiscovery);
  }

  if (options.webRoot) {
    await app.register(fastifyStatic, {
      root: options.webRoot,
      prefix: '/',
      wildcard: false,
      index: ['index.html'],
      setHeaders(response, filePath) {
        response.header(
          'Cache-Control',
          basename(dirname(filePath)) === 'assets'
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        );
      },
    });
  }

  if (options.onClose) {
    app.addHook('onClose', options.onClose);
  }

  return app;
}
